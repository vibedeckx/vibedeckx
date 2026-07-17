import { execFileSync } from "child_process";
import { createHash } from "crypto";

const MAX_BUFFER = 10 * 1024 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Lightweight capture of the workspace state at review time (spec §3.3).
 * We store a digest, never the patch text itself (size / binary / sensitive
 * content concerns). The digest covers uncommitted changes and untracked
 * files, which a bare HEAD comparison would miss.
 */
export interface ReviewTarget {
  baseHead: string | null;
  diffDigest: string | null;
  diffStat: string | null;
  capturedAt: number;
}

export function captureReviewTarget(worktreePath: string): ReviewTarget {
  try {
    const baseHead = git(worktreePath, ["rev-parse", "HEAD"]).trim();
    const diff = git(worktreePath, ["diff"]);
    const status = git(worktreePath, ["status", "--porcelain"]);
    const diffDigest = createHash("sha256")
      .update(diff)
      .update("\0")
      .update(status)
      .digest("hex");
    const diffStat = git(worktreePath, ["diff", "--shortstat"]).trim() || null;
    return { baseHead, diffDigest, diffStat, capturedAt: Date.now() };
  } catch {
    return {
      baseHead: null,
      diffDigest: null,
      diffStat: null,
      capturedAt: Date.now(),
    };
  }
}

export function hasDrifted(
  worktreePath: string,
  target: ReviewTarget
): boolean {
  if (!target.baseHead || !target.diffDigest) return false;
  const current = captureReviewTarget(worktreePath);
  if (!current.baseHead || !current.diffDigest) return false;
  return (
    current.baseHead !== target.baseHead ||
    current.diffDigest !== target.diffDigest
  );
}
