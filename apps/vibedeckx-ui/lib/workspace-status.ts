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
 * The activity map is the SSE-backed source of truth for branches with DB
 * sessions. `isPlaceholder` overrides it to "idle" for branches the user has
 * explicitly reset via New Conversation but not yet sent a first message on
 * — the backend has no signal for that intent (no DB row), so without this
 * override the prior session's "completed"/"stopped" state would survive any
 * project switch and clobber the gray dot. See `lib/placeholder-workspaces.ts`.
 */
export function computeWorkspaceStatuses(
  worktrees: Worktree[] | undefined,
  backendStatuses: Map<string, WorkspaceStatus>,
  isPlaceholder?: (branch: string | null) => boolean,
): Map<string, WorkspaceStatus> {
  const map = new Map<string, WorkspaceStatus>();
  if (!worktrees) return map;

  for (const wt of worktrees) {
    const branchKey = toBranchKey(wt.branch);
    if (isPlaceholder?.(wt.branch)) {
      map.set(branchKey, "idle");
    } else {
      map.set(branchKey, backendStatuses.get(branchKey) ?? "idle");
    }
  }
  return map;
}
