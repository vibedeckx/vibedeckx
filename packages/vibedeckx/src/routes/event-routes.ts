import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { GlobalEvent } from "../event-bus.js";
import { EventFanout } from "../event-fanout.js";
import { CLERK_CLOCK_SKEW_MS } from "./ws-authz.js";
import "../server-types.js";

// tailOutput/finalResult carry raw process output (stdout/stderr/PTY tail and
// the agent's final message) for in-process consumers (chat-session-manager,
// scheduler) only — never expose them over the wire.
function toWireEvent(event: GlobalEvent): GlobalEvent {
  if (event.type === "executor:stopped" && (event.tailOutput !== undefined || event.finalResult !== undefined)) {
    const { tailOutput: _tailOutput, finalResult: _finalResult, ...rest } = event;
    return rest;
  }
  return event;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // One bus subscription for all SSE connections; the fanout resolves each
  // project's owner once and writes only to that owner's connections.
  const fanout = new EventFanout({
    getOwnerId: (projectId) => fastify.storage.projects.getOwnerId(projectId),
    onError: (err) => {
      console.error(`[EventsSSE] Failed to route/write event:`, err);
    },
  });
  const unsubscribeBus = fastify.eventBus.subscribe((event) => fanout.dispatch(event));
  fastify.addHook("onClose", async () => {
    unsubscribeBus();
  });

  fastify.get<{ Querystring: { token?: string } }>("/api/events", async (req, reply) => {
    // Tenant scope for event filtering: null means no-auth solo mode, which sees
    // all events; a Clerk userId only receives events for projects it owns.
    // VIBEDECKX_API_KEY confers no identity here — it only gates the door — so an
    // API-key-locked server under Clerk still requires a session token.
    let userId: string | null = null;

    // SSE doesn't support Authorization headers, so verify token from query param
    if (fastify.authEnabled) {
      const token = req.query.token;
      if (!token) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      try {
        const { verifyToken } = await import("@clerk/backend");
        const payload = await verifyToken(token, {
          secretKey: process.env.CLERK_SECRET_KEY!,
          clockSkewInMs: CLERK_CLOCK_SKEW_MS,
        });
        if (!payload.sub) {
          return reply.code(401).send({ error: "Unauthorized" });
        }
        userId = payload.sub;
      } catch (err) {
        // Preserve Clerk's reason (clock-skew hook for B) — see ws-authz.ts.
        const reason = (err as { reason?: string })?.reason;
        if (reason) console.log(`[EventsSSE] token verification failed: ${reason}`);
        return reply.code(401).send({ error: "Unauthorized" });
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

    // Handshake frame. Carries the build fingerprint of the UI bundle this
    // server is serving so a long-lived tab can detect version skew the moment
    // it (re)connects — a deploy is a restart, so the SSE reconnect is exactly
    // when a new build becomes visible. Additive: consumers filter by `type`,
    // old UIs ignore it. `uiBuildId` is omitted in API-only mode or for a
    // pre-build-id UI bundle; clients treat its absence as "check unavailable".
    reply.raw.write(
      `data: ${JSON.stringify({ type: "hello", ...(fastify.uiBuildId ? { uiBuildId: fastify.uiBuildId } : {}) })}\n\n`,
    );

    // Every GlobalEvent carries a projectId; Clerk users only see events for
    // projects they own. Trusted principals (userId === null) see everything.
    const unsubscribe = fanout.add(userId, (event) => {
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
