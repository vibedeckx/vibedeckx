import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { randomUUID } from "crypto";
import { proxyToRemote, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { resolveWorktreePath } from "../utils/worktree-paths.js";
import { requireAuth } from "../server.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // Execute command at a path (for remote executor)
  fastify.post<{
    Body: { path: string; command: string; cwd?: string; branch?: string | null; pty?: boolean };
  }>("/api/path/execute", async (req, reply) => {
    const { path: projectPath, command, cwd, branch, pty } = req.body;
    if (!projectPath || !command) {
      return reply.code(400).send({ error: "Path and command are required" });
    }

    const resolvedBase = resolveWorktreePath(projectPath, branch ?? null);
    const resolvedCwd = cwd ? path.join(resolvedBase, cwd) : null;

    const tempExecutor = {
      id: randomUUID(),
      project_id: "remote",
      group_id: "",
      name: "remote-command",
      command,
      cwd: resolvedCwd,
      pty: pty !== false,
      position: 0,
      created_at: new Date().toISOString(),
    };

    try {
      const processId = fastify.processManager.start(tempExecutor, resolvedBase, true);
      return reply.code(200).send({ processId });
    } catch (error) {
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 启动 Executor
  fastify.post<{ Params: { id: string }; Body: { branch?: string | null } }>("/api/executors/:id/start", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const executor = fastify.storage.executors.getById(req.params.id);
    if (!executor) {
      return reply.code(404).send({ error: "Executor not found" });
    }

    const project = fastify.storage.projects.getById(executor.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.body?.branch;

    const executorMode = project.executor_mode;
    const useRemoteExecutor = executorMode !== 'local';

    // When remote, resolve connection info from project_remotes table
    const remoteConfig = useRemoteExecutor
      ? fastify.storage.projectRemotes.getByProjectAndServer(project.id, executorMode)
      : undefined;

    // Fallback to legacy project fields if no project_remote found
    const effectiveRemoteUrl = remoteConfig?.server_url ?? project.remote_url;
    const effectiveRemoteApiKey = remoteConfig?.server_api_key ?? project.remote_api_key;
    const effectiveRemotePath = remoteConfig?.remote_path ?? project.remote_path;

    const hasRemoteConfig = !!(effectiveRemoteUrl && effectiveRemoteApiKey && effectiveRemotePath);
    const shouldUseRemote = useRemoteExecutor && hasRemoteConfig;

    console.log(`[API] POST executors/${req.params.id}/start: ` +
      `executor_mode=${executorMode}, useRemoteExecutor=${shouldUseRemote}, ` +
      `remoteConfig=${remoteConfig ? `url=${remoteConfig.server_url}, path=${remoteConfig.remote_path}` : 'legacy'}`);

    if (shouldUseRemote) {
      const result = await proxyToRemoteAuto(
        executorMode,
        effectiveRemoteUrl!,
        effectiveRemoteApiKey!,
        "POST",
        `/api/path/execute`,
        {
          path: effectiveRemotePath,
          command: executor.command,
          branch: branch ?? undefined,
          cwd: executor.cwd || undefined,
          pty: executor.pty,
        },
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      if (result.ok) {
        const remoteData = result.data as { processId: string };
        const localProcessId = `remote-${executor.id}-${remoteData.processId}`;
        fastify.remoteExecutorMap.set(localProcessId, {
          remoteServerId: executorMode,
          remoteUrl: effectiveRemoteUrl!,
          remoteApiKey: effectiveRemoteApiKey!,
          remoteProcessId: remoteData.processId,
        });
        return reply.code(200).send({ processId: localProcessId });
      }
      return reply.code(result.status || 502).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);

    try {
      const processId = fastify.processManager.start(executor, basePath);
      return reply.code(200).send({ processId });
    } catch (error) {
      console.error("[API] Failed to start executor:", error);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 停止进程
  fastify.post<{ Params: { processId: string } }>(
    "/api/executor-processes/:processId/stop",
    async (req, reply) => {
      console.log(`[API] Stop process requested: ${req.params.processId}`);

      if (req.params.processId.startsWith("remote-")) {
        const remoteInfo = fastify.remoteExecutorMap.get(req.params.processId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote process not found" });
        }
        const result = await proxyToRemoteAuto(
          remoteInfo.remoteServerId,
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/executor-processes/${remoteInfo.remoteProcessId}/stop`,
          undefined,
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        return reply.code(result.status || 200).send(result.data);
      }

      const stopped = fastify.processManager.stop(req.params.processId);
      console.log(`[API] Stop result: ${stopped}`);
      if (!stopped) {
        return reply.code(404).send({ error: "Process not found or already stopped" });
      }
      return reply.code(200).send({ success: true });
    }
  );

  // 获取所有运行中的进程
  fastify.get("/api/executor-processes/running", async (req, reply) => {
    const runningProcessIds = fastify.processManager.getRunningProcessIds();
    const processes = runningProcessIds.map((id) => {
      const dbProcess = fastify.storage.executorProcesses.getById(id);
      return dbProcess;
    }).filter(Boolean);

    return reply.code(200).send({ processes });
  });
};

export default fp(routes, { name: "process-routes" });
