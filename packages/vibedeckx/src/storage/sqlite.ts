import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { Storage } from "./types.js";
import type { DB } from "./schema.js";
import { sqliteHelpers } from "./dialect.js";
import { createScheduledRepos } from "./repositories/scheduled.js";
import { createCoreRepos } from "./repositories/core.js";
import { createRemoteServerRepos } from "./repositories/remote-servers.js";
import { createExecutorRepos } from "./repositories/executors.js";
import { createAgentSessionRepos } from "./repositories/agent-sessions.js";
import { createWorkspaceRepos } from "./repositories/workspace.js";

const createDatabase = (dbPath: string): BetterSqlite3Database => {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // Disable FK enforcement during schema creation/migration to avoid errors
  // when DROP TABLE + recreate migrations run on existing databases with FK references
  db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT,
      remote_path TEXT,
      is_remote INTEGER DEFAULT 0,
      remote_url TEXT,
      remote_api_key TEXT,
      remote_project_id TEXT,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS executor_groups (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, branch),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS executors (
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

    CREATE TABLE IF NOT EXISTS executor_processes (
      id TEXT PRIMARY KEY,
      executor_id TEXT NOT NULL,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP,
      FOREIGN KEY (executor_id) REFERENCES executors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS remote_executor_processes (
      local_process_id TEXT PRIMARY KEY,
      remote_server_id TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      remote_api_key TEXT NOT NULL,
      remote_process_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      project_id TEXT,
      branch TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS machine_identity (
      machine_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      title TEXT DEFAULT NULL,
      -- Millisecond-precision timestamps. CURRENT_TIMESTAMP is seconds-only,
      -- which lets two sessions tie on updated_at within the same second and
      -- corrupts the ordering used by getLatestByBranch. The 'YYYY-MM-DD
      -- HH:MM:SS.fff' format remains lex-sortable (and lex-comparable with
      -- existing seconds-only rows, which correctly sort earlier).
      created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      -- Branch activity tracking (epoch ms). NULL = event has not occurred.
      -- Drives the workspace-status derivation; see plans/branch-activity-refactor.md.
      last_user_message_at INTEGER DEFAULT NULL,
      last_completed_at INTEGER DEFAULT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    -- Note: idx_agent_sessions_project_branch and idx_agent_sessions_updated_at
    -- are created AFTER the agent_sessions column migrations (see below), so
    -- existing databases that predate the updated_at column don't fail here.

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      branch TEXT,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      branch TEXT,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS global_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT UNIQUE,
      api_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_remotes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      remote_server_id TEXT NOT NULL REFERENCES remote_servers(id),
      remote_path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      sync_up_config TEXT,
      sync_down_config TEXT,
      UNIQUE(project_id, remote_server_id)
    );

    -- Persists the in-memory remoteSessionMap so server restarts don't break
    -- existing remote-prefixed session URLs. URL/api key are NOT stored here —
    -- always derived from project_remotes(project_id, remote_server_id) at
    -- hydration time, so rotating an api key in project_remotes naturally
    -- propagates without needing to update this table.
    CREATE TABLE IF NOT EXISTS remote_session_mappings (
      local_session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      remote_server_id TEXT NOT NULL,
      remote_session_id TEXT NOT NULL,
      branch TEXT,
      title_resolved INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Migration: add title_resolved flag to remote_session_mappings so the
  // local-side AI title generator only fires once per remote session, even
  // across server restarts. Pre-existing rows are marked resolved so we
  // don't retroactively overwrite snippet titles produced by older code.
  const remoteMappingInfo = db.prepare("PRAGMA table_info(remote_session_mappings)").all() as { name: string }[];
  if (!remoteMappingInfo.some(col => col.name === "title_resolved")) {
    db.exec("ALTER TABLE remote_session_mappings ADD COLUMN title_resolved INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE remote_session_mappings SET title_resolved = 1");
  }

  // Migration: add pty column to existing executors table if not present
  const tableInfo = db.prepare("PRAGMA table_info(executors)").all() as { name: string }[];
  const hasPtyColumn = tableInfo.some((col) => col.name === "pty");
  if (!hasPtyColumn) {
    db.exec("ALTER TABLE executors ADD COLUMN pty INTEGER DEFAULT 1");
  }

  // Migration: add position column to existing executors table if not present
  const hasPositionColumn = tableInfo.some((col) => col.name === "position");
  if (!hasPositionColumn) {
    db.exec("ALTER TABLE executors ADD COLUMN position INTEGER DEFAULT 0");
    // Initialize positions based on created_at order
    db.exec(`
      UPDATE executors SET position = (
        SELECT COUNT(*) FROM executors e2
        WHERE e2.project_id = executors.project_id
        AND e2.created_at <= executors.created_at
      ) - 1
    `);
  }

  // Migration: add executor_type column to executors table
  const hasExecutorTypeColumn = tableInfo.some((col) => col.name === "executor_type");
  if (!hasExecutorTypeColumn) {
    db.exec("ALTER TABLE executors ADD COLUMN executor_type TEXT DEFAULT 'command'");
  }

  // Migration: add prompt_provider column to executors table
  const hasPromptProviderColumn = tableInfo.some((col) => col.name === "prompt_provider");
  if (!hasPromptProviderColumn) {
    db.exec("ALTER TABLE executors ADD COLUMN prompt_provider TEXT DEFAULT NULL");
  }

  // Migration: add remote project columns to existing projects table if not present
  const projectTableInfo = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  const hasIsRemoteColumn = projectTableInfo.some((col) => col.name === "is_remote");
  if (!hasIsRemoteColumn) {
    db.exec("ALTER TABLE projects ADD COLUMN is_remote INTEGER DEFAULT 0");
    db.exec("ALTER TABLE projects ADD COLUMN remote_url TEXT");
    db.exec("ALTER TABLE projects ADD COLUMN remote_api_key TEXT");
    db.exec("ALTER TABLE projects ADD COLUMN remote_project_id TEXT");
  }

  // Migration: add remote_path column and migrate existing remote projects
  const hasRemotePathColumn = projectTableInfo.some((col) => col.name === "remote_path");
  if (!hasRemotePathColumn) {
    db.exec("ALTER TABLE projects ADD COLUMN remote_path TEXT");
    // Migrate existing remote projects: move path to remote_path, clear path
    db.exec("UPDATE projects SET remote_path = path, path = NULL WHERE is_remote = 1");
  }

  // Migration: add agent_mode and executor_mode columns
  const hasAgentModeColumn = projectTableInfo.some((col) => col.name === "agent_mode");
  if (!hasAgentModeColumn) {
    db.exec("ALTER TABLE projects ADD COLUMN agent_mode TEXT DEFAULT 'local'");
    db.exec("ALTER TABLE projects ADD COLUMN executor_mode TEXT DEFAULT 'local'");
    db.exec("UPDATE projects SET agent_mode = 'local' WHERE agent_mode IS NULL");
    db.exec("UPDATE projects SET executor_mode = 'local' WHERE executor_mode IS NULL");
  }

  // Migration: add sync button config columns
  const hasSyncUpConfigColumn = projectTableInfo.some((col) => col.name === "sync_up_config");
  if (!hasSyncUpConfigColumn) {
    db.exec("ALTER TABLE projects ADD COLUMN sync_up_config TEXT");
    db.exec("ALTER TABLE projects ADD COLUMN sync_down_config TEXT");
  }

  // Migration: add user_id column for Clerk authentication
  const hasUserIdColumn = projectTableInfo.some((col) => col.name === "user_id");
  if (!hasUserIdColumn) {
    db.exec("ALTER TABLE projects ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
    db.exec("CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)");
  }

  // Migration: add executor_groups table and group_id column to executors
  const hasGroupIdColumn = tableInfo.some((col) => col.name === "group_id");
  if (!hasGroupIdColumn) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS executor_groups (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, branch),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    db.exec("ALTER TABLE executors ADD COLUMN group_id TEXT REFERENCES executor_groups(id) ON DELETE CASCADE");

    // Create a "Default" group for each project and assign existing executors to it
    const projects = db.prepare("SELECT DISTINCT project_id FROM executors").all() as { project_id: string }[];
    for (const { project_id } of projects) {
      const groupId = `default-${project_id}`;
      db.prepare(
        "INSERT OR IGNORE INTO executor_groups (id, project_id, name, branch) VALUES (@id, @project_id, 'Default', '')"
      ).run({ id: groupId, project_id });
      db.prepare(
        "UPDATE executors SET group_id = @group_id WHERE project_id = @project_id AND group_id IS NULL"
      ).run({ group_id: groupId, project_id });
    }
  }

  // Migration: add assigned_branch column to tasks table
  const taskTableInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const hasAssignedBranchColumn = taskTableInfo.some((col) => col.name === "assigned_branch");
  if (!hasAssignedBranchColumn) {
    db.exec("ALTER TABLE tasks ADD COLUMN assigned_branch TEXT DEFAULT NULL");
  }

  // Migration: add archived_at column to tasks table
  const taskArchivedInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const hasArchivedAtColumn = taskArchivedInfo.some((col) => col.name === "archived_at");
  if (!hasArchivedAtColumn) {
    db.exec("ALTER TABLE tasks ADD COLUMN archived_at INTEGER DEFAULT NULL");
  }

  // Migration: rename worktree_path to branch in agent_sessions
  const sessionTableInfo = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  const hasWorktreePathColumn = sessionTableInfo.some((col) => col.name === "worktree_path");
  if (hasWorktreePathColumn) {
    // Sessions are ephemeral - clear stale rows and recreate table
    db.exec("DROP TABLE agent_sessions");
    db.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, branch),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
  }

  // Migration: add permission_mode column to agent_sessions
  const sessionInfo2 = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  if (!sessionInfo2.some(col => col.name === "permission_mode")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN permission_mode TEXT DEFAULT 'edit'");
  }

  // Migration: add agent_type column to agent_sessions
  if (!sessionInfo2.some(col => col.name === "agent_type")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN agent_type TEXT DEFAULT 'claude-code'");
  }

  // Migration: drop UNIQUE(project_id, branch) on agent_sessions (multi-session support)
  const sessionInfoV3 = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  const hasUpdatedAtColumn = sessionInfoV3.some(col => col.name === "updated_at");
  if (!hasUpdatedAtColumn) {
    db.exec(`
      BEGIN;
      CREATE TABLE agent_sessions_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        permission_mode TEXT DEFAULT 'edit',
        agent_type TEXT DEFAULT 'claude-code',
        created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO agent_sessions_new (id, project_id, branch, status, permission_mode, agent_type, created_at, updated_at)
        SELECT id, project_id, branch, status, permission_mode, agent_type, created_at, created_at
        FROM agent_sessions;
      DROP TABLE agent_sessions;
      ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
      COMMIT;
    `);
  }

  // Migration: add title column to agent_sessions (Phase 2 Task 2.1)
  const sessionInfoV4 = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  if (!sessionInfoV4.some(col => col.name === "title")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN title TEXT DEFAULT NULL");
  }

  // Migration: add branch-activity timestamp columns (epoch ms).
  // See plans/branch-activity-refactor.md Phase 1.
  const sessionInfoV5 = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  if (!sessionInfoV5.some(col => col.name === "last_user_message_at")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN last_user_message_at INTEGER DEFAULT NULL");
  }
  if (!sessionInfoV5.some(col => col.name === "last_completed_at")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN last_completed_at INTEGER DEFAULT NULL");
  }

  // Migration: add favorited_at column for session bookmarking (epoch ms; NULL = not favorited).
  const sessionInfoV6 = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  if (!sessionInfoV6.some(col => col.name === "favorited_at")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN favorited_at INTEGER DEFAULT NULL");
  }

  // Ensure agent_sessions indexes exist. Safe to run here because either:
  //  - the fresh-DDL path created the table with all columns, or
  //  - the Task 1.1 rebuild migration above recreated the table with updated_at.
  // Must run AFTER all agent_sessions column migrations so the referenced
  // columns are guaranteed to exist. CREATE INDEX IF NOT EXISTS is idempotent.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_branch
      ON agent_sessions(project_id, branch);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated_at
      ON agent_sessions(updated_at DESC);
  `);

  // Migration: add pid column to executor_processes
  const processTableInfo = db.prepare("PRAGMA table_info(executor_processes)").all() as { name: string }[];
  if (!processTableInfo.some(col => col.name === "pid")) {
    db.exec("ALTER TABLE executor_processes ADD COLUMN pid INTEGER");
  }

  // Clean up stale "running" processes from previous server instances
  db.exec("UPDATE executor_processes SET status = 'killed', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'");

  // Migration: add status/exit_code/finished_at to remote_executor_processes so
  // rows can survive past a process's lifecycle and back the "Last run" UI.
  // Pre-existing rows default to 'running' and are then swept to 'killed' below
  // (since their owning process can't outlive the previous server instance).
  const remoteProcessTableInfo = db.prepare("PRAGMA table_info(remote_executor_processes)").all() as { name: string }[];
  if (!remoteProcessTableInfo.some(col => col.name === "status")) {
    db.exec("ALTER TABLE remote_executor_processes ADD COLUMN status TEXT NOT NULL DEFAULT 'running'");
  }
  if (!remoteProcessTableInfo.some(col => col.name === "exit_code")) {
    db.exec("ALTER TABLE remote_executor_processes ADD COLUMN exit_code INTEGER");
  }
  if (!remoteProcessTableInfo.some(col => col.name === "finished_at")) {
    db.exec("ALTER TABLE remote_executor_processes ADD COLUMN finished_at TIMESTAMP");
  }
  if (!remoteProcessTableInfo.some(col => col.name === "machine_id")) {
    db.exec("ALTER TABLE remote_executor_processes ADD COLUMN machine_id TEXT");
  }
  // Note: unlike executor_processes, we don't bulk-mark remote 'running' rows
  // as killed here. Remote processes can outlive a local restart, so the
  // shared-services restore logic verifies each row against the remote
  // server's running list and calls markFinished() for those that aren't.

  // Create agent_session_entries table for conversation persistence
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_session_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      entry_index INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, entry_index),
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    )
  `);

  // Migration: existing remote projects → remote_servers + project_remotes
  // This migrates data from the old single-remote model (remote_url on projects table)
  // into the new multi-remote model (remote_servers + project_remotes tables).
  // Idempotent: checks for existing records before inserting.
  {
    const existingRemotes = db.prepare(
      `SELECT DISTINCT remote_url, remote_api_key FROM projects WHERE remote_url IS NOT NULL AND remote_url != ''`
    ).all() as { remote_url: string; remote_api_key: string | null }[];

    for (const row of existingRemotes) {
      const existing = db.prepare(`SELECT id FROM remote_servers WHERE url = ?`).get(row.remote_url) as { id: string } | undefined;
      if (!existing) {
        let name: string;
        try { name = new URL(row.remote_url).hostname; } catch { name = row.remote_url; }
        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO remote_servers (id, name, url, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
        ).run(id, name, row.remote_url, row.remote_api_key);
      }
    }

    const projectsWithRemote = db.prepare(
      `SELECT id, remote_url, remote_path, sync_up_config, sync_down_config, agent_mode, executor_mode FROM projects WHERE remote_url IS NOT NULL AND remote_url != ''`
    ).all() as { id: string; remote_url: string; remote_path: string | null; sync_up_config: string | null; sync_down_config: string | null; agent_mode: string; executor_mode: string }[];

    for (const proj of projectsWithRemote) {
      const server = db.prepare(`SELECT id FROM remote_servers WHERE url = ?`).get(proj.remote_url) as { id: string } | undefined;
      if (!server) continue;

      const existingLink = db.prepare(
        `SELECT id FROM project_remotes WHERE project_id = ? AND remote_server_id = ?`
      ).get(proj.id, server.id);
      if (!existingLink && proj.remote_path) {
        db.prepare(
          `INSERT INTO project_remotes (id, project_id, remote_server_id, remote_path, sort_order, sync_up_config, sync_down_config) VALUES (?, ?, ?, ?, 0, ?, ?)`
        ).run(crypto.randomUUID(), proj.id, server.id, proj.remote_path, proj.sync_up_config, proj.sync_down_config);
      }

      // Update agent_mode/executor_mode from 'remote' to the corresponding remote_server_id
      if (proj.agent_mode === 'remote') {
        db.prepare(`UPDATE projects SET agent_mode = ? WHERE id = ?`).run(server.id, proj.id);
      }
      if (proj.executor_mode === 'remote') {
        db.prepare(`UPDATE projects SET executor_mode = ? WHERE id = ?`).run(server.id, proj.id);
      }
    }
  }

  // Migration: executor.disabled (global bool) → executor.disabled_targets
  // (JSON array of target ids: "local" or a remote_server_id). A disabled
  // executor becomes disabled on every current target of its project, then the
  // old column is dropped. New remotes added later default to enabled.
  const execColsForDisabled = db.prepare("PRAGMA table_info(executors)").all() as { name: string }[];
  if (!execColsForDisabled.some((c) => c.name === "disabled_targets")) {
    db.exec("ALTER TABLE executors ADD COLUMN disabled_targets TEXT DEFAULT '[]'");
  }
  if (execColsForDisabled.some((c) => c.name === "disabled")) {
    // ADD COLUMN stays outside the transaction below; the txn does only the
    // idempotent data backfill + DROP. If a crash lands between them, the next
    // startup finds disabled_targets already present (skips ADD) but disabled
    // still present (re-runs the deterministic backfill) — safe to re-enter.
    const migrateDisabled = db.transaction(() => {
      const disabledRows = db
        .prepare("SELECT id, project_id FROM executors WHERE disabled = 1")
        .all() as { id: string; project_id: string }[];
      for (const row of disabledRows) {
        const remotes = db
          .prepare("SELECT remote_server_id FROM project_remotes WHERE project_id = ?")
          .all(row.project_id) as { remote_server_id: string }[];
        const targets = ["local", ...remotes.map((r) => r.remote_server_id)];
        db.prepare("UPDATE executors SET disabled_targets = @dt WHERE id = @id").run({
          dt: JSON.stringify(targets),
          id: row.id,
        });
      }
      db.exec("ALTER TABLE executors DROP COLUMN disabled");
    });
    migrateDisabled();
  }

  // Migration: add reverse-connect columns to remote_servers
  const remoteServerTableInfo = db.prepare("PRAGMA table_info(remote_servers)").all() as { name: string }[];
  if (!remoteServerTableInfo.some(col => col.name === "connection_mode")) {
    db.exec("ALTER TABLE remote_servers ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'outbound'");
    db.exec("ALTER TABLE remote_servers ADD COLUMN connect_token TEXT");
    db.exec("ALTER TABLE remote_servers ADD COLUMN connect_token_created_at TEXT");
    db.exec("ALTER TABLE remote_servers ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'");
    db.exec("ALTER TABLE remote_servers ADD COLUMN last_connected_at TEXT");
  }

  // Migration: add user_id column and change UNIQUE(url) to UNIQUE(url, user_id) for multi-user isolation
  const remoteServerTableInfoV2 = db.prepare("PRAGMA table_info(remote_servers)").all() as { name: string }[];
  if (!remoteServerTableInfoV2.some(col => col.name === "user_id")) {
    db.exec(`
      BEGIN;
      ALTER TABLE remote_servers ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
      CREATE TABLE remote_servers_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT,
        api_key TEXT,
        connection_mode TEXT NOT NULL DEFAULT 'outbound',
        connect_token TEXT,
        connect_token_created_at TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_connected_at TEXT,
        user_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(url, user_id)
      );
      INSERT INTO remote_servers_new SELECT
        id, name, url, api_key, connection_mode, connect_token, connect_token_created_at,
        status, last_connected_at, user_id, created_at, updated_at
      FROM remote_servers;
      DROP TABLE remote_servers;
      ALTER TABLE remote_servers_new RENAME TO remote_servers;
      CREATE INDEX IF NOT EXISTS idx_remote_servers_user_id ON remote_servers(user_id);
      COMMIT;
    `);
  }

  // Migration: make url nullable in remote_servers (allows multiple inbound servers with NULL url)
  {
    const rsInfo = db.prepare("PRAGMA table_info(remote_servers)").all() as { name: string; notnull: number }[];
    const urlCol = rsInfo.find(col => col.name === "url");
    if (urlCol && urlCol.notnull === 1) {
      db.exec(`
        BEGIN;
        CREATE TABLE remote_servers_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT,
          api_key TEXT,
          connection_mode TEXT NOT NULL DEFAULT 'outbound',
          connect_token TEXT,
          connect_token_created_at TEXT,
          status TEXT NOT NULL DEFAULT 'unknown',
          last_connected_at TEXT,
          user_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(url, user_id)
        );
        INSERT INTO remote_servers_new SELECT
          id, name, url, api_key, connection_mode, connect_token, connect_token_created_at,
          status, last_connected_at, user_id, created_at, updated_at
        FROM remote_servers;
        DROP TABLE remote_servers;
        ALTER TABLE remote_servers_new RENAME TO remote_servers;
        UPDATE remote_servers SET url = NULL WHERE url = '';
        CREATE INDEX IF NOT EXISTS idx_remote_servers_user_id ON remote_servers(user_id);
        COMMIT;
      `);
    }
  }

  // Reset stale 'online' status for inbound remote_servers from previous server instances.
  // status='online' is only flipped to 'offline' by the WS close handler; if the host crashes
  // before the handler runs, the row stays online forever and the UI shows a green dot for an
  // unreachable remote. Real connections will re-flip to 'online' on reconnect.
  db.exec("UPDATE remote_servers SET status = 'offline' WHERE connection_mode = 'inbound' AND status = 'online'");

  // Migration: drop old UNIQUE(path, is_remote, remote_url) constraint on projects
  // Commit b4ef7b5 removed it from CREATE TABLE but existing databases still have it,
  // causing UNIQUE constraint failures when creating pseudo-project rows.
  {
    const oldIndex = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='projects' AND sql LIKE '%path%is_remote%remote_url%'`
    ).get() as { name: string } | undefined;
    if (oldIndex) {
      db.exec(`
        BEGIN;
        CREATE TABLE projects_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT,
          remote_path TEXT,
          is_remote INTEGER DEFAULT 0,
          remote_url TEXT,
          remote_api_key TEXT,
          remote_project_id TEXT,
          user_id TEXT NOT NULL DEFAULT '',
          agent_mode TEXT DEFAULT 'local',
          executor_mode TEXT DEFAULT 'local',
          sync_up_config TEXT,
          sync_down_config TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO projects_new SELECT
          id, name, path, remote_path, is_remote, remote_url, remote_api_key, remote_project_id,
          user_id, agent_mode, executor_mode, sync_up_config, sync_down_config, created_at
        FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects_new RENAME TO projects;
        CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
        COMMIT;
      `);
    }
  }

  // Scheduled tasks (cron-triggered executor-like runs) + their run history
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      timezone TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'local',
      enabled INTEGER NOT NULL DEFAULT 1,
      run_type TEXT NOT NULL DEFAULT 'command',
      content TEXT NOT NULL,
      cwd_mode TEXT NOT NULL DEFAULT 'branch',
      branch TEXT,
      directory TEXT,
      timeout_seconds INTEGER NOT NULL DEFAULT 1800,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      output TEXT,
      process_id TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP,
      FOREIGN KEY (schedule_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_schedule ON scheduled_task_runs(schedule_id);
  `);

  // Server died mid-run: 'running' rows from a previous instance are orphans
  // (same idiom as the executor_processes fixup earlier in this function).
  db.exec("UPDATE scheduled_task_runs SET status = 'killed', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'");

  // Add scheduled_tasks.target for DBs created before remote-schedule support.
  const scheduledTaskCols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as { name: string }[];
  if (!scheduledTaskCols.some((c) => c.name === "target")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN target TEXT NOT NULL DEFAULT 'local'");
  }

  // Re-enable FK enforcement for runtime operations
  db.pragma("foreign_keys = ON");

  return db;
};

export const createSqliteStorage = async (dbPath: string): Promise<Storage> => {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = createDatabase(dbPath); // legacy DDL/migrations, kept verbatim
  // Kysely wraps the same better-sqlite3 handle. Every repository group
  // (see storage/repositories/*.ts) consumes kdb/h via a factory function
  // spread into the returned object below — the query layer is fully on
  // Kysely; this file now only owns the legacy DDL (createDatabase) and
  // this assembly.
  const kdb = new Kysely<DB>({ dialect: new SqliteDialect({ database: db }) });
  const h = sqliteHelpers;

  return {
    ...createCoreRepos(kdb, h),
    ...createRemoteServerRepos(kdb, h),
    ...createExecutorRepos(kdb, h),
    ...createScheduledRepos(kdb, h),
    ...createAgentSessionRepos(kdb, h),
    ...createWorkspaceRepos(kdb, h),

    close: async () => {
      // kdb.destroy() tears down the Kysely driver, which for SqliteDialect
      // calls db.close() on the wrapped better-sqlite3 handle — no separate
      // db.close() needed (verified against kysely's SqliteDriver.destroy()).
      await kdb.destroy();
    },
  };
};
