import type { FastifyInstance, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import { REVIEWER_AGENT_TYPES, WorkflowError } from "../workflow-engine.js";
import { generateIntentBrief } from "../utils/review-brief.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import type { AgentMessage } from "../agent-types.js";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { projectIdFromRemoteSessionId, mapRemoteReviewerCandidate, mapRemoteRun } from "./remote-status-bridge.js";
import { ensureRemoteAgentStream } from "../remote-agent-sessions.js";
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
  /**
   * Front-side handles for runs living on a worker. Mirrors remoteSessionMap's
   * hydrate-by-use model: populated on POST/GET responses, so after a front
   * restart the panel's first proxied list fetch re-learns every active run
   * before any gate could be clicked. Not persisted on purpose.
   */
  interface RemoteRunInfo {
    remoteServerId: string;
    remoteUrl: string;
    remoteApiKey: string;
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
    info: { remoteServerId: string; remoteUrl: string; remoteApiKey: string },
    method: string,
    apiPath: string,
    body?: unknown,
  ) =>
    proxyToRemoteAuto(info.remoteServerId, info.remoteUrl, info.remoteApiKey, method, apiPath, body, {
      reverseConnectManager: fastify.reverseConnectManager,
    });

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
   */
  const resolveRemoteRun = async (runId: string, userId: string | undefined) => {
    const info = remoteRunMap.get(runId);
    if (!info) return null;
    const project = await fastify.storage.projects.getById(info.projectId, userId);
    if (!project) return null;
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
        const historyResult = await proxyAuto(
          remoteInfo, "GET", `/api/agent-sessions/${remoteInfo.remoteSessionId}`,
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
    Body: { projectId: string; branch?: string | null; sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number; reviewerAgentType?: string; reviewerSessionId?: string; intentBrief?: string; reviewSpan?: string };
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
    const intentBriefRaw = req.body?.intentBrief;
    if (intentBriefRaw !== undefined && typeof intentBriefRaw !== "string") {
      return reply.code(400).send({ error: "intentBrief must be a string" });
    }
    // A present field means the client already ran tier-1 pre-generation (the
    // review dialog does this on open, via POST /api/workflow-runs/intent-brief,
    // to hide the distillation latency) — don't distill again here.
    const clientProvidedBrief = intentBriefRaw !== undefined;
    const clientBrief = normalizeIntentBrief(intentBriefRaw);
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

      let bareReviewerSessionId: string | undefined;
      if (reviewerSessionId) {
        const reviewerInfo = fastify.remoteSessionMap.get(reviewerSessionId);
        if (!reviewerInfo ||
            reviewerInfo.remoteServerId !== remoteInfo.remoteServerId ||
            projectIdFromRemoteSessionId(reviewerSessionId, reviewerInfo) !== projectId) {
          return reply.code(404).send({ error: "Reviewer session not found" });
        }
        bareReviewerSessionId = reviewerInfo.remoteSessionId;
      }

      // Tier-1 context (fresh reviews only): prefer the client's pre-generated
      // brief; distill here only when the client didn't attempt it. Any failure
      // degrades to the worker's deterministic excerpt (tier 2) by simply
      // omitting the field.
      let intentBrief = clientBrief;
      if (!clientProvidedBrief && !bareReviewerSessionId) {
        intentBrief = await distillIntentBrief(userId, sourceSessionId);
      }

      // The worker derives branch from its own session row — the body branch
      // is not forwarded (server-derived branch, same rule as the local path).
      const result = await proxyAuto(remoteInfo, "POST", "/api/path/workflow-runs", {
        sourceSessionId: remoteInfo.remoteSessionId,
        reviewFocus,
        sourceTurnEndIndex,
        reviewSpan,
        reviewerAgentType,
        reviewerSessionId: bareReviewerSessionId,
        intentBrief,
      });
      if (!result.ok) return sendProxyFailure(reply, result);

      const bareRun = (result.data as { run: WorkflowRun }).run;
      const localRun = mapRemoteRun(bareRun, remoteInfo.remoteServerId, projectId);
      trackRemoteRun(localRun, {
        remoteServerId: remoteInfo.remoteServerId,
        remoteUrl: remoteInfo.remoteUrl,
        remoteApiKey: remoteInfo.remoteApiKey,
        bareRunId: bareRun.id,
        projectId,
      });

      // Surface the worker-created reviewer on the front: register the handle
      // and open the resident stream — that stream is what carries the
      // reviewer's suppressed taskCompleted and the workflowRunUpdated frames.
      if (bareRun.reviewer_session_id && localRun.reviewer_session_id) {
        const reviewerInfo = {
          remoteServerId: remoteInfo.remoteServerId,
          remoteUrl: remoteInfo.remoteUrl,
          remoteApiKey: remoteInfo.remoteApiKey,
          remoteSessionId: bareRun.reviewer_session_id,
          branch: bareRun.branch,
        };
        fastify.remoteSessionMap.set(localRun.reviewer_session_id, reviewerInfo);
        await fastify.storage.remoteSessionMappings.upsert(
          localRun.reviewer_session_id, projectId, remoteInfo.remoteServerId,
          bareRun.reviewer_session_id, bareRun.branch,
        );
        ensureRemoteAgentStream(localRun.reviewer_session_id, {
          remoteSessionMap: fastify.remoteSessionMap,
          remotePatchCache: fastify.remotePatchCache,
          reverseConnectManager: fastify.reverseConnectManager,
          eventBus: fastify.eventBus,
          agentSessionManager: fastify.agentSessionManager,
        });
        // The worker's spawn-time announcements (session:status/processAlive)
        // fire before this front subscribes, so nothing surfaces the reviewer
        // here on its own. Same intent as the commander's remote spawn path:
        // session:process makes the sidebar (useResidentSessions) refetch the
        // branch list — which now includes the reviewer — and session:status
        // surfaces it in an open agent window on this workspace.
        fastify.eventBus.emit({
          type: "session:process",
          projectId,
          branch: bareRun.branch,
          sessionId: localRun.reviewer_session_id,
          alive: true,
        });
        fastify.eventBus.emit({
          type: "session:status",
          projectId,
          branch: bareRun.branch,
          sessionId: localRun.reviewer_session_id,
          status: "running",
        });
        // The worker's engine already wrote the final "Review - …" title
        // before responding (the session:process refetch above picks it up).
        // Claim the front's one-shot title slots so a later /message through
        // the front (human takeover) can't regenerate an AI title over it.
        fastify.agentSessionManager.markTitleResolved(localRun.reviewer_session_id);
        await fastify.storage.remoteSessionMappings.markTitleResolved(localRun.reviewer_session_id);
      }
      fastify.eventBus.emit({ type: "workflow:run-updated", projectId, branch: bareRun.branch, run: localRun });
      return reply.code(201).send({ run: localRun });
    }
    const project = await fastify.storage.projects.getById(projectId, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (!project.path) return reply.code(400).send({ error: "Project has no local path (remote-only projects are not supported yet)" });
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceSession || sourceSession.project_id !== projectId) {
      return reply.code(404).send({ error: "Session not found" });
    }
    // The run's branch is derived from the source session itself, never taken
    // verbatim from the request body: the client isn't trusted to report the
    // session's real branch, and a mismatched one would spawn the reviewer
    // against the wrong worktree. "" is the DB's null-branch sentinel for the
    // main workspace (see agent-session-manager.ts createNewSession's
    // `branch ?? ""`), so normalize it to null to match WorkflowRun.branch /
    // the rest of the API's null-branch convention.
    const runBranch = sourceSession.branch || null;
    if (branch !== undefined && (branch || null) !== runBranch) {
      return reply.code(400).send({ error: "branch does not match source session" });
    }
    // Tier-1 context (fresh reviews only): same rule as the remote branch —
    // prefer the client's pre-generated brief, distill only when absent.
    let intentBrief = clientBrief;
    if (!clientProvidedBrief && !reviewerSessionId) {
      intentBrief = await distillIntentBrief(userId, sourceSessionId);
    }
    try {
      const run = await fastify.workflowEngine.startAdhocReview({
        project: { id: project.id, path: project.path },
        branch: runBranch,
        sourceSessionId,
        reviewFocus,
        sourceTurnEndIndex,
        reviewSpan,
        reviewerAgentType,
        reviewerSessionId,
        intentBrief,
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
      if (!session || session.project_id !== projectId) {
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
        const reviewerInfo = {
          remoteServerId: remoteInfo.remoteServerId,
          remoteUrl: remoteInfo.remoteUrl,
          remoteApiKey: remoteInfo.remoteApiKey,
          remoteSessionId: bareCandidate.sessionId,
          branch: remoteInfo.branch,
        };
        fastify.remoteSessionMap.set(candidate.sessionId, reviewerInfo);
        await fastify.storage.remoteSessionMappings.upsert(
          candidate.sessionId,
          projectId,
          remoteInfo.remoteServerId,
          bareCandidate.sessionId,
          remoteInfo.branch ?? null,
        );
      }
      return reply.send({ candidate });
    }
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceSession || sourceSession.project_id !== projectId) {
      return reply.code(404).send({ error: "Session not found" });
    }
    const candidate = await fastify.workflowEngine.getReviewerCandidate(sourceSessionId);
    return reply.send({ candidate });
  });

  fastify.get<{ Querystring: { projectId: string; branch?: string } }>(
    "/api/workflow-runs", async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const { projectId, branch } = req.query;
      if (!projectId) return reply.code(400).send({ error: "projectId is required" });
      const project = await fastify.storage.projects.getById(projectId, userId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.agent_mode && project.agent_mode !== "local") {
        const remoteConfig = await fastify.storage.projectRemotes.getByProjectAndServer(projectId, project.agent_mode);
        if (remoteConfig) {
          const q = new URLSearchParams({ path: remoteConfig.remote_path ?? "" });
          if (branch) q.set("branch", branch);
          const info = {
            remoteServerId: project.agent_mode,
            remoteUrl: remoteConfig.server_url ?? "",
            remoteApiKey: remoteConfig.server_api_key || "",
          };
          const result = await proxyAuto(info, "GET", `/api/path/workflow-runs?${q}`);
          if (!result.ok) return sendProxyFailure(reply, result);
          const bareRuns = (result.data as { runs: WorkflowRun[] }).runs ?? [];
          const runs = bareRuns.map((r) => {
            const mapped = mapRemoteRun(r, info.remoteServerId, projectId);
            trackRemoteRun(mapped, { ...info, bareRunId: r.id, projectId });
            return mapped;
          });
          return reply.send({ runs });
        }
      }
      const runs = await fastify.storage.workflowRuns.getActive(projectId, branch ?? null);
      return reply.send({ runs });
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

  fastify.post<{ Params: { id: string }; Body: { action: "approve" | "cancel"; editedPayload?: string } }>(
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
        return reply.code(400).send({ error: "action must be approve or cancel" });
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
  // Served under /api/path/* so the --accept-remote gate in server.ts applies.
  // A front server proxies here for remote workspaces: it knows the worker's
  // bare session id and the workspace's remote_path, but not the worker-local
  // project id — so these mirrors derive the project themselves. Gate/cancel/
  // get-by-id need no mirrors (bare run ids work on the normal routes).

  fastify.post<{
    Body: { sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number; reviewerAgentType?: string; reviewerSessionId?: string; intentBrief?: string; reviewSpan?: string };
  }>("/api/path/workflow-runs", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { sourceSessionId, reviewFocus, sourceTurnEndIndex } = req.body ?? {};
    if (!sourceSessionId) return reply.code(400).send({ error: "sourceSessionId is required" });
    const reviewSpan = parseReviewSpan(req.body?.reviewSpan);
    if (reviewSpan === null) return reply.code(400).send({ error: "reviewSpan must be one of: this_turn, session_start" });
    const intentBriefRaw = req.body?.intentBrief;
    if (intentBriefRaw !== undefined && typeof intentBriefRaw !== "string") {
      return reply.code(400).send({ error: "intentBrief must be a string" });
    }
    const intentBrief = normalizeIntentBrief(intentBriefRaw);
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
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceSession) return reply.code(404).send({ error: "Session not found" });
    const project = await fastify.storage.projects.getById(sourceSession.project_id);
    if (!project) return reply.code(404).send({ error: "Session not found" });
    if (!project.path) return reply.code(400).send({ error: "Project has no local path" });
    try {
      const run = await fastify.workflowEngine.startAdhocReview({
        project: { id: project.id, path: project.path },
        branch: sourceSession.branch || null,
        sourceSessionId,
        reviewFocus,
        sourceTurnEndIndex,
        reviewSpan,
        reviewerAgentType,
        reviewerSessionId,
        intentBrief,
      });
      return reply.code(201).send({ run });
    } catch (err) {
      const status = errStatus(err);
      if (status) return reply.code(status).send({ error: (err as Error).message });
      throw err;
    }
  });

  fastify.get<{
    Querystring: { sourceSessionId?: string };
  }>("/api/path/workflow-runs/reviewer-candidate", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { sourceSessionId } = req.query;
    if (!sourceSessionId) return reply.code(400).send({ error: "sourceSessionId is required" });
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceSession) return reply.code(404).send({ error: "Session not found" });
    const candidate = await fastify.workflowEngine.getReviewerCandidate(sourceSessionId);
    return reply.send({ candidate });
  });

  fastify.get<{
    Querystring: { path?: string; branch?: string };
  }>("/api/path/workflow-runs", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { path: projectPath, branch } = req.query;
    if (!projectPath) return reply.code(400).send({ error: "path is required" });
    // Same resolution as /api/path/agent-sessions: real project by path,
    // else the pseudo project id used for path-created sessions.
    const project =
      (await fastify.storage.projects.getByPath(projectPath)) ??
      (await fastify.storage.projects.getById(`path:${projectPath}`));
    if (!project) return reply.send({ runs: [] });
    const runs = await fastify.storage.workflowRuns.getActive(project.id, branch || null);
    return reply.send({ runs });
  });
}

export default fp(routes, { name: "workflow-run-routes" });
