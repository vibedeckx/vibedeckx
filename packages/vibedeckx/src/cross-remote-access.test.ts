import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import {
  isSessionUsable,
  resolveTarget,
  listAccessibleRemotes,
  SessionConcurrencyGuard,
  TOOL_TIERS,
  type AccessDeps,
} from "./cross-remote-access.js";
import type { CrossRemoteTokenPayload } from "./utils/cross-remote-token.js";

describe("cross-remote access", () => {
  let dir: string;
  let storage: Storage;
  let connected: Set<string>;
  let aliveLocal: Set<string>;
  let deps: AccessDeps;

  const payload = (over: Partial<CrossRemoteTokenPayload> = {}): CrossRemoteTokenPayload => ({
    userId: "user-1",
    sessionId: "sess-1",
    sourceRemoteServerId: "srv-a",
    ...over,
  });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xracc-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    connected = new Set();
    aliveLocal = new Set();
    deps = {
      storage,
      reverseConnectManager: { isConnected: (id) => connected.has(id) },
      remoteSessionMap: new Map(),
      agentSessionManager: { getSessionProcessAlive: (id) => aliveLocal.has(id) },
    };
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps every tool to a tier", () => {
    expect(TOOL_TIERS).toEqual({
      remote_read_file: "read",
      remote_list_dir: "read",
      remote_stat_path: "read",
      remote_process_list: "read",
      remote_bash: "exec",
    });
  });

  describe("isSessionUsable", () => {
    it("accepts a live local session", () => {
      aliveLocal.add("sess-1");
      expect(isSessionUsable(deps, "sess-1")).toBe(true);
    });

    it("rejects a dead local session", () => {
      expect(isSessionUsable(deps, "sess-1")).toBe(false);
    });

    it("accepts a known remote session", () => {
      deps.remoteSessionMap.set("remote-xyz", {});
      expect(isSessionUsable(deps, "remote-xyz")).toBe(true);
    });

    it("rejects an unknown remote session", () => {
      expect(isSessionUsable(deps, "remote-gone")).toBe(false);
    });
  });

  describe("resolveTarget", () => {
    it("resolves an online outbound target at the read tier", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "read" }, "user-1");

      const result = await resolveTarget(deps, payload(), b.id, "read");
      expect(result.ok).toBe(true);
    });

    it("denies a read-tier target for an exec-tier tool", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "read" }, "user-1");

      const result = await resolveTarget(deps, payload(), b.id, "exec");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("allows an exec-tier target for a read-tier tool", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-1");

      const result = await resolveTarget(deps, payload(), b.id, "read");
      expect(result.ok).toBe(true);
    });

    it("denies a target left at the default 'off' tier", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      const result = await resolveTarget(deps, payload(), b.id, "read");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("denies a target owned by another user", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-2");
      await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-2");

      const result = await resolveTarget(deps, payload({ userId: "user-1" }), b.id, "read");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("denies the source remote targeting itself", async () => {
      const a = await storage.remoteServers.create({ name: "a", url: "http://a:5173" }, "user-1");
      await storage.remoteServers.update(a.id, { cross_remote_access: "exec" }, "user-1");

      const result = await resolveTarget(deps, payload({ sourceRemoteServerId: a.id }), a.id, "read");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("denies an unknown remote id", async () => {
      const result = await resolveTarget(deps, payload(), "does-not-exist", "read");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("reports an inbound target that is not connected as offline", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: null, connection_mode: "inbound" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-1");

      const result = await resolveTarget(deps, payload(), b.id, "exec");
      expect(result).toEqual({ ok: false, reason: "offline" });
    });

    it("resolves an inbound target once it is connected", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: null, connection_mode: "inbound" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-1");
      connected.add(b.id);

      const result = await resolveTarget(deps, payload(), b.id, "exec");
      expect(result.ok).toBe(true);
    });
  });

  describe("listAccessibleRemotes", () => {
    it("returns opted-in remotes, excluding the source and 'off' remotes", async () => {
      const a = await storage.remoteServers.create({ name: "a", url: "http://a:5173" }, "user-1");
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      const c = await storage.remoteServers.create({ name: "c", url: "http://c:5173" }, "user-1");
      await storage.remoteServers.update(a.id, { cross_remote_access: "exec" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "read" }, "user-1");
      // c stays 'off'

      const list = await listAccessibleRemotes(deps, payload({ sourceRemoteServerId: a.id }));
      expect(list).toEqual([{ id: b.id, name: "b", access: "read", online: true }]);
      expect(list.find((r) => r.id === c.id)).toBeUndefined();
    });

    it("returns nothing for a user with no opted-in remotes", async () => {
      await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      expect(await listAccessibleRemotes(deps, payload())).toEqual([]);
    });
  });

  describe("SessionConcurrencyGuard", () => {
    it("allows up to the cap and rejects beyond it", () => {
      const guard = new SessionConcurrencyGuard(2);
      expect(guard.acquire("s")).toBe(true);
      expect(guard.acquire("s")).toBe(true);
      expect(guard.acquire("s")).toBe(false);
    });

    it("frees a slot on release", () => {
      const guard = new SessionConcurrencyGuard(1);
      expect(guard.acquire("s")).toBe(true);
      expect(guard.acquire("s")).toBe(false);
      guard.release("s");
      expect(guard.acquire("s")).toBe(true);
    });

    it("counts sessions independently", () => {
      const guard = new SessionConcurrencyGuard(1);
      expect(guard.acquire("s1")).toBe(true);
      expect(guard.acquire("s2")).toBe(true);
    });

    it("never drops below zero on an unbalanced release", () => {
      const guard = new SessionConcurrencyGuard(1);
      guard.release("s");
      expect(guard.acquire("s")).toBe(true);
      expect(guard.acquire("s")).toBe(false);
    });
  });
});
