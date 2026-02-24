import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send initial keepalive
    reply.raw.write(":ok\n\n");

    // Subscribe to all events
    const unsubscribe = fastify.eventBus.subscribe((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Keepalive every 15 seconds
    const keepalive = setInterval(() => {
      reply.raw.write(":keepalive\n\n");
    }, 15000);

    // Cleanup on client disconnect
    req.raw.on("close", () => {
      unsubscribe();
      clearInterval(keepalive);
    });

    // Prevent Fastify from sending a response (we're handling it raw)
    await reply;
  });
};

export default fp(routes, { name: "event-routes" });
