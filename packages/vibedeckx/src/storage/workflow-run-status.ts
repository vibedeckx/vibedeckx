import type { WorkflowRunStatus } from "./types.js";

/**
 * The non-terminal workflow-run states: the engine is still tracking the run
 * in memory and will keep delivering to its participant sessions.
 *
 * Shared on purpose. Session retention exempts participants of an ACTIVE run
 * from deletion (docs/plans/2026-08-08-session-retention.md §1.2), and that
 * exemption is only correct if it uses exactly the same status set the engine
 * treats as live — two independent copies would drift the moment a state is
 * added, and the drift would show up as a silently deleted participant.
 */
export const WORKFLOW_ACTIVE_STATUSES: readonly WorkflowRunStatus[] = [
  "preparing",
  "waiting_reviewer",
  "waiting_feedback",
  "discussing",
  "sending_feedback",
];
