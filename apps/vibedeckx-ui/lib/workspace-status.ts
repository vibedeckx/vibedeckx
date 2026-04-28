import type { Worktree, Task } from "@/lib/api";

export type WorkspaceStatus = "idle" | "assigned" | "working" | "completed";

/** Session status values from polling. Duplicated here to avoid importing from a React hook file. */
export type AgentSessionStatus = "running" | "stopped" | "error";

/** Normalize null branch (main worktree) to empty string for Map keys. */
export function toBranchKey(branch: string | null): string {
  return branch === null ? "" : branch;
}

/**
 * Compute workspace statuses for all worktrees.
 *
 * Two-tier fallback:
 * 1. Realtime statuses (event-driven, highest priority)
 * 2. Polling/task data (session status + assigned tasks)
 *
 * The selected branch's polling session status is ignored because
 * auto-start creates idle "running" sessions.
 */
export function computeWorkspaceStatuses(
  worktrees: Worktree[] | undefined,
  realtimeStatuses: Map<string, WorkspaceStatus>,
  sessionStatuses: Map<string, AgentSessionStatus>,
  tasks: Task[],
  selectedBranch: string | null
): Map<string, WorkspaceStatus> {
  const map = new Map<string, WorkspaceStatus>();
  if (!worktrees) return map;

  const selectedKey = toBranchKey(selectedBranch);

  for (const wt of worktrees) {
    const branchKey = toBranchKey(wt.branch);

    // 1. Event-driven status (user has interacted with this branch)
    const realtimeStatus = realtimeStatuses.get(branchKey);
    if (realtimeStatus !== undefined) {
      map.set(branchKey, realtimeStatus);
      continue;
    }

    // 2. Fallback: polling + task data
    //    Ignore polling for selected branch (auto-start creates idle "running" sessions)
    const sessionStatus =
      branchKey === selectedKey ? undefined : sessionStatuses.get(branchKey);
    const assignedTaskForBranch = tasks.find(
      (t) => t.assigned_branch === branchKey
    );

    if (assignedTaskForBranch && assignedTaskForBranch.status === "done") {
      map.set(branchKey, "completed");
    } else if (sessionStatus === "running") {
      map.set(branchKey, "working");
    } else if (assignedTaskForBranch) {
      map.set(branchKey, "assigned");
    } else {
      map.set(branchKey, "idle");
    }
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

/** Set a branch's realtime status to "completed". */
export function applyStatusCompleted(
  prev: Map<string, WorkspaceStatus>,
  branch: string | null
): Map<string, WorkspaceStatus> {
  const next = new Map(prev);
  next.set(toBranchKey(branch), "completed");
  return next;
}

/** Remove a branch's realtime status so polling/task fallback takes over. */
export function clearRealtimeStatus(
  prev: Map<string, WorkspaceStatus>,
  branch: string | null
): Map<string, WorkspaceStatus> {
  const next = new Map(prev);
  next.delete(toBranchKey(branch));
  return next;
}

/**
 * Apply a global session status event.
 * - "running" → set realtime "working"
 * - "stopped" → clear realtime entry, but preserve "completed" (the backend
 *   emits session:status=stopped immediately after taskCompleted; clearing
 *   would erase the green dot for projects without an assigned task)
 * - "error" → clear realtime entry
 *
 * Returns the new realtime statuses map and whether tasks should be refetched.
 */
export function applyGlobalSessionStatus(
  prev: Map<string, WorkspaceStatus>,
  branch: string | null,
  status: AgentSessionStatus
): { realtimeStatuses: Map<string, WorkspaceStatus>; shouldRefetchTasks: boolean } {
  if (status === "running") {
    return {
      realtimeStatuses: applyStatusWorking(prev, branch),
      shouldRefetchTasks: false,
    };
  }
  if (status === "stopped" && prev.get(toBranchKey(branch)) === "completed") {
    return { realtimeStatuses: prev, shouldRefetchTasks: true };
  }
  return {
    realtimeStatuses: clearRealtimeStatus(prev, branch),
    shouldRefetchTasks: true,
  };
}
