import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { resolveWorktreePath } from "../utils/worktree-paths.js";
import { proxyToRemote } from "../utils/remote-proxy.js";
import "../server-types.js";

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
      return reply.code(500).send({ error: String(error) });
    }
  });

  // List terminals for a project (local + remote)
  fastify.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/terminals",
    async (req, reply) => {
      const project = fastify.storage.projects.getById(req.params.projectId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      // Local terminals
      const localTerminals = fastify.processManager
        .getTerminals(req.params.projectId)
        .map((t) => ({ ...t, location: "local" as const }));

      // Remote terminals from remoteExecutorMap
      const remoteTerminals: Array<{
        id: string;
        name: string;
        projectId: string;
        cwd?: string;
        location: "remote";
      }> = [];
      for (const [key, info] of fastify.remoteExecutorMap) {
        if (key.startsWith("remote-terminal-")) {
          remoteTerminals.push({
            id: key,
            name: key,
            projectId: req.params.projectId,
            location: "remote",
          });
        }
      }

      const terminals = [...localTerminals, ...remoteTerminals];
      return reply.code(200).send({ terminals });
    }
  );

  // Create a new terminal (local or remote)
  fastify.post<{
    Params: { projectId: string };
    Body: { cwd?: string; branch?: string | null; location?: "local" | "remote" };
  }>("/api/projects/:projectId/terminals", async (req, reply) => {
    const project = fastify.storage.projects.getById(req.params.projectId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.body?.branch;
    const explicitLocation = req.body?.location;

    // Determine whether to use remote
    const hasRemoteConfig = !!(project.remote_url && project.remote_api_key && project.remote_path);
    const useRemote =
      explicitLocation === "remote" ||
      (explicitLocation === undefined &&
        hasRemoteConfig &&
        (!project.path || project.executor_mode === "remote"));

    if (useRemote) {
      if (!hasRemoteConfig) {
        return reply
          .code(400)
          .send({ error: "Project has no remote configuration" });
      }

      const result = await proxyToRemote(
        project.remote_url!,
        project.remote_api_key!,
        "POST",
        "/api/path/terminals",
        {
          path: project.remote_path,
          branch: branch ?? undefined,
        }
      );

      if (result.ok) {
        const remoteData = result.data as {
          terminal: { id: string; name: string; cwd: string };
        };
        const remoteId = remoteData.terminal.id;
        const localId = `remote-terminal-${remoteId}`;

        fastify.remoteExecutorMap.set(localId, {
          remoteUrl: project.remote_url!,
          remoteApiKey: project.remote_api_key!,
          remoteProcessId: remoteId,
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

      return reply.code(result.status || 502).send(result.data);
    }

    // Local terminal
    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);
    const cwd = req.body?.cwd || basePath;

    try {
      const terminal = fastify.processManager.startTerminal(req.params.projectId, cwd);
      return reply.code(201).send({ terminal: { ...terminal, cwd, location: "local" } });
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

        const result = await proxyToRemote(
          remoteInfo.remoteUrl,
          remoteInfo.remoteApiKey,
          "POST",
          `/api/executor-processes/${remoteInfo.remoteProcessId}/stop`
        );

        fastify.remoteExecutorMap.delete(terminalId);

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
