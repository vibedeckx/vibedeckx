import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";
import { maintainHeadBackup, headBackupDir } from "./head-backup.js";

/**
 * Relational-head backup + corruption self-heal (the 未雨绸缪 package, see
 * docs/plans/2026-08-06-session-entries-to-files.md §0.0). The promise under
 * test: losing the database file loses conversation entries at worst — the
 * relational head (projects, sessions, executors, settings) comes back.
 */
describe("head backup and corruption self-heal", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage | null;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-hb-"));
    dbPath = path.join(dir, "data.sqlite");
    storage = null;
  });
  afterEach(async () => {
    await storage?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = async () => {
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
    await storage.agentSessions.setNativeSessionId("s1", "native-uuid-1", "claude-code");
    await storage.agentSessions.upsertEntry("s1", 0, '{"seq":0}');
    await storage.agentSessions.upsertEntry("s1", 1, '{"seq":1}');
    await storage.close();
    storage = null;
  };

  const todaysBackup = () =>
    path.join(headBackupDir(dbPath), `head-${new Date().toISOString().slice(0, 10)}.sqlite`);

  it("captures the relational head verbatim and excludes the entries table", async () => {
    await seed();
    maintainHeadBackup(dbPath);

    const backup = new Database(todaysBackup(), { readonly: true });
    try {
      const tables = (backup.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'",
      ).all() as { name: string }[]).map((r) => r.name);
      expect(tables).toContain("projects");
      expect(tables).toContain("agent_sessions");
      expect(tables).not.toContain("agent_session_entries");

      expect(backup.prepare("SELECT id FROM projects").all()).toEqual([{ id: "p1" }]);
      expect(backup.prepare("SELECT native_session_id FROM agent_sessions WHERE id='s1'").get())
        .toEqual({ native_session_id: "native-uuid-1" });
      // The native-id history rides along — recovery needs every transcript
      // association, not just the newest.
      expect(backup.prepare("SELECT native_session_id FROM agent_session_native_ids WHERE session_id='s1'").all())
        .toEqual([{ native_session_id: "native-uuid-1" }]);
    } finally {
      backup.close();
    }
  });

  it("writes at most one backup per day and prunes beyond the retention count", async () => {
    await seed();
    const dir = headBackupDir(dbPath);
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 9; i++) {
      writeFileSync(path.join(dir, `head-2020-01-0${i}.sqlite`), "old");
    }

    maintainHeadBackup(dbPath);
    maintainHeadBackup(dbPath); // second run same day: no-op, still prunes

    const kept = readdirSync(dir).sort();
    expect(kept).toHaveLength(7);
    expect(kept.at(-1)).toBe(path.basename(todaysBackup()));
    expect(kept).not.toContain("head-2020-01-01.sqlite");
  });

  it("quarantines a corrupt database, restores the head, and recreates entries empty", async () => {
    await seed();
    maintainHeadBackup(dbPath);

    // Clobber the file header — the next open dies with SQLITE_NOTADB.
    writeFileSync(dbPath, "this is no longer a sqlite database");

    storage = await createSqliteStorage(dbPath);

    // Head restored: project, session, and the join key to the CLI transcript.
    expect(await storage.projects.getById("p1")).toMatchObject({ id: "p1" });
    expect(await storage.agentSessions.getById("s1"))
      .toMatchObject({ id: "s1", native_session_id: "native-uuid-1" });
    // Entries are not part of the head backup — recreated empty, not missing.
    expect(await storage.agentSessions.getEntries("s1")).toEqual([]);
    // The damaged file is preserved for post-mortem, not destroyed.
    expect(readdirSync(dir).some((f) => f.startsWith("data.sqlite.corrupt-"))).toBe(true);
  });

  it("starts fresh when a corrupt database has no backup to restore from", async () => {
    writeFileSync(dbPath, "garbage from day one");

    storage = await createSqliteStorage(dbPath);

    expect(await storage.projects.getAll()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith("data.sqlite.corrupt-"))).toBe(true);
  });

  it("does not create a backup for a fresh install", async () => {
    storage = await createSqliteStorage(dbPath);
    expect(existsSync(todaysBackup())).toBe(false);
  });
});
