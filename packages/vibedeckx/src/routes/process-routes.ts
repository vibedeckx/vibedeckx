import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { randomUUID } from "crypto";
import { proxyToRemote } from "../utils/remote-proxy.js";
import { resolveWorktreePath } from "../utils/worktree-paths.js";
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
    const executor = fastify.storage.executors.getById(req.params.id);
    if (!executor) {
      return reply.code(404).send({ error: "Executor not found" });
    }

    const project = fastify.storage.projects.getById(executor.project_id);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.body?.branch;

    const useRemoteExecutor = project.remote_url && project.remote_api_key && project.remote_path &&
      (!project.path || project.executor_mode === 'remote');

    console.log(`[API] POST executors/${req.params.id}/start: ` +
      `executor_mode=${project.executor_mode}, useRemoteExecutor=${useRemoteExecutor}`);

    if (useRemoteExecutor) {
      const result = await proxyToRemote(
        project.remote_url!,
        project.remote_api_key!,
        "POST",
        `/api/path/execute`,
        {
          path: project.remote_path,
          command: executor.command,
          branch: branch ?? undefined,
          cwd: executor.cwd || undefined,
          pty: executor.pty,
        }
      );
      if (result.ok) {
        const remoteData = result.data as { processId: string };
        const localProcessId = `remote-${executor.id}-${remoteData.processId}`;
        fastify.remoteExecutorMap.set(localProcessId, {
          remoteServerId: String(project.executor_mode),
          remoteUrl: project.remote_url!,
          remoteApiKey: project.remote_api_key!,
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
        const result = await proxyToRemote(
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/executor-processes/${remoteInfo.remoteProcessId}/stop`
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
