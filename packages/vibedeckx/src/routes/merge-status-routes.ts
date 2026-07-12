import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { computeMergeStatus } from "../merge-status.js";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";
import "../server-types.js";
import type { Project } from "../storage/types.js";

/**
 * Merge status API — is each worktree branch merged into its target branch?
 * See docs/superpowers/specs/2026-07-12-branch-merge-status-design.md.
 */

async function getRemoteConfig(fastify: FastifyInstance, project: Project) {
  const remotes = await fastify.storage.projectRemotes.getByProject(project.id);
  if (remotes.length > 0) {
    const primary = remotes[0]; // sorted by sort_order
    return {
      serverId: primary.remote_server_id,
      url: primary.server_url ?? "",
      apiKey: primary.server_api_key ?? "",
      remotePath: primary.remote_path,
    };
  }
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

function sendComputed(reply: FastifyReply, repoPath: string, target?: string) {
  try {
    return reply.code(200).send(computeMergeStatus(repoPath, target));
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "Failed to compute merge status";
    return reply.code(statusCode).send({ error: message });
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Path-based: used as the proxy target by remote backends.
  fastify.get<{ Querystring: { path?: string; target?: string } }>(
    "/api/path/branches/merge-status",
    async (req, reply) => {
      const projectPath = req.query.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      return sendComputed(reply, projectPath, req.query.target || undefined);
    },
  );

  // Project-based: local computation or proxy to remote for remote-only projects.
  fastify.get<{ Params: { id: string }; Querystring: { target?: string } }>(
    "/api/projects/:id/branches/merge-status",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(req.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      if (!project.path) {
        const remoteConfig = await getRemoteConfig(fastify, project);
        if (!remoteConfig) {
          return reply.code(400).send({ error: "Project has no local path" });
        }
        const params = new URLSearchParams({ path: remoteConfig.remotePath });
        if (req.query.target) params.set("target", req.query.target);
        const result = await proxyToRemoteAuto(
          remoteConfig.serverId,
          remoteConfig.url,
          remoteConfig.apiKey,
          "GET",
          `/api/path/branches/merge-status?${params.toString()}`,
          undefined,
          { reverseConnectManager: fastify.reverseConnectManager },
        );
        return reply.code(proxyStatus(result)).send(result.data);
      }

      return sendComputed(reply, project.path, req.query.target || undefined);
    },
  );
};

export default fp(routes, { name: "merge-status-routes" });
