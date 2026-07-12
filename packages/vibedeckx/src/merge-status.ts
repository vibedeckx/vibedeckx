import { execFileSync } from "child_process";
import { parseGitWorktreeList } from "./utils/worktree-paths.js";

/**
 * Merged-ness detection for workspace branches vs a target branch.
 * See docs/superpowers/specs/2026-07-12-branch-merge-status-design.md.
 */

export type MergeStatusValue = "merged" | "partial" | "unmerged" | "no-unique-commits";

export interface MergeStatusEntry {
  branch: string;
  status: MergeStatusValue;
  unmergedCount: number;
  dirty: boolean;
}

export interface MergeStatusResponse {
  target: string;
  entries: MergeStatusEntry[];
}

const MAX_BUFFER = 10 * 1024 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function revParse(repoPath: string, ref: string): string | null {
  try {
    return git(repoPath, ["rev-parse", "--verify", ref]).trim();
  } catch {
    return null;
  }
}

export function validateBranchExists(repoPath: string, branch: string): boolean {
  return revParse(repoPath, `refs/heads/${branch}`) !== null;
}

export function detectDefaultBranch(repoPath: string): string {
  for (const candidate of ["main", "master"]) {
    if (validateBranchExists(repoPath, candidate)) return candidate;
  }
  throw Object.assign(new Error("No default branch (main/master) found"), { statusCode: 400 });
}

interface CachedStatus {
  branchTip: string;
  targetTip: string;
  status: MergeStatusValue;
  unmergedCount: number;
}

// Tip-keyed: an entry is valid as long as neither the branch tip nor the
// target tip has moved. `dirty` is intentionally NOT cached — working-tree
// changes don't move tips.
const statusCache = new Map<string, CachedStatus>();

export function clearMergeStatusCache(): void {
  statusCache.clear();
}

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  try {
    git(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tiered detection: tip equality → merge-base ancestor (normal/ff merges) →
 * `git cherry` patch-ids (rebase / cherry-pick merges). Squash merges are a
 * known phase-1 limitation: they show as unmerged (conservative).
 */
export function computeBranchMergeStatus(
  repoPath: string,
  branch: string,
  target: string,
): { status: MergeStatusValue; unmergedCount: number } {
  const branchTip = revParse(repoPath, `refs/heads/${branch}`);
  const targetTip = revParse(repoPath, `refs/heads/${target}`);
  if (!branchTip || !targetTip) {
    const missing = !branchTip ? branch : target;
    throw Object.assign(new Error(`Branch not found: ${missing}`), { statusCode: 400 });
  }

  const cacheKey = `${repoPath}\0${branch}\0${target}`;
  const cached = statusCache.get(cacheKey);
  if (cached && cached.branchTip === branchTip && cached.targetTip === targetTip) {
    return { status: cached.status, unmergedCount: cached.unmergedCount };
  }

  let status: MergeStatusValue;
  let unmergedCount = 0;

  if (branchTip === targetTip) {
    status = "no-unique-commits";
  } else if (isAncestor(repoPath, branchTip, targetTip)) {
    status = "merged";
  } else {
    // git cherry only outputs commits "yet to be applied" ("+"), not already-applied ("-").
    // Count total commits on branch (all commits minus the root).
    const logOutput = git(repoPath, ["log", "--oneline", branch]).trim().split("\n").filter(Boolean);
    const totalCount = logOutput.length - 1; // exclude root/base commit

    // git cherry shows commits "yet to be applied" (start with "+").
    const cherryLines = git(repoPath, ["cherry", target, branch]).trim().split("\n").filter(Boolean);
    unmergedCount = cherryLines.filter((l) => l.startsWith("+")).length;

    // Determine status based on total vs unmerged count.
    if (totalCount === 0) status = "no-unique-commits";
    else if (unmergedCount === 0) status = "merged";
    else if (unmergedCount < totalCount) status = "partial";
    else status = "unmerged";
  }

  statusCache.set(cacheKey, { branchTip, targetTip, status, unmergedCount });
  return { status, unmergedCount };
}

function isDirty(worktreePath: string): boolean {
  try {
    return git(worktreePath, ["status", "--porcelain"]).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Merge status for every worktree branch of `repoPath` vs `target`
 * (auto-detected default branch when omitted). Worktree → branch mapping is
 * read live — users switch branches inside worktrees with git commands.
 */
export function computeMergeStatus(repoPath: string, target?: string): MergeStatusResponse {
  if (target && !validateBranchExists(repoPath, target)) {
    throw Object.assign(new Error(`Target branch not found: ${target}`), { statusCode: 400 });
  }
  const resolvedTarget = target ?? detectDefaultBranch(repoPath);

  const entries: MergeStatusEntry[] = [];
  for (const wt of parseGitWorktreeList(repoPath)) {
    if (!wt.branch || wt.branch === resolvedTarget) continue;
    const { status, unmergedCount } = computeBranchMergeStatus(repoPath, wt.branch, resolvedTarget);
    entries.push({ branch: wt.branch, status, unmergedCount, dirty: isDirty(wt.path) });
  }
  return { target: resolvedTarget, entries };
}
