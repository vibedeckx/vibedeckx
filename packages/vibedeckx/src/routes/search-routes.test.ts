import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import path from "path";
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
    expect(body.sessions[0]).toMatchObject({ id: "s1", branch: null, title: "Investigate flaky test", entryCount: 1 });
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
