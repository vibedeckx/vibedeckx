import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { token?: string } }>("/api/events", async (req, reply) => {
    // SSE doesn't support Authorization headers, so verify token from query param
    if (fastify.authEnabled) {
      const apiKey = req.headers["x-vibedeckx-api-key"];
      if (!apiKey) {
        const token = req.query.token;
        if (!token) {
          return reply.code(401).send({ error: "Unauthorized" });
        }
        try {
          const { verifyToken } = await import("@clerk/backend");
          const payload = await verifyToken(token, {
            secretKey: process.env.CLERK_SECRET_KEY!,
          });
          if (!payload.sub) {
            return reply.code(401).send({ error: "Unauthorized" });
          }
        } catch {
          return reply.code(401).send({ error: "Unauthorized" });
        }
      }
    }

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
