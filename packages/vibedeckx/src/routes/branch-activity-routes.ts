import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { computeBranchActivity, type BranchActivityState } from "../branch-activity.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";
import "../server-types.js";

/**
 * Branch activity API — derived `idle | working | completed` per branch.
 * See plans/branch-activity-refactor.md.
 */

interface BranchActivityResponse {
  branches: Array<{
    branch: string | null;
    activity: BranchActivityState["activity"];
    since: number;
  }>;
}

function toResponse(map: Map<string, BranchActivityState>): BranchActivityResponse {
  return {
    branches: Array.from(map.entries()).map(([branch, state]) => ({
      branch: branch === "" ? null : branch,
      activity: state.activity,
      since: state.since,
    })),
  };
}

const routes: FastifyPluginAsync = async (fastify) => {
  function proxyAuto(
    remoteServerId: string,
    remoteUrl: string,
    remoteApiKey: string,
    method: string,
    apiPath: string,
    body?: unknown,
  ) {
    return proxyToRemoteAuto(remoteServerId, remoteUrl, remoteApiKey, method, apiPath, body, {
      reverseConnectManager: fastify.reverseConnectManager,
    });
  }

  // Path-based: used as the proxy target by remote backends.
  fastify.get<{ Querystring: { path?: string } }>(
    "/api/path/branches/activity",
    async (req, reply) => {
      const projectPath = req.query.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const project = fastify.storage.projects.getByPath(projectPath);
      if (!project) {
        // No project row yet — no activity to report.
        return reply.code(200).send({ branches: [] } satisfies BranchActivityResponse);
      }
      const sessions = fastify.storage.agentSessions.getByProjectId(project.id);
      return reply.code(200).send(toResponse(computeBranchActivity(sessions)));
    },
  );

  // Project-based: local DB or proxy to remote depending on project.agent_mode.
  fastify.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/branches/activity",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      if (project.agent_mode !== "local") {
        const remoteConfig = fastify.storage.projectRemotes.getByProjectAndServer(
          project.id, project.agent_mode,
        );
        if (!remoteConfig) {
          // Remote misconfigured — return empty so the sidebar just shows idle.
          return reply.code(200).send({ branches: [] } satisfies BranchActivityResponse);
        }
        const params = new URLSearchParams({ path: remoteConfig.remote_path });
        const result = await proxyAuto(
          project.agent_mode,
          remoteConfig.server_url ?? "",
          remoteConfig.server_api_key || "",
          "GET",
          `/api/path/branches/activity?${params.toString()}`,
        );
        if (!result.ok) {
          // Older remote backend may not have this endpoint yet — degrade
          // gracefully so the sidebar isn't broken during a partial rollout.
          if (result.status === 404) {
            return reply.code(200).send({ branches: [] } satisfies BranchActivityResponse);
          }
          return reply.code(result.status || 502).send(result.data);
        }
        return reply.code(200).send(result.data);
      }

      const sessions = fastify.storage.agentSessions.getByProjectId(project.id);
      return reply.code(200).send(toResponse(computeBranchActivity(sessions)));
    },
  );
};

export default fp(routes, { name: "branch-activity-routes" });
