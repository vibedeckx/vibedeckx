import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { proxyToRemote } from "../utils/remote-proxy.js";
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
  // Start agent session at a path (path-based, for remote execution)
  fastify.post<{
    Body: { path: string; branch?: string | null; permissionMode?: "plan" | "edit" };
  }>("/api/path/agent-sessions", async (req, reply) => {
    const { path: projectPath, branch, permissionMode } = req.body;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    try {
      const pseudoProjectId = `path:${projectPath}`;
      console.log(`[API] POST /api/path/agent-sessions: path=${projectPath}, branch=${branch}, pseudoProjectId=${pseudoProjectId}`);

      // Ensure a project row exists for the pseudo project ID so the FK constraint is satisfied
      if (!fastify.storage.projects.getById(pseudoProjectId)) {
        const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
        fastify.storage.projects.create({
          id: pseudoProjectId,
          name,
          path: projectPath,
        });
      }

      const sessionId = fastify.agentSessionManager.getOrCreateSession(
        pseudoProjectId,
        branch ?? null,
        projectPath,
        false,
        permissionMode || "edit"
      );

      const session = fastify.agentSessionManager.getSession(sessionId);
      const messages = fastify.agentSessionManager.getMessages(sessionId);

      return reply.code(200).send({
        session: {
          id: sessionId,
          projectId: pseudoProjectId,
          branch: branch ?? null,
          status: session?.status || "running",
          permissionMode: session?.permissionMode || "edit",
        },
        messages,
      });
    } catch (error) {
      console.error("[API] Failed to create path-based agent session:", error);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 获取项目的所有 Agent Sessions
  fastify.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/agent-sessions",
    async (req, reply) => {
      const project = fastify.storage.projects.getById(req.params.projectId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      if (!project.path) {
        return reply.code(200).send({ sessions: [] });
      }

      const dbSessions = fastify.storage.agentSessions.getByProjectId(req.params.projectId);
      const sessions = dbSessions.map(s => {
        const inMemory = fastify.agentSessionManager.getSession(s.id);
        if (inMemory) {
          return { ...s, status: inMemory.status };
        }
        // Stale DB record — if it claims "running" but no in-memory session exists, it's orphaned
        if (s.status === "running") {
          return { ...s, status: "stopped" };
        }
        return s;
      });
      return reply.code(200).send({ sessions });
    }
  );

  // 创建或获取 Agent Session
  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null; permissionMode?: "plan" | "edit" };
  }>("/api/projects/:projectId/agent-sessions", async (req, reply) => {
    const project = fastify.storage.projects.getById(req.params.projectId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branch, permissionMode } = req.body;

    const useRemoteAgent = project.remote_url && project.remote_api_key && project.remote_path &&
      (!project.path || project.agent_mode === 'remote');

    console.log(`[API] POST agent-sessions: projectId=${req.params.projectId}, ` +
      `path=${project.path}, remote_url=${project.remote_url}, ` +
      `remote_path=${project.remote_path}, agent_mode=${project.agent_mode}, ` +
      `useRemoteAgent=${useRemoteAgent}`);

    if (useRemoteAgent) {
      try {
        const result = await proxyToRemote(
          project.remote_url!,
          project.remote_api_key!,
          "POST",
          `/api/path/agent-sessions`,
          { path: project.remote_path, branch, permissionMode }
        );

        console.log(`[API] Remote proxy result: ok=${result.ok}, status=${result.status}, ` +
          `data=${JSON.stringify(result.data).substring(0, 500)}`);

        if (result.ok) {
          const remoteData = result.data as { session: { id: string }; messages: unknown[] };
          const localSessionId = `remote-${project.id}-${remoteData.session.id}`;
          fastify.remoteSessionMap.set(localSessionId, {
            remoteUrl: project.remote_url!,
            remoteApiKey: project.remote_api_key!,
            remoteSessionId: remoteData.session.id,
          });

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
        permissionMode || "edit"
      );

      const session = fastify.agentSessionManager.getSession(sessionId);
      const messages = fastify.agentSessionManager.getMessages(sessionId);

      return reply.code(200).send({
        session: {
          id: sessionId,
          projectId: req.params.projectId,
          branch: branch ?? null,
          status: session?.status || "running",
          permissionMode: session?.permissionMode || "edit",
        },
        messages,
      });
    } catch (error) {
      console.error("[API] Failed to create agent session:", error);
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
        const result = await proxyToRemote(
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "GET",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}`
        );
        return reply.code(result.status || 200).send(result.data);
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
        },
        messages,
      });
    }
  );

  // 发送消息到 Agent Session
  fastify.post<{
    Params: { sessionId: string };
    Body: { content: string };
  }>("/api/agent-sessions/:sessionId/message", async (req, reply) => {
    const { content } = req.body;

    if (!content || typeof content !== "string") {
      return reply.code(400).send({ error: "Content is required" });
    }

    if (req.params.sessionId.startsWith("remote-")) {
      const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
      if (!remoteInfo) {
        return reply.code(404).send({ error: "Remote session not found" });
      }
      const result = await proxyToRemote(
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
        const result = await proxyToRemote(
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
  fastify.post<{ Params: { sessionId: string } }>(
    "/api/agent-sessions/:sessionId/restart",
    async (req, reply) => {
      if (req.params.sessionId.startsWith("remote-")) {
        const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyToRemote(
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}/restart`
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

      const restarted = fastify.agentSessionManager.restartSession(req.params.sessionId, projectPath);
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
        const result = await proxyToRemote(
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
        const result = await proxyToRemote(
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

  // 删除 Agent Session
  fastify.delete<{ Params: { sessionId: string } }>(
    "/api/agent-sessions/:sessionId",
    async (req, reply) => {
      if (req.params.sessionId.startsWith("remote-")) {
        const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote session not found" });
        }
        const result = await proxyToRemote(
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "DELETE",
          `/api/agent-sessions/${remoteInfo.remoteSessionId}`
        );
        fastify.remoteSessionMap.delete(req.params.sessionId);
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
};

export default fp(routes, { name: "agent-session-routes" });
