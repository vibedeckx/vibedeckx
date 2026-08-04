import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { MIN_WORKER_VERSION, WORKER_VERSION_REPORTING_SINCE } from "../constants.js";
import { compareVersionStrings } from "../update-check.js";
import "../server-types.js";

// Operator-only fleet aggregates (docs/server-worker-compat-design.md §2
// Phase 3): version distribution, deploy blast radius, upgrade adoption.
// Deliberately NOT a user-facing API — it spans tenants — and deliberately
// aggregate-only: no server names, no user ids.

// Empty means unset, matching server.ts's gate — see the note there.
const API_KEY = process.env.VIBEDECKX_API_KEY || undefined;

const STALE_WORKER_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
// Phase 4 exit criteria (§2): enforcement may start only once unknown-version
// workers are a sliver of the connected fleet AND a full deprecation window
// has passed since workers could report at all.
const PHASE4_UNKNOWN_SHARE_MAX = 0.05;
const PHASE4_DEPRECATION_DAYS = 60;

/** SQLite datetime('now') → epoch ms ("YYYY-MM-DD HH:MM:SS", UTC). */
function parseDbTimestamp(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const ms = Date.parse(ts.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? undefined : ms;
}

function countByVersion(versions: Array<string | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const version of versions) {
    const key = version ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function oldestVersion(versions: string[]): string | undefined {
  let oldest: string | undefined;
  for (const version of versions) {
    if (oldest === undefined) {
      oldest = version;
      continue;
    }
    const cmp = compareVersionStrings(version, oldest);
    if (cmp !== undefined && cmp < 0) oldest = version;
  }
  return oldest;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/admin/worker-version-stats — operator gate, then aggregates.
  fastify.get("/api/admin/worker-version-stats", async (request, reply) => {
    // Operator = holder of the server-side API key (the middleware has already
    // rejected any non-matching header by this point), or the solo no-auth
    // deployment where the only user IS the operator. Clerk tenants never
    // qualify; 404 rather than 403 so the endpoint's existence isn't leaked.
    const apiKeyHeader = request.headers["x-vibedeckx-api-key"];
    const isOperator =
      (API_KEY !== undefined && apiKeyHeader !== undefined) ||
      (!fastify.authEnabled && API_KEY === undefined);
    if (!isOperator) return reply.code(404).send({ error: "Not found" });

    const now = Date.now();
    const servers = await fastify.storage.remoteServers.getAll();
    const connected = servers.filter((server) =>
      fastify.reverseConnectManager.isConnected(server.id));
    const everActive = servers.filter((server) => server.last_connected_at !== undefined);

    const connectedVersions = connected.map((server) => server.worker_version);
    const unknownConnected = connectedVersions.filter((v) => v === undefined).length;
    const unknownShareConnected =
      connected.length > 0 ? unknownConnected / connected.length : null;
    const daysSinceReporting = Math.floor(
      (now - Date.parse(WORKER_VERSION_REPORTING_SINCE)) / (24 * 60 * 60 * 1000));

    return reply.send({
      min_worker_version: MIN_WORKER_VERSION,
      reporting_since: WORKER_VERSION_REPORTING_SINCE,
      workers_total: servers.length,
      connected_workers: connected.length,
      // Two lenses on the distribution: _all accumulates dead rows forever
      // (abandoned trials), _connected is the one Phase 4 decisions use.
      versions_all: countByVersion(servers.map((server) => server.worker_version)),
      versions_connected: countByVersion(connectedVersions),
      oldest_connected_version: oldestVersion(
        connectedVersions.filter((v): v is string => v !== undefined)) ?? null,
      // Deploy blast radius: how many live tunnels a restart would sever, and
      // how many of those are mid-turn (the actual user harm — idle sessions
      // recover on reconnect).
      active_remote_sessions: fastify.remoteSessionMap.size,
      active_turns: await fastify.storage.searchCache.countRunningRemoteSessions(),
      // Upgrade-failure tripwire: workers that were active once but have been
      // offline > 7 days — the classic "daemon didn't come back" signature.
      stale_workers_7d: everActive.filter((server) => {
        if (fastify.reverseConnectManager.isConnected(server.id)) return false;
        const lastSeen = parseDbTimestamp(server.last_connected_at);
        return lastSeen !== undefined && now - lastSeen > STALE_WORKER_THRESHOLD_MS;
      }).length,
      phase4_ready: {
        unknown_share_connected: unknownShareConnected,
        unknown_share_max: PHASE4_UNKNOWN_SHARE_MAX,
        days_since_reporting_release: daysSinceReporting,
        deprecation_days: PHASE4_DEPRECATION_DAYS,
        verdict:
          unknownShareConnected !== null &&
          unknownShareConnected < PHASE4_UNKNOWN_SHARE_MAX &&
          daysSinceReporting >= PHASE4_DEPRECATION_DAYS,
      },
    });
  });
};

export default fp(routes, { name: "worker-stats-routes" });
