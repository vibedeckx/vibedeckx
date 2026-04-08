import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { resolveWorktreePath } from "../utils/worktree-paths.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";
import "../server-types.js";
import type { Project } from "../storage/types.js";

function getRemoteConfig(fastify: FastifyInstance, project: Project, remoteServerId?: string) {
  // Check project_remotes table first (new approach)
  const remotes = fastify.storage.projectRemotes.getByProject(project.id);
  if (remotes.length > 0) {
    const target = remoteServerId
      ? remotes.find((r) => r.remote_server_id === remoteServerId)
      : remotes[0]; // sorted by sort_order
    if (target) {
      return {
        serverId: target.remote_server_id,
        url: target.server_url ?? "",
        apiKey: target.server_api_key ?? "",
        remotePath: target.remote_path,
      };
    }
  }
  // Fallback to legacy project fields
  if (project.remote_url && project.remote_api_key && project.remote_path) {
    return {
      serverId: "",
      url: project.remote_url,
      apiKey: project.remote_api_key,
      remotePath: project.remote_path,
    };
  }
  return null;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Remote-side endpoint: spawn a terminal at a given path
  fastify.post<{
    Body: { path: string; branch?: string | null };
  }>("/api/path/terminals", async (req, reply) => {
    const { path: projectPath, branch } = req.body;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    const resolvedPath = resolveWorktreePath(projectPath, branch ?? null);

    try {
      const terminal = fastify.processManager.startTerminal("remote", resolvedPath);
      return reply.code(201).send({ terminal: { id: terminal.id, name: terminal.name, cwd: resolvedPath } });
    } catch (error) {
      console.error(`[terminal-routes] Failed to start terminal in ${resolvedPath}:`, error);
      return reply.code(500).send({ error: String(error) });
    }
  });

  // Remote-side endpoint: send a command to a terminal (fire-and-forget)
  fastify.post<{
    Params: { terminalId: string };
    Body: { command: string };
  }>("/api/path/terminals/:terminalId/send", async (req, reply) => {
    const { terminalId } = req.params;
    const { command } = req.body;

    if (!command) {
      return reply.code(400).send({ error: "Command is required" });
    }

    try {
      fastify.processManager.sendToTerminal(terminalId, command);
      return reply.send({ sent: true });
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });

  // List terminals for a project (local + remote)
  fastify.get<{ Params: { projectId: string }; Querystring: { branch?: string } }>(
    "/api/projects/:projectId/terminals",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const branch = req.query.branch !== undefined ? (req.query.branch || null) : undefined;

      // Local terminals (filtered by branch)
      const localTerminals = fastify.processManager
        .getTerminals(req.params.projectId, branch)
        .map((t) => ({ ...t, location: "local" as const }));

      // Remote terminals from remoteExecutorMap (filtered by project and branch)
      const remoteTerminals: Array<{
        id: string;
        name: string;
        projectId: string;
        cwd?: string;
        branch?: string | null;
        location: "remote";
      }> = [];
      for (const [key, info] of fastify.remoteExecutorMap.entries()) {
        if (!key.startsWith("remote-terminal-")) continue;
        if (info.projectId && info.projectId !== req.params.projectId) continue;
        if (branch !== undefined && (info.branch ?? null) !== branch) continue;
        remoteTerminals.push({
          id: key,
          name: key,
          projectId: req.params.projectId,
          branch: info.branch,
          location: "remote",
        });
      }

      const terminals = [...localTerminals, ...remoteTerminals];
      return reply.code(200).send({ terminals });
    }
  );

  // Create a new terminal (local or remote)
  fastify.post<{
    Params: { projectId: string };
    Body: { cwd?: string; branch?: string | null; location?: "local" | "remote"; remote_server_id?: string };
  }>("/api/projects/:projectId/terminals", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.body?.branch;
    const explicitLocation = req.body?.location;

    const executorMode = project.executor_mode;
    const remoteConfig = getRemoteConfig(fastify, project, req.body?.remote_server_id);

    const useRemote =
      explicitLocation === "remote" ||
      (explicitLocation === undefined &&
        remoteConfig &&
        (!project.path || executorMode !== "local"));

    if (useRemote) {
      if (!remoteConfig) {
        return reply
          .code(400)
          .send({ error: "Project has no remote configuration" });
      }

      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "POST",
        "/api/path/terminals",
        {
          path: remoteConfig.remotePath,
          branch: branch ?? undefined,
        },
        { reverseConnectManager: fastify.reverseConnectManager }
      );

      if (result.ok) {
        const remoteData = result.data as {
          terminal: { id: string; name: string; cwd: string };
        };
        if (!remoteData?.terminal?.id) {
          console.error(`[terminal-routes] Remote returned unexpected data:`, JSON.stringify(result.data).slice(0, 500));
          return reply.code(502).send({ error: "Remote returned invalid terminal data" });
        }
        const remoteId = remoteData.terminal.id;
        const localId = `remote-terminal-${remoteId}`;
        console.log(`[terminal-routes] Remote terminal created: ${localId} (remote=${remoteId})`);

        fastify.remoteExecutorMap.set(localId, {
          remoteServerId: remoteConfig.serverId,
          remoteUrl: remoteConfig.url,
          remoteApiKey: remoteConfig.apiKey,
          remoteProcessId: remoteId,
          executorId: "",
          projectId: req.params.projectId,
          branch: branch ?? null,
        });
        fastify.storage.remoteExecutorProcesses.insert(localId, {
          remoteServerId: remoteConfig.serverId,
          remoteUrl: remoteConfig.url,
          remoteApiKey: remoteConfig.apiKey,
          remoteProcessId: remoteId,
          executorId: "",
          projectId: req.params.projectId,
          branch: branch ?? null,
        });

        return reply.code(201).send({
          terminal: {
            id: localId,
            name: remoteData.terminal.name,
            cwd: remoteData.terminal.cwd,
            location: "remote",
          },
        });
      }

      console.error(`[terminal-routes] Remote terminal creation failed: status=${result.status}, error=${result.errorCode}, data=${JSON.stringify(result.data).slice(0, 300)}`);
      return reply.code(result.status || 502).send(result.data);
    }

    // Local terminal
    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);
    const cwd = req.body?.cwd || basePath;

    try {
      const terminal = fastify.processManager.startTerminal(req.params.projectId, cwd, branch ?? null);
      return reply.code(201).send({ terminal: { ...terminal, cwd, branch: branch ?? null, location: "local" } });
    } catch (error) {
      return reply.code(500).send({ error: String(error) });
    }
  });

  // Close a terminal (local or remote)
  fastify.delete<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId",
    async (req, reply) => {
      const { terminalId } = req.params;

      // Remote terminal
      if (terminalId.startsWith("remote-terminal-")) {
        const remoteInfo = fastify.remoteExecutorMap.get(terminalId);
        if (!remoteInfo) {
          return reply.code(404).send({ error: "Remote terminal not found" });
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

        fastify.remoteExecutorMap.delete(terminalId);
        fastify.storage.remoteExecutorProcesses.delete(terminalId);

        if (!result.ok) {
          return reply.code(result.status || 502).send(result.data);
        }

        return reply.code(200).send({ success: true });
      }

      // Local terminal
      const stopped = fastify.processManager.stop(terminalId);
      if (!stopped) {
        return reply.code(404).send({ error: "Terminal not found or already closed" });
      }
      return reply.code(200).send({ success: true });
    }
  );
};

export default fp(routes, { name: "terminal-routes" });
