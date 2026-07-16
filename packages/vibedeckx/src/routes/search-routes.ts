import type { FastifyPluginAsync } from "fastify";
import { buildSearchCatalog } from "../search/catalog.js";
import { createSearchRefresher, listSearchTargets, computeCacheState, type SearchTarget } from "../search/refresh.js";
import type { SearchCatalogSessionEntry } from "../storage/types.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";

const searchRoutes: FastifyPluginAsync = async (fastify) => {
  // Worker-side (also served locally in solo mode): full project catalog for
  // search-cache refresh. Reached through the remote proxy like the other
  // /api/path/* provider routes.
  fastify.get<{ Querystring: { path?: string } }>(
    "/api/path/search-catalog",
    async (req, reply) => {
      const projectPath = req.query.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const project = await fastify.storage.projects.getByPath(projectPath);
      if (!project) {
        return reply.code(200).send({ snapshotAt: Date.now(), workspaces: [], sessions: [] });
      }
      try {
        const catalog = await buildSearchCatalog(
          {
            storage: fastify.storage,
            getProcessAlive: (id) => fastify.agentSessionManager.getSessionProcessAlive(id),
          },
          project.id,
          projectPath,
        );
        return reply.code(200).send(catalog);
      } catch (error) {
        return reply.code(500).send({ error: String(error) });
      }
    },
  );

  const refresher = createSearchRefresher({
    storage: fastify.storage,
    buildLocalCatalog: (projectId, projectPath) =>
      buildSearchCatalog(
        {
          storage: fastify.storage,
          getProcessAlive: (id) => fastify.agentSessionManager.getSessionProcessAlive(id),
        },
        projectId,
        projectPath,
      ),
    fetchRemoteCatalog: async (target: SearchTarget) => {
      const r = target.remote;
      if (!r) throw new Error("remote target without remote config");
      const params = new URLSearchParams({ path: r.remotePath });
      const result = await proxyToRemoteAuto(
        r.serverId, r.url, r.apiKey,
        "GET", `/api/path/search-catalog?${params.toString()}`, undefined,
        { reverseConnectManager: fastify.reverseConnectManager, timeoutMs: 2000 },
      );
      if (!result.ok) {
        throw new Error(`catalog fetch failed: ${result.status} ${result.errorCode ?? ""}`);
      }
      const data = result.data as { workspaces: Array<{ branch: string | null }>; sessions: SearchCatalogSessionEntry[] };
      // Wrap remote ids into local remote-prefixed ids and register mappings,
      // mirroring the session list proxy — a cached session must be navigable
      // even if the user never opened its branch dropdown.
      const sessions = await Promise.all(data.sessions.map(async (s) => {
        const localSessionId = `remote-${target.targetId}-${target.projectId}-${s.id}`;
        if (!fastify.remoteSessionMap.has(localSessionId)) {
          fastify.remoteSessionMap.set(localSessionId, {
            remoteServerId: target.targetId,
            remoteUrl: r.url,
            remoteApiKey: r.apiKey,
            remoteSessionId: s.id,
            branch: s.branch,
          });
        }
        await fastify.storage.remoteSessionMappings.upsert(
          localSessionId, target.projectId, target.targetId, s.id, s.branch,
        );
        return { ...s, id: localSessionId };
      }));
      return { workspaces: data.workspaces, sessions };
    },
  });

  async function currentCacheState(userId: string | undefined): Promise<"cold" | "stale" | "fresh"> {
    const targets = await listSearchTargets(fastify.storage, userId);
    const states = await fastify.storage.searchCache.getSyncStates(
      [...new Set(targets.map((t) => t.projectId))],
    );
    return computeCacheState(states, targets.length, Date.now());
  }

  // Cache-only search: never proxies, never spawns subprocesses.
  fastify.get<{ Querystring: { q?: string; limitPerGroup?: string } }>(
    "/api/search",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const query = (req.query.q ?? "").slice(0, 256);
      const parsed = parseInt(req.query.limitPerGroup ?? "10", 10);
      const limitPerGroup = Math.min(Math.max(Number.isNaN(parsed) ? 10 : parsed, 1), 50);
      const results = await fastify.storage.searchCache.search({ userId, query, limitPerGroup });
      const cacheState = await currentCacheState(userId);
      return reply.code(200).send({ ...results, cacheState });
    },
  );

  // Explicit refresh, called once on palette open. Returns when done or at
  // the deadline; the frontend re-queries afterwards.
  fastify.post("/api/search/refresh", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    await refresher.refreshAll(userId);
    const cacheState = await currentCacheState(userId);
    return reply.code(200).send({ ok: true, cacheState });
  });
};

export default searchRoutes;
