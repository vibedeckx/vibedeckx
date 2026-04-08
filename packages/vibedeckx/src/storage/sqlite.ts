import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { Project, Executor, ExecutorGroup, ExecutorProcess, ExecutorProcessStatus, ExecutorType, PromptProvider, AgentSession, AgentSessionStatus, Task, TaskStatus, TaskPriority, Rule, Storage, ExecutionMode, SyncButtonConfig, RemoteServer, RemoteServerConnectionMode, RemoteServerStatus, ProjectRemote, ProjectRemoteWithServer } from "./types.js";

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

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, branch),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

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
  `);

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

  // Migration: add pid column to executor_processes
  const processTableInfo = db.prepare("PRAGMA table_info(executor_processes)").all() as { name: string }[];
  if (!processTableInfo.some(col => col.name === "pid")) {
    db.exec("ALTER TABLE executor_processes ADD COLUMN pid INTEGER");
  }

  // Clean up stale "running" processes from previous server instances
  db.exec("UPDATE executor_processes SET status = 'killed', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'");

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

  // Re-enable FK enforcement for runtime operations
  db.pragma("foreign_keys = ON");

  return db;
};

export const createSqliteStorage = async (dbPath: string): Promise<Storage> => {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = createDatabase(dbPath);

  // Helper to convert SQLite project row to Project interface
  const toProject = (row: ProjectRow): Project => ({
    id: row.id,
    name: row.name,
    path: row.path,
    is_remote: row.is_remote === 1,
    remote_path: row.remote_path ?? undefined,
    remote_url: row.remote_url ?? undefined,
    remote_api_key: row.remote_api_key ?? undefined,
    agent_mode: (row.agent_mode as ExecutionMode) ?? 'local',
    executor_mode: (row.executor_mode as ExecutionMode) ?? 'local',
    sync_up_config: row.sync_up_config ? JSON.parse(row.sync_up_config) as SyncButtonConfig : undefined,
    sync_down_config: row.sync_down_config ? JSON.parse(row.sync_down_config) as SyncButtonConfig : undefined,
    created_at: row.created_at,
  });

  type ProjectRow = {
    id: string;
    name: string;
    path: string | null;
    remote_path: string | null;
    is_remote: number;
    remote_url: string | null;
    remote_api_key: string | null;
    agent_mode: string | null;
    executor_mode: string | null;
    sync_up_config: string | null;
    sync_down_config: string | null;
    user_id: string;
    created_at: string;
  };

  type RemoteServerRow = {
    id: string;
    name: string;
    url: string | null;
    api_key: string | null;
    connection_mode: string;
    connect_token: string | null;
    connect_token_created_at: string | null;
    status: string;
    last_connected_at: string | null;
    user_id: string;
    created_at: string;
    updated_at: string;
  };

  const toRemoteServer = (row: RemoteServerRow): RemoteServer => ({
    id: row.id,
    name: row.name,
    url: row.url,
    api_key: row.api_key ?? undefined,
    connection_mode: (row.connection_mode as RemoteServer["connection_mode"]) ?? 'outbound',
    connect_token: row.connect_token ?? undefined,
    connect_token_created_at: row.connect_token_created_at ?? undefined,
    status: (row.status as RemoteServer["status"]) ?? 'unknown',
    last_connected_at: row.last_connected_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  // Helper type and mapper for executor rows
  type ExecutorRow = { id: string; project_id: string; group_id: string; name: string; command: string; executor_type: string; prompt_provider: string | null; cwd: string | null; pty: number; position: number; created_at: string };
  const mapExecutorRow = (row: ExecutorRow): Executor => ({
    ...row,
    executor_type: (row.executor_type || 'command') as ExecutorType,
    prompt_provider: (row.prompt_provider as PromptProvider) ?? null,
    pty: row.pty === 1,
  });

  return {
    projects: {
      create: ({ id, name, path: projectPath, remote_path, remote_url, remote_api_key, agent_mode, executor_mode, sync_up_config, sync_down_config }, userId?: string) => {
        const is_remote = remote_url ? 1 : 0;
        db.prepare(
          `INSERT INTO projects (id, name, path, remote_path, is_remote, remote_url, remote_api_key, agent_mode, executor_mode, sync_up_config, sync_down_config, user_id)
           VALUES (@id, @name, @path, @remote_path, @is_remote, @remote_url, @remote_api_key, @agent_mode, @executor_mode, @sync_up_config, @sync_down_config, @user_id)`
        ).run({
          id,
          name,
          path: projectPath ?? null,
          remote_path: remote_path ?? null,
          is_remote,
          remote_url: remote_url ?? null,
          remote_api_key: remote_api_key ?? null,
          agent_mode: agent_mode ?? 'local',
          executor_mode: executor_mode ?? 'local',
          sync_up_config: sync_up_config ? JSON.stringify(sync_up_config) : null,
          sync_down_config: sync_down_config ? JSON.stringify(sync_down_config) : null,
          user_id: userId ?? '',
        });

        const row = db
          .prepare<{ id: string }, ProjectRow>(`SELECT * FROM projects WHERE id = @id`)
          .get({ id })!;
        return toProject(row);
      },

      getAll: (userId?: string) => {
        if (userId) {
          const rows = db
            .prepare<{ user_id: string }, ProjectRow>(`SELECT * FROM projects WHERE user_id = @user_id ORDER BY created_at DESC`)
            .all({ user_id: userId });
          return rows.map(toProject);
        }
        const rows = db
          .prepare<{}, ProjectRow>(`SELECT * FROM projects ORDER BY created_at DESC`)
          .all({});
        return rows.map(toProject);
      },

      getById: (id: string, userId?: string) => {
        if (userId) {
          const row = db
            .prepare<{ id: string; user_id: string }, ProjectRow>(`SELECT * FROM projects WHERE id = @id AND user_id = @user_id`)
            .get({ id, user_id: userId });
          return row ? toProject(row) : undefined;
        }
        const row = db
          .prepare<{ id: string }, ProjectRow>(`SELECT * FROM projects WHERE id = @id`)
          .get({ id });
        return row ? toProject(row) : undefined;
      },

      getByPath: (projectPath: string) => {
        const row = db
          .prepare<{ path: string }, ProjectRow>(`SELECT * FROM projects WHERE path = @path`)
          .get({ path: projectPath });
        return row ? toProject(row) : undefined;
      },

      update: (id: string, opts: { name?: string; path?: string | null; remote_path?: string | null; remote_url?: string | null; remote_api_key?: string | null; agent_mode?: ExecutionMode; executor_mode?: ExecutionMode; sync_up_config?: SyncButtonConfig | null; sync_down_config?: SyncButtonConfig | null }, userId?: string) => {
        const updates: string[] = [];
        const params: Record<string, unknown> = { id };

        if (opts.name !== undefined) {
          updates.push('name = @name');
          params.name = opts.name;
        }
        if (opts.path !== undefined) {
          updates.push('path = @path');
          params.path = opts.path;
        }
        if (opts.remote_path !== undefined) {
          updates.push('remote_path = @remote_path');
          params.remote_path = opts.remote_path;
        }
        if (opts.remote_url !== undefined) {
          updates.push('remote_url = @remote_url');
          params.remote_url = opts.remote_url;
        }
        if (opts.remote_api_key !== undefined) {
          updates.push('remote_api_key = @remote_api_key');
          params.remote_api_key = opts.remote_api_key;
        }
        if (opts.agent_mode !== undefined) {
          updates.push('agent_mode = @agent_mode');
          params.agent_mode = opts.agent_mode;
        }
        if (opts.executor_mode !== undefined) {
          updates.push('executor_mode = @executor_mode');
          params.executor_mode = opts.executor_mode;
        }
        if (opts.sync_up_config !== undefined) {
          updates.push('sync_up_config = @sync_up_config');
          params.sync_up_config = opts.sync_up_config ? JSON.stringify(opts.sync_up_config) : null;
        }
        if (opts.sync_down_config !== undefined) {
          updates.push('sync_down_config = @sync_down_config');
          params.sync_down_config = opts.sync_down_config ? JSON.stringify(opts.sync_down_config) : null;
        }

        // Auto-derive is_remote from remote_url
        if (opts.remote_url !== undefined) {
          updates.push('is_remote = @is_remote');
          params.is_remote = opts.remote_url ? 1 : 0;
        }

        const ownerFilter = userId ? ' AND user_id = @user_id' : '';
        if (userId) params.user_id = userId;

        if (updates.length === 0) {
          const row = db.prepare<Record<string, unknown>, ProjectRow>(`SELECT * FROM projects WHERE id = @id${ownerFilter}`).get(params);
          return row ? toProject(row) : undefined;
        }

        db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = @id${ownerFilter}`).run(params);
        const row = db.prepare<Record<string, unknown>, ProjectRow>(`SELECT * FROM projects WHERE id = @id${ownerFilter}`).get(params);
        return row ? toProject(row) : undefined;
      },

      delete: (id: string, userId?: string) => {
        if (userId) {
          db.prepare(`DELETE FROM projects WHERE id = @id AND user_id = @user_id`).run({ id, user_id: userId });
        } else {
          db.prepare(`DELETE FROM projects WHERE id = @id`).run({ id });
        }
      },
    },

    remoteServers: {
      create: (server: { name: string; url: string | null; api_key?: string; connection_mode?: RemoteServerConnectionMode }, userId?: string): RemoteServer => {
        const id = crypto.randomUUID();
        const connectionMode = server.connection_mode ?? 'outbound';
        db.prepare(
          `INSERT INTO remote_servers (id, name, url, api_key, connection_mode, user_id) VALUES (@id, @name, @url, @api_key, @connection_mode, @user_id)`
        ).run({ id, name: server.name, url: server.url, api_key: server.api_key ?? null, connection_mode: connectionMode, user_id: userId ?? '' });

        return toRemoteServer(db
          .prepare<{ id: string }, RemoteServerRow>(`SELECT * FROM remote_servers WHERE id = @id`)
          .get({ id })!);
      },

      getAll: (userId?: string): RemoteServer[] => {
        if (userId) {
          return db
            .prepare<{ user_id: string }, RemoteServerRow>(`SELECT * FROM remote_servers WHERE user_id = @user_id ORDER BY created_at DESC`)
            .all({ user_id: userId })
            .map(toRemoteServer);
        }
        return db
          .prepare<{}, RemoteServerRow>(`SELECT * FROM remote_servers ORDER BY created_at DESC`)
          .all({})
          .map(toRemoteServer);
      },

      getById: (id: string, userId?: string): RemoteServer | undefined => {
        if (userId) {
          const row = db
            .prepare<{ id: string; user_id: string }, RemoteServerRow>(`SELECT * FROM remote_servers WHERE id = @id AND user_id = @user_id`)
            .get({ id, user_id: userId });
          return row ? toRemoteServer(row) : undefined;
        }
        const row = db
          .prepare<{ id: string }, RemoteServerRow>(`SELECT * FROM remote_servers WHERE id = @id`)
          .get({ id });
        return row ? toRemoteServer(row) : undefined;
      },

      getByUrl: (url: string): RemoteServer | undefined => {
        const row = db
          .prepare<{ url: string }, RemoteServerRow>(`SELECT * FROM remote_servers WHERE url = @url`)
          .get({ url });
        return row ? toRemoteServer(row) : undefined;
      },

      getByToken: (token: string): RemoteServer | undefined => {
        const row = db
          .prepare<{ token: string }, RemoteServerRow>(`SELECT * FROM remote_servers WHERE connect_token = @token`)
          .get({ token });
        return row ? toRemoteServer(row) : undefined;
      },

      update: (id: string, opts: { name?: string; url?: string; api_key?: string; connection_mode?: RemoteServerConnectionMode }, userId?: string): RemoteServer | undefined => {
        const updates: string[] = [];
        const params: Record<string, unknown> = { id };

        if (opts.name !== undefined) {
          updates.push('name = @name');
          params.name = opts.name;
        }
        if (opts.url !== undefined) {
          updates.push('url = @url');
          params.url = opts.url;
        }
        if (opts.api_key !== undefined) {
          updates.push('api_key = @api_key');
          params.api_key = opts.api_key;
        }
        if (opts.connection_mode !== undefined) {
          updates.push('connection_mode = @connection_mode');
          params.connection_mode = opts.connection_mode;
        }

        const ownerFilter = userId ? ' AND user_id = @user_id' : '';
        if (userId) params.user_id = userId;

        if (updates.length === 0) {
          const row = db.prepare<Record<string, unknown>, RemoteServerRow>(`SELECT * FROM remote_servers WHERE id = @id${ownerFilter}`).get(params);
          return row ? toRemoteServer(row) : undefined;
        }

        updates.push("updated_at = datetime('now')");
        db.prepare(`UPDATE remote_servers SET ${updates.join(', ')} WHERE id = @id${ownerFilter}`).run(params);
        const row = db.prepare<Record<string, unknown>, RemoteServerRow>(`SELECT * FROM remote_servers WHERE id = @id${ownerFilter}`).get(params);
        return row ? toRemoteServer(row) : undefined;
      },

      updateStatus: (id: string, status: RemoteServerStatus): void => {
        const updates = status === 'online'
          ? "status = @status, last_connected_at = datetime('now'), updated_at = datetime('now')"
          : "status = @status, updated_at = datetime('now')";
        db.prepare(`UPDATE remote_servers SET ${updates} WHERE id = @id`).run({ id, status });
      },

      generateToken: (id: string, userId?: string): string | undefined => {
        const ownerFilter = userId ? ' AND user_id = @user_id' : '';
        const params: Record<string, unknown> = { id };
        if (userId) params.user_id = userId;

        const existing = db.prepare<Record<string, unknown>, RemoteServerRow>(`SELECT * FROM remote_servers WHERE id = @id${ownerFilter}`).get(params);
        if (!existing) return undefined;
        const token = crypto.randomBytes(32).toString('hex');
        db.prepare(
          `UPDATE remote_servers SET connect_token = @token, connect_token_created_at = datetime('now'), updated_at = datetime('now') WHERE id = @id${ownerFilter}`
        ).run({ ...params, token });
        return token;
      },

      revokeToken: (id: string, userId?: string): boolean => {
        const ownerFilter = userId ? ' AND user_id = @user_id' : '';
        const params: Record<string, unknown> = { id };
        if (userId) params.user_id = userId;

        const result = db.prepare(
          `UPDATE remote_servers SET connect_token = NULL, connect_token_created_at = NULL, updated_at = datetime('now') WHERE id = @id${ownerFilter}`
        ).run(params);
        return result.changes > 0;
      },

      delete: (id: string, userId?: string): boolean => {
        if (userId) {
          const result = db.prepare(`DELETE FROM remote_servers WHERE id = @id AND user_id = @user_id`).run({ id, user_id: userId });
          return result.changes > 0;
        }
        const result = db.prepare(`DELETE FROM remote_servers WHERE id = @id`).run({ id });
        return result.changes > 0;
      },
    },

    projectRemotes: {
      getByProject: (projectId: string): ProjectRemoteWithServer[] => {
        type ProjectRemoteRow = {
          id: string;
          project_id: string;
          remote_server_id: string;
          remote_path: string;
          sort_order: number;
          sync_up_config: string | null;
          sync_down_config: string | null;
          server_name: string;
          server_url: string;
          server_api_key: string | null;
        };
        const rows = db
          .prepare<{ project_id: string }, ProjectRemoteRow>(
            `SELECT pr.id, pr.project_id, pr.remote_server_id, pr.remote_path, pr.sort_order,
                    pr.sync_up_config, pr.sync_down_config,
                    rs.name as server_name, rs.url as server_url, rs.api_key as server_api_key
             FROM project_remotes pr
             JOIN remote_servers rs ON pr.remote_server_id = rs.id
             WHERE pr.project_id = @project_id
             ORDER BY pr.sort_order ASC`
          )
          .all({ project_id: projectId });
        return rows.map((row) => ({
          id: row.id,
          project_id: row.project_id,
          remote_server_id: row.remote_server_id,
          remote_path: row.remote_path,
          sort_order: row.sort_order,
          sync_up_config: row.sync_up_config ? JSON.parse(row.sync_up_config) as SyncButtonConfig : undefined,
          sync_down_config: row.sync_down_config ? JSON.parse(row.sync_down_config) as SyncButtonConfig : undefined,
          server_name: row.server_name,
          server_url: row.server_url,
          server_api_key: row.server_api_key ?? undefined,
        }));
      },

      getByProjectAndServer: (projectId: string, remoteServerId: string): ProjectRemoteWithServer | undefined => {
        type ProjectRemoteRow = {
          id: string;
          project_id: string;
          remote_server_id: string;
          remote_path: string;
          sort_order: number;
          sync_up_config: string | null;
          sync_down_config: string | null;
          server_name: string;
          server_url: string;
          server_api_key: string | null;
        };
        const row = db
          .prepare<{ project_id: string; remote_server_id: string }, ProjectRemoteRow>(
            `SELECT pr.id, pr.project_id, pr.remote_server_id, pr.remote_path, pr.sort_order,
                    pr.sync_up_config, pr.sync_down_config,
                    rs.name as server_name, rs.url as server_url, rs.api_key as server_api_key
             FROM project_remotes pr
             JOIN remote_servers rs ON pr.remote_server_id = rs.id
             WHERE pr.project_id = @project_id AND pr.remote_server_id = @remote_server_id`
          )
          .get({ project_id: projectId, remote_server_id: remoteServerId });
        if (!row) return undefined;
        return {
          id: row.id,
          project_id: row.project_id,
          remote_server_id: row.remote_server_id,
          remote_path: row.remote_path,
          sort_order: row.sort_order,
          sync_up_config: row.sync_up_config ? JSON.parse(row.sync_up_config) as SyncButtonConfig : undefined,
          sync_down_config: row.sync_down_config ? JSON.parse(row.sync_down_config) as SyncButtonConfig : undefined,
          server_name: row.server_name,
          server_url: row.server_url,
          server_api_key: row.server_api_key ?? undefined,
        };
      },

      add: (opts: {
        project_id: string;
        remote_server_id: string;
        remote_path: string;
        sort_order?: number;
        sync_up_config?: SyncButtonConfig;
        sync_down_config?: SyncButtonConfig;
      }): ProjectRemote => {
        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO project_remotes (id, project_id, remote_server_id, remote_path, sort_order, sync_up_config, sync_down_config)
           VALUES (@id, @project_id, @remote_server_id, @remote_path, @sort_order, @sync_up_config, @sync_down_config)`
        ).run({
          id,
          project_id: opts.project_id,
          remote_server_id: opts.remote_server_id,
          remote_path: opts.remote_path,
          sort_order: opts.sort_order ?? 0,
          sync_up_config: opts.sync_up_config ? JSON.stringify(opts.sync_up_config) : null,
          sync_down_config: opts.sync_down_config ? JSON.stringify(opts.sync_down_config) : null,
        });

        type ProjectRemoteDbRow = {
          id: string;
          project_id: string;
          remote_server_id: string;
          remote_path: string;
          sort_order: number;
          sync_up_config: string | null;
          sync_down_config: string | null;
        };
        const row = db
          .prepare<{ id: string }, ProjectRemoteDbRow>(`SELECT * FROM project_remotes WHERE id = @id`)
          .get({ id })!;
        return {
          id: row.id,
          project_id: row.project_id,
          remote_server_id: row.remote_server_id,
          remote_path: row.remote_path,
          sort_order: row.sort_order,
          sync_up_config: row.sync_up_config ? JSON.parse(row.sync_up_config) as SyncButtonConfig : undefined,
          sync_down_config: row.sync_down_config ? JSON.parse(row.sync_down_config) as SyncButtonConfig : undefined,
        };
      },

      update: (id: string, opts: {
        remote_path?: string;
        sort_order?: number;
        sync_up_config?: SyncButtonConfig | null;
        sync_down_config?: SyncButtonConfig | null;
      }): ProjectRemote | undefined => {
        const updates: string[] = [];
        const params: Record<string, unknown> = { id };

        if (opts.remote_path !== undefined) {
          updates.push('remote_path = @remote_path');
          params.remote_path = opts.remote_path;
        }
        if (opts.sort_order !== undefined) {
          updates.push('sort_order = @sort_order');
          params.sort_order = opts.sort_order;
        }
        if (opts.sync_up_config !== undefined) {
          updates.push('sync_up_config = @sync_up_config');
          params.sync_up_config = opts.sync_up_config ? JSON.stringify(opts.sync_up_config) : null;
        }
        if (opts.sync_down_config !== undefined) {
          updates.push('sync_down_config = @sync_down_config');
          params.sync_down_config = opts.sync_down_config ? JSON.stringify(opts.sync_down_config) : null;
        }

        type ProjectRemoteDbRow = {
          id: string;
          project_id: string;
          remote_server_id: string;
          remote_path: string;
          sort_order: number;
          sync_up_config: string | null;
          sync_down_config: string | null;
        };

        if (updates.length === 0) {
          const row = db.prepare<{ id: string }, ProjectRemoteDbRow>(`SELECT * FROM project_remotes WHERE id = @id`).get({ id });
          if (!row) return undefined;
          return {
            id: row.id,
            project_id: row.project_id,
            remote_server_id: row.remote_server_id,
            remote_path: row.remote_path,
            sort_order: row.sort_order,
            sync_up_config: row.sync_up_config ? JSON.parse(row.sync_up_config) as SyncButtonConfig : undefined,
            sync_down_config: row.sync_down_config ? JSON.parse(row.sync_down_config) as SyncButtonConfig : undefined,
          };
        }

        db.prepare(`UPDATE project_remotes SET ${updates.join(', ')} WHERE id = @id`).run(params);
        const row = db.prepare<{ id: string }, ProjectRemoteDbRow>(`SELECT * FROM project_remotes WHERE id = @id`).get({ id });
        if (!row) return undefined;
        return {
          id: row.id,
          project_id: row.project_id,
          remote_server_id: row.remote_server_id,
          remote_path: row.remote_path,
          sort_order: row.sort_order,
          sync_up_config: row.sync_up_config ? JSON.parse(row.sync_up_config) as SyncButtonConfig : undefined,
          sync_down_config: row.sync_down_config ? JSON.parse(row.sync_down_config) as SyncButtonConfig : undefined,
        };
      },

      remove: (id: string): boolean => {
        const result = db.prepare(`DELETE FROM project_remotes WHERE id = @id`).run({ id });
        return result.changes > 0;
      },
    },

    executorGroups: {
      create: ({ id, project_id, name, branch }) => {
        db.prepare(
          `INSERT INTO executor_groups (id, project_id, name, branch) VALUES (@id, @project_id, @name, @branch)`
        ).run({ id, project_id, name, branch });

        return db
          .prepare<{ id: string }, ExecutorGroup>(`SELECT * FROM executor_groups WHERE id = @id`)
          .get({ id })!;
      },

      getByProjectId: (projectId: string) => {
        return db
          .prepare<{ project_id: string }, ExecutorGroup>(`SELECT * FROM executor_groups WHERE project_id = @project_id ORDER BY created_at ASC`)
          .all({ project_id: projectId });
      },

      getById: (id: string) => {
        return db
          .prepare<{ id: string }, ExecutorGroup>(`SELECT * FROM executor_groups WHERE id = @id`)
          .get({ id });
      },

      getByBranch: (projectId: string, branch: string) => {
        return db
          .prepare<{ project_id: string; branch: string }, ExecutorGroup>(
            `SELECT * FROM executor_groups WHERE project_id = @project_id AND branch = @branch`
          )
          .get({ project_id: projectId, branch });
      },

      update: (id: string, opts: { name?: string }) => {
        if (opts.name !== undefined) {
          db.prepare(`UPDATE executor_groups SET name = @name WHERE id = @id`).run({ id, name: opts.name });
        }
        return db
          .prepare<{ id: string }, ExecutorGroup>(`SELECT * FROM executor_groups WHERE id = @id`)
          .get({ id });
      },

      delete: (id: string) => {
        db.prepare(`DELETE FROM executor_groups WHERE id = @id`).run({ id });
      },
    },

    executors: {
      create: ({ id, project_id, group_id, name, command, executor_type, prompt_provider, cwd, pty }) => {
        // Get max position for this group
        const maxPos = db.prepare<{ group_id: string }, { max_pos: number | null }>(
          `SELECT MAX(position) as max_pos FROM executors WHERE group_id = @group_id`
        ).get({ group_id });
        const position = (maxPos?.max_pos ?? -1) + 1;

        db.prepare(
          `INSERT INTO executors (id, project_id, group_id, name, command, executor_type, prompt_provider, cwd, pty, position) VALUES (@id, @project_id, @group_id, @name, @command, @executor_type, @prompt_provider, @cwd, @pty, @position)`
        ).run({ id, project_id, group_id, name, command, executor_type: executor_type ?? 'command', prompt_provider: prompt_provider ?? null, cwd: cwd ?? null, pty: pty !== false ? 1 : 0, position });

        const row = db
          .prepare<{ id: string }, ExecutorRow>(`SELECT * FROM executors WHERE id = @id`)
          .get({ id })!;
        return mapExecutorRow(row);
      },

      getByProjectId: (projectId: string) => {
        const rows = db
          .prepare<{ project_id: string }, ExecutorRow>(`SELECT * FROM executors WHERE project_id = @project_id ORDER BY position ASC`)
          .all({ project_id: projectId });
        return rows.map(mapExecutorRow);
      },

      getByGroupId: (groupId: string) => {
        const rows = db
          .prepare<{ group_id: string }, ExecutorRow>(`SELECT * FROM executors WHERE group_id = @group_id ORDER BY position ASC`)
          .all({ group_id: groupId });
        return rows.map(mapExecutorRow);
      },

      getById: (id: string) => {
        const row = db
          .prepare<{ id: string }, ExecutorRow>(`SELECT * FROM executors WHERE id = @id`)
          .get({ id });
        return row ? mapExecutorRow(row) : undefined;
      },

      update: (id: string, opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean }) => {
        const updates: string[] = [];
        const params: Record<string, unknown> = { id };

        if (opts.name !== undefined) {
          updates.push('name = @name');
          params.name = opts.name;
        }
        if (opts.command !== undefined) {
          updates.push('command = @command');
          params.command = opts.command;
        }
        if (opts.executor_type !== undefined) {
          updates.push('executor_type = @executor_type');
          params.executor_type = opts.executor_type;
        }
        if (opts.prompt_provider !== undefined) {
          updates.push('prompt_provider = @prompt_provider');
          params.prompt_provider = opts.prompt_provider;
        }
        if (opts.cwd !== undefined) {
          updates.push('cwd = @cwd');
          params.cwd = opts.cwd;
        }
        if (opts.pty !== undefined) {
          updates.push('pty = @pty');
          params.pty = opts.pty ? 1 : 0;
        }

        if (updates.length === 0) {
          const row = db.prepare<{ id: string }, ExecutorRow>(`SELECT * FROM executors WHERE id = @id`).get({ id });
          return row ? mapExecutorRow(row) : undefined;
        }

        db.prepare(`UPDATE executors SET ${updates.join(', ')} WHERE id = @id`).run(params);
        const row = db.prepare<{ id: string }, ExecutorRow>(`SELECT * FROM executors WHERE id = @id`).get({ id });
        return row ? mapExecutorRow(row) : undefined;
      },

      delete: (id: string) => {
        db.prepare(`DELETE FROM executors WHERE id = @id`).run({ id });
      },

      reorder: (groupId: string, orderedIds: string[]) => {
        const transaction = db.transaction(() => {
          for (let i = 0; i < orderedIds.length; i++) {
            db.prepare(
              `UPDATE executors SET position = @position WHERE id = @id AND group_id = @group_id`
            ).run({ id: orderedIds[i], group_id: groupId, position: i });
          }
        });
        transaction();
      },
    },

    executorProcesses: {
      create: ({ id, executor_id, pid }) => {
        db.prepare(
          `INSERT INTO executor_processes (id, executor_id, pid, status) VALUES (@id, @executor_id, @pid, 'running')`
        ).run({ id, executor_id, pid: pid ?? null });

        return db
          .prepare<{ id: string }, ExecutorProcess>(`SELECT * FROM executor_processes WHERE id = @id`)
          .get({ id })!;
      },

      getById: (id: string) => {
        return db
          .prepare<{ id: string }, ExecutorProcess>(`SELECT * FROM executor_processes WHERE id = @id`)
          .get({ id });
      },

      getRunning: () => {
        return db
          .prepare<{}, ExecutorProcess>(`SELECT * FROM executor_processes WHERE status = 'running'`)
          .all({});
      },

      updateStatus: (id: string, status: ExecutorProcessStatus, exitCode?: number) => {
        const finishedAt = status !== 'running' ? new Date().toISOString() : null;
        db.prepare(
          `UPDATE executor_processes SET status = @status, exit_code = @exit_code, finished_at = @finished_at WHERE id = @id`
        ).run({ id, status, exit_code: exitCode ?? null, finished_at: finishedAt });
      },

      updatePid: (id: string, pid: number) => {
        db.prepare(
          `UPDATE executor_processes SET pid = @pid WHERE id = @id`
        ).run({ id, pid });
      },
    },

    remoteExecutorProcesses: {
      insert: (localProcessId, info) => {
        db.prepare(
          `INSERT OR REPLACE INTO remote_executor_processes (local_process_id, remote_server_id, remote_url, remote_api_key, remote_process_id, executor_id, project_id, branch) VALUES (@local_process_id, @remote_server_id, @remote_url, @remote_api_key, @remote_process_id, @executor_id, @project_id, @branch)`
        ).run({
          local_process_id: localProcessId,
          remote_server_id: info.remoteServerId,
          remote_url: info.remoteUrl,
          remote_api_key: info.remoteApiKey,
          remote_process_id: info.remoteProcessId,
          executor_id: info.executorId,
          project_id: info.projectId ?? null,
          branch: info.branch ?? null,
        });
      },

      delete: (localProcessId) => {
        db.prepare(`DELETE FROM remote_executor_processes WHERE local_process_id = @id`).run({ id: localProcessId });
      },

      getAll: () => {
        return db
          .prepare<{}, { local_process_id: string; remote_server_id: string; remote_url: string; remote_api_key: string; remote_process_id: string; executor_id: string; project_id: string | null; branch: string | null }>(
            `SELECT * FROM remote_executor_processes`
          )
          .all({});
      },
    },

    agentSessions: {
      create: ({ id, project_id, branch, permission_mode, agent_type }) => {
        // Delete any existing session for this branch (one-to-one binding)
        db.prepare(
          `DELETE FROM agent_sessions WHERE project_id = @project_id AND branch = @branch`
        ).run({ project_id, branch });

        db.prepare(
          `INSERT INTO agent_sessions (id, project_id, branch, status, permission_mode, agent_type) VALUES (@id, @project_id, @branch, 'running', @permission_mode, @agent_type)`
        ).run({ id, project_id, branch, permission_mode: permission_mode ?? 'edit', agent_type: agent_type ?? 'claude-code' });

        return db
          .prepare<{ id: string }, AgentSession>(`SELECT * FROM agent_sessions WHERE id = @id`)
          .get({ id })!;
      },

      getAll: () => {
        return db
          .prepare<{}, AgentSession>(`SELECT * FROM agent_sessions ORDER BY created_at DESC`)
          .all({});
      },

      getById: (id: string) => {
        return db
          .prepare<{ id: string }, AgentSession>(`SELECT * FROM agent_sessions WHERE id = @id`)
          .get({ id });
      },

      getByProjectId: (projectId: string) => {
        return db
          .prepare<{ project_id: string }, AgentSession>(`SELECT * FROM agent_sessions WHERE project_id = @project_id ORDER BY created_at DESC`)
          .all({ project_id: projectId });
      },

      getByBranch: (projectId: string, branch: string) => {
        return db
          .prepare<{ project_id: string; branch: string }, AgentSession>(
            `SELECT * FROM agent_sessions WHERE project_id = @project_id AND branch = @branch`
          )
          .get({ project_id: projectId, branch });
      },

      updateStatus: (id: string, status: AgentSessionStatus) => {
        db.prepare(
          `UPDATE agent_sessions SET status = @status WHERE id = @id`
        ).run({ id, status });
      },

      updatePermissionMode: (id: string, mode: string) => {
        db.prepare(
          `UPDATE agent_sessions SET permission_mode = @mode WHERE id = @id`
        ).run({ id, mode });
      },

      delete: (id: string) => {
        db.prepare(`DELETE FROM agent_sessions WHERE id = @id`).run({ id });
      },

      upsertEntry: (sessionId: string, entryIndex: number, data: string) => {
        db.prepare(
          `INSERT INTO agent_session_entries (session_id, entry_index, data)
           VALUES (@session_id, @entry_index, @data)
           ON CONFLICT(session_id, entry_index) DO UPDATE SET data = excluded.data`
        ).run({ session_id: sessionId, entry_index: entryIndex, data });
      },

      getEntries: (sessionId: string) => {
        return db
          .prepare<{ session_id: string }, { entry_index: number; data: string }>(
            `SELECT entry_index, data FROM agent_session_entries WHERE session_id = @session_id ORDER BY entry_index ASC`
          )
          .all({ session_id: sessionId });
      },

      deleteEntries: (sessionId: string) => {
        db.prepare(
          `DELETE FROM agent_session_entries WHERE session_id = @session_id`
        ).run({ session_id: sessionId });
      },
    },

    settings: {
      get: (key: string) => {
        const row = db
          .prepare<{ key: string }, { value: string }>(`SELECT value FROM global_settings WHERE key = @key`)
          .get({ key });
        return row?.value;
      },

      set: (key: string, value: string) => {
        db.prepare(
          `INSERT INTO global_settings (key, value) VALUES (@key, @value)
           ON CONFLICT(key) DO UPDATE SET value = @value`
        ).run({ key, value });
      },

      delete: (key: string) => {
        db.prepare(`DELETE FROM global_settings WHERE key = @key`).run({ key });
      },
    },

    tasks: {
      create: ({ id, project_id, title, description, status, priority, assigned_branch }) => {
        const maxPos = db.prepare<{ project_id: string }, { max_pos: number | null }>(
          `SELECT MAX(position) as max_pos FROM tasks WHERE project_id = @project_id`
        ).get({ project_id });
        const position = (maxPos?.max_pos ?? -1) + 1;

        db.prepare(
          `INSERT INTO tasks (id, project_id, title, description, status, priority, assigned_branch, position)
           VALUES (@id, @project_id, @title, @description, @status, @priority, @assigned_branch, @position)`
        ).run({
          id,
          project_id,
          title,
          description: description ?? null,
          status: status ?? 'todo',
          priority: priority ?? 'medium',
          assigned_branch: assigned_branch ?? null,
          position,
        });

        return db
          .prepare<{ id: string }, Task>(`SELECT * FROM tasks WHERE id = @id`)
          .get({ id })!;
      },

      getByProjectId: (projectId: string) => {
        return db
          .prepare<{ project_id: string }, Task>(`SELECT * FROM tasks WHERE project_id = @project_id ORDER BY position ASC`)
          .all({ project_id: projectId });
      },

      getById: (id: string) => {
        return db
          .prepare<{ id: string }, Task>(`SELECT * FROM tasks WHERE id = @id`)
          .get({ id });
      },

      update: (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null; position?: number }) => {
        const updates: string[] = [];
        const params: Record<string, unknown> = { id };

        if (opts.title !== undefined) {
          updates.push('title = @title');
          params.title = opts.title;
        }
        if (opts.description !== undefined) {
          updates.push('description = @description');
          params.description = opts.description;
        }
        if (opts.status !== undefined) {
          updates.push('status = @status');
          params.status = opts.status;
        }
        if (opts.priority !== undefined) {
          updates.push('priority = @priority');
          params.priority = opts.priority;
        }
        if (opts.assigned_branch !== undefined) {
          updates.push('assigned_branch = @assigned_branch');
          params.assigned_branch = opts.assigned_branch;
        }
        if (opts.position !== undefined) {
          updates.push('position = @position');
          params.position = opts.position;
        }

        if (updates.length === 0) {
          return db.prepare<{ id: string }, Task>(`SELECT * FROM tasks WHERE id = @id`).get({ id });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = @id`).run(params);
        return db.prepare<{ id: string }, Task>(`SELECT * FROM tasks WHERE id = @id`).get({ id });
      },

      delete: (id: string) => {
        db.prepare(`DELETE FROM tasks WHERE id = @id`).run({ id });
      },

      reorder: (projectId: string, orderedIds: string[]) => {
        const transaction = db.transaction(() => {
          for (let i = 0; i < orderedIds.length; i++) {
            db.prepare(
              `UPDATE tasks SET position = @position, updated_at = CURRENT_TIMESTAMP WHERE id = @id AND project_id = @project_id`
            ).run({ id: orderedIds[i], project_id: projectId, position: i });
          }
        });
        transaction();
      },
    },

    rules: {
      create: ({ id, project_id, branch, name, content, enabled }) => {
        const maxPos = db.prepare<{ project_id: string; branch: string | null }, { max_pos: number | null }>(
          `SELECT MAX(position) as max_pos FROM rules WHERE project_id = @project_id AND (branch IS @branch OR (branch IS NULL AND @branch IS NULL))`
        ).get({ project_id, branch: branch ?? null });
        const position = (maxPos?.max_pos ?? -1) + 1;

        db.prepare(
          `INSERT INTO rules (id, project_id, branch, name, content, enabled, position)
           VALUES (@id, @project_id, @branch, @name, @content, @enabled, @position)`
        ).run({
          id,
          project_id,
          branch: branch ?? null,
          name,
          content,
          enabled: enabled === false ? 0 : 1,
          position,
        });

        return db
          .prepare<{ id: string }, Rule>(`SELECT * FROM rules WHERE id = @id`)
          .get({ id })!;
      },

      getByWorkspace: (projectId: string, branch: string | null) => {
        return db
          .prepare<{ project_id: string; branch: string | null }, Rule>(
            `SELECT * FROM rules WHERE project_id = @project_id AND (branch IS @branch OR (branch IS NULL AND @branch IS NULL)) ORDER BY position ASC`
          )
          .all({ project_id: projectId, branch: branch ?? null });
      },

      getById: (id: string) => {
        return db
          .prepare<{ id: string }, Rule>(`SELECT * FROM rules WHERE id = @id`)
          .get({ id });
      },

      update: (id: string, opts: { name?: string; content?: string; enabled?: boolean; position?: number }) => {
        const updates: string[] = [];
        const params: Record<string, unknown> = { id };

        if (opts.name !== undefined) {
          updates.push('name = @name');
          params.name = opts.name;
        }
        if (opts.content !== undefined) {
          updates.push('content = @content');
          params.content = opts.content;
        }
        if (opts.enabled !== undefined) {
          updates.push('enabled = @enabled');
          params.enabled = opts.enabled ? 1 : 0;
        }
        if (opts.position !== undefined) {
          updates.push('position = @position');
          params.position = opts.position;
        }

        if (updates.length === 0) {
          return db.prepare<{ id: string }, Rule>(`SELECT * FROM rules WHERE id = @id`).get({ id });
        }

        updates.push('updated_at = datetime(\'now\')');
        db.prepare(`UPDATE rules SET ${updates.join(', ')} WHERE id = @id`).run(params);
        return db.prepare<{ id: string }, Rule>(`SELECT * FROM rules WHERE id = @id`).get({ id });
      },

      delete: (id: string) => {
        db.prepare(`DELETE FROM rules WHERE id = @id`).run({ id });
      },

      reorder: (projectId: string, branch: string | null, orderedIds: string[]) => {
        const transaction = db.transaction(() => {
          for (let i = 0; i < orderedIds.length; i++) {
            db.prepare(
              `UPDATE rules SET position = @position, updated_at = datetime('now') WHERE id = @id AND project_id = @project_id`
            ).run({ id: orderedIds[i], project_id: projectId, position: i });
          }
        });
        transaction();
      },
    },

    close: () => {
      db.close();
    },
  };
};
