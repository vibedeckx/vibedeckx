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
