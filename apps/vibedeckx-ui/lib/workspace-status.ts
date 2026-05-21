import type { Worktree } from "@/lib/api";

export type WorkspaceStatus =
  | "idle"
  | "working"
  | "completed"
  | "stopped"
  | "main-running"
  | "main-completed";

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
 *
 * The placeholder is the *agent* window's "no DB session yet" intent, but the
 * dot is shared with the chat orchestrator. A live orchestrator state
 * (`main-running`/`main-completed`, emitted by chat-session-manager) is
 * current, not stale, so it wins over the placeholder — otherwise sending a
 * message in the chat window after New Conversation would leave the dot gray
 * instead of turning it violet.
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
    const backend = backendStatuses.get(branchKey);
    const isLiveOrchestrator =
      backend === "main-running" || backend === "main-completed";
    if (isPlaceholder?.(wt.branch) && !isLiveOrchestrator) {
      map.set(branchKey, "idle");
    } else {
      map.set(branchKey, backend ?? "idle");
    }
  }
  return map;
}
