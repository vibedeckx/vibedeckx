import type { Storage } from "./storage/types.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import { forgetRemoteSession, type RemoteSessionCleanupDeps } from "./remote-session-cleanup.js";

/**
 * Hub-side convergence for sessions a worker deleted on its own
 * (docs/plans/2026-08-08-session-retention.md §3.1).
 *
 * When the user deletes a remote session, the hub explicitly forgets it. A
 * worker's internal retention sweep has no such channel: left alone, the hub
 * accumulates mappings that point at sessions which no longer exist — handles
 * that error on click, stale routes, ghost search hits.
 *
 * Snapshot reconciliation rather than delete events/tombstones: the deletion
 * happens on a machine that is routinely offline, against a hub that
 * restarts, over a link that can duplicate. Per-event notification would have
 * to solve loss, replay and dedupe; a snapshot comparison is idempotent and
 * self-healing, and covers "deleted while disconnected" and "hub was down"
 * without any extra protocol state.
 */

/** Worker capability key for the inventory endpoint this pass depends on. */
export const SESSION_INVENTORY_CAPABILITY = "http:GET /api/path/session-ids";

export interface ReconcileTarget {
  projectId: string;
  remoteServerId: string;
  remotePath: string;
}

export interface ReconcileDeps extends RemoteSessionCleanupDeps {
  storage: Storage;
  reverseConnectManager: ReverseConnectManager;
  timeoutMs?: number;
}

export interface ReconcileSummary {
  targetsChecked: number;
  targetsSkipped: number;
  forgotten: number;
}

interface SessionInventoryResponse {
  sessionIds?: unknown;
  complete?: unknown;
}

/**
 * Ask a worker for the COMPLETE set of session ids it holds for one project.
 * Returns null whenever the answer cannot be trusted — offline worker, error
 * status, a worker too old to serve the route, or a response that doesn't
 * assert completeness. Absence of an answer is never evidence of deletion.
 */
async function fetchLiveSessionIds(
  deps: ReconcileDeps,
  target: ReconcileTarget,
): Promise<Set<string> | null> {
  const result = await proxyToRemoteAuto(
    target.remoteServerId,
    "GET",
    `/api/path/session-ids?path=${encodeURIComponent(target.remotePath)}`,
    undefined,
    { reverseConnectManager: deps.reverseConnectManager, timeoutMs: deps.timeoutMs ?? 10_000 },
  );
  if (!result.ok) return null;
  const data = result.data as SessionInventoryResponse | null;
  // `complete` is an explicit assertion by the worker that nothing was
  // truncated. A paginated or partially-failed listing must fail the whole
  // round rather than let missing ids read as deletions.
  if (!data || data.complete !== true || !Array.isArray(data.sessionIds)) return null;
  // Reject the response outright if ANY element is not a string, rather than
  // filtering the odd ones out: on this path a shorter list means "these were
  // deleted", so silently dropping elements is the same silent truncation the
  // `complete` flag exists to rule out — just with the hub doing it to itself.
  if (!data.sessionIds.every((id) => typeof id === "string")) return null;
  return new Set(data.sessionIds as string[]);
}

/**
 * One reconciliation round over the given targets.
 *
 * The order of the first two steps is the correctness argument: capture the
 * mapping set FIRST, then ask the worker. Reversed, a session created while
 * the request was in flight would be missing from the worker's snapshot and
 * get "reconciled away" seconds after the user created it.
 */
export async function reconcileRemoteSessions(
  deps: ReconcileDeps,
  targets: ReconcileTarget[],
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { targetsChecked: 0, targetsSkipped: 0, forgotten: 0 };

  // 1. Capture the full triple, not just the local id: during a request a
  //    local id can be RE-mapped to a different remote session (reconnect,
  //    recreate), and cleaning by local id alone would take the new mapping
  //    down with the old one. Captured once for the whole round, before any
  //    request goes out — capturing earlier is only ever safer, because the
  //    eligible set can then only be smaller than what the workers report on.
  const capturedAll = (await deps.storage.remoteSessionMappings.getAll()).map((m) => ({
    localSessionId: m.local_session_id,
    projectId: m.project_id,
    remoteServerId: m.remote_server_id,
    remoteSessionId: m.remote_session_id,
  }));

  for (const target of targets) {
    const captured = capturedAll.filter(
      (m) => m.projectId === target.projectId && m.remoteServerId === target.remoteServerId,
    );
    if (captured.length === 0) continue;

    // 2. Now ask the worker.
    const live = await fetchLiveSessionIds(deps, target);
    if (!live) {
      summary.targetsSkipped++;
      continue;
    }
    summary.targetsChecked++;

    // 3. Only captured mappings are eligible; anything created or re-mapped
    //    mid-flight simply waits for the next round. The captured triple is
    //    handed to the cleanup as an expectation rather than being checked
    //    here and acted on afterwards — a re-map can land between a check and
    //    an unconditional delete, and would then be erased by it.
    for (const entry of captured) {
      if (live.has(entry.remoteSessionId)) continue;
      const forgotten = await forgetRemoteSession(deps, entry.localSessionId, {
        expect: { remoteServerId: entry.remoteServerId, remoteSessionId: entry.remoteSessionId },
      });
      if (forgotten) summary.forgotten++;
    }
  }

  return summary;
}
