import type { FastifyPluginAsync } from "fastify";
import "../server-types.js";

/**
 * Worker-side session inventory: every session id this machine holds for one
 * project. The hub's reconciliation pass diffs its mappings against this list
 * to converge after the worker's own retention sweep deleted sessions
 * (docs/plans/2026-08-08-session-retention.md §3.1).
 *
 * Contract, and the hub refuses to clean anything without it:
 *  - EVERY database row for the project — no sidebar-visibility filtering, no
 *    "has messages" test, no recency window. A missing id must mean deleted,
 *    nothing else.
 *  - `complete: true` is the worker asserting the list was not truncated. If
 *    this ever grows pagination, `complete` must stay false until the caller
 *    holds every page.
 *
 * Not the search catalog, which looks like the same data: that one only lists
 * sessions that already have at least one persisted conversation entry, so a
 * session created seconds ago is absent from it and would be reconciled away
 * as though it had been deleted.
 */
const sessionInventoryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { path?: string } }>(
    "/api/path/session-ids",
    async (req, reply) => {
      const projectPath = req.query.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const project = await fastify.storage.projects.getByPath(projectPath);
      // An unregistered path is legitimately an empty inventory, and it is
      // still a COMPLETE answer — a hub whose mappings point at a project this
      // worker no longer has should converge, not stall forever.
      if (!project) {
        return reply.code(200).send({ sessionIds: [], complete: true });
      }
      const sessionIds = await fastify.storage.agentSessions.listIdsByProject(project.id);
      return reply.code(200).send({ sessionIds, complete: true });
    },
  );

  // Retention holds (retention-holds.ts). Under /api/path/ for the same reason
  // as the inventory above: they are the hub's handle on its worker, and
  // server.ts 404s this prefix on anything that isn't a reverse-connect worker
  // — on a multi-tenant hub they would otherwise let any signed-in user list
  // held session ids and rewrite another tenant's holds.

  // Every session on this machine that has a hold, so the hub can recompute
  // each one and release holds whose schedules are gone.
  fastify.get("/api/path/retention-holds", async (_req, reply) => {
    return reply.code(200).send({ sessionIds: await fastify.storage.sessionRetentionHolds.listSessionIds() });
  });

  // The whole hold set of one session, replacing whatever it had.
  fastify.put<{
    Params: { sessionId: string };
    Body: { holds?: unknown };
  }>("/api/path/retention-holds/:sessionId", async (req, reply) => {
    const raw = req.body?.holds;
    const validPart = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
    if (!Array.isArray(raw) || raw.length > 1000
      || !raw.every((h) => h && typeof h === "object" && validPart(h.kind) && validPart(h.id))) {
      return reply.code(400).send({ error: "holds must be an array of { kind, id }" });
    }
    const session = await fastify.storage.agentSessions.getById(req.params.sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const holds = (raw as Array<{ kind: string; id: string }>).map((h) => ({ kind: h.kind, id: h.id }));
    await fastify.storage.sessionRetentionHolds.replace(req.params.sessionId, holds);
    return reply.code(204).send();
  });
};

export default sessionInventoryRoutes;
