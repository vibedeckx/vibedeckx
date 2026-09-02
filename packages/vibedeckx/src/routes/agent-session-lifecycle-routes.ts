/**
 * Prepared-session lifecycle routes
 * (docs/superpowers/specs/2026-08-31-prepared-agent-session-lifecycle-design.md §9).
 *
 * Worker surface (path-based, tunnel-reachable, registered in
 * reverse-connect-capabilities.ts):
 *   POST   /api/path/agent-sessions/prepare
 *   POST   /api/path/agent-sessions/start
 *   POST   /api/agent-sessions/:sessionId/activate
 *   DELETE /api/agent-sessions/:sessionId/preparation
 *
 * Hub surface (project-based; local projects go to the local service, remote
 * projects to RemoteSessionLifecycleAdapter):
 *   POST   /api/projects/:projectId/agent-sessions/prepare
 *   POST   /api/projects/:projectId/agent-sessions/start
 * plus the two by-id routes above, which dispatch on the `remote-` prefix.
 *
 * Every response is `{ kind, lifecycle, ... }` with the status from
 * `lifecycleHttpStatus`; there is no separate lifecycle GET (§9.1).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AgentType, ContentPart, NotificationDisposition } from "../agent-types.js";
import { requireAuth as requireRawAuth } from "../server.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import { mintCrossRemoteMcpConfig, type CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";
import { isSessionPurpose, type SessionPurpose } from "../session-lifecycle-log.js";
import { toLifecycleResponse, type SessionLifecycleView, type SessionOwner } from "../agent-session-lifecycle.js";
import { RemoteSessionLifecycleAdapter } from "../remote-session-lifecycle.js";
import "../server-types.js";

const KEY_MAX = 512;
const validKey = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= KEY_MAX;
const validInstruction = (value: unknown): value is string | ContentPart[] =>
  (typeof value === "string" && value.trim().length > 0) || (Array.isArray(value) && value.length > 0);
const permission = (value: unknown): "plan" | "edit" => (value === "plan" ? "plan" : "edit");
const modelOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const ownerOf = (value: unknown): SessionOwner | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const o = value as { kind?: unknown; id?: unknown };
  if ((o.kind === "workflow_run" || o.kind === "project_chat_operation" || o.kind === "commander_request") && typeof o.id === "string") {
    return { kind: o.kind, id: o.id };
  }
  return undefined;
};
const crossRemoteOf = (value: unknown): CrossRemoteMcpConfig | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const c = value as { url?: unknown; token?: unknown };
  return typeof c.url === "string" && typeof c.token === "string" ? { url: c.url, token: c.token } : undefined;
};

interface PrepareBody {
  operationId?: string;
  sessionId?: string;
  branch?: string | null;
  permissionMode?: "plan" | "edit";
  agentType?: string;
  model?: string | null;
  purpose?: string;
  owner?: unknown;
}
interface StartBody extends PrepareBody {
  instruction?: unknown;
  force?: boolean;
  origin?: "workflow";
  notificationDisposition?: NotificationDisposition;
  crossRemoteMcp?: unknown;
}
interface ActivateBody {
  activationKey?: string;
  instruction?: unknown;
  force?: boolean;
  origin?: "workflow";
  notificationDisposition?: NotificationDisposition;
  crossRemoteMcp?: unknown;
}

export interface LifecycleRoutesOptions {
  /** Test seam: replaces the adapter built from the instance's decorations. */
  remoteLifecycle?: RemoteSessionLifecycleAdapter;
}

const routes: FastifyPluginAsync<LifecycleRoutesOptions> = async (fastify, opts) => {
  const remote = () => opts.remoteLifecycle ?? new RemoteSessionLifecycleAdapter({
    remoteSessionMap: fastify.remoteSessionMap,
    remoteSessionMappings: fastify.storage.remoteSessionMappings,
    remotePatchCache: fastify.remotePatchCache,
    agentSessionManager: fastify.agentSessionManager,
    reverseConnectManager: fastify.reverseConnectManager,
    storage: fastify.storage,
    eventBus: fastify.eventBus ?? null,
  });

  /**
   * Session summary for the UI once a session is real (§10.1: the client
   * caches/connects/selects only after activation). Absent for every other
   * outcome — a pending identity is deliberately not a session to the UI.
   */
  const sessionSummary = (result: { kind: string; view?: SessionLifecycleView | null }, fallback: {
    permissionMode: "plan" | "edit"; agentType: string; model: string | null;
  }) => {
    if (!result.view || !["activated", "replayed", "uncertain"].includes(result.kind)) return undefined;
    const view = result.view;
    const local = view.remoteSessionId ? null : fastify.agentSessionManager.getSession(view.sessionId);
    return {
      id: view.sessionId,
      projectId: view.projectId,
      branch: view.branch,
      status: local?.status ?? "running",
      permissionMode: local?.permissionMode ?? fallback.permissionMode,
      agentType: local?.agentType ?? fallback.agentType,
      model: local ? (local.model ?? null) : fallback.model,
      processAlive: local ? fastify.agentSessionManager.getSessionProcessAlive(view.sessionId) : true,
    };
  };

  const send = (
    reply: FastifyReply,
    result: { kind: string; view?: SessionLifecycleView | null; [key: string]: unknown },
    fallback?: { permissionMode: "plan" | "edit"; agentType: string; model: string | null },
  ) => {
    const { status, body } = toLifecycleResponse({ ...result, view: result.view ?? undefined } as Parameters<typeof toLifecycleResponse>[0]);
    const session = fallback ? sessionSummary(result, fallback) : undefined;
    return reply.code(status).send(session ? { ...body, session } : body);
  };

  /**
   * Worker-side project resolution for path-based routes — the same rule the
   * legacy `/api/path/agent-sessions/new` applies: an existing project by
   * path wins, otherwise a `path:` pseudo-project is created on demand.
   */
  async function resolvePathProject(projectPath: string, authResult: string | undefined): Promise<string | null> {
    let pseudoProjectId = `path:${projectPath}`;
    if (await fastify.storage.projects.getById(pseudoProjectId, authResult)) return pseudoProjectId;
    const existingByPath = await fastify.storage.projects.getByPath(projectPath);
    if (existingByPath) {
      if (!(await fastify.storage.projects.getById(existingByPath.id, authResult))) return null;
      return existingByPath.id;
    }
    const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
    try {
      await fastify.storage.projects.create({ id: pseudoProjectId, name, path: projectPath }, authResult);
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message.includes("UNIQUE constraint failed"))) throw err;
    }
    return pseudoProjectId;
  }

  /** Purpose is server-assigned: path routes take the hub's word (it validated), project routes accept only the interactive pair. */
  const purposeOf = (value: unknown, allowed: readonly SessionPurpose[]): SessionPurpose | null => {
    if (value === undefined) return "interactive";
    return isSessionPurpose(value) && allowed.includes(value) ? value : null;
  };
  const ALL_PURPOSES: readonly SessionPurpose[] = ["interactive", "interactive_upload", "commander", "project_chat", "workflow_review"];
  const CLIENT_PURPOSES: readonly SessionPurpose[] = ["interactive", "interactive_upload"];

  // -------------------------------------------------------------------------
  // Worker: path-based prepare / start
  // -------------------------------------------------------------------------

  fastify.post<{ Body: PrepareBody & { path?: string } }>("/api/path/agent-sessions/prepare", async (req, reply) => {
    const authResult = requireRawAuth(req, reply);
    if (authResult === null) return;
    const { path: projectPath } = req.body;
    if (!projectPath) return reply.code(400).send({ error: "Path is required" });
    if (!validKey(req.body.operationId)) return reply.code(400).send({ error: "operationId must contain 1-512 characters" });
    const purpose = purposeOf(req.body.purpose, ALL_PURPOSES);
    if (!purpose) return reply.code(400).send({ error: "Invalid purpose" });
    const projectId = await resolvePathProject(projectPath, authResult);
    if (!projectId) return reply.code(404).send({ error: "Project not found" });
    const result = await fastify.agentSessionLifecycle.prepare({
      operationId: req.body.operationId,
      sessionId: typeof req.body.sessionId === "string" ? req.body.sessionId : undefined,
      projectId,
      branch: req.body.branch ?? null,
      permissionMode: permission(req.body.permissionMode),
      agentType: (req.body.agentType as AgentType) || "claude-code",
      model: modelOf(req.body.model),
      purpose,
      owner: ownerOf(req.body.owner),
    });
    return send(reply, result);
  });

  fastify.post<{ Body: StartBody & { path?: string } }>("/api/path/agent-sessions/start", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const authResult = requireRawAuth(req, reply);
    if (authResult === null) return;
    const { path: projectPath } = req.body;
    if (!projectPath) return reply.code(400).send({ error: "Path is required" });
    if (!validKey(req.body.operationId)) return reply.code(400).send({ error: "operationId must contain 1-512 characters" });
    if (!validInstruction(req.body.instruction)) return reply.code(400).send({ error: "Instruction is required" });
    const purpose = purposeOf(req.body.purpose, ["interactive", "commander", "project_chat"]);
    if (!purpose) return reply.code(400).send({ error: "Invalid purpose" });
    const projectId = await resolvePathProject(projectPath, authResult);
    if (!projectId) return reply.code(404).send({ error: "Project not found" });
    const result = await fastify.agentSessionLifecycle.start({
      operationId: req.body.operationId,
      sessionId: typeof req.body.sessionId === "string" ? req.body.sessionId : undefined,
      projectId,
      branch: req.body.branch ?? null,
      permissionMode: permission(req.body.permissionMode),
      agentType: (req.body.agentType as AgentType) || "claude-code",
      model: modelOf(req.body.model),
      purpose: purpose as "interactive" | "commander" | "project_chat",
      owner: ownerOf(req.body.owner),
      instruction: req.body.instruction,
      force: req.body.force === true,
      origin: req.body.origin === "workflow" ? "workflow" : undefined,
      notificationDisposition: req.body.notificationDisposition,
      crossRemoteMcp: crossRemoteOf(req.body.crossRemoteMcp),
      userId: resolveUserId(authResult),
    });
    return send(reply, result, { permissionMode: permission(req.body.permissionMode), agentType: (req.body.agentType as string) || "claude-code", model: modelOf(req.body.model) });
  });

  // -------------------------------------------------------------------------
  // Hub: project-based prepare / start
  // -------------------------------------------------------------------------

  async function hubProject(req: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) {
    const userId = requireAuth(req, reply);
    if (userId === null) return null;
    const project = await fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      reply.code(404).send({ error: "Project not found" });
      return null;
    }
    if (project.agent_mode !== "local") {
      const remoteConfig = await fastify.storage.projectRemotes.getByProjectAndServer(project.id, project.agent_mode);
      if (!remoteConfig?.remote_path) {
        reply.code(400).send({ error: `Remote server configuration not found for agent_mode="${project.agent_mode}"` });
        return null;
      }
      return { userId, project, remote: { serverId: project.agent_mode, path: remoteConfig.remote_path } };
    }
    if (!project.path) {
      reply.code(400).send({ error: "Project has no local path" });
      return null;
    }
    return { userId, project, remote: null };
  }

  fastify.post<{ Params: { projectId: string }; Body: PrepareBody }>("/api/projects/:projectId/agent-sessions/prepare", async (req, reply) => {
    const ctx = await hubProject(req, reply);
    if (!ctx) return;
    if (!validKey(req.body.operationId)) return reply.code(400).send({ error: "operationId must contain 1-512 characters" });
    const purpose = purposeOf(req.body.purpose, CLIENT_PURPOSES);
    if (!purpose) return reply.code(400).send({ error: "Invalid purpose" });
    const common = {
      operationId: req.body.operationId,
      branch: req.body.branch ?? null,
      permissionMode: permission(req.body.permissionMode),
      agentType: (req.body.agentType as AgentType) || "claude-code",
      model: modelOf(req.body.model),
      purpose,
    };
    if (ctx.remote) {
      const result = await remote().prepare({
        ...common, projectId: ctx.project.id, remoteServerId: ctx.remote.serverId, remotePath: ctx.remote.path,
        userId: ctx.userId,
      });
      return send(reply, result);
    }
    const result = await fastify.agentSessionLifecycle.prepare({
      ...common,
      sessionId: typeof req.body.sessionId === "string" ? req.body.sessionId : undefined,
      projectId: ctx.project.id,
    });
    return send(reply, result);
  });

  fastify.post<{ Params: { projectId: string }; Body: StartBody }>("/api/projects/:projectId/agent-sessions/start", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const ctx = await hubProject(req, reply);
    if (!ctx) return;
    if (!validKey(req.body.operationId)) return reply.code(400).send({ error: "operationId must contain 1-512 characters" });
    if (!validInstruction(req.body.instruction)) return reply.code(400).send({ error: "Instruction is required" });
    if (req.body.purpose !== undefined && req.body.purpose !== "interactive") return reply.code(400).send({ error: "Invalid purpose" });
    const common = {
      operationId: req.body.operationId,
      branch: req.body.branch ?? null,
      permissionMode: permission(req.body.permissionMode),
      agentType: (req.body.agentType as AgentType) || "claude-code",
      model: modelOf(req.body.model),
      instruction: req.body.instruction,
      force: req.body.force === true,
      userId: ctx.userId,
    };
    const fallback = { permissionMode: common.permissionMode, agentType: common.agentType as string, model: common.model };
    if (ctx.remote) {
      const result = await remote().start({
        ...common, purpose: "interactive", projectId: ctx.project.id,
        remoteServerId: ctx.remote.serverId, remotePath: ctx.remote.path,
      });
      return send(reply, result, fallback);
    }
    const sessionId = typeof req.body.sessionId === "string" ? req.body.sessionId : undefined;
    const crossRemoteMcp = sessionId
      ? await mintCrossRemoteMcpConfig({ storage: fastify.storage }, { userId: ctx.userId, sessionId, sourceRemoteServerId: null })
      : undefined;
    const result = await fastify.agentSessionLifecycle.start({
      ...common, purpose: "interactive", sessionId, projectId: ctx.project.id, crossRemoteMcp,
    });
    return send(reply, result, fallback);
  });

  // -------------------------------------------------------------------------
  // Both: by-id activate / cancel, dispatching on the remote- prefix
  // -------------------------------------------------------------------------

  /** Local rows are authorized through their projected project; pending rows are bound, so the projection exists. */
  async function authorizeLocal(sessionId: string, authResult: string | undefined): Promise<boolean> {
    const activity = await fastify.storage.agentSessions.getActivityById(sessionId, "runtime");
    if (!activity) return false;
    return Boolean(await fastify.storage.projects.getById(activity.projectId, authResult));
  }

  /** Remote ids resolve through the durable intent (pending) or the mapping (active). */
  async function authorizeRemote(sessionId: string, authResult: string | undefined): Promise<boolean> {
    const [intent, mapping] = await Promise.all([
      fastify.storage.remoteSessionCreationIntents.getByLocal(sessionId),
      fastify.storage.remoteSessionMappings.getByLocal(sessionId),
    ]);
    const projectId = mapping?.project_id ?? intent?.project_id;
    if (!projectId) return false;
    return Boolean(await fastify.storage.projects.getById(projectId, authResult));
  }

  fastify.post<{ Params: { sessionId: string }; Body: ActivateBody }>("/api/agent-sessions/:sessionId/activate", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    if (!validKey(req.body.activationKey)) return reply.code(400).send({ error: "activationKey must contain 1-512 characters" });
    if (!validInstruction(req.body.instruction)) return reply.code(400).send({ error: "Instruction is required" });
    const { sessionId } = req.params;
    const common = {
      activationKey: req.body.activationKey,
      instruction: req.body.instruction,
      force: req.body.force === true,
      origin: req.body.origin === "workflow" ? "workflow" as const : undefined,
      notificationDisposition: req.body.notificationDisposition,
    };

    if (sessionId.startsWith("remote-")) {
      if (!(await authorizeRemote(sessionId, authResult))) return reply.code(404).send({ kind: "not_found", error: "Session not found" });
      const intent = await fastify.storage.remoteSessionCreationIntents.getByLocal(sessionId);
      return send(reply, await remote().activate({ ...common, localSessionId: sessionId, userId: authResult }), {
        permissionMode: intent?.permission_mode ?? "edit", agentType: intent?.agent_type ?? "claude-code", model: intent?.model ?? null,
      });
    }

    if (!(await authorizeLocal(sessionId, authResult))) return reply.code(404).send({ kind: "not_found", error: "Session not found" });
    // Re-minted per spawn (the worker half adopts a hub-supplied config, the
    // hub half mints its own for a local session).
    const crossRemoteMcp = crossRemoteOf(req.body.crossRemoteMcp)
      ?? await mintCrossRemoteMcpConfig({ storage: fastify.storage }, { userId: authResult, sessionId, sourceRemoteServerId: null })
        .catch(() => undefined);
    const result = await fastify.agentSessionLifecycle.activate({
      ...common, sessionId, crossRemoteMcp, userId: resolveUserId(authResult),
    });
    return send(reply, result, { permissionMode: "edit", agentType: "claude-code", model: null });
  });

  fastify.delete<{ Params: { sessionId: string }; Body?: { reason?: string } }>("/api/agent-sessions/:sessionId/preparation", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const { sessionId } = req.params;
    const reason = req.body?.reason === "owner_failed" ? "owner_failed" as const : "cancelled" as const;
    if (sessionId.startsWith("remote-")) {
      if (!(await authorizeRemote(sessionId, authResult))) return reply.code(404).send({ kind: "not_found", error: "Session not found" });
      return send(reply, await remote().cancel({ localSessionId: sessionId, reason }));
    }
    if (!(await authorizeLocal(sessionId, authResult))) return reply.code(404).send({ kind: "not_found", error: "Session not found" });
    return send(reply, await fastify.agentSessionLifecycle.cancel({ sessionId, reason }));
  });
};

export default fp(routes, { name: "agent-session-lifecycle-routes" });
