import { rethrowGitTimeout, runGit } from "./utils/git-exec.js";
import { parseGitWorktreeList } from "./utils/worktree-paths.js";

/**
 * Merged-ness detection for workspace branches vs a target branch.
 * See docs/superpowers/specs/2026-07-12-branch-merge-status-design.md.
 *
 * All git runs async (the sidebar polls this every 30–60s per workspace). A
 * catch that reads a git failure as "no" rethrows timeouts first, so a slow
 * repo fails the request with a 504 instead of showing a wrong badge.
 */

export type MergeStatusValue = "merged" | "partial" | "unmerged" | "no-unique-commits";

async function revParse(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await runGit(repoPath, ["rev-parse", "--verify", ref])).trim();
  } catch (err) {
    rethrowGitTimeout(err);
    return null;
  }
}

export async function validateBranchExists(repoPath: string, branch: string): Promise<boolean> {
  return (await revParse(repoPath, `refs/heads/${branch}`)) !== null;
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  for (const candidate of ["main", "master"]) {
    if (await validateBranchExists(repoPath, candidate)) return candidate;
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

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (err) {
    rethrowGitTimeout(err);
    return false;
  }
}

/**
 * Tree-level containment: does `branch` add any content to `target`? Merge
 * branch into target in memory; if the merged tree equals target's own tree,
 * branch contributes nothing new and is fully merged.
 *
 * This backstops `git cherry`, which compares per-commit patch-ids (diffs) and
 * so misses work that already lives in target once the diff changed — e.g. a
 * rebase whose new base touched lines within the ~3-line diff context window
 * (patch-id hashes context lines), or a squash merge (one commit, no matching
 * patch-ids). A merge conflict means genuinely divergent content, so
 * `merge-tree --write-tree` exits non-zero and we return false. Requires git
 * >= 2.38; on any failure we return false and keep the conservative cherry
 * result — this check only ever downgrades "unmerged/partial" to "merged", it
 * never hides real unmerged work.
 */
async function branchContentContainedInTarget(
  repoPath: string,
  branch: string,
  target: string,
): Promise<boolean> {
  try {
    const mergedTree = (await runGit(repoPath, ["merge-tree", "--write-tree", target, branch]))
      .split("\n", 1)[0]
      .trim();
    const targetTree = await revParse(repoPath, `${target}^{tree}`);
    return targetTree !== null && mergedTree === targetTree;
  } catch (err) {
    rethrowGitTimeout(err);
    return false;
  }
}

/**
 * Tiered detection: tip equality → merge-base ancestor (normal/ff merges) →
 * `git cherry` patch-ids (rebase / cherry-pick merges) → `git merge-tree`
 * content containment (catches rebases whose diff shifted and squash merges,
 * which patch-ids miss). Each tier is cheaper than the next and only runs when
 * the prior one is inconclusive.
 */
export async function computeBranchMergeStatus(
  repoPath: string,
  branch: string,
  target: string,
): Promise<{ status: MergeStatusValue; unmergedCount: number }> {
  const branchTip = await revParse(repoPath, `refs/heads/${branch}`);
  const targetTip = await revParse(repoPath, `refs/heads/${target}`);
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
  } else if (await isAncestor(repoPath, branchTip, targetTip)) {
    status = "merged";
  } else {
    const lines = (await runGit(repoPath, ["cherry", target, branch])).trim().split("\n").filter(Boolean);
    unmergedCount = lines.filter((l) => l.startsWith("+")).length;
    if (lines.length === 0) status = "no-unique-commits";
    else if (unmergedCount === 0) status = "merged";
    else if (unmergedCount < lines.length) status = "partial";
    else status = "unmerged";

    // Tier 4: cherry (patch-id) misses rebases whose diff shifted and squash
    // merges even when the content already lives in target. Confirm at the
    // tree level before trusting an unmerged/partial verdict.
    if (unmergedCount > 0 && (await branchContentContainedInTarget(repoPath, branch, target))) {
      status = "merged";
      unmergedCount = 0;
    }
  }

  statusCache.set(cacheKey, { branchTip, targetTip, status, unmergedCount });
  return { status, unmergedCount };
}

async function isDirty(worktreePath: string): Promise<boolean> {
  try {
    return (await runGit(worktreePath, ["status", "--porcelain"])).trim().length > 0;
  } catch (err) {
    rethrowGitTimeout(err);
    return false;
  }
}

export interface MergeComparison {
  branch: string;
  /** Omitted = compare against the auto-detected default branch (main/master). */
  target?: string;
}

export type MergePairError = "target-not-found" | "branch-not-found" | "no-default-branch";

export interface MergeStatusPairEntry {
  branch: string;
  /** Resolved target branch; null when errored before resolution. */
  target: string | null;
  status?: MergeStatusValue;
  unmergedCount?: number;
  dirty?: boolean;
  error?: MergePairError;
}

/**
 * Merge status for explicit branch-target pairs. Computes exactly what was
 * asked: no worktree enumeration beyond the dirty lookup, dirty checked once
 * per branch per call, default branch resolved at most once per call.
 * Pair-level problems are reported per entry, never thrown.
 */
export async function computeMergeStatusPairs(
  repoPath: string,
  comparisons: MergeComparison[],
): Promise<MergeStatusPairEntry[]> {
  // Worktree paths for dirty checks — enumerated once per call. A branch not
  // checked out in any worktree has no working tree, so dirty = false.
  const worktreePathByBranch = new Map<string, string>();
  for (const wt of parseGitWorktreeList(repoPath)) {
    if (wt.branch) worktreePathByBranch.set(wt.branch, wt.path);
  }

  let defaultTarget: string | null | undefined; // undefined = not resolved yet
  const dirtyByBranch = new Map<string, boolean>();

  // Sequential on purpose: one git at a time per request keeps a project with
  // many workspaces from fanning out dozens of processes on every poll.
  const entries: MergeStatusPairEntry[] = [];
  for (const cmp of comparisons) {
    entries.push(await computePair(cmp));
  }
  return entries;

  async function computePair(cmp: MergeComparison): Promise<MergeStatusPairEntry> {
    let target = cmp.target;
    if (!target) {
      if (defaultTarget === undefined) {
        try {
          defaultTarget = await detectDefaultBranch(repoPath);
        } catch (err) {
          rethrowGitTimeout(err);
          defaultTarget = null;
        }
      }
      if (defaultTarget === null) {
        return { branch: cmp.branch, target: null, error: "no-default-branch" };
      }
      target = defaultTarget;
    } else if (!(await validateBranchExists(repoPath, target))) {
      return { branch: cmp.branch, target: null, error: "target-not-found" };
    }

    if (!(await validateBranchExists(repoPath, cmp.branch))) {
      return { branch: cmp.branch, target, error: "branch-not-found" };
    }

    const { status, unmergedCount } = await computeBranchMergeStatus(repoPath, cmp.branch, target);
    let dirty = dirtyByBranch.get(cmp.branch);
    if (dirty === undefined) {
      const wtPath = worktreePathByBranch.get(cmp.branch);
      dirty = wtPath ? await isDirty(wtPath) : false;
      dirtyByBranch.set(cmp.branch, dirty);
    }
    return { branch: cmp.branch, target, status, unmergedCount, dirty };
  }
}
