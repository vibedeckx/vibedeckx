import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import path from "path";

const proxyMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/remote-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/remote-proxy.js")>()),
  proxyToRemoteAuto: proxyMock,
}));

import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import searchRoutes from "./search-routes.js";

describe("GET /api/path/search-catalog", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let repoDir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-search-routes-"));
    repoDir = path.join(dir, "repo");
    execSync(`git init -q "${repoDir}"`, { stdio: "ignore" });
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "proj", path: repoDir });

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("agentSessionManager", { getSessionProcessAlive: () => false });
    app.decorate("reverseConnectManager", undefined);
    await app.register(searchRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the main workspace and non-empty sessions with API branch convention (null = main)", async () => {
    const s = await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "" });
    await storage.agentSessions.updateTitle(s.id, "Investigate flaky test");
    await storage.agentSessions.upsertEntry(s.id, 0, "{}");
    await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" }); // empty → filtered

    const res = await app.inject({ method: "GET", url: `/api/path/search-catalog?path=${encodeURIComponent(repoDir)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshotAt).toBeGreaterThan(0);
    expect(body.workspaces).toEqual([{ branch: null }]);           // git-init repo: main worktree only
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: "s1", branch: null, title: "Investigate flaky test", entryCount: 1,
      status: "running", agentType: "claude-code", model: null,
    });
  });

  it("returns an empty catalog for an unknown path", async () => {
    const res = await app.inject({ method: "GET", url: `/api/path/search-catalog?path=${encodeURIComponent("/nope")}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workspaces: [], sessions: [] });
  });

  it("400s without a path", async () => {
    const res = await app.inject({ method: "GET", url: "/api/path/search-catalog" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/search and POST /api/search/refresh", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let repoDir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-search-routes-"));
    repoDir = path.join(dir, "repo");
    execSync(`git init -q "${repoDir}"`, { stdio: "ignore" });
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "proj", path: repoDir });

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("agentSessionManager", { getSessionProcessAlive: () => false });
    app.decorate("reverseConnectManager", undefined);
    app.decorate("remoteSessionMap", new Map());
    await app.register(searchRoutes);
    await app.ready();

    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateTitle("s1", "Fix login flow");
    await storage.agentSessions.upsertEntry("s1", 0, "{}");
  });
  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("search returns matches from local sessions with cacheState", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=login" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["s1"]);
    expect(["cold", "stale", "fresh"]).toContain(body.cacheState);
  });

  it("refresh populates the local target's workspace cache, then search finds the branch", async () => {
    let res = await app.inject({ method: "POST", url: "/api/search/refresh" });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: "/api/search?q=main" });
    // repoDir is a git-init repo → its main workspace ('' sentinel, branch null) is cached
    expect(res.json().workspaces.some((w: { branch: string | null }) => w.branch === null)).toBe(true);
  });

  it("search caps and clamps limitPerGroup", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=login&limitPerGroup=9999" });
    expect(res.statusCode).toBe(200); // clamped internally to <= 50, must not error
  });
});

/**
 * Search DISCOVERS worker sessions it did not create. Their mappings must be
 * registered `from_now`, or a fresh front database pointed at a long-lived
 * worker would import months of milestones as unread notifications and sound.
 */
describe("POST /api/search/refresh: remote mapping provenance", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;

  beforeEach(async () => {
    proxyMock.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-search-provenance-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    // Remote-only project (no local path) so refresh has exactly one target.
    await storage.projects.create({ id: "p1", name: "proj", path: null });
    const server = await storage.remoteServers.create({ name: "w1", url: "http://w1", api_key: "k1" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: server.id, remote_path: "/srv/app",
    });

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("agentSessionManager", { getSessionProcessAlive: () => false });
    app.decorate("reverseConnectManager", undefined);
    app.decorate("remoteSessionMap", new Map());
    await app.register(searchRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const serverId = async () => (await storage.remoteServers.getAll())[0].id;

  it("registers a discovered worker session as from_now", async () => {
    const srv = await serverId();
    proxyMock.mockResolvedValue({
      ok: true, status: 200,
      data: { workspaces: [{ branch: "dev" }], sessions: [{ id: "r1", branch: "dev", title: "old work", lastActiveAt: 1, favoritedAt: null, entryCount: 3 }] },
    });

    const res = await app.inject({ method: "POST", url: "/api/search/refresh" });
    expect(res.statusCode).toBe(200);

    const mapping = await storage.remoteSessionMappings.getByRemote(srv, "r1");
    expect(mapping?.notification_sync_start).toBe("from_now");
  });

  it("does not downgrade a session this front created (from_start)", async () => {
    const srv = await serverId();
    const localId = `remote-${srv}-p1-r1`;
    await storage.remoteSessionMappings.upsert(localId, "p1", srv, "r1", "dev", "from_start");
    proxyMock.mockResolvedValue({
      ok: true, status: 200,
      data: { workspaces: [{ branch: "dev" }], sessions: [{ id: "r1", branch: "dev", title: "t", lastActiveAt: 1, favoritedAt: null, entryCount: 1 }] },
    });

    await app.inject({ method: "POST", url: "/api/search/refresh" });

    expect((await storage.remoteSessionMappings.getByRemote(srv, "r1"))?.notification_sync_start).toBe("from_start");
  });
});

describe("automatic remote activity backfill", () => {
  it("refreshes legacy unknown session activity without opening the quick switcher", async () => {
    proxyMock.mockReset();
    const dir = mkdtempSync(path.join(tmpdir(), "vdx-search-activity-backfill-"));
    const storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    const app = Fastify();
    try {
      await storage.projects.create({ id: "p1", name: "proj", path: null });
      const server = await storage.remoteServers.create({ name: "w1", url: "http://w1", api_key: "k1" });
      await storage.projectRemotes.add({
        project_id: "p1", remote_server_id: server.id, remote_path: "/srv/app",
      });
      const localId = `remote-${server.id}-p1-r1`;
      await storage.remoteSessionMappings.upsert(localId, "p1", server.id, "r1", "dev", "from_now");
      await storage.searchCache.noteSessionCreated({
        localSessionId: localId, projectId: "p1", targetId: server.id, branch: "dev", title: "Legacy",
      });
      proxyMock.mockResolvedValue({
        ok: true, status: 200,
        data: {
          workspaces: [{ branch: "dev" }],
          sessions: [{
            id: "r1", branch: "dev", title: "Legacy", lastActiveAt: 123,
            favoritedAt: null, entryCount: 3, status: "stopped",
            agentType: "codex", model: "gpt-5", lastUserMessageAt: 100, lastCompletedAt: 120,
          }],
        },
      });

      app.decorate("storage", storage);
      app.decorate("agentSessionManager", { getSessionProcessAlive: () => false });
      app.decorate("reverseConnectManager", undefined);
      app.decorate("remoteSessionMap", new Map());
      await app.register(searchRoutes);
      await app.ready();

      await vi.waitFor(async () => {
        const rows = await storage.searchCache.listRemoteSessionActivityByProject("p1", 10);
        expect(rows[0]).toMatchObject({ id: localId, status: "stopped", model: "gpt-5" });
      });
      expect(proxyMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
