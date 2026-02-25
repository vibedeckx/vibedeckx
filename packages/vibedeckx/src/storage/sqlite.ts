import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { mkdir } from "fs/promises";
import path from "path";
import type { Project, Executor, ExecutorGroup, ExecutorProcess, ExecutorProcessStatus, AgentSession, AgentSessionStatus, Task, TaskStatus, TaskPriority, Storage, ExecutionMode, SyncButtonConfig } from "./types.js";

const createDatabase = (dbPath: string): BetterSqlite3Database => {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
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
      cwd TEXT,
      pty INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES executor_groups(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS executor_processes (
      id TEXT PRIMARY KEY,
      executor_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP,
      FOREIGN KEY (executor_id) REFERENCES executors(id) ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS global_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
    created_at: string;
  };

  return {
    projects: {
      create: ({ id, name, path: projectPath, remote_path, remote_url, remote_api_key, agent_mode, executor_mode, sync_up_config, sync_down_config }) => {
        const is_remote = remote_url ? 1 : 0;
        db.prepare(
          `INSERT INTO projects (id, name, path, remote_path, is_remote, remote_url, remote_api_key, agent_mode, executor_mode, sync_up_config, sync_down_config)
           VALUES (@id, @name, @path, @remote_path, @is_remote, @remote_url, @remote_api_key, @agent_mode, @executor_mode, @sync_up_config, @sync_down_config)`
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
        });

        const row = db
          .prepare<{ id: string }, ProjectRow>(`SELECT * FROM projects WHERE id = @id`)
          .get({ id })!;
        return toProject(row);
      },

      getAll: () => {
        const rows = db
          .prepare<{}, ProjectRow>(`SELECT * FROM projects ORDER BY created_at DESC`)
          .all({});
        return rows.map(toProject);
      },

      getById: (id: string) => {
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

      update: (id: string, opts: { name?: string; path?: string | null; remote_path?: string | null; remote_url?: string | null; remote_api_key?: string | null; agent_mode?: ExecutionMode; executor_mode?: ExecutionMode; sync_up_config?: SyncButtonConfig | null; sync_down_config?: SyncButtonConfig | null }) => {
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

        if (updates.length === 0) {
          const row = db.prepare<{ id: string }, ProjectRow>(`SELECT * FROM projects WHERE id = @id`).get({ id });
          return row ? toProject(row) : undefined;
        }

        db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = @id`).run(params);
        const row = db.prepare<{ id: string }, ProjectRow>(`SELECT * FROM projects WHERE id = @id`).get({ id });
        return row ? toProject(row) : undefined;
      },

      delete: (id: string) => {
        db.prepare(`DELETE FROM projects WHERE id = @id`).run({ id });
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
      create: ({ id, project_id, group_id, name, command, cwd, pty }) => {
        // Get max position for this group
        const maxPos = db.prepare<{ group_id: string }, { max_pos: number | null }>(
          `SELECT MAX(position) as max_pos FROM executors WHERE group_id = @group_id`
        ).get({ group_id });
        const position = (maxPos?.max_pos ?? -1) + 1;

        db.prepare(
          `INSERT INTO executors (id, project_id, group_id, name, command, cwd, pty, position) VALUES (@id, @project_id, @group_id, @name, @command, @cwd, @pty, @position)`
        ).run({ id, project_id, group_id, name, command, cwd: cwd ?? null, pty: pty !== false ? 1 : 0, position });

        const row = db
          .prepare<{ id: string }, { id: string; project_id: string; group_id: string; name: string; command: string; cwd: string | null; pty: number; position: number; created_at: string }>(`SELECT * FROM executors WHERE id = @id`)
          .get({ id })!;
        return { ...row, pty: row.pty === 1 };
      },

      getByProjectId: (projectId: string) => {
        const rows = db
          .prepare<{ project_id: string }, { id: string; project_id: string; group_id: string; name: string; command: string; cwd: string | null; pty: number; position: number; created_at: string }>(`SELECT * FROM executors WHERE project_id = @project_id ORDER BY position ASC`)
          .all({ project_id: projectId });
        return rows.map((row) => ({ ...row, pty: row.pty === 1 }));
      },

      getByGroupId: (groupId: string) => {
        const rows = db
          .prepare<{ group_id: string }, { id: string; project_id: string; group_id: string; name: string; command: string; cwd: string | null; pty: number; position: number; created_at: string }>(`SELECT * FROM executors WHERE group_id = @group_id ORDER BY position ASC`)
          .all({ group_id: groupId });
        return rows.map((row) => ({ ...row, pty: row.pty === 1 }));
      },

      getById: (id: string) => {
        const row = db
          .prepare<{ id: string }, { id: string; project_id: string; group_id: string; name: string; command: string; cwd: string | null; pty: number; position: number; created_at: string }>(`SELECT * FROM executors WHERE id = @id`)
          .get({ id });
        return row ? { ...row, pty: row.pty === 1 } : undefined;
      },

      update: (id: string, opts: { name?: string; command?: string; cwd?: string | null; pty?: boolean }) => {
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
        if (opts.cwd !== undefined) {
          updates.push('cwd = @cwd');
          params.cwd = opts.cwd;
        }
        if (opts.pty !== undefined) {
          updates.push('pty = @pty');
          params.pty = opts.pty ? 1 : 0;
        }

        if (updates.length === 0) {
          const row = db.prepare<{ id: string }, { id: string; project_id: string; group_id: string; name: string; command: string; cwd: string | null; pty: number; position: number; created_at: string }>(`SELECT * FROM executors WHERE id = @id`).get({ id });
          return row ? { ...row, pty: row.pty === 1 } : undefined;
        }

        db.prepare(`UPDATE executors SET ${updates.join(', ')} WHERE id = @id`).run(params);
        const row = db.prepare<{ id: string }, { id: string; project_id: string; group_id: string; name: string; command: string; cwd: string | null; pty: number; position: number; created_at: string }>(`SELECT * FROM executors WHERE id = @id`).get({ id });
        return row ? { ...row, pty: row.pty === 1 } : undefined;
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
      create: ({ id, executor_id }) => {
        db.prepare(
          `INSERT INTO executor_processes (id, executor_id, status) VALUES (@id, @executor_id, 'running')`
        ).run({ id, executor_id });

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
    },

    agentSessions: {
      create: ({ id, project_id, branch }) => {
        // Delete any existing session for this branch (one-to-one binding)
        db.prepare(
          `DELETE FROM agent_sessions WHERE project_id = @project_id AND branch = @branch`
        ).run({ project_id, branch });

        db.prepare(
          `INSERT INTO agent_sessions (id, project_id, branch, status) VALUES (@id, @project_id, @branch, 'running')`
        ).run({ id, project_id, branch });

        return db
          .prepare<{ id: string }, AgentSession>(`SELECT * FROM agent_sessions WHERE id = @id`)
          .get({ id })!;
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

      delete: (id: string) => {
        db.prepare(`DELETE FROM agent_sessions WHERE id = @id`).run({ id });
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

    close: () => {
      db.close();
    },
  };
};
