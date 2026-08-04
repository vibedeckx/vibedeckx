import { execFileSync } from "child_process";
import type { ReviewSpan, Storage } from "../storage/types.js";

const MAX_BUFFER = 10 * 1024 * 1024;

/** Sentinel content hash for a path that does not exist at a boundary. */
export const ABSENT = "absent";

export interface SnapshotState {
  head: string;
  /** path -> git blob sha of the uncommitted content, or ABSENT for a deletion. */
  dirty: Record<string, string>;
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Paths per batched git invocation. Snapshotting used to spawn one process per
 * file, which on a worktree with a few hundred changed files cost a second of
 * blocked event loop before the review even started — and on a worker that
 * loop also carries the tunnel. Chunked rather than unbounded so a huge
 * worktree can't blow the command line length limit.
 */
const PATHS_PER_BATCH = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Blob sha of each path's working-tree content, in one `git hash-object` call
 * per batch. git emits one sha per line, in argument order.
 *
 * Throws whenever a sha cannot be produced for every requested path, exactly
 * as the old per-file loop did: a path silently missing from the result would
 * read as "not dirty" downstream and quietly drop a changed file from the
 * review scope, which is worse than degrading to no scope at all. The
 * per-path retry only exists to surface which path a batch failure came from.
 */
function hashObjects(worktreePath: string, paths: string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const batch of chunk(paths, PATHS_PER_BATCH)) {
    let shas: string[] = [];
    try {
      shas = git(worktreePath, ["hash-object", "--", ...batch])
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      shas = [];
    }
    if (shas.length !== batch.length) {
      // Batch failed, or git returned a line count we can't align with the
      // arguments. Redo it one path at a time; the offending path throws.
      for (const p of batch) hashes.set(p, git(worktreePath, ["hash-object", "--", p]).trim());
      continue;
    }
    batch.forEach((p, i) => hashes.set(p, shas[i]!));
  }
  return hashes;
}

/**
 * Capture the worktree's git state at a turn boundary: the current HEAD plus a
 * content-hash of every uncommitted file. Rename detection is disabled so a
 * rename reads as delete-old + add-new (each path keyed independently).
 * Returns null on any git failure (no commits, not a repo) — callers degrade.
 */
export function captureSnapshot(worktreePath: string): SnapshotState | null {
  try {
    const head = git(worktreePath, ["rev-parse", "HEAD"]).trim();
    const dirty: Record<string, string> = {};

    // Tracked changes vs HEAD (staged + unstaged), no rename detection.
    // Lines: "<status>\t<path>", e.g. "M\tsrc/a.ts", "D\tsrc/gone.ts".
    // -c core.quotepath=false: emit non-ASCII paths as literal UTF-8 bytes
    // instead of git's default octal-escaped/double-quoted form (e.g.
    // "caf\303\251.ts"), which the tab/line-split parsing below can't
    // recover the real path from. Residual: a path containing a literal
    // double-quote, backslash, tab, or newline is still git-quoted
    // regardless of this setting — accepted as far rarer than accented
    // filenames.
    const nameStatus = git(worktreePath, [
      "-c",
      "core.quotepath=false",
      "diff",
      "HEAD",
      "--name-status",
      "--no-renames",
    ]);
    const toHash: string[] = [];
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const status = line.slice(0, tab).trim();
      const p = line.slice(tab + 1).trim();
      if (status.startsWith("D")) dirty[p] = ABSENT;
      else toHash.push(p);
    }

    // Untracked files (never added) — always additions.
    const untracked = git(worktreePath, [
      "-c",
      "core.quotepath=false",
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    for (const p of untracked.split("\n")) {
      const t = p.trim();
      if (t) toHash.push(t);
    }

    for (const [p, sha] of hashObjects(worktreePath, toHash)) dirty[p] = sha;

    return { head, dirty };
  } catch {
    return null;
  }
}

/** Blob sha of `path` at `head`, or ABSENT if it does not exist there. */
function blobShaOrAbsent(worktreePath: string, head: string, filePath: string): string {
  try {
    return git(worktreePath, ["rev-parse", `${head}:${filePath}`]).trim();
  } catch {
    return ABSENT;
  }
}

/** `<sha> <type> <size>` — anything else (notably `<object> missing`) is ABSENT. */
const BATCH_CHECK_FOUND = /^([0-9a-f]{40,64}) [a-z]+ \d+$/;

/**
 * Blob sha of every path at `head`, ABSENT where the path does not exist
 * there. `git cat-file --batch-check` answers a whole batch from one process,
 * replacing the `git rev-parse <head>:<path>` spawned per candidate file —
 * which, across both boundaries, was two processes per changed file.
 *
 * The protocol is one request line in, one result line out, so a path
 * containing a newline is answered individually instead; any batch whose
 * output doesn't line up falls back the same way. ABSENT is a legitimate
 * answer here (the file didn't exist at that boundary), so unlike hashObjects
 * a failure degrades rather than throws — exactly what the per-file
 * blobShaOrAbsent already did.
 */
function blobShasAt(worktreePath: string, head: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const batchable: string[] = [];
  for (const p of paths) {
    if (p.includes("\n")) out.set(p, blobShaOrAbsent(worktreePath, head, p));
    else batchable.push(p);
  }
  for (const batch of chunk(batchable, PATHS_PER_BATCH)) {
    let lines: string[] = [];
    try {
      const stdin = batch.map((p) => `${head}:${p}`).join("\n") + "\n";
      lines = git(worktreePath, ["cat-file", "--batch-check"], stdin)
        .split("\n")
        .filter((l) => l.length > 0);
    } catch {
      lines = [];
    }
    if (lines.length !== batch.length) {
      for (const p of batch) out.set(p, blobShaOrAbsent(worktreePath, head, p));
      continue;
    }
    batch.forEach((p, i) => {
      const found = BATCH_CHECK_FOUND.exec(lines[i]!);
      out.set(p, found ? found[1]! : ABSENT);
    });
  }
  return out;
}

/**
 * The set of files whose effective content changed between two boundary
 * snapshots. Effective content = the uncommitted blob if the file is dirty at
 * that boundary, otherwise the committed blob at that boundary's HEAD.
 * Comparison is by content sha, so pure status churn (staging, committing the
 * same content, prior-turn dirt left untouched) is correctly excluded.
 */
export function computeScope(
  start: SnapshotState,
  end: SnapshotState,
  worktreePath: string,
): { changedFiles: string[]; startHead: string } {
  const candidates = new Set<string>();

  if (start.head !== end.head) {
    // -c core.quotepath=false: see captureSnapshot's name-status call above —
    // same rationale, this is another git call that emits paths.
    const committed = git(worktreePath, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--name-only",
      "--no-renames",
      start.head,
      end.head,
    ]);
    for (const line of committed.split("\n")) {
      const p = line.trim();
      if (p) candidates.add(p);
    }
  }
  for (const p of Object.keys(start.dirty)) candidates.add(p);
  for (const p of Object.keys(end.dirty)) candidates.add(p);

  const candidateList = [...candidates];
  const startShas = blobShasAt(
    worktreePath, start.head, candidateList.filter((f) => start.dirty[f] === undefined),
  );
  const endShas = blobShasAt(
    worktreePath, end.head, candidateList.filter((f) => end.dirty[f] === undefined),
  );

  const changed: string[] = [];
  for (const f of candidateList) {
    const startSha = start.dirty[f] ?? startShas.get(f) ?? ABSENT;
    const endSha = end.dirty[f] ?? endShas.get(f) ?? ABSENT;
    if (startSha !== endSha) changed.push(f);
  }
  changed.sort();
  return { changedFiles: changed, startHead: start.head };
}

/**
 * Capture + persist a turn-boundary snapshot. Best-effort: any failure logs and
 * returns, so review scoping degrades but the turn lifecycle is never disrupted.
 *
 * `captured` lets a caller that already snapshotted this worktree moments ago
 * hand the result over instead of walking it again — see the reviewer spawn in
 * WorkflowEngine.startAdhocReview.
 */
export async function recordTurnSnapshot(
  storage: Storage,
  sessionId: string,
  turnEndIndex: number,
  worktreePath: string,
  captured?: SnapshotState | null,
): Promise<void> {
  try {
    const snap = captured ?? captureSnapshot(worktreePath);
    if (!snap) return;
    await storage.turnSnapshots.create({
      session_id: sessionId,
      turn_end_index: turnEndIndex,
      head: snap.head,
      dirty: snap.dirty,
    });
  } catch (err) {
    console.warn(`[ReviewSnapshot] failed to record snapshot for ${sessionId}@${turnEndIndex}:`, (err as Error).message);
  }
}

/**
 * Resolve the start-boundary snapshot for a review's span. `session_start`
 * uses the session-start (-1) snapshot; `this_turn` uses the snapshot
 * immediately before the reviewed turn. Undefined when the chosen snapshot
 * is missing (pre-feature session / capture failure) — the caller degrades
 * to a null scope.
 */
export async function resolveStartSnapshot(
  storage: Storage,
  sessionId: string,
  span: ReviewSpan,
  turnEndIndex: number,
): Promise<SnapshotState | undefined> {
  return span === "session_start"
    ? storage.turnSnapshots.getSessionStart(sessionId)
    : storage.turnSnapshots.getStartBoundary(sessionId, turnEndIndex);
}
