import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { AgentMessage, AgentType, ContentPart } from "../agent-types.js";
import { ConversationPatch } from "../conversation-patch.js";
import { getAllProviders } from "../providers/index.js";
import { proxyToRemote, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";
import "../server-types.js";

// Resolve project path from a session's projectId.
// Handles both real DB projects and path-based pseudo IDs ("path:/some/path")
function resolveProjectPath(
  projectId: string,
  storage: { projects: { getById: (id: string) => { path: string | null } | undefined } }
): string | null {
  if (projectId.startsWith("path:")) {
    return projectId.slice(5);
  }
  const project = storage.projects.getById(projectId);
  return project?.path ?? null;
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

  // List available agent providers
  fastify.get("/api/agent-providers", async (_req, reply) => {
    const providers = getAllProviders().map((provider) => ({
      type: provider.getAgentType(),
      displayName: provider.getDisplayName(),
      available: provider.detectBinary() !== null,
    }));
    return reply.code(200).send({ providers });
  });

  // Start agent session at a path (path-based, for remote execution)
  fastify.post<{
    Body: { path: string; branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string };
  }>("/api/path/agent-sessions", async (req, reply) => {
    const { path: projectPath, branch, permissionMode, agentType } = req.body;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    try {
      let pseudoProjectId = `path:${projectPath}`;
      console.log(`[API] POST /api/path/agent-sessions: path=${projectPath}, branch=${branch}, pseudoProjectId=${pseudoProjectId}`);

      // Ensure a project row exists for the pseudo project ID so the FK constraint is satisfied
      if (!fastify.storage.projects.getById(pseudoProjectId)) {
        // Check if a project with this path already exists (avoids UNIQUE constraint on path)
        const existingByPath = fastify.storage.projects.getByPath(projectPath);
        if (existingByPath) {
          // Reuse the existing project's ID for FK references
          pseudoProjectId = existingByPath.id;
        } else {
          const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
          try {
            fastify.storage.projects.create({
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

      const sessionId = fastify.agentSessionManager.getOrCreateSession(
        pseudoProjectId,
        branch ?? null,
        projectPath,
        false,
        permissionMode || "edit",
        (agentType as AgentType) || "claude-code"
      );

      const session = fastify.agentSessionManager.getSession(sessionId);
      const messages = fastify.agentSessionManager.getMessages(sessionId);

      const effectiveStatus = session?.status || "stopped";

      return reply.code(200).send({
        session: {
          id: sessionId,
          projectId: pseudoProjectId,
          branch: branch ?? null,
          status: effectiveStatus,
          permissionMode: session?.permissionMode || "edit",
          agentType: session?.agentType || "claude-code",
        },
        messages,
      });
    } catch (error) {
      console.error("[API] Failed to create path-based agent session:", error);
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
      const existing = fastify.storage.projects.getByPath(projectPath);
      if (!existing) {
        // No project registered at that path yet — nothing to list.
        return reply.code(200).send({ sessions: [] });
      }
      const dbSessions = typeof req.query.branch === "string"
        ? fastify.storage.agentSessions.listByBranch(existing.id, req.query.branch)
        : fastify.storage.agentSessions.getByProjectId(existing.id);

      const countMap = new Map(
        fastify.storage.agentSessions.countEntries().map(r => [r.session_id, r.cnt])
      );
      const sessions = dbSessions.map(s => {
        const inMemory = fastify.agentSessionManager.getSession(s.id);
        const status = inMemory?.status ?? (s.status === "running" ? "stopped" : s.status);
        return { ...s, status, entry_count: countMap.get(s.id) ?? 0 };
      });
      return reply.code(200).send({ sessions });
    }
  );

  // Path-based: always create a new session (for remote `/new` proxy target)
  fastify.post<{
    Body: { path: string; branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string };
  }>("/api/path/agent-sessions/new", async (req, reply) => {
    const { path: projectPath, branch, permissionMode, agentType } = req.body;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    let pseudoProjectId = `path:${projectPath}`;
    if (!fastify.storage.projects.getById(pseudoProjectId)) {
      const existingByPath = fastify.storage.projects.getByPath(projectPath);
      if (existingByPath) {
        pseudoProjectId = existingByPath.id;
      } else {
        const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
        try {
          fastify.storage.projects.create({ id: pseudoProjectId, name, path: projectPath });
        } catch (err: unknown) {
          if (!(err instanceof Error && err.message.includes("UNIQUE constraint failed"))) throw err;
        }
      }
    }

    const sessionId = fastify.agentSessionManager.createNewSession(
      pseudoProjectId,
      branch ?? null,
      projectPath,
      false,
      permissionMode || "edit",
      (agentType as AgentType) || "claude-code"
    );
    const session = fastify.agentSessionManager.getSession(sessionId);
    return reply.code(200).send({
      session: {
        id: sessionId,
        projectId: pseudoProjectId,
        branch: branch ?? null,
        status: session?.status || "running",
        permissionMode: session?.permissionMode || "edit",
        agentType: session?.agentType || "claude-code",
      },
      messages: [],
    });
  });

  // 获取项目的所有 Agent Sessions
  fastify.get<{ Params: { projectId: string }; Querystring: { branch?: string } }>(
    "/api/projects/:projectId/agent-sessions",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const useRemoteAgent = project.agent_mode !== "local";

      if (useRemoteAgent) {
        const remoteConfig = fastify.storage.projectRemotes.getByProjectAndServer(project.id, project.agent_mode);
        if (!remoteConfig) {
          // Remote misconfigured — return empty so the dropdown just shows nothing rather than 4xx.
          return reply.code(200).send({ sessions: [] });
        }
        const params = new URLSearchParams();
        params.set("path", remoteConfig.remote_path);
        if (typeof req.query.branch === "string") {
          params.set("branch", req.query.branch);
        }
        const result = await proxyAuto(
          project.agent_mode,
          remoteConfig.server_url ?? "",
          remoteConfig.server_api_key || "",
          "GET",
          `/api/path/agent-sessions?${params.toString()}`
        );
        if (!result.ok) {
          console.error("[API] Remote agent-sessions list proxy error:", result.status, result.data);
          return reply.code(result.status || 502).send(result.data);
        }
        const data = result.data as { sessions: Array<{ id: string; status: string; branch?: string | null; entry_count?: number; [k: string]: unknown }> };
        const mapped = data.sessions.map(s => {
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
          fastify.storage.remoteSessionMappings.upsert(
            localSessionId, project.id, project.agent_mode, s.id, s.branch ?? null,
          );
          return { ...s, id: localSessionId, entry_count: s.entry_count ?? 0 };
        });
        return reply.code(200).send({ sessions: mapped });
      }

      if (!project.path) {
        return reply.code(200).send({ sessions: [] });
      }

      const dbSessions = typeof req.query.branch === "string"
        ? fastify.storage.agentSessions.listByBranch(req.params.projectId, req.query.branch)
        : fastify.storage.agentSessions.getByProjectId(req.params.projectId);

      const countMap = new Map(
        fastify.storage.agentSessions.countEntries().map(r => [r.session_id, r.cnt])
      );
      const sessions = dbSessions.map(s => {
        const inMemory = fastify.agentSessionManager.getSession(s.id);
        const status = inMemory?.status ?? (s.status === "running" ? "stopped" : s.status);
        return { ...s, status, entry_count: countMap.get(s.id) ?? 0 };
      });
      return reply.code(200).send({ sessions });
    }
  );

  // 创建或获取 Agent Session
  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string };
  }>("/api/projects/:projectId/agent-sessions", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branch, permissionMode, agentType } = req.body;

    let agentMode = project.agent_mode;
    let useRemoteAgent = agentMode !== 'local';

    // Fallback: legacy "remote" value → resolve to actual remote server ID
    if (useRemoteAgent && agentMode === 'remote') {
      const remotes = fastify.storage.projectRemotes.getByProject(project.id);
      if (remotes.length > 0) {
        const fallback = remotes[0];
        agentMode = fallback.remote_server_id;
        fastify.storage.projects.update(project.id, { agent_mode: fallback.remote_server_id });
        console.log(`[API] Auto-resolved agent_mode from 'remote' to '${fallback.remote_server_id}' (legacy value)`);
      }
    }

    // Fallback: if local mode but no local path, try to find a remote to use
    if (!useRemoteAgent && !project.path) {
      const remotes = fastify.storage.projectRemotes.getByProject(project.id);
      if (remotes.length > 0) {
        const fallback = remotes[0];
        useRemoteAgent = true;
        agentMode = fallback.remote_server_id;
        // Fix the persisted agent_mode so future requests use the correct mode
        fastify.storage.projects.update(project.id, { agent_mode: fallback.remote_server_id });
        console.log(`[API] Auto-resolved agent_mode from 'local' to '${fallback.remote_server_id}' (no local path)`);
      }
    }

    // When remote, resolve connection info from project_remotes table
    const remoteConfig = useRemoteAgent
      ? fastify.storage.projectRemotes.getByProjectAndServer(project.id, agentMode)
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
          const remoteData = result.data as { session: { id: string }; messages: unknown[] };
          const localSessionId = `remote-${agentMode}-${project.id}-${remoteData.session.id}`;
          fastify.remoteSessionMap.set(localSessionId, {
            remoteServerId: agentMode,
            remoteUrl: remoteConfig.server_url ?? "",
            remoteApiKey: remoteConfig.server_api_key || "",
            remoteSessionId: remoteData.session.id,
            branch: branch ?? null,
          });
          fastify.storage.remoteSessionMappings.upsert(
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
            }
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
        return reply.code(result.status || 502).send(result.data);
      } catch (error) {
        console.error("[API] Remote agent session proxy error:", error);
        return reply.code(502).send({ error: `Remote agent error: ${String(error)}` });
      }
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    console.log(`[API] Creating LOCAL agent session: projectId=${req.params.projectId}, branch=${branch ?? null}, path=${project.path}, permissionMode=${permissionMode || "edit"}`);

    try {
      const sessionId = fastify.agentSessionManager.getOrCreateSession(
        req.params.projectId,
        branch ?? null,
        project.path,
        false,
        permissionMode || "edit",
        (agentType as AgentType) || "claude-code"
      );

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
        },
        messages,
      });
    } catch (error) {
      console.error("[API] Failed to create agent session:", error);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // Create a brand-new Agent Session (explicit, always creates)
  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string };
  }>("/api/projects/:projectId/agent-sessions/new", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branch, permissionMode, agentType } = req.body;
    const agentMode = project.agent_mode;
    const useRemoteAgent = agentMode !== 'local';

    if (useRemoteAgent) {
      const remoteConfig = fastify.storage.projectRemotes.getByProjectAndServer(project.id, agentMode);
      if (!remoteConfig) {
        return reply.code(400).send({ error: `Remote server configuration not found for agent_mode="${agentMode}"` });
      }
      try {
        const result = await proxyAuto(
          agentMode,
          remoteConfig.server_url ?? "",
          remoteConfig.server_api_key || "",
          "POST",
          `/api/path/agent-sessions/new`,
          { path: remoteConfig.remote_path, branch, permissionMode, agentType }
        );
        if (result.ok) {
          const remoteData = result.data as { session: { id: string }; messages: unknown[] };
          const localSessionId = `remote-${agentMode}-${project.id}-${remoteData.session.id}`;
          fastify.remoteSessionMap.set(localSessionId, {
            remoteServerId: agentMode,
            remoteUrl: remoteConfig.server_url ?? "",
            remoteApiKey: remoteConfig.server_api_key || "",
            remoteSessionId: remoteData.session.id,
            branch: branch ?? null,
          });
          fastify.storage.remoteSessionMappings.upsert(
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
            }
          }

          return reply.code(200).send({
            session: { ...remoteData.session, id: localSessionId, projectId: req.params.projectId },
            messages: remoteData.messages,
          });
        }
        return reply.code(result.status || 502).send(result.data);
      } catch (error) {
        console.error("[API] Remote agent session proxy error (new):", error);
        return reply.code(502).send({ error: `Remote agent error: ${String(error)}` });
      }
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const sessionId = fastify.agentSessionManager.createNewSession(
        req.params.projectId,
        branch ?? null,
        project.path,
        false,
        permissionMode || "edit",
        (agentType as AgentType) || "claude-code"
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
        },
        messages: [],
      });
    } catch (error) {
      console.error("[API] Failed to create new agent session:", error);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 获取 Agent Session 详情和消息历史
  fastify.get<{ Params: { sessionId: string } }>(
    "/api/agent-sessions/:sessionId",
    async (req, reply) => {
      if (req.params.sessionId.startsWith("remote-")) {
        const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
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
        return reply.code(result.status || 502).send(result.data);
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
    const { content } = req.body;

    console.log(`[API] POST /message: sessionId=${req.params.sessionId}, isRemote=${req.params.sessionId.startsWith("remote-")}, remoteMapSize=${fastify.remoteSessionMap.size}`);

    // Validate: must be a non-empty string or non-empty array
    const isValidString = typeof content === "string" && content.trim().length > 0;
    const isValidArray = Array.isArray(content) && content.length > 0;
    if (!isValidString && !isValidArray) {
      return reply.code(400).send({ error: "Content is required" });
    }

    if (req.params.sessionId.startsWith("remote-")) {
      const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
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
        const status = result.status || 502;
        return reply.code(status).send({
          error: `Remote proxy failed: ${result.errorCode || "unknown"}`,
          errorCode: result.errorCode,
          attempts: result.attempts,
          totalDurationMs: result.totalDurationMs,
          detail: result.data,
        });
      }
      return reply.code(result.status || 200).send(result.data);
    }

    // For dormant sessions, we need projectPath to spawn the process
    const session = fastify.agentSessionManager.getSession(req.params.sessionId);
    let projectPathForWake: string | undefined;
    if (session?.dormant) {
      projectPathForWake = resolveProjectPath(session.projectId, fastify.storage) ?? undefined;
      if (!projectPathForWake) {
        return reply.code(400).send({ error: "Cannot wake session: project has no local path" });
      }
    }

    const success = fastify.agentSessionManager.sendUserMessage(req.params.sessionId, content, projectPathForWake);
    if (!success) {
      console.log(`[API] /message 404: local session not found or not running. sessionId=${req.params.sessionId}, sessionExists=${!!session}, dormant=${session?.dormant}`);
      return reply.code(404).send({ error: "Session not found or not running" });
    }

    return reply.code(200).send({ success: true });
  });

  // 停止 Agent Session
  fastify.post<{ Params: { sessionId: string } }>(
    "/api/agent-sessions/:sessionId/stop",
    async (req, reply) => {
      if (req.params.sessionId.startsWith("remote-")) {
        const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
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
        return reply.code(result.status || 200).send(result.data);
      }

      const stopped = fastify.agentSessionManager.stopSession(req.params.sessionId);
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
        const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
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
        return reply.code(result.status || 200).send(result.data);
      }

      const session = fastify.agentSessionManager.getSession(req.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      const projectPath = resolveProjectPath(session.projectId, fastify.storage);
      if (!projectPath) {
        return reply.code(404).send({ error: "Project not found or has no local path" });
      }

      const { agentType } = (req.body || {}) as { agentType?: string };
      const restarted = fastify.agentSessionManager.restartSession(req.params.sessionId, projectPath, agentType as AgentType | undefined);
      if (!restarted) {
        return reply.code(500).send({ error: "Failed to restart session" });
      }
      return reply.code(200).send({ success: true });
    }
  );

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
        const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
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
        return reply.code(result.status || 200).send(result.data);
      }

      const session = fastify.agentSessionManager.getSession(req.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      const projectPath = resolveProjectPath(session.projectId, fastify.storage);
      if (!projectPath) {
        return reply.code(404).send({ error: "Project not found or has no local path" });
      }

      const switched = fastify.agentSessionManager.switchMode(req.params.sessionId, projectPath, mode);
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
        const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
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
        return reply.code(result.status || 200).send(result.data);
      }

      const session = fastify.agentSessionManager.getSession(req.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      const projectPath = resolveProjectPath(session.projectId, fastify.storage);
      if (!projectPath) {
        return reply.code(404).send({ error: "Project not found or has no local path" });
      }

      const accepted = fastify.agentSessionManager.acceptPlanAndRestart(
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
        const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
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
        return reply.code(result.status || 200).send(result.data);
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
        const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
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
        fastify.storage.remoteSessionMappings.delete(req.params.sessionId);
        fastify.remotePatchCache.delete(req.params.sessionId);
        return reply.code(result.status || 200).send(result.data);
      }

      const deleted = fastify.agentSessionManager.deleteSession(req.params.sessionId);
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

    if (req.params.sessionId.startsWith("remote-")) {
      const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
      if (!remoteInfo) return reply.code(404).send({ error: "Remote session not found" });
      const result = await proxyAuto(
        remoteInfo.remoteServerId,
        remoteInfo.remoteUrl,
        remoteInfo.remoteApiKey,
        "PATCH",
        `/api/agent-sessions/${remoteInfo.remoteSessionId}/title`,
        { title }
      );
      return reply.code(result.status || 200).send(result.data);
    }

    const session = fastify.storage.agentSessions.getById(req.params.sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    fastify.storage.agentSessions.updateTitle(req.params.sessionId, title);
    return reply.code(200).send({ success: true, title });
  });
};

export default fp(routes, { name: "agent-session-routes" });
