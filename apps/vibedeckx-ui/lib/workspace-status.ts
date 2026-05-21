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
 * Optional timing inputs that let the placeholder override reason about a
 * *terminal* orchestrator dot (`main-completed`). Both return epoch ms.
 *
 *   - `backendSince(branch)`   — when the orchestrator emitted its current dot.
 *   - `placeholderSince(branch)` — when the user reset the workspace via New
 *                                  Conversation.
 *
 * When omitted, `computeWorkspaceStatuses` falls back to keeping
 * `main-completed` (the pre-timing behavior).
 */
export interface WorkspaceStatusTiming {
  backendSince?: (branch: string | null) => number | undefined;
  placeholderSince?: (branch: string | null) => number | undefined;
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
 * dot is shared with the chat orchestrator, so orchestrator states need care:
 *
 *   - `main-running` is genuinely live — the orchestrator is working right now
 *     — so it always wins over the placeholder. Otherwise sending a message in
 *     the chat window after New Conversation would leave the dot gray instead
 *     of turning it violet.
 *   - `main-completed` is *terminal*. Whether it wins depends on ordering: a
 *     reset performed AFTER the orchestrator completed is the newer intent and
 *     wins (gray); an orchestrator completion that landed AFTER the reset keeps
 *     its green dot. This is resolved by comparing `since` timestamps via the
 *     optional `timing` argument. Without timing info we keep `main-completed`
 *     (the conservative pre-timing behavior).
 */
export function computeWorkspaceStatuses(
  worktrees: Worktree[] | undefined,
  backendStatuses: Map<string, WorkspaceStatus>,
  isPlaceholder?: (branch: string | null) => boolean,
  timing?: WorkspaceStatusTiming,
): Map<string, WorkspaceStatus> {
  const map = new Map<string, WorkspaceStatus>();
  if (!worktrees) return map;

  for (const wt of worktrees) {
    const branchKey = toBranchKey(wt.branch);
    const backend = backendStatuses.get(branchKey);

    if (!isPlaceholder?.(wt.branch)) {
      map.set(branchKey, backend ?? "idle");
      continue;
    }

    // Placeholder is active for this branch.
    if (backend === "main-running") {
      // Live orchestrator work — always wins over the reset.
      map.set(branchKey, "main-running");
    } else if (backend === "main-completed") {
      // Terminal orchestrator dot: the reset wins only if it happened after
      // the orchestrator completed. A completion that ran after the reset
      // (e.g. user reset the agent, then drove the chat to completion) keeps
      // its green dot.
      const orchestratorSince = timing?.backendSince?.(wt.branch) ?? 0;
      const resetSince = timing?.placeholderSince?.(wt.branch) ?? 0;
      map.set(branchKey, resetSince > orchestratorSince ? "idle" : "main-completed");
    } else {
      // Stale agent-derived state (completed/stopped/working/idle) — the reset
      // is the newer intent, so the dot is gray.
      map.set(branchKey, "idle");
    }
  }
  return map;
}
