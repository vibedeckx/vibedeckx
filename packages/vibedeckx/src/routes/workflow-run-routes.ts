import type { FastifyInstance, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { requireAuth as requireRawAuth } from "../server.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import { REVIEWER_AGENT_TYPES, WorkflowError } from "../workflow-engine.js";
import { generateIntentBrief } from "../utils/review-brief.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import type { AgentMessage } from "../agent-types.js";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { projectIdFromRemoteSessionId, mapRemoteReviewerCandidate, mapRemoteRun, parseRemoteRunId } from "./remote-status-bridge.js";
import { bindRemoteSessionMapping, createRemoteWorkflowReviewer, ensureRemoteAgentStream } from "../remote-agent-sessions.js";
import type { ReviewSpan, WorkflowRun } from "../storage/types.js";
import type { AgentType } from "../agent-types.js";

/** undefined → engine default; null → invalid (reject with 400). */
function parseReviewerAgentType(raw: unknown): AgentType | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "string" && REVIEWER_AGENT_TYPES.has(raw as AgentType) ? (raw as AgentType) : null;
}

/** undefined → this_turn (back-compat); a valid span passes; anything else → null (reject with 400). */
export function parseReviewSpan(raw: unknown): ReviewSpan | null {
  if (raw === undefined) return "this_turn";
  return raw === "this_turn" || raw === "session_start" ? raw : null;
}

/** undefined → briefed (back-compat); a valid mode passes; anything else → null (reject with 400). */
export function parseReviewContextMode(raw: unknown): "briefed" | "blind" | null {
  if (raw === undefined) return "briefed";
  return raw === "briefed" || raw === "blind" ? raw : null;
}

/**
 * Opaque tier-1 text handed over the wire (browser → front, front → worker).
 * Bound it so a client/front bug can't balloon the reviewer prompt.
 */
function normalizeIntentBrief(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  return raw.length > 8000 ? raw.slice(0, 8000) + "…" : raw;
}

function errStatus(err: unknown): number | null {
  if (!(err instanceof WorkflowError)) return null;
  switch (err.code) {
    case "session-busy": return 409;
    case "source-running": return 409;
    case "reviewer-unavailable": return 409;
    case "bad-state": return 409;
    case "no-completed-turn": return 400;
    case "send-failed": return 502;
    case "spawn-failed": return 500;
    default: return 500;
  }
}

async function routes(fastify: FastifyInstance) {
  const durableReviewFlights = new Map<string, Promise<WorkflowRun>>();
  const projectLocalSession = async (session: {
    id: string; project_id: string; branch: string; workspace_checkout_id?: string | null;
  }) => {
    const reader = fastify.storage.agentSessions.getActivityById;
    // Compatibility for injected/custom storage used by embedders while the
    // Storage interface rolls forward. Real storage always provides the
    // checkout-first reader; only an actually unbound row may use snapshots.
    if (typeof reader !== "function") {
      return session.workspace_checkout_id ? undefined : {
        projectId: session.project_id,
        branch: session.branch || null,
      };
    }
    return reader(session.id, "workflow-reviewer");
  };

  const remoteWorkflowCheckoutAvailable = async (
    localSessionId: string,
    remoteInfo: { remoteServerId: string; remoteSessionId: string },
    projectId: string,
  ): Promise<boolean> => {
    const getMapping = fastify.storage.remoteSessionMappings?.getByLocal;
    const getCheckout = fastify.storage.workspaceRegistry?.getCheckoutById;
    if (typeof getMapping !== "function" || typeof getCheckout !== "function") return true;
    const rawMapping = await getMapping(localSessionId);
    const getAuthorized = fastify.storage.remoteSessionMappings?.getAuthorizedByLocal;
    const mapping = rawMapping && typeof getAuthorized === "function"
      ? await getAuthorized(localSessionId, projectId, "workflow-reviewer")
      : rawMapping;
    if (rawMapping && !mapping) return false;
    if (!mapping?.workspace_checkout_id) return true;
    const registered = await getCheckout(mapping.workspace_checkout_id);
    return Boolean(registered
      && registered.checkout.deleted_at === null
      && registered.checkout.status === "ready"
      && registered.workspace.project_id === projectId
      && registered.checkout.target_id === remoteInfo.remoteServerId
      && mapping.remote_server_id === remoteInfo.remoteServerId
      && mapping.remote_session_id === remoteInfo.remoteSessionId);
  };
  /**
   * Front-side handles for runs living on a worker. Mirrors remoteSessionMap's
   * hydrate-by-use model: populated on POST/GET responses, so after a front
   * restart the panel's first proxied list fetch re-learns every active run
   * before any gate could be clicked. Not persisted on purpose.
   */
  interface RemoteRunInfo {
    remoteServerId: string;
    bareRunId: string;
    projectId: string;
  }
  const remoteRunMap = new Map<string, RemoteRunInfo>();

  // Terminal runs are never gated again, so retaining their handle would only
  // grow the map forever on a long-lived hosted front. Evict on terminal
  // status instead of set; the map is in-memory and hydrate-by-use anyway
  // (see remoteRunMap comment above), so a later fetch re-learns any run
  // that's still active.
  const TERMINAL_RUN_STATUSES = new Set<WorkflowRun["status"]>(["completed", "cancelled", "failed"]);
  const trackRemoteRun = (localRun: WorkflowRun, info: RemoteRunInfo) => {
    if (TERMINAL_RUN_STATUSES.has(localRun.status)) remoteRunMap.delete(localRun.id);
    else remoteRunMap.set(localRun.id, info);
  };

  const proxyAuto = (
    info: { remoteServerId: string },
    method: string,
    apiPath: string,
    body?: unknown,
  ) =>
    proxyToRemoteAuto(info.remoteServerId, method, apiPath, body, {
      reverseConnectManager: fastify.reverseConnectManager,
    });

  /**
   * Worker routes the two-phase remote review needs. Checked against the
   * handshake-reported capability list; a worker missing either falls back to
   * the original single-shot create (distill inline, slow submit) — exactly
   * the behavior it had before these routes existed.
   */
  const TWO_PHASE_REVIEW_CAPABILITIES = [
    "http:POST /api/path/workflow-runs/prepare",
    "http:POST /api/path/workflow-runs/:param/activate",
  ] as const;

  /**
   * Publish a worker-created reviewer on the front: handle, mapping, activity
   * projection, notification watch, resident stream and the sidebar/window
   * announcements. For a single-shot review this runs inline (the worker
   * already prompted the reviewer); for a two-phase review it runs only after
   * the worker's activate answered — until then the reviewer is a pending
   * identity with no runtime, and publishing it would put an inert session
   * in the sidebar/alive projections (lifecycle design §10.4).
   */
  const publishRemoteReviewer = async (opts: {
    projectId: string;
    remoteInfo: { remoteServerId: string };
    bareRun: WorkflowRun;
    localRun: WorkflowRun;
    reviewerActivityAt: number;
    twoPhase: boolean;
  }): Promise<{ status: number; error: string } | null> => {
    const { projectId, remoteInfo, bareRun, localRun, reviewerActivityAt, twoPhase } = opts;
    // Surface the worker-created reviewer on the front: register the handle
    // and open the resident stream — that stream is what carries the
    // reviewer's suppressed taskCompleted and the workflowRunUpdated frames.
    if (bareRun.reviewer_session_id && localRun.reviewer_session_id) {
      const remoteConfig = await fastify.storage.projectRemotes.getByProjectAndServer(
        projectId, remoteInfo.remoteServerId,
      );
      if (!remoteConfig) return { status: 404, error: "Remote project configuration not found" };
      const reviewerInfo = {
        remoteServerId: remoteInfo.remoteServerId,
        remoteSessionId: bareRun.reviewer_session_id,
        branch: bareRun.branch,
      };
      fastify.remoteSessionMap.set(localRun.reviewer_session_id, reviewerInfo);
      // from_start for a FRESH reviewer: it was created moments ago by this
      // run, and its review may well finish before this mapping row lands —
      // sequence zero is what recovers that race. Insert-only, so a REUSED
      // reviewer keeps the cursor (and policy) it already had and does not
      // replay its previous reviews.
      await bindRemoteSessionMapping(fastify.storage, {
        localSessionId: localRun.reviewer_session_id, projectId,
        remoteServerId: remoteInfo.remoteServerId,
        remoteSessionId: bareRun.reviewer_session_id, branch: bareRun.branch,
        remotePath: remoteConfig.remote_path, notificationSyncStart: "from_start",
      });
      // The worker may be offline again before the resident stream attaches,
      // so create the front's Activity projection from the acknowledged run
      // response. This exact mapping+association-validated write must precede
      // every local running/process/status invalidation below.
      const activityReady = await fastify.storage.searchCache.updateRemoteSessionActivity({
        localSessionId: localRun.reviewer_session_id,
        projectId,
        targetId: remoteInfo.remoteServerId,
        remoteSessionId: bareRun.reviewer_session_id,
        status: "running",
        activityAt: reviewerActivityAt,
        lastUserMessageAt: reviewerActivityAt,
      });
      if (activityReady === false) {
        return { status: 409, error: "Remote reviewer mapping is no longer authorized" };
      }
      // The reviewer may already have finished on the worker; ask for its
      // milestones now rather than waiting for the next periodic sweep.
      await fastify.remoteNotificationSync.extendWatch(localRun.reviewer_session_id);
      fastify.remoteNotificationSync.enqueue(() =>
        fastify.remoteNotificationSync.syncServer(remoteInfo.remoteServerId, { includeExpired: true }),
      );
      ensureRemoteAgentStream(localRun.reviewer_session_id, {
        remoteSessionMap: fastify.remoteSessionMap,
        remotePatchCache: fastify.remotePatchCache,
        reverseConnectManager: fastify.reverseConnectManager,
        eventBus: fastify.eventBus,
        agentSessionManager: fastify.agentSessionManager,
        storage: fastify.storage,
      });
      // Seed branch:activity `working` for the reviewer's branch. The worker
      // already prompted the reviewer (working state produced on ITS bus), but
      // the front doesn't subscribe to the worker's SSE and only reconstructs
      // remote branch:activity from its own outbound sends + `taskCompleted`
      // frames — and this branch is still sitting at the source's `completed`.
      // Mirrors the /message route's post-proxy `working` emit.
      //
      // DISPLAY ONLY — this has no notification role. The reviewer's
      // attention milestone is a durable `review_ready` outbox row written by
      // the worker's WorkflowEngine and imported by RemoteNotificationSync;
      // the bell no longer derives anything from branch:activity, so this emit
      // exists purely to keep the workspace dot honest while a review runs.
      if (activityReady === true) {
        fastify.agentSessionManager.emitBranchActivityIfChanged(projectId, bareRun.branch, {
          activity: "working",
          since: reviewerActivityAt,
          sessionId: localRun.reviewer_session_id,
        });
      }
      // The worker's spawn-time announcements (session:status/processAlive)
      // fire before this front subscribes, so nothing surfaces the reviewer
      // here on its own. Same intent as the commander's remote spawn path:
      // session:process makes the sidebar (useResidentSessions) refetch the
      // branch list — which now includes the reviewer — and session:status
      // surfaces it in an open agent window on this workspace.
      if (activityReady === true) {
        fastify.eventBus.emit({
          type: "session:process",
          projectId,
          branch: bareRun.branch,
          sessionId: localRun.reviewer_session_id,
          alive: true,
        });
        // session:status "running" auto-surfaces the reviewer into an open
        // agent window (useSurfaceCommanderSession). The two-phase flow
        // deliberately skips it: the user stays on the source session and
        // opens the preparing reviewer from the sidebar entry the
        // session:process emit above just produced.
        if (!twoPhase) {
          fastify.eventBus.emit({
            type: "session:status",
            projectId,
            branch: bareRun.branch,
            sessionId: localRun.reviewer_session_id,
            status: "running",
          });
        }
      }
      // The worker's engine already wrote the final "Review - …" title
      // before responding (the session:process refetch above picks it up).
      // Claim the front's one-shot title slots so a later /message through
      // the front (human takeover) can't regenerate an AI title over it.
      fastify.agentSessionManager.markTitleResolved(localRun.reviewer_session_id);
      await fastify.storage.remoteSessionMappings.markTitleResolved(localRun.reviewer_session_id);
      // Two-phase: the creation intent was left pending at prepare so a crash
      // before this point is recoverable (createRemoteWorkflowReviewer). Every
      // durable piece of the publish is now in place — close it.
      if (twoPhase) {
        await fastify.storage.remoteReviewerCreationIntents.confirm(localRun.reviewer_session_id);
      }
    }
    return null;
  };

  /**
   * Phase 2 for a remote review, after the 201 already went out: distill the
   * intent brief (unless the client supplied one or the review is blind) and
   * hand it to the worker's activate route, which sends the reviewer's first
   * message. Failure accounting lives worker-side — an activation error fails
   * the run, and an activation that never arrives trips the worker's
   * preparation timeout — both surfacing as a failed run + workflow_failed
   * milestone, so the hub only retries transient tunnel errors and logs.
   */
  const activateRemoteReview = async (opts: {
    remoteServerId: string;
    bareRunId: string;
    /** Local (`remote-`-prefixed) source session id, for distillation. */
    sourceSessionId: string;
    userId: string | undefined;
    reviewContextMode: "briefed" | "blind";
    clientBrief: string | undefined;
    clientProvidedBrief: boolean;
    /** Runs once the worker reports the run past `preparing` (reviewer live). */
    onActivated?: (run: WorkflowRun) => Promise<void>;
  }): Promise<void> => {
    const blind = opts.reviewContextMode === "blind";
    let intentBrief = opts.clientBrief;
    if (!opts.clientProvidedBrief && !blind) {
      intentBrief = await distillIntentBrief(opts.userId, opts.sourceSessionId);
    }
    const body = { intentBrief, reviewContextMode: opts.reviewContextMode };
    for (let attempt = 1; ; attempt++) {
      const result = await proxyAuto(
        opts, "POST", `/api/path/workflow-runs/${opts.bareRunId}/activate`, body,
      );
      if (result.ok) {
        const run = (result.data as { run?: WorkflowRun } | null)?.run;
        if (run && run.status !== "preparing" && run.status !== "failed" && run.status !== "cancelled") {
          await opts.onActivated?.(run);
        }
        return;
      }
      // status 0 = never reached the worker (tunnel blip / brief disconnect);
      // any semantic response means the worker owns the outcome now.
      if (result.status !== 0 || attempt >= 3) {
        console.warn(
          `[WorkflowRuns] remote activation failed for run ${opts.bareRunId}: status=${result.status} code=${result.errorCode ?? "n/a"}`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  };

  /** status 0 = never reached the worker; otherwise forward its semantic body. */
  const sendProxyFailure = (reply: FastifyReply, result: { status: number; data: unknown; errorCode?: string }) =>
    reply.code(proxyStatus(result)).send(
      result.status === 0 ? { error: `Remote proxy failed: ${result.errorCode || "unknown"}` } : result.data,
    );

  /**
   * Authorization pattern for remote run ids on the front: never trust a bare
   * remoteRunMap.get — always re-check project ownership with the raw
   * requireAuth result (undefined in solo mode is fine), same rule as
   * getAuthorizedRemoteSessionInfo for remote sessions.
   *
   * The map alone is not enough to *find* a run, only to shortcut finding it:
   * it holds what this front has seen since boot and evicts terminal runs (see
   * trackRemoteRun). Without the parse fallback, cancelling a run that just
   * finished — the panel is workspace-scoped and 5s-polled, so a second view
   * (or a second click) routinely races the transition — answered 404 "Run not
   * found" for a run the worker knows perfectly well, and the user saw an
   * error for what is a no-op. The id is self-describing, so derive the handle
   * from it and let the worker stay the authority on existence.
   */
  const resolveRemoteRun = async (runId: string, userId: string | undefined) => {
    const tracked = remoteRunMap.get(runId);
    const info = tracked ?? parseRemoteRunId(runId);
    if (!info) return null;
    const project = await fastify.storage.projects.getById(info.projectId, userId);
    if (!project) return null;
    // A parsed handle is caller-supplied: prove the project really is bound to
    // that worker before proxying anything there. A tracked handle was built
    // from a response this front had already authorized.
    if (!tracked
      && !(await fastify.storage.projectRemotes.getByProjectAndServer(info.projectId, info.remoteServerId))) {
      return null;
    }
    return info;
  };

  /**
   * Tier-1 context: distill the source conversation into an intent brief.
   * Runs on this front — chat-provider keys live here, never on workers (same
   * split as remote title generation). Remote sources pull their history over
   * the existing session proxy. Caller must have authorized the session
   * already. Never throws; undefined means the reviewer prompt falls back to
   * the worker's deterministic excerpt (tier 2).
   */
  const distillIntentBrief = async (
    userId: string | undefined,
    sourceSessionId: string,
  ): Promise<string | undefined> => {
    try {
      let messages: AgentMessage[];
      if (sourceSessionId.startsWith("remote-")) {
        const remoteInfo = fastify.remoteSessionMap.get(sourceSessionId);
        if (!remoteInfo) return undefined;
        // Projected history, not the raw session: distillation reads only user
        // and assistant text, and pulling the tool traffic to discard it here
        // was ~70x the bytes over the tunnel. A worker too old to serve this
        // 404s, which lands in the `!ok` branch below — the review then starts
        // on the deterministic excerpt (tier 2), the same degradation as any
        // other failure to reach the source history.
        const historyResult = await proxyAuto(
          remoteInfo, "GET", `/api/agent-sessions/${remoteInfo.remoteSessionId}/brief-source`,
        );
        if (!historyResult.ok) return undefined;
        messages = (historyResult.data as { messages?: AgentMessage[] }).messages ?? [];
      } else {
        messages = fastify.agentSessionManager.getMessages(sourceSessionId);
      }
      return (await generateIntentBrief(fastify.storage, resolveUserId(userId), messages)) ?? undefined;
    } catch (err) {
      console.warn("[WorkflowRuns] intent brief generation failed:", err);
      return undefined;
    }
  };

  fastify.post<{
    Body: { projectId: string; branch?: string | null; sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number; reviewerAgentType?: string; reviewerSessionId?: string; intentBrief?: string; reviewSpan?: string; reviewContextMode?: string };
  }>("/api/workflow-runs", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { projectId, branch, sourceSessionId, reviewFocus, sourceTurnEndIndex } = req.body ?? {};
    if (!projectId || !sourceSessionId) return reply.code(400).send({ error: "projectId and sourceSessionId are required" });
    const reviewerAgentType = parseReviewerAgentType(req.body?.reviewerAgentType);
    if (reviewerAgentType === null) return reply.code(400).send({ error: "reviewerAgentType must be one of: claude-code, codex" });
    const reviewSpan = parseReviewSpan(req.body?.reviewSpan);
    if (reviewSpan === null) return reply.code(400).send({ error: "reviewSpan must be one of: this_turn, session_start" });
    const reviewerSessionIdRaw = req.body?.reviewerSessionId;
    if (reviewerSessionIdRaw !== undefined &&
        (typeof reviewerSessionIdRaw !== "string" || reviewerSessionIdRaw.trim() === "")) {
      return reply.code(400).send({ error: "reviewerSessionId must be a non-empty string" });
    }
    if (reviewerSessionIdRaw !== undefined && reviewerAgentType !== undefined) {
      return reply.code(400).send({ error: "reviewerSessionId and reviewerAgentType are mutually exclusive" });
    }
    const reviewerSessionId = reviewerSessionIdRaw?.trim();
    const reviewContextMode = parseReviewContextMode(req.body?.reviewContextMode);
    if (reviewContextMode === null) return reply.code(400).send({ error: "reviewContextMode must be one of: briefed, blind" });
    const blind = reviewContextMode === "blind";
    if (blind && reviewerSessionId) {
      return reply.code(400).send({ error: "blind review requires a new reviewer session" });
    }
    const intentBriefRaw = req.body?.intentBrief;
    if (intentBriefRaw !== undefined && typeof intentBriefRaw !== "string") {
      return reply.code(400).send({ error: "intentBrief must be a string" });
    }
    // A present field means the client already ran tier-1 pre-generation (the
    // review dialog does this on open, via POST /api/workflow-runs/intent-brief,
    // to hide the distillation latency) — don't distill again here. Blind
    // review discards any brief outright: withheld context is the feature.
    const clientProvidedBrief = intentBriefRaw !== undefined;
    const clientBrief = blind ? undefined : normalizeIntentBrief(intentBriefRaw);
    if (sourceSessionId.startsWith("remote-")) {
      // Remote workspace: the run lives on the worker (spec §Phase 1.5 —
      // engine runs where the session/worktree live). Authz follows the
      // getAuthorizedRemoteSessionInfo pattern: derive the project from the
      // id and re-check ownership; never trust the map entry alone.
      const remoteInfo = fastify.remoteSessionMap.get(sourceSessionId);
      if (!remoteInfo) return reply.code(404).send({ error: "Session not found" });
      const derivedProjectId = projectIdFromRemoteSessionId(sourceSessionId, remoteInfo);
      if (derivedProjectId !== projectId) return reply.code(404).send({ error: "Session not found" });
      const remoteProject = await fastify.storage.projects.getById(projectId, userId);
      if (!remoteProject) return reply.code(404).send({ error: "Project not found" });
      if (!(await remoteWorkflowCheckoutAvailable(sourceSessionId, remoteInfo, projectId))) {
        return reply.code(409).send({ error: "Source session workspace checkout is unavailable" });
      }

      let bareReviewerSessionId: string | undefined;
      if (reviewerSessionId) {
        const reviewerInfo = fastify.remoteSessionMap.get(reviewerSessionId);
        if (!reviewerInfo ||
            reviewerInfo.remoteServerId !== remoteInfo.remoteServerId ||
            projectIdFromRemoteSessionId(reviewerSessionId, reviewerInfo) !== projectId) {
          return reply.code(404).send({ error: "Reviewer session not found" });
        }
        if (!(await remoteWorkflowCheckoutAvailable(reviewerSessionId, reviewerInfo, projectId))) {
          return reply.code(409).send({ error: "Reviewer session workspace checkout is unavailable" });
        }
        bareReviewerSessionId = reviewerInfo.remoteSessionId;
      }

      // A reused reviewer is about to start a new turn on an already-mapped
      // session: baseline its cursor first (see prepareForNewTurn) so the
      // review we are starting can't be mistaken for that session's history.
      if (reviewerSessionId &&
          !(await fastify.remoteNotificationSync.prepareForNewTurn(reviewerSessionId))) {
        return reply.code(502).send({
          error: "Could not reach the remote server to prepare notification delivery",
          errorCode: "notification_baseline_failed",
        });
      }
      // The worker derives branch from its own session row — the body branch
      // is not forwarded (server-derived branch, same rule as the local path).
      const reviewerActivityAt = Date.now();
      let bareRun: WorkflowRun;
      let twoPhase = false;
      if (bareReviewerSessionId) {
        // Re-reviews never distill (the reviewer keeps its own context), so a
        // client-provided brief is all that can apply here.
        const result = await proxyAuto(remoteInfo, "POST", "/api/path/workflow-runs", {
          sourceSessionId: remoteInfo.remoteSessionId,
          reviewFocus,
          sourceTurnEndIndex,
          reviewSpan,
          reviewerSessionId: bareReviewerSessionId,
          intentBrief: clientBrief,
        });
        if (!result.ok) return sendProxyFailure(reply, result);
        bareRun = (result.data as { run: WorkflowRun }).run;
      } else {
        const remoteConfig = await fastify.storage.projectRemotes.getByProjectAndServer(
          projectId, remoteInfo.remoteServerId,
        );
        if (!remoteConfig) return reply.code(404).send({ error: "Remote project configuration not found" });
        const server = await fastify.storage.remoteServers.getById(remoteInfo.remoteServerId);
        twoPhase = TWO_PHASE_REVIEW_CAPABILITIES.every(
          (capability) => server?.worker_capabilities?.includes(capability),
        );
        // Tier-1 context: with a two-phase worker the distillation moves past
        // the response (activateRemoteReview); on the single-shot fallback it
        // stays inline — prefer the client's pre-generated brief, distill only
        // when the client didn't attempt it. Any failure degrades to the
        // worker's deterministic excerpt (tier 2) by simply omitting the field.
        let intentBrief = clientBrief;
        if (!twoPhase && !clientProvidedBrief && !blind) {
          intentBrief = await distillIntentBrief(userId, sourceSessionId);
        }
        const result = await createRemoteWorkflowReviewer({
          remoteSessionMap: fastify.remoteSessionMap,
          remoteSessionMappings: fastify.storage.remoteSessionMappings,
          remotePatchCache: fastify.remotePatchCache,
          agentSessionManager: fastify.agentSessionManager,
          reverseConnectManager: fastify.reverseConnectManager,
          storage: fastify.storage,
        }, {
          projectId,
          agentMode: remoteInfo.remoteServerId,
          remotePath: remoteConfig.remote_path,
          branch: remoteInfo.branch ?? null,
          sourceRemoteSessionId: remoteInfo.remoteSessionId,
          reviewFocus,
          sourceTurnEndIndex,
          reviewSpan,
          // Additive tunnel field: a worker that predates it ignores the flag
          // and runs a briefed (tier-2) review — the reviewer prompt's
          // trailing "(review context: …)" line records what actually ran.
          reviewContextMode,
          reviewerAgentType: reviewerAgentType ?? "claude-code",
          intentBrief,
          userId,
          ...(twoPhase ? { phase: "prepare" as const } : {}),
        });
        if (!result.ok) return reply.code(proxyStatus(result)).send(result.data);
        bareRun = result.remoteRun;
      }
      const localRun = mapRemoteRun(bareRun, remoteInfo.remoteServerId, projectId);
      trackRemoteRun(localRun, {
        remoteServerId: remoteInfo.remoteServerId,
        bareRunId: bareRun.id,
        projectId,
      });

      // Single-shot: the worker already prompted the reviewer, publish now.
      // Two-phase: the reviewer is still a pending identity; it is published
      // from the activation task once the worker reports it live.
      if (!twoPhase) {
        const failed = await publishRemoteReviewer({ projectId, remoteInfo, bareRun, localRun, reviewerActivityAt, twoPhase });
        if (failed) return reply.code(failed.status).send({ error: failed.error });
      }
      fastify.eventBus.emit({ type: "workflow:run-updated", projectId, branch: bareRun.branch, run: localRun });
      if (twoPhase) {
        const bareRunId = bareRun.id;
        void activateRemoteReview({
          remoteServerId: remoteInfo.remoteServerId,
          bareRunId,
          sourceSessionId,
          userId,
          reviewContextMode,
          clientBrief,
          clientProvidedBrief,
          onActivated: async (activatedBareRun) => {
            // Stamp the reviewer's first turn at activation time, not at
            // prepare: that is when its first user message actually landed.
            const failed = await publishRemoteReviewer({
              projectId, remoteInfo, bareRun: activatedBareRun, localRun: mapRemoteRun(activatedBareRun, remoteInfo.remoteServerId, projectId),
              reviewerActivityAt: Date.now(), twoPhase,
            });
            if (failed) console.warn(`[WorkflowRuns] remote reviewer publish failed for run ${bareRunId}: ${failed.error}`);
          },
        }).catch((err) => {
          console.warn(`[WorkflowRuns] remote activation task failed for run ${bareRunId}:`, err);
        });
      }
      return reply.code(201).send({ run: localRun });
    }
    const project = await fastify.storage.projects.getById(projectId, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (!project.path) return reply.code(400).send({ error: "Project has no local path (remote-only projects are not supported yet)" });
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    const sourceProjection = sourceSession
      ? await projectLocalSession(sourceSession)
      : undefined;
    if (!sourceSession || sourceProjection?.projectId !== projectId) {
      return reply.code(404).send({ error: "Session not found" });
    }
    // The run's branch is derived from the source session itself, never taken
    // verbatim from the request body: the client isn't trusted to report the
    // session's real branch, and a mismatched one would spawn the reviewer
    // against the wrong worktree. "" is the DB's null-branch sentinel for the
    // main workspace (see agent-session-manager.ts createNewSession's
    // `branch ?? ""`), so normalize it to null to match WorkflowRun.branch /
    // the rest of the API's null-branch convention.
    const runBranch = sourceProjection.branch;
    if (branch !== undefined && (branch || null) !== runBranch) {
      return reply.code(400).send({ error: "branch does not match source session" });
    }
    if (!reviewerSessionId) {
      // Fresh local reviewer: two-phase. Prepare synchronously (fast — run row
      // + placeholder session, no model calls) so the client gets the run and
      // the sidebar entry immediately; the intent-brief distillation and the
      // reviewer's first message happen after this response. A failure past
      // this point becomes a failed run + workflow_failed milestone
      // (activateAdhocReview / the engine's preparation timeout own that), so
      // the fire-and-forget below only logs.
      let run: WorkflowRun;
      try {
        run = await fastify.workflowEngine.prepareAdhocReview({
          project: { id: project.id, path: project.path },
          branch: runBranch,
          sourceSessionId,
          reviewFocus,
          sourceTurnEndIndex,
          reviewSpan,
          reviewerAgentType,
        });
      } catch (err) {
        const status = errStatus(err);
        if (status) return reply.code(status).send({ error: (err as Error).message });
        throw err;
      }
      void (async () => {
        // Same rule as the remote branch: prefer the client's pre-generated
        // brief, distill only when the client didn't attempt it.
        let intentBrief = clientBrief;
        if (!clientProvidedBrief && !blind) {
          intentBrief = await distillIntentBrief(userId, sourceSessionId);
        }
        await fastify.workflowEngine.activateAdhocReview(run.id, { intentBrief, blind });
      })().catch((err) => {
        console.warn(`[WorkflowRuns] background activation failed for run ${run.id}:`, err);
      });
      return reply.code(201).send({ run });
    }
    try {
      const run = await fastify.workflowEngine.startAdhocReview({
        project: { id: project.id, path: project.path },
        branch: runBranch,
        sourceSessionId,
        reviewFocus,
        sourceTurnEndIndex,
        reviewSpan,
        reviewerSessionId,
        intentBrief: clientBrief,
        blind,
      });
      return reply.code(201).send({ run });
    } catch (err) {
      const status = errStatus(err);
      if (status) return reply.code(status).send({ error: (err as Error).message });
      throw err;
    }
  });

  /**
   * Tier-1 pre-generation: the review dialog calls this on open so the brief
   * distills while the user is still picking a reviewer / typing the focus,
   * then hands the result back via POST /api/workflow-runs { intentBrief }.
   * Same authz shape as reviewer-candidate below.
   */
  fastify.post<{
    Body: { projectId?: string; sourceSessionId?: string };
  }>("/api/workflow-runs/intent-brief", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { projectId, sourceSessionId } = req.body ?? {};
    if (!projectId || !sourceSessionId) {
      return reply.code(400).send({ error: "projectId and sourceSessionId are required" });
    }
    const project = await fastify.storage.projects.getById(projectId, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (sourceSessionId.startsWith("remote-")) {
      const remoteInfo = fastify.remoteSessionMap.get(sourceSessionId);
      if (!remoteInfo || projectIdFromRemoteSessionId(sourceSessionId, remoteInfo) !== projectId) {
        return reply.code(404).send({ error: "Session not found" });
      }
    } else {
      const session = await fastify.storage.agentSessions.getById(sourceSessionId);
      const projection = session
        ? await projectLocalSession(session)
        : undefined;
      if (!session || projection?.projectId !== projectId) {
        return reply.code(404).send({ error: "Session not found" });
      }
    }
    const brief = await distillIntentBrief(userId, sourceSessionId);
    return reply.send({ brief: brief ?? null });
  });

  fastify.get<{
    Querystring: { projectId?: string; sourceSessionId?: string };
  }>("/api/workflow-runs/reviewer-candidate", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { projectId, sourceSessionId } = req.query;
    if (!projectId || !sourceSessionId) {
      return reply.code(400).send({ error: "projectId and sourceSessionId are required" });
    }
    const project = await fastify.storage.projects.getById(projectId, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (sourceSessionId.startsWith("remote-")) {
      const remoteInfo = fastify.remoteSessionMap.get(sourceSessionId);
      if (!remoteInfo || projectIdFromRemoteSessionId(sourceSessionId, remoteInfo) !== projectId) {
        return reply.code(404).send({ error: "Session not found" });
      }
      const params = new URLSearchParams({ sourceSessionId: remoteInfo.remoteSessionId });
      const result = await proxyAuto(
        remoteInfo,
        "GET",
        `/api/path/workflow-runs/reviewer-candidate?${params}`,
      );
      if (!result.ok) return sendProxyFailure(reply, result);
      const bareCandidate = (result.data as { candidate: import("../workflow-engine.js").ReviewerCandidate | null }).candidate;
      const candidate = mapRemoteReviewerCandidate(bareCandidate, remoteInfo.remoteServerId, projectId);
      if (bareCandidate?.sessionId && candidate?.sessionId) {
        const remoteConfig = await fastify.storage.projectRemotes.getByProjectAndServer(
          projectId, remoteInfo.remoteServerId,
        );
        if (!remoteConfig) return reply.code(404).send({ error: "Remote project configuration not found" });
        const reviewerInfo = {
          remoteServerId: remoteInfo.remoteServerId,
          remoteSessionId: bareCandidate.sessionId,
          branch: remoteInfo.branch,
        };
        fastify.remoteSessionMap.set(candidate.sessionId, reviewerInfo);
        // from_now: candidate lookup DISCOVERS a reviewer session from an
        // earlier run. Its old reviews are not new attention milestones.
        await bindRemoteSessionMapping(fastify.storage, {
          localSessionId: candidate.sessionId, projectId,
          remoteServerId: remoteInfo.remoteServerId,
          remoteSessionId: bareCandidate.sessionId, branch: remoteInfo.branch ?? null,
          remotePath: remoteConfig.remote_path, notificationSyncStart: "from_now",
        });
      }
      return reply.send({ candidate });
    }
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    const sourceProjection = sourceSession
      ? await projectLocalSession(sourceSession)
      : undefined;
    if (!sourceSession || sourceProjection?.projectId !== projectId) {
      return reply.code(404).send({ error: "Session not found" });
    }
    const candidate = await fastify.workflowEngine.getReviewerCandidate(sourceSessionId);
    return reply.send({ candidate });
  });

  /**
   * The panel's only pull path. Logged at info with the branch it asked for and
   * the count it got back: the generic access log records the route *pattern*
   * only (query strings carry WS/SSE auth material and are deliberately never
   * logged), and a 2xx never reaches it at info anyway — so without this line an
   * empty panel gives no way to tell "the client never asked" from "it asked on
   * the wrong branch" from "the run genuinely wasn't there". `branch` is scoped
   * exactly (`branch is ?`), so a workspace mismatch reads as a normal empty 200.
   */
  fastify.get<{ Querystring: { projectId: string; branch?: string } }>(
    "/api/workflow-runs", async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const { projectId, branch } = req.query;
      if (!projectId) return reply.code(400).send({ error: "projectId is required" });
      const logRead = (count: number, source: string) =>
        console.log(
          `[workflow-runs] read project=${projectId} branch=${branch ?? "(unset)"} source=${source} active=${count}`,
        );
      const project = await fastify.storage.projects.getById(projectId, userId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.agent_mode && project.agent_mode !== "local") {
        const remoteConfig = await fastify.storage.projectRemotes.getByProjectAndServer(projectId, project.agent_mode);
        if (remoteConfig) {
          const q = new URLSearchParams({ path: remoteConfig.remote_path ?? "" });
          if (branch) q.set("branch", branch);
          const info = {
            remoteServerId: project.agent_mode,
          };
          const result = await proxyAuto(info, "GET", `/api/path/workflow-runs?${q}`);
          if (!result.ok) return sendProxyFailure(reply, result);
          const data = result.data as { runs: WorkflowRun[]; reviewedSessionIds?: string[] };
          const bareRuns = data.runs ?? [];
          const runs = bareRuns.map((r) => {
            const mapped = mapRemoteRun(r, info.remoteServerId, projectId);
            trackRemoteRun(mapped, { ...info, bareRunId: r.id, projectId });
            return mapped;
          });
          logRead(runs.length, `remote:${info.remoteServerId}`);
          // Worker-namespace ids, rewritten with mapRemoteRun's prefix scheme
          // (a pure string prefix — no mapping table needed). A worker that
          // predates the field sends nothing: pass the absence through rather
          // than defaulting to [], so the client can tell "no prior reviews"
          // from "this worker cannot answer" and degrade to asking the
          // candidate endpoint on open, as it always did.
          const prefix = `remote-${info.remoteServerId}-${projectId}-`;
          return reply.send({
            runs,
            ...(data.reviewedSessionIds
              ? { reviewedSessionIds: data.reviewedSessionIds.map((id) => prefix + id) }
              : {}),
          });
        }
      }
      const [runs, reviewedSessionIds] = await Promise.all([
        fastify.storage.workflowRuns.getActive(projectId, branch ?? null),
        fastify.storage.workflowRuns.listReviewedSourceSessions(projectId, branch ?? null),
      ]);
      logRead(runs.length, "local");
      return reply.send({ runs, reviewedSessionIds });
    });

  fastify.get<{ Params: { id: string } }>("/api/workflow-runs/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    if (req.params.id.startsWith("remote-")) {
      const info = await resolveRemoteRun(req.params.id, userId);
      if (!info) return reply.code(404).send({ error: "Run not found" });
      const result = await proxyAuto(info, "GET", `/api/workflow-runs/${info.bareRunId}`);
      if (!result.ok) return sendProxyFailure(reply, result);
      const localRun = mapRemoteRun((result.data as { run: WorkflowRun }).run, info.remoteServerId, info.projectId);
      trackRemoteRun(localRun, info);
      return reply.send({ run: localRun });
    }
    const run = await fastify.storage.workflowRuns.getById(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const project = await fastify.storage.projects.getById(run.project_id, userId);
    if (!project) return reply.code(404).send({ error: "Run not found" });
    return reply.send({ run });
  });

  fastify.post<{ Params: { id: string }; Body: { action: "approve" | "cancel" | "finalize"; editedPayload?: string } }>(
    "/api/workflow-runs/:id/gate", async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      if (req.params.id.startsWith("remote-")) {
        const info = await resolveRemoteRun(req.params.id, userId);
        if (!info) return reply.code(404).send({ error: "Run not found" });
        const result = await proxyAuto(info, "POST", `/api/workflow-runs/${info.bareRunId}/gate`, req.body ?? {});
        if (!result.ok) return sendProxyFailure(reply, result);
        const localRun = mapRemoteRun((result.data as { run: WorkflowRun }).run, info.remoteServerId, info.projectId);
        trackRemoteRun(localRun, info);
        fastify.eventBus.emit({ type: "workflow:run-updated", projectId: info.projectId, branch: localRun.branch, run: localRun });
        return reply.send({ run: localRun });
      }
      const existing = await fastify.storage.workflowRuns.getById(req.params.id);
      if (!existing) return reply.code(404).send({ error: "Run not found" });
      const project = await fastify.storage.projects.getById(existing.project_id, userId);
      if (!project) return reply.code(404).send({ error: "Run not found" });
      const { action, editedPayload } = req.body ?? {};
      try {
        if (action === "approve") {
          const run = await fastify.workflowEngine.approveFeedback(req.params.id, editedPayload);
          return reply.send({ run });
        }
        if (action === "cancel") {
          const run = await fastify.workflowEngine.cancelRun(req.params.id);
          return reply.send({ run });
        }
        if (action === "finalize") {
          const run = await fastify.workflowEngine.requestFinalVerdict(req.params.id);
          return reply.send({ run });
        }
        return reply.code(400).send({ error: "action must be approve, cancel or finalize" });
      } catch (err) {
        const status = errStatus(err);
        if (status) return reply.code(status).send({ error: (err as Error).message });
        throw err;
      }
    });

  fastify.post<{ Params: { id: string } }>("/api/workflow-runs/:id/cancel", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    if (req.params.id.startsWith("remote-")) {
      const info = await resolveRemoteRun(req.params.id, userId);
      if (!info) return reply.code(404).send({ error: "Run not found" });
      const result = await proxyAuto(info, "POST", `/api/workflow-runs/${info.bareRunId}/cancel`);
      if (!result.ok) return sendProxyFailure(reply, result);
      const localRun = mapRemoteRun((result.data as { run: WorkflowRun }).run, info.remoteServerId, info.projectId);
      trackRemoteRun(localRun, info);
      fastify.eventBus.emit({ type: "workflow:run-updated", projectId: info.projectId, branch: localRun.branch, run: localRun });
      return reply.send({ run: localRun });
    }
    const existing = await fastify.storage.workflowRuns.getById(req.params.id);
    if (!existing) return reply.code(404).send({ error: "Run not found" });
    const project = await fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) return reply.code(404).send({ error: "Run not found" });
    try {
      const run = await fastify.workflowEngine.cancelRun(req.params.id);
      return reply.send({ run });
    } catch (err) {
      const status = errStatus(err);
      if (status) return reply.code(status).send({ error: (err as Error).message });
      throw err;
    }
  });

  // ---- Remote-provider (path-based) mirrors --------------------------------
  // Served under /api/path/* so the remote-provider gate in server.ts applies.
  // A front server proxies here for remote workspaces: it knows the worker's
  // bare session id and the workspace's remote_path, but not the worker-local
  // project id — so these mirrors derive the project themselves. Gate/cancel/
  // get-by-id need no mirrors (bare run ids work on the normal routes).

  fastify.post<{
    Body: { sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number; reviewerAgentType?: string; reviewerSessionId?: string; intentBrief?: string; reviewSpan?: string; reviewContextMode?: string; runId?: string; newReviewerSessionId?: string };
  }>("/api/path/workflow-runs", async (req, reply) => {
    const userId = requireRawAuth(req, reply);
    if (userId === null) return;
    const { sourceSessionId, reviewFocus, sourceTurnEndIndex } = req.body ?? {};
    if (!sourceSessionId) return reply.code(400).send({ error: "sourceSessionId is required" });
    const reviewSpan = parseReviewSpan(req.body?.reviewSpan);
    if (reviewSpan === null) return reply.code(400).send({ error: "reviewSpan must be one of: this_turn, session_start" });
    const reviewContextMode = parseReviewContextMode(req.body?.reviewContextMode);
    if (reviewContextMode === null) return reply.code(400).send({ error: "reviewContextMode must be one of: briefed, blind" });
    const blind = reviewContextMode === "blind";
    const intentBriefRaw = req.body?.intentBrief;
    if (intentBriefRaw !== undefined && typeof intentBriefRaw !== "string") {
      return reply.code(400).send({ error: "intentBrief must be a string" });
    }
    const intentBrief = blind ? undefined : normalizeIntentBrief(intentBriefRaw);
    const reviewerAgentType = parseReviewerAgentType(req.body?.reviewerAgentType);
    if (reviewerAgentType === null) return reply.code(400).send({ error: "reviewerAgentType must be one of: claude-code, codex" });
    const reviewerSessionIdRaw = req.body?.reviewerSessionId;
    if (reviewerSessionIdRaw !== undefined &&
        (typeof reviewerSessionIdRaw !== "string" || reviewerSessionIdRaw.trim() === "")) {
      return reply.code(400).send({ error: "reviewerSessionId must be a non-empty string" });
    }
    if (reviewerSessionIdRaw !== undefined && reviewerAgentType !== undefined) {
      return reply.code(400).send({ error: "reviewerSessionId and reviewerAgentType are mutually exclusive" });
    }
    const reviewerSessionId = reviewerSessionIdRaw?.trim();
    const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
    const newReviewerSessionId = typeof req.body?.newReviewerSessionId === "string"
      ? req.body.newReviewerSessionId.trim() : "";
    if ((req.body?.runId !== undefined && !runId)
      || (req.body?.newReviewerSessionId !== undefined && !newReviewerSessionId)) {
      return reply.code(400).send({ error: "runId and newReviewerSessionId must be non-empty strings" });
    }
    if (Boolean(runId) !== Boolean(newReviewerSessionId) || (reviewerSessionId && newReviewerSessionId)) {
      return reply.code(400).send({ error: "runId and newReviewerSessionId must be supplied together for a fresh reviewer" });
    }
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceSession) return reply.code(404).send({ error: "Session not found" });
    const sourceProjection = await projectLocalSession(sourceSession);
    if (!sourceProjection) return reply.code(409).send({ error: "Session workspace binding is unavailable" });
    const project = await fastify.storage.projects.getById(sourceProjection.projectId);
    if (!project) return reply.code(404).send({ error: "Session not found" });
    if (!project.path) return reply.code(400).send({ error: "Project has no local path" });
    const projectPath = project.path;
    try {
      const start = () => fastify.workflowEngine.startAdhocReview({
          project: { id: project.id, path: projectPath },
          branch: sourceProjection.branch,
          sourceSessionId,
          reviewFocus,
          sourceTurnEndIndex,
          reviewSpan,
          reviewerAgentType,
          reviewerSessionId,
          intentBrief,
          blind,
          runId: runId || undefined,
          newReviewerSessionId: newReviewerSessionId || undefined,
        });
      let flight = runId ? durableReviewFlights.get(runId) : undefined;
      if (!flight) {
        flight = start();
        if (runId) {
          durableReviewFlights.set(runId, flight);
          const clear = () => {
            if (durableReviewFlights.get(runId) === flight) durableReviewFlights.delete(runId);
          };
          void flight.then(clear, clear);
        }
      }
      const run = await flight;
      return reply.code(201).send({ run });
    } catch (err) {
      const status = errStatus(err);
      if (status) return reply.code(status).send({ error: (err as Error).message });
      throw err;
    }
  });

  /**
   * Phase 1 mirror for the two-phase remote review (hub distills, this worker
   * executes): create the run — status `preparing` — and the placeholder
   * reviewer session without prompting it. Stable identities are REQUIRED so
   * an uncertain result can be replayed through either this route or the
   * single-shot mirror above (whose startAdhocReview activates a prepared run
   * inline). Fresh reviewers only: a re-review has nothing to distill, so it
   * never has a preparing phase. Shares durableReviewFlights with the
   * single-shot mirror — same runId means the same creation, whichever mirror
   * a replay lands on.
   */
  fastify.post<{
    Body: { sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number; reviewerAgentType?: string; reviewSpan?: string; runId?: string; newReviewerSessionId?: string };
  }>("/api/path/workflow-runs/prepare", async (req, reply) => {
    const userId = requireRawAuth(req, reply);
    if (userId === null) return;
    const { sourceSessionId, reviewFocus, sourceTurnEndIndex } = req.body ?? {};
    if (!sourceSessionId) return reply.code(400).send({ error: "sourceSessionId is required" });
    const reviewSpan = parseReviewSpan(req.body?.reviewSpan);
    if (reviewSpan === null) return reply.code(400).send({ error: "reviewSpan must be one of: this_turn, session_start" });
    const reviewerAgentType = parseReviewerAgentType(req.body?.reviewerAgentType);
    if (reviewerAgentType === null) return reply.code(400).send({ error: "reviewerAgentType must be one of: claude-code, codex" });
    const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
    const newReviewerSessionId = typeof req.body?.newReviewerSessionId === "string"
      ? req.body.newReviewerSessionId.trim() : "";
    if (!runId || !newReviewerSessionId) {
      return reply.code(400).send({ error: "runId and newReviewerSessionId are required" });
    }
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceSession) return reply.code(404).send({ error: "Session not found" });
    const sourceProjection = await projectLocalSession(sourceSession);
    if (!sourceProjection) return reply.code(409).send({ error: "Session workspace binding is unavailable" });
    const project = await fastify.storage.projects.getById(sourceProjection.projectId);
    if (!project) return reply.code(404).send({ error: "Session not found" });
    if (!project.path) return reply.code(400).send({ error: "Project has no local path" });
    const projectPath = project.path;
    try {
      let flight = durableReviewFlights.get(runId);
      if (!flight) {
        flight = fastify.workflowEngine.prepareAdhocReview({
          project: { id: project.id, path: projectPath },
          branch: sourceProjection.branch,
          sourceSessionId,
          reviewFocus,
          sourceTurnEndIndex,
          reviewSpan,
          reviewerAgentType,
          runId,
          newReviewerSessionId,
        });
        durableReviewFlights.set(runId, flight);
        const clear = () => {
          if (durableReviewFlights.get(runId) === flight) durableReviewFlights.delete(runId);
        };
        void flight.then(clear, clear);
      }
      const run = await flight;
      return reply.code(201).send({ run });
    } catch (err) {
      const status = errStatus(err);
      if (status) return reply.code(status).send({ error: (err as Error).message });
      throw err;
    }
  });

  /**
   * Phase 2 mirror: the hub finished (or skipped) distilling and hands over
   * the brief; the engine builds the reviewer prompt and sends the first
   * message. Idempotent on replay — an already-activated run comes back
   * unchanged.
   */
  fastify.post<{
    Params: { id: string };
    Body: { intentBrief?: string; reviewContextMode?: string };
  }>("/api/path/workflow-runs/:id/activate", async (req, reply) => {
    const userId = requireRawAuth(req, reply);
    if (userId === null) return;
    const reviewContextMode = parseReviewContextMode(req.body?.reviewContextMode);
    if (reviewContextMode === null) return reply.code(400).send({ error: "reviewContextMode must be one of: briefed, blind" });
    const blind = reviewContextMode === "blind";
    const intentBriefRaw = req.body?.intentBrief;
    if (intentBriefRaw !== undefined && typeof intentBriefRaw !== "string") {
      return reply.code(400).send({ error: "intentBrief must be a string" });
    }
    const intentBrief = blind ? undefined : normalizeIntentBrief(intentBriefRaw);
    try {
      const run = await fastify.workflowEngine.activateAdhocReview(req.params.id, { intentBrief, blind });
      return reply.send({ run });
    } catch (err) {
      const status = errStatus(err);
      if (status) return reply.code(status).send({ error: (err as Error).message });
      throw err;
    }
  });

  fastify.get<{
    Querystring: { sourceSessionId?: string };
  }>("/api/path/workflow-runs/reviewer-candidate", async (req, reply) => {
    const userId = requireRawAuth(req, reply);
    if (userId === null) return;
    const { sourceSessionId } = req.query;
    if (!sourceSessionId) return reply.code(400).send({ error: "sourceSessionId is required" });
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceSession) return reply.code(404).send({ error: "Session not found" });
    if (!(await projectLocalSession(sourceSession))) {
      return reply.code(409).send({ error: "Session workspace binding is unavailable" });
    }
    const candidate = await fastify.workflowEngine.getReviewerCandidate(sourceSessionId);
    return reply.send({ candidate });
  });

  fastify.get<{
    Querystring: { path?: string; branch?: string };
  }>("/api/path/workflow-runs", async (req, reply) => {
    const userId = requireRawAuth(req, reply);
    if (userId === null) return;
    const { path: projectPath, branch } = req.query;
    if (!projectPath) return reply.code(400).send({ error: "path is required" });
    // Same resolution as /api/path/agent-sessions: real project by path,
    // else the pseudo project id used for path-created sessions.
    const project =
      (await fastify.storage.projects.getByPath(projectPath)) ??
      (await fastify.storage.projects.getById(`path:${projectPath}`));
    if (!project) return reply.send({ runs: [], reviewedSessionIds: [] });
    const [runs, reviewedSessionIds] = await Promise.all([
      fastify.storage.workflowRuns.getActive(project.id, branch || null),
      fastify.storage.workflowRuns.listReviewedSourceSessions(project.id, branch || null),
    ]);
    return reply.send({ runs, reviewedSessionIds });
  });
}

export default fp(routes, { name: "workflow-run-routes" });
