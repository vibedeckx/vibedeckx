import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { RemoteServer, CrossRemoteAccess } from "../storage/types.js";
import { proxyToRemoteAuto, proxyStatus } from "../utils/remote-proxy.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import { fetchLatestPublishedVersion, compareVersionStrings } from "../update-check.js";
import { MIN_WORKER_VERSION } from "../constants.js";
import "../server-types.js";

function sanitizeServer(server: RemoteServer) {
  const { connect_token: _t, ...safe } = server;
  return safe;
}

export type WorkerUpdateStatus = "unreported" | "behind-min" | "behind-latest" | "current";

// npm-latest cache: successes are good for an hour, failures retried after
// five minutes so a registry blip doesn't hide the upgrade badge all day.
let npmLatestCache: { value: string | undefined; fetchedAt: number } | undefined;
let npmLatestRefreshInFlight = false;

/**
 * Non-blocking stale-while-revalidate: the list response must never wait on
 * the npm registry. An expired (or absent) cache serves what it has and kicks
 * off a background refresh — the settings UI polls every 15s, so the badge
 * appears one poll later.
 */
function getLatestWorkerVersion(): string | undefined {
  const ttlMs = npmLatestCache?.value !== undefined ? 60 * 60 * 1000 : 5 * 60 * 1000;
  const fresh = npmLatestCache !== undefined && Date.now() - npmLatestCache.fetchedAt < ttlMs;
  if (!fresh && !npmLatestRefreshInFlight) {
    npmLatestRefreshInFlight = true;
    void fetchLatestPublishedVersion()
      .then((value) => {
        npmLatestCache = { value, fetchedAt: Date.now() };
      })
      .finally(() => {
        npmLatestRefreshInFlight = false;
      });
  }
  return npmLatestCache?.value;
}

/** Test seam: preseed the npm-latest cache so route tests stay offline. */
export function primeNpmLatestCacheForTests(value: string | undefined): void {
  npmLatestCache = { value, fetchedAt: Date.now() };
}

/**
 * Phase 3 upgrade nudge (docs/server-worker-compat-design.md §2): advisory
 * only — nothing is rejected here. "current" also covers "can't judge"
 * (npm unreachable or unparseable version): no badge is better than a wrong one.
 */
export function workerUpdateStatus(
  workerVersion: string | undefined,
  latest: string | undefined,
): WorkerUpdateStatus {
  if (!workerVersion) return "unreported";
  const vsMin = compareVersionStrings(workerVersion, MIN_WORKER_VERSION);
  if (vsMin !== undefined && vsMin < 0) return "behind-min";
  const vsLatest = latest === undefined ? undefined : compareVersionStrings(workerVersion, latest);
  if (vsLatest !== undefined && vsLatest < 0) return "behind-latest";
  return "current";
}

const CROSS_REMOTE_ACCESS_VALUES: readonly CrossRemoteAccess[] = ["off", "read", "exec"];

const isCrossRemoteAccess = (value: unknown): value is CrossRemoteAccess =>
  typeof value === "string" && (CROSS_REMOTE_ACCESS_VALUES as readonly string[]).includes(value);

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/remote-servers — list all (api_key sanitized), each annotated
  // with the worker's upgrade status against MIN_WORKER_VERSION / npm latest.
  fastify.get("/api/remote-servers", async (request, reply) => {
    const userId = requireAuth(request, reply);
    if (userId === null) return;
    const servers = await fastify.storage.remoteServers.getAll(userId);
    const latest = getLatestWorkerVersion();
    return reply.send(servers.map((server) => ({
      ...sanitizeServer(server),
      latest_worker_version: latest,
      worker_update_status: workerUpdateStatus(server.worker_version, latest),
    })));
  });

  // POST /api/remote-servers — create (all servers connect inbound via reverse-connect)
  fastify.post("/api/remote-servers", async (request, reply) => {
    const userId = requireAuth(request, reply);
    if (userId === null) return;
    const { name } = request.body as { name: string };
    if (!name)
      return reply.code(400).send({ error: "name is required" });
    const server = await fastify.storage.remoteServers.create({ name }, userId);
    return reply.code(201).send(sanitizeServer(server));
  });

  // PUT /api/remote-servers/:id — update
  fastify.put<{ Params: { id: string } }>(
    "/api/remote-servers/:id",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const { name, crossRemoteAccess } = request.body as {
        name?: string;
        crossRemoteAccess?: string;
      };

      if (crossRemoteAccess !== undefined && !isCrossRemoteAccess(crossRemoteAccess)) {
        return reply.code(400).send({ error: "crossRemoteAccess must be one of: off, read, exec" });
      }

      const server = await fastify.storage.remoteServers.update(id, {
        name,
        cross_remote_access: crossRemoteAccess,
      }, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });
      return reply.send(sanitizeServer(server));
    }
  );

  // DELETE /api/remote-servers/:id — delete
  fastify.delete<{ Params: { id: string } }>(
    "/api/remote-servers/:id",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const deleted = await fastify.storage.remoteServers.delete(id, userId);
      if (!deleted)
        return reply.code(404).send({ error: "Server not found" });
      return reply.send({ success: true });
    }
  );

  // POST /api/remote-servers/:id/test — report reverse-connect status
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/test",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const server = await fastify.storage.remoteServers.getById(id, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });

      const connected = fastify.reverseConnectManager.isConnected(id);
      return reply.send({ success: connected, status: connected ? "online" : "offline" });
    }
  );

  // Derive the worker-facing server URL from the incoming request.
  const connectCommandFor = (request: FastifyRequest, token: string) => {
    const proto = request.headers["x-forwarded-proto"] || request.protocol || "http";
    const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
    return `npx vibedeckx@latest connect --connect-to ${proto}://${host} --token ${token}`;
  };

  // Shared body of the two connect-token endpoints: resolve the server, run the
  // supplied storage op, answer with the token plus a ready-to-paste command.
  const sendConnectToken = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    op: (id: string, userId?: string) => Promise<string | undefined>,
    failure: string
  ) => {
    const userId = requireAuth(request, reply);
    if (userId === null) return;
    const { id } = request.params;
    const server = await fastify.storage.remoteServers.getById(id, userId);
    if (!server) return reply.code(404).send({ error: "Server not found" });

    const token = await op(id, userId);
    if (!token) return reply.code(500).send({ error: failure });

    return reply.send({ token, connectCommand: connectCommandFor(request, token) });
  };

  // POST /api/remote-servers/:id/connect-token — read the connect token, minting
  // one on first use. Idempotent: an already-issued token is returned as-is so
  // re-opening the dialog can't strand a connected worker. POST rather than GET
  // because the first call writes, and a GET would put a secret-bearing URL into
  // proxy caches and access logs.
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/connect-token",
    (request, reply) =>
      sendConnectToken(
        request,
        reply,
        (id, userId) => fastify.storage.remoteServers.generateToken(id, userId),
        "Failed to read token"
      )
  );

  // POST /api/remote-servers/:id/connect-token/rotate — mint a replacement,
  // invalidating the old token immediately.
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/connect-token/rotate",
    (request, reply) =>
      sendConnectToken(
        request,
        reply,
        (id, userId) => fastify.storage.remoteServers.rotateToken(id, userId),
        "Failed to rotate token"
      )
  );

  // POST /api/remote-servers/:id/browse — browse directories on remote server
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/browse",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const { path: browsePath } = (request.body as { path?: string }) ?? {};
      const server = await fastify.storage.remoteServers.getById(id, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });

      try {
        const queryPath = browsePath ? `?path=${encodeURIComponent(browsePath)}` : "";
        const result = await proxyToRemoteAuto(
          id,
          "GET",
          `/api/browse${queryPath}`,
          undefined,
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        if (result.ok) {
          return reply.send(result.data);
        }
        return reply.code(502).send({ error: "Failed to browse remote directory", details: result.data });
      } catch (err) {
        return reply.code(502).send({ error: "Failed to browse remote directory" });
      }
    }
  );

  // POST /api/remote-servers/:id/mkdir — create a directory on the remote server
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/mkdir",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const { parentPath, name } =
        (request.body as { parentPath?: string; name?: string }) ?? {};
      const server = await fastify.storage.remoteServers.getById(id, userId);
      if (!server) return reply.code(404).send({ error: "Server not found" });

      try {
        const result = await proxyToRemoteAuto(
          id,
          "POST",
          "/api/mkdir",
          { parentPath, name },
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        return reply.code(proxyStatus(result)).send(result.data);
      } catch (err) {
        return reply.code(502).send({ error: "Failed to create remote directory" });
      }
    }
  );

  // DELETE /api/remote-servers/:id/connect-token — revoke the connect token and
  // drop any live tunnel using it. The next connect-token read mints a fresh one.
  fastify.delete<{ Params: { id: string } }>(
    "/api/remote-servers/:id/connect-token",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const server = await fastify.storage.remoteServers.getById(id, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });

      if (fastify.reverseConnectManager.isConnected(id)) {
        fastify.reverseConnectManager.unregisterConnection(id);
        await fastify.storage.remoteServers.updateStatus(id, "offline");
      }

      const revoked = await fastify.storage.remoteServers.revokeToken(id, userId);
      return reply.send({ success: revoked });
    }
  );
};

export default fp(routes, { name: "remote-server-routes" });
