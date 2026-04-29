export type ExecutionMode = 'local' | string;

export type SyncActionType = 'command' | 'prompt';

export interface SyncButtonConfig {
  actionType: SyncActionType;
  executionMode: ExecutionMode;
  content: string;
}

export type RemoteServerConnectionMode = 'outbound' | 'inbound';
export type RemoteServerStatus = 'unknown' | 'online' | 'offline';

export interface RemoteServer {
  id: string;
  name: string;
  url: string | null;
  api_key?: string;
  connection_mode: RemoteServerConnectionMode;
  connect_token?: string;
  connect_token_created_at?: string;
  status: RemoteServerStatus;
  last_connected_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectRemote {
  id: string;
  project_id: string;
  remote_server_id: string;
  remote_path: string;
  sort_order: number;
  sync_up_config?: SyncButtonConfig;
  sync_down_config?: SyncButtonConfig;
}

export interface ProjectRemoteWithServer extends ProjectRemote {
  server_name: string;
  server_url: string | null;
  server_api_key?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string | null;
  remote_path?: string;
  is_remote: boolean;
  remote_url?: string;
  remote_api_key?: string;
  agent_mode: ExecutionMode;
  executor_mode: ExecutionMode;
  sync_up_config?: SyncButtonConfig;
  sync_down_config?: SyncButtonConfig;
  created_at: string;
}

export interface ExecutorGroup {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  created_at: string;
}

export type ExecutorType = 'command' | 'prompt';
export type PromptProvider = 'claude' | 'codex';

export interface Executor {
  id: string;
  project_id: string;
  group_id: string;
  name: string;
  command: string;
  executor_type: ExecutorType;
  prompt_provider: PromptProvider | null;
  cwd: string | null;
  pty: boolean;
  position: number;
  created_at: string;
}

export type ExecutorProcessStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface ExecutorProcess {
  id: string;
  executor_id: string;
  pid: number | null;
  status: ExecutorProcessStatus;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface RemoteExecutorProcessRow {
  local_process_id: string;
  remote_server_id: string;
  remote_url: string;
  remote_api_key: string;
  remote_process_id: string;
  executor_id: string;
  project_id: string | null;
  branch: string | null;
  started_at: string;
  status: ExecutorProcessStatus;
  exit_code: number | null;
  finished_at: string | null;
}

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_branch: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Rule {
  id: string;
  project_id: string;
  branch: string | null;
  name: string;
  content: string;
  enabled: number;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Command {
  id: string;
  project_id: string;
  branch: string | null;
  name: string;
  content: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export type AgentSessionStatus = 'running' | 'stopped' | 'error';

export interface AgentSession {
  id: string;
  project_id: string;
  branch: string;
  status: AgentSessionStatus;
  permission_mode?: string;
  agent_type?: string;
  title?: string | null;
  created_at: string;
  updated_at?: string;
  /** Epoch ms of the most recent user-typed message, or null if none yet. */
  last_user_message_at?: number | null;
  /** Epoch ms of the most recent successful turn completion, or null if none yet. */
  last_completed_at?: number | null;
}

export interface Storage {
  projects: {
    create: (opts: {
      id: string;
      name: string;
      path?: string | null;
      remote_path?: string;
      remote_url?: string;
      remote_api_key?: string;
      agent_mode?: ExecutionMode;
      executor_mode?: ExecutionMode;
      sync_up_config?: SyncButtonConfig;
      sync_down_config?: SyncButtonConfig;
    }, userId?: string) => Project;
    getAll: (userId?: string) => Project[];
    getById: (id: string, userId?: string) => Project | undefined;
    getByPath: (path: string) => Project | undefined;
    update: (id: string, opts: {
      name?: string;
      path?: string | null;
      remote_path?: string | null;
      remote_url?: string | null;
      remote_api_key?: string | null;
      agent_mode?: ExecutionMode;
      executor_mode?: ExecutionMode;
      sync_up_config?: SyncButtonConfig | null;
      sync_down_config?: SyncButtonConfig | null;
    }, userId?: string) => Project | undefined;
    delete: (id: string, userId?: string) => void;
  };
  remoteServers: {
    create(server: { name: string; url: string | null; api_key?: string; connection_mode?: RemoteServerConnectionMode }, userId?: string): RemoteServer;
    getAll(userId?: string): RemoteServer[];
    getById(id: string, userId?: string): RemoteServer | undefined;
    getByUrl(url: string): RemoteServer | undefined;
    getByToken(token: string): RemoteServer | undefined;
    update(id: string, opts: { name?: string; url?: string; api_key?: string; connection_mode?: RemoteServerConnectionMode }, userId?: string): RemoteServer | undefined;
    updateStatus(id: string, status: RemoteServerStatus): void;
    generateToken(id: string, userId?: string): string | undefined;
    revokeToken(id: string, userId?: string): boolean;
    delete(id: string, userId?: string): boolean;
  };
  projectRemotes: {
    getByProject(projectId: string): ProjectRemoteWithServer[];
    getByProjectAndServer(projectId: string, remoteServerId: string): ProjectRemoteWithServer | undefined;
    add(opts: {
      project_id: string;
      remote_server_id: string;
      remote_path: string;
      sort_order?: number;
      sync_up_config?: SyncButtonConfig;
      sync_down_config?: SyncButtonConfig;
    }): ProjectRemote;
    update(id: string, opts: {
      remote_path?: string;
      sort_order?: number;
      sync_up_config?: SyncButtonConfig | null;
      sync_down_config?: SyncButtonConfig | null;
    }): ProjectRemote | undefined;
    remove(id: string): boolean;
  };
  executorGroups: {
    create: (opts: { id: string; project_id: string; name: string; branch: string }) => ExecutorGroup;
    getByProjectId: (projectId: string) => ExecutorGroup[];
    getById: (id: string) => ExecutorGroup | undefined;
    getByBranch: (projectId: string, branch: string) => ExecutorGroup | undefined;
    update: (id: string, opts: { name?: string }) => ExecutorGroup | undefined;
    delete: (id: string) => void;
  };
  executors: {
    create: (opts: { id: string; project_id: string; group_id: string; name: string; command: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string; pty?: boolean }) => Executor;
    getByProjectId: (projectId: string) => Executor[];
    getByGroupId: (groupId: string) => Executor[];
    getById: (id: string) => Executor | undefined;
    update: (id: string, opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean }) => Executor | undefined;
    delete: (id: string) => void;
    reorder: (groupId: string, orderedIds: string[]) => void;
  };
  executorProcesses: {
    create: (opts: { id: string; executor_id: string; pid?: number }) => ExecutorProcess;
    getById: (id: string) => ExecutorProcess | undefined;
    getRunning: () => ExecutorProcess[];
    getLastByExecutorId: (executorId: string) => ExecutorProcess | undefined;
    updateStatus: (id: string, status: ExecutorProcessStatus, exitCode?: number) => void;
    updatePid: (id: string, pid: number) => void;
  };
  remoteExecutorProcesses: {
    insert(localProcessId: string, info: { remoteServerId: string; remoteUrl: string; remoteApiKey: string; remoteProcessId: string; executorId: string; projectId?: string; branch?: string | null }): void;
    /**
     * Hard-delete a row. Use only for stale-row cleanup or transient sessions
     * (e.g. terminals). Use markFinished() when an executor process exits so
     * the row survives for "Last run" lookup and post-finish log replay.
     */
    delete(localProcessId: string): void;
    /** Mark a row as no longer running while preserving it for history. */
    markFinished(localProcessId: string, exitCode?: number, status?: ExecutorProcessStatus): void;
    getById(localProcessId: string): RemoteExecutorProcessRow | undefined;
    /** Most recent row for an executor, regardless of status — used for "Last run" lookup. */
    getLastByExecutorId(executorId: string): RemoteExecutorProcessRow | undefined;
    /** Only rows currently marked 'running' — used for restoration on startup/reconnect. */
    getRunning(): RemoteExecutorProcessRow[];
    /** All rows including finished — primarily for legacy callers. */
    getAll(): RemoteExecutorProcessRow[];
  };
  agentSessions: {
    create: (opts: { id: string; project_id: string; branch: string; permission_mode?: string; agent_type?: string }) => AgentSession;
    getAll: () => AgentSession[];
    getById: (id: string) => AgentSession | undefined;
    getByProjectId: (projectId: string) => AgentSession[];
    /** @deprecated — use listByBranch + getLatestByBranch */
    getByBranch: (projectId: string, branch: string) => AgentSession | undefined;
    listByBranch: (projectId: string, branch: string) => AgentSession[];
    getLatestByBranch: (projectId: string, branch: string) => AgentSession | undefined;
    updateStatus: (id: string, status: AgentSessionStatus) => void;
    /**
     * Update status without touching `updated_at`. Used by startup restore, where
     * bulk-resetting "running" rows to "stopped" is not a real user-facing event
     * and must not disturb the ordering used by `getLatestByBranch`.
     */
    updateStatusPreservingTimestamp: (id: string, status: AgentSessionStatus) => void;
    updatePermissionMode: (id: string, mode: string) => void;
    updateTitle: (id: string, title: string | null) => void;
    touchUpdatedAt: (id: string) => void;
    /** Set last_user_message_at to the given epoch-ms timestamp. */
    markUserMessage: (id: string, timestampMs: number) => void;
    /** Set last_completed_at to the given epoch-ms timestamp. */
    markCompleted: (id: string, timestampMs: number) => void;
    delete: (id: string) => void;
    upsertEntry: (sessionId: string, entryIndex: number, data: string) => void;
    getEntries: (sessionId: string) => Array<{ entry_index: number; data: string }>;
    deleteEntries: (sessionId: string) => void;
    countEntries: () => Array<{ session_id: string; cnt: number }>;
    countUserEntries: () => Array<{ session_id: string; cnt: number }>;
  };
  remoteSessionMappings: {
    upsert: (localSessionId: string, projectId: string, remoteServerId: string, remoteSessionId: string, branch: string | null) => void;
    getAll: () => Array<{ local_session_id: string; project_id: string; remote_server_id: string; remote_session_id: string; branch: string | null }>;
    delete: (localSessionId: string) => void;
  };
  settings: {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
    delete: (key: string) => void;
  };
  tasks: {
    create: (opts: { id: string; project_id: string; title: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => Task;
    getByProjectId: (projectId: string) => Task[];
    getById: (id: string) => Task | undefined;
    update: (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null; position?: number }) => Task | undefined;
    delete: (id: string) => void;
    reorder: (projectId: string, orderedIds: string[]) => void;
  };
  rules: {
    create: (opts: { id: string; project_id: string; branch: string | null; name: string; content: string; enabled?: boolean }) => Rule;
    getByWorkspace: (projectId: string, branch: string | null) => Rule[];
    getById: (id: string) => Rule | undefined;
    update: (id: string, opts: { name?: string; content?: string; enabled?: boolean; position?: number }) => Rule | undefined;
    delete: (id: string) => void;
    reorder: (projectId: string, branch: string | null, orderedIds: string[]) => void;
  };
  commands: {
    create: (opts: { id: string; project_id: string; branch: string | null; name: string; content: string }) => Command;
    getByWorkspace: (projectId: string, branch: string | null) => Command[];
    getById: (id: string) => Command | undefined;
    update: (id: string, opts: { name?: string; content?: string; position?: number }) => Command | undefined;
    delete: (id: string) => void;
  };
  close: () => void;
}
