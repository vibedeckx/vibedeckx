import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { RemoteServer } from "../storage/types.js";
import { proxyToRemote } from "../utils/remote-proxy.js";
import "../server-types.js";

function sanitizeServer(server: RemoteServer) {
  const { api_key: _, connect_token: _t, ...safe } = server;
  return safe;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/remote-servers — list all (api_key sanitized)
  fastify.get("/api/remote-servers", async (_request, reply) => {
    const servers = fastify.storage.remoteServers.getAll();
    return reply.send(servers.map(sanitizeServer));
  });

  // POST /api/remote-servers — create
  fastify.post("/api/remote-servers", async (request, reply) => {
    const { name, url, apiKey, connectionMode } = request.body as {
      name: string;
      url: string;
      apiKey?: string;
      connectionMode?: "outbound" | "inbound";
    };
    if (!name)
      return reply.code(400).send({ error: "name is required" });
    // URL is required for outbound, optional for inbound
    if (connectionMode !== "inbound" && !url)
      return reply.code(400).send({ error: "url is required for outbound servers" });
    if (url) {
      const existing = fastify.storage.remoteServers.getByUrl(url);
      if (existing)
        return reply
          .code(409)
          .send({ error: "A server with this URL already exists" });
    }
    const server = fastify.storage.remoteServers.create({
      name,
      url: url || "",
      api_key: apiKey,
      connection_mode: connectionMode,
    });
    return reply.code(201).send(sanitizeServer(server));
  });

  // PUT /api/remote-servers/:id — update
  fastify.put<{ Params: { id: string } }>(
    "/api/remote-servers/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { name, url, apiKey } = request.body as {
        name?: string;
        url?: string;
        apiKey?: string;
      };
      const server = fastify.storage.remoteServers.update(id, {
        name,
        url,
        api_key: apiKey,
      });
      if (!server)
        return reply.code(404).send({ error: "Server not found" });
      return reply.send(sanitizeServer(server));
    }
  );

  // DELETE /api/remote-servers/:id — delete
  fastify.delete<{ Params: { id: string } }>(
    "/api/remote-servers/:id",
    async (request, reply) => {
      const { id } = request.params;
      const deleted = fastify.storage.remoteServers.delete(id);
      if (!deleted)
        return reply.code(404).send({ error: "Server not found" });
      return reply.send({ success: true });
    }
  );

  // POST /api/remote-servers/:id/test — test connection
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/test",
    async (request, reply) => {
      const { id } = request.params;
      const server = fastify.storage.remoteServers.getById(id);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });

      // For inbound servers, check if reverse-connected
      if (server.connection_mode === "inbound") {
        const connected = fastify.reverseConnectManager.isConnected(id);
        return reply.send({ success: connected, status: connected ? "online" : "offline" });
      }

      try {
        const result = await proxyToRemote(
          server.url,
          server.api_key ?? "",
          "GET",
          "/api/projects"
        );
        if (result.ok)
          return reply.send({ success: true });
        return reply
          .code(502)
          .send({ error: "Connection failed", details: result.data });
      } catch (err) {
        return reply.code(502).send({ error: "Connection failed" });
      }
    }
  );

  // POST /api/remote-servers/:id/generate-token — generate a connect token for inbound servers
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/generate-token",
    async (request, reply) => {
      const { id } = request.params;
      const server = fastify.storage.remoteServers.getById(id);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });
      if (server.connection_mode !== "inbound")
        return reply.code(400).send({ error: "Token generation is only available for inbound servers" });

      const token = fastify.storage.remoteServers.generateToken(id);
      if (!token)
        return reply.code(500).send({ error: "Failed to generate token" });

      // Build connect command for convenience
      const connectCommand = `vibedeckx connect --connect-to <server-url> --token ${token}`;
      return reply.send({ token, connectCommand });
    }
  );

  // POST /api/remote-servers/:id/revoke-token — revoke connect token and disconnect
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/revoke-token",
    async (request, reply) => {
      const { id } = request.params;
      const server = fastify.storage.remoteServers.getById(id);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });

      // Disconnect active reverse connection
      if (fastify.reverseConnectManager.isConnected(id)) {
        fastify.reverseConnectManager.unregisterConnection(id);
        fastify.storage.remoteServers.updateStatus(id, "offline");
      }

      const revoked = fastify.storage.remoteServers.revokeToken(id);
      return reply.send({ success: revoked });
    }
  );
};

export default fp(routes, { name: "remote-server-routes" });
