import { execFileSync } from "child_process";

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
    const nameStatus = git(worktreePath, ["diff", "HEAD", "--name-status", "--no-renames"]);
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const status = line.slice(0, tab).trim();
      const p = line.slice(tab + 1).trim();
      dirty[p] = status.startsWith("D") ? ABSENT : git(worktreePath, ["hash-object", p]).trim();
    }

    // Untracked files (never added) — always additions.
    const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
    for (const p of untracked.split("\n")) {
      const t = p.trim();
      if (t) dirty[t] = git(worktreePath, ["hash-object", t]).trim();
    }

    return { head, dirty };
  } catch {
    return null;
  }
}
