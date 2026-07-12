// ============ Auth Token Management ============
// `_authToken` is a warm cache of the last-known Clerk session JWT. It exists so
// that synchronous callers (WebSocket/SSE URL builders) can read a token without
// awaiting. The source of truth, however, is `_tokenGetter` — Clerk's
// `getToken()` — which returns a guaranteed-valid token (refreshing in the
// background only when the cached JWT is near/after expiry). Always prefer
// `getFreshToken()` over the bare cache for anything that can await.
let _authToken: string | null = null;
let _tokenGetter:
  | ((opts?: { skipCache?: boolean }) => Promise<string | null>)
  | null = null;

export function setAuthToken(token: string | null) {
  _authToken = token;
}

export function getAuthToken(): string | null {
  return _authToken;
}

// Registered once by the auth wrapper with Clerk's `getToken`. Passing `null`
// (on sign-out) makes `getFreshToken()` fall back to the bare cache.
export function setTokenGetter(
  fn: ((opts?: { skipCache?: boolean }) => Promise<string | null>) | null
) {
  _tokenGetter = fn;
}

// Decode a JWT's `exp` and decide whether it is at/near expiry. The WS/SSE URL
// builders read the warm `_authToken` cache synchronously, so a stale value here
// becomes a token the server rejects ("Invalid authentication token"). Returns
// true for anything we can't vouch for (missing/unparseable token), so the caller
// forces a refresh instead of risking a dead JWT.
function tokenExpiringSoon(token: string | null, withinSeconds = 10): boolean {
  if (!token) return true;
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const { exp } = JSON.parse(json) as { exp?: number };
    if (typeof exp !== "number") return false; // no exp claim — assume long-lived
    return exp * 1000 - Date.now() < withinSeconds * 1000;
  } catch {
    return false; // unparseable — let Clerk's own cache logic decide
  }
}

// Returns a guaranteed-valid token. When the cached JWT is comfortably valid this
// hits Clerk's in-memory cache with zero network cost; when it is at/near expiry
// we force a network mint so the warm cache the synchronous WS/SSE readers see is
// never an already-expired token. Clerk's own getToken() refresh threshold can lag
// the server's hard-expiry check, which left the cache holding a dead JWT across a
// reconnect storm (e.g. after a server restart) — hence the explicit exp check
// here rather than trusting getToken()'s default caching. Pass `{ skipCache: true }`
// to force a refresh unconditionally (401 retry, reconnect-after-close).
export async function getFreshToken(opts?: {
  skipCache?: boolean;
}): Promise<string | null> {
  if (_tokenGetter) {
    try {
      const skipCache = opts?.skipCache ?? tokenExpiringSoon(_authToken);
      const token = await _tokenGetter({ skipCache });
      _authToken = token;
      return token;
    } catch {
      // Transient getToken() failure. The last-known token only helps while it
      // still has real life left — handing back an already-expired JWT just earns
      // an "Invalid token" rejection and a reconnect loop, so drop it in that case.
      return tokenExpiringSoon(_authToken, 5) ? null : _authToken;
    }
  }
  return _authToken;
}

// Build Authorization headers with a freshly-validated token. Use for fetch
// calls that don't go through `authFetch` (e.g. the session hooks that build
// their own requests).
export async function getAuthHeaders(
  contentType?: string
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  const token = await getFreshToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// ============ App Config ============
export interface AppConfig {
  authEnabled: boolean;
  clerkPublishableKey?: string;
  // Absent on older servers / persisted configs — treat missing as enabled.
  localProjectsEnabled?: boolean;
}

let _cachedConfig: AppConfig | null = null;
let _configInFlight: Promise<AppConfig> | null = null;

// Persist the app config (public, non-sensitive: an authEnabled flag plus the
// public Clerk publishable key) so a refresh can mount the auth provider on the
// first render instead of blocking it on the /api/config round-trip. The value
// is always revalidated against the server in the background — see getConfig.
const CONFIG_STORAGE_KEY = "vibedeckx:app-config";

function persistConfig(config: AppConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore storage failures (private mode / quota) — we still have it in memory
  }
}

// Synchronously read a previously persisted config. Returns null on the first
// ever visit (no cache yet), in which case callers fall back to the network.
export function getPersistedConfig(): AppConfig | null {
  if (_cachedConfig) return _cachedConfig;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return null;
    _cachedConfig = JSON.parse(raw) as AppConfig;
    return _cachedConfig;
  } catch {
    return null;
  }
}

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

// Authenticated fetch: attaches a freshly-validated Clerk token and, if the
// server still rejects it as expired (a token that lapsed in the brief window
// between cache-hit and the server's clock check), force-refreshes once and
// retries. The retry is safe even for POSTs: the backend's auth preHandler
// rejects expired tokens before the route runs, so the first attempt never
// reached the handler.
export async function authFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const send = async (skipCache: boolean): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) {
      const token = await getFreshToken(skipCache ? { skipCache: true } : undefined);
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(url, { ...init, headers });
  };

  const res = await send(false);
  if (res.status === 401 && _tokenGetter && !new Headers(init?.headers).has("Authorization")) {
    return send(true);
  }
  return res;
}

// Builds a WebSocket URL with the auth token in the query string (WS can't send
// Authorization headers). Pass an explicit `token` (from `await getFreshToken()`)
// to guarantee freshness; omit it to fall back to the warm cache.
export function getWebSocketUrl(path: string, token?: string | null): string {
  const authToken = token !== undefined ? token : _authToken;
  const withToken = (base: string): string => {
    if (!authToken) return base;
    const sep = path.includes("?") ? "&" : "?";
    return `${base}${sep}token=${encodeURIComponent(authToken)}`;
  };

  if (typeof window === "undefined") {
    return `ws://localhost:5173${path}`;
  }

  // 本地开发模式：连接到后端 5173 端口
  if (isLocalDevMode()) {
    return withToken(`ws://localhost:5173${path}`);
  }

  // 生产模式或通过 tunnel 访问：使用当前页面的 host
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return withToken(`${protocol}//${host}${path}`);
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
export type CrossRemoteAccess = 'off' | 'read' | 'exec';

export interface RemoteServer {
  id: string;
  name: string;
  url: string | null;
  connection_mode: RemoteServerConnectionMode;
  status: RemoteServerStatus;
  last_connected_at?: string;
  created_at: string;
  updated_at: string;
  cross_remote_access: CrossRemoteAccess;
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
  // Optionally joined from the remote server (see useProjectRemotes withStatus)
  status?: RemoteServerStatus;
  connection_mode?: RemoteServerConnectionMode;
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

export type MergeStatusValue = "merged" | "partial" | "unmerged" | "no-unique-commits";

export interface MergeStatusEntry {
  branch: string;
  status: MergeStatusValue;
  unmergedCount: number;
  dirty: boolean;
}

export interface MergeStatusResponse {
  target: string;
  entries: MergeStatusEntry[];
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
  // Target ids ("local" or a remote_server_id) on which this executor is
  // disabled. The UI checks membership for the currently-selected target.
  disabled_targets: string[];
  created_at: string;
  // Per-target "Last run" data, keyed by target identifier ("local" or a
  // remote_server_id). The UI looks up the entry for the currently selected
  // target to (1) show the "Last run: <datetime>" label and (2) reconnect to
  // the buffered log of a finished process after a workspace switch. Targets
  // the executor has never run on are simply absent from the map.
  last_runs?: Record<string, { started_at: string; process_id: string }>;
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
  // `historical` is a frontend-only tag set at WS-receipt time (before
  // history_end arrives). xterm parses writes asynchronously, so query
  // responses to replayed history fire after history_end has already been
  // processed — the renderer needs to know per-entry which data is replay.
  | { type: "stdout"; data: string; historical?: boolean }
  | { type: "stderr"; data: string; historical?: boolean }
  | { type: "pty"; data: string; historical?: boolean }
  | { type: "finished"; exitCode: number | null }
  | { type: "init"; isPty: boolean }
  | { type: "error"; message: string }
  | { type: "history_end" };

export type InputMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

// 多路复用 executor 日志通道
export type MuxClientMessage =
  | { type: "subscribe"; processId: string }
  | { type: "unsubscribe"; processId: string }
  | { type: "input"; processId: string; data: string }
  | { type: "resize"; processId: string; cols: number; rows: number };

export type MuxServerMessage = { processId: string } & LogMessage;

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
  archived_at: number | null;
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

export type ScheduleRunStatus = "running" | "completed" | "failed" | "timeout" | "killed" | "skipped";

export interface ScheduleRun {
  id: string;
  schedule_id: string;
  status: ScheduleRunStatus;
  exit_code: number | null;
  /** Only populated by getScheduleRun; list endpoints return null. */
  output?: string | null;
  /** Agent's final message for prompt runs (Markdown). Only populated by getScheduleRun. */
  report?: string | null;
  process_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface Schedule {
  id: string;
  project_id: string;
  name: string;
  cron_expr: string;
  timezone: string;
  target: string;
  enabled: boolean;
  run_type: "command" | "prompt";
  prompt_provider: PromptProvider | null;
  content: string;
  cwd_mode: "branch" | "directory";
  branch: string | null;
  directory: string | null;
  timeout_seconds: number;
  created_at: string;
  updated_at: string;
  // Enriched by GET /api/projects/:id/schedules
  last_run?: ScheduleRun | null;
  next_run_at?: string | null;
  running?: boolean;
}

export interface ScheduleInput {
  name: string;
  cron_expr: string;
  timezone: string;
  target: string;
  enabled?: boolean;
  run_type: "command" | "prompt";
  prompt_provider?: PromptProvider | null;
  content: string;
  cwd_mode: "branch" | "directory";
  branch?: string | null;
  directory?: string | null;
  timeout_seconds?: number;
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

export interface UploadResponse {
  uploaded: string[];
}

export interface SymbolHit {
  file: string;
  line: number;
  text: string;
  kind: "definition" | "reference";
}

export interface SymbolSearchResponse {
  symbol: string;
  hits: SymbolHit[];
  truncated: boolean;
}

export interface ProxyConfig {
  type: 'none' | 'http' | 'socks5';
  host: string;
  port: number;
}

export type ProviderId = 'deepseek' | 'openrouter';

export interface ProviderUiDef {
  id: ProviderId;
  label: string;
  /** Fixed model list (rendered as a dropdown), or null for free-form input. */
  models: readonly string[] | null;
  modelLabels?: Record<string, string>;
  defaultModel: string;
  placeholder?: string;
  /** Env var name shown in the API-key hint. */
  envKey: string;
}

export const PROVIDERS: Record<ProviderId, ProviderUiDef> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    modelLabels: {
      'deepseek-v4-flash': 'DeepSeek V4 Flash — faster, lower cost',
      'deepseek-v4-pro': 'DeepSeek V4 Pro — higher quality',
    },
    defaultModel: 'deepseek-v4-flash',
    placeholder: 'sk-...',
    envKey: 'DEEPSEEK_API_KEY',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    models: null,
    defaultModel: 'deepseek/deepseek-chat-v3-0324',
    placeholder: 'deepseek/deepseek-chat-v3-0324',
    envKey: 'OPENROUTER_API_KEY',
  },
};

export const PROVIDER_IDS: ProviderId[] = ['deepseek', 'openrouter'];

export interface ModelChoice {
  provider: ProviderId;
  model: string;
}

export interface ChatProviderConfig {
  apiKeys: Record<ProviderId, string>;
  main: ModelChoice;
  fast: ModelChoice;
}

export function defaultModelChoice(provider: ProviderId = 'deepseek'): ModelChoice {
  return { provider, model: PROVIDERS[provider].defaultModel };
}

export function defaultChatProviderConfig(): ChatProviderConfig {
  return {
    apiKeys: { deepseek: '', openrouter: '' },
    main: defaultModelChoice(),
    fast: defaultModelChoice(),
  };
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

export interface ConversationSettings {
  agentFontSize: number;
  chatFontSize: number;
  filesTreeFontSize: number;
  filesContentFontSize: number;
}

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  agentFontSize: 15,
  chatFontSize: 15,
  filesTreeFontSize: 14,
  filesContentFontSize: 14,
};

export const CONVERSATION_SETTINGS_LIMITS = {
  fontSizeMin: 12,
  fontSizeMax: 22,
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
  favorited_at?: number | null;
  branch?: string | null;
  projectId?: string;
  processAlive?: boolean;
}

// List all sessions for a (projectId, branch) pair
export async function listBranchSessions(
  projectId: string,
  branch: string | null
): Promise<{ sessions: BranchSessionSummary[] }> {
  // Main/default branch is represented by the empty-string sentinel ("") across
  // the system, so always send the param (empty for main) to keep the backend on
  // the branch-filtered query path rather than the unfiltered all-branches one.
  const qs = `?branch=${encodeURIComponent(branch ?? "")}`;
  const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions${qs}`);
  if (!res.ok) throw new Error(`listBranchSessions failed: ${res.status}`);
  return res.json();
}

// Explicitly create a new agent session (never reuses an existing one)
export async function createNewAgentSession(
  projectId: string,
  branch: string | null,
  permissionMode?: "plan" | "edit",
  agentType?: string,
  force?: boolean,
): Promise<{
  session: { id: string; projectId: string; branch: string | null; status: string; permissionMode?: string; agentType?: string; processAlive?: boolean };
  messages: unknown[];
}> {
  const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, permissionMode, agentType, force }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body?.errorCode === "resident_limit_reached") {
      throw new ResidentLimitError(
        body.maxResidentAgentProcesses,
        Array.isArray(body.runningSessions) ? body.runningSessions : [],
      );
    }
    throw new Error(`createNewAgentSession failed: ${res.status}`);
  }
  return res.json();
}

export interface RunningResidentSession {
  id: string;
  projectId?: string;
  branch?: string | null;
  title?: string | null;
  lastActiveAt?: number;
}

export class ResidentLimitError extends Error {
  readonly maxResidentAgentProcesses: number;
  readonly runningSessions: RunningResidentSession[];

  constructor(maxResidentAgentProcesses: number, runningSessions: RunningResidentSession[]) {
    super("Resident agent process limit reached");
    this.name = "ResidentLimitError";
    this.maxResidentAgentProcesses = maxResidentAgentProcesses;
    this.runningSessions = runningSessions;
  }
}

export interface AgentProcessSettings {
  maxResidentAgentProcesses: number;
}

export const DEFAULT_AGENT_PROCESS_SETTINGS: AgentProcessSettings = {
  maxResidentAgentProcesses: 3,
};

export const AGENT_PROCESS_SETTINGS_LIMITS = {
  min: 1,
  max: 10,
} as const;

export async function getAgentProcessSettings(): Promise<AgentProcessSettings> {
  const res = await authFetch(`${getApiBase()}/api/settings/agent-processes`);
  if (!res.ok) throw new Error(`getAgentProcessSettings failed: ${res.status}`);
  return res.json();
}

export async function updateAgentProcessSettings(settings: AgentProcessSettings): Promise<AgentProcessSettings> {
  const res = await authFetch(`${getApiBase()}/api/settings/agent-processes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`updateAgentProcessSettings failed: ${res.status}`);
  return res.json();
}

// Branch an agent session: creates a new session that copies the source
// session's conversation history ("Branch - <title>"). Optionally switches
// the coding agent for the new session.
export async function branchAgentSession(
  sessionId: string,
  agentType?: string
): Promise<{
  session: { id: string; projectId: string; branch: string | null; status: string; permissionMode?: string; agentType?: string; title?: string | null };
  messages: unknown[];
}> {
  const res = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentType }),
  });
  if (!res.ok) throw new Error(`branchAgentSession failed: ${res.status}`);
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

// Mark or unmark an agent session as favorited
export async function setSessionFavorited(sessionId: string, favorited: boolean): Promise<void> {
  const res = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/favorite`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorited }),
  });
  if (!res.ok) throw new Error(`setSessionFavorited failed: ${res.status}`);
}

export const api = {
  async getConfig(): Promise<AppConfig> {
    // Revalidate the persisted config once per page load and share that single
    // request across every consumer (AuthWrapper, UserMenu, GlobalEventStream…).
    // The resolved promise is cached for the page session so consumers mounting
    // in different waves reuse it instead of each firing their own /api/config;
    // a fresh load re-initializes this module and revalidates again. On failure
    // we clear it so a later caller can retry rather than inheriting the error.
    if (_configInFlight) return _configInFlight;
    _configInFlight = (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/config`);
        const data = (await res.json()) as AppConfig;
        _cachedConfig = data;
        persistConfig(data);
        return data;
      } catch (err) {
        _configInFlight = null;
        throw err;
      }
    })();
    return _configInFlight;
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

  async getProjectWorktrees(id: string, target?: string): Promise<Worktree[]> {
    const params = new URLSearchParams();
    if (target && target !== "local") params.set("target", target);
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await authFetch(`${getApiBase()}/api/projects/${id}/worktrees${query}`);
    if (!res.ok) {
      return [{ branch: null }];
    }
    const data = await res.json();
    return data.worktrees;
  },

  async getMergeStatus(id: string, target?: string): Promise<MergeStatusResponse | null> {
    try {
      const params = new URLSearchParams();
      if (target) params.set("target", target);
      const query = params.toString() ? `?${params.toString()}` : "";
      const res = await authFetch(`${getApiBase()}/api/projects/${id}/branches/merge-status${query}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
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
    opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean; target?: string; disabled?: boolean }
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

  async getDiff(projectId: string, branch?: string | null, commit?: string | null, target?: 'local' | 'remote', compareTo?: string | null): Promise<DiffResponse> {
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
    if (compareTo) {
      params.set('compareTo', compareTo);
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
    return Array.isArray(data?.commits) ? data.commits : [];
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

  async createRemoteServerDirectory(
    serverId: string,
    parentPath: string,
    name: string
  ): Promise<RemoteBrowseItem> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${serverId}/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentPath, name }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || "Failed to create directory");
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
  async getTasks(projectId: string, opts?: { includeArchived?: boolean }): Promise<Task[]> {
    const qs = opts?.includeArchived ? "?includeArchived=true" : "";
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/tasks${qs}`);
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

  async archiveTask(id: string): Promise<Task> {
    const res = await authFetch(`${getApiBase()}/api/tasks/${id}/archive`, { method: "POST" });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.task;
  },

  async unarchiveTask(id: string): Promise<Task> {
    const res = await authFetch(`${getApiBase()}/api/tasks/${id}/unarchive`, { method: "POST" });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.task;
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

  async getSchedules(projectId: string): Promise<Schedule[]> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/schedules`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.schedules;
  },

  async createSchedule(projectId: string, opts: ScheduleInput): Promise<Schedule> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.schedule;
  },

  async updateSchedule(id: string, opts: Partial<ScheduleInput>): Promise<Schedule> {
    const res = await authFetch(`${getApiBase()}/api/schedules/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.schedule;
  },

  async deleteSchedule(id: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/schedules/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async runScheduleNow(id: string): Promise<{ runId: string }> {
    const res = await authFetch(`${getApiBase()}/api/schedules/${id}/run`, { method: "POST" });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  async getScheduleRuns(id: string): Promise<ScheduleRun[]> {
    const res = await authFetch(`${getApiBase()}/api/schedules/${id}/runs`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.runs;
  },

  async getScheduleRun(runId: string): Promise<ScheduleRun> {
    const res = await authFetch(`${getApiBase()}/api/schedule-runs/${runId}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.run;
  },

  // File Browser API
  async browseProjectDirectory(
    projectId: string,
    relativePath?: string,
    branch?: string | null,
    target?: "local" | "remote",
    showHidden?: boolean
  ): Promise<BrowseResponse> {
    const params = new URLSearchParams();
    if (relativePath) params.set("path", relativePath);
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);
    if (showHidden) params.set("hidden", "1");
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/browse${query}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  async listProjectFiles(
    projectId: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<{ files: string[]; truncated: boolean }> {
    const params = new URLSearchParams();
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/list-files${query}`);
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

  async searchSymbol(
    projectId: string,
    symbol: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<SymbolSearchResponse> {
    const params = new URLSearchParams({ symbol });
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);
    const res = await authFetch(
      `${getApiBase()}/api/projects/${projectId}/symbol-search?${params.toString()}`
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || "Symbol search failed");
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

  // Fetch the file's raw bytes as a Blob, carrying auth headers via authFetch.
  // Used for inline previews (e.g. images): a plain <img src={downloadUrl}> can't
  // send the Authorization header the download route requires under --auth, so we
  // fetch here and hand the caller an object URL via URL.createObjectURL.
  async getFileBlob(
    projectId: string,
    filePath: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<Blob> {
    const url = this.getFileDownloadUrl(projectId, filePath, branch, target);
    const res = await authFetch(url);
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || "Failed to load file");
    }
    return res.blob();
  },

  // Fetch the file as a blob (carrying auth headers) and trigger a real browser
  // download. Using authFetch + an <a download> element avoids opening the file
  // inline in a new tab, which window.open() does when the browser renders the
  // content instead of honoring Content-Disposition (and which also can't send
  // the Authorization header the download route requires under --auth).
  async downloadFile(
    projectId: string,
    filePath: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<void> {
    const url = this.getFileDownloadUrl(projectId, filePath, branch, target);
    const res = await authFetch(url);
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || "Download failed");
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filePath.split("/").pop() || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  async uploadFiles(
    projectId: string,
    files: File[],
    targetPath: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<UploadResponse> {
    const params = new URLSearchParams();
    if (targetPath) params.set("path", targetPath);
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);
    const query = params.toString() ? `?${params.toString()}` : "";

    const form = new FormData();
    for (const file of files) {
      form.append("file", file, file.name);
    }

    // Do NOT set Content-Type — the browser sets the multipart boundary.
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/upload${query}`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || "Upload failed");
    }
    return res.json();
  },

  async deleteFile(
    projectId: string,
    filePath: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<{ deleted: string }> {
    const params = new URLSearchParams({ path: filePath });
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);

    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/file?${params.toString()}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || "Delete failed");
    }
    return res.json();
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

  // Chat Tool Approval
  async chatToolApproval(sessionId: string, approvalId: string, approved: boolean): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/chat-sessions/${sessionId}/tool-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId, approved }),
    });
    if (!res.ok) throw new Error("Tool approval failed");
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
      return defaultChatProviderConfig();
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

  async getConversationSettings(): Promise<ConversationSettings> {
    const res = await authFetch(`${getApiBase()}/api/settings/conversation`);
    if (!res.ok) {
      return { ...DEFAULT_CONVERSATION_SETTINGS };
    }
    return res.json();
  },

  async updateConversationSettings(
    config: Partial<ConversationSettings>,
    options: { keepalive?: boolean } = {},
  ): Promise<ConversationSettings> {
    const res = await authFetch(`${getApiBase()}/api/settings/conversation`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
      // keepalive: true lets the request finish after the page unmounts/unloads,
      // so a drag-then-close-tab inside the debounce window still persists.
      keepalive: options.keepalive,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to update conversation settings" }));
      throw new Error(err.error || "Failed to update conversation settings");
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

  async updateRemoteServer(id: string, opts: { name?: string; url?: string; apiKey?: string; crossRemoteAccess?: CrossRemoteAccess }): Promise<RemoteServer> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    // The PUT handler replies with the sanitized server object directly, not { server }.
    return (await res.json()) as RemoteServer;
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

  /**
   * Origin that serves the browser-proxy iframes. Used to scope the postMessage
   * command channel so commands target — and results are accepted from — only the
   * proxy origin (never "*"). Dev serves the proxy from :5173; production bundles
   * it same-origin.
   */
  getBrowserProxyOrigin(): string {
    const base = getApiBase();
    if (base) return new URL(base).origin;
    return typeof window !== "undefined" ? window.location.origin : "";
  },
};
