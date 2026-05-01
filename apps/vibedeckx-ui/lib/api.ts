// ============ Auth Token Management ============
let _authToken: string | null = null;

export function setAuthToken(token: string | null) {
  _authToken = token;
}

export function getAuthToken(): string | null {
  return _authToken;
}

// ============ App Config ============
export interface AppConfig {
  authEnabled: boolean;
  clerkPublishableKey?: string;
}

let _cachedConfig: AppConfig | null = null;

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

// Helper for authenticated fetch
async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (_authToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${_authToken}`);
  }
  return fetch(url, { ...init, headers });
}

export function getWebSocketUrl(path: string): string {
  if (typeof window === "undefined") {
    return `ws://localhost:5173${path}`;
  }

  // 本地开发模式：连接到后端 5173 端口
  if (isLocalDevMode()) {
    const base = `ws://localhost:5173${path}`;
    if (_authToken) {
      const sep = path.includes("?") ? "&" : "?";
      return `${base}${sep}token=${encodeURIComponent(_authToken)}`;
    }
    return base;
  }

  // 生产模式或通过 tunnel 访问：使用当前页面的 host
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const base = `${protocol}//${host}${path}`;
  if (_authToken) {
    const sep = path.includes("?") ? "&" : "?";
    return `${base}${sep}token=${encodeURIComponent(_authToken)}`;
  }
  return base;
}

export type ExecutionMode = 'local' | string;

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
  has_remote_api_key?: boolean;
  agent_mode: ExecutionMode;
  executor_mode: ExecutionMode;
  sync_up_config?: SyncButtonConfig;
  sync_down_config?: SyncButtonConfig;
  created_at: string;
}

export type RemoteServerConnectionMode = 'outbound' | 'inbound';
export type RemoteServerStatus = 'unknown' | 'online' | 'offline';

export interface RemoteServer {
  id: string;
  name: string;
  url: string | null;
  connection_mode: RemoteServerConnectionMode;
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
  server_name: string;
  server_url: string;
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
  // Most recent process across local + remote tables for this executor.
  // Used by the UI to reconnect to a finished process's log buffer (within
  // backend retention) after a workspace switch unmounts the ExecutorItem,
  // and to show "Last run: <datetime>" on hover. `last_process_target` is
  // either "local" or a remote_server_id; the frontend only auto-reconnects
  // when it matches the current executor mode.
  last_process_id?: string | null;
  last_process_started_at?: string | null;
  last_process_target?: string | null;
}

export type ExecutorProcessStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface ExecutorProcess {
  id: string;
  executor_id: string;
  status: ExecutorProcessStatus;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  target?: string;
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
  | { type: "finished"; exitCode: number | null }
  | { type: "init"; isPty: boolean }
  | { type: "error"; message: string }
  | { type: "history_end" };

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

export interface ChatProviderConfig {
  provider: 'deepseek' | 'openrouter';
  deepseekApiKey: string;
  openrouterApiKey: string;
  openrouterModel: string;
}

export interface TerminalSettings {
  scrollback: number;
  fontSize: number;
  fontFamily: string;
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  scrollback: 1000,
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
};

export const TERMINAL_SETTINGS_LIMITS = {
  scrollbackMin: 500,
  scrollbackMax: 100000,
  fontSizeMin: 8,
  fontSizeMax: 32,
} as const;

// ============ Agent Provider Types ============

export type AgentType = "claude-code" | "codex";

export interface AgentProviderInfo {
  type: AgentType;
  displayName: string;
  available: boolean;
}

export async function getAgentProviders(): Promise<AgentProviderInfo[]> {
  const res = await authFetch(`${getApiBase()}/api/agent-providers`);
  const data = await res.json();
  return data.providers;
}

export async function sendApprovalResponse(sessionId: string, requestId: string, decision: string): Promise<void> {
  const res = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, decision }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Approval request failed" }));
    throw new Error(data.error || "Approval request failed");
  }
}

export async function translateText(text: string): Promise<{ translatedText: string; error?: string }> {
  try {
    const res = await authFetch(`${getApiBase()}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return { translatedText: text, error: "Translation failed" };
    return res.json();
  } catch {
    return { translatedText: text, error: "Translation failed" };
  }
}

// ============ Agent Session Multi-Session Helpers ============

export interface BranchSessionSummary {
  id: string;
  status: string;
  title?: string | null;
  created_at: string;
  updated_at?: string;
  permission_mode?: string;
  agent_type?: string;
  entry_count?: number;
}

// List all sessions for a (projectId, branch) pair
export async function listBranchSessions(
  projectId: string,
  branch: string | null
): Promise<{ sessions: BranchSessionSummary[] }> {
  const qs = branch != null ? `?branch=${encodeURIComponent(branch)}` : "";
  const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions${qs}`);
  if (!res.ok) throw new Error(`listBranchSessions failed: ${res.status}`);
  return res.json();
}

// Explicitly create a new agent session (never reuses an existing one)
export async function createNewAgentSession(
  projectId: string,
  branch: string | null,
  permissionMode?: "plan" | "edit",
  agentType?: string
): Promise<{
  session: { id: string; projectId: string; branch: string | null; status: string; permissionMode?: string; agentType?: string };
  messages: unknown[];
}> {
  const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, permissionMode, agentType }),
  });
  if (!res.ok) throw new Error(`createNewAgentSession failed: ${res.status}`);
  return res.json();
}

// Rename (or clear) the title of an agent session
export async function renameSession(sessionId: string, title: string | null): Promise<void> {
  const res = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/title`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`renameSession failed: ${res.status}`);
}

// Delete an agent session
export async function deleteSession(sessionId: string): Promise<void> {
  const res = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`deleteSession failed: ${res.status}`);
}

export const api = {
  async getConfig(): Promise<AppConfig> {
    if (_cachedConfig) return _cachedConfig;
    const res = await fetch(`${getApiBase()}/api/config`);
    const data = await res.json();
    _cachedConfig = data;
    return data;
  },

  async getProjects(): Promise<Project[]> {
    const res = await authFetch(`${getApiBase()}/api/projects`);
    if (!res.ok) {
      throw new Error(`Failed to fetch projects: ${res.status}`);
    }
    const data = await res.json();
    return data.projects;
  },

  async getProject(id: string): Promise<Project> {
    const res = await authFetch(`${getApiBase()}/api/projects/${id}`);
    const data = await res.json();
    return data.project;
  },

  async selectFolder(): Promise<{ path: string | null; cancelled: boolean }> {
    const res = await authFetch(`${getApiBase()}/api/dialog/select-folder`, {
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
    agentMode?: ExecutionMode;
  }): Promise<Project> {
    const res = await authFetch(`${getApiBase()}/api/projects`, {
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
    const res = await authFetch(`${getApiBase()}/api/projects/${id}`, {
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
    await authFetch(`${getApiBase()}/api/projects/${id}`, {
      method: "DELETE",
    });
  },

  async getProjectFiles(id: string): Promise<DirectoryEntry[]> {
    const res = await authFetch(`${getApiBase()}/api/projects/${id}/files`);
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
      const res = await authFetch(`${getApiBase()}/api/projects/${id}/branches${query}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.branches ?? [];
    } catch {
      return [];
    }
  },

  async getProjectWorktrees(id: string): Promise<Worktree[]> {
    const res = await authFetch(`${getApiBase()}/api/projects/${id}/worktrees`);
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/worktrees`, {
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/worktrees`, {
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/executor-groups`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.groups;
  },

  async getExecutorGroupByBranch(projectId: string, branch: string): Promise<ExecutorGroup | null> {
    const params = new URLSearchParams({ branch });
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/executor-groups/by-branch?${params}`);
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/executor-groups`, {
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
    const res = await authFetch(`${getApiBase()}/api/executor-groups/${id}`, {
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
    const res = await authFetch(`${getApiBase()}/api/executor-groups/${id}`, {
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/executors${query}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.executors;
  },

  async createExecutor(
    projectId: string,
    opts: { name: string; command: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string; pty?: boolean; group_id: string }
  ): Promise<Executor> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/executors`, {
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
    opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean }
  ): Promise<Executor> {
    const res = await authFetch(`${getApiBase()}/api/executors/${id}`, {
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
    const res = await authFetch(`${getApiBase()}/api/executors/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async reorderExecutors(projectId: string, orderedIds: string[], groupId: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/executors/reorder`, {
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
  async startExecutor(executorId: string, branch?: string | null, target?: string): Promise<string> {
    const res = await authFetch(`${getApiBase()}/api/executors/${executorId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch, target }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.processId;
  },

  async stopProcess(processId: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/executor-processes/${processId}/stop`, {
      method: "POST",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async getRunningProcesses(): Promise<ExecutorProcess[]> {
    const res = await authFetch(`${getApiBase()}/api/executor-processes/running`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.processes;
  },

  async getDiff(projectId: string, branch?: string | null, commit?: string | null, target?: 'local' | 'remote'): Promise<DiffResponse> {
    const params = new URLSearchParams();
    if (branch) {
      params.set('branch', branch);
    }
    if (commit) {
      params.set('commit', commit);
    }
    if (target) {
      params.set('target', target);
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/diff${query}`);
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/commits${query}`);
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    return data.commits;
  },

  // Remote Project API
  async testRemoteConnection(url: string, apiKey: string): Promise<{ success: boolean; message?: string }> {
    const res = await authFetch(`${getApiBase()}/api/remote/test-connection`, {
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
    const res = await authFetch(`${getApiBase()}/api/remote/browse`, {
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

  async browseRemoteServerDirectory(serverId: string, path?: string): Promise<RemoteBrowseResponse> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${serverId}/browse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
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
    branch?: string | null,
    remoteServerId?: string
  ): Promise<SyncExecutionResult> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/execute-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncType, branch, remoteServerId }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  // Task API
  async getTasks(projectId: string): Promise<Task[]> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/tasks`);
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/tasks`, {
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
    const res = await authFetch(`${getApiBase()}/api/tasks/${id}`, {
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
    const res = await authFetch(`${getApiBase()}/api/tasks/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async reorderTasks(projectId: string, orderedIds: string[]): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/tasks/reorder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async getRules(projectId: string, branch: string | null): Promise<Rule[]> {
    const params = new URLSearchParams();
    if (branch) params.set("branch", branch);
    const qs = params.toString();
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/rules${qs ? `?${qs}` : ""}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.rules;
  },

  async createRule(
    projectId: string,
    opts: { branch: string | null; name: string; content: string; enabled?: boolean }
  ): Promise<Rule> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.rule;
  },

  async updateRule(
    id: string,
    opts: { name?: string; content?: string; enabled?: boolean; position?: number }
  ): Promise<Rule> {
    const res = await authFetch(`${getApiBase()}/api/rules/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.rule;
  },

  async deleteRule(id: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/rules/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async getCommands(projectId: string, branch: string | null): Promise<Command[]> {
    const params = new URLSearchParams();
    if (branch) params.set("branch", branch);
    const qs = params.toString();
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/commands${qs ? `?${qs}` : ""}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.commands;
  },

  async createCommand(
    projectId: string,
    opts: { branch: string | null; name: string; content: string }
  ): Promise<Command> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.command;
  },

  async updateCommand(
    id: string,
    opts: { name?: string; content?: string; position?: number }
  ): Promise<Command> {
    const res = await authFetch(`${getApiBase()}/api/commands/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.command;
  },

  async deleteCommand(id: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/commands/${id}`, {
      method: "DELETE",
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/browse${query}`);
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/file-content?${params.toString()}`);
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
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/terminals${qs ? `?${qs}` : ""}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.terminals;
  },

  async createTerminal(projectId: string, branch?: string | null, location?: "local" | "remote", remoteServerId?: string): Promise<TerminalSession> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/terminals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch, location, remote_server_id: remoteServerId }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.terminal;
  },

  async closeTerminal(terminalId: string): Promise<void> {
    await authFetch(`${getApiBase()}/api/terminals/${terminalId}`, {
      method: "DELETE",
    });
  },

  // Chat Session Event Listening
  async setChatEventListening(sessionId: string, enabled: boolean): Promise<boolean> {
    const res = await authFetch(`${getApiBase()}/api/chat-sessions/${sessionId}/event-listening`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error("Failed to toggle event listening");
    const data = await res.json();
    return data.enabled;
  },

  // Reset Chat Session (clear conversation)
  async resetChatSession(sessionId: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/chat-sessions/${sessionId}/reset`, {
      method: "POST",
    });
    if (!res.ok) throw new Error("Failed to reset chat session");
  },

  // Settings API
  async getProxySettings(): Promise<ProxyConfig> {
    const res = await authFetch(`${getApiBase()}/api/settings/proxy`);
    if (!res.ok) {
      return { type: 'none', host: '', port: 0 };
    }
    return res.json();
  },

  async updateProxySettings(config: ProxyConfig): Promise<ProxyConfig> {
    const res = await authFetch(`${getApiBase()}/api/settings/proxy`, {
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
    const res = await authFetch(`${getApiBase()}/api/settings/proxy/test`, {
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

  // Chat Provider Settings
  async getChatProviderSettings(): Promise<ChatProviderConfig> {
    const res = await authFetch(`${getApiBase()}/api/settings/chat-provider`);
    if (!res.ok) {
      return { provider: 'deepseek', deepseekApiKey: '', openrouterApiKey: '', openrouterModel: '' };
    }
    return res.json();
  },

  async updateChatProviderSettings(config: Partial<ChatProviderConfig>): Promise<ChatProviderConfig> {
    const res = await authFetch(`${getApiBase()}/api/settings/chat-provider`, {
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

  // Terminal Settings
  async getTerminalSettings(): Promise<TerminalSettings> {
    const res = await authFetch(`${getApiBase()}/api/settings/terminal`);
    if (!res.ok) {
      return { ...DEFAULT_TERMINAL_SETTINGS };
    }
    return res.json();
  },

  async updateTerminalSettings(config: Partial<TerminalSettings>): Promise<TerminalSettings> {
    const res = await authFetch(`${getApiBase()}/api/settings/terminal`, {
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

  // Remote Servers API
  async getRemoteServers(): Promise<RemoteServer[]> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data;
  },

  async createRemoteServer(opts: { name: string; url?: string; apiKey?: string; connectionMode?: RemoteServerConnectionMode }): Promise<RemoteServer> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.server;
  },

  async updateRemoteServer(id: string, opts: { name?: string; url?: string; apiKey?: string }): Promise<RemoteServer> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.server;
  },

  async deleteRemoteServer(id: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async testRemoteServer(id: string): Promise<{ success: boolean; status?: string }> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}/test`, {
      method: "POST",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  async generateRemoteServerToken(id: string): Promise<{ token: string; connectCommand: string }> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}/generate-token`, {
      method: "POST",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  async revokeRemoteServerToken(id: string): Promise<{ success: boolean }> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}/revoke-token`, {
      method: "POST",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  // Project Remotes API
  async getProjectRemotes(projectId: string): Promise<ProjectRemote[]> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/remotes`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data;
  },

  async addProjectRemote(projectId: string, opts: {
    remoteServerId: string;
    remotePath: string;
    sortOrder?: number;
  }): Promise<ProjectRemote> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/remotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.remote;
  },

  async updateProjectRemote(projectId: string, remoteId: string, opts: {
    remotePath?: string;
    sortOrder?: number;
    syncUpConfig?: SyncButtonConfig | null;
    syncDownConfig?: SyncButtonConfig | null;
  }): Promise<ProjectRemote> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/remotes/${remoteId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.remote;
  },

  async removeProjectRemote(projectId: string, remoteId: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/remotes/${remoteId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  // ---- Browser Preview ----

  async startBrowser(projectId: string, branch?: string): Promise<{ id: string; status: string; url: string }> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/browser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to start browser" }));
      throw new Error(error.error || "Failed to start browser");
    }
    return res.json();
  },

  async getBrowserStatus(projectId: string): Promise<{ id: string; status: string; url: string } | null> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/browser`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error("Failed to get browser status");
    }
    return res.json();
  },

  async stopBrowser(projectId: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/browser`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      const error = await res.json().catch(() => ({ error: "Failed to stop browser" }));
      throw new Error(error.error || "Failed to stop browser");
    }
  },

  async navigateBrowser(projectId: string, url: string): Promise<{ title: string; url: string }> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/browser/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Navigation failed" }));
      throw new Error(error.error || "Navigation failed");
    }
    return res.json();
  },

  async reportBrowserError(projectId: string, error: { type: string; data: Record<string, unknown> }): Promise<void> {
    await authFetch(`${getApiBase()}/api/projects/${projectId}/browser/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(error),
    }).catch(() => { /* best effort */ });
  },

  getBrowserProxyUrl(projectId: string, targetUrl: string): string {
    return `${getApiBase()}/api/projects/${projectId}/browser/proxy/${encodeURIComponent(targetUrl)}`;
  },
};
