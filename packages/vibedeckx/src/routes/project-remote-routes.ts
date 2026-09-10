import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { ProjectRemoteWithServer } from "../storage/types.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { registerReportedWorktrees, type ReportedWorktree } from "../workspace-binding-backfill.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import "../server-types.js";

function sanitizeProjectRemote(pr: ProjectRemoteWithServer) {
  return pr;
}

/** Ceiling on how long linking waits for the new remote's worktree list. */
const LINK_SYNC_TIMEOUT_MS = 10_000;

/**
 * Register a just-linked remote's worktree list, so its per-workspace state
 * is known from the start instead of "unknown" until it is listed. Offline
 * or old workers simply leave it unconfirmed; the link itself has already
 * succeeded, so nothing here may fail it.
 */
async function syncLinkedRemoteWorktrees(
  fastify: FastifyInstance,
  projectId: string,
  remote: { remote_server_id: string; remote_path: string },
): Promise<void> {
  try {
    const result = await proxyToRemoteAuto(
      remote.remote_server_id,
      "GET",
      `/api/path/worktrees?path=${encodeURIComponent(remote.remote_path)}`,
      undefined,
      { reverseConnectManager: fastify.reverseConnectManager, timeoutMs: LINK_SYNC_TIMEOUT_MS },
    );
    if (!result.ok) return;
    const worktrees = (result.data as { worktrees?: ReportedWorktree[] } | undefined)?.worktrees;
    if (!Array.isArray(worktrees)) return;
    await registerReportedWorktrees(fastify.storage, {
      projectId,
      targetId: remote.remote_server_id,
      remotePath: remote.remote_path,
      worktrees,
    });
    await fastify.storage.projectRemotes.markWorktreesSynced(projectId, remote.remote_server_id);
  } catch (error) {
    console.warn(`[ProjectRemotes] Worktree sync after linking ${remote.remote_server_id} failed:`, error);
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects/:id/remotes — list all remotes for a project (api_key sanitized)
  fastify.get<{ Params: { id: string } }>(
    "/api/projects/:id/remotes",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const { id } = request.params;
      const project = await fastify.storage.projects.getById(id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });
      const remotes = await fastify.storage.projectRemotes.getByProject(id);
      return reply.send(remotes.map(sanitizeProjectRemote));
    }
  );

  // POST /api/projects/:id/remotes — add a remote to a project
  fastify.post<{ Params: { id: string } }>(
    "/api/projects/:id/remotes",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const { id } = request.params;
      const { remoteServerId, remotePath, sortOrder } =
        request.body as {
          remoteServerId: string;
          remotePath: string;
          sortOrder?: number;
        };

      if (!remoteServerId || !remotePath)
        return reply
          .code(400)
          .send({ error: "remoteServerId and remotePath are required" });

      const project = await fastify.storage.projects.getById(id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });

      const server = await fastify.storage.remoteServers.getById(remoteServerId, userId);
      if (!server)
        return reply.code(404).send({ error: "Remote server not found" });

      const existing = await fastify.storage.projectRemotes.getByProjectAndServer(
        id,
        remoteServerId
      );
      if (existing)
        return reply
          .code(409)
          .send({ error: "This remote server is already associated with the project" });

      const projectRemote = await fastify.storage.projectRemotes.add({
        project_id: id,
        remote_server_id: remoteServerId,
        remote_path: remotePath,
        sort_order: sortOrder,
      });
      await syncLinkedRemoteWorktrees(fastify, id, projectRemote);
      return reply.code(201).send(
        // The sync may have just confirmed the remote; answer with that.
        (await fastify.storage.projectRemotes.getByProjectAndServer(id, remoteServerId)) ?? projectRemote,
      );
    }
  );

  // PUT /api/projects/:id/remotes/:rid — update a project-remote association
  fastify.put<{ Params: { id: string; rid: string } }>(
    "/api/projects/:id/remotes/:rid",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(request.params.id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });

      const { rid } = request.params;
      const { remotePath, sortOrder } =
        request.body as {
          remotePath?: string;
          sortOrder?: number;
        };

      const updated = await fastify.storage.projectRemotes.update(rid, {
        remote_path: remotePath,
        sort_order: sortOrder,
      }, project.id);
      if (!updated)
        return reply.code(404).send({ error: "Project remote not found" });
      return reply.send(updated);
    }
  );

  // POST /api/projects/:id/remotes/:rid/primary — promote a project remote
  fastify.post<{ Params: { id: string; rid: string } }>(
    "/api/projects/:id/remotes/:rid/primary",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(request.params.id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });

      const promoted = await fastify.storage.projectRemotes.setPrimary(
        project.id,
        request.params.rid,
      );
      if (!promoted)
        return reply.code(404).send({ error: "Project remote not found" });
      return reply.send({ success: true });
    },
  );

  // DELETE /api/projects/:id/remotes/:rid — remove a remote from a project
  fastify.delete<{ Params: { id: string; rid: string } }>(
    "/api/projects/:id/remotes/:rid",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(request.params.id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });

      const { rid } = request.params;
      const removed = await fastify.storage.projectRemotes.remove(rid, project.id);
      if (!removed)
        return reply.code(404).send({ error: "Project remote not found" });
      return reply.send({ success: true });
    }
  );
};

export default fp(routes, { name: "project-remote-routes" });
