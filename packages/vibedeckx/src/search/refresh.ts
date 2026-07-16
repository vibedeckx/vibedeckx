import type { Storage, SearchCatalogSnapshot, SearchSyncState } from "../storage/types.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_DEADLINE_MS = 5_000;
const PER_WORKER_CONCURRENCY = 3;
const LOCAL_CONCURRENCY = 4;

export interface SearchTarget {
  projectId: string;
  targetId: string;
  projectPath?: string | null;
  remote?: { serverId: string; url: string; apiKey: string; remotePath: string };
}

export async function listSearchTargets(storage: Storage, userId?: string): Promise<SearchTarget[]> {
  const projects = await storage.projects.getAll(userId);
  const targets: SearchTarget[] = [];
  for (const p of projects) {
    if (p.path) targets.push({ projectId: p.id, targetId: "local", projectPath: p.path });
    const remotes = await storage.projectRemotes.getByProject(p.id);
    for (const r of remotes) {
      targets.push({
        projectId: p.id,
        targetId: r.remote_server_id,
        remote: {
          serverId: r.remote_server_id,
          url: r.server_url ?? "",
          apiKey: r.server_api_key ?? "",
          remotePath: r.remote_path,
        },
      });
    }
  }
  return targets;
}

export function computeCacheState(
  states: SearchSyncState[],
  expectedTargets: number,
  now: number,
  ttlMs: number = DEFAULT_TTL_MS,
): "cold" | "stale" | "fresh" {
  if (expectedTargets === 0) return "fresh";
  const succeeded = states.filter((s) => s.last_success_at != null);
  if (succeeded.length < expectedTargets) return "cold";
  return succeeded.every((s) => now - (s.last_success_at ?? 0) <= ttlMs) ? "fresh" : "stale";
}

export interface RefreshDeps {
  storage: Storage;
  buildLocalCatalog: (projectId: string, projectPath: string) => Promise<SearchCatalogSnapshot>;
  fetchRemoteCatalog: (target: SearchTarget) => Promise<SearchCatalogSnapshot>;
  ttlMs?: number;
  deadlineMs?: number;
  now?: () => number;
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      await task();
    }
  });
  await Promise.all(workers);
}

export function createSearchRefresher(deps: RefreshDeps) {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = deps.now ?? Date.now;
  // Singleflight per (project, target): concurrent palette-opens share one fetch.
  const inflight = new Map<string, Promise<void>>();

  function refreshTarget(t: SearchTarget): Promise<void> {
    const key = `${t.projectId}:${t.targetId}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const run = (async () => {
      try {
        const snapshot = t.targetId === "local"
          ? await deps.buildLocalCatalog(t.projectId, t.projectPath ?? "")
          : await deps.fetchRemoteCatalog(t);
        await deps.storage.searchCache.applyCatalogSnapshot(t.projectId, t.targetId, snapshot);
      } catch (err) {
        // A failed fetch must never delete cache rows — record and move on.
        await deps.storage.searchCache.recordSyncFailure(
          t.projectId, t.targetId, err instanceof Error ? err.message : String(err),
        ).catch(() => {});
      }
    })();
    inflight.set(key, run);
    void run.finally(() => inflight.delete(key));
    return run;
  }

  async function refreshAll(userId?: string): Promise<void> {
    const targets = await listSearchTargets(deps.storage, userId);
    const states = await deps.storage.searchCache.getSyncStates([...new Set(targets.map((t) => t.projectId))]);
    const stateByKey = new Map(states.map((s) => [`${s.project_id}:${s.target_id}`, s]));
    const due = targets.filter((t) => {
      const s = stateByKey.get(`${t.projectId}:${t.targetId}`);
      return !s?.last_success_at || now() - s.last_success_at > ttlMs;
    });

    // Group by worker: many projects can point at the same worker, and it
    // must not be stampeded — cap in-flight catalog calls per worker.
    const byWorker = new Map<string, SearchTarget[]>();
    for (const t of due) {
      const k = t.targetId;
      byWorker.set(k, [...(byWorker.get(k) ?? []), t]);
    }
    const lanes = [...byWorker.entries()].map(([workerId, ts]) =>
      runWithConcurrency(
        ts.map((t) => () => refreshTarget(t)),
        workerId === "local" ? LOCAL_CONCURRENCY : PER_WORKER_CONCURRENCY,
      ),
    );
    const all = Promise.all(lanes).then(() => undefined);
    // Overall deadline: return with whatever completed; stragglers finish in
    // the background (their singleflight entries prevent duplicate work).
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deadlineMs);
        timer.unref?.();
      }),
    ]);
  }

  return { refreshAll };
}
