import type { AgentSession } from "./storage/types.js";

/**
 * Derived activity state per branch. The single source of truth for
 * workspace status indicators (idle / working / completed dot color) — see
 * `plans/branch-activity-refactor.md`.
 *
 * The `main-*` variants are emitted directly by ChatSessionManager (the
 * orchestrator chat) and are NEVER returned by `computeBranchActivity`,
 * which only derives state from the coding-agent `agent_sessions` table.
 * They override the agent-derived dot color so users can visually tell
 * "orchestrator is running" apart from "coding agent is running".
 */
export type BranchActivity =
  | "idle"
  | "working"
  | "completed"
  | "stopped"
  | "main-running"
  | "main-completed";

export interface BranchActivityState {
  activity: BranchActivity;
  /** Epoch ms of the event that determined this state, or 0 for idle-from-no-events. */
  since: number;
}

/**
 * Compute branch activity from agent_sessions. For each branch, picks the
 * session with the most recent `updated_at` and derives the state from its
 * timestamps + status:
 *   - working   if status === "running" AND last_user_message_at > (last_completed_at ?? 0)
 *   - stopped   if status !== "running" AND last_user_message_at > (last_completed_at ?? 0)
 *               (user clicked Stop, or process errored mid-turn)
 *   - completed if last_completed_at >= last_user_message_at (and any > 0)
 *   - idle      no timestamps yet (fresh session, never received any messages)
 *
 * `stopped` exists as a distinct state from `idle` so the sidebar dot can
 * surface "you abandoned work here, come back to it" — visually different
 * from a fresh workspace that never had any activity.
 *
 * Picking the latest session (rather than aggregating across all sessions)
 * gives "New Conversation" the correct reset semantics: creating a fresh
 * session bumps `updated_at`, the new session has no timestamps, and the
 * branch correctly reports idle. Older sessions' completed state on the same
 * branch doesn't bleed forward.
 *
 * `updated_at` is touched by user messages (via `persistEntry`/`touchUpdatedAt`)
 * but intentionally NOT by `markCompleted` — so a session that's "completed"
 * stays the latest until the user starts a new conversation or messages a
 * different session.
 *
 * Pure function — no side effects, no DB access. Callers pass the AgentSession
 * rows already loaded from storage.
 */
export function computeBranchActivity(
  sessions: AgentSession[]
): Map<string, BranchActivityState> {
  const latestByBranch = new Map<string, AgentSession>();

  for (const s of sessions) {
    const key = s.branch ?? "";
    const prev = latestByBranch.get(key);
    if (!prev || compareUpdatedAt(s, prev) > 0) {
      latestByBranch.set(key, s);
    }
  }

  const result = new Map<string, BranchActivityState>();
  for (const [branch, s] of latestByBranch) {
    const lastUser = s.last_user_message_at ?? 0;
    const lastCompleted = s.last_completed_at ?? 0;
    if (lastUser === 0 && lastCompleted === 0) {
      result.set(branch, { activity: "idle", since: 0 });
    } else if (lastUser > lastCompleted) {
      if (s.status === "running") {
        result.set(branch, { activity: "working", since: lastUser });
      } else {
        result.set(branch, { activity: "stopped", since: lastUser });
      }
    } else {
      result.set(branch, { activity: "completed", since: lastCompleted });
    }
  }
  return result;
}

/**
 * Stateful dedupe gate for `branch:activity` emissions. The backend has many
 * state-changing operations that all want to publish activity; rather than
 * each one guessing whether the state actually changed, they go through this
 * gate so a redundant emit (same activity as the last one we sent for this
 * branch) is dropped at the source.
 *
 * Concrete bug this guards against: clicking Stop then New Conversation
 * re-runs `stopSession` on the already-stopped session, which without this
 * gate re-emits `branch:activity:stopped` and clobbers the frontend's
 * optimistic "idle" overlay.
 *
 * Keyed by `${projectId}::${branch ?? ""}`. The cache only stores the
 * last-emitted activity value — `since` is not part of dedupe because the
 * value timestamp doesn't carry semantic state (and the frontend's stale-
 * event guard uses `since` separately for ordering, not for identity).
 */
export class BranchActivityDedupe {
  private cache = new Map<string, BranchActivity>();

  private key(projectId: string, branch: string | null): string {
    return `${projectId}::${branch ?? ""}`;
  }

  /**
   * Returns true if `next` differs from the last emit for this branch
   * (and updates the cache). Returns false on a redundant emit, leaving
   * the cache as-is.
   */
  shouldEmit(projectId: string, branch: string | null, next: BranchActivity): boolean {
    const k = this.key(projectId, branch);
    if (this.cache.get(k) === next) return false;
    this.cache.set(k, next);
    return true;
  }

  /**
   * Read the last-emitted activity for a branch without mutating the cache,
   * or undefined if nothing has been emitted yet. Lets callers reason about
   * what the dot currently shows (e.g. ChatSessionManager.markCompleted needs
   * to know whether a stale orchestrator `main-running` is still on screen).
   */
  peek(projectId: string, branch: string | null): BranchActivity | undefined {
    return this.cache.get(this.key(projectId, branch));
  }

  /**
   * Drop the cache entry for a branch — call when the branch's session
   * history is wiped (e.g. all sessions deleted) so the next emit isn't
   * suppressed against a stale post-deletion value.
   */
  forget(projectId: string, branch: string | null): void {
    this.cache.delete(this.key(projectId, branch));
  }
}

/**
 * Decide whether the chat orchestrator's `complete_task` tool should repaint
 * the workspace dot to `main-completed`.
 *
 * User-initiated turns always own the orchestrator dot, so they always clear
 * to `main-completed`. On reactive (event-driven) turns the dot normally
 * belongs to the subsystem (coding agent / executor) and must not be
 * repainted — EXCEPT when it still shows the orchestrator's own
 * `main-running`. That happens in the common "kick off async work, end the
 * turn, finish when the event arrives" flow: a prior user turn painted the
 * dot violet without completing, the work finished via an
 * `[Executor Event]` / `[Terminal Event]` / `[Agent Event]` turn, and that
 * reactive turn is where `complete_task` fires. `complete_task` is a
 * definitive "the user's overall task is done" signal, so it must clear that
 * stale violet rather than leave it stuck.
 *
 * Pure function — exported for tests.
 */
export function shouldEmitMainCompleted(
  eventDrivenTurn: boolean,
  currentDotActivity: BranchActivity | undefined,
): boolean {
  return !eventDrivenTurn || currentDotActivity === "main-running";
}

/**
 * Compare two sessions by `updated_at` (the millisecond-precision text format
 * is lex-sortable by design — see the schema comment in sqlite.ts). Falls back
 * to `created_at` when updated_at is missing on legacy rows.
 */
function compareUpdatedAt(a: AgentSession, b: AgentSession): number {
  const aTs = a.updated_at ?? a.created_at;
  const bTs = b.updated_at ?? b.created_at;
  if (aTs < bTs) return -1;
  if (aTs > bTs) return 1;
  return 0;
}
