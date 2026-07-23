import { execFileSync } from "child_process";
import type { Storage } from "../storage/types.js";

const MAX_BUFFER = 10 * 1024 * 1024;

/** Sentinel content hash for a path that does not exist at a boundary. */
export const ABSENT = "absent";

export interface SnapshotState {
  head: string;
  /** path -> git blob sha of the uncommitted content, or ABSENT for a deletion. */
  dirty: Record<string, string>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
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
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const status = line.slice(0, tab).trim();
      const p = line.slice(tab + 1).trim();
      dirty[p] = status.startsWith("D") ? ABSENT : git(worktreePath, ["hash-object", p]).trim();
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
      if (t) dirty[t] = git(worktreePath, ["hash-object", t]).trim();
    }

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

  const changed: string[] = [];
  for (const f of candidates) {
    const startSha = start.dirty[f] ?? blobShaOrAbsent(worktreePath, start.head, f);
    const endSha = end.dirty[f] ?? blobShaOrAbsent(worktreePath, end.head, f);
    if (startSha !== endSha) changed.push(f);
  }
  changed.sort();
  return { changedFiles: changed, startHead: start.head };
}

/**
 * Capture + persist a turn-boundary snapshot. Best-effort: any failure logs and
 * returns, so review scoping degrades but the turn lifecycle is never disrupted.
 */
export async function recordTurnSnapshot(
  storage: Storage,
  sessionId: string,
  turnEndIndex: number,
  worktreePath: string,
): Promise<void> {
  try {
    const snap = captureSnapshot(worktreePath);
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
