import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("workspace registry storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-workspace-registry-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project", path: "/repo" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records creating intent and promotes the logical workspace when checkout succeeds", async () => {
    const creating = await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    expect(creating.workspace.status).toBe("creating");
    expect(creating.checkout.status).toBe("creating");

    await storage.workspaceRegistry.setCheckoutStatus(creating.workspace.id, "local", "ready");
    const ready = await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local");
    expect(ready?.workspace.status).toBe("ready");
    expect(ready?.checkout.status).toBe("ready");
  });

  it("keeps per-target failures without hiding a ready checkout", async () => {
    const local = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    const remote = await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: "remote-1",
      worktreePath: "/remote/dev", expectedBranch: "dev",
    });
    await storage.workspaceRegistry.setCheckoutStatus(remote.workspace.id, "remote-1", "error", "offline");

    const rows = await storage.workspaceRegistry.listByProject("p1");
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.checkout.target_id === "remote-1")?.checkout.error).toBe("offline");
    expect(rows[0].workspace.id).toBe(local.workspace.id);
    expect(rows.every((row) => row.workspace.status === "ready")).toBe(true);
  });

  it("removes the logical workspace after its last checkout is removed", async () => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    await storage.workspaceRegistry.removeCheckout(registered.workspace.id, "local");
    expect(await storage.workspaceRegistry.listByProject("p1")).toEqual([]);
  });

  it("registerReadyCheckout adopts an existing worktree idempotently", async () => {
    const first = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    const second = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.checkout.id).toBe(first.checkout.id);
    expect(await storage.workspaceRegistry.listByProject("p1", "local")).toHaveLength(1);
  });

  it("allows project aliases to register the same physical checkout", async () => {
    await storage.projects.create({ id: "p2", name: "project alias", path: "/repo" });
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "remote-1",
      worktreePath: "/remote/worktrees/dev", expectedBranch: "dev",
    });

    await expect(storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p2", branch: "dev", targetId: "remote-1",
      worktreePath: "/remote/worktrees/dev", expectedBranch: "dev",
    })).resolves.toMatchObject({ checkout: { status: "ready" } });
  });

  it("does not let reconciliation overwrite a checkout that changed after its read", async () => {
    const creating = await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    await storage.workspaceRegistry.setCheckoutStatus(creating.workspace.id, "local", "ready");

    const changed = await storage.workspaceRegistry.setCheckoutStatusIfCurrent(
      creating.workspace.id,
      "local",
      { status: "creating", updatedAt: creating.checkout.updated_at },
      "error",
      "Worktree is missing",
    );

    expect(changed).toBe(false);
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ status: "ready", error: null });
  });
});

describe("workspace registry schema migration", () => {
  it("removes the legacy global target/path uniqueness without losing rows", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vdx-workspace-registry-migration-"));
    const dbPath = path.join(dir, "test.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT, remote_path TEXT,
        is_remote INTEGER DEFAULT 0, remote_url TEXT, remote_api_key TEXT,
        remote_project_id TEXT, user_id TEXT NOT NULL DEFAULT 'local',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id, branch)
      );
      CREATE TABLE workspace_checkouts (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, target_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL, expected_branch TEXT NOT NULL, status TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, target_id), UNIQUE(target_id, worktree_path)
      );
      INSERT INTO projects (id, name, path) VALUES ('p1', 'project', '/repo');
      INSERT INTO workspaces VALUES ('w1', 'p1', 'dev', 'ready', NULL, 'now', 'now');
      INSERT INTO workspace_checkouts
        VALUES ('c1', 'w1', 'remote-1', '/remote/dev', 'dev', 'ready', NULL, 'now', 'now');
    `);
    legacy.close();

    const migrated = await createSqliteStorage(dbPath);
    try {
      await migrated.projects.create({ id: "p2", name: "alias", path: "/repo" });
      await expect(migrated.workspaceRegistry.registerReadyCheckout({
        projectId: "p2", branch: "dev", targetId: "remote-1",
        worktreePath: "/remote/dev", expectedBranch: "dev",
      })).resolves.toMatchObject({ checkout: { status: "ready" } });
      expect(await migrated.workspaceRegistry.getByProjectBranch("p1", "dev", "remote-1"))
        .toMatchObject({ checkout: { id: "c1" } });
    } finally {
      await migrated.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
