import type { Worktree } from "@/lib/api";

export type WorkspaceStatus = "idle" | "working" | "completed";

/** Normalize null branch (main worktree) to empty string for Map keys. */
export function toBranchKey(branch: string | null): string {
  return branch === null ? "" : branch;
}

/**
 * Compute workspace statuses for all worktrees.
 *
 * Two-tier fallback:
 * 1. Realtime overlay (optimistic, set by user actions like message-send /
 *    New Conversation — for sub-50ms feedback before the SSE event lands)
 * 2. Backend-derived activity (single source of truth, see
 *    `useBranchActivity` and `plans/branch-activity-refactor.md`)
 */
export function computeWorkspaceStatuses(
  worktrees: Worktree[] | undefined,
  realtimeStatuses: Map<string, WorkspaceStatus>,
  backendStatuses: Map<string, WorkspaceStatus>
): Map<string, WorkspaceStatus> {
  const map = new Map<string, WorkspaceStatus>();
  if (!worktrees) return map;

  for (const wt of worktrees) {
    const branchKey = toBranchKey(wt.branch);
    map.set(
      branchKey,
      realtimeStatuses.get(branchKey) ?? backendStatuses.get(branchKey) ?? "idle"
    );
  }
  return map;
}

/** Set a branch's realtime status to "working". */
export function applyStatusWorking(
  prev: Map<string, WorkspaceStatus>,
  branch: string | null
): Map<string, WorkspaceStatus> {
  const next = new Map(prev);
  next.set(toBranchKey(branch), "working");
  return next;
}

/** Remove a branch's realtime status so the backend-derived value takes over. */
export function clearRealtimeStatus(
  prev: Map<string, WorkspaceStatus>,
  branch: string | null
): Map<string, WorkspaceStatus> {
  const next = new Map(prev);
  next.delete(toBranchKey(branch));
  return next;
}
