import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import workerStatsRoutes from "./worker-stats-routes.js";
import { workerUpdateStatus } from "./remote-server-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import { recordWorkspaceBindingRead, resetWorkspaceBindingReadMetrics } from "../workspace-binding-metrics.js";

const URL_PATH = "/api/admin/worker-version-stats";
const BINDING_STATS_PATH = "/api/admin/workspace-binding-read-stats";

describe("GET /api/admin/worker-version-stats", () => {
  let dir: string;
  let storage: Storage;
  let app: FastifyInstance;
  const connectedIds = new Set<string>();

  async function build(authEnabled: boolean) {
    const instance = Fastify();
    instance.decorate("authEnabled", authEnabled);
    instance.decorate("storage", storage);
    instance.decorate("reverseConnectManager", {
      isConnected: (id: string) => connectedIds.has(id),
    } as never);
    instance.decorate("remoteSessionMap", new Map());
    await instance.register(workerStatsRoutes);
    await instance.ready();
    return instance;
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-wstats-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    connectedIds.clear();
    resetWorkspaceBindingReadMetrics();
  });

  afterEach(async () => {
    await app?.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hides the endpoint from tenants when auth is on and no API key is configured", async () => {
    app = await build(true);
    const res = await app.inject({ method: "GET", url: URL_PATH });
    expect(res.statusCode).toBe(404);
  });

  it("aggregates version distribution across all and connected workers", async () => {
    // Three workers: one reporting + connected, one reporting + offline,
    // one pre-reporting (never reported) + connected.
    const a = await storage.remoteServers.create({ name: "a" });
    const b = await storage.remoteServers.create({ name: "b" });
    const c = await storage.remoteServers.create({ name: "c" });
    await storage.remoteServers.updateWorkerVersion(a.id, "0.3.3", ["http:GET /x"]);
    await storage.remoteServers.updateWorkerVersion(b.id, "0.2.0", []);
    connectedIds.add(a.id);
    connectedIds.add(c.id);

    app = await build(false); // solo mode: sole user IS the operator
    const res = await app.inject({ method: "GET", url: URL_PATH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body.workers_total).toBe(3);
    expect(body.connected_workers).toBe(2);
    expect(body.versions_all).toEqual({ "0.3.3": 1, "0.2.0": 1, unknown: 1 });
    expect(body.versions_connected).toEqual({ "0.3.3": 1, unknown: 1 });
    expect(body.oldest_connected_version).toBe("0.3.3");
    expect(body.active_remote_sessions).toBe(0);
    expect(body.active_turns).toBe(0);
    expect(body.stale_workers_7d).toBe(0);

    const phase4 = body.phase4_ready as Record<string, unknown>;
    // 1 of 2 connected workers is unknown — nowhere near the 5% exit bar.
    expect(phase4.unknown_share_connected).toBe(0.5);
    expect(phase4.verdict).toBe(false);
  });

  it("reports per-consumer binding reads together with current database diagnostics", async () => {
    recordWorkspaceBindingRead("search", "legacy-fallback", 2);
    app = await build(false);

    const res = await app.inject({ method: "GET", url: BINDING_STATS_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      reads: expect.arrayContaining([
        { consumer: "search", outcome: "legacy-fallback", count: 2 },
      ]),
      database: {
        unboundLocal: 0,
        unboundRemote: 0,
        danglingLocal: 0,
        danglingRemote: 0,
      },
    });
  });

  it("counts ever-active workers offline for over 7 days as stale", async () => {
    const gone = await storage.remoteServers.create({ name: "gone" });
    const fresh = await storage.remoteServers.create({ name: "fresh" });
    const never = await storage.remoteServers.create({ name: "never" });
    // updateStatus('online') stamps last_connected_at = now; backdate one row.
    await storage.remoteServers.updateStatus(gone.id, "online");
    await storage.remoteServers.updateStatus(fresh.id, "online");
    await storage.remoteServers.updateStatus(gone.id, "offline");
    await storage.remoteServers.updateStatus(fresh.id, "offline");
    void never;
    const db = (await import("better-sqlite3")).default(path.join(dir, "test.sqlite"));
    db.prepare(
      "UPDATE remote_servers SET last_connected_at = datetime('now', '-10 days') WHERE id = ?",
    ).run(gone.id);
    db.close();

    app = await build(false);
    const res = await app.inject({ method: "GET", url: URL_PATH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // "gone" is 10 days offline; "fresh" reconnected recently; "never" has no
    // last_connected_at and must not count.
    expect(body.stale_workers_7d).toBe(1);
  });

  // `VIBEDECKX_API_KEY=` is what uncommenting the line in the env examples
  // without filling it in produces. server.ts's gate treats "" as falsy and
  // validates nothing, so if this route counted "" as a configured key, any
  // caller sending any header value would be an operator on a Clerk
  // deployment — unauthenticated access to cross-tenant fleet aggregates.
  it("treats an empty VIBEDECKX_API_KEY as unset, so no header can pass as the operator", async () => {
    const original = process.env.VIBEDECKX_API_KEY;
    process.env.VIBEDECKX_API_KEY = "";
    vi.resetModules();
    try {
      const { default: freshRoutes } = await import("./worker-stats-routes.js");
      const instance = Fastify();
      instance.decorate("authEnabled", true);
      instance.decorate("storage", storage);
      instance.decorate("reverseConnectManager", { isConnected: () => false } as never);
      instance.decorate("remoteSessionMap", new Map());
      await instance.register(freshRoutes);
      await instance.ready();
      app = instance;

      for (const key of ["anything", "", "undefined"]) {
        const res = await app.inject({
          method: "GET",
          url: URL_PATH,
          headers: { "x-vibedeckx-api-key": key },
        });
        expect(res.statusCode).toBe(404);
      }
    } finally {
      if (original === undefined) delete process.env.VIBEDECKX_API_KEY;
      else process.env.VIBEDECKX_API_KEY = original;
      vi.resetModules();
    }
  });
});

describe("workerUpdateStatus", () => {
  it("classifies each worker version against min and latest", () => {
    expect(workerUpdateStatus(undefined, "0.3.3")).toBe("unreported");
    expect(workerUpdateStatus("0.3.1", "0.3.3")).toBe("behind-latest");
    expect(workerUpdateStatus("0.3.3", "0.3.3")).toBe("current");
    // npm check failed → no badge rather than a wrong one.
    expect(workerUpdateStatus("0.3.1", undefined)).toBe("current");
    // Unparseable reported version → can't judge → current.
    expect(workerUpdateStatus("unknown", "0.3.3")).toBe("current");
  });
});
