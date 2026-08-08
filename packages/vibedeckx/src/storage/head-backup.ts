import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, copyFileSync } from "fs";
import path from "path";

/**
 * Relational-head backup and corruption self-heal for the worker database.
 *
 * The database holds two very different kinds of data in one file: a small
 * relational head (projects, sessions, executors, settings — a few MB) and
 * `agent_session_entries`, which is ~99% of the bytes. A full-file backup
 * rotation is impractical at that size, and the entries have their own
 * recovery path anyway (agent_sessions.native_session_id joins each session
 * to the CLI's on-disk transcript). So the backup captures everything
 * EXCEPT the entries: cheap enough to run at every startup, and enough to
 * bring a machine back with all projects, workspaces, executors and settings
 * intact after the database file is lost or corrupted.
 *
 * The backup runs BEFORE the database is opened for real (see
 * createSqliteStorage): what it captures is the last state an older, known-
 * good binary left behind — so a migration that corrupts data cannot poison
 * the same day's backup on its way in.
 *
 * See docs/plans/2026-08-06-session-entries-to-files.md §0.0 (未雨绸缪包).
 */

/** Bulk tables deliberately excluded from the head backup. */
const EXCLUDED_TABLES = new Set(["agent_session_entries"]);

export const headBackupDir = (dbPath: string): string =>
  path.join(path.dirname(dbPath), "backups");

const BACKUP_PATTERN = /^head-\d{4}-\d{2}-\d{2}\.sqlite$/;

const backupFileName = (): string =>
  `head-${new Date().toISOString().slice(0, 10)}.sqlite`;

const listBackups = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  // ISO date names sort lexically = chronologically.
  return readdirSync(dir).filter((f) => BACKUP_PATTERN.test(f)).sort();
};

/**
 * Write today's head backup (skipped if it already exists) and prune old
 * generations. Throws on failure — the caller treats backup as best-effort
 * and must not let it block startup.
 */
export const maintainHeadBackup = (dbPath: string, keep = 7): void => {
  if (!existsSync(dbPath)) return; // fresh install — nothing to back up
  const dir = headBackupDir(dbPath);
  mkdirSync(dir, { recursive: true });

  const target = path.join(dir, backupFileName());
  if (!existsSync(target)) {
    const tmp = `${target}.tmp-${process.pid}`;
    try {
      writeHeadSnapshot(dbPath, tmp);
      renameSync(tmp, target);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  for (const stale of listBackups(dir).slice(0, -keep)) {
    rmSync(path.join(dir, stale), { force: true });
  }
};

/**
 * Copy every table except EXCLUDED_TABLES — schema verbatim, then rows —
 * into a fresh database file. DDL is replayed from sqlite_master rather than
 * re-stated here, so columns added by future migrations are carried without
 * this file knowing about them. One read transaction spans the whole copy,
 * so the snapshot is consistent even against a live WAL writer.
 */
const writeHeadSnapshot = (srcPath: string, outPath: string): void => {
  rmSync(outPath, { force: true });
  const dst = new Database(outPath);
  try {
    // better-sqlite3 enables foreign_keys by default. It must be OFF here:
    // tables are replayed in sqlite_master order, and a rebuilt parent (e.g.
    // agent_sessions after the FK-tighten migration) sorts AFTER children
    // that reference it — enforcement would reject the child rows.
    dst.pragma("foreign_keys = OFF");
    dst.prepare("ATTACH DATABASE ? AS src").run(srcPath);
    dst.transaction(() => {
      const objects = dst.prepare(
        `SELECT type, name, tbl_name, sql FROM src.sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
          ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`,
      ).all() as { type: string; name: string; tbl_name: string; sql: string }[];

      for (const obj of objects) {
        if (EXCLUDED_TABLES.has(obj.tbl_name)) continue;
        dst.exec(obj.sql); // unqualified DDL lands in main (= the backup file)
        if (obj.type === "table") {
          dst.exec(`INSERT INTO main."${obj.name}" SELECT * FROM src."${obj.name}"`);
        }
      }
    })();
    dst.exec("DETACH DATABASE src");
  } finally {
    dst.close();
  }
};

/**
 * True for the errors that mean "this file can no longer be trusted", as
 * opposed to a bug in our own SQL (which must keep throwing loudly).
 */
export const isCorruptionError = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB";
};

/**
 * Move the database and its WAL/SHM sidecars out of the way, preserving them
 * for post-mortem. The sidecars MUST move with the main file: a stale WAL
 * replayed against a restored backup would corrupt it again.
 */
export const quarantineCorruptDatabase = (dbPath: string): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantined = `${dbPath}.corrupt-${stamp}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      renameSync(`${dbPath}${suffix}`, `${quarantined}${suffix}`);
    }
  }
  return quarantined;
};

/**
 * Put the newest head backup in place as the database file. Returns the
 * backup used, or null when none exists (the caller then starts fresh).
 * Conversation entries are not in the backup; the recreated table starts
 * empty and native_session_id points at the CLI-side transcripts.
 */
export const restoreLatestHeadBackup = (dbPath: string): string | null => {
  const dir = headBackupDir(dbPath);
  const newest = listBackups(dir).at(-1);
  if (!newest) return null;
  const backupPath = path.join(dir, newest);
  copyFileSync(backupPath, dbPath);
  return backupPath;
};
