import type { Worktree } from "@/lib/api";

export type WorkspaceStatus = "idle" | "working" | "completed" | "stopped";

/** Normalize null branch (main worktree) to empty string for Map keys. */
export function toBranchKey(branch: string | null): string {
  return branch === null ? "" : branch;
}

/**
 * Project the per-branch activity map across the visible worktree list,
 * filling in "idle" for any worktree the backend hasn't reported on yet.
 *
 * The activity map is the single source of truth. Optimistic transitions
 * (send → "working", New Conversation → "idle") are seeded directly into
 * that map via `useBranchActivity.setOptimisticActivity`; there is no
 * separate "realtime overlay" tier to merge here.
 */
export function computeWorkspaceStatuses(
  worktrees: Worktree[] | undefined,
  backendStatuses: Map<string, WorkspaceStatus>
): Map<string, WorkspaceStatus> {
  const map = new Map<string, WorkspaceStatus>();
  if (!worktrees) return map;

  for (const wt of worktrees) {
    const branchKey = toBranchKey(wt.branch);
    map.set(branchKey, backendStatuses.get(branchKey) ?? "idle");
  }
  return map;
}
