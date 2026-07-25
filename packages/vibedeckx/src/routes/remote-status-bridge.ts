import type { AgentSessionStatus } from "../conversation-patch.js";
import type { GlobalEvent } from "../event-bus.js";
import type { RemoteSessionInfo } from "../server-types.js";
import type { WorkflowRun } from "../storage/types.js";
import type { ReviewerCandidate } from "../workflow-engine.js";

/**
 * Extract the projectId from a synthetic remote session id.
 *
 * Remote session ids are formatted `remote-{serverId}-{projectId}-{sessionId}`.
 * The serverId and sessionId are known from `remoteInfo`, so we strip the
 * known prefix/suffix. Falls back to a heuristic split for malformed ids.
 *
 * Single source of truth for this slicing. Both the status-bridge and the
 * taskCompleted-bridge in `websocket-routes.ts` call this helper.
 */
export function projectIdFromRemoteSessionId(
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
): string {
  const prefix = `remote-${remoteInfo.remoteServerId}-`;
  const suffix = `-${remoteInfo.remoteSessionId}`;
  if (sessionId.startsWith(prefix) && sessionId.endsWith(suffix)) {
    return sessionId.slice(prefix.length, sessionId.length - suffix.length);
  }
  return sessionId.split("-").slice(2, -1).join("-");
}

/**
 * If `parsed` is a JsonPatch message from a remote agent session that
 * contains a `/status` op with a valid status string, return the
 * `session:status` event payload to emit on the local EventBus.
 *
 * Returns `null` when the message does not carry a status update.
 *
 * Note: the workspace dot is now driven by `branch:activity` events, not
 * `session:status` — so the previous "first-emit suppression" hack to
 * absorb the remote `subscribe()` handshake's trailing status patch is no
 * longer needed. session:status events still flow for any legacy consumers
 * (e.g. ChatSessionManager); the branch:activity stream is independent.
 */
export function statusEventFromRemotePatch(
  parsed: Record<string, unknown>,
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
): Extract<GlobalEvent, { type: "session:status" }> | null {
  if (!("JsonPatch" in parsed)) return null;
  const ops = parsed.JsonPatch;
  if (!Array.isArray(ops)) return null;
  const statusOp = (ops as Array<{
    op: string;
    path: string;
    value?: { type?: string; content?: unknown };
  }>).find((o) => o.path === "/status");
  if (!statusOp) return null;
  const content = statusOp.value?.content;
  if (content !== "running" && content !== "stopped" && content !== "error") {
    return null;
  }
  return {
    type: "session:status",
    projectId: projectIdFromRemoteSessionId(sessionId, remoteInfo),
    branch: remoteInfo.branch ?? null,
    sessionId,
    status: content as AgentSessionStatus,
  };
}

/**
 * Build the front-server `session:taskCompleted` event from a worker's
 * `{ taskCompleted: {...} }` stream frame. Forwards the turn boundary (needed
 * by the front's event-card Review button) and the workflow-suppression mark
 * (the worker's WorkflowEngine claimed this completion — the front commander
 * must not double-handle it).
 */
export function taskCompletedEventFromRemoteFrame(
  parsed: Record<string, unknown>,
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
): Extract<GlobalEvent, { type: "session:taskCompleted" }> | null {
  if (!("taskCompleted" in parsed)) return null;
  const tc = parsed.taskCompleted as Record<string, unknown> | undefined;
  return {
    type: "session:taskCompleted",
    projectId: projectIdFromRemoteSessionId(sessionId, remoteInfo),
    branch: remoteInfo.branch ?? null,
    sessionId,
    duration_ms: tc?.duration_ms as number | undefined,
    cost_usd: tc?.cost_usd as number | undefined,
    input_tokens: tc?.input_tokens as number | undefined,
    output_tokens: tc?.output_tokens as number | undefined,
    summaryText: tc?.summaryText as string | undefined,
    turnEndEntryIndex: tc?.turnEndEntryIndex as number | undefined,
    workflowSuppressed: tc?.workflowSuppressed === true ? true : undefined,
  };
}

/**
 * Rewrite a worker-local workflow run into the front server's id space: the
 * run id and both participant session ids gain the standard
 * `remote-{serverId}-{projectId}-` prefix (same shape as remote session ids,
 * so the frontend's session-matching predicates keep working), and
 * project_id becomes the front's project id. Branch names are shared
 * vocabulary across machines and pass through untouched.
 */
export function mapRemoteRun<
  T extends { id: string; project_id: string; source_session_id: string; reviewer_session_id: string | null },
>(run: T, remoteServerId: string, projectId: string): T {
  const prefix = `remote-${remoteServerId}-${projectId}-`;
  return {
    ...run,
    id: `${prefix}${run.id}`,
    project_id: projectId,
    source_session_id: `${prefix}${run.source_session_id}`,
    reviewer_session_id: run.reviewer_session_id ? `${prefix}${run.reviewer_session_id}` : null,
  };
}

export function mapRemoteReviewerCandidate(
  candidate: ReviewerCandidate | null,
  remoteServerId: string,
  projectId: string,
): ReviewerCandidate | null {
  if (!candidate?.sessionId) return candidate;
  return {
    ...candidate,
    sessionId: `remote-${remoteServerId}-${projectId}-${candidate.sessionId}`,
  };
}

/**
 * Build the front-server `workflow:run-updated` event from a worker's
 * `{ workflowRunUpdated: run }` stream frame (mirrored by the worker's
 * WorkflowEngine onto participant streams — spec §Phase 1.5 事件回传).
 */
export function runUpdatedEventFromRemoteFrame(
  parsed: Record<string, unknown>,
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
): Extract<GlobalEvent, { type: "workflow:run-updated" }> | null {
  if (!("workflowRunUpdated" in parsed)) return null;
  const bare = parsed.workflowRunUpdated as WorkflowRun;
  const projectId = projectIdFromRemoteSessionId(sessionId, remoteInfo);
  const run = mapRemoteRun(bare, remoteInfo.remoteServerId, projectId);
  return { type: "workflow:run-updated", projectId, branch: run.branch, run };
}
