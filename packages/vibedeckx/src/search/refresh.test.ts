import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage, SearchCatalogSnapshot } from "../storage/types.js";
import { createSearchRefresher, listSearchTargets, computeCacheState, type SearchTarget } from "./refresh.js";

const emptySnap: SearchCatalogSnapshot = { workspaces: [], sessions: [] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("search refresh", () => {
  let dir: string;
  let storage: Storage;
  let serverId: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-refresh-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "proj", path: null });
    const server = await storage.remoteServers.create({ name: "W1", url: "http://w1" });
    serverId = server.id;
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverId, remote_path: "/repo" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("listSearchTargets: local target only when the project has a path; one target per linked remote", async () => {
    let targets = await listSearchTargets(storage);
    expect(targets).toEqual([
      expect.objectContaining({ projectId: "p1", targetId: serverId }),
    ]);
    await storage.projects.create({ id: "p2", name: "local-proj", path: "/tmp/p2" });
    targets = await listSearchTargets(storage);
    expect(targets.map((t) => t.targetId).sort()).toEqual(["local", serverId].sort());
  });

  it("fetches due targets and applies snapshots", async () => {
    const fetched: string[] = [];
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async (t) => { fetched.push(t.targetId); return emptySnap; },
    });
    await refresher.refreshAll();
    expect(fetched).toEqual([serverId]);
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_success_at).toBeGreaterThan(0);
  });

  it("TTL: a fresh target is not refetched", async () => {
    let calls = 0;
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async () => { calls++; return emptySnap; },
      ttlMs: 60_000,
    });
    await refresher.refreshAll();
    await refresher.refreshAll();
    expect(calls).toBe(1);
  });

  it("singleflight: concurrent refreshes coalesce per target", async () => {
    let calls = 0;
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async () => { calls++; await wait(50); return emptySnap; },
      ttlMs: 0, // always due
    });
    await Promise.all([refresher.refreshAll(), refresher.refreshAll()]);
    expect(calls).toBe(1);
  });

  it("a failing fetch records the failure and does not throw", async () => {
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async () => { throw new Error("boom"); },
    });
    await expect(refresher.refreshAll()).resolves.toBeUndefined();
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_error).toBe("boom");
    expect(states[0].last_success_at ?? null).toBeNull();
  });

  it("deadline: refreshAll returns even while a slow fetch is still running", async () => {
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async () => { await wait(1_000); return emptySnap; },
      deadlineMs: 50,
    });
    const started = Date.now();
    await refresher.refreshAll();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("computeCacheState: cold until every target has succeeded, fresh within TTL, stale after", () => {
    const now = 100_000;
    expect(computeCacheState([], [], now)).toBe("fresh");
    expect(computeCacheState([], [{ projectId: "p1", targetId: "t" }], now)).toBe("cold");
    expect(computeCacheState(
      [{ project_id: "p1", target_id: "t", last_success_at: now - 1_000, last_attempt_at: now, last_error: null }],
      [{ projectId: "p1", targetId: "t" }], now,
    )).toBe("fresh");
    expect(computeCacheState(
      [{ project_id: "p1", target_id: "t", last_success_at: now - 90_000, last_attempt_at: now, last_error: null }],
      [{ projectId: "p1", targetId: "t" }], now,
    )).toBe("stale");
    expect(computeCacheState(
      [{ project_id: "p1", target_id: "t", last_success_at: now - 1_000, last_attempt_at: now, last_error: null }],
      [{ projectId: "p1", targetId: "t" }, { projectId: "p1", targetId: "t2" }], now,
    )).toBe("cold");
  });

  it("computeCacheState: a leftover row for a since-unlinked target is ignored — does not force permanent staleness", () => {
    const now = 100_000;
    const states = [
      // expected target: fresh
      { project_id: "p1", target_id: "t", last_success_at: now - 1_000, last_attempt_at: now, last_error: null },
      // leftover row for a target no longer in `targets` (e.g. an unlinked remote), long stale
      { project_id: "p1", target_id: "gone", last_success_at: now - 999_999, last_attempt_at: now, last_error: null },
    ];
    expect(computeCacheState(states, [{ projectId: "p1", targetId: "t" }], now)).toBe("fresh");
  });

  it("computeCacheState: a leftover row's success cannot mask a never-synced expected target as cold", () => {
    const now = 100_000;
    const states = [
      // leftover row for a target no longer in `targets`, but it DID succeed —
      // must not be counted toward the expected target's success.
      { project_id: "p1", target_id: "gone", last_success_at: now - 1_000, last_attempt_at: now, last_error: null },
    ];
    expect(computeCacheState(states, [{ projectId: "p1", targetId: "t" }], now)).toBe("cold");
  });
});
