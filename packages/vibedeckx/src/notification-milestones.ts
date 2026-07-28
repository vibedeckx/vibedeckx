import type { AgentMessage, NotificationDisposition, TurnOutcome } from "./agent-types.js";
import type { NotificationOutboxEvent } from "./storage/types.js";

/**
 * Deterministic milestone identity. Both the live turn-completion path and
 * startup crash repair derive ids from the same durable facts (session id +
 * turn_end entry index, or workflow run id), so a retried transaction
 * re-derives the same id and the outbox's UNIQUE(id) absorbs it instead of
 * producing a second notification.
 */
export const sessionResultReadyId = (sessionId: string, turnEndEntryIndex: number): string =>
  `session:${sessionId}:turn:${turnEndEntryIndex}:result-ready`;

export const sessionFailedId = (sessionId: string, turnEndEntryIndex: number): string =>
  `session:${sessionId}:turn:${turnEndEntryIndex}:failed`;

/**
 * Per-round: one review run can open the gate multiple times (initial review,
 * then each "final verdict" after a discussion round). The turn boundary index
 * of the reviewer turn that produced the verdict distinguishes rounds; a
 * replayed taskCompleted for the same turn must still collapse onto one id.
 */
export const reviewReadyId = (workflowRunId: string, turnEndEntryIndex: number): string =>
  `workflow:${workflowRunId}:turn:${turnEndEntryIndex}:review-ready`;

/**
 * `stateVersion` is the state the run failed OUT OF. Two distinct failures of
 * one run (e.g. a reviewer-stage failure and a later feedback-stage failure)
 * are separate attention milestones and must not collapse onto one id; a
 * retried transition out of the same state must.
 */
export const workflowFailedId = (workflowRunId: string, stateVersion: string): string =>
  `workflow:${workflowRunId}:failed:${stateVersion}`;

/**
 * Find the user entry that OPENED the turn ending at `beforeIndex`. Walks back
 * to the previous turn boundary and keeps the earliest user entry seen, so
 * mid-turn steering messages (which are also `user` entries) can't be mistaken
 * for the turn's opener and silently flip its disposition.
 *
 * `entries` is the sparse entry array — holes are skipped, not treated as
 * boundaries.
 */
export function findTurnOpeningUserEntry(
  entries: Array<AgentMessage | undefined>,
  beforeIndex: number,
): AgentMessage | undefined {
  let opening: AgentMessage | undefined;
  for (let i = Math.min(beforeIndex, entries.length) - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === "turn_end") break;
    if (entry.type === "user") opening = entry;
  }
  return opening;
}

/**
 * Resolve a turn's notification disposition from its opening user entry.
 *
 * Legacy entries (persisted before the field existed) have no disposition:
 * ordinary input resolves to `result`, while `origin: "workflow"` resolves to
 * `internal` so an old reviewer/helper turn can't produce a false generic
 * notification. A turn with no discoverable opener also resolves to `result` —
 * a turn was demonstrably in flight, and a missed milestone is worse for the
 * user than a redundant one.
 */
export function resolveNotificationDisposition(
  openingUserEntry: AgentMessage | undefined,
): NotificationDisposition {
  if (openingUserEntry?.type !== "user") return "result";
  if (openingUserEntry.notificationDisposition) return openingUserEntry.notificationDisposition;
  return openingUserEntry.origin === "workflow" ? "internal" : "result";
}

/** Terminal outcomes that mean "the user's work did not land". */
const FAILURE_OUTCOMES: ReadonlySet<TurnOutcome> = new Set<TurnOutcome>([
  "failed",
  "process_exit",
  "server_restart",
]);

/**
 * The outbox row a turn_end deserves, or undefined for none.
 *
 * Only `result` turns produce a generic session milestone. `stopped` never
 * produces one: a user-initiated Stop is the user already knowing.
 */
export function sessionMilestoneForTurnEnd(opts: {
  sessionId: string;
  projectId: string;
  branch: string | null;
  entryIndex: number;
  outcome: TurnOutcome;
  disposition: NotificationDisposition;
  createdAt: number;
}): Omit<NotificationOutboxEvent, "seq"> | undefined {
  if (opts.disposition !== "result") return undefined;

  const base = {
    project_id: opts.projectId,
    branch: opts.branch,
    session_id: opts.sessionId,
    workflow_run_id: null,
    created_at: opts.createdAt,
  };

  if (opts.outcome === "completed") {
    return {
      ...base,
      id: sessionResultReadyId(opts.sessionId, opts.entryIndex),
      kind: "session_result_ready",
    };
  }
  if (FAILURE_OUTCOMES.has(opts.outcome)) {
    return {
      ...base,
      id: sessionFailedId(opts.sessionId, opts.entryIndex),
      kind: "session_failed",
    };
  }
  return undefined;
}
