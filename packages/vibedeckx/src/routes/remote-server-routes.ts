import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { RemoteServer } from "../storage/types.js";
import { proxyToRemote } from "../utils/remote-proxy.js";
import "../server-types.js";

function sanitizeServer(server: RemoteServer) {
  const { api_key: _, ...safe } = server;
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
    const { name, url, apiKey } = request.body as {
      name: string;
      url: string;
      apiKey?: string;
    };
    if (!name || !url)
      return reply.code(400).send({ error: "name and url are required" });
    const existing = fastify.storage.remoteServers.getByUrl(url);
    if (existing)
      return reply
        .code(409)
        .send({ error: "A server with this URL already exists" });
    const server = fastify.storage.remoteServers.create({
      name,
      url,
      api_key: apiKey,
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
};

export default fp(routes, { name: "remote-server-routes" });
