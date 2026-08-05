#!/usr/bin/env node
// One-off data hygiene for the workspace-binding migration.
//
// Removes rows that reference a project which no longer exists. These are
// unreachable in the UI and can never be bound to a workspace checkout, so
// they would otherwise sit in the diagnostics forever as `project_missing`.
//
// Deliberately NOT part of the automatic startup healing: deleting user data
// is an operator decision, while an unbound row is merely a row that falls
// back to its legacy snapshot.
//
// Usage:
//   node scripts/cleanup-orphan-sessions.mjs                 # dry run
//   node scripts/cleanup-orphan-sessions.mjs --apply
//   node scripts/cleanup-orphan-sessions.mjs --db /path/to/data.sqlite --apply

import Database from "better-sqlite3";
import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbIndex = args.indexOf("--db");
const dbPath = dbIndex >= 0
  ? args[dbIndex + 1]
  : path.join(homedir(), ".vibedeckx", "data.sqlite");

if (dbIndex >= 0 && !dbPath) {
  console.error("--db requires a path");
  process.exit(2);
}

let db;
try {
  // fileMustExist: a typo in --db must not silently create an empty database
  // and then report "nothing to clean".
  db = new Database(dbPath, { fileMustExist: true });
} catch {
  console.error(`cannot open database: ${dbPath}`);
  process.exit(2);
}
db.pragma("foreign_keys = ON");

const tableExists = (name) => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
).get(name));

if (!tableExists("agent_sessions") || !tableExists("projects")) {
  console.error(`${dbPath} is not a vibedeckx database (no agent_sessions/projects table)`);
  process.exit(2);
}

const ORPHAN_SESSIONS = `
  SELECT s.id FROM agent_sessions s
  LEFT JOIN projects p ON p.id = s.project_id
  WHERE p.id IS NULL`;
const ORPHAN_MAPPINGS = `
  SELECT m.local_session_id AS id, m.remote_server_id, m.remote_session_id
  FROM remote_session_mappings m
  LEFT JOIN projects p ON p.id = m.project_id
  WHERE p.id IS NULL`;

const orphanSessions = db.prepare(ORPHAN_SESSIONS).all();
const orphanMappings = db.prepare(ORPHAN_MAPPINGS).all();

// Reported for awareness only — never deleted. Re-attaching the remote to the
// project makes these sessions reachable again; deleting them is irreversible.
const detachedMappings = db.prepare(`
  SELECT count(*) AS count FROM remote_session_mappings m
  LEFT JOIN project_remotes pr
    ON pr.project_id = m.project_id AND pr.remote_server_id = m.remote_server_id
  JOIN projects p ON p.id = m.project_id
  WHERE pr.id IS NULL`).get().count;

console.log(`database: ${dbPath}`);
console.log(`orphan agent_sessions:        ${orphanSessions.length}`);
console.log(`orphan remote mappings:       ${orphanMappings.length}`);
console.log(`detached mappings (kept):     ${detachedMappings}`);

if (orphanSessions.length === 0 && orphanMappings.length === 0) {
  console.log("nothing to clean.");
  process.exit(0);
}

if (!apply) {
  console.log("\ndry run — re-run with --apply to delete. Back up the database first:");
  console.log(`  cp ${dbPath}{,.bak}`);
  process.exit(0);
}

// Tables holding a session id WITHOUT a foreign key: they must be cleaned
// explicitly. agent_session_entries / agent_instruction_deliveries /
// turn_snapshots are ON DELETE CASCADE and go with the session row.
const SESSION_REFS = [
  ["notification_outbox", "session_id"],
  ["notifications", "session_id"],
  ["session_search_cache", "local_session_id"],
];

const deleted = db.transaction(() => {
  const counts = {};
  const sessionIds = orphanSessions.map((row) => row.id);
  const mappingIds = orphanMappings.map((row) => row.id);
  const allIds = [...sessionIds, ...mappingIds];

  for (const [table, column] of SESSION_REFS) {
    if (!tableExists(table) || allIds.length === 0) continue;
    const stmt = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`);
    counts[table] = allIds.reduce((sum, id) => sum + stmt.run(id).changes, 0);
  }

  if (tableExists("workflow_runs") && allIds.length > 0) {
    const stmt = db.prepare(
      "DELETE FROM workflow_runs WHERE source_session_id = ? OR reviewer_session_id = ?",
    );
    counts.workflow_runs = allIds.reduce((sum, id) => sum + stmt.run(id, id).changes, 0);
  }

  if (tableExists("notification_sync_cursors") && orphanMappings.length > 0) {
    const stmt = db.prepare(
      "DELETE FROM notification_sync_cursors WHERE remote_server_id = ? AND remote_session_id = ?",
    );
    counts.notification_sync_cursors = orphanMappings.reduce(
      (sum, row) => sum + stmt.run(row.remote_server_id, row.remote_session_id).changes, 0,
    );
  }

  const sessionStmt = db.prepare("DELETE FROM agent_sessions WHERE id = ?");
  counts.agent_sessions = sessionIds.reduce((sum, id) => sum + sessionStmt.run(id).changes, 0);
  const mappingStmt = db.prepare("DELETE FROM remote_session_mappings WHERE local_session_id = ?");
  counts.remote_session_mappings = mappingIds.reduce(
    (sum, id) => sum + mappingStmt.run(id).changes, 0,
  );
  return counts;
})();

for (const [table, count] of Object.entries(deleted)) {
  if (count > 0) console.log(`deleted ${count} row(s) from ${table}`);
}
console.log("done.");
db.close();
