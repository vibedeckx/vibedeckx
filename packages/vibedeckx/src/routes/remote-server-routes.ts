import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { RemoteServer, CrossRemoteAccess } from "../storage/types.js";
import { proxyToRemoteAuto, proxyStatus } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";
import "../server-types.js";

function sanitizeServer(server: RemoteServer) {
  const { connect_token: _t, ...safe } = server;
  return safe;
}

const CROSS_REMOTE_ACCESS_VALUES: readonly CrossRemoteAccess[] = ["off", "read", "exec"];

const isCrossRemoteAccess = (value: unknown): value is CrossRemoteAccess =>
  typeof value === "string" && (CROSS_REMOTE_ACCESS_VALUES as readonly string[]).includes(value);

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/remote-servers — list all (api_key sanitized)
  fastify.get("/api/remote-servers", async (request, reply) => {
    const userId = requireAuth(request, reply);
    if (userId === null) return;
    const servers = await fastify.storage.remoteServers.getAll(userId);
    return reply.send(servers.map(sanitizeServer));
  });

  // POST /api/remote-servers — create (all servers connect inbound via reverse-connect)
  fastify.post("/api/remote-servers", async (request, reply) => {
    const userId = requireAuth(request, reply);
    if (userId === null) return;
    const { name } = request.body as { name: string };
    if (!name)
      return reply.code(400).send({ error: "name is required" });
    const server = await fastify.storage.remoteServers.create({ name }, userId);
    return reply.code(201).send(sanitizeServer(server));
  });

  // PUT /api/remote-servers/:id — update
  fastify.put<{ Params: { id: string } }>(
    "/api/remote-servers/:id",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const { name, crossRemoteAccess } = request.body as {
        name?: string;
        crossRemoteAccess?: string;
      };

      if (crossRemoteAccess !== undefined && !isCrossRemoteAccess(crossRemoteAccess)) {
        return reply.code(400).send({ error: "crossRemoteAccess must be one of: off, read, exec" });
      }

      const server = await fastify.storage.remoteServers.update(id, {
        name,
        cross_remote_access: crossRemoteAccess,
      }, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });
      return reply.send(sanitizeServer(server));
    }
  );

  // DELETE /api/remote-servers/:id — delete
  fastify.delete<{ Params: { id: string } }>(
    "/api/remote-servers/:id",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const deleted = await fastify.storage.remoteServers.delete(id, userId);
      if (!deleted)
        return reply.code(404).send({ error: "Server not found" });
      return reply.send({ success: true });
    }
  );

  // POST /api/remote-servers/:id/test — report reverse-connect status
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/test",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const server = await fastify.storage.remoteServers.getById(id, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });

      const connected = fastify.reverseConnectManager.isConnected(id);
      return reply.send({ success: connected, status: connected ? "online" : "offline" });
    }
  );

  // POST /api/remote-servers/:id/generate-token — generate a connect token for inbound servers
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/generate-token",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const server = await fastify.storage.remoteServers.getById(id, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });

      const token = await fastify.storage.remoteServers.generateToken(id, userId);
      if (!token)
        return reply.code(500).send({ error: "Failed to generate token" });

      // Derive server URL from the incoming request
      const proto = request.headers["x-forwarded-proto"] || request.protocol || "http";
      const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
      const serverUrl = `${proto}://${host}`;
      const connectCommand = `npx vibedeckx@latest connect --connect-to ${serverUrl} --token ${token}`;
      return reply.send({ token, connectCommand });
    }
  );

  // POST /api/remote-servers/:id/browse — browse directories on remote server
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/browse",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const { path: browsePath } = (request.body as { path?: string }) ?? {};
      const server = await fastify.storage.remoteServers.getById(id, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });

      try {
        const queryPath = browsePath ? `?path=${encodeURIComponent(browsePath)}` : "";
        const result = await proxyToRemoteAuto(
          id,
          "GET",
          `/api/browse${queryPath}`,
          undefined,
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        if (result.ok) {
          return reply.send(result.data);
        }
        return reply.code(502).send({ error: "Failed to browse remote directory", details: result.data });
      } catch (err) {
        return reply.code(502).send({ error: "Failed to browse remote directory" });
      }
    }
  );

  // POST /api/remote-servers/:id/mkdir — create a directory on the remote server
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/mkdir",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const { parentPath, name } =
        (request.body as { parentPath?: string; name?: string }) ?? {};
      const server = await fastify.storage.remoteServers.getById(id, userId);
      if (!server) return reply.code(404).send({ error: "Server not found" });

      try {
        const result = await proxyToRemoteAuto(
          id,
          "POST",
          "/api/mkdir",
          { parentPath, name },
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        return reply.code(proxyStatus(result)).send(result.data);
      } catch (err) {
        return reply.code(502).send({ error: "Failed to create remote directory" });
      }
    }
  );

  // POST /api/remote-servers/:id/revoke-token — revoke connect token and disconnect
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/revoke-token",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const server = await fastify.storage.remoteServers.getById(id, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });

      if (fastify.reverseConnectManager.isConnected(id)) {
        fastify.reverseConnectManager.unregisterConnection(id);
        await fastify.storage.remoteServers.updateStatus(id, "offline");
      }

      const revoked = await fastify.storage.remoteServers.revokeToken(id, userId);
      return reply.send({ success: revoked });
    }
  );
};

export default fp(routes, { name: "remote-server-routes" });
