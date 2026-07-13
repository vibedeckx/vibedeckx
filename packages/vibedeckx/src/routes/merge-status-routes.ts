import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { computeMergeStatusPairs, type MergeComparison } from "../merge-status.js";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";
import "../server-types.js";
import type { Project } from "../storage/types.js";

/**
 * Merge status API — is each worktree branch merged into its target branch?
 * See docs/superpowers/specs/2026-07-12-branch-merge-status-design.md.
 */

export type MergeStatusRepository =
  | { kind: "local"; label: "Local" }
  | { kind: "remote"; remoteServerId: string; label: string };

function legacyRemoteLabel(remoteUrl: string): string {
  try {
    return new URL(remoteUrl).hostname;
  } catch {
    return "Remote";
  }
}

async function getRemoteConfig(fastify: FastifyInstance, project: Project) {
  const remotes = await fastify.storage.projectRemotes.getByProject(project.id);
  if (remotes.length > 0) {
    const primary = remotes[0]; // sorted by sort_order
    return {
      serverId: primary.remote_server_id,
      url: primary.server_url ?? "",
      apiKey: primary.server_api_key ?? "",
      remotePath: primary.remote_path,
      serverName: primary.server_name,
    };
  }
  if (project.remote_url && project.remote_api_key && project.remote_path) {
    return {
      serverId: "",
      url: project.remote_url,
      apiKey: project.remote_api_key,
      remotePath: project.remote_path,
      serverName: legacyRemoteLabel(project.remote_url),
    };
  }
  return null;
}

const MAX_COMPARISONS = 50;

/** Returns validated comparisons, or null when the body is malformed. */
function parseComparisons(body: unknown): MergeComparison[] | null {
  if (!body || typeof body !== "object") return null;
  const comparisons = (body as { comparisons?: unknown }).comparisons;
  if (!Array.isArray(comparisons) || comparisons.length > MAX_COMPARISONS) return null;
  const result: MergeComparison[] = [];
  for (const item of comparisons) {
    if (!item || typeof item !== "object") return null;
    const branch = (item as { branch?: unknown }).branch;
    const target = (item as { target?: unknown }).target;
    if (typeof branch !== "string" || !branch) return null;
    if (target !== undefined && (typeof target !== "string" || !target)) return null;
    result.push(target === undefined ? { branch } : { branch, target });
  }
  return result;
}

function sendComputed(
  reply: FastifyReply,
  repoPath: string,
  comparisons: MergeComparison[],
  repository?: MergeStatusRepository,
) {
  try {
    return reply.code(200).send({
      ...(repository ? { repository } : {}),
      entries: computeMergeStatusPairs(repoPath, comparisons),
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "Failed to compute merge status";
    return reply.code(statusCode).send({ error: message });
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Path-based: used as the proxy target by remote backends.
  fastify.post<{ Body: { path?: string; comparisons?: unknown } }>(
    "/api/path/branches/merge-status",
    async (req, reply) => {
      const projectPath = req.body?.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const comparisons = parseComparisons(req.body);
      if (!comparisons) {
        return reply.code(400).send({ error: "Invalid comparisons" });
      }
      return sendComputed(reply, projectPath, comparisons);
    },
  );

  // Project-based: local computation or proxy to remote for remote-only projects.
  fastify.post<{ Params: { id: string }; Body: { comparisons?: unknown } }>(
    "/api/projects/:id/branches/merge-status",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(req.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const comparisons = parseComparisons(req.body);
      if (!comparisons) {
        return reply.code(400).send({ error: "Invalid comparisons" });
      }

      if (!project.path) {
        const remoteConfig = await getRemoteConfig(fastify, project);
        if (!remoteConfig) {
          return reply.code(400).send({ error: "Project has no local path" });
        }
        const result = await proxyToRemoteAuto(
          remoteConfig.serverId,
          remoteConfig.url,
          remoteConfig.apiKey,
          "POST",
          "/api/path/branches/merge-status",
          { path: remoteConfig.remotePath, comparisons },
          { reverseConnectManager: fastify.reverseConnectManager },
        );
        if (!result.ok) {
          return reply.code(proxyStatus(result)).send(result.data);
        }
        const data = result.data as { entries?: unknown };
        return reply.code(200).send({
          repository: {
            kind: "remote",
            remoteServerId: remoteConfig.serverId,
            label: remoteConfig.serverName,
          } satisfies MergeStatusRepository,
          entries: data.entries ?? [],
        });
      }

      return sendComputed(
        reply,
        project.path,
        comparisons,
        { kind: "local", label: "Local" },
      );
    },
  );
};

export default fp(routes, { name: "merge-status-routes" });
