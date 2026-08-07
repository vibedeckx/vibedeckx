import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

/**
 * executor_groups → workspaces. A destructive migration: it rebuilds the
 * executors table and drops executor_groups, so the legacy shape has to be
 * built with raw SQL — the current schema can no longer produce it.
 *
 * The mapping is 1:1 by (project_id, branch), the key both tables used, so
 * every assertion here is about that identity surviving intact rather than
 * about any merge.
 */
describe("executor group → workspace migration", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-exec-mig-"));
    dbPath = path.join(dir, "test.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A database in the pre-migration shape: executors carry group_id, and
   * executor_groups holds the (project_id, branch) scope. `workspaces` is
   * created by the current DDL on open, so seeding a workspace row here
   * simulates a branch whose worktree the registry already knows about.
   */
  const seedLegacy = (opts: { withWorkspaceFor?: string[] } = {}) => {
    const db = new Database(dbPath);
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'deleting', 'error', 'archived')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        UNIQUE(project_id, branch),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE executor_groups (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, branch),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE executors (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        group_id TEXT,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        executor_type TEXT DEFAULT 'command',
        prompt_provider TEXT,
        cwd TEXT,
        pty INTEGER DEFAULT 1,
        position INTEGER DEFAULT 0,
        disabled_targets TEXT DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES executor_groups(id) ON DELETE CASCADE
      );
      CREATE TABLE executor_processes (
        id TEXT PRIMARY KEY,
        executor_id TEXT NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        exit_code INTEGER,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP,
        FOREIGN KEY (executor_id) REFERENCES executors(id) ON DELETE CASCADE
      );

      INSERT INTO projects (id, name, path) VALUES ('p1', 'p', '/tmp/p');

      INSERT INTO executor_groups (id, project_id, name, branch) VALUES
        ('g-main', 'p1', 'Default', ''),
        ('g-feat', 'p1', 'Executors (feat)', 'feat');

      INSERT INTO executors
        (id, project_id, group_id, name, command, executor_type, prompt_provider, cwd, pty, position, disabled_targets)
      VALUES
        ('e-main-0', 'p1', 'g-main', 'dev',   'npm run dev',   'command', NULL,    '/tmp/p', 1, 0, '["srv-1"]'),
        ('e-main-1', 'p1', 'g-main', 'build', 'npm run build', 'command', NULL,    NULL,     0, 1, '[]'),
        ('e-feat-0', 'p1', 'g-feat', 'dev',   'npm run dev',   'prompt',  'codex', NULL,     1, 0, '[]');

      INSERT INTO executor_processes (id, executor_id, pid, status, exit_code)
        VALUES ('proc-1', 'e-main-0', 4242, 'completed', 0);
    `);
    for (const branch of opts.withWorkspaceFor ?? []) {
      db.prepare(
        "INSERT INTO workspaces (id, project_id, branch, status) VALUES (@id, 'p1', @branch, 'ready')",
      ).run({ id: `ws-${branch || "main"}`, branch });
    }
    db.close();
  };

  const rows = <T>(sql: string): T[] => {
    const db = new Database(dbPath);
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };

  const open = async (): Promise<Storage> => createSqliteStorage(dbPath);

  it("maps each group onto the workspace with the same (project, branch)", async () => {
    seedLegacy({ withWorkspaceFor: ["", "feat"] });
    const storage = await open();

    const main = await storage.workspaceRegistry.getWorkspaceByProjectBranch("p1", "");
    const feat = await storage.workspaceRegistry.getWorkspaceByProjectBranch("p1", "feat");
    expect(main?.id).toBe("ws-main");
    expect(feat?.id).toBe("ws-feat");

    const mainExecutors = await storage.executors.getByWorkspaceId("ws-main");
    const featExecutors = await storage.executors.getByWorkspaceId("ws-feat");
    expect(mainExecutors.map((e) => e.id)).toEqual(["e-main-0", "e-main-1"]);
    expect(featExecutors.map((e) => e.id)).toEqual(["e-feat-0"]);

    await storage.close();
  });

  it("creates an archived workspace for a group whose branch was never registered", async () => {
    // Only the main workspace pre-exists; "feat" has to be conjured.
    seedLegacy({ withWorkspaceFor: [""] });
    const storage = await open();

    const feat = await storage.workspaceRegistry.getWorkspaceByProjectBranch("p1", "feat");
    expect(feat).toBeDefined();
    // No live checkout backs it — "archived" is the registry's own word for
    // that, and recomputeWorkspace promotes it once a real checkout lands.
    expect(feat?.status).toBe("archived");
    expect((await storage.executors.getByWorkspaceId(feat!.id)).map((e) => e.id)).toEqual(["e-feat-0"]);

    await storage.close();
  });

  it("preserves every executor column, per-workspace order, and process history", async () => {
    seedLegacy({ withWorkspaceFor: ["", "feat"] });
    const storage = await open();

    const [dev, build] = await storage.executors.getByWorkspaceId("ws-main");
    expect(dev).toMatchObject({
      id: "e-main-0", project_id: "p1", workspace_id: "ws-main",
      name: "dev", command: "npm run dev", executor_type: "command",
      prompt_provider: null, cwd: "/tmp/p", pty: true, position: 0,
      disabled_targets: ["srv-1"],
    });
    expect(build).toMatchObject({
      id: "e-main-1", name: "build", pty: false, position: 1, cwd: null,
    });
    const [feat] = await storage.executors.getByWorkspaceId("ws-feat");
    expect(feat).toMatchObject({
      executor_type: "prompt", prompt_provider: "codex", position: 0,
    });

    // executor_processes is FK-bound to executors; the table rebuild must not
    // have taken its rows with it.
    const history = await storage.executorProcesses.getLastByExecutorId("e-main-0");
    expect(history).toMatchObject({ id: "proc-1", pid: 4242, status: "completed" });

    await storage.close();
  });

  it("moves executors with a NULL or dangling group into the main workspace", async () => {
    seedLegacy({ withWorkspaceFor: ["", "feat"] });
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = OFF");
    raw.exec(`
      INSERT INTO executors (id, project_id, group_id, name, command, position)
        VALUES ('e-null', 'p1', NULL, 'orphan-null', 'echo null', 0),
               ('e-gone', 'p1', 'g-deleted', 'orphan-dangling', 'echo gone', 0);
    `);
    raw.close();

    const storage = await open();
    const mainIds = (await storage.executors.getByWorkspaceId("ws-main")).map((e) => e.id);
    expect(mainIds).toContain("e-null");
    expect(mainIds).toContain("e-gone");
    // Renumbering is per workspace, so the merged-in rows cannot collide with
    // the positions the main workspace's own executors already held.
    const positions = (await storage.executors.getByWorkspaceId("ws-main")).map((e) => e.position);
    expect(positions).toEqual([...new Set(positions)]);
    expect(positions).toEqual([0, 1, 2, 3]);

    await storage.close();
  });

  it("drops executor_groups and leaves no FK violations, and reopening is a no-op", async () => {
    seedLegacy({ withWorkspaceFor: ["", "feat"] });
    let storage = await open();
    await storage.close();

    expect(rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='executor_groups'",
    )).toEqual([]);
    expect(rows("PRAGMA foreign_key_check")).toEqual([]);

    const before = rows("SELECT * FROM executors ORDER BY id");
    storage = await open();
    await storage.close();
    expect(rows("SELECT * FROM executors ORDER BY id")).toEqual(before);
    expect(rows("PRAGMA foreign_key_check")).toEqual([]);
  });
});
