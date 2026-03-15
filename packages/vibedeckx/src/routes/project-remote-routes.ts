import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { ProjectRemoteWithServer, SyncButtonConfig } from "../storage/types.js";
import { requireAuth } from "../server.js";
import "../server-types.js";

function sanitizeProjectRemote(pr: ProjectRemoteWithServer) {
  const { server_api_key: _, ...safe } = pr;
  return safe;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects/:id/remotes — list all remotes for a project (api_key sanitized)
  fastify.get<{ Params: { id: string } }>(
    "/api/projects/:id/remotes",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const { id } = request.params;
      const project = fastify.storage.projects.getById(id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });
      const remotes = fastify.storage.projectRemotes.getByProject(id);
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
      const { remoteServerId, remotePath, sortOrder, syncUpConfig, syncDownConfig } =
        request.body as {
          remoteServerId: string;
          remotePath: string;
          sortOrder?: number;
          syncUpConfig?: SyncButtonConfig;
          syncDownConfig?: SyncButtonConfig;
        };

      if (!remoteServerId || !remotePath)
        return reply
          .code(400)
          .send({ error: "remoteServerId and remotePath are required" });

      const project = fastify.storage.projects.getById(id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });

      const server = fastify.storage.remoteServers.getById(remoteServerId, userId);
      if (!server)
        return reply.code(404).send({ error: "Remote server not found" });

      const existing = fastify.storage.projectRemotes.getByProjectAndServer(
        id,
        remoteServerId
      );
      if (existing)
        return reply
          .code(409)
          .send({ error: "This remote server is already associated with the project" });

      const projectRemote = fastify.storage.projectRemotes.add({
        project_id: id,
        remote_server_id: remoteServerId,
        remote_path: remotePath,
        sort_order: sortOrder,
        sync_up_config: syncUpConfig,
        sync_down_config: syncDownConfig,
      });
      return reply.code(201).send(projectRemote);
    }
  );

  // PUT /api/projects/:id/remotes/:rid — update a project-remote association
  fastify.put<{ Params: { id: string; rid: string } }>(
    "/api/projects/:id/remotes/:rid",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const { rid } = request.params;
      const { remotePath, sortOrder, syncUpConfig, syncDownConfig } =
        request.body as {
          remotePath?: string;
          sortOrder?: number;
          syncUpConfig?: SyncButtonConfig | null;
          syncDownConfig?: SyncButtonConfig | null;
        };

      const updated = fastify.storage.projectRemotes.update(rid, {
        remote_path: remotePath,
        sort_order: sortOrder,
        sync_up_config: syncUpConfig,
        sync_down_config: syncDownConfig,
      });
      if (!updated)
        return reply.code(404).send({ error: "Project remote not found" });
      return reply.send(updated);
    }
  );

  // DELETE /api/projects/:id/remotes/:rid — remove a remote from a project
  fastify.delete<{ Params: { id: string; rid: string } }>(
    "/api/projects/:id/remotes/:rid",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const { rid } = request.params;
      const removed = fastify.storage.projectRemotes.remove(rid);
      if (!removed)
        return reply.code(404).send({ error: "Project remote not found" });
      return reply.send({ success: true });
    }
  );
};

export default fp(routes, { name: "project-remote-routes" });
