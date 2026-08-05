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
import { createCrossRemoteAuditRepo } from "./repositories/cross-remote-audit.js";
import { createMergeTargetsRepo } from "./repositories/merge-targets.js";
import { createSearchCacheRepos } from "./repositories/search-cache.js";
import { createWorkflowRunRepos } from "./repositories/workflow-runs.js";
import { createTurnSnapshotRepos } from "./repositories/turn-snapshots.js";
import { createNotificationRepos } from "./repositories/notifications.js";
import { createProjectChatRepos } from "./repositories/project-chat.js";
import { createWorkspaceRegistryRepo } from "./repositories/workspace-registry.js";

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
      user_id TEXT NOT NULL DEFAULT 'local',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS workspaces (
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

    CREATE TABLE IF NOT EXISTS workspace_checkouts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      expected_branch TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'deleting', 'error')),
      error TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_project_status
      ON workspaces(project_id, status, branch);
    CREATE INDEX IF NOT EXISTS idx_workspace_checkouts_workspace_status
      ON workspace_checkouts(workspace_id, status, target_id);

    CREATE TABLE IF NOT EXISTS project_chat_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      archived_at INTEGER,
      create_request_id TEXT,
      create_payload_hash TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_project_chat_threads_project_user_updated_id
      ON project_chat_threads(project_id, user_id, updated_at DESC, id DESC);

    DROP INDEX IF EXISTS idx_project_chat_threads_project_user_updated;

    CREATE TABLE IF NOT EXISTS project_chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN (
        'user', 'assistant', 'system', 'tool_use', 'tool_result',
        'tool_approval_request', 'operation', 'error', 'turn_end'
      )),
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(thread_id, sequence),
      FOREIGN KEY (thread_id) REFERENCES project_chat_threads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_chat_work_items (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'accepted', 'running', 'completed', 'stopped', 'failed'
      )),
      attempt INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES project_chat_threads(id) ON DELETE CASCADE,
      FOREIGN KEY (user_message_id) REFERENCES project_chat_messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_project_chat_work_items_thread_status_created_id
      ON project_chat_work_items(thread_id, status, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_project_chat_work_items_recovery
      ON project_chat_work_items(status, created_at, id, thread_id);

    CREATE TABLE IF NOT EXISTS project_chat_context_refs (
      thread_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN (
        'task', 'workspace', 'agent_session', 'schedule', 'schedule_run'
      )),
      entity_id TEXT NOT NULL,
      last_referenced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (thread_id, entity_type, entity_id),
      FOREIGN KEY (thread_id) REFERENCES project_chat_threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_project_chat_context_refs_thread_recency
      ON project_chat_context_refs(thread_id, last_referenced_at DESC, entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS project_chat_operations (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
      thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 512),
      project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 512),
      user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 512),
      kind TEXT NOT NULL CHECK (kind IN (
        'task_create', 'task_update', 'agent_session_create',
        'agent_instruction', 'schedule_run', 'workspace_selection'
      )),
      payload_version INTEGER NOT NULL CHECK (payload_version = 1),
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'resolving', 'running', 'completed', 'failed'
      )),
      entity_type TEXT CHECK (entity_type IS NULL OR entity_type IN (
        'task', 'workspace', 'agent_session', 'schedule', 'schedule_run'
      )),
      entity_id TEXT CHECK (entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 512),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
      payload TEXT NOT NULL CHECK (
        length(payload) <= 32768 AND json_valid(payload)
        AND coalesce(json_type(payload, '$.version') = 'integer', 0)
        AND coalesce(json_type(payload, '$.kind') = 'text', 0)
        AND json_extract(payload, '$.version') = payload_version
        AND json_extract(payload, '$.kind') = kind
      ),
      error TEXT CHECK (error IS NULL OR length(error) <= 1024),
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(thread_id, idempotency_key),
      FOREIGN KEY (thread_id) REFERENCES project_chat_threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_project_chat_operations_thread_status_created_id
      ON project_chat_operations(thread_id, status, created_at, id);

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
      user_id TEXT NOT NULL DEFAULT 'local',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      workspace_checkout_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      title TEXT DEFAULT NULL,
      -- Per-session agent model, e.g. 'opus' or 'gpt-5.6-sol'. NULL = use the
      -- CLI's own default (no flag is passed). Never validated: an unknown
      -- name is passed to the CLI and fails there.
      model TEXT DEFAULT NULL,
      -- Millisecond-precision timestamps. CURRENT_TIMESTAMP is seconds-only,
      -- which lets two sessions tie on updated_at within the same second and
      -- corrupts the ordering used by getLatestByBranch. The 'YYYY-MM-DD
      -- HH:MM:SS.fff' format remains lex-sortable (and lex-comparable with
      -- existing seconds-only rows, which correctly sort earlier).
      created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      activity_at INTEGER DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)),
      -- Branch activity tracking (epoch ms). NULL = event has not occurred.
      -- Drives the workspace-status derivation; see plans/branch-activity-refactor.md.
      last_user_message_at INTEGER DEFAULT NULL,
      last_completed_at INTEGER DEFAULT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_instruction_deliveries (
      session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
      claim_token TEXT,
      owner_token TEXT,
      lease_expires_at INTEGER,
      created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      PRIMARY KEY (session_id, idempotency_key),
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
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
      workspace_checkout_id TEXT DEFAULT NULL,
      title_resolved INTEGER NOT NULL DEFAULT 0
    );

    -- Audit trail for cross-remote MCP gateway calls (one remote diagnosing
    -- another through the server-side gateway). No FK to remote_servers:
    -- audit rows must outlive deletion of the remote they describe. seq is
    -- the sort key (not created_at) because datetime('now') has one-second
    -- resolution and audit rows can be inserted multiple times per second.
    CREATE TABLE IF NOT EXISTS cross_remote_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_remote_id TEXT,
      target_remote_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_summary TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cross_remote_audit_target ON cross_remote_audit(target_remote_id, seq);
  `);

  // The original registry schema made (target_id, worktree_path) globally
  // unique. The same physical checkout can legitimately be represented by
  // multiple project aliases, so that constraint caused the second project to
  // fail permanently. SQLite cannot drop a table constraint in place; rebuild
  // only databases that still carry the old declaration.
  const workspaceCheckoutsTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_checkouts'",
  ).get() as { sql: string } | undefined;
  if (/UNIQUE\s*\(\s*target_id\s*,\s*worktree_path\s*\)/i.test(workspaceCheckoutsTable?.sql ?? "")) {
    db.transaction(() => db.exec(`
      ALTER TABLE workspace_checkouts RENAME TO workspace_checkouts_global_path_unique;
      CREATE TABLE workspace_checkouts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        expected_branch TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'deleting', 'error')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        UNIQUE(workspace_id, target_id),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      INSERT INTO workspace_checkouts
        (id, workspace_id, target_id, worktree_path, expected_branch, status, error, created_at, updated_at)
      SELECT id, workspace_id, target_id, worktree_path, expected_branch, status, error, created_at, updated_at
        FROM workspace_checkouts_global_path_unique;
      DROP TABLE workspace_checkouts_global_path_unique;
      CREATE INDEX idx_workspace_checkouts_workspace_status
        ON workspace_checkouts(workspace_id, status, target_id);
    `))();
  }

  // Workspace checkout lifecycle migration: explicit deletion leaves a
  // tombstone, and recreating the same workspace/target gets a new checkout
  // identity. Rebuild both tables together because SQLite cannot alter either
  // CHECK constraints or table-level UNIQUE constraints in place.
  const workspaceTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'",
  ).get() as { sql: string } | undefined;
  const checkoutTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_checkouts'",
  ).get() as { sql: string } | undefined;
  const checkoutColumns = db.prepare("PRAGMA table_info(workspace_checkouts)").all() as { name: string }[];
  const hasCheckoutDeletedAt = checkoutColumns.some((column) => column.name === "deleted_at");
  const needsWorkspaceLifecycleMigration = !/['\"]archived['\"]/i.test(workspaceTable?.sql ?? "")
    || !hasCheckoutDeletedAt
    || /UNIQUE\s*\(\s*workspace_id\s*,\s*target_id\s*\)/i.test(checkoutTable?.sql ?? "");
  if (needsWorkspaceLifecycleMigration) {
    const copyDeletedAt = hasCheckoutDeletedAt ? "deleted_at" : "NULL";
    db.transaction(() => db.exec(`
      ALTER TABLE workspace_checkouts RENAME TO workspace_checkouts_lifecycle_legacy;
      ALTER TABLE workspaces RENAME TO workspaces_lifecycle_legacy;
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
      CREATE TABLE workspace_checkouts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        expected_branch TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'deleting', 'error')),
        error TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      INSERT INTO workspaces (id, project_id, branch, status, error, created_at, updated_at)
        SELECT id, project_id, branch, status, error, created_at, updated_at
        FROM workspaces_lifecycle_legacy;
      INSERT INTO workspace_checkouts
        (id, workspace_id, target_id, worktree_path, expected_branch, status, error, deleted_at, created_at, updated_at)
        SELECT id, workspace_id, target_id, worktree_path, expected_branch, status, error,
               ${copyDeletedAt}, created_at, updated_at
        FROM workspace_checkouts_lifecycle_legacy;
      DROP TABLE workspace_checkouts_lifecycle_legacy;
      DROP TABLE workspaces_lifecycle_legacy;
      CREATE INDEX idx_workspaces_project_status
        ON workspaces(project_id, status, branch);
      CREATE INDEX idx_workspace_checkouts_workspace_status
        ON workspace_checkouts(workspace_id, status, target_id);
      CREATE UNIQUE INDEX idx_workspace_checkouts_active_target
        ON workspace_checkouts(workspace_id, target_id) WHERE deleted_at IS NULL;
    `))();
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_checkouts_active_target
      ON workspace_checkouts(workspace_id, target_id) WHERE deleted_at IS NULL;
  `);

  const instructionDeliveryCols = db.prepare("PRAGMA table_info(agent_instruction_deliveries)").all() as { name: string }[];
  if (!instructionDeliveryCols.some((c) => c.name === "owner_token")) {
    db.exec("ALTER TABLE agent_instruction_deliveries ADD COLUMN owner_token TEXT");
  }
  if (!instructionDeliveryCols.some((c) => c.name === "lease_expires_at")) {
    db.exec("ALTER TABLE agent_instruction_deliveries ADD COLUMN lease_expires_at INTEGER");
  }

  // Project Chat mutation journal v2: persist immutable scope and an
  // independently constrained payload version. Task 5 intermediate databases
  // had neither column, so rebuild and backfill from the authoritative thread.
  const projectChatOperationInfo = db.prepare("PRAGMA table_info(project_chat_operations)").all() as { name: string }[];
  if (!projectChatOperationInfo.some((column) => column.name === "project_id")) {
    db.transaction(() => db.exec(`
      DROP INDEX IF EXISTS idx_project_chat_operations_entity_correlation;
      DROP INDEX IF EXISTS idx_project_chat_operations_thread_status_created_id;
      ALTER TABLE project_chat_operations RENAME TO project_chat_operations_v1;
      CREATE TABLE project_chat_operations (
        id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
        thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 512),
        project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 512),
        user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 512),
        kind TEXT NOT NULL CHECK (kind IN (
          'task_create', 'task_update', 'agent_session_create',
          'agent_instruction', 'schedule_run', 'workspace_selection'
        )),
        payload_version INTEGER NOT NULL CHECK (payload_version = 1),
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'resolving', 'running', 'completed', 'failed'
        )),
        entity_type TEXT CHECK (entity_type IS NULL OR entity_type IN (
          'task', 'workspace', 'agent_session', 'schedule', 'schedule_run'
        )),
        entity_id TEXT CHECK (entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 512),
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
        payload TEXT NOT NULL CHECK (
          length(payload) <= 32768 AND json_valid(payload)
          AND coalesce(json_type(payload, '$.version') = 'integer', 0)
          AND coalesce(json_type(payload, '$.kind') = 'text', 0)
          AND json_extract(payload, '$.version') = payload_version
          AND json_extract(payload, '$.kind') = kind
        ),
        error TEXT CHECK (error IS NULL OR length(error) <= 1024),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(thread_id, idempotency_key),
        FOREIGN KEY (thread_id) REFERENCES project_chat_threads(id) ON DELETE CASCADE
      );
      INSERT INTO project_chat_operations
        (id, thread_id, project_id, user_id, kind, payload_version, status,
         entity_type, entity_id, idempotency_key, payload, error, created_at, updated_at)
      SELECT operation.id, operation.thread_id, thread.project_id, thread.user_id,
             operation.kind, 1, operation.status, operation.entity_type,
             operation.entity_id, operation.idempotency_key, operation.payload,
             operation.error, operation.created_at, operation.updated_at
        FROM project_chat_operations_v1 operation
        JOIN project_chat_threads thread ON thread.id = operation.thread_id;
      DROP TABLE project_chat_operations_v1;
      CREATE INDEX idx_project_chat_operations_entity_correlation
        ON project_chat_operations(project_id, entity_type, entity_id, status, id);
      CREATE INDEX idx_project_chat_operations_thread_status_created_id
        ON project_chat_operations(thread_id, status, created_at, id);
    `))();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project_chat_operations_entity_correlation
      ON project_chat_operations(project_id, entity_type, entity_id, status, id);
    DROP TRIGGER IF EXISTS project_chat_operations_scope_insert;
    DROP TRIGGER IF EXISTS project_chat_operations_scope_update;
    DROP TRIGGER IF EXISTS project_chat_operations_immutable;
    CREATE TRIGGER project_chat_operations_scope_insert
      BEFORE INSERT ON project_chat_operations
      WHEN NOT EXISTS (
        SELECT 1 FROM project_chat_threads thread
         WHERE thread.id = NEW.thread_id
           AND thread.project_id = NEW.project_id
           AND thread.user_id = NEW.user_id
      )
      BEGIN SELECT RAISE(ABORT, 'project chat operation scope mismatch'); END;
    CREATE TRIGGER project_chat_operations_scope_update
      BEFORE UPDATE ON project_chat_operations
      WHEN NOT EXISTS (
        SELECT 1 FROM project_chat_threads thread
         WHERE thread.id = NEW.thread_id
           AND thread.project_id = NEW.project_id
           AND thread.user_id = NEW.user_id
      )
      BEGIN SELECT RAISE(ABORT, 'project chat operation scope mismatch'); END;
    CREATE TRIGGER project_chat_operations_immutable
      BEFORE UPDATE ON project_chat_operations
      WHEN OLD.id != NEW.id OR OLD.thread_id != NEW.thread_id
        OR OLD.project_id != NEW.project_id OR OLD.user_id != NEW.user_id
        OR OLD.kind != NEW.kind OR OLD.payload_version != NEW.payload_version
        OR OLD.idempotency_key != NEW.idempotency_key
      BEGIN SELECT RAISE(ABORT, 'project chat operation immutable fields changed'); END;
  `);
  const projectChatOperationCols = db.prepare("PRAGMA table_info(project_chat_operations)").all() as { name: string }[];
  if (!projectChatOperationCols.some((c) => c.name === "retry_count")) {
    db.exec("ALTER TABLE project_chat_operations ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!projectChatOperationCols.some((c) => c.name === "next_retry_at")) {
    db.exec("ALTER TABLE project_chat_operations ADD COLUMN next_retry_at INTEGER");
  }

  const projectChatThreadInfo = db.prepare("PRAGMA table_info(project_chat_threads)").all() as { name: string }[];
  if (!projectChatThreadInfo.some((column) => column.name === "create_request_id")) {
    db.exec("ALTER TABLE project_chat_threads ADD COLUMN create_request_id TEXT");
  }
  if (!projectChatThreadInfo.some((column) => column.name === "create_payload_hash")) {
    db.exec("ALTER TABLE project_chat_threads ADD COLUMN create_payload_hash TEXT");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_chat_threads_create_request
      ON project_chat_threads(project_id, user_id, create_request_id)
      WHERE create_request_id IS NOT NULL;
  `);

  const projectChatWorkInfo = db.prepare("PRAGMA table_info(project_chat_work_items)").all() as { name: string }[];
  if (!projectChatWorkInfo.some((column) => column.name === "attempt")) {
    db.exec("ALTER TABLE project_chat_work_items ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
  }

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
    db.exec("ALTER TABLE projects ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)");
  }
  // Solo-mode projects created before Project Chat used the empty-string owner
  // sentinel. Project Chat uses the non-empty "local" principal, so normalize
  // those legacy rows once at open rather than weakening scoped authorization.
  db.exec("UPDATE projects SET user_id = 'local' WHERE user_id = ''");

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

  // Migration: add model column to agent_sessions (per-session agent model;
  // NULL = CLI default).
  const sessionInfoV7 = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  if (!sessionInfoV7.some(col => col.name === "model")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN model TEXT DEFAULT NULL");
  }

  // Phase 2: bind sessions to an immutable checkout incarnation. The foreign
  // key is intentionally deferred until all legacy rows have been backfilled.
  const sessionCheckoutInfo = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  if (!sessionCheckoutInfo.some(col => col.name === "workspace_checkout_id")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN workspace_checkout_id TEXT DEFAULT NULL");
  }

  // Persist the semantic max used by Project Activity so its bounded lists
  // can use an index instead of sorting every session in a project. Legacy
  // rows are backfilled from all four historical activity sources.
  const sessionInfoV8 = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  if (!sessionInfoV8.some(col => col.name === "activity_at")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN activity_at INTEGER");
    db.exec(`UPDATE agent_sessions SET activity_at = max(
      coalesce(last_user_message_at, 0),
      coalesce(last_completed_at, 0),
      coalesce(cast((julianday(updated_at) - 2440587.5) * 86400000 as integer), 0),
      coalesce(cast((julianday(created_at) - 2440587.5) * 86400000 as integer), 0)
    )`);
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
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_activity_id
      ON agent_sessions(project_id, activity_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_checkout
      ON agent_sessions(workspace_checkout_id, updated_at DESC);
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

  // Primary remote is represented by sort_order = 0. Older databases could
  // contain tied orders because new links previously defaulted to zero.
  // Normalize deterministically on every startup; the pass is idempotent.
  db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, project_id
      FROM project_remotes
      ORDER BY project_id ASC, sort_order ASC, rowid ASC
    `).all() as { id: string; project_id: string }[];
    const nextOrder = new Map<string, number>();
    const update = db.prepare("UPDATE project_remotes SET sort_order = ? WHERE id = ?");
    for (const row of rows) {
      const sortOrder = nextOrder.get(row.project_id) ?? 0;
      update.run(sortOrder, row.id);
      nextOrder.set(row.project_id, sortOrder + 1);
    }
  })();

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
      ALTER TABLE remote_servers ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
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
        user_id TEXT NOT NULL DEFAULT 'local',
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
          user_id TEXT NOT NULL DEFAULT 'local',
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

  // Migration: per-remote cross-remote access tier ('off' | 'read' | 'exec')
  // Placed after the user_id and url-nullable rebuild migrations above (not immediately
  // after the reverse-connect block) because those rebuilds recreate remote_servers via
  // CREATE TABLE remote_servers_new + an explicit INSERT INTO ... SELECT column list. On
  // a brand-new database both of those migrations always run (a fresh CREATE TABLE has
  // neither user_id nor a NOT NULL url), and neither rebuild's column list mentions
  // cross_remote_access, so a column added before them would be silently dropped.
  const remoteServerAccessInfo = db.prepare("PRAGMA table_info(remote_servers)").all() as { name: string }[];
  if (!remoteServerAccessInfo.some(col => col.name === "cross_remote_access")) {
    db.exec("ALTER TABLE remote_servers ADD COLUMN cross_remote_access TEXT NOT NULL DEFAULT 'off'");
  }

  // Canonicalize solo-mode ownership. Older schemas defaulted user_id to the
  // empty string, which both made browser routes accidentally unscoped and
  // prevented a local project from associating its local remote server. Rebuild
  // transactionally so the column default is fixed as well as existing rows;
  // the PRAGMA/data predicate makes this safe to run on every open.
  {
    const ownerInfo = db.prepare("PRAGMA table_info(remote_servers)").all() as {
      name: string;
      dflt_value: string | null;
    }[];
    const ownerColumn = ownerInfo.find((column) => column.name === "user_id");
    const hasBlankOwner = !!db.prepare(
      "SELECT 1 FROM remote_servers WHERE user_id = '' LIMIT 1",
    ).get();
    if (ownerColumn?.dflt_value !== "'local'" || hasBlankOwner) {
      db.exec(`
        BEGIN;
        CREATE TABLE remote_servers_local_owner (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT,
          api_key TEXT,
          connection_mode TEXT NOT NULL DEFAULT 'outbound',
          connect_token TEXT,
          connect_token_created_at TEXT,
          status TEXT NOT NULL DEFAULT 'unknown',
          last_connected_at TEXT,
          user_id TEXT NOT NULL DEFAULT 'local',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          cross_remote_access TEXT NOT NULL DEFAULT 'off',
          UNIQUE(url, user_id)
        );
        INSERT INTO remote_servers_local_owner (
          id, name, url, api_key, connection_mode, connect_token,
          connect_token_created_at, status, last_connected_at, user_id,
          created_at, updated_at, cross_remote_access
        )
        SELECT
          id, name, url, api_key, connection_mode, connect_token,
          connect_token_created_at, status, last_connected_at,
          CASE WHEN user_id = '' THEN 'local' ELSE user_id END,
          created_at, updated_at, cross_remote_access
        FROM remote_servers;
        DROP TABLE remote_servers;
        ALTER TABLE remote_servers_local_owner RENAME TO remote_servers;
        CREATE INDEX IF NOT EXISTS idx_remote_servers_user_id ON remote_servers(user_id);
        COMMIT;
      `);
    }
  }

  // Machine identity ownership must use the same solo sentinel as the remote
  // server token that authenticates the connection. A legacy blank pin paired
  // with a migrated local server would otherwise fail the signed ownership
  // challenge. Rebuild fixes both existing data and the column default; the
  // predicate plus transaction makes repeated opens a no-op.
  {
    const ownerInfo = db.prepare("PRAGMA table_info(machine_identity)").all() as {
      name: string;
      dflt_value: string | null;
    }[];
    const ownerColumn = ownerInfo.find((column) => column.name === "user_id");
    const hasBlankOwner = !!db.prepare(
      "SELECT 1 FROM machine_identity WHERE user_id = '' LIMIT 1",
    ).get();
    if (ownerColumn?.dflt_value !== "'local'" || hasBlankOwner) {
      db.exec(`
        BEGIN;
        CREATE TABLE machine_identity_local_owner (
          machine_id TEXT PRIMARY KEY,
          public_key TEXT NOT NULL,
          user_id TEXT NOT NULL DEFAULT 'local',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_seen_at TIMESTAMP
        );
        INSERT INTO machine_identity_local_owner (
          machine_id, public_key, user_id, created_at, last_seen_at
        )
        SELECT
          machine_id, public_key,
          CASE WHEN user_id = '' THEN 'local' ELSE user_id END,
          created_at, last_seen_at
        FROM machine_identity;
        DROP TABLE machine_identity;
        ALTER TABLE machine_identity_local_owner RENAME TO machine_identity;
        COMMIT;
      `);
    }
  }

  // Migration: worker version reporting (docs/server-worker-compat-design.md §2
  // Phase 1). Placed after every remote_servers table rebuild above — a column
  // added before them would be silently dropped by their explicit
  // CREATE TABLE ... INSERT INTO ... SELECT column lists. NULL = the worker has
  // never reported a version (pre-reporting release), deliberately distinct
  // from any real version string.
  {
    // Guarded per column: a crash between the ALTERs must not leave the later
    // columns permanently skipped on the next startup.
    const workerVersionInfo = db.prepare("PRAGMA table_info(remote_servers)").all() as { name: string }[];
    for (const column of ["worker_version", "worker_capabilities", "worker_version_reported_at"]) {
      if (!workerVersionInfo.some((col) => col.name === column)) {
        db.exec(`ALTER TABLE remote_servers ADD COLUMN ${column} TEXT`);
      }
    }
  }

  // Reset stale 'online' status for inbound remote_servers from previous server instances.
  // status='online' is only flipped to 'offline' by the WS close handler; if the host crashes
  // before the handler runs, the row stays online forever and the UI shows a green dot for an
  // unreachable remote. Real connections will re-flip to 'online' on reconnect.
  db.exec("UPDATE remote_servers SET status = 'offline' WHERE status = 'online'");

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
          user_id TEXT NOT NULL DEFAULT 'local',
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
      prompt_provider TEXT,
      content TEXT NOT NULL,
      cwd_mode TEXT NOT NULL DEFAULT 'branch',
      branch TEXT,
      directory TEXT,
      timeout_seconds INTEGER NOT NULL DEFAULT 1800,
      next_run_at TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      output TEXT,
      report TEXT,
      process_id TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP,
      FOREIGN KEY (schedule_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_schedule ON scheduled_task_runs(schedule_id);

    CREATE TABLE IF NOT EXISTS scheduled_task_execution_claims (
      schedule_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      process_id TEXT NOT NULL,
      owner_token TEXT NOT NULL DEFAULT '',
      lease_expires_at INTEGER NOT NULL DEFAULT 0,
      effect_fingerprint TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (schedule_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES scheduled_task_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_task_run_requests (
      request_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      source_run_id TEXT,
      terminal_status TEXT,
      terminal_finished_at TIMESTAMP,
      terminal_exit_code INTEGER,
      terminal_error TEXT,
      terminal_response_status INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (schedule_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_task_run_requests_schedule
      ON scheduled_task_run_requests(schedule_id, created_at DESC);
  `);

  const scheduleRequestCols = db.prepare("PRAGMA table_info(scheduled_task_run_requests)").all() as { name: string }[];
  for (const [name, declaration] of [
    ["terminal_status", "TEXT"],
    ["terminal_finished_at", "TIMESTAMP"],
    ["terminal_exit_code", "INTEGER"],
    ["terminal_error", "TEXT"],
    ["terminal_response_status", "INTEGER"],
  ] as const) {
    if (!scheduleRequestCols.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE scheduled_task_run_requests ADD COLUMN ${name} ${declaration}`);
    }
  }

  db.exec(`
    DROP TRIGGER IF EXISTS trg_scheduled_task_run_requests_validate_scope;
    DROP TRIGGER IF EXISTS trg_scheduled_task_run_requests_immutable;
    CREATE TRIGGER trg_scheduled_task_run_requests_validate_scope
    BEFORE INSERT ON scheduled_task_run_requests
    WHEN NOT EXISTS (
      SELECT 1 FROM scheduled_tasks
      WHERE id = NEW.schedule_id AND project_id = NEW.project_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'manual run request scope mismatch');
    END;
    CREATE TRIGGER trg_scheduled_task_run_requests_immutable
    BEFORE UPDATE ON scheduled_task_run_requests
    WHEN OLD.request_id IS NOT NEW.request_id
      OR OLD.run_id IS NOT NEW.run_id
      OR OLD.project_id IS NOT NEW.project_id
      OR OLD.schedule_id IS NOT NEW.schedule_id
      OR OLD.source_run_id IS NOT NEW.source_run_id
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.terminal_status IS NOT NULL
      OR NEW.terminal_status IS NULL
      OR NEW.terminal_status NOT IN ('completed', 'failed', 'timeout', 'killed', 'skipped')
      OR NEW.terminal_finished_at IS NULL
      OR NEW.terminal_response_status IS NULL
      OR NEW.terminal_response_status < 200
      OR NEW.terminal_response_status > 599
      OR LENGTH(COALESCE(NEW.terminal_error, '')) > 1000
    BEGIN
      SELECT RAISE(ABORT, 'manual run request is immutable');
    END;
  `);

  const scheduleClaimCols = db.prepare("PRAGMA table_info(scheduled_task_execution_claims)").all() as { name: string }[];
  if (!scheduleClaimCols.some((c) => c.name === "owner_token")) {
    db.exec("ALTER TABLE scheduled_task_execution_claims ADD COLUMN owner_token TEXT NOT NULL DEFAULT ''");
  }
  if (!scheduleClaimCols.some((c) => c.name === "lease_expires_at")) {
    db.exec("ALTER TABLE scheduled_task_execution_claims ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0");
  }
  if (!scheduleClaimCols.some((c) => c.name === "effect_fingerprint")) {
    db.exec("ALTER TABLE scheduled_task_execution_claims ADD COLUMN effect_fingerprint TEXT NOT NULL DEFAULT ''");
  }

  // Claimed runs remain recoverable after their owner's lease expires. Merely
  // opening another connection must not mutate a live owner's running row.
  db.exec(`UPDATE scheduled_task_runs SET status = 'killed', finished_at = CURRENT_TIMESTAMP
    WHERE status = 'running' AND id NOT IN (SELECT run_id FROM scheduled_task_execution_claims)`);
  // Compactly preserve any legacy/manual result that terminalized before the
  // outcome columns existed (including orphaned runs killed by startup fixup).
  // The immutable trigger permits this single NULL -> terminal transition.
  db.exec(`UPDATE scheduled_task_run_requests AS request SET
      terminal_status = (SELECT status FROM scheduled_task_runs WHERE id = request.run_id),
      terminal_finished_at = (SELECT COALESCE(finished_at, CURRENT_TIMESTAMP) FROM scheduled_task_runs WHERE id = request.run_id),
      terminal_exit_code = (SELECT exit_code FROM scheduled_task_runs WHERE id = request.run_id),
      terminal_error = (SELECT CASE
        WHEN status = 'skipped' THEN 'A run is already in progress'
        WHEN status = 'failed' AND process_id IS NULL AND exit_code IS NULL
          THEN SUBSTR(COALESCE(output, 'Schedule run failed to start'), 1, 1000)
        ELSE NULL END FROM scheduled_task_runs WHERE id = request.run_id),
      terminal_response_status = (SELECT CASE
        WHEN status = 'skipped' THEN 409
        WHEN status = 'failed' AND process_id IS NULL AND exit_code IS NULL THEN 400
        ELSE 200 END FROM scheduled_task_runs WHERE id = request.run_id)
    WHERE terminal_status IS NULL AND EXISTS (
      SELECT 1 FROM scheduled_task_runs
      WHERE id = request.run_id AND status NOT IN ('starting', 'running')
    )`);
  db.exec(`DELETE FROM scheduled_task_execution_claims
    WHERE run_id IN (SELECT id FROM scheduled_task_runs WHERE status NOT IN ('starting', 'running'))`);

  // Add scheduled_tasks.target for DBs created before remote-schedule support.
  const scheduledTaskCols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as { name: string }[];
  if (!scheduledTaskCols.some((c) => c.name === "target")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN target TEXT NOT NULL DEFAULT 'local'");
  }
  if (!scheduledTaskCols.some((c) => c.name === "prompt_provider")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN prompt_provider TEXT DEFAULT NULL");
  }
  if (!scheduledTaskCols.some((c) => c.name === "next_run_at")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN next_run_at TEXT");
  }

  // Add scheduled_task_runs.report for DBs created before run reports.
  const scheduledRunCols = db.prepare("PRAGMA table_info(scheduled_task_runs)").all() as { name: string }[];
  if (!scheduledRunCols.some((c) => c.name === "report")) {
    db.exec("ALTER TABLE scheduled_task_runs ADD COLUMN report TEXT DEFAULT NULL");
  }
  if (!scheduledRunCols.some((c) => c.name === "project_id")) {
    db.exec("ALTER TABLE scheduled_task_runs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE");
  }
  db.exec(`
    UPDATE scheduled_task_runs
    SET project_id = (
      SELECT scheduled_tasks.project_id
      FROM scheduled_tasks
      WHERE scheduled_tasks.id = scheduled_task_runs.schedule_id
    )
    WHERE project_id IS NULL;

    DROP TRIGGER IF EXISTS trg_scheduled_task_runs_validate_project_insert;
    DROP TRIGGER IF EXISTS trg_scheduled_task_runs_fill_project_insert;
    DROP TRIGGER IF EXISTS trg_scheduled_task_runs_immutable_scope;
    DROP TRIGGER IF EXISTS trg_scheduled_tasks_project_immutable_with_runs;

    CREATE TRIGGER trg_scheduled_task_runs_validate_project_insert
    BEFORE INSERT ON scheduled_task_runs
    WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM scheduled_tasks
      WHERE id = NEW.schedule_id AND project_id = NEW.project_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'scheduled run project does not match schedule');
    END;

    CREATE TRIGGER trg_scheduled_task_runs_fill_project_insert
    AFTER INSERT ON scheduled_task_runs
    WHEN NEW.project_id IS NULL
    BEGIN
      UPDATE scheduled_task_runs
      SET project_id = (SELECT project_id FROM scheduled_tasks WHERE id = NEW.schedule_id)
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_scheduled_task_runs_immutable_scope
    BEFORE UPDATE OF schedule_id, project_id ON scheduled_task_runs
    WHEN NEW.schedule_id IS NOT OLD.schedule_id
      OR (OLD.project_id IS NOT NULL AND NEW.project_id IS NOT OLD.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'scheduled run scope is immutable');
    END;

    CREATE TRIGGER trg_scheduled_tasks_project_immutable_with_runs
    BEFORE UPDATE OF project_id ON scheduled_tasks
    WHEN NEW.project_id IS NOT OLD.project_id
      AND EXISTS (SELECT 1 FROM scheduled_task_runs WHERE schedule_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'schedule project is immutable after runs exist');
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_merge_targets (
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      target TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, branch),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Search caches: server-side searchable copies of worker catalogs.
    -- remote_session_mappings stays routing-only; these tables are reconciled
    -- from full catalog snapshots (generation-based) and rows are soft-deleted,
    -- so wiping them never breaks existing remote session URLs.
    CREATE TABLE IF NOT EXISTS session_search_cache (
      local_session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      title TEXT,
      last_active_at INTEGER,
      favorited_at INTEGER,
      entry_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unknown',
      agent_type TEXT,
      model TEXT,
      last_user_message_at INTEGER,
      last_completed_at INTEGER,
      generation INTEGER NOT NULL,
      deleted_at INTEGER,
      written_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_session_search_cache_project
      ON session_search_cache(project_id, target_id);

    CREATE TABLE IF NOT EXISTS workspace_search_cache (
      project_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      generation INTEGER NOT NULL,
      deleted_at INTEGER,
      PRIMARY KEY (project_id, target_id, branch)
    );

    CREATE TABLE IF NOT EXISTS search_catalog_sync_state (
      project_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      last_success_at INTEGER,
      last_attempt_at INTEGER,
      snapshot_generation INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (project_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      branch TEXT,
      source_session_id TEXT NOT NULL,
      source_turn_end_index INTEGER NOT NULL,
      reviewer_session_id TEXT,
      review_focus TEXT,
      review_target TEXT,
      review_span TEXT NOT NULL DEFAULT 'this_turn',
      feedback_snapshot TEXT,
      status TEXT NOT NULL DEFAULT 'waiting_reviewer',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS turn_snapshots (
      session_id TEXT NOT NULL,
      turn_end_index INTEGER NOT NULL,
      head TEXT NOT NULL,
      dirty TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, turn_end_index),
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    );

    -- Durable attention-milestone outbox of THIS server. Written in the same
    -- transaction as the state that proves the milestone (a turn_end entry, a
    -- workflow status transition), so a crash can never leave a completed turn
    -- without its notification. Deliberately carries no title/body: the
    -- user-facing server generates copy at import time from its own session
    -- mapping, so a stale worker-side title never enters the wire protocol.
    -- No FK to agent_sessions: an outbox row must outlive deletion of the
    -- session it describes (deleting a session mid-sync must not silently drop
    -- an already-produced milestone). seq is the cursor, not created_at.
    CREATE TABLE IF NOT EXISTS notification_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch TEXT,
      session_id TEXT NOT NULL,
      workflow_run_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notification_outbox_session_seq
      ON notification_outbox(session_id, seq);

    -- User-scoped notification inbox of the user-facing server. The id is the
    -- deterministic milestone id (remote rows namespaced
    -- remote:{serverId}:{outboxEventId}), which is what makes replay after a
    -- crash-before-cursor-advance a no-op instead of a duplicate ding.
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch TEXT,
      session_id TEXT,
      workflow_run_id TEXT,
      title TEXT NOT NULL,
      body TEXT,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user_created
      ON notifications(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS notification_sync_cursors (
      remote_server_id TEXT NOT NULL,
      remote_session_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (remote_server_id, remote_session_id)
    );
  `);

  // Composite access paths used by bounded, deterministic Project Commander lists.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_project_archived_position_id
      ON tasks(project_id, archived_at, position ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_archived_status_position_id
      ON tasks(project_id, archived_at, status, position ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_archived_status_priority_position_id
      ON tasks(project_id, archived_at, status, priority, position ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_updated_id
      ON agent_sessions(project_id, updated_at DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_remote_session_mappings_project_local
      ON remote_session_mappings(project_id, local_session_id ASC);
    CREATE INDEX IF NOT EXISTS idx_workspace_search_cache_project_target_branch
      ON workspace_search_cache(project_id, deleted_at, target_id ASC, branch ASC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project_created_id
      ON scheduled_tasks(project_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project_enabled_next_run
      ON scheduled_tasks(project_id, enabled, next_run_at ASC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_schedule_started_id
      ON scheduled_task_runs(schedule_id, started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_project_started_id
      ON scheduled_task_runs(project_id, started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_project_status
      ON scheduled_task_runs(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_project_attention_finished_id
      ON scheduled_task_runs(
        project_id,
        coalesce(finished_at, started_at) DESC,
        id DESC
      ) WHERE status IN ('failed', 'timeout');
  `);

  // Migration: per-mapping notification sync provenance + watch window.
  // Existing mappings default to 'from_now' ON PURPOSE — an upgrade (or a
  // rebuilt front database attached to a long-lived worker) must not backfill
  // months of historical worker milestones as new unread notifications and a
  // sound storm. Only sessions this front newly creates get 'from_start'.
  const remoteMappingNotifyInfo = db.prepare("PRAGMA table_info(remote_session_mappings)").all() as { name: string }[];
  if (!remoteMappingNotifyInfo.some((col) => col.name === "notification_sync_start")) {
    db.exec("ALTER TABLE remote_session_mappings ADD COLUMN notification_sync_start TEXT NOT NULL DEFAULT 'from_now'");
  }
  if (!remoteMappingNotifyInfo.some((col) => col.name === "notification_watch_until")) {
    db.exec("ALTER TABLE remote_session_mappings ADD COLUMN notification_watch_until INTEGER");
  }
  if (!remoteMappingNotifyInfo.some((col) => col.name === "workspace_checkout_id")) {
    db.exec("ALTER TABLE remote_session_mappings ADD COLUMN workspace_checkout_id TEXT DEFAULT NULL");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_session_mappings_workspace_checkout
    ON remote_session_mappings(workspace_checkout_id)`);

  // Migration: add written_at to session_search_cache — the timestamp of the
  // last out-of-band write-through (session create/delete/title transiting the
  // server). Snapshot reconciliation only overrides rows whose write-through
  // is older than the snapshot's collection time.
  const sessionSearchCacheInfo = db.prepare("PRAGMA table_info(session_search_cache)").all() as { name: string }[];
  if (!sessionSearchCacheInfo.some((col) => col.name === "written_at")) {
    db.exec("ALTER TABLE session_search_cache ADD COLUMN written_at INTEGER");
  }
  if (!sessionSearchCacheInfo.some((col) => col.name === "status")) {
    db.exec("ALTER TABLE session_search_cache ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!sessionSearchCacheInfo.some((col) => col.name === "agent_type")) {
    db.exec("ALTER TABLE session_search_cache ADD COLUMN agent_type TEXT");
  }
  if (!sessionSearchCacheInfo.some((col) => col.name === "model")) {
    db.exec("ALTER TABLE session_search_cache ADD COLUMN model TEXT");
  }
  if (!sessionSearchCacheInfo.some((col) => col.name === "last_user_message_at")) {
    db.exec("ALTER TABLE session_search_cache ADD COLUMN last_user_message_at INTEGER");
  }
  if (!sessionSearchCacheInfo.some((col) => col.name === "last_completed_at")) {
    db.exec("ALTER TABLE session_search_cache ADD COLUMN last_completed_at INTEGER");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_search_cache_project_activity
    ON session_search_cache(project_id, deleted_at, last_active_at DESC, local_session_id ASC, target_id)`);

  // Migration: add review_span to workflow_runs — the review-scope span
  // (this_turn default, or session_start). Existing rows default to this_turn.
  const workflowRunsInfo = db.prepare("PRAGMA table_info(workflow_runs)").all() as { name: string }[];
  if (!workflowRunsInfo.some((col) => col.name === "review_span")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN review_span TEXT NOT NULL DEFAULT 'this_turn'");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
  `);

  // Migrate legacy user-level settings out of global_settings. These three
  // keys used to be server-global; in SaaS multi-user mode that meant every
  // tenant shared one row (including chat_provider API keys). Copy them to
  // the "local" pseudo-user (the row no-auth mode reads), then delete the
  // global rows so no shared secret lingers. Under Clerk auth the "local"
  // rows are inert — real users start from defaults, which is intentional:
  // the old shared chat_provider key must not fall back to every tenant.
  // INSERT OR IGNORE keeps this idempotent and never clobbers a newer
  // user_settings row.
  const migrateUserSettings = db.transaction(() => {
    const USER_LEVEL_KEYS = ["terminal", "conversation", "chat_provider"];
    const placeholders = USER_LEVEL_KEYS.map(() => "?").join(", ");
    db.prepare(
      `INSERT OR IGNORE INTO user_settings (user_id, key, value)
       SELECT 'local', key, value FROM global_settings WHERE key IN (${placeholders})`,
    ).run(...USER_LEVEL_KEYS);
    db.prepare(`DELETE FROM global_settings WHERE key IN (${placeholders})`).run(...USER_LEVEL_KEYS);
  });
  migrateUserSettings();

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
    ...createWorkspaceRegistryRepo(kdb, h),
    ...createRemoteServerRepos(kdb, h),
    ...createExecutorRepos(kdb, h),
    ...createScheduledRepos(kdb, h),
    ...createAgentSessionRepos(kdb, h),
    ...createWorkspaceRepos(kdb, h),
    ...createCrossRemoteAuditRepo(kdb),
    ...createMergeTargetsRepo(kdb),
    ...createSearchCacheRepos(kdb, h),
    ...createWorkflowRunRepos(kdb),
    ...createTurnSnapshotRepos(kdb),
    ...createNotificationRepos(kdb),
    ...createProjectChatRepos(kdb),

    close: async () => {
      // kdb.destroy() tears down the Kysely driver, which for SqliteDialect
      // calls db.close() on the wrapped better-sqlite3 handle — no separate
      // db.close() needed (verified against kysely's SqliteDriver.destroy()).
      await kdb.destroy();
    },
  };
};
