import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const proxyMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/remote-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/remote-proxy.js")>()),
  proxyToRemoteAuto: proxyMock,
}));

import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import settingsRoutes from "./settings-routes.js";
import sessionInventoryRoutes from "./session-inventory-routes.js";
import { SESSION_RETENTION_SETTING_KEY } from "../session-retention-config.js";

/**
 * The operator-facing retention setting, its downlink to workers, and the
 * worker-side inventory endpoint the hub reconciles against
 * (docs/plans/2026-08-08-session-retention.md §3 / §3.1).
 */

describe("session retention routes", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let sweep: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-retention-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "proj", path: "/srv/app" });
    proxyMock.mockReset();
    sweep = vi.fn(async () => ({ scanned: 0, deleted: 0, budgetExhausted: false, disabled: false }));

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("sessionRetention", { sweep });
    app.decorate("reverseConnectManager", undefined);
    app.decorate("proxyManager", { updateConfig: () => undefined });
    app.decorate("authEnabled", false);
    await app.register(settingsRoutes);
    await app.register(sessionInventoryRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = () => app.inject({ method: "GET", url: "/api/settings/session-retention" });
  const put = (days: unknown) => app.inject({
    method: "PUT", url: "/api/settings/session-retention", payload: { days },
  });

  it("is off by default, with 90 offered as the prefill", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ days: null, suggestedDays: 90, minDays: 1, maxDays: 3650 });
  });

  it("saves a window, sweeps immediately, and reads back", async () => {
    const res = await put(30);
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toBe(30);
    // Without this the operator changes the setting, sees nothing happen for
    // hours, and concludes it is broken.
    expect(sweep).toHaveBeenCalled();
    expect((await get()).json().days).toBe(30);
  });

  it("turns retention off with null", async () => {
    await put(30);
    expect((await put(null)).json().days).toBeNull();
    expect((await get()).json().days).toBeNull();
    expect(await storage.settings.get(SESSION_RETENTION_SETTING_KEY)).toBe("");
  });

  it("rejects out-of-range and non-integer values instead of coercing them", async () => {
    for (const bad of [0, -1, 12.5, "ninety", 3651]) {
      const res = await put(bad);
      expect(res.statusCode, `days=${bad}`).toBe(400);
    }
    expect((await get()).json().days).toBeNull();
  });

  it("reports per-worker downlink outcomes so an old worker is visible", async () => {
    await storage.remoteServers.create({ name: "laptop" });
    await storage.remoteServers.create({ name: "old-box" });
    const servers = await storage.remoteServers.getAll();
    proxyMock.mockImplementation(async (serverId: string) => (
      serverId === servers[0].id
        ? { ok: true, status: 200, data: { days: 30 } }
        : { ok: false, status: 404, data: { error: "Not Found" } }
    ));

    const body = (await put(30)).json();

    expect(proxyMock).toHaveBeenCalledWith(
      expect.any(String), "PUT", "/api/settings/session-retention/apply", { days: 30 },
      expect.anything(),
    );
    expect(body.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "laptop", status: "applied" }),
      expect.objectContaining({ name: "old-box", status: "needs_upgrade" }),
    ]));
  });

  it("reports an offline worker as unreachable rather than failing the save", async () => {
    await storage.remoteServers.create({ name: "offline" });
    proxyMock.mockResolvedValue({ ok: false, status: 0, data: null, errorCode: "network_error" });

    const res = await put(30);

    expect(res.statusCode).toBe(200);
    expect(res.json().workers[0]).toMatchObject({ name: "offline", status: "unreachable" });
    expect((await get()).json().days).toBe(30);
  });

  describe("worker-side apply", () => {
    const apply = (days: unknown) => app.inject({
      method: "PUT", url: "/api/settings/session-retention/apply", payload: { days },
    });

    it("stores the pushed window and sweeps", async () => {
      expect((await apply(45)).json().days).toBe(45);
      expect(await storage.settings.get(SESSION_RETENTION_SETTING_KEY)).toBe("45");
      expect(sweep).toHaveBeenCalled();
    });

    it("treats an unusable pushed value as off rather than 500ing the tunnel", async () => {
      await apply(45);
      expect((await apply("garbage")).json().days).toBeNull();
      expect(await storage.settings.get(SESSION_RETENTION_SETTING_KEY)).toBe("");
    });
  });

  describe("GET /api/path/session-ids", () => {
    it("lists every session for the project, complete", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "" });

      const res = await app.inject({ method: "GET", url: "/api/path/session-ids?path=/srv/app" });

      expect(res.statusCode).toBe(200);
      expect(res.json().sessionIds.sort()).toEqual(["s1", "s2"]);
      expect(res.json().complete).toBe(true);
    });

    it("includes a session that has no conversation entries yet", async () => {
      // The search catalog would omit this one — which is exactly why the
      // reconciler must not use the catalog as its liveness list.
      await storage.agentSessions.create({ id: "brand-new", project_id: "p1", branch: "dev" });
      const res = await app.inject({ method: "GET", url: "/api/path/session-ids?path=/srv/app" });
      expect(res.json().sessionIds).toEqual(["brand-new"]);
    });

    it("answers empty-but-complete for an unregistered path", async () => {
      const res = await app.inject({ method: "GET", url: "/api/path/session-ids?path=/nope" });
      expect(res.json()).toEqual({ sessionIds: [], complete: true });
    });

    it("400s without a path", async () => {
      const res = await app.inject({ method: "GET", url: "/api/path/session-ids" });
      expect(res.statusCode).toBe(400);
    });
  });
});
