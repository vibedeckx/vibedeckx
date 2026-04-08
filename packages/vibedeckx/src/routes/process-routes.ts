import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { randomUUID } from "crypto";
import { proxyToRemote, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { resolveWorktreePath } from "../utils/worktree-paths.js";
import type { ExecutorType, PromptProvider } from "../storage/types.js";
import { requireAuth } from "../server.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // Execute command at a path (for remote executor)
  fastify.post<{
    Body: { path: string; command: string; executor_type?: string; prompt_provider?: string; cwd?: string; branch?: string | null; pty?: boolean };
  }>("/api/path/execute", async (req, reply) => {
    const { path: projectPath, command, executor_type, prompt_provider, cwd, branch, pty } = req.body;
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
      executor_type: (executor_type === 'prompt' ? 'prompt' : 'command') as ExecutorType,
      prompt_provider: (prompt_provider === 'codex' ? 'codex' : 'claude') as PromptProvider | null,
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
  fastify.post<{ Params: { id: string }; Body: { branch?: string | null; target?: string } }>("/api/executors/:id/start", async (req, reply) => {
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

    // Use explicit target from request if provided, otherwise fall back to project setting
    let executorMode = req.body?.target || project.executor_mode;
    let useRemoteExecutor = executorMode !== 'local';

    // Fallback: legacy "remote" value → resolve to actual remote server ID
    if (useRemoteExecutor && executorMode === 'remote') {
      const remotes = fastify.storage.projectRemotes.getByProject(project.id);
      if (remotes.length > 0) {
        const fallback = remotes[0];
        executorMode = fallback.remote_server_id;
        fastify.storage.projects.update(project.id, { executor_mode: fallback.remote_server_id });
        console.log(`[API] Auto-resolved executor_mode from 'remote' to '${fallback.remote_server_id}' (legacy value)`);
      }
    }

    // Fallback: if local mode but no local path, try to find a remote to use
    if (!useRemoteExecutor && !project.path) {
      const remotes = fastify.storage.projectRemotes.getByProject(project.id);
      if (remotes.length > 0) {
        const fallback = remotes[0];
        useRemoteExecutor = true;
        executorMode = fallback.remote_server_id;
        fastify.storage.projects.update(project.id, { executor_mode: fallback.remote_server_id });
        console.log(`[API] Auto-resolved executor_mode from 'local' to '${fallback.remote_server_id}' (no local path)`);
      }
    }

    // When remote, resolve connection info from project_remotes table
    const remoteConfig = useRemoteExecutor
      ? fastify.storage.projectRemotes.getByProjectAndServer(project.id, executorMode)
      : undefined;

    console.log(`[API] POST executors/${req.params.id}/start: ` +
      `executor_mode=${executorMode}, useRemoteExecutor=${useRemoteExecutor}, ` +
      `remoteConfig=${remoteConfig ? `url=${remoteConfig.server_url}, path=${remoteConfig.remote_path}` : 'none'}`);

    if (useRemoteExecutor) {
      if (!remoteConfig) {
        return reply.code(400).send({ error: `Remote server configuration not found for executor_mode="${executorMode}"` });
      }

      const result = await proxyToRemoteAuto(
        executorMode,
        remoteConfig.server_url ?? "",
        remoteConfig.server_api_key || "",
        "POST",
        `/api/path/execute`,
        {
          path: remoteConfig.remote_path,
          command: executor.command,
          executor_type: executor.executor_type,
          prompt_provider: executor.prompt_provider,
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
          remoteUrl: remoteConfig.server_url ?? "",
          remoteApiKey: remoteConfig.server_api_key || "",
          remoteProcessId: remoteData.processId,
          executorId: executor.id,
          projectId: project.id,
        });
        fastify.storage.remoteExecutorProcesses.insert(localProcessId, {
          remoteServerId: executorMode,
          remoteUrl: remoteConfig.server_url ?? "",
          remoteApiKey: remoteConfig.server_api_key || "",
          remoteProcessId: remoteData.processId,
          executorId: executor.id,
          projectId: project.id,
          branch: branch ?? undefined,
        });
        fastify.eventBus.emit({
          type: "executor:started",
          projectId: project.id,
          executorId: executor.id,
          processId: localProcessId,
          target: executorMode,
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
        if (result.ok) {
          fastify.eventBus.emit({
            type: "executor:stopped",
            projectId: remoteInfo.projectId ?? "",
            executorId: remoteInfo.executorId,
            processId: req.params.processId,
            exitCode: 0,
            target: remoteInfo.remoteServerId,
          });
          fastify.remoteExecutorMap.delete(req.params.processId);
          fastify.storage.remoteExecutorProcesses.delete(req.params.processId);
        }
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
    // Local processes
    const runningProcessIds = fastify.processManager.getRunningProcessIds();
    const processes: Array<Record<string, unknown>> = runningProcessIds.map((id) => {
      const dbProcess = fastify.storage.executorProcesses.getById(id);
      return dbProcess ? { ...dbProcess, target: "local" } : null;
    }).filter(Boolean) as Array<Record<string, unknown>>;

    // Remote processes (tracked in remoteExecutorMap)
    for (const [localProcessId, info] of fastify.remoteExecutorMap) {
      processes.push({
        id: localProcessId,
        executor_id: info.executorId,
        status: "running",
        exit_code: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        target: info.remoteServerId,
      });
    }

    return reply.code(200).send({ processes });
  });
};

export default fp(routes, { name: "process-routes" });
