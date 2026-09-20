/**
 * Hub side of a repeat-until-done loop that runs on a worker
 * (docs/superpowers/specs/2026-09-20-workflow-repeat-until-done-design.md §7).
 *
 * Unlike every other remote session, a loop's sessions are created BY THE
 * WORKER's engine: no create request passes through this hub, so nothing
 * publishes them here on its own. Two layers:
 *
 *  - The bell must be reliable (unattended loop, a hub that redeploys several
 *    times a day). The worker writes every loop milestone to the outbox of the
 *    loop's FIRST session — the anchor. This hub gives the anchor a persisted
 *    mapping and a notification watch that outlasts the loop's time cap, so the
 *    periodic and startup sweeps find the milestone with no stream, browser or
 *    in-memory state involved.
 *  - Display is best effort: whenever a loop run passes through this hub (start
 *    response, run list / read, gate response, a `workflowRunUpdated` frame),
 *    the sessions it names are published on sight. A missed frame costs
 *    nothing — the panel polls and the sidebar discovers.
 */
import type { EnsureStreamDeps } from "./remote-agent-sessions.js";
import { bindRemoteSessionMapping, ensureRemoteAgentStream } from "./remote-agent-sessions.js";
import { WATCH_WINDOW_MS } from "./remote-notification-sync.js";
import { parseRemoteRunId } from "./routes/remote-status-bridge.js";
import type { WorkflowRun } from "./storage/types.js";

export interface PublishLoopDeps extends EnsureStreamDeps {
  remoteNotificationSync?: { enqueue(work: () => Promise<void>): void; syncServer(id: string, opts: { includeExpired: boolean }): Promise<void> };
}

interface LoopParamsView { anchorSessionId?: string; prevSessionId?: string | null; maxMinutes?: number; startedAt?: number }

/**
 * `run` is the HUB-side view (ids already prefixed by mapRemoteRun). Idempotent;
 * never throws — a display nicety must not fail the request or bus handler that
 * saw the run.
 */
export async function publishRemoteLoopSessions(deps: PublishLoopDeps, run: WorkflowRun): Promise<void> {
  if (run.kind !== "repeat" || !run.params) return;
  const parsedId = parseRemoteRunId(run.id);
  if (!parsedId) return;
  const { remoteServerId, projectId } = parsedId;
  try {
    const params = JSON.parse(run.params) as LoopParamsView;
    const remoteConfig = await deps.storage.projectRemotes.getByProjectAndServer(projectId, remoteServerId);
    if (!remoteConfig?.remote_path) return;
    const prefix = `remote-${remoteServerId}-${projectId}-`;

    // A gate's / a not-yet-dispatched run's own session id is only reserved.
    const live = run.status !== "waiting_resume" && run.status !== "preparing";
    const localIds = new Set<string>();
    if (params.anchorSessionId) localIds.add(params.anchorSessionId);
    if (params.prevSessionId) localIds.add(params.prevSessionId);
    if (live) localIds.add(run.source_session_id);

    for (const localId of localIds) {
      if (!localId.startsWith(prefix) || deps.remoteSessionMap.has(localId)) continue;
      const bareId = localId.slice(prefix.length);
      deps.remoteSessionMap.set(localId, { remoteServerId, remoteSessionId: bareId, branch: run.branch });
      // from_start: the session was created by the loop moments ago — and for
      // the anchor, sequence zero is what recovers a milestone written before
      // this row landed. Insert-only, so a known session keeps its cursor.
      await bindRemoteSessionMapping(deps.storage, {
        localSessionId: localId, projectId, remoteServerId, remoteSessionId: bareId,
        branch: run.branch, remotePath: remoteConfig.remote_path, notificationSyncStart: "from_start",
      });
      ensureRemoteAgentStream(localId, deps);
      deps.eventBus?.emit({ type: "session:process", projectId, branch: run.branch, sessionId: localId, alive: true });
    }

    if (params.anchorSessionId) {
      // MAX() in storage: this can only ever lengthen the window.
      const capMs = (params.maxMinutes ?? 0) * 60_000;
      const until = Math.max(Date.now(), params.startedAt ?? 0) + capMs + WATCH_WINDOW_MS;
      await deps.storage.remoteSessionMappings.extendNotificationWatch(params.anchorSessionId, until);
      // A run that just ended or stopped for a human has a milestone waiting.
      if (run.status !== "running_task" && run.status !== "preparing") {
        deps.remoteNotificationSync?.enqueue(() =>
          deps.remoteNotificationSync!.syncServer(remoteServerId, { includeExpired: false }),
        );
      }
    }
  } catch (err) {
    console.warn(`[RemoteLoop] publishing sessions of run ${run.id} failed:`, err);
  }
}
