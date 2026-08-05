import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";
import { bindRemoteSessionMapping } from "../remote-agent-sessions.js";

/**
 * Phase 7: `workspace_checkout_id` becomes a real foreign key. The risk is not
 * the constraint itself but the table rebuild that installs it — three child
 * tables reference `agent_sessions`, and project deletion reaches checkouts by
 * a different path than it reaches sessions.
 */
describe("workspace checkout foreign key", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;

  const openRaw = () => new Database(dbPath);
  const ddl = (db: Database.Database, table: string) => (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) as { sql: string }).sql;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-fk-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const registerCheckout = (branch: string, targetId = "local") =>
    storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch, targetId,
      worktreePath: `/tmp/p-${branch || "main"}`, expectedBranch: branch,
    });

  it("enforces the key at runtime instead of merely declaring it", async () => {
    const raw = openRaw();
    try {
      expect(ddl(raw, "agent_sessions")).toMatch(/REFERENCES workspace_checkouts/);
      expect(ddl(raw, "remote_session_mappings")).toMatch(/REFERENCES workspace_checkouts/);
      // The rebuild drops and recreates the parent table; the children must
      // still point at it, not at the temporary name it was built under.
      for (const child of ["agent_session_entries", "turn_snapshots", "agent_instruction_deliveries"]) {
        expect(ddl(raw, child)).toMatch(/REFERENCES agent_sessions\(id\)/);
      }
      expect(raw.pragma("foreign_key_check")).toEqual([]);

      expect(() => raw.prepare(
        "INSERT INTO agent_sessions (id, project_id, branch, workspace_checkout_id) VALUES (?,?,?,?)",
      ).run("bogus", "p1", "dev", "no-such-checkout")).toThrow(/FOREIGN KEY/);
      expect(() => raw.prepare(
        `INSERT INTO remote_session_mappings
           (local_session_id, project_id, remote_server_id, remote_session_id, workspace_checkout_id)
         VALUES (?,?,?,?,?)`,
      ).run("bogus", "p1", "srv", "worker", "no-such-checkout")).toThrow(/FOREIGN KEY/);
    } finally {
      raw.close();
    }
  });

  it("keeps every row, id and timestamp across the rebuild, including unbound legacy rows", async () => {
    // Rebuild a pre-Phase-7 database by hand so the migration has real work.
    await storage.close();
    const legacy = openRaw();
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`
      CREATE TABLE agent_sessions_legacy AS SELECT * FROM agent_sessions;
      DROP TABLE agent_sessions;
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '',
        workspace_checkout_id TEXT DEFAULT NULL, status TEXT NOT NULL DEFAULT 'running',
        permission_mode TEXT DEFAULT 'edit', agent_type TEXT DEFAULT 'claude-code',
        title TEXT DEFAULT NULL, model TEXT DEFAULT NULL,
        created_at TEXT, updated_at TEXT, activity_at INTEGER,
        last_user_message_at INTEGER, last_completed_at INTEGER, favorited_at INTEGER,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      DROP TABLE agent_sessions_legacy;
      INSERT INTO agent_sessions (id, project_id, branch, created_at, updated_at, activity_at, title)
        VALUES ('legacy', 'p1', 'dev', '2026-01-01 00:00:00.000', '2026-01-02 00:00:00.000', 42, 'Old');
    `);
    legacy.close();

    storage = await createSqliteStorage(dbPath);

    const raw = openRaw();
    try {
      expect(ddl(raw, "agent_sessions")).toMatch(/REFERENCES workspace_checkouts/);
      expect(raw.prepare("SELECT * FROM agent_sessions WHERE id='legacy'").get()).toMatchObject({
        project_id: "p1",
        branch: "dev",
        // The isolated row keeps its NULL binding: an unbindable legacy row is
        // expected, and the nullable column is what lets it stay readable.
        workspace_checkout_id: null,
        title: "Old",
        created_at: "2026-01-01 00:00:00.000",
        updated_at: "2026-01-02 00:00:00.000",
        activity_at: 42,
      });
    } finally {
      raw.close();
    }
  });

  it("refuses to tighten while a dangling binding exists, and completes once it is resolved", async () => {
    const registered = await registerCheckout("dev");
    await storage.agentSessions.createBound({
      id: "s1", project_id: "p1", branch: "dev", target_id: "local",
      checkout_id: registered.checkout.id,
    });
    await storage.close();

    // Strip the key and break the binding — the shape an operator would hit
    // after restoring a session table from an older backup.
    const broken = openRaw();
    broken.pragma("foreign_keys = OFF");
    broken.exec(`
      CREATE TABLE agent_sessions_nofk AS SELECT * FROM agent_sessions;
      DROP TABLE agent_sessions;
      ALTER TABLE agent_sessions_nofk RENAME TO agent_sessions;
      UPDATE agent_sessions SET workspace_checkout_id = 'vanished' WHERE id = 's1';
    `);
    broken.close();

    storage = await createSqliteStorage(dbPath);
    const refused = openRaw();
    try {
      expect(ddl(refused, "agent_sessions")).not.toMatch(/REFERENCES workspace_checkouts/);
      // Refusing must not cost availability: the row is still readable.
      expect(await storage.agentSessions.getById("s1")).toMatchObject({ id: "s1" });
    } finally {
      refused.close();
    }

    await storage.close();
    const repaired = openRaw();
    repaired.exec("UPDATE agent_sessions SET workspace_checkout_id = NULL WHERE id = 's1'");
    repaired.close();

    storage = await createSqliteStorage(dbPath);
    const tightened = openRaw();
    try {
      expect(ddl(tightened, "agent_sessions")).toMatch(/REFERENCES workspace_checkouts/);
    } finally {
      tightened.close();
    }
  });

  it("tombstones a checkout without breaking the key, and keeps its history readable", async () => {
    const registered = await registerCheckout("dev");
    await storage.agentSessions.createBound({
      id: "s1", project_id: "p1", branch: "dev", target_id: "local",
      checkout_id: registered.checkout.id,
    });

    await expect(storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id))
      .resolves.toBeUndefined();

    expect(await storage.agentSessions.getById("s1"))
      .toMatchObject({ workspace_checkout_id: registered.checkout.id });
    const raw = openRaw();
    try {
      expect(raw.pragma("foreign_key_check")).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("deletes a project through its whole dependency graph, sessions and remote mappings alike", async () => {
    const local = await registerCheckout("dev");
    const remoteServer = await storage.remoteServers.create({ name: "worker" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: remoteServer.id, remote_path: "/repo",
    });
    const remote = await registerCheckout("dev", remoteServer.id);

    await storage.agentSessions.createBound({
      id: "s1", project_id: "p1", branch: "dev", target_id: "local",
      checkout_id: local.checkout.id,
    });
    await storage.agentSessions.upsertEntry("s1", 0, "{}");
    await storage.remoteSessionMappings.upsertBound({
      localSessionId: "m1", projectId: "p1", remoteServerId: remoteServer.id,
      remoteSessionId: "worker-1", branch: "dev", checkoutId: remote.checkout.id,
    });

    // Both cascade paths (sessions, and workspaces → checkouts) run inside this
    // one statement; a non-deferred key would fail depending on their order.
    await expect(storage.projects.delete("p1")).resolves.toBeUndefined();

    expect(await storage.agentSessions.getById("s1")).toBeUndefined();
    expect(await storage.remoteSessionMappings.getByLocal("m1")).toBeUndefined();
    const raw = openRaw();
    try {
      expect(raw.pragma("foreign_key_check")).toEqual([]);
      expect(raw.prepare("SELECT count(*) c FROM agent_session_entries").get()).toEqual({ c: 0 });
      expect(raw.prepare("SELECT count(*) c FROM workspace_checkouts").get()).toEqual({ c: 0 });
    } finally {
      raw.close();
    }
  });

  it("still binds a mapping from an old worker, resolving its conventional path to a real checkout id", async () => {
    const remoteServer = await storage.remoteServers.create({ name: "old-worker" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: remoteServer.id, remote_path: "/repo",
    });

    // No `reportedWorktreePath`: the pre-0.3.x response shape. The compatibility
    // path must still register a checkout and bind to *its* id — a derived path
    // is not a substitute for a key, and the FK would reject anything else.
    await bindRemoteSessionMapping(storage, {
      localSessionId: "m-old", projectId: "p1", remoteServerId: remoteServer.id,
      remoteSessionId: "worker-1", branch: "dev", remotePath: "/repo",
    });

    const mapping = await storage.remoteSessionMappings.getByLocal("m-old");
    const checkout = await storage.workspaceRegistry.getByProjectBranch("p1", "dev", remoteServer.id);
    expect(mapping?.workspace_checkout_id).toBe(checkout?.checkout.id);
    expect(checkout?.checkout.path_source).toBe("conventional");

    const raw = openRaw();
    try {
      expect(raw.pragma("foreign_key_check")).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("does not let an unauthorized delete strip another tenant's remote mappings", async () => {
    await storage.projects.create({ id: "owned", name: "owned", path: "/tmp/owned" }, "owner");
    const server = await storage.remoteServers.create({ name: "worker" });
    await storage.remoteSessionMappings.upsert("m-owned", "owned", server.id, "worker-1", "dev");

    await storage.projects.delete("owned", "someone-else");

    expect(await storage.projects.getById("owned", "owner")).toBeDefined();
    expect(await storage.remoteSessionMappings.getByLocal("m-owned")).toBeDefined();
  });
});
