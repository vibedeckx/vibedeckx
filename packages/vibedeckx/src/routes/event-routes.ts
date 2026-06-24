import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { GlobalEvent } from "../event-bus.js";
import "../server-types.js";

// tailOutput carries raw process output (stdout/stderr/PTY tail) for the
// in-process chat-session-manager consumer only — never expose it over the wire.
function toWireEvent(event: GlobalEvent): GlobalEvent {
  if (event.type === "executor:stopped" && event.tailOutput !== undefined) {
    const { tailOutput: _tailOutput, ...rest } = event;
    return rest;
  }
  return event;
}

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { token?: string } }>("/api/events", async (req, reply) => {
    // Tenant scope for event filtering: null means a trusted principal (no-auth
    // solo mode, or a validated API-key proxy connection) that sees all events;
    // a Clerk userId only receives events for projects it owns.
    let userId: string | null = null;

    // SSE doesn't support Authorization headers, so verify token from query param
    if (fastify.authEnabled) {
      // Skip Clerk only when VIBEDECKX_API_KEY is configured AND the header is
      // present — the global API-key middleware has by then rejected any header
      // that doesn't match, so a present header is the validated key. When the
      // env var is unset the header is unvalidated and must NOT bypass Clerk —
      // otherwise any value authenticates.
      const apiKey = req.headers["x-vibedeckx-api-key"];
      if (!(process.env.VIBEDECKX_API_KEY && apiKey)) {
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
          userId = payload.sub;
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

    // Subscribe to all events, filtered to the subscriber's tenant
    const unsubscribe = fastify.eventBus.subscribe((event) => {
      // Every GlobalEvent carries a projectId; Clerk users only see events for
      // projects they own. Trusted principals (userId === null) see everything.
      if (userId !== null && !fastify.storage.projects.getById(event.projectId, userId)) {
        return;
      }
      reply.raw.write(`data: ${JSON.stringify(toWireEvent(event))}\n\n`);
    });

    // Heartbeat every 15 seconds. A real `data:` event (not an SSE comment) so
    // the browser surfaces it to EventSource.onmessage — letting the client
    // detect a silently-dead ("zombie") connection by the *absence* of pings,
    // which a comment-line keepalive can't do (EventSource never delivers
    // comments). Consumers filter by their own `type`, so a `ping` is ignored.
    const keepalive = setInterval(() => {
      reply.raw.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
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
