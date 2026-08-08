import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import {
  conventionalWorktreePath,
  getRegisteredWorktreeBranches,
  getWorktreeBaseForProject,
  invalidateWorktreeListCache,
} from "./worktree-paths.js";

describe("non-git project", () => {
  it("owns exactly one workspace at its root, so its sessions can still bind", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vdx-nongit-"));
    const storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    try {
      await storage.projects.create({ id: "p1", name: "p", path: dir });

      expect(await getRegisteredWorktreeBranches(storage, "p1", dir)).toEqual([{ branch: null }]);
      expect(await storage.workspaceRegistry.getByProjectBranch("p1", "", "local"))
        .toMatchObject({ checkout: { worktree_path: dir, status: "ready" } });

      const bound = await storage.agentSessions.createBound({
        id: "s1", project_id: "p1", branch: "", target_id: "local",
      });
      expect(bound.session.workspace_checkout_id).toBe(bound.checkout.id);
    } finally {
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts the branch created by a later git init instead of reporting drift", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vdx-nongit-init-"));
    const storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    try {
      await storage.projects.create({ id: "p1", name: "p", path: dir });
      await getRegisteredWorktreeBranches(storage, "p1", dir);

      execFileSync("git", ["init", "-b", "main", dir]);
      invalidateWorktreeListCache(dir);

      expect(await getRegisteredWorktreeBranches(storage, "p1", dir)).toEqual([{ branch: null }]);
      expect((await storage.workspaceRegistry.getByProjectBranch("p1", "", "local"))?.checkout)
        .toMatchObject({ worktree_path: dir, expected_branch: "main", status: "ready" });
    } finally {
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("persisted worktree identity", () => {
  let dir: string;
  let projectPath: string;
  let worktreePath: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-worktree-registry-"));
    projectPath = path.join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", projectPath]);
    execFileSync("git", ["-C", projectPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", projectPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", projectPath, "commit", "--allow-empty", "-m", "initial"]);
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project", path: projectPath });
    worktreePath = conventionalWorktreePath(projectPath, "dev");
    execFileSync("git", ["-C", projectPath, "worktree", "add", "-b", "dev", worktreePath, "main"]);
  });

  afterEach(async () => {
    await storage.close();
    if (existsSync(worktreePath)) {
      execFileSync("git", ["-C", projectPath, "worktree", "remove", "--force", worktreePath]);
    }
    rmSync(getWorktreeBaseForProject(projectPath), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("adopts an existing worktree once and keeps its original branch after drift", async () => {
    expect(await getRegisteredWorktreeBranches(storage, "p1", projectPath)).toEqual([
      { branch: null },
      { branch: "dev" },
    ]);
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ worktree_path: worktreePath, expected_branch: "dev", status: "ready" });

    execFileSync("git", ["-C", worktreePath, "switch", "-c", "agent/experiment"]);
    invalidateWorktreeListCache(projectPath);

    expect(await getRegisteredWorktreeBranches(storage, "p1", projectPath)).toEqual([
      { branch: null },
      { branch: "dev", currentBranch: "agent/experiment" },
    ]);
  });

  it("marks a registered checkout missing when Git no longer reports it", async () => {
    await getRegisteredWorktreeBranches(storage, "p1", projectPath);
    execFileSync("git", ["-C", projectPath, "worktree", "remove", "--force", worktreePath]);
    invalidateWorktreeListCache(projectPath);

    expect(await getRegisteredWorktreeBranches(storage, "p1", projectPath)).toEqual([{ branch: null }]);
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ status: "error", error: "Worktree is missing" });
  });
});
