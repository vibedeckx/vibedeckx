export type ExecutionMode = 'local' | 'remote';

export type SyncActionType = 'command' | 'prompt';

export interface SyncButtonConfig {
  actionType: SyncActionType;
  executionMode: ExecutionMode;
  content: string;
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

export interface Executor {
  id: string;
  project_id: string;
  group_id: string;
  name: string;
  command: string;
  cwd: string | null;
  pty: boolean;
  position: number;
  created_at: string;
}

export type ExecutorProcessStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface ExecutorProcess {
  id: string;
  executor_id: string;
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
    }) => Project;
    getAll: () => Project[];
    getById: (id: string) => Project | undefined;
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
    }) => Project | undefined;
    delete: (id: string) => void;
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
    create: (opts: { id: string; project_id: string; group_id: string; name: string; command: string; cwd?: string; pty?: boolean }) => Executor;
    getByProjectId: (projectId: string) => Executor[];
    getByGroupId: (groupId: string) => Executor[];
    getById: (id: string) => Executor | undefined;
    update: (id: string, opts: { name?: string; command?: string; cwd?: string | null; pty?: boolean }) => Executor | undefined;
    delete: (id: string) => void;
    reorder: (groupId: string, orderedIds: string[]) => void;
  };
  executorProcesses: {
    create: (opts: { id: string; executor_id: string }) => ExecutorProcess;
    getById: (id: string) => ExecutorProcess | undefined;
    getRunning: () => ExecutorProcess[];
    updateStatus: (id: string, status: ExecutorProcessStatus, exitCode?: number) => void;
  };
  agentSessions: {
    create: (opts: { id: string; project_id: string; branch: string }) => AgentSession;
    getById: (id: string) => AgentSession | undefined;
    getByProjectId: (projectId: string) => AgentSession[];
    getByBranch: (projectId: string, branch: string) => AgentSession | undefined;
    updateStatus: (id: string, status: AgentSessionStatus) => void;
    delete: (id: string) => void;
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
