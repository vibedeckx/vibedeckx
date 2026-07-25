import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import type { NotificationOutboxEvent } from "../storage/types.js";
import "../server-types.js";

/**
 * Machine-facing cursor API over this server's milestone outbox.
 *
 * A user-facing front server pulls it through `proxyToRemoteAuto`, so the same
 * route serves both direct-HTTP and reverse-connect workers. Authentication is
 * the existing API-key / reverse-connect trust boundary — this endpoint adds no
 * boundary of its own, it just refuses to be a browser-reachable oracle when
 * Clerk auth is on.
 *
 * Sessions must be requested EXPLICITLY. The worker never volunteers its session
 * list, so a front can only ever learn about sessions it already has a persisted
 * mapping for.
 */

/** Bounds so one request can't turn into an unbounded scan. */
export const MAX_SESSIONS_PER_REQUEST = 100;
export const MAX_EVENTS_PER_SESSION = 100;

interface SessionRequest {
  sessionId: string;
  after: number;
  /**
   * Baseline-only: return `headCursor` with no event payloads. Lets a
   * newly-discovered historical session establish "start from now" without
   * replaying — or sounding — months of old milestones.
   */
  headOnly?: boolean;
}

interface QueryBody {
  sessions?: unknown;
  limitPerSession?: unknown;
}

type Validated = { ok: true; sessions: SessionRequest[]; limit: number } | { ok: false; error: string };

export function validateOutboxQuery(body: QueryBody): Validated {
  const raw = body?.sessions;
  if (!Array.isArray(raw)) return { ok: false, error: "sessions must be an array" };
  if (raw.length === 0) return { ok: false, error: "sessions must not be empty" };
  if (raw.length > MAX_SESSIONS_PER_REQUEST) {
    return { ok: false, error: `sessions must contain at most ${MAX_SESSIONS_PER_REQUEST} entries` };
  }

  const seen = new Set<string>();
  const sessions: SessionRequest[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, error: "each session must be an object" };
    const { sessionId, after, headOnly } = entry as Record<string, unknown>;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { ok: false, error: "sessionId must be a non-empty string" };
    }
    if (typeof after !== "number" || !Number.isInteger(after) || after < 0) {
      return { ok: false, error: "after must be a non-negative integer" };
    }
    if (headOnly !== undefined && typeof headOnly !== "boolean") {
      return { ok: false, error: "headOnly must be a boolean" };
    }
    // Duplicates would make the response ambiguous about which cursor produced
    // which page — reject rather than silently picking one.
    if (seen.has(sessionId)) return { ok: false, error: `duplicate sessionId: ${sessionId}` };
    seen.add(sessionId);
    sessions.push({ sessionId, after, ...(headOnly ? { headOnly: true } : {}) });
  }

  const rawLimit = body?.limitPerSession;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit <= 0) {
      return { ok: false, error: "limitPerSession must be a positive integer" };
    }
    if (rawLimit > MAX_EVENTS_PER_SESSION) {
      return { ok: false, error: `limitPerSession must be at most ${MAX_EVENTS_PER_SESSION}` };
    }
  }

  return {
    ok: true,
    sessions,
    limit: typeof rawLimit === "number" ? rawLimit : MAX_EVENTS_PER_SESSION,
  };
}

interface SessionResult {
  sessionId: string;
  events: NotificationOutboxEvent[];
  /** Highest seq this session has, so a caller can tell how far behind it is. */
  headCursor: number;
  /** Resume point: the last RETURNED row, or `after` when nothing was returned. */
  nextCursor: number;
  hasMore: boolean;
}

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: QueryBody }>("/api/notification-outbox/query", async (req, reply) => {
    // When Clerk auth is on, an API-key/reverse-connect caller short-circuits
    // inside requireAuth; a browser without an identity gets 401 here.
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;

    const validated = validateOutboxQuery(req.body ?? {});
    if (!validated.ok) return reply.code(400).send({ error: validated.error });

    const sessions: SessionResult[] = [];
    for (const request of validated.sessions) {
      const headCursor = await fastify.storage.notificationOutbox.headBySession(request.sessionId);
      if (request.headOnly) {
        sessions.push({
          sessionId: request.sessionId,
          events: [],
          headCursor,
          nextCursor: headCursor,
          hasMore: false,
        });
        continue;
      }

      const events = await fastify.storage.notificationOutbox.listBySessionAfter(
        request.sessionId,
        request.after,
        validated.limit,
      );
      const nextCursor = events.length > 0 ? events[events.length - 1].seq : request.after;
      sessions.push({
        sessionId: request.sessionId,
        events,
        headCursor,
        nextCursor,
        hasMore: nextCursor < headCursor,
      });
    }

    return reply.code(200).send({ sessions });
  });
};

export default fp(routes, { name: "notification-outbox-routes" });
