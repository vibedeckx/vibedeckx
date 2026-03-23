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

export type AgentSessionStatus = 'running' | 'stopped' | 'error';

export interface AgentSession {
  id: string;
  project_id: string;
  branch: string;
  status: AgentSessionStatus;
  permission_mode?: string;
  agent_type?: string;
  created_at: string;
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
    updateStatus: (id: string, status: ExecutorProcessStatus, exitCode?: number) => void;
    updatePid: (id: string, pid: number) => void;
  };
  agentSessions: {
    create: (opts: { id: string; project_id: string; branch: string; permission_mode?: string; agent_type?: string }) => AgentSession;
    getAll: () => AgentSession[];
    getById: (id: string) => AgentSession | undefined;
    getByProjectId: (projectId: string) => AgentSession[];
    getByBranch: (projectId: string, branch: string) => AgentSession | undefined;
    updateStatus: (id: string, status: AgentSessionStatus) => void;
    updatePermissionMode: (id: string, mode: string) => void;
    delete: (id: string) => void;
    upsertEntry: (sessionId: string, entryIndex: number, data: string) => void;
    getEntries: (sessionId: string) => Array<{ entry_index: number; data: string }>;
    deleteEntries: (sessionId: string) => void;
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
  close: () => void;
}
