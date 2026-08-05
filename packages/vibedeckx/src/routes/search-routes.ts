import type { FastifyPluginAsync } from "fastify";
import { buildSearchCatalog } from "../search/catalog.js";
import { createSearchRefresher, listSearchTargets, computeCacheState, type SearchTarget } from "../search/refresh.js";
import type { SearchCatalogSessionEntry } from "../storage/types.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import { bindRemoteSessionMapping } from "../remote-agent-sessions.js";

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
        r.serverId,
        "GET", `/api/path/search-catalog?${params.toString()}`, undefined,
        { reverseConnectManager: fastify.reverseConnectManager, timeoutMs: 2000 },
      );
      if (!result.ok) {
        throw new Error(`catalog fetch failed: ${result.status} ${result.errorCode ?? ""}`);
      }
      const data = result.data as { workspaces: Array<{ branch: string | null; worktreePath?: string }>; sessions: SearchCatalogSessionEntry[] };
      const pathByBranch = new Map(data.workspaces.map((workspace) => [workspace.branch ?? "", workspace.worktreePath]));
      // Wrap remote ids into local remote-prefixed ids and register mappings,
      // mirroring the session list proxy — a cached session must be navigable
      // even if the user never opened its branch dropdown.
      const sessions = await Promise.all(data.sessions.map(async (s) => {
        const localSessionId = `remote-${target.targetId}-${target.projectId}-${s.id}`;
        // The session-list proxy (agent-session-routes.ts) registers the same
        // map entry / mapping row with the worker's raw "" branch sentinel for
        // main, while the catalog here uses the API's `null` convention.
        // Whichever registrar runs first must not leave a divergent value for
        // the other — normalize to "" for the map/mapping registration only;
        // the snapshot passed onward to applyCatalogSnapshot keeps `null`.
        const mapBranch = s.branch ?? "";
        if (!fastify.remoteSessionMap.has(localSessionId)) {
          fastify.remoteSessionMap.set(localSessionId, {
            remoteServerId: target.targetId,
            remoteSessionId: s.id,
            branch: mapBranch,
          });
        }
        // from_now: search DISCOVERS pre-existing worker sessions. Importing
        // their whole milestone history would flood a fresh front database with
        // unread notifications and a sound storm — the first sync just records
        // the worker's current head. Insert-only, so a session this front
        // created (from_start) is never downgraded by a later search pass.
        await bindRemoteSessionMapping(fastify.storage, {
          localSessionId, projectId: target.projectId, remoteServerId: target.targetId,
          remoteSessionId: s.id, branch: mapBranch, remotePath: r.remotePath,
          reportedWorktreePath: pathByBranch.get(mapBranch),
          notificationSyncStart: "from_now",
        });
        return { ...s, id: localSessionId };
      }));
      return { workspaces: data.workspaces, sessions };
    },
  });

  // Reconcile every authorized remote target automatically in fair bounded
  // pages. This repairs both legacy unknown rows and known statuses (notably a
  // stale `running`) after a front-server restart without requiring Cmd+K.
  let activityRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let activityRefreshRun: Promise<void> | undefined;
  const runActivityRefresh = () => {
    if (activityRefreshRun) return activityRefreshRun;
    const run = refresher.refreshRemoteActivity().catch((error) => {
      console.error("[Search] remote activity refresh failed:", error);
    });
    activityRefreshRun = run;
    void run.finally(() => {
      if (activityRefreshRun === run) activityRefreshRun = undefined;
    });
    return run;
  };
  fastify.addHook("onReady", async () => {
    void runActivityRefresh();
    activityRefreshTimer = setInterval(() => {
      void runActivityRefresh();
    }, 30_000);
    activityRefreshTimer.unref?.();
  });
  fastify.addHook("onClose", async () => {
    if (activityRefreshTimer) clearInterval(activityRefreshTimer);
    await activityRefreshRun;
    await refresher.drain();
  });

  async function currentCacheState(userId: string | undefined): Promise<"cold" | "stale" | "fresh"> {
    const targets = await listSearchTargets(fastify.storage, userId);
    const states = await fastify.storage.searchCache.getSyncStates(
      [...new Set(targets.map((t) => t.projectId))],
    );
    return computeCacheState(states, targets, Date.now());
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
