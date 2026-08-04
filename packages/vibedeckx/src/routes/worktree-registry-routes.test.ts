import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/fastify", () => ({ getAuth: () => ({ userId: null }), clerkClient: {} }));

import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import {
  conventionalWorktreePath,
  getWorktreeBaseForProject,
  invalidateWorktreeListCache,
} from "../utils/worktree-paths.js";
import worktreeRoutes from "./worktree-routes.js";

describe("worktree routes persisted identity", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let projectPath: string;
  let worktreePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-worktree-routes-"));
    projectPath = path.join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", projectPath]);
    execFileSync("git", ["-C", projectPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", projectPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", projectPath, "commit", "--allow-empty", "-m", "initial"]);
    worktreePath = conventionalWorktreePath(projectPath, "dev");

    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project", path: projectPath });

    app = Fastify({ logger: false });
    app.decorate("authEnabled", false);
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    await app.register(worktreeRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    if (existsSync(worktreePath)) {
      execFileSync("git", ["-C", projectPath, "worktree", "remove", "--force", worktreePath]);
    }
    rmSync(getWorktreeBaseForProject(projectPath), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the original branch and reports a later checkout as drift", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });

    expect(created.statusCode).toBe(201);
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({
        worktree_path: worktreePath,
        expected_branch: "dev",
        status: "ready",
      });

    execFileSync("git", ["-C", worktreePath, "switch", "-c", "agent/experiment"]);
    invalidateWorktreeListCache(projectPath);

    const listed = await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().worktrees).toEqual([
      { branch: null },
      { branch: "dev", currentBranch: "agent/experiment" },
    ]);
  });

  it("restores a checkout to ready when dirty files prevent deletion", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    expect(created.statusCode).toBe(201);
    writeFileSync(path.join(worktreePath, "dirty.txt"), "keep me");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });

    expect(deleted.statusCode).toBe(409);
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ status: "ready", error: null });
  });
});
