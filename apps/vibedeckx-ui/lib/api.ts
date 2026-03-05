// 检查是否是本地开发模式（Next.js dev server 在 3000 端口）
function isLocalDevMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  // 只有在 localhost:3000 时才是本地开发模式
  return window.location.hostname === "localhost" && window.location.port === "3000";
}

// 获取 API 基础地址
function getApiBase(): string {
  if (typeof window === "undefined") {
    return "";
  }
  // 本地开发模式：前端在 3000，后端在 5173
  if (isLocalDevMode()) {
    return "http://localhost:5173";
  }
  // 生产模式或通过 tunnel 访问：使用相对路径
  return "";
}

export function getWebSocketUrl(path: string): string {
  if (typeof window === "undefined") {
    return `ws://localhost:5173${path}`;
  }

  // 本地开发模式：连接到后端 5173 端口
  if (isLocalDevMode()) {
    return `ws://localhost:5173${path}`;
  }

  // 生产模式或通过 tunnel 访问：使用当前页面的 host
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}${path}`;
}

export type ExecutionMode = 'local' | 'remote';

export type SyncActionType = 'command' | 'prompt';

export interface SyncButtonConfig {
  actionType: SyncActionType;
  executionMode: ExecutionMode;
  content: string;
}

export interface SyncExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Project {
  id: string;
  name: string;
  path?: string | null;
  remote_path?: string;
  is_remote: boolean;
  remote_url?: string;
  agent_mode: ExecutionMode;
  executor_mode: ExecutionMode;
  sync_up_config?: SyncButtonConfig;
  sync_down_config?: SyncButtonConfig;
  created_at: string;
}

export interface RemoteBrowseItem {
  name: string;
  path: string;
  type: "directory";
}

export interface RemoteBrowseResponse {
  path: string;
  items: RemoteBrowseItem[];
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory";
}

export interface Worktree {
  branch: string | null;
}

export type WorktreeTarget = "local" | "remote";

export interface WorktreeTargetResult {
  success: boolean;
  worktree?: { branch: string };
  error?: string;
  errorCode?: string;
  requestId?: string;
}

export interface WorktreeCreateResult {
  worktree: Worktree;
  results?: Partial<Record<WorktreeTarget, WorktreeTargetResult>>;
  partialSuccess?: boolean;
}

export interface WorktreeDeleteResult {
  success: boolean;
  results?: Partial<Record<WorktreeTarget, { success: boolean; error?: string }>>;
  partialSuccess?: boolean;
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

export interface TerminalSession {
  id: string;
  projectId: string;
  name: string;
  cwd: string;
  location?: "local" | "remote";
  branch: string | null;
}

export type LogMessage =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "pty"; data: string }
  | { type: "finished"; exitCode: number }
  | { type: "init"; isPty: boolean }
  | { type: "error"; message: string };

export type InputMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

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

export interface DiffLine {
  type: 'context' | 'add' | 'delete';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  oldPath?: string;
  hunks: DiffHunk[];
}

export interface DiffResponse {
  files: FileDiff[];
}

export interface CommitEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface BrowseEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
}

export interface BrowseResponse {
  path: string;
  items: BrowseEntry[];
}

export interface FileContentResponse {
  binary: boolean;
  tooLarge?: boolean;
  content: string | null;
  size: number;
}

export interface ProxyConfig {
  type: 'none' | 'http' | 'socks5';
  host: string;
  port: number;
}

// ============ Agent Provider Types ============

export type AgentType = "claude-code" | "codex";

export interface AgentProviderInfo {
  type: AgentType;
  displayName: string;
  available: boolean;
}

export async function getAgentProviders(): Promise<AgentProviderInfo[]> {
  const res = await fetch(`${getApiBase()}/api/agent-providers`);
  const data = await res.json();
  return data.providers;
}

export const api = {
  async getProjects(): Promise<Project[]> {
    const res = await fetch(`${getApiBase()}/api/projects`);
    const data = await res.json();
    return data.projects;
  },

  async getProject(id: string): Promise<Project> {
    const res = await fetch(`${getApiBase()}/api/projects/${id}`);
    const data = await res.json();
    return data.project;
  },

  async selectFolder(): Promise<{ path: string | null; cancelled: boolean }> {
    const res = await fetch(`${getApiBase()}/api/dialog/select-folder`, {
      method: "POST",
    });
    return res.json();
  },

  async createProject(opts: {
    name: string;
    path?: string;
    remotePath?: string;
    remoteUrl?: string;
    remoteApiKey?: string;
  }): Promise<Project> {
    const res = await fetch(`${getApiBase()}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.project;
  },

  async updateProject(
    id: string,
    opts: {
      name?: string;
      path?: string | null;
      remotePath?: string | null;
      remoteUrl?: string | null;
      remoteApiKey?: string | null;
      agentMode?: ExecutionMode;
      executorMode?: ExecutionMode;
      syncUpConfig?: SyncButtonConfig | null;
      syncDownConfig?: SyncButtonConfig | null;
    }
  ): Promise<Project> {
    const res = await fetch(`${getApiBase()}/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.project;
  },

  async deleteProject(id: string): Promise<void> {
    await fetch(`${getApiBase()}/api/projects/${id}`, {
      method: "DELETE",
    });
  },

  async getProjectFiles(id: string): Promise<DirectoryEntry[]> {
    const res = await fetch(`${getApiBase()}/api/projects/${id}/files`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.files;
  },

  async getProjectBranches(id: string, target?: "local" | "remote"): Promise<string[]> {
    try {
      const params = new URLSearchParams();
      if (target) params.set("target", target);
      const query = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`${getApiBase()}/api/projects/${id}/branches${query}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.branches ?? [];
    } catch {
      return [];
    }
  },

  async getProjectWorktrees(id: string): Promise<Worktree[]> {
    const res = await fetch(`${getApiBase()}/api/projects/${id}/worktrees`);
    if (!res.ok) {
      return [{ branch: null }];
    }
    const data = await res.json();
    return data.worktrees;
  },

  async createWorktree(
    projectId: string,
    branchName: string,
    targets?: WorktreeTarget[],
    baseBranch?: string,
    remoteBaseBranch?: string
  ): Promise<WorktreeCreateResult> {
    const body: { branchName: string; targets?: WorktreeTarget[]; baseBranch?: string; remoteBaseBranch?: string } = { branchName };
    if (targets && targets.length > 0) {
      body.targets = targets;
    }
    if (baseBranch) body.baseBranch = baseBranch;
    if (remoteBaseBranch) body.remoteBaseBranch = remoteBaseBranch;
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/worktrees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Accept 207 as partial success
    if (!res.ok && res.status !== 207) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return {
      worktree: data.worktree,
      results: data.results,
      partialSuccess: res.status === 207,
    };
  },

  async deleteWorktree(projectId: string, branch: string): Promise<WorktreeDeleteResult> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/worktrees`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    // Accept 207 as partial success
    if (!res.ok && res.status !== 207) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return {
      success: data.success,
      results: data.results,
      partialSuccess: res.status === 207,
    };
  },

  // Executor Group API
  async getExecutorGroups(projectId: string): Promise<ExecutorGroup[]> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/executor-groups`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.groups;
  },

  async getExecutorGroupByBranch(projectId: string, branch: string): Promise<ExecutorGroup | null> {
    const params = new URLSearchParams({ branch });
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/executor-groups/by-branch?${params}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.group;
  },

  async createExecutorGroup(
    projectId: string,
    opts: { name: string; branch: string }
  ): Promise<ExecutorGroup> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/executor-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.group;
  },

  async updateExecutorGroup(
    id: string,
    opts: { name?: string }
  ): Promise<ExecutorGroup> {
    const res = await fetch(`${getApiBase()}/api/executor-groups/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.group;
  },

  async deleteExecutorGroup(id: string): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/executor-groups/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  // Executor API
  async getExecutors(projectId: string, groupId?: string): Promise<Executor[]> {
    const params = new URLSearchParams();
    if (groupId) params.set("groupId", groupId);
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/executors${query}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.executors;
  },

  async createExecutor(
    projectId: string,
    opts: { name: string; command: string; cwd?: string; pty?: boolean; group_id: string }
  ): Promise<Executor> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/executors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.executor;
  },

  async updateExecutor(
    id: string,
    opts: { name?: string; command?: string; cwd?: string | null; pty?: boolean }
  ): Promise<Executor> {
    const res = await fetch(`${getApiBase()}/api/executors/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.executor;
  },

  async deleteExecutor(id: string): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/executors/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async reorderExecutors(projectId: string, orderedIds: string[], groupId: string): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/executors/reorder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds, groupId }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  // Process Control API
  async startExecutor(executorId: string, branch?: string | null): Promise<string> {
    const res = await fetch(`${getApiBase()}/api/executors/${executorId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.processId;
  },

  async stopProcess(processId: string): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/executor-processes/${processId}/stop`, {
      method: "POST",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async getRunningProcesses(): Promise<ExecutorProcess[]> {
    const res = await fetch(`${getApiBase()}/api/executor-processes/running`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.processes;
  },

  async getDiff(projectId: string, branch?: string | null, sinceCommit?: string | null, target?: 'local' | 'remote'): Promise<DiffResponse> {
    const params = new URLSearchParams();
    if (branch) {
      params.set('branch', branch);
    }
    if (sinceCommit) {
      params.set('since', sinceCommit);
    }
    if (target) {
      params.set('target', target);
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/diff${query}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  async getCommits(projectId: string, branch?: string | null, limit?: number, target?: 'local' | 'remote'): Promise<CommitEntry[]> {
    const params = new URLSearchParams();
    if (branch) {
      params.set('branch', branch);
    }
    if (limit) {
      params.set('limit', String(limit));
    }
    if (target) {
      params.set('target', target);
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/commits${query}`);
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    return data.commits;
  },

  // Remote Project API
  async testRemoteConnection(url: string, apiKey: string): Promise<{ success: boolean; message?: string }> {
    const res = await fetch(`${getApiBase()}/api/remote/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, apiKey }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Connection failed");
    }
    return res.json();
  },

  async browseRemoteDirectory(url: string, apiKey: string, path?: string): Promise<RemoteBrowseResponse> {
    const res = await fetch(`${getApiBase()}/api/remote/browse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, apiKey, path }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to browse directory");
    }
    return res.json();
  },

  async createRemoteProject(
    name: string,
    remotePath: string,
    remoteUrl: string,
    remoteApiKey: string
  ): Promise<Project> {
    return this.createProject({ name, remotePath, remoteUrl, remoteApiKey });
  },

  async updateProjectMode(
    id: string,
    field: 'agentMode' | 'executorMode',
    mode: ExecutionMode
  ): Promise<Project> {
    return this.updateProject(id, { [field]: mode });
  },

  async executeSyncCommand(
    projectId: string,
    syncType: 'up' | 'down',
    branch?: string | null
  ): Promise<SyncExecutionResult> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/execute-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncType, branch }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  // Task API
  async getTasks(projectId: string): Promise<Task[]> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/tasks`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.tasks;
  },

  async createTask(
    projectId: string,
    opts: { title?: string; description: string; status?: TaskStatus; priority?: TaskPriority }
  ): Promise<Task> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.task;
  },

  async updateTask(
    id: string,
    opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null; position?: number }
  ): Promise<Task> {
    const res = await fetch(`${getApiBase()}/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.task;
  },

  async deleteTask(id: string): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/tasks/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async reorderTasks(projectId: string, orderedIds: string[]): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/tasks/reorder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  // File Browser API
  async browseProjectDirectory(
    projectId: string,
    relativePath?: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<BrowseResponse> {
    const params = new URLSearchParams();
    if (relativePath) params.set("path", relativePath);
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/browse${query}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  async getFileContent(
    projectId: string,
    filePath: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<FileContentResponse> {
    const params = new URLSearchParams({ path: filePath });
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/file-content?${params.toString()}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  getFileDownloadUrl(
    projectId: string,
    filePath: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): string {
    const params = new URLSearchParams({ path: filePath });
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);
    return `${getApiBase()}/api/projects/${projectId}/file-download?${params.toString()}`;
  },

  // Terminal API
  async getTerminals(projectId: string, branch?: string | null): Promise<TerminalSession[]> {
    const params = new URLSearchParams();
    if (branch !== undefined) params.set("branch", branch ?? "");
    const qs = params.toString();
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/terminals${qs ? `?${qs}` : ""}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.terminals;
  },

  async createTerminal(projectId: string, branch?: string | null, location?: "local" | "remote"): Promise<TerminalSession> {
    const res = await fetch(`${getApiBase()}/api/projects/${projectId}/terminals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch, location }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.terminal;
  },

  async closeTerminal(terminalId: string): Promise<void> {
    await fetch(`${getApiBase()}/api/terminals/${terminalId}`, {
      method: "DELETE",
    });
  },

  // Settings API
  async getProxySettings(): Promise<ProxyConfig> {
    const res = await fetch(`${getApiBase()}/api/settings/proxy`);
    if (!res.ok) {
      return { type: 'none', host: '', port: 0 };
    }
    return res.json();
  },

  async updateProxySettings(config: ProxyConfig): Promise<ProxyConfig> {
    const res = await fetch(`${getApiBase()}/api/settings/proxy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  async testProxyConnection(config: ProxyConfig): Promise<{ success: boolean; message?: string }> {
    const res = await fetch(`${getApiBase()}/api/settings/proxy/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },
};
