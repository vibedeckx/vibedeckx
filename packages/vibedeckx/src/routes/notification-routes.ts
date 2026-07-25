import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";

/** Bound on one page of the bell's hydration query. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const routes: FastifyPluginAsync = async (fastify) => {
  // Hydration: the browser's source of truth for the notification center.
  // SSE only tells it that a new row exists.
  fastify.get<{ Querystring: { unread?: string; limit?: string } }>(
    "/api/notifications",
    async (req, reply) => {
      const authResult = requireAuth(req, reply);
      if (authResult === null) return;
      const userId = resolveUserId(authResult);

      const requested = Number(req.query.limit);
      const limit = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_LIMIT)
        : DEFAULT_LIMIT;

      const notifications = await fastify.storage.notifications.listForUser(userId, {
        limit,
        unreadOnly: req.query.unread === "true",
      });
      return reply.code(200).send({ notifications });
    },
  );

  // Milestone ids are deterministic and therefore guessable. 404 covers both
  // "no such notification" and "not yours" so the response can't be used to
  // probe another tenant's inbox — the storage layer enforces the scope.
  fastify.patch<{ Params: { id: string } }>("/api/notifications/:id/read", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);

    const ok = await fastify.storage.notifications.markRead(req.params.id, userId);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return reply.code(200).send({ ok: true });
  });

  fastify.post("/api/notifications/read-all", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);

    await fastify.storage.notifications.markAllRead(userId);
    return reply.code(200).send({ ok: true });
  });
};

export default fp(routes, { name: "notification-routes" });
