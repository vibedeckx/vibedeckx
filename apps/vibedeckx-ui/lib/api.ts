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
  _tokenGeneration++;
  _mintInFlight = null;
}

// Bumped on every setTokenGetter(). A mint that started under an earlier getter
// (previous account, or pre-sign-out) must not write its result into the cache
// after the swap: sign-out runs `setTokenGetter(null); setAuthToken(null)`, and a
// late-resolving mint would otherwise put the old user's JWT straight back.
let _tokenGeneration = 0;

// Single-flight guard for forced network mints. On a cold page load `_authToken`
// is null, so every concurrent `getFreshToken()` caller (the warm-up plus the
// first wave of API fetches and WS/SSE connects — 20+ in parallel) decides
// `skipCache: true` before the first mint has landed. `skipCache` bypasses
// Clerk's own in-flight dedup, so without this each caller sent its own
// `POST /v1/client/sessions/:id/tokens` — one token storm per refresh. Callers
// that arrive while a mint is in flight await that same promise instead: the
// token it yields is just as fresh as one they would mint themselves.
let _mintInFlight: Promise<string | null> | null = null;

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
      const generation = _tokenGeneration;
      let token: string | null;
      if (!skipCache) {
        token = await _tokenGetter({ skipCache: false });
      } else if (_mintInFlight) {
        token = await _mintInFlight;
      } else {
        const getter = _tokenGetter;
        // The chain writes the cache itself, *before* the guard is cleared:
        // if the guard were dropped first, a caller landing in the microtask gap
        // before the waiters resume would see "cold cache, nothing in flight"
        // and start a second mint.
        const mint = getter({ skipCache: true })
          .then((t) => {
            if (generation === _tokenGeneration) _authToken = t;
            return t;
          })
          .finally(() => {
            if (_mintInFlight === mint) _mintInFlight = null;
          });
        _mintInFlight = mint;
        token = await mint;
      }
      if (generation === _tokenGeneration) _authToken = token;
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
  // Ephemeral / network-only — NEVER persisted (see persistConfig). Drives the
  // header Discord button; unsetting the server env var must reliably hide it.
  discordInviteUrl?: string;
}

let _cachedConfig: AppConfig | null = null;
let _configInFlight: Promise<AppConfig> | null = null;

// Persist the app config (public, non-sensitive: an authEnabled flag plus the
// public Clerk publishable key) so a refresh can mount the auth provider on the
// first render instead of blocking it on the /api/config round-trip. The value
// is always revalidated against the server in the background — see getConfig.
const CONFIG_STORAGE_KEY = "vibedeckx:app-config";

// discordInviteUrl is network-only: it must never live in the synchronously-read
// persisted cache, so a removed env var can't leave a stale button and a stale
// invite can never resurrect from cache. Stripped on BOTH the write and the read
// path so the guarantee holds no matter how a value entered storage.
function withoutEphemeralFields(config: AppConfig): AppConfig {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { discordInviteUrl: _drop, ...rest } = config;
  return rest;
}

function persistConfig(config: AppConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(withoutEphemeralFields(config)));
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
    // Strip again on read: a cache written by an older build (or otherwise
    // seeded) may still carry discordInviteUrl — it must not surface here.
    _cachedConfig = withoutEphemeralFields(JSON.parse(raw) as AppConfig);
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
  agent_mode: ExecutionMode;
  executor_mode: ExecutionMode;
  sync_up_config?: SyncButtonConfig;
  sync_down_config?: SyncButtonConfig;
  created_at: string;
}

export type RemoteServerStatus = 'unknown' | 'online' | 'offline';
export type CrossRemoteAccess = 'off' | 'read' | 'exec';

export type WorkerUpdateStatus = 'unreported' | 'behind-min' | 'behind-latest' | 'current';

export interface RemoteServer {
  id: string;
  name: string;
  status: RemoteServerStatus;
  last_connected_at?: string;
  created_at: string;
  updated_at: string;
  cross_remote_access: CrossRemoteAccess;
  /** Version the worker reported at its last handshake; absent = pre-reporting worker. */
  worker_version?: string;
  worker_capabilities?: string[];
  worker_version_reported_at?: string;
  /** npm latest at list time (server-cached); absent when the registry check failed. */
  latest_worker_version?: string;
  worker_update_status?: WorkerUpdateStatus;
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
  // Optionally joined from the remote server (see useProjectRemotes withStatus)
  status?: RemoteServerStatus;
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
  /** Stable workspace/session identity. */
  branch: string | null;
  /** Live checkout when it differs from `branch`; null means detached HEAD. */
  currentBranch?: string | null;
  /** Display name for the root workspace, whose `branch` identity is null. */
  expectedBranch?: string;
}

export type MergeStatusValue = "merged" | "partial" | "unmerged" | "no-unique-commits";

export interface MergeComparison {
  branch: string;
  /** Omitted = compare against the auto-detected default branch (main/master). */
  target?: string;
}

export type MergePairError = "target-not-found" | "branch-not-found" | "no-default-branch";

export type TargetSource = "request" | "stored" | "default";

/**
 * Merge-status entry returned by the project endpoint.
 * For target-not-found warnings, read requestedTarget: target is null because
 * the computation layer could not resolve it.
 */
export interface ProjectMergeStatusPairEntry {
  branch: string;
  /** Resolved target branch; null when errored before resolution. */
  target: string | null;
  targetSource: TargetSource;
  requestedTarget: string | null;
  status?: MergeStatusValue;
  unmergedCount?: number;
  dirty?: boolean;
  error?: MergePairError;
}

export type MergeStatusRepository =
  | { kind: "local"; label: "Local" }
  | { kind: "remote"; remoteServerId: string; label: string };

export type MergeStatusBatchResult =
  | { ok: true; repository: MergeStatusRepository; entries: ProjectMergeStatusPairEntry[] }
  | { ok: false; status: number }; // status 0 = thrown fetch/network error

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

export type ExecutorType = 'command' | 'prompt';
export type PromptProvider = 'claude' | 'codex';

export interface Executor {
  id: string;
  project_id: string;
  workspace_id: string;
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
  // `retryable` means the transport failed, not the process — the server could
  // not reach the worker. Re-subscribing later may well succeed.
  | { type: "error"; message: string; retryable?: boolean }
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

export type ScheduleRunStatus = "starting" | "running" | "completed" | "failed" | "timeout" | "killed" | "skipped";

export interface ScheduleRun {
  id: string;
  schedule_id: string;
  project_id: string | null;
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
  /** Set when this schedule came from an agent's propose_schedule card. */
  source_session_id?: string | null;
  source_tool_use_id?: string | null;
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
  /**
   * Provenance of an agent proposal. Sending it makes creation idempotent: the
   * same (session, tool_use) pair can only ever produce one schedule, and a
   * replay returns the existing one.
   */
  source?: { session_id: string; tool_use_id: string };
}

// ============ Project Activity / Project Chat ============

export interface ProjectChatThread {
  id: string;
  project_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived_at: number | null;
}

export interface ProjectChatThreadPage {
  threads: ProjectChatThread[];
  nextCursor: string | null;
}

export type ProjectChatMessageType =
  | "user"
  | "assistant"
  | "system"
  | "tool_use"
  | "tool_result"
  | "tool_approval_request"
  | "operation"
  | "error"
  | "turn_end";

export interface ProjectChatMessage {
  id: string;
  thread_id: string;
  sequence: number;
  type: ProjectChatMessageType;
  content: string;
  created_at: string;
}

export type ProjectChatContextEntityType =
  | "task"
  | "workspace"
  | "agent_session"
  | "schedule"
  | "schedule_run";

export type ProjectChatContextNavigation =
  | { kind: "task"; taskId: string; label: string }
  | { kind: "workspace"; target: string; branch: string | null; label: string }
  | { kind: "agent_session"; sessionId: string; target: string; branch: string | null; label: string }
  | { kind: "schedule"; scheduleId: string; label: string }
  | { kind: "schedule_run"; scheduleId: string; runId: string; label: string };

export interface ProjectChatContextRef {
  thread_id: string;
  entity_type: ProjectChatContextEntityType;
  entity_id: string;
  last_referenced_at: string;
  deleted: boolean;
  navigation: ProjectChatContextNavigation | null;
}

export interface ProjectChatThreadDetail {
  thread: ProjectChatThread;
  contextRefs: ProjectChatContextRef[];
}

export type ProjectChatOperationKind =
  | "task_create"
  | "task_update"
  | "agent_session_create"
  | "agent_instruction"
  | "schedule_run"
  | "workspace_selection";

export type ProjectChatOperationStatus = "pending" | "resolving" | "running" | "completed" | "failed";

export type ProjectChatOperationFailureCode =
  | "failed"
  | "timeout"
  | "remote_offline"
  | "deleted_target";

export interface ProjectChatOperationFailure {
  code: ProjectChatOperationFailureCode;
  message: string;
}

interface ProjectChatOperationMessageBase {
  version: 1;
  operationId: string;
  status: ProjectChatOperationStatus;
  failure?: ProjectChatOperationFailure;
}

export type ProjectChatOperationMessage = ProjectChatOperationMessageBase & (
  | {
    kind: "task_create";
    taskId: string;
    title?: string;
  }
  | {
    kind: "task_update";
    taskId: string;
    title?: string;
  }
  | {
    kind: "agent_session_create";
    sessionId: string;
    target?: string;
    branch?: string | null;
    instruction?: string;
    sessionAvailable: boolean;
  }
  | {
    kind: "agent_instruction";
    sessionId: string;
    instruction?: string;
  }
  | {
    kind: "schedule_run";
    scheduleId: string;
    runId: string;
    runAvailable: boolean;
  }
  | {
    kind: "workspace_selection";
    requestId: string;
    candidates: ProjectChatWorkspaceCandidate[];
  }
);

export interface ProjectChatWorkspaceCandidate {
  id: string;
  target: string;
  branch: string | null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PUBLIC_OPERATION_BASE_KEYS = ["version", "operationId", "kind", "status", "failure"] as const;
const PUBLIC_OPERATION_KEYS = {
  task_create: [...PUBLIC_OPERATION_BASE_KEYS, "taskId", "title"],
  task_update: [...PUBLIC_OPERATION_BASE_KEYS, "taskId", "title"],
  agent_session_create: [...PUBLIC_OPERATION_BASE_KEYS, "sessionId", "target", "branch", "instruction", "sessionAvailable"],
  agent_instruction: [...PUBLIC_OPERATION_BASE_KEYS, "sessionId", "instruction"],
  schedule_run: [...PUBLIC_OPERATION_BASE_KEYS, "scheduleId", "runId", "runAvailable"],
  workspace_selection: [...PUBLIC_OPERATION_BASE_KEYS, "requestId", "candidates"],
} as const;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, options: { optional?: boolean; allowEmpty?: boolean } = {}): value is string | undefined {
  if (value === undefined) return options.optional === true;
  return typeof value === "string" && value.length <= 512 && (options.allowEmpty === true || value.length > 0);
}

/**
 * Parses the versioned public operation envelope. This deliberately validates
 * the JSON shape and never derives operation state or identities from prose.
 */
export function parseProjectChatOperationMessage(content: string): ProjectChatOperationMessage | null {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (!isRecordValue(value) || value.version !== 1
    || !isBoundedString(value.operationId)
    || !["pending", "resolving", "running", "completed", "failed"].includes(String(value.status))
    || !["task_create", "task_update", "agent_session_create", "agent_instruction", "schedule_run", "workspace_selection"]
      .includes(String(value.kind))) return null;
  const kind = value.kind as keyof typeof PUBLIC_OPERATION_KEYS;
  if (!hasOnlyKeys(value, PUBLIC_OPERATION_KEYS[kind])) return null;
  if (value.failure !== undefined) {
    if (!isRecordValue(value.failure)
      || !hasOnlyKeys(value.failure, ["code", "message"])
      || !["failed", "timeout", "remote_offline", "deleted_target"].includes(String(value.failure.code))
      || !isBoundedString(value.failure.message)) return null;
  }
  if ((value.status === "failed") !== (value.failure !== undefined)) return null;
  if ((value.kind === "task_create" || value.kind === "task_update")
    && (!isBoundedString(value.taskId)
      || !isBoundedString(value.title, { optional: true, allowEmpty: true }))) return null;
  if (value.kind === "agent_instruction"
    && (!isBoundedString(value.sessionId)
      || !isBoundedString(value.instruction, { optional: true, allowEmpty: true }))) return null;
  if (value.kind === "agent_session_create"
    && (!isBoundedString(value.sessionId)
      || !isBoundedString(value.target, { optional: true, allowEmpty: true })
      || value.branch !== undefined && value.branch !== null
        && !isBoundedString(value.branch, { allowEmpty: true })
      || !isBoundedString(value.instruction, { optional: true, allowEmpty: true })
      || typeof value.sessionAvailable !== "boolean")) return null;
  if (value.kind === "schedule_run"
    && (!isBoundedString(value.scheduleId) || !isBoundedString(value.runId)
      || typeof value.runAvailable !== "boolean")) return null;
  if (value.kind === "workspace_selection") {
    if (!isBoundedString(value.requestId) || !Array.isArray(value.candidates)
      || value.candidates.length > 20) return null;
    if (!value.candidates.every((candidate) => isRecordValue(candidate)
      && hasOnlyKeys(candidate, ["id", "target", "branch"])
      && isBoundedString(candidate.id)
      && isBoundedString(candidate.target, { allowEmpty: true })
      && (candidate.branch === null || isBoundedString(candidate.branch, { allowEmpty: true })))) return null;
  }
  return value as unknown as ProjectChatOperationMessage;
}

export interface ProjectChatToolApprovalMessage {
  approvalId: string;
  tool?: string;
  input?: unknown;
  [key: string]: unknown;
}

export type ProjectChatStatus = "idle" | "running" | "queued";

export interface ProjectChatSnapshot {
  identity: { projectId: string; threadId: string; userId: string };
  thread: ProjectChatThread;
  messages: ProjectChatMessage[];
  hasEarlierMessages: boolean;
  earliestSequence: number | null;
  status: ProjectChatStatus;
  activeTurnId: string | null;
  pendingApprovalIds: string[];
  queueLength: number;
  contextRefs: ProjectChatContextRef[];
}

export interface ProjectChatMessagePage {
  messages: ProjectChatMessage[];
  hasMore: boolean;
  nextCursor: number | null;
}

export interface ProjectAgentSessionActivity {
  id: string;
  projectId: string;
  branch: string | null;
  status: "running" | "stopped" | "error" | "unknown";
  title: string | null;
  target: string;
  workspace: { target: string; branch: string | null };
  agentType: string | null;
  model: string | null;
  lastActiveAt: number | null;
  lastUserMessageAt: number | null;
  lastCompletedAt: number | null;
}

export interface ProjectScheduleRunActivity {
  id: string;
  schedule_id: string;
  status: ScheduleRunStatus;
  exit_code: number | null;
  process_id: string | null;
  started_at: string;
  finished_at: string | null;
  scheduleName: string;
  branch: string | null;
  target: string;
  reportPreview: string | null;
}

export interface ProjectActivityAttentionItem {
  type: "agent_session" | "schedule_run";
  entityId: string;
  status: string;
  title: string;
  occurredAt: string;
  target?: string;
  workspace?: { target: string; branch: string | null };
}

export interface ProjectActivity {
  recentThreads: ProjectChatThread[];
  recentAgentSessions: ProjectAgentSessionActivity[];
  recentScheduleRuns: ProjectScheduleRunActivity[];
  priorityTasks: Task[];
  attention: ProjectActivityAttentionItem[];
  summary: { running: number; nextScheduleAt: string | null };
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

export type ProviderId = 'deepseek' | 'openrouter' | 'gateway';

export interface ProviderUiDef {
  id: ProviderId;
  label: string;
  /** One-line pitch shown on the provider radio card. */
  description: string;
  /** Fixed model list (rendered as a dropdown), or null for free-form input. */
  models: readonly string[] | null;
  modelLabels?: Record<string, string>;
  defaultModel: string;
  placeholder?: string;
  /** Placeholder for the API-key input, when the provider's keys aren't `sk-…`. */
  keyPlaceholder?: string;
  /** Env var name shown in the API-key hint. */
  envKey: string;
}

export const PROVIDERS: Record<ProviderId, ProviderUiDef> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'Direct API access — lowest latency',
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
    description: 'Aggregator routing — many models available',
    models: null,
    defaultModel: 'deepseek/deepseek-chat-v3-0324',
    placeholder: 'deepseek/deepseek-chat-v3-0324',
    envKey: 'OPENROUTER_API_KEY',
  },
  gateway: {
    id: 'gateway',
    label: 'Vercel AI Gateway',
    description: 'One key, unified billing and failover',
    models: null,
    defaultModel: 'anthropic/claude-sonnet-5',
    placeholder: 'anthropic/claude-sonnet-5',
    keyPlaceholder: 'vck_...',
    envKey: 'AI_GATEWAY_API_KEY',
  },
};

export const PROVIDER_IDS: ProviderId[] = ['deepseek', 'openrouter', 'gateway'];

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
    apiKeys: emptyByProvider(''),
    main: defaultModelChoice(),
    fast: defaultModelChoice(),
  };
}

/** `{ deepseek: v, openrouter: v, … }` — keeps callers off hardcoded provider lists. */
export function emptyByProvider<T>(value: T): Record<ProviderId, T> {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, value])) as Record<ProviderId, T>;
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
  agentFontSize: 16,
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

/** Review-scope span; mirrors the backend `ReviewSpan` (frontend can't import backend types). */
export type ReviewSpan = "this_turn" | "session_start";

export interface AgentProviderInfo {
  type: AgentType;
  displayName: string;
  available: boolean;
  /**
   * Suggested model names for this agent. NOT a whitelist — the picker also
   * accepts free text, and nothing validates against this list.
   */
  models?: string[];
}

export async function getAgentProviders(): Promise<AgentProviderInfo[]> {
  const res = await authFetch(`${getApiBase()}/api/agent-providers`);
  const data = await res.json();
  return data.providers;
}

// ---- Notification inbox ----
// The server database is authoritative for both the list and the read state;
// `notification:created` SSE is only a low-latency hint that a new row exists.

export type NotificationKind =
  | "review_ready"
  | "session_result_ready"
  | "session_failed"
  | "workflow_failed";

/** Server row shape — snake_case, exactly as `/api/notifications` returns it. */
export interface ServerNotification {
  id: string;
  kind: NotificationKind;
  project_id: string;
  branch: string | null;
  session_id: string | null;
  workflow_run_id: string | null;
  title: string;
  body: string | null;
  created_at: number;
  read_at: number | null;
}

export async function getNotifications(
  opts?: { unread?: boolean; limit?: number },
): Promise<ServerNotification[]> {
  const params = new URLSearchParams();
  if (opts?.unread) params.set("unread", "true");
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const query = params.toString();
  const res = await authFetch(`${getApiBase()}/api/notifications${query ? `?${query}` : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch notifications: ${res.status}`);
  return (await res.json()).notifications;
}

export async function markNotificationRead(id: string): Promise<void> {
  const res = await authFetch(`${getApiBase()}/api/notifications/${encodeURIComponent(id)}/read`, {
    method: "PATCH",
  });
  if (!res.ok) throw new Error(`Failed to mark notification read: ${res.status}`);
}

export async function markAllNotificationsRead(): Promise<void> {
  const res = await authFetch(`${getApiBase()}/api/notifications/read-all`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to mark notifications read: ${res.status}`);
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

// ============ Search Helpers ============

export type SearchCacheState = "cold" | "stale" | "fresh";
export interface SearchResultProject { id: string; name: string; path: string | null }
export interface SearchResultWorkspace { projectId: string; projectName: string; targetId: string; branch: string | null }
export interface SearchResultSession {
  sessionId: string; projectId: string; projectName: string; targetId: string;
  branch: string | null; title: string | null; lastActiveAt: number | null; favoritedAt: number | null;
}
export interface SearchResponse {
  projects: SearchResultProject[];
  workspaces: SearchResultWorkspace[];
  sessions: SearchResultSession[];
  // Recents mode (empty query) only: favorited sessions that didn't make the
  // recency cut in `sessions`. Always [] when a query term is present.
  favorites: SearchResultSession[];
  cacheState: SearchCacheState;
}

export async function searchAll(q: string, opts?: { signal?: AbortSignal }): Promise<SearchResponse> {
  const res = await authFetch(`${getApiBase()}/api/search?q=${encodeURIComponent(q)}`, { signal: opts?.signal });
  if (!res.ok) throw new Error(`searchAll failed: ${res.status}`);
  return res.json();
}

export async function refreshSearchCache(): Promise<{ ok: boolean; cacheState: SearchCacheState }> {
  const res = await authFetch(`${getApiBase()}/api/search/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(`refreshSearchCache failed: ${res.status}`);
  return res.json();
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
  model?: string | null;
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

// Deliberately minimal: a sidebar row's name, the workspace it hangs under,
// and its dot. No timestamp — the list arrives most-recently-active first.
export interface AliveSessionSummary {
  id: string;
  branch: string | null;
  title?: string | null;
  status: string;
}

/**
 * Every session in the project that currently holds a live agent process — one
 * request for the whole sidebar, instead of one per workspace. Rows come back
 * most recently active first.
 *
 * `complete: false` means the answer couldn't be enumerated (a remote worker
 * too old to serve the endpoint); the caller must fall back to
 * `listBranchSessions` per branch. A worker that is merely offline/erroring
 * REJECTS instead, so the caller keeps the rows it already has.
 */
export async function listAliveSessions(
  projectId: string
): Promise<{ sessions: AliveSessionSummary[]; complete: boolean }> {
  const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions/alive`);
  if (!res.ok) throw new Error(`listAliveSessions failed: ${res.status}`);
  return res.json();
}

// Explicitly create a new agent session (never reuses an existing one)
export async function createNewAgentSession(
  projectId: string,
  branch: string | null,
  permissionMode?: "plan" | "edit",
  agentType?: string,
  force?: boolean,
  model?: string | null,
): Promise<{
  session: { id: string; projectId: string; branch: string | null; status: string; permissionMode?: string; agentType?: string; model?: string | null; processAlive?: boolean };
  messages: unknown[];
}> {
  const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, permissionMode, agentType, force, model }),
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

// ---- Session retention ----
// Deletes sessions that have been inactive past the window, unless favorited.
// One global value for the whole deployment; the server fans it out to every
// worker, because a session is deleted by the machine that holds it.

export interface SessionRetentionSettings {
  /** null = retention off (the default). */
  days: number | null;
  /** Prefill for the input when the operator first turns retention on. */
  suggestedDays: number;
  minDays: number;
  maxDays: number;
}

/** Per-worker outcome of pushing the window down the tunnel. */
export interface SessionRetentionWorkerResult {
  remoteServerId: string;
  name: string;
  status: "applied" | "needs_upgrade" | "unreachable" | "error";
  detail?: string;
}

export async function getSessionRetentionSettings(): Promise<SessionRetentionSettings> {
  const res = await authFetch(`${getApiBase()}/api/settings/session-retention`);
  if (!res.ok) throw new Error(`getSessionRetentionSettings failed: ${res.status}`);
  return res.json();
}

export async function updateSessionRetentionSettings(
  days: number | null,
): Promise<{ days: number | null; workers: SessionRetentionWorkerResult[] }> {
  const res = await authFetch(`${getApiBase()}/api/settings/session-retention`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `updateSessionRetentionSettings failed: ${res.status}`);
  }
  return res.json();
}

// Branch an agent session: creates a new session that copies the source
// session's conversation history ("Branch - <title>"). Optionally switches
// the coding agent for the new session.
export async function branchAgentSession(
  sessionId: string,
  agentType?: string,
  upToEntryIndex?: number
): Promise<{
  session: { id: string; projectId: string; branch: string | null; status: string; permissionMode?: string; agentType?: string; title?: string | null };
  messages: unknown[];
}> {
  const res = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentType, upToEntryIndex }),
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

/**
 * Vouch for a background task: stop counting it toward the park deadline, so
 * the turn is not force-closed on its account and the session keeps its
 * resident-process shield.
 *
 * A worker older than the route 404s; the caller treats that as "this session
 * has no deadline to defuse" rather than an error.
 */
export async function keepBackgroundTaskRunning(sessionId: string, taskId: string): Promise<void> {
  const res = await authFetch(
    `${getApiBase()}/api/agent-sessions/${sessionId}/background-tasks/${encodeURIComponent(taskId)}/keep`,
    { method: "POST" },
  );
  if (!res.ok && res.status !== 404) throw new Error(`keepBackgroundTaskRunning failed: ${res.status}`);
}

/**
 * Ask the agent to stop one background task.
 *
 * Returns false when the agent has no such primitive (501, Codex) or the
 * worker predates the route (404) — the caller then points at stopping the
 * session, which always works.
 */
export async function stopBackgroundTask(sessionId: string, taskId: string): Promise<boolean> {
  const res = await authFetch(
    `${getApiBase()}/api/agent-sessions/${sessionId}/background-tasks/${encodeURIComponent(taskId)}/stop`,
    { method: "POST" },
  );
  if (res.status === 501 || res.status === 404) return false;
  if (!res.ok) throw new Error(`stopBackgroundTask failed: ${res.status}`);
  return true;
}

// ============ Workflow Runs (agent-review loop) ============

/**
 * A background task the agent launched that is still running. Mirrors the
 * backend ledger: `local_bash` is a real OS process, `local_agent` is a
 * subagent running inside the same CLI process — so "N background processes"
 * is only an honest label for the former.
 *
 * These outlive the turn that started them, and Claude Code does not bound
 * their runtime, so a task with a faulty exit condition can run indefinitely
 * while the session sits at "running" with no visible explanation.
 */
export interface BackgroundTask {
  taskId: string;
  taskType?: string;
  description?: string;
  /** Epoch ms, stamped when the server first saw the task. */
  startedAt: number;
  /**
   * The user vouched for this one ("keep running"), so it no longer pressures
   * the session: no park deadline, and it keeps shielding the session from
   * being reclaimed.
   */
  sanctioned?: boolean;
}

export interface WorkflowRun {
  id: string;
  project_id: string;
  branch: string | null;
  source_session_id: string;
  source_turn_end_index: number;
  reviewer_session_id: string | null;
  review_focus: string | null;
  review_target: string | null;
  feedback_snapshot: string | null;
  status: "waiting_reviewer" | "waiting_feedback" | "discussing" | "sending_feedback" | "completed" | "cancelled" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewerCandidate {
  available: boolean;
  sessionId: string | null;
  title: string | null;
  agentType: AgentType | null;
  reason:
    | "deleted"
    | "project-mismatch"
    | "branch-mismatch"
    | "running"
    | "busy"
    | "unsupported-agent"
    | "unavailable"
    | null;
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

  async getProjectWorktrees(id: string, target?: string, signal?: AbortSignal): Promise<Worktree[]> {
    const params = new URLSearchParams();
    if (target && target !== "local") params.set("target", target);
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await authFetch(`${getApiBase()}/api/projects/${id}/worktrees${query}`, { signal });
    if (!res.ok) {
      // Throw instead of fabricating a root-only list: callers must be able
      // to tell "the server says there is only main" from "the fetch failed"
      // (useWorktrees keeps failed results non-authoritative).
      throw new Error(`Failed to fetch worktrees: ${res.status}`);
    }
    const data = await res.json();
    return data.worktrees;
  },

  /** Adopt `branch` as the main workspace's expected branch, clearing its drift warning. */
  async anchorRootWorkspace(id: string, branch: string, target?: string): Promise<string> {
    const res = await authFetch(`${getApiBase()}/api/projects/${id}/worktrees/anchor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch, ...(target && target !== "local" ? { target } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to anchor workspace");
    return data.expectedBranch;
  },

  /**
   * Re-anchor the main workspace to `branch` regardless of what is checked out
   * there — the branch it now differs from shows up as drift, which the user
   * resolves with Git on their own terms.
   */
  async setRootWorkspaceBranch(id: string, branch: string, target?: string): Promise<string> {
    const res = await authFetch(`${getApiBase()}/api/projects/${id}/worktrees/anchor-branch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch, ...(target && target !== "local" ? { target } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to change workspace branch");
    return data.expectedBranch;
  },

  async getMergeStatus(id: string, comparisons: MergeComparison[]): Promise<MergeStatusBatchResult> {
    try {
      const res = await authFetch(`${getApiBase()}/api/projects/${id}/branches/merge-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comparisons }),
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return { ok: true, repository: data.repository, entries: data.entries ?? [] };
    } catch {
      return { ok: false, status: 0 };
    }
  },

  async setMergeTarget(
    projectId: string,
    branch: string,
    target: string | null,
    opts?: { ifAbsent?: boolean },
  ): Promise<boolean> {
    try {
      const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/branches/merge-target`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch,
          target,
          ...(opts?.ifAbsent ? { ifAbsent: true } : {}),
        }),
      });
      return res.ok;
    } catch {
      return false;
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

  // Executor API
  // `branch` scopes the list to one workspace; the "" main-workspace sentinel
  // is a real value here, so only `undefined` means "every executor".
  async getExecutors(projectId: string, branch?: string | null): Promise<Executor[]> {
    const params = new URLSearchParams();
    if (branch !== undefined && branch !== null) params.set("branch", branch);
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
    opts: { name: string; command: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string; pty?: boolean; branch: string }
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

  async reorderExecutors(projectId: string, orderedIds: string[], branch: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/executors/reorder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds, branch }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  // Process Control API
  // No branch: the server derives the working directory from the executor's
  // own workspace, so a stale selection here can't run it somewhere else.
  async startExecutor(executorId: string, target?: string): Promise<string> {
    const res = await authFetch(`${getApiBase()}/api/executors/${executorId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
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

  async getTask(projectId: string, taskId: string): Promise<Task> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/tasks/${taskId}`);
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error ?? `Failed to fetch task: ${res.status}`);
    }
    return (await res.json()).task;
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

  async runScheduleNow(
    id: string,
    request: { requestId: string; runId: string; sourceRunId?: string },
  ): Promise<{ runId: string; replay?: boolean; status?: ScheduleRun["status"] }> {
    const res = await authFetch(`${getApiBase()}/api/schedules/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const error = await res.json();
      throw Object.assign(new Error(error.error), {
        status: res.status,
        durable: error.durable === true,
        runId: error.runId,
        runStatus: error.status,
      });
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

  async getProjectActivity(projectId: string, opts?: { signal?: AbortSignal }): Promise<ProjectActivity> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/activity`, {
      signal: opts?.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Failed to fetch project activity: ${res.status}`);
    }
    return res.json();
  },

  async listProjectChatThreads(
    projectId: string,
    includeArchived = false,
    opts?: { signal?: AbortSignal },
  ): Promise<ProjectChatThread[]> {
    const query = includeArchived ? "?includeArchived=true" : "";
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/project-chat/threads${query}`, {
      signal: opts?.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Failed to list Project Chat threads: ${res.status}`);
    }
    return (await res.json()).threads;
  },

  async listProjectChatThreadPage(
    projectId: string,
    opts?: {
      includeArchived?: boolean;
      query?: string;
      cursor?: string;
      signal?: AbortSignal;
    },
  ): Promise<ProjectChatThreadPage> {
    const query = new URLSearchParams();
    if (opts?.includeArchived) query.set("includeArchived", "true");
    if (opts?.query?.trim()) query.set("q", opts.query.trim());
    if (opts?.cursor) query.set("cursor", opts.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/project-chat/threads${suffix}`, {
      signal: opts?.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Failed to list Project Chat thread history: ${res.status}`);
    }
    const body = await res.json() as Partial<ProjectChatThreadPage>;
    return {
      threads: Array.isArray(body.threads) ? body.threads : [],
      nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
    };
  },

  async createProjectChatThread(
    projectId: string,
    message?: string,
    createRequestId?: string,
  ): Promise<ProjectChatThread> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/project-chat/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(message === undefined ? {} : { message }),
        ...(createRequestId === undefined ? {} : { createRequestId }),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(
        new Error(body.error ?? `Failed to create Project Chat thread: ${res.status}`),
        { status: res.status },
      );
    }
    return (await res.json()).thread;
  },

  async getProjectChatThread(
    threadId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ProjectChatThreadDetail> {
    const res = await authFetch(`${getApiBase()}/api/project-chat/threads/${threadId}`, {
      signal: opts?.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(
        new Error(body.error ?? `Failed to fetch Project Chat thread: ${res.status}`),
        { status: res.status },
      );
    }
    return res.json();
  },

  async listProjectChatMessages(
    threadId: string,
    opts: { beforeSequence: number },
  ): Promise<ProjectChatMessagePage> {
    const query = new URLSearchParams({ beforeSequence: String(opts.beforeSequence) });
    const res = await authFetch(`${getApiBase()}/api/project-chat/threads/${threadId}/messages?${query}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(
        new Error(body.error ?? `Failed to fetch Project Chat messages: ${res.status}`),
        { status: res.status },
      );
    }
    return res.json();
  },

  async updateProjectChatThread(
    threadId: string,
    patch: { title?: string | null; archived?: boolean },
  ): Promise<ProjectChatThread> {
    const res = await authFetch(`${getApiBase()}/api/project-chat/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Failed to update Project Chat thread: ${res.status}`);
    }
    return (await res.json()).thread;
  },

  async deleteProjectChatThread(threadId: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/project-chat/threads/${threadId}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Failed to delete Project Chat thread: ${res.status}`);
    }
  },

  async sendProjectChatMessage(threadId: string, content: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/project-chat/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Failed to send Project Chat message: ${res.status}`);
    }
  },

  async stopProjectChatTurn(threadId: string, expectedActiveTurnId: string): Promise<boolean> {
    const res = await authFetch(`${getApiBase()}/api/project-chat/threads/${threadId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedActiveTurnId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Failed to stop Project Chat turn: ${res.status}`);
    }
    return (await res.json()).stopped;
  },

  async approveProjectChatTool(threadId: string, approvalId: string, approved: boolean): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/project-chat/threads/${threadId}/tool-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId, approved }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Failed to resolve Project Chat tool approval: ${res.status}`);
    }
  },

  async selectProjectChatWorkspace(
    threadId: string,
    requestId: string,
    workspaceId: string,
  ): Promise<{ status: ProjectChatOperationStatus; sessionId?: string }> {
    const res = await authFetch(`${getApiBase()}/api/project-chat/threads/${threadId}/workspace-selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, workspaceId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(
        new Error(body.error ?? `Failed to select Project Chat workspace: ${res.status}`),
        { status: res.status },
      );
    }
    return res.json();
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

  async createRemoteServer(opts: { name: string }): Promise<RemoteServer> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    // The POST handler replies with the sanitized server object directly, not { server }.
    return (await res.json()) as RemoteServer;
  },

  async updateRemoteServer(id: string, opts: { name?: string; crossRemoteAccess?: CrossRemoteAccess }): Promise<RemoteServer> {
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

  /** Current connect token (minted on first call). Idempotent — safe to re-open the dialog. */
  async getRemoteServerConnectToken(id: string): Promise<{ token: string; connectCommand: string }> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}/connect-token`, {
      method: "POST",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  /** Replaces the connect token — the previous one stops working immediately. */
  async rotateRemoteServerConnectToken(id: string): Promise<{ token: string; connectCommand: string }> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}/connect-token/rotate`, {
      method: "POST",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  async revokeRemoteServerConnectToken(id: string): Promise<{ success: boolean }> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}/connect-token`, {
      method: "DELETE",
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

  async setProjectRemotePrimary(projectId: string, remoteId: string): Promise<void> {
    const res = await authFetch(
      `${getApiBase()}/api/projects/${projectId}/remotes/${remoteId}/primary`,
      { method: "POST" },
    );
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to set primary remote");
    }
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

  // ---- Workflow Runs ----

  async createWorkflowRun(opts: {
    projectId: string; branch: string | null; sourceSessionId: string;
    reviewFocus?: string; sourceTurnEndIndex?: number; reviewerAgentType?: AgentType;
    reviewerSessionId?: string;
    /** Review-scope span: `this_turn` (default) or `session_start`. */
    reviewSpan?: ReviewSpan;
    /** Pre-generated tier-1 brief (see generateReviewIntentBrief); when present the server skips its own distillation. */
    intentBrief?: string;
  }): Promise<WorkflowRun> {
    const res = await authFetch(`${getApiBase()}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Failed to start review: ${res.status}`);
    }
    return (await res.json()).run;
  },

  /**
   * Distill the source conversation into a tier-1 intent brief for the
   * reviewer. Called when the review dialog opens so the LLM latency hides
   * behind the user filling in the form; null means no brief (no chat model
   * configured, or distillation failed) — the review degrades to tier 2.
   */
  async generateReviewIntentBrief(
    projectId: string,
    sourceSessionId: string,
  ): Promise<string | null> {
    const res = await authFetch(`${getApiBase()}/api/workflow-runs/intent-brief`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, sourceSessionId }),
    });
    if (!res.ok) throw new Error(`Failed to generate intent brief: ${res.status}`);
    return (await res.json()).brief;
  },

  async getReviewerCandidate(
    projectId: string,
    sourceSessionId: string,
  ): Promise<ReviewerCandidate | null> {
    const params = new URLSearchParams({ projectId, sourceSessionId });
    const res = await authFetch(
      `${getApiBase()}/api/workflow-runs/reviewer-candidate?${params}`,
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch reviewer candidate: ${res.status}`);
    }
    return (await res.json()).candidate;
  },

  async getActiveWorkflowRuns(projectId: string, branch: string | null): Promise<WorkflowRun[]> {
    const params = new URLSearchParams({ projectId });
    if (branch) params.set("branch", branch);
    const res = await authFetch(`${getApiBase()}/api/workflow-runs?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch workflow runs: ${res.status}`);
    return (await res.json()).runs;
  },

  async workflowRunGate(runId: string, action: "approve" | "cancel" | "finalize", editedPayload?: string): Promise<WorkflowRun> {
    const res = await authFetch(`${getApiBase()}/api/workflow-runs/${runId}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, editedPayload }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Gate action failed: ${res.status}`);
    }
    return (await res.json()).run;
  },

  async cancelWorkflowRun(runId: string): Promise<WorkflowRun> {
    const res = await authFetch(`${getApiBase()}/api/workflow-runs/${runId}/cancel`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to cancel run: ${res.status}`);
    return (await res.json()).run;
  },
};
