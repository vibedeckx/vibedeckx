import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { AgentMessage, AgentType, ContentPart } from "../agent-types.js";
import { ConversationPatch } from "../conversation-patch.js";
import { getAllProviders } from "../providers/index.js";
import { proxyStatus, proxyToRemote, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { projectIdFromRemoteSessionId } from "./remote-status-bridge.js";
import { requireAuth } from "../server.js";
import "../server-types.js";
import { writePasteToTempFile } from "../utils/paste-file.js";
import { extractUserText } from "../utils/session-title.js";
import type { RemoteSessionInfo } from "../server-types.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import { createRemoteAgentSession, generateAndPushRemoteSessionTitle } from "../remote-agent-sessions.js";
import { ResidentProcessLimitError, shouldShowBranchSessionInList } from "../resident-agent-processes.js";
import { mintCrossRemoteMcpConfig, type CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";
import { randomUUID } from "crypto";

// Resolve project path from a session's projectId.
// Handles both real DB projects and path-based pseudo IDs ("path:/some/path")
async function resolveProjectPath(
  projectId: string,
  storage: { projects: { getById: (id: string) => Promise<{ path: string | null } | undefined> } }
): Promise<string | null> {
  if (projectId.startsWith("path:")) {
    return projectId.slice(5);
  }
  const project = await storage.projects.getById(projectId);
  return project?.path ?? null;
}

// Hard upper bound on the user-typed text portion of a /message body. Image
// attachments (base64) don't count — they have legitimate large size. Long
// pastes are expected to go through /paste and arrive here as a tiny
// <vpaste/> marker. 64 KB chars is well under any agent-context size limit
// but cuts off accidental/malicious bloat that would re-render slowly.
const MESSAGE_TEXT_CHAR_LIMIT = 64 * 1024;

function messageTextLength(content: string | ContentPart[]): number {
  if (typeof content === "string") return content.length;
  let n = 0;
  for (const part of content) {
    if (part.type === "text") n += part.text.length;
  }
  return n;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Helper: proxy to remote via reverse-connect if available, else outbound
  function proxyAuto(
    remoteServerId: string,
    remoteUrl: string,
    remoteApiKey: string,
    method: string,
    apiPath: string,
    body?: unknown
  ) {
    return proxyToRemoteAuto(remoteServerId, remoteUrl, remoteApiKey, method, apiPath, body, {
      reverseConnectManager: fastify.reverseConnectManager,
    });
  }

  /**
   * Resolve a remote-prefixed session id to its RemoteSessionInfo only when the
   * caller owns the mapped project. The remoteSessionMap is a process-wide map
   * hydrated from persisted mappings with no owner context, so a bare map lookup
   * authorizes by ID-presence alone — which is an unauth/IDOR hole on the direct
   * control routes. Gate every remote branch through here.
   *
   * `userId` is the raw `requireAuth` result: `undefined` in no-auth/solo mode,
   * where `projects.getById(id, undefined)` skips the owner filter (one-user
   * deployment), and the Clerk user id under `--auth`, where it enforces
   * per-user ownership. Do NOT pass `resolveUserId(...)` here — that collapses
   * `undefined` to `"local"`, which would not match solo projects (user_id="").
   */
  async function getAuthorizedRemoteSessionInfo(
    sessionId: string,
    userId: string | undefined,
  ): Promise<RemoteSessionInfo | null> {
    const remoteInfo = fastify.remoteSessionMap.get(sessionId);
    if (!remoteInfo) return null;
    const projectId = projectIdFromRemoteSessionId(sessionId, remoteInfo);
    const project = await fastify.storage.projects.getById(projectId, userId);
    if (!project) return null;
    return remoteInfo;
  }

  // Branch a local session: verify the caller owns the source's project, copy
  // its history into a new dormant session, and return the response payload.
  // Shared by the UI route (`/api/agent-sessions/:id/branch`, which mints its
  // own crossRemoteMcp) and the remote-provider route
  // (`/api/path/agent-sessions/:id/branch`, which receives a center-minted one).
  // `userId` is the raw requireAuth result — undefined in solo/api-key mode,
  // which makes projects.getById unscoped (single-tenant) by design.
  async function performLocalBranch(
    sourceSessionId: string,
    userId: string | undefined,
    opts: { agentType?: string; sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig; upToEntryIndex?: number },
  ): Promise<
    | { ok: true; payload: { session: Record<string, unknown>; messages: unknown[] } }
    | { ok: false; code: number; error: string }
  > {
    const sourceRow = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceRow || !(await fastify.storage.projects.getById(sourceRow.project_id, userId))) {
      return { ok: false, code: 404, error: "Session not found" };
    }

    const result = await fastify.agentSessionManager.branchSession(
      sourceSessionId,
      opts.agentType as AgentType | undefined,
      { sessionId: opts.sessionId, crossRemoteMcp: opts.crossRemoteMcp, upToEntryIndex: opts.upToEntryIndex },
    );
    if (!result.ok) {
      if (result.reason === "invalid-cutoff") {
        return { ok: false, code: 400, error: "upToEntryIndex must reference a turn_end stop point" };
      }
      if (result.reason === "running-needs-cutoff") {
        return { ok: false, code: 409, error: "Session is running; branching requires a stop-point cutoff" };
      }
      return { ok: false, code: 404, error: "Session not found or has no history to branch" };
    }
    const newSessionId = result.sessionId;

    const session = fastify.agentSessionManager.getSession(newSessionId);
    const messages = fastify.agentSessionManager.getMessages(newSessionId);
    const dbRow = await fastify.storage.agentSessions.getById(newSessionId);
    return {
      ok: true,
      payload: {
        session: {
          id: newSessionId,
          projectId: session?.projectId,
          branch: session?.branch ?? null,
          status: session?.status || "stopped",
          permissionMode: session?.permissionMode || "edit",
          agentType: session?.agentType || "claude-code",
          title: dbRow?.title ?? null,
        },
        messages,
      },
    };
  }

  // Broadcast a manual rename over the same `session:title` SSE channel the
  // AI-title path uses, so every open window (the sidebar's resident-session
  // list included) updates live instead of waiting for its next refetch. Both
  // the local and remote-proxy branches funnel through here to keep the emit
  // shape identical. `sessionId` MUST be the local id — the wrapped `remote-…`
  // id for remote sessions — since the sidebar keys off wrapped ids. A null
  // title tells the client to fall back to the default name.
  function broadcastRenamedTitle(
    sessionId: string,
    projectId: string,
    branch: string | null,
    title: string | null,
  ): void {
    fastify.agentSessionManager.emitSessionTitle(projectId, branch, sessionId, title);
  }

  // List available agent providers
  fastify.get("/api/agent-providers", async (_req, reply) => {
    const providers = getAllProviders().map((provider) => ({
      type: provider.getAgentType(),
      displayName: provider.getDisplayName(),
      available: provider.isAvailable?.() ?? provider.detectBinary() !== null,
    }));
    return reply.code(200).send({ providers });
  });

  // Start agent session at a path (path-based, for remote execution)
  fastify.post<{
    Body: { path: string; branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string; force?: boolean };
  }>("/api/path/agent-sessions", async (req, reply) => {
    const { path: projectPath, branch, permissionMode, agentType, force } = req.body;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    try {
      let pseudoProjectId = `path:${projectPath}`;
      console.log(`[API] POST /api/path/agent-sessions: path=${projectPath}, branch=${branch}, pseudoProjectId=${pseudoProjectId}`);

      // Ensure a project row exists for the pseudo project ID so the FK constraint is satisfied
      if (!(await fastify.storage.projects.getById(pseudoProjectId))) {
        // Check if a project with this path already exists (avoids UNIQUE constraint on path)
        const existingByPath = await fastify.storage.projects.getByPath(projectPath);
        if (existingByPath) {
          // Reuse the existing project's ID for FK references
          pseudoProjectId = existingByPath.id;
        } else {
          const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
          try {
            await fastify.storage.projects.create({
              id: pseudoProjectId,
              name,
              path: projectPath,
            });
          } catch (err: unknown) {
            // Safety net: if UNIQUE constraint still fires, ignore — the row exists
            if (!(err instanceof Error && err.message.includes("UNIQUE constraint failed"))) {
              throw err;
            }
          }
        }
      }

      const sessionId = await fastify.agentSessionManager.findExistingSession(
        pseudoProjectId,
        branch ?? null,
        projectPath,
        false,
        permissionMode || "edit",
      );

      if (!sessionId) {
        // No existing session for this branch — return placeholder. Frontend
        // shows the "start a conversation" empty state; the session will be
        // created on first user message via /agent-sessions/new.
        console.log(`[API] /api/path/agent-sessions: no existing session (path=${projectPath}, branch=${branch ?? "<null>"})`);
        return reply.code(200).send({ session: null, messages: [] });
      }

      const session = fastify.agentSessionManager.getSession(sessionId);
      const messages = fastify.agentSessionManager.getMessages(sessionId);

      const effectiveStatus = session?.status || "stopped";

      console.log(`[API] /api/path/agent-sessions RESPONSE: sessionId=${sessionId} status=${effectiveStatus} messages.length=${messages.length} (path=${projectPath}, branch=${branch ?? "<null>"}, pseudoProjectId=${pseudoProjectId})`);

      return reply.code(200).send({
        session: {
          id: sessionId,
          projectId: pseudoProjectId,
          branch: branch ?? null,
          status: effectiveStatus,
          permissionMode: session?.permissionMode || "edit",
          agentType: session?.agentType || "claude-code",
          processAlive: session ? fastify.agentSessionManager.getSessionProcessAlive(sessionId) : false,
        },
        messages,
      });
    } catch (error) {
      console.error("[API] Failed to load path-based agent session:", error);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // Path-based: list agent sessions by path (optionally filtered by branch).
  // Used by remote-proxy branch of GET /api/projects/:projectId/agent-sessions.
  // Resolves project via path — avoids relying on pseudo-project (`path:...`) rows
  // existing on the remote, which may not be the case if the project was seeded via path.
  fastify.get<{ Querystring: { path?: string; branch?: string } }>(
    "/api/path/agent-sessions",
    async (req, reply) => {
      const projectPath = req.query.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const existing = await fastify.storage.projects.getByPath(projectPath);
      if (!existing) {
        // No project registered at that path yet — nothing to list.
        return reply.code(200).send({ sessions: [] });
      }
      // Always filter by branch. A missing param means the main/default branch,
      // stored with the empty-string sentinel (""). Mirrors the project-id route;
      // falling back to getByProjectId() here would leak every branch's sessions.
      const dbSessions = await fastify.storage.agentSessions.listByBranch(
        existing.id,
        typeof req.query.branch === "string" ? req.query.branch : "",
      );

      const countMap = new Map(
        (await fastify.storage.agentSessions.countEntries()).map(r => [r.session_id, r.cnt])
      );
      // Hide empty sessions from history — only sessions that actually held a
      // conversation should appear in the dropdown.
      const sessions = dbSessions
        .map(s => {
          const inMemory = fastify.agentSessionManager.getSession(s.id);
          const status = inMemory?.status ?? (s.status === "running" ? "stopped" : s.status);
          return {
            ...s,
            status,
            processAlive: fastify.agentSessionManager.getSessionProcessAlive(s.id),
            entry_count: countMap.get(s.id) ?? 0,
          };
        })
        .filter(s => shouldShowBranchSessionInList({
          entryCount: s.entry_count,
          processAlive: s.processAlive,
        }));
      return reply.code(200).send({ sessions });
    }
  );

  // Path-based: always create a new session (for remote `/new` proxy target)
  fastify.post<{
    Body: { path: string; branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string; force?: boolean; sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig };
  }>("/api/path/agent-sessions/new", async (req, reply) => {
    const { path: projectPath, branch, permissionMode, agentType, force, sessionId, crossRemoteMcp } = req.body;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    let pseudoProjectId = `path:${projectPath}`;
    if (!(await fastify.storage.projects.getById(pseudoProjectId))) {
      const existingByPath = await fastify.storage.projects.getByPath(projectPath);
      if (existingByPath) {
        pseudoProjectId = existingByPath.id;
      } else {
        const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
        try {
          await fastify.storage.projects.create({ id: pseudoProjectId, name, path: projectPath });
        } catch (err: unknown) {
          if (!(err instanceof Error && err.message.includes("UNIQUE constraint failed"))) throw err;
        }
      }
    }

    try {
      const createdSessionId = await fastify.agentSessionManager.createNewSession(
        pseudoProjectId,
        branch ?? null,
        projectPath,
        false,
        permissionMode || "edit",
        (agentType as AgentType) || "claude-code",
        false,
        force === true,
        { sessionId, crossRemoteMcp },
      );
      const session = fastify.agentSessionManager.getSession(createdSessionId);
      return reply.code(200).send({
        session: {
          id: createdSessionId,
          projectId: pseudoProjectId,
          branch: branch ?? null,
          status: session?.status || "running",
          permissionMode: session?.permissionMode || "edit",
          agentType: session?.agentType || "claude-code",
          processAlive: session ? fastify.agentSessionManager.getSessionProcessAlive(session.id) : false,
        },
        messages: [],
      });
    } catch (error) {
      if (error instanceof ResidentProcessLimitError) {
        return reply.code(409).send({
          errorCode: error.errorCode,
          error: error.message,
          maxResidentAgentProcesses: error.maxResidentAgentProcesses,
          runningSessions: error.runningSessions,
        });
      }
      throw error;
    }
  });

  // 获取项目的所有 Agent Sessions
  fastify.get<{ Params: { projectId: string }; Querystring: { branch?: string } }>(
    "/api/projects/:projectId/agent-sessions",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = await fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const useRemoteAgent = project.agent_mode !== "local";

      if (useRemoteAgent) {
        const remoteConfig = await fastify.storage.projectRemotes.getByProjectAndServer(project.id, project.agent_mode);
        if (!remoteConfig) {
          // Remote misconfigured — return empty so the dropdown just shows nothing rather than 4xx.
          return reply.code(200).send({ sessions: [] });
        }
        const params = new URLSearchParams();
        params.set("path", remoteConfig.remote_path);
        // Always forward branch (empty for main) so the remote stays on its
        // branch-filtered query path instead of listing every branch's sessions.
        params.set("branch", typeof req.query.branch === "string" ? req.query.branch : "");
        const result = await proxyAuto(
          project.agent_mode,
          remoteConfig.server_url ?? "",
          remoteConfig.server_api_key || "",
          "GET",
          `/api/path/agent-sessions?${params.toString()}`
        );
        if (!result.ok) {
          console.error("[API] Remote agent-sessions list proxy error:", result.status, result.data);
          return reply.code(proxyStatus(result)).send(result.data);
        }
        const data = result.data as { sessions: Array<{ id: string; status: string; branch?: string | null; entry_count?: number; processAlive?: boolean; [k: string]: unknown }> };
        const mapped = await Promise.all(data.sessions.map(async (s) => {
          const localSessionId = `remote-${project.agent_mode}-${project.id}-${s.id}`;
          // Populate remoteSessionMap + persist so the user can navigate to ANY
          // session in the dropdown (including ones created on the remote
          // directly or by a previous local-server lifetime), and the mapping
          // survives restarts.
          if (!fastify.remoteSessionMap.has(localSessionId)) {
            fastify.remoteSessionMap.set(localSessionId, {
              remoteServerId: project.agent_mode,
              remoteUrl: remoteConfig.server_url ?? "",
              remoteApiKey: remoteConfig.server_api_key || "",
              remoteSessionId: s.id,
              branch: s.branch ?? null,
            });
          }
          await fastify.storage.remoteSessionMappings.upsert(
            localSessionId, project.id, project.agent_mode, s.id, s.branch ?? null,
          );
          return { ...s, id: localSessionId, processAlive: s.processAlive ?? false, entry_count: s.entry_count ?? 0 };
        }));
        return reply.code(200).send({ sessions: mapped });
      }

      if (!project.path) {
        return reply.code(200).send({ sessions: [] });
      }

      // Always filter by branch. A missing param means the main/default branch,
      // which is stored with the empty-string sentinel (""). Falling back to
      // getByProjectId() here would leak sessions from every branch into the list.
      const dbSessions = await fastify.storage.agentSessions.listByBranch(
        req.params.projectId,
        typeof req.query.branch === "string" ? req.query.branch : "",
      );

      const countMap = new Map(
        (await fastify.storage.agentSessions.countEntries()).map(r => [r.session_id, r.cnt])
      );
      // Hide empty sessions from history — only sessions that actually held a
      // conversation should appear in the dropdown.
      const sessions = dbSessions
        .map(s => {
          const inMemory = fastify.agentSessionManager.getSession(s.id);
          const status = inMemory?.status ?? (s.status === "running" ? "stopped" : s.status);
          return {
            ...s,
            status,
            processAlive: fastify.agentSessionManager.getSessionProcessAlive(s.id),
            entry_count: countMap.get(s.id) ?? 0,
          };
        })
        .filter(s => shouldShowBranchSessionInList({
          entryCount: s.entry_count,
          processAlive: s.processAlive,
        }));
      return reply.code(200).send({ sessions });
    }
  );

  // Load existing Agent Session for a branch (no auto-create)
  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string };
  }>("/api/projects/:projectId/agent-sessions", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = await fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branch, permissionMode, agentType } = req.body;

    let agentMode = project.agent_mode;
    let useRemoteAgent = agentMode !== 'local';

    // Fallback: legacy "remote" value → resolve to actual remote server ID
    if (useRemoteAgent && agentMode === 'remote') {
      const remotes = await fastify.storage.projectRemotes.getByProject(project.id);
      if (remotes.length > 0) {
        const fallback = remotes[0];
        agentMode = fallback.remote_server_id;
        await fastify.storage.projects.update(project.id, { agent_mode: fallback.remote_server_id });
        console.log(`[API] Auto-resolved agent_mode from 'remote' to '${fallback.remote_server_id}' (legacy value)`);
      }
    }

    // Fallback: if local mode but no local path, try to find a remote to use
    if (!useRemoteAgent && !project.path) {
      const remotes = await fastify.storage.projectRemotes.getByProject(project.id);
      if (remotes.length > 0) {
        const fallback = remotes[0];
        useRemoteAgent = true;
        agentMode = fallback.remote_server_id;
        // Fix the persisted agent_mode so future requests use the correct mode
        await fastify.storage.projects.update(project.id, { agent_mode: fallback.remote_server_id });
        console.log(`[API] Auto-resolved agent_mode from 'local' to '${fallback.remote_server_id}' (no local path)`);
      }
    }

    // When remote, resolve connection info from project_remotes table
    const remoteConfig = useRemoteAgent
      ? await fastify.storage.projectRemotes.getByProjectAndServer(project.id, agentMode)
      : undefined;

    console.log(`[API] POST agent-sessions: projectId=${req.params.projectId}, ` +
      `path=${project.path}, agent_mode=${agentMode}, ` +
      `useRemoteAgent=${useRemoteAgent}, remoteConfig=${remoteConfig ? `url=${remoteConfig.server_url}, path=${remoteConfig.remote_path}` : 'none'}`);

    if (useRemoteAgent) {
      if (!remoteConfig) {
        return reply.code(400).send({ error: `Remote server configuration not found for agent_mode="${agentMode}"` });
      }

      try {
        const result = await proxyAuto(
          agentMode,
          remoteConfig.server_url ?? "",
          remoteConfig.server_api_key || "",
          "POST",
          `/api/path/agent-sessions`,
          { path: remoteConfig.remote_path, branch, permissionMode, agentType }
        );

        console.log(`[API] Remote proxy result: ok=${result.ok}, status=${result.status}, ` +
          `data=${JSON.stringify(result.data).substring(0, 500)}`);

        if (result.ok) {
          const remoteData = result.data as { session: { id: string } | null; messages: unknown[] };
          if (!remoteData.session) {
            // Remote has no existing session for this branch — pass through.
            return reply.code(200).send({ session: null, messages: [] });
          }
          const localSessionId = `remote-${agentMode}-${project.id}-${remoteData.session.id}`;
          fastify.remoteSessionMap.set(localSessionId, {
            remoteServerId: agentMode,
            remoteUrl: remoteConfig.server_url ?? "",
            remoteApiKey: remoteConfig.server_api_key || "",
            remoteSessionId: remoteData.session.id,
            branch: branch ?? null,
          });
          await fastify.storage.remoteSessionMappings.upsert(
            localSessionId, project.id, agentMode, remoteData.session.id, branch ?? null,
          );

          // Seed remotePatchCache with REST messages so WS replay has data immediately
          if (remoteData.messages && remoteData.messages.length > 0) {
            const cacheEntry = fastify.remotePatchCache.getOrCreate(localSessionId);
            if (cacheEntry.messages.length === 0) {
              for (let i = 0; i < remoteData.messages.length; i++) {
                const patch = ConversationPatch.addEntry(i, remoteData.messages[i] as AgentMessage);
                fastify.remotePatchCache.appendMessage(localSessionId, JSON.stringify({ JsonPatch: patch }), true);
              }
              console.log(`[API] findExisting proxy: seeded cache with ${remoteData.messages.length} msgs for ${localSessionId}`);
            } else {
              console.log(`[API] findExisting proxy: cache already has ${cacheEntry.messages.length} msgs for ${localSessionId} (remote returned ${remoteData.messages.length}), skipping seed`);
            }
          } else {
            console.log(`[API] findExisting proxy: remote returned 0 messages for ${localSessionId} — NOT seeding cache. Cache existing size=${fastify.remotePatchCache.getOrCreate(localSessionId).messages.length}`);
          }

          return reply.code(200).send({
            session: {
              ...remoteData.session,
              id: localSessionId,
              projectId: req.params.projectId,
            },
            messages: remoteData.messages,
          });
        }
        return reply.code(proxyStatus(result)).send(result.data);
      } catch (error) {
        console.error("[API] Remote agent session proxy error:", error);
        return reply.code(502).send({ error: `Remote agent error: ${String(error)}` });
      }
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    console.log(`[API] Loading LOCAL agent session: projectId=${req.params.projectId}, branch=${branch ?? null}, path=${project.path}`);

    try {
      const sessionId = await fastify.agentSessionManager.findExistingSession(
        req.params.projectId,
        branch ?? null,
        project.path,
        false,
        permissionMode || "edit",
      );

      if (!sessionId) {
        // No existing session — UI shows empty placeholder. Session is created
        // on first user message via /agent-sessions/new.
        return reply.code(200).send({ session: null, messages: [] });
      }

      const session = fastify.agentSessionManager.getSession(sessionId);
      const messages = fastify.agentSessionManager.getMessages(sessionId);

      const effectiveStatus = session?.status || "stopped";

      return reply.code(200).send({
        session: {
          id: sessionId,
          projectId: req.params.projectId,
          branch: branch ?? null,
              status: effectiveStatus,
              permissionMode: session?.permissionMode || "edit",
              agentType: session?.agentType || "claude-code",
              processAlive: session ? fastify.agentSessionManager.getSessionProcessAlive(sessionId) : false,
            },
        messages,
      });
    } catch (error) {
      console.error("[API] Failed to load agent session:", error);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // Create a brand-new Agent Session (explicit, always creates)
  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string; force?: boolean };
  }>("/api/projects/:projectId/agent-sessions/new", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = await fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branch, permissionMode, agentType, force } = req.body;
    const agentMode = project.agent_mode;
    const useRemoteAgent = agentMode !== 'local';

    if (useRemoteAgent) {
      const remoteConfig = await fastify.storage.projectRemotes.getByProjectAndServer(project.id, agentMode);
      if (!remoteConfig) {
        return reply.code(400).send({ error: `Remote server configuration not found for agent_mode="${agentMode}"` });
      }
      try {
        const created = await createRemoteAgentSession(
          {
            remoteSessionMap: fastify.remoteSessionMap,
            remoteSessionMappings: fastify.storage.remoteSessionMappings,
            remotePatchCache: fastify.remotePatchCache,
            agentSessionManager: fastify.agentSessionManager,
            reverseConnectManager: fastify.reverseConnectManager,
            storage: fastify.storage,
          },
          {
            projectId: project.id,
            agentMode,
            remoteConfig,
            branch: branch ?? null,
            permissionMode: permissionMode || "edit",
            agentType,
            force: force === true,
            userId,
          },
        );
        if (created.ok) {
          return reply.code(200).send({
            session: { ...created.remoteSession, id: created.localSessionId, projectId: req.params.projectId },
            messages: created.messages,
          });
        }
        return reply.code(proxyStatus({ status: created.status })).send(created.data);
      } catch (error) {
        console.error("[API] Remote agent session proxy error (new):", error);
        return reply.code(502).send({ error: `Remote agent error: ${String(error)}` });
      }
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const preSessionId = randomUUID();
      const crossRemoteMcp = await mintCrossRemoteMcpConfig(
        { storage: fastify.storage },
        { userId, sessionId: preSessionId, sourceRemoteServerId: null },
      );

      const sessionId = await fastify.agentSessionManager.createNewSession(
        req.params.projectId,
        branch ?? null,
        project.path,
        false,
        permissionMode || "edit",
        (agentType as AgentType) || "claude-code",
        false,
        force === true,
        { sessionId: preSessionId, crossRemoteMcp },
      );
      const session = fastify.agentSessionManager.getSession(sessionId);
      return reply.code(200).send({
        session: {
          id: sessionId,
          projectId: req.params.projectId,
          branch: branch ?? null,
          status: session?.status || "running",
          permissionMode: session?.permissionMode || "edit",
          agentType: session?.agentType || "claude-code",
          processAlive: session ? fastify.agentSessionManager.getSessionProcessAlive(sessionId) : false,
        },
        messages: [],
      });
    } catch (error) {
      if (error instanceof ResidentProcessLimitError) {
        return reply.code(409).send({
          errorCode: error.errorCode,
          error: error.message,
          maxResidentAgentProcesses: error.maxResidentAgentProcesses,
          runningSessions: error.runningSessions,
        });
      }
      console.error("[API] Failed to create new agent session:", error);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 获取 Agent Session 详情和消息历史
  fastify.get<{ Params: { sessionId: string } }>(
    "/api/agent-sessions/:sessionId",
    async (req, reply) => {
      if (req.params.sessionId.startsWith("remote-")) {
        const userId = requireAuth(req, reply);
        if (userId === null) return;
        const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "GET",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}`
        );
        if (result.ok) {
          // Rewrite session.id back to the local remote-prefixed id — otherwise
          // the frontend would use the bare remote UUID for subsequent calls
          // (notably the WebSocket URL), which local doesn't recognize and
          // would 404 with "Session not found" in a reconnect loop.
          const remoteData = result.data as { session: { id: string; [k: string]: unknown }; messages: unknown[] };
          return reply.code(200).send({
            ...remoteData,
            session: { ...remoteData.session, id: req.params.sessionId },
          });
        }
        return reply.code(proxyStatus(result)).send(result.data);
      }

      const session = fastify.agentSessionManager.getSession(req.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      const messages = fastify.agentSessionManager.getMessages(req.params.sessionId);

      return reply.code(200).send({
        session: {
          id: session.id,
          projectId: session.projectId,
          branch: session.branch,
          status: session.status,
          permissionMode: session.permissionMode,
          agentType: session.agentType || "claude-code",
          processAlive: fastify.agentSessionManager.getSessionProcessAlive(session.id),
        },
        messages,
      });
    }
  );

  // 发送消息到 Agent Session
  fastify.post<{
    Params: { sessionId: string };
    Body: { content: string | ContentPart[] };
  }>("/api/agent-sessions/:sessionId/message", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
    const { content } = req.body;

    console.log(`[API] POST /message: sessionId=${req.params.sessionId}, isRemote=${req.params.sessionId.startsWith("remote-")}, remoteMapSize=${fastify.remoteSessionMap.size}`);

    // Validate: must be a non-empty string or non-empty array
    const isValidString = typeof content === "string" && content.trim().length > 0;
    const isValidArray = Array.isArray(content) && content.length > 0;
    if (!isValidString && !isValidArray) {
      return reply.code(400).send({ error: "Content is required" });
    }

    // Cap the typed-text portion. Long content should be uploaded via /paste
    // and sent here as a <vpaste/> marker (< 100 bytes per paste).
    const textLen = messageTextLength(content);
    if (textLen > MESSAGE_TEXT_CHAR_LIMIT) {
      return reply.code(413).send({
        error: `Message text exceeds ${MESSAGE_TEXT_CHAR_LIMIT} characters (got ${textLen}). Use /api/agent-sessions/:id/paste for long content.`,
      });
    }

    if (req.params.sessionId.startsWith("remote-")) {
      const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, authResult);
      if (!remoteInfo) {
        console.log(`[API] /message 404: remote session not found. Known keys: [${[...fastify.remoteSessionMap.keys()].join(', ')}]`);
        return reply.code(404).send({ error: "Remote session not found" });
      }
      const result = await proxyAuto(
        remoteInfo.remoteServerId,
        remoteInfo.remoteUrl,
        remoteInfo.remoteApiKey,
        "POST",
        `/api/agent-sessions/${remoteInfo.remoteSessionId}/message`,
        { content }
      );
      if (!result.ok) {
        const status = proxyStatus(result);
        return reply.code(status).send({
          error: `Remote proxy failed: ${result.errorCode || "unknown"}`,
          errorCode: result.errorCode,
          attempts: result.attempts,
          totalDurationMs: result.totalDurationMs,
          detail: result.data,
        });
      }
      // Emit branch:activity working — remote's own EventBus would also emit
      // this event but we don't subscribe to remote SSE; deriving from the
      // proxy success is the cheapest reliable signal. Dedupe handles
      // repeated sends within the same working turn.
      fastify.agentSessionManager.emitBranchActivityIfChanged(
        projectIdFromRemoteSessionId(req.params.sessionId, remoteInfo),
        remoteInfo.branch ?? null,
        { activity: "working", since: Date.now(), sessionId: req.params.sessionId },
      );
      // First-message title generation runs locally (uses the same
      // chat_provider config as main chat), then PATCHes the result back to
      // the remote. Fire-and-forget so it doesn't delay the response.
      void generateAndPushRemoteSessionTitle(
        {
          storage: fastify.storage,
          agentSessionManager: fastify.agentSessionManager,
          remotePatchCache: fastify.remotePatchCache,
          reverseConnectManager: fastify.reverseConnectManager,
        },
        req.params.sessionId,
        extractUserText(content),
        remoteInfo,
        userId,
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    // For dormant sessions, we need projectPath to spawn the process
    const session = fastify.agentSessionManager.getSession(req.params.sessionId);
    let projectPathForWake: string | undefined;
    if (session?.dormant) {
      projectPathForWake = (await resolveProjectPath(session.projectId, fastify.storage)) ?? undefined;
      if (!projectPathForWake) {
        return reply.code(400).send({ error: "Cannot wake session: project has no local path" });
      }
    }

    const success = await fastify.agentSessionManager.sendUserMessage(
      req.params.sessionId,
      content,
      projectPathForWake,
      userId,
    );
    if (!success) {
      console.log(`[API] /message 404: local session not found or not running. sessionId=${req.params.sessionId}, sessionExists=${!!session}, dormant=${session?.dormant}`);
      return reply.code(404).send({ error: "Session not found or not running" });
    }

    return reply.code(200).send({ success: true });
  });

  // Save a pasted blob of text to a temp file on the agent's execution machine.
  // For remote sessions, proxies through so the file lands on the remote host.
  fastify.post<{
    Params: { sessionId: string };
    Body: { content: string };
  }>("/api/agent-sessions/:sessionId/paste", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const { content } = req.body;

    if (typeof content !== "string" || content.length === 0) {
      return reply.code(400).send({ error: "content must be a non-empty string" });
    }

    if (req.params.sessionId.startsWith("remote-")) {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
      if (!remoteInfo) {
        return reply.code(404).send({ error: "Remote session not found" });
      }
      const result = await proxyAuto(
        remoteInfo.remoteServerId,
        remoteInfo.remoteUrl,
        remoteInfo.remoteApiKey,
        "POST",
        `/api/agent-sessions/${remoteInfo.remoteSessionId}/paste`,
        { content }
      );
      if (!result.ok) {
        const status = proxyStatus(result);
        return reply.code(status).send({
          error: `Remote proxy failed: ${result.errorCode || "unknown"}`,
          errorCode: result.errorCode,
          attempts: result.attempts,
          totalDurationMs: result.totalDurationMs,
          detail: result.data,
        });
      }
      return reply.code(proxyStatus(result)).send(result.data);
    }

    try {
      const written = await writePasteToTempFile(content);
      return reply.code(200).send(written);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log?.error({ err }, "[paste] failed to write temp file");
      return reply.code(500).send({ error: `Failed to write paste: ${msg}` });
    }
  });

  // 停止 Agent Session
  fastify.post<{ Params: { sessionId: string } }>(
    "/api/agent-sessions/:sessionId/stop",
    async (req, reply) => {
      if (req.params.sessionId.startsWith("remote-")) {
        const userId = requireAuth(req, reply);
        if (userId === null) return;
        const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}/stop`
        );
        return reply.code(proxyStatus(result)).send(result.data);
      }

      const stopped = await fastify.agentSessionManager.stopSession(req.params.sessionId);
      if (!stopped) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return reply.code(200).send({ success: true });
    }
  );

  // 重启 Agent Session
  fastify.post<{ Params: { sessionId: string }; Body: { agentType?: string } }>(
    "/api/agent-sessions/:sessionId/restart",
    async (req, reply) => {
      if (req.params.sessionId.startsWith("remote-")) {
        const userId = requireAuth(req, reply);
        if (userId === null) return;
        const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}/restart`,
          req.body
        );
        fastify.remotePatchCache.replaceAll(req.params.sessionId, [], 0);
        return reply.code(proxyStatus(result)).send(result.data);
      }

      const session = fastify.agentSessionManager.getSession(req.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      const projectPath = await resolveProjectPath(session.projectId, fastify.storage);
      if (!projectPath) {
        return reply.code(404).send({ error: "Project not found or has no local path" });
      }

      const { agentType } = (req.body || {}) as { agentType?: string };
      const restarted = await fastify.agentSessionManager.restartSession(req.params.sessionId, projectPath, agentType as AgentType | undefined);
      if (!restarted) {
        return reply.code(500).send({ error: "Failed to restart session" });
      }
      return reply.code(200).send({ success: true });
    }
  );

  // Switch the coding agent of an existing session WITHOUT clearing history.
  // The session goes dormant; the next user message wakes it under the new
  // agent with a full conversation-context replay. Refused with 409 while a
  // turn is running on a session that already has history.
  fastify.post<{ Params: { sessionId: string }; Body: { agentType?: string } }>(
    "/api/agent-sessions/:sessionId/agent-type",
    async (req, reply) => {
      const { agentType } = (req.body || {}) as { agentType?: string };
      if (!agentType) {
        return reply.code(400).send({ error: "agentType is required" });
      }

      if (req.params.sessionId.startsWith("remote-")) {
        const userId = requireAuth(req, reply);
        if (userId === null) return;
        const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}/agent-type`,
          { agentType }
        );
        return reply.code(proxyStatus(result)).send(result.data);
      }

      const outcome = await fastify.agentSessionManager.switchAgentType(
        req.params.sessionId,
        agentType as AgentType
      );
      if (outcome === "not_found") {
        return reply.code(404).send({ error: "Session not found" });
      }
      if (outcome === "busy") {
        return reply.code(409).send({ error: "Agent is currently running — stop it before switching" });
      }
      return reply.code(200).send({ success: true, agentType });
    }
  );

  // Branch an Agent Session: create a new dormant session that copies the
  // source session's conversation history. The user continues in the copy
  // (optionally with a different agent type) while the original stays intact.
  fastify.post<{
    Params: { sessionId: string };
    Body: { agentType?: string; upToEntryIndex?: number };
  }>(
    "/api/agent-sessions/:sessionId/branch",
    async (req, reply) => {
      const { agentType, upToEntryIndex } = (req.body || {}) as { agentType?: string; upToEntryIndex?: number };
      if (upToEntryIndex !== undefined && (!Number.isInteger(upToEntryIndex) || upToEntryIndex < 0)) {
        return reply.code(400).send({ error: "upToEntryIndex must be a non-negative integer" });
      }

      const userId = requireAuth(req, reply);
      if (userId === null) return;

      if (req.params.sessionId.startsWith("remote-")) {
        const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const projectId = projectIdFromRemoteSessionId(req.params.sessionId, remoteInfo);
        // Pre-generate the branch's id so we can mint a token bound to it before
        // the remote creates the (dormant) branch — mirrors createRemoteAgentSession.
        // The branch runs on the remote, which can't mint (no userId / no public
        // URL), so the config must be minted here and passed down.
        const newRemoteSessionId = randomUUID();
        const localSessionId = `remote-${remoteInfo.remoteServerId}-${projectId}-${newRemoteSessionId}`;
        const crossRemoteMcp = await mintCrossRemoteMcpConfig(
          { storage: fastify.storage },
          { userId, sessionId: localSessionId, sourceRemoteServerId: remoteInfo.remoteServerId },
        );
        const result = await proxyAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/path/agent-sessions/${remoteInfo.remoteSessionId}/branch`,
          { agentType, sessionId: newRemoteSessionId, crossRemoteMcp, upToEntryIndex }
        );
        if (!result.ok) {
          return reply.code(proxyStatus(result)).send(result.data);
        }

        const remoteData = result.data as { session: { id: string }; messages: unknown[] };
        if (remoteData.session.id !== newRemoteSessionId) {
          // Older remote that ignored the supplied id (or lacks the path-branch
          // route). The token we minted names a session that won't exist, so
          // cross-remote calls would be rejected — fail closed and don't register.
          return reply.code(409).send({ error: "Remote returned an unexpected session id; upgrade the remote" });
        }
        // Old-remote guard (post-hoc by design — lockstep upgrades assumed,
        // same pattern as the id check above): a remote that ignored the
        // cutoff copied the full history. Fail closed and don't register.
        if (upToEntryIndex !== undefined && remoteData.messages.length > upToEntryIndex + 1) {
          console.error(
            `[Branch] Remote ${remoteInfo.remoteServerId} ignored branch cutoff (${remoteData.messages.length} messages > cutoff ${upToEntryIndex}) — version drift, upgrade the remote`,
          );
          return reply.code(409).send({ error: "Remote ignored branch cutoff; upgrade the remote" });
        }
        // Register the local handle. The in-memory set is first (so a later
        // failure has something to roll back), but a throw in the DB write or
        // any subsequent step must not leave a half-registered handle: the map
        // entry would keep a session id "usable" to the gateway (isSessionUsable
        // checks map presence) while the client, having gotten a 500, retries
        // and creates a *second* branch on the remote. Clean up on any error,
        // mirroring createRemoteAgentSession's rollback.
        fastify.remoteSessionMap.set(localSessionId, {
          remoteServerId: remoteInfo.remoteServerId,
          remoteUrl: remoteInfo.remoteUrl,
          remoteApiKey: remoteInfo.remoteApiKey,
          remoteSessionId: newRemoteSessionId,
          branch: remoteInfo.branch ?? null,
        });
        try {
          await fastify.storage.remoteSessionMappings.upsert(
            localSessionId, projectId, remoteInfo.remoteServerId, newRemoteSessionId, remoteInfo.branch ?? null,
          );
          // The remote already wrote the final "Branch - ..." title — claim both
          // title-generation guards so the first message here doesn't clobber it.
          await fastify.storage.remoteSessionMappings.markTitleResolved(localSessionId);
          fastify.agentSessionManager.markTitleResolved(localSessionId);

          // Seed remotePatchCache with the copied messages so WS replay has data
          // immediately (mirrors the create/findExisting proxy paths).
          if (remoteData.messages && remoteData.messages.length > 0) {
            const cacheEntry = fastify.remotePatchCache.getOrCreate(localSessionId);
            if (cacheEntry.messages.length === 0) {
              for (let i = 0; i < remoteData.messages.length; i++) {
                const patch = ConversationPatch.addEntry(i, remoteData.messages[i] as AgentMessage);
                fastify.remotePatchCache.appendMessage(localSessionId, JSON.stringify({ JsonPatch: patch }), true);
              }
            }
          }
        } catch (err) {
          fastify.remoteSessionMap.delete(localSessionId);
          throw err;
        }

        return reply.code(200).send({
          session: { ...remoteData.session, id: localSessionId, projectId },
          messages: remoteData.messages,
        });
      }

      // Mint a cross-remote MCP config bound to the branch's own (pre-generated)
      // session id, mirroring the New Conversation path — otherwise the dormant
      // branch wakes and spawns with no --mcp-config and the gateway never appears.
      const preSessionId = randomUUID();
      const crossRemoteMcp = await mintCrossRemoteMcpConfig(
        { storage: fastify.storage },
        { userId, sessionId: preSessionId, sourceRemoteServerId: null },
      );

      const branched = await performLocalBranch(req.params.sessionId, userId, {
        agentType,
        sessionId: preSessionId,
        crossRemoteMcp,
        upToEntryIndex,
      });
      if (!branched.ok) {
        return reply.code(branched.code).send({ error: branched.error });
      }
      return reply.code(200).send(branched.payload);
    }
  );

  // Path-based branch: the remote-provider target the center proxies to when a
  // user branches a remote session. Gated to --accept-remote servers by the
  // /api/path/ prefix hook, so only an api-key-authenticated center reaches it.
  // The center pre-generates the branch id and mints a token bound to it, then
  // passes both here — the remote must honour the supplied id (the center 409s
  // on mismatch, mirroring /api/path/agent-sessions/new).
  fastify.post<{
    Params: { sessionId: string };
    Body: { agentType?: string; sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig; upToEntryIndex?: number };
  }>("/api/path/agent-sessions/:sessionId/branch", async (req, reply) => {
    const { agentType, sessionId, crossRemoteMcp, upToEntryIndex } = req.body || {};
    if (upToEntryIndex !== undefined && (!Number.isInteger(upToEntryIndex) || upToEntryIndex < 0)) {
      return reply.code(400).send({ error: "upToEntryIndex must be a non-negative integer" });
    }
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const branched = await performLocalBranch(req.params.sessionId, userId, {
      agentType,
      sessionId,
      crossRemoteMcp,
      upToEntryIndex,
    });
    if (!branched.ok) {
      return reply.code(branched.code).send({ error: branched.error });
    }
    return reply.code(200).send(branched.payload);
  });

  // Switch Agent Session permission mode
  fastify.post<{
    Params: { sessionId: string };
    Body: { mode: "plan" | "edit" };
  }>(
    "/api/agent-sessions/:sessionId/switch-mode",
    async (req, reply) => {
      const { mode } = req.body;
      if (!mode || (mode !== "plan" && mode !== "edit")) {
        return reply.code(400).send({ error: "Mode must be 'plan' or 'edit'" });
      }

      if (req.params.sessionId.startsWith("remote-")) {
        const userId = requireAuth(req, reply);
        if (userId === null) return;
        const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}/switch-mode`,
          { mode }
        );
        return reply.code(proxyStatus(result)).send(result.data);
      }

      const session = fastify.agentSessionManager.getSession(req.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      const projectPath = await resolveProjectPath(session.projectId, fastify.storage);
      if (!projectPath) {
        return reply.code(404).send({ error: "Project not found or has no local path" });
      }

      const switched = await fastify.agentSessionManager.switchMode(req.params.sessionId, projectPath, mode);
      if (!switched) {
        return reply.code(500).send({ error: "Failed to switch mode" });
      }
      return reply.code(200).send({ success: true, permissionMode: mode });
    }
  );

  // Accept plan and restart session in edit mode
  fastify.post<{
    Params: { sessionId: string };
    Body: { planContent: string };
  }>(
    "/api/agent-sessions/:sessionId/accept-plan",
    async (req, reply) => {
      const { planContent } = req.body;
      if (!planContent || typeof planContent !== "string") {
        return reply.code(400).send({ error: "planContent is required" });
      }

      if (req.params.sessionId.startsWith("remote-")) {
        const userId = requireAuth(req, reply);
        if (userId === null) return;
        const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}/accept-plan`,
          { planContent }
        );
        return reply.code(proxyStatus(result)).send(result.data);
      }

      const session = fastify.agentSessionManager.getSession(req.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      const projectPath = await resolveProjectPath(session.projectId, fastify.storage);
      if (!projectPath) {
        return reply.code(404).send({ error: "Project not found or has no local path" });
      }

      const accepted = await fastify.agentSessionManager.acceptPlanAndRestart(
        req.params.sessionId,
        projectPath,
        planContent
      );
      if (!accepted) {
        return reply.code(500).send({ error: "Failed to accept plan" });
      }
      return reply.code(200).send({ success: true, permissionMode: "edit" });
    }
  );

  // Approve or deny an agent action (Codex approval flow)
  fastify.post<{
    Params: { sessionId: string };
    Body: { requestId: string; decision: string };
  }>(
    "/api/agent-sessions/:sessionId/approve",
    async (req, reply) => {
      const { requestId, decision } = req.body;
      if (!requestId || typeof requestId !== "string") {
        return reply.code(400).send({ error: "requestId is required" });
      }
      if (!decision || typeof decision !== "string") {
        return reply.code(400).send({ error: "decision is required" });
      }

      if (req.params.sessionId.startsWith("remote-")) {
        const userId = requireAuth(req, reply);
        if (userId === null) return;
        const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}/approve`,
          { requestId, decision }
        );
        return reply.code(proxyStatus(result)).send(result.data);
      }

      const session = fastify.agentSessionManager.getSession(req.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      const success = fastify.agentSessionManager.sendApprovalResponse(
        req.params.sessionId,
        requestId,
        decision
      );
      if (!success) {
        return reply.code(400).send({ error: "Provider does not support approvals or session is not running" });
      }
      return reply.code(200).send({ success: true });
    }
  );

  // 删除 Agent Session
  fastify.delete<{ Params: { sessionId: string } }>(
    "/api/agent-sessions/:sessionId",
    async (req, reply) => {
      if (req.params.sessionId.startsWith("remote-")) {
        const userId = requireAuth(req, reply);
        if (userId === null) return;
        const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "DELETE",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}`
        );
        fastify.remoteSessionMap.delete(req.params.sessionId);
        await fastify.storage.remoteSessionMappings.delete(req.params.sessionId);
        fastify.remotePatchCache.delete(req.params.sessionId);
        return reply.code(proxyStatus(result)).send(result.data);
      }

      const deleted = await fastify.agentSessionManager.deleteSession(req.params.sessionId);
      if (!deleted) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return reply.code(200).send({ success: true });
    }
  );

  fastify.patch<{
    Params: { sessionId: string };
    Body: { title: string | null };
  }>("/api/agent-sessions/:sessionId/title", async (req, reply) => {
    const { title } = req.body;
    if (title !== null && (typeof title !== "string" || title.length > 200)) {
      return reply.code(400).send({ error: "title must be null or a string up to 200 chars" });
    }
    // Normalize once so persistence, the proxied remote write, and the live
    // `session:title` broadcast all agree on the same value: empty/whitespace
    // collapses to null, which the client renders as the default "New Session".
    const normalizedTitle = title && title.trim().length > 0 ? title.trim() : null;

    if (req.params.sessionId.startsWith("remote-")) {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
      if (!remoteInfo) return reply.code(404).send({ error: "Remote session not found" });
      const result = await proxyAuto(
        remoteInfo.remoteServerId,
        remoteInfo.remoteUrl,
        remoteInfo.remoteApiKey,
        "PATCH",
        `/api/agent-sessions/${remoteInfo.remoteSessionId}/title`,
        { title: normalizedTitle }
      );
      // The remote write persists on its node and emits `session:title` on the
      // remote's bus — which this browser never sees, and whose raw id wouldn't
      // match the sidebar's wrapped id anyway. Re-emit locally (once the proxy
      // succeeds) with the LOCAL wrapped id so the sidebar updates live.
      if (result.ok) {
        broadcastRenamedTitle(
          req.params.sessionId,
          projectIdFromRemoteSessionId(req.params.sessionId, remoteInfo),
          remoteInfo.branch ?? null,
          normalizedTitle
        );
      }
      return reply.code(proxyStatus(result)).send(result.data);
    }

    const session = await fastify.storage.agentSessions.getById(req.params.sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    await fastify.storage.agentSessions.updateTitle(req.params.sessionId, normalizedTitle);
    broadcastRenamedTitle(
      req.params.sessionId,
      session.project_id,
      session.branch,
      normalizedTitle
    );
    return reply.code(200).send({ success: true, title: normalizedTitle });
  });

  fastify.patch<{
    Params: { sessionId: string };
    Body: { favorited: boolean };
  }>("/api/agent-sessions/:sessionId/favorite", async (req, reply) => {
    const { favorited } = req.body;
    if (typeof favorited !== "boolean") {
      return reply.code(400).send({ error: "favorited must be a boolean" });
    }

    if (req.params.sessionId.startsWith("remote-")) {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const remoteInfo = await getAuthorizedRemoteSessionInfo(req.params.sessionId, userId);
      if (!remoteInfo) return reply.code(404).send({ error: "Remote session not found" });
      const result = await proxyAuto(
        remoteInfo.remoteServerId,
        remoteInfo.remoteUrl,
        remoteInfo.remoteApiKey,
        "PATCH",
        `/api/agent-sessions/${remoteInfo.remoteSessionId}/favorite`,
        { favorited }
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    const session = await fastify.storage.agentSessions.getById(req.params.sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    await fastify.storage.agentSessions.setFavorited(req.params.sessionId, favorited);
    return reply.code(200).send({ success: true, favorited });
  });
};

export default fp(routes, { name: "agent-session-routes" });
