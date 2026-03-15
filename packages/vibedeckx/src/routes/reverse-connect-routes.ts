import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // Must be registered after websocket plugin
  fastify.after(() => {
    // GET /api/reverse-connect?token=<token> — WebSocket upgrade for inbound remote nodes
    fastify.get<{ Querystring: { token?: string } }>(
      "/api/reverse-connect",
      { websocket: true },
      (socket, req) => {
        const token = (req.query as { token?: string }).token;
        if (!token) {
          socket.send(JSON.stringify({ error: "Token required" }));
          socket.close(4001, "Token required");
          return;
        }

        const server = fastify.storage.remoteServers.getByToken(token);
        if (!server) {
          socket.send(JSON.stringify({ error: "Invalid token" }));
          socket.close(4001, "Invalid token");
          return;
        }

        if (server.connection_mode !== "inbound") {
          socket.send(JSON.stringify({ error: "Server is not configured for inbound connections" }));
          socket.close(4001, "Not inbound");
          return;
        }

        console.log(`[ReverseConnect] Inbound connection from remote server: ${server.name} (${server.id})`);

        // Register the connection with the manager
        fastify.reverseConnectManager.registerConnection(server.id, socket as unknown as import("ws").default);

        // Update DB status
        fastify.storage.remoteServers.updateStatus(server.id, "online");
      }
    );
  });
};

export default fp(routes, { name: "reverse-connect-routes" });
