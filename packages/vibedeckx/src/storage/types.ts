export type ExecutionMode = 'local' | string;

export type SyncActionType = 'command' | 'prompt';

export interface SyncButtonConfig {
  actionType: SyncActionType;
  executionMode: ExecutionMode;
  content: string;
}

export type RemoteServerStatus = 'unknown' | 'online' | 'offline';
export type CrossRemoteAccess = 'off' | 'read' | 'exec';

export type CrossRemoteAuditStatus = 'ok' | 'error' | 'timeout' | 'denied' | 'offline';

export interface CrossRemoteAuditEntry {
  user_id: string;
  session_id: string;
  source_remote_id: string | null;
  target_remote_id: string;
  tool_name: string;
  args_summary: string;
  exit_code: number | null;
  duration_ms: number;
  status: CrossRemoteAuditStatus;
}

export interface CrossRemoteAuditRow extends CrossRemoteAuditEntry {
  id: string;
  created_at: string;
}

export interface RemoteServer {
  id: string;
  name: string;
  connect_token?: string;
  connect_token_created_at?: string;
  status: RemoteServerStatus;
  last_connected_at?: string;
  cross_remote_access: CrossRemoteAccess;
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
  // Target ids ("local" or a remote_server_id) on which this executor is
  // disabled. Empty = runnable everywhere. Absence of a target = enabled there.
  disabled_targets: string[];
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

export type ScheduledTaskRunType = 'command' | 'prompt';
export type ScheduledTaskCwdMode = 'branch' | 'directory';
export type ScheduledTaskRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timeout' | 'killed' | 'skipped';

export interface ScheduledTask {
  id: string;
  project_id: string;
  name: string;
  cron_expr: string;
  /** IANA timezone name the cron expression is evaluated in, e.g. "Asia/Shanghai". */
  timezone: string;
  /** 'local' or a remote_server_id — where the run's process is spawned. */
  target: string;
  enabled: boolean;
  run_type: ScheduledTaskRunType;
  prompt_provider: PromptProvider | null;
  /** Shell command (run_type=command) or prompt text (run_type=prompt). */
  content: string;
  cwd_mode: ScheduledTaskCwdMode;
  /** cwd_mode=branch: worktree branch to run in; null = main worktree. */
  branch: string | null;
  /** cwd_mode=directory: absolute path to run in. */
  directory: string | null;
  timeout_seconds: number;
  /** Persisted scheduler projection used for an indexed project-wide minimum. */
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRun {
  id: string;
  schedule_id: string;
  /** Denormalized from the immutable parent schedule for bounded project lists. */
  project_id: string | null;
  status: ScheduledTaskRunStatus;
  exit_code: number | null;
  /** Captured output (ANSI included), capped. Omitted (null) by list queries. */
  output: string | null;
  /** Agent's final message for prompt runs (Markdown). Omitted (null) by list queries. */
  report: string | null;
  process_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ScheduledTaskRunRequest {
  requestId: string;
  runId: string;
  projectId: string;
  scheduleId: string;
  sourceRunId: string | null;
  createdAt: string;
  terminalStatus: ScheduledTaskRunStatus | null;
  terminalFinishedAt: string | null;
  terminalExitCode: number | null;
  /** Bounded replay error for durable non-2xx outcomes; never raw run output/report. */
  terminalError: string | null;
  terminalResponseStatus: number | null;
}

/** Bounded Project Overview projection. Full report/output stay on getById(). */
export interface ScheduledTaskRunActivity {
  id: string;
  schedule_id: string;
  status: ScheduledTaskRunStatus;
  exit_code: number | null;
  process_id: string | null;
  started_at: string;
  finished_at: string | null;
  scheduleName: string;
  branch: string | null;
  target: string;
  reportPreview: string | null;
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
  /**
   * Fingerprint of the remote's stable machine identity (sha256 of its public
   * key) that ran this process. Used to re-anchor the row after the machine
   * reconnects under a new remote_servers.id. Null for direct-URL servers and
   * for rows created before machine identity was introduced.
   */
  machine_id: string | null;
}

export interface MachineIdentityRow {
  /** sha256(publicKey) hex — stable across remote_servers.id recreation. */
  machine_id: string;
  /** SPKI PEM of the remote machine's public key. */
  public_key: string;
  /** Owner of the machine, pinned on first (token-authenticated) connect. */
  user_id: string;
  created_at: string;
  last_seen_at: string | null;
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
  archived_at: number | null;
  created_at: string;
  updated_at: string;
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

export type ProjectChatContextEntityType =
  | "task"
  | "workspace"
  | "agent_session"
  | "schedule"
  | "schedule_run";

export interface ProjectChatThread {
  id: string;
  project_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived_at: number | null;
}

export interface ProjectChatMessage {
  id: string;
  thread_id: string;
  sequence: number;
  type: ProjectChatMessageType;
  content: string;
  created_at: string;
}

export type ProjectChatWorkStatus = "accepted" | "running" | "completed" | "stopped" | "failed";

export interface ProjectChatWorkItem {
  id: string;
  thread_id: string;
  user_message_id: string;
  content: string;
  status: ProjectChatWorkStatus;
  attempt: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectChatRecoveryCursor {
  status: Extract<ProjectChatWorkStatus, "accepted" | "running">;
  createdAt: string;
  id: string;
}

export interface ProjectChatRecoveryCandidate {
  thread: ProjectChatThread;
  workItemId: string;
  cursor: ProjectChatRecoveryCursor;
  /** Equivalent to the normal thread/project authorization check. */
  authorized: boolean;
}

export interface ProjectChatContextRef {
  thread_id: string;
  entity_type: ProjectChatContextEntityType;
  entity_id: string;
  last_referenced_at: string;
}

export type ProjectChatContextNavigation =
  | { kind: "task"; taskId: string; label: string }
  | { kind: "workspace"; target: string; branch: string | null; label: string }
  | { kind: "agent_session"; sessionId: string; target: string; branch: string | null; label: string }
  | { kind: "schedule"; scheduleId: string; label: string }
  | { kind: "schedule_run"; scheduleId: string; runId: string; label: string };

export interface ResolvedProjectChatContextRef {
  entity_type: ProjectChatContextEntityType;
  entity_id: string;
  navigation: ProjectChatContextNavigation;
}

export type ProjectChatOperationKind =
  | "task_create"
  | "task_update"
  | "agent_session_create"
  | "agent_instruction"
  | "schedule_run"
  | "workspace_selection";

export type ProjectChatOperationStatus = "pending" | "resolving" | "running" | "completed" | "failed";

export type ProjectChatOperationPayload = {
  version: 1;
  operationId: string;
  status: ProjectChatOperationStatus;
} & (
  | { kind: "task_create"; taskId: string; title?: string; description?: string | null; taskStatus?: TaskStatus; priority?: TaskPriority; assignedBranch?: string | null }
  | { kind: "task_update"; taskId: string; title?: string; patch?: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assignedBranch?: string | null }; before?: { title: string; description: string | null; status: TaskStatus; priority: TaskPriority; assignedBranch: string | null } }
  | { kind: "agent_session_create"; sessionId: string; workerSessionId?: string; workspaceId?: string; target?: string; branch?: string | null; instruction?: string; permissionMode?: string; agentType?: string; model?: string | null; initialInstructionDelivery?: "pending" | "confirmed"; phase?: "workspace_selection"; requestId?: string; candidates?: Array<{ id: string; target: string; branch: string | null }>; selectedWorkspaceId?: string; claimToken?: string }
  | { kind: "agent_instruction"; sessionId: string; instruction?: string; target?: "local" | { remoteServerId: string; remoteSessionId: string }; delivery?: "pending" | "confirmed" }
  | { kind: "schedule_run"; scheduleId: string; runId: string; contextConfirmed?: boolean; skipped?: boolean }
  | { kind: "workspace_selection"; requestId: string; candidates: Array<{ id: string; target: string; branch: string | null }> }
);

export interface ProjectChatOperation {
  id: string;
  thread_id: string;
  project_id: string;
  user_id: string;
  kind: ProjectChatOperationKind;
  payload_version: 1;
  status: ProjectChatOperationStatus;
  entity_type: ProjectChatContextEntityType | null;
  entity_id: string | null;
  idempotency_key: string;
  payload: ProjectChatOperationPayload;
  error: string | null;
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

export type WorkflowRunStatus =
  | "waiting_reviewer"
  | "waiting_feedback"
  | "discussing"
  | "sending_feedback"
  | "completed"
  | "cancelled"
  | "failed";

export type ReviewSpan = "this_turn" | "session_start";

export interface WorkflowRun {
  id: string;
  project_id: string;
  branch: string | null;
  source_session_id: string;
  source_turn_end_index: number;
  reviewer_session_id: string | null;
  review_focus: string | null;
  review_target: string | null;
  review_span: string;
  feedback_snapshot: string | null;
  status: WorkflowRunStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Attention milestones the notification bell surfaces. Deliberately narrower
 * than "something changed": see
 * docs/plans/2026-07-25-persistent-notification-milestones-design.md
 * §Product Semantics for what does and does not earn a notification.
 */
export type NotificationKind =
  | "review_ready"
  | "session_result_ready"
  | "session_failed"
  | "workflow_failed";

/**
 * An immutable milestone row in an *execution* server's outbox. Stores semantic
 * identity and routing only — never presentation text: the user-facing server
 * owns `title`/`body`, so a stale worker-side title can never be baked into a
 * milestone. (The outbox *query response* may carry the session's current title,
 * resolved at query time, for fronts that have no local session row to label
 * a remote import with — see notification-outbox-routes.ts.)
 *
 * `seq` is a monotonically increasing cursor local to one execution server;
 * `id` is deterministic for the underlying milestone (UNIQUE), which is what
 * makes transaction retry and page replay safe.
 */
export interface NotificationOutboxEvent {
  seq: number;
  id: string;
  kind: NotificationKind;
  project_id: string;
  branch: string | null;
  /** Always set — the session the user should open, including for workflow failures. */
  session_id: string;
  workflow_run_id: string | null;
  created_at: number;
}

/** A user-scoped inbox row on the user-facing server. */
export interface Notification {
  id: string;
  user_id: string;
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

/**
 * Where a newly mapped remote session starts importing milestones.
 * `from_start` (sequence zero) is for sessions this front just created — they
 * have no unrelated history, and starting at zero closes the race where the
 * session completes before its mapping row lands. `from_now` is for sessions
 * *discovered* (search, listing, opening an existing worker session): their
 * first sync records the worker's current head without importing anything, so
 * a fresh front database attached to a long-lived worker can't turn months of
 * history into unread notifications and a sound storm.
 */
export type NotificationSyncStart = "from_start" | "from_now";

export interface RemoteSessionMapping {
  local_session_id: string;
  project_id: string;
  remote_server_id: string;
  remote_session_id: string;
  branch: string | null;
  notification_sync_start: NotificationSyncStart;
  /** Epoch ms through which periodic notification sync polls this mapping. */
  notification_watch_until: number | null;
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
  /** Per-session agent model, or null/undefined to use the CLI's default. */
  model?: string | null;
  created_at: string;
  updated_at?: string;
  /** Epoch ms of the most recent user-typed message, or null if none yet. */
  last_user_message_at?: number | null;
  /** Epoch ms of the most recent successful turn completion, or null if none yet. */
  last_completed_at?: number | null;
  /** Epoch ms when the user favorited this session, or null if not favorited. */
  favorited_at?: number | null;
}

export interface SearchCatalogSessionEntry {
  id: string;                 // server-side session id (already remote-prefixed for remote targets)
  branch: string | null;      // null = main workspace (API convention)
  title: string | null;
  lastActiveAt: number | null;
  favoritedAt: number | null;
  entryCount: number;
  status?: AgentSessionStatus;
  agentType?: string | null;
  model?: string | null;
  lastUserMessageAt?: number | null;
  lastCompletedAt?: number | null;
}

export type AgentSessionActivityStatus = AgentSessionStatus | "unknown";
export type RemoteSessionActivityUpdateResult = true | "stale" | false;

/** Project Overview projection shared by local rows and cached remote rows. */
export interface AgentSessionActivity {
  id: string;
  projectId: string;
  branch: string | null;
  status: AgentSessionActivityStatus;
  title: string | null;
  target: string;
  workspace: { target: string; branch: string | null };
  agentType: string | null;
  model: string | null;
  lastActiveAt: number | null;
  lastUserMessageAt: number | null;
  lastCompletedAt: number | null;
}

export interface SearchCatalogSnapshot {
  workspaces: Array<{ branch: string | null }>;
  sessions: SearchCatalogSessionEntry[];
}

export interface SearchSyncState {
  project_id: string;
  target_id: string;          // "local" or remote server id
  last_success_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
}

export interface SearchResultProjectRow {
  id: string;
  name: string;
  path: string | null;
}

export interface SearchResultWorkspaceRow {
  projectId: string;
  projectName: string;
  targetId: string;           // "local" or remote server id
  branch: string | null;      // null = main workspace (API convention)
}

export interface SearchResultSessionRow {
  sessionId: string;
  projectId: string;
  projectName: string;
  targetId: string;           // "local" or remote server id
  branch: string | null;      // null = main workspace (API convention)
  title: string | null;
  lastActiveAt: number | null;
  favoritedAt: number | null;
}

export interface SearchResults {
  projects: SearchResultProjectRow[];
  workspaces: SearchResultWorkspaceRow[];
  sessions: SearchResultSessionRow[];
  // Recents mode (empty query) only: favorited sessions that didn't make the
  // recency cut in `sessions`. Always [] when a query term is present.
  favorites: SearchResultSessionRow[];
}

export interface Storage {
  projects: {
    create: (opts: {
      id: string;
      name: string;
      path?: string | null;
      remote_path?: string;
      agent_mode?: ExecutionMode;
      executor_mode?: ExecutionMode;
      sync_up_config?: SyncButtonConfig;
      sync_down_config?: SyncButtonConfig;
    }, userId?: string) => Promise<Project>;
    getAll: (userId?: string) => Promise<Project[]>;
    getById: (id: string, userId?: string) => Promise<Project | undefined>;
    getByPath: (path: string) => Promise<Project | undefined>;
    update: (id: string, opts: {
      name?: string;
      path?: string | null;
      remote_path?: string | null;
      agent_mode?: ExecutionMode;
      executor_mode?: ExecutionMode;
      sync_up_config?: SyncButtonConfig | null;
      sync_down_config?: SyncButtonConfig | null;
    }, userId?: string) => Promise<Project | undefined>;
    delete: (id: string, userId?: string) => Promise<void>;
    /**
     * Owner user_id of a project, unscoped. Notification ownership is derived
     * from the *mapped local project* — never from a worker-supplied tenant id —
     * so the importer needs this lookup without a request context.
     * `remoteServers.getOwnerId` is not a substitute: a project can be owned by
     * a different user than the remote server it executes on.
     * Returns the `"local"` sentinel for solo-mode rows, undefined if absent.
     */
    getOwnerId: (projectId: string) => Promise<string | undefined>;
  };
  mergeTargets: {
    getForBranches: (projectId: string, branches: string[]) => Promise<Map<string, string>>;
    upsert: (projectId: string, branch: string, target: string) => Promise<boolean>;
    insertIfAbsent: (projectId: string, branch: string, target: string) => Promise<boolean>;
    delete: (projectId: string, branch: string) => Promise<boolean>;
  };
  remoteServers: {
    create(server: { name: string }, userId?: string): Promise<RemoteServer>;
    getAll(userId?: string): Promise<RemoteServer[]>;
    getById(id: string, userId?: string): Promise<RemoteServer | undefined>;
    /** Trusted connect/provider lookup. Deliberately unscoped: the token is the credential. */
    getByToken(token: string): Promise<RemoteServer | undefined>;
    /** Owner user_id of a server, unscoped — for ownership checks without a request context. */
    getOwnerId(id: string): Promise<string | undefined>;
    update(id: string, opts: { name?: string; cross_remote_access?: CrossRemoteAccess }, userId?: string): Promise<RemoteServer | undefined>;
    /** Trusted connection-manager update, not a user-facing mutation API. */
    updateStatus(id: string, status: RemoteServerStatus): Promise<void>;
    /** Current connect token, minting one on first use. Idempotent — never invalidates a token in use. */
    generateToken(id: string, userId?: string): Promise<string | undefined>;
    /** Replace the connect token with a fresh one, invalidating the previous token immediately. */
    rotateToken(id: string, userId?: string): Promise<string | undefined>;
    revokeToken(id: string, userId?: string): Promise<boolean>;
    delete(id: string, userId?: string): Promise<boolean>;
  };
  crossRemoteAudit: {
    insert(entry: CrossRemoteAuditEntry): Promise<void>;
    listByTarget(targetRemoteId: string, limit?: number): Promise<CrossRemoteAuditRow[]>;
  };
  projectRemotes: {
    getByProject(projectId: string): Promise<ProjectRemoteWithServer[]>;
    getByProjectAndServer(projectId: string, remoteServerId: string): Promise<ProjectRemoteWithServer | undefined>;
    add(opts: {
      project_id: string;
      remote_server_id: string;
      remote_path: string;
      sort_order?: number;
      sync_up_config?: SyncButtonConfig;
      sync_down_config?: SyncButtonConfig;
    }): Promise<ProjectRemote>;
    update(id: string, opts: {
      remote_path?: string;
      sort_order?: number;
      sync_up_config?: SyncButtonConfig | null;
      sync_down_config?: SyncButtonConfig | null;
    }, projectId?: string): Promise<ProjectRemote | undefined>;
    setPrimary(projectId: string, remoteId: string): Promise<boolean>;
    remove(id: string, projectId?: string): Promise<boolean>;
  };
  executorGroups: {
    create: (opts: { id: string; project_id: string; name: string; branch: string }) => Promise<ExecutorGroup>;
    getByProjectId: (projectId: string) => Promise<ExecutorGroup[]>;
    getById: (id: string) => Promise<ExecutorGroup | undefined>;
    getByBranch: (projectId: string, branch: string) => Promise<ExecutorGroup | undefined>;
    /**
     * Atomically create a group for (project_id, branch) unless one already
     * exists there. The existence check and insert happen inside one storage
     * call (backed by the table's UNIQUE(project_id, branch) constraint), so
     * two concurrent creates for the same branch can no longer both observe
     * "none exists" before either insert lands — the loser gets back the
     * winner's row with `created: false` instead of an unhandled constraint-
     * violation error. Callers that want the previous "409 Conflict" behavior
     * should branch on `created`.
     */
    createIfBranchFree: (opts: { id: string; project_id: string; name: string; branch: string }) => Promise<{ created: boolean; group: ExecutorGroup }>;
    update: (id: string, opts: { name?: string }) => Promise<ExecutorGroup | undefined>;
    delete: (id: string) => Promise<void>;
  };
  executors: {
    create: (opts: { id: string; project_id: string; group_id: string; name: string; command: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string; pty?: boolean }) => Promise<Executor>;
    getByProjectId: (projectId: string) => Promise<Executor[]>;
    getByGroupId: (groupId: string) => Promise<Executor[]>;
    getById: (id: string) => Promise<Executor | undefined>;
    update: (id: string, opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean; disabled_targets?: string[] }) => Promise<Executor | undefined>;
    /**
     * Atomically add/remove a single target from `disabled_targets` — the
     * read-modify-write of the JSON array happens inside one storage call, so
     * two concurrent toggles of *different* targets on the same executor no
     * longer risk one clobbering the other (previously a caller-side
     * read-then-write with an intervening await). Returns undefined if the
     * executor doesn't exist.
     */
    setTargetDisabled: (id: string, target: string, disabled: boolean) => Promise<Executor | undefined>;
    delete: (id: string) => Promise<void>;
    reorder: (groupId: string, orderedIds: string[]) => Promise<void>;
  };
  executorProcesses: {
    create: (opts: { id: string; executor_id: string; pid?: number }) => Promise<ExecutorProcess>;
    getById: (id: string) => Promise<ExecutorProcess | undefined>;
    getRunning: () => Promise<ExecutorProcess[]>;
    getLastByExecutorId: (executorId: string) => Promise<ExecutorProcess | undefined>;
    /** Most recent row per executor for the given IDs. At most one row per executorId in the result. */
    getLastByExecutorIds: (executorIds: string[]) => Promise<ExecutorProcess[]>;
    updateStatus: (id: string, status: ExecutorProcessStatus, exitCode?: number) => Promise<void>;
    updatePid: (id: string, pid: number) => Promise<void>;
    /**
     * Mark a process "killed" only if it is still recorded as "running".
     * Used by the PID-based fallback stop path (no in-memory confirmation
     * the process is still alive), so a genuine concurrent completion/failure
     * status written by the process's own exit handler around the same time
     * can't be clobbered by a stale "killed" write.
     */
    markKilledIfRunning: (id: string) => Promise<void>;
  };
  scheduledTasks: {
    create: (opts: { id: string; project_id: string; name: string; cron_expr: string; timezone: string; run_type: ScheduledTaskRunType; prompt_provider?: PromptProvider | null; content: string; cwd_mode: ScheduledTaskCwdMode; branch?: string | null; directory?: string | null; timeout_seconds?: number; enabled?: boolean; target?: string }) => Promise<ScheduledTask>;
    getByProjectId: (projectId: string) => Promise<ScheduledTask[]>;
    /** Stable project-scoped list capped in SQL. */
    listByProject: (projectId: string, limit: number) => Promise<ScheduledTask[]>;
    getById: (id: string) => Promise<ScheduledTask | undefined>;
    getAllEnabled: () => Promise<ScheduledTask[]>;
    /** Indexed minimum across every enabled schedule in the project. */
    getEarliestNextRunAt: (projectId: string) => Promise<string | null>;
    /** Recompute after startup or a cron firing advances the next occurrence. */
    refreshNextRunAt: (id: string) => Promise<string | null>;
    update: (id: string, opts: { name?: string; cron_expr?: string; timezone?: string; enabled?: boolean; run_type?: ScheduledTaskRunType; prompt_provider?: PromptProvider | null; content?: string; cwd_mode?: ScheduledTaskCwdMode; branch?: string | null; directory?: string | null; timeout_seconds?: number; target?: string }) => Promise<ScheduledTask | undefined>;
    delete: (id: string) => Promise<void>;
  };
  scheduledTaskRuns: {
    create: (opts: { id: string; schedule_id: string; status?: ScheduledTaskRunStatus; process_id?: string | null }) => Promise<ScheduledTaskRun>;
    claimStart: (opts: { id: string; scheduleId: string; processId: string; ownerToken: string; effectFingerprint: string; leaseMs?: number }) => Promise<
      "claimed" | "retry" | "existing" | "occupied" | "conflict"
    >;
    claimManualRequest: (opts: { requestId: string; runId: string; projectId: string; scheduleId: string; sourceRunId?: string | null }) => Promise<"claimed" | "existing" | "conflict">;
    getManualRequest: (requestId: string) => Promise<ScheduledTaskRunRequest | undefined>;
    /** Fill a legacy request's immutable outcome from its terminal run, if one still exists. */
    backfillManualRequestOutcome: (requestId: string) => Promise<ScheduledTaskRunRequest | undefined>;
    heartbeat: (id: string, ownerToken: string, leaseMs?: number) => Promise<boolean>;
    markRunning: (id: string, claimedProcessId: string, processId?: string, ownerToken?: string) => Promise<boolean>;
    /** Insert a terminal pre-start failure only if the run identity is still unused. */
    failBeforeStart: (opts: { id: string; scheduleId: string; output: string }) => Promise<boolean>;
    getById: (id: string) => Promise<ScheduledTaskRun | undefined>;
    /** Newest runs across schedules belonging to exactly one project; output/report omitted. */
    listRecentByProject: (projectId: string, limit: number) => Promise<ScheduledTaskRun[]>;
    /** Newest Project Overview rows, joined to schedule context with only a bounded report preview. */
    getRecentByProject: (projectId: string, limit: number) => Promise<ScheduledTaskRunActivity[]>;
    /** Newest failed/timeout Project Overview rows, independent of the recent-runs card window. */
    getAttentionByProject: (projectId: string, limit: number) => Promise<ScheduledTaskRunActivity[]>;
    countByProjectStatuses: (projectId: string, statuses: ScheduledTaskRunStatus[]) => Promise<number>;
    /** Newest first. Never includes the output column (always null) — use getById for output. */
    getByScheduleId: (scheduleId: string, limit?: number) => Promise<ScheduledTaskRun[]>;
    /** Most recent run per schedule for the given IDs (output omitted). */
    getLastByScheduleIds: (scheduleIds: string[]) => Promise<Record<string, ScheduledTaskRun>>;
    finish: (id: string, opts: { status: ScheduledTaskRunStatus; exit_code?: number | null; output?: string | null; report?: string | null; responseStatus?: number; responseError?: string | null }) => Promise<void>;
    /** Atomically terminalize and release a claim only for its current owner. */
    finishOwned: (id: string, ownerToken: string, opts: { status: ScheduledTaskRunStatus; exit_code?: number | null; output?: string | null; report?: string | null; responseStatus?: number; responseError?: string | null }) => Promise<boolean>;
    /** Delete all but the newest `keep` terminal runs for a schedule. */
    prune: (scheduleId: string, keep: number) => Promise<void>;
  };
  remoteExecutorProcesses: {
    insert(localProcessId: string, info: { remoteServerId: string; remoteProcessId: string; executorId: string; projectId?: string; branch?: string | null; machineId?: string | null }): Promise<void>;
    /**
     * Hard-delete a row. Use only for stale-row cleanup or transient sessions
     * (e.g. terminals). Use markFinished() when an executor process exits so
     * the row survives for "Last run" lookup and post-finish log replay.
     */
    delete(localProcessId: string): Promise<void>;
    /** Mark a row as no longer running while preserving it for history. */
    markFinished(localProcessId: string, exitCode?: number, status?: ExecutorProcessStatus): Promise<void>;
    getById(localProcessId: string): Promise<RemoteExecutorProcessRow | undefined>;
    /** Most recent row for an executor, regardless of status — used for "Last run" lookup. */
    getLastByExecutorId(executorId: string): Promise<RemoteExecutorProcessRow | undefined>;
    /**
     * Most recent row per (executor_id, remote_server_id) pair across the given
     * executor IDs. Used by the executor list endpoint to assemble per-target
     * "Last run" data in a single query.
     */
    getLastByExecutorIdsGroupedByServer(executorIds: string[]): Promise<RemoteExecutorProcessRow[]>;
    /** Only rows currently marked 'running' — used for restoration on startup/reconnect. */
    getRunning(): Promise<RemoteExecutorProcessRow[]>;
    /**
     * Running rows anchored to a specific verified machine identity. Used by
     * reverse-connect recovery to safely re-claim a machine's processes after
     * it reconnects under a new remote_servers.id.
     */
    getRunningByMachine(machineId: string): Promise<RemoteExecutorProcessRow[]>;
    /** All rows including finished — primarily for legacy callers. */
    getAll(): Promise<RemoteExecutorProcessRow[]>;
  };
  /**
   * Stable cryptographic identities for reverse-connect remote machines. Keyed
   * by public-key fingerprint so a machine remains recognizable across
   * remote_servers record recreation (new id + new token).
   */
  machineIdentity: {
    get(machineId: string): Promise<MachineIdentityRow | undefined>;
    /** Pin a fingerprint→(publicKey, owner) on first connect. No-op if present. */
    pin(machineId: string, publicKey: string, userId: string): Promise<void>;
    touch(machineId: string): Promise<void>;
    /**
     * Atomically pin-if-absent (TOFU) and verify ownership of a machine
     * fingerprint in one storage call, then touch `last_seen_at`. Closes the
     * race where two concurrent first-connects for the same fingerprint under
     * two different owners could both observe "unpinned" (via separate get()
     * calls) before either pin() landed — with this method the insert and the
     * ownership readback are one atomic step, so only one caller's userId can
     * ever win the first claim. Returns whether `userId` is the (possibly
     * just-claimed) owner, the definitive owner id either way, and whether
     * this call was the one that performed the first-time pin.
     */
    claimOrVerify(machineId: string, publicKey: string, userId: string): Promise<{ owned: boolean; ownerId: string; created: boolean }>;
  };
  agentSessions: {
    create: (opts: { id: string; project_id: string; branch: string; permission_mode?: string; agent_type?: string; model?: string | null }) => Promise<AgentSession>;
    getAll: () => Promise<AgentSession[]>;
    getById: (id: string) => Promise<AgentSession | undefined>;
    getByProjectId: (projectId: string) => Promise<AgentSession[]>;
    /** Newest sessions for exactly one project, capped in SQL. */
    listByProject: (projectId: string, limit: number) => Promise<AgentSession[]>;
    /** Project Overview recency list; insertion order breaks sub-millisecond timestamp ties. */
    listRecentByProject: (projectId: string, limit: number) => Promise<AgentSession[]>;
    /** Newest stopped/error sessions, independent of the recent-sessions card window. */
    listAttentionByProject: (projectId: string, limit: number) => Promise<AgentSession[]>;
    countRunningByProject: (projectId: string) => Promise<number>;
    /** Errors plus stopped sessions whose latest user turn never completed. */
    countAttentionByProject: (projectId: string) => Promise<number>;
    /** @deprecated — use listByBranch + getLatestByBranch */
    getByBranch: (projectId: string, branch: string) => Promise<AgentSession | undefined>;
    listByBranch: (projectId: string, branch: string) => Promise<AgentSession[]>;
    getLatestByBranch: (projectId: string, branch: string) => Promise<AgentSession | undefined>;
    updateStatus: (id: string, status: AgentSessionStatus) => Promise<void>;
    /**
     * Update status without touching `updated_at`. Used by startup restore, where
     * bulk-resetting "running" rows to "stopped" is not a real user-facing event
     * and must not disturb the ordering used by `getLatestByBranch`.
     */
    updateStatusPreservingTimestamp: (id: string, status: AgentSessionStatus) => Promise<void>;
    updatePermissionMode: (id: string, mode: string) => Promise<void>;
    updateAgentType: (id: string, agent_type: string) => Promise<void>;
    /**
     * Set (or clear, with null) the per-session model.
     *
     * The model is otherwise fixed at creation; this exists for the one path
     * that must change it after the fact — switching a session's agent type,
     * where the inherited name is definitionally wrong (`opus` means nothing
     * to Codex) and must be cleared back to the new CLI's default. Never
     * validated, like every other model write.
     */
    updateModel: (id: string, model: string | null) => Promise<void>;
    updateTitle: (id: string, title: string | null) => Promise<void>;
    /** Mark or unmark the session as favorited. Does not touch updated_at. */
    setFavorited: (id: string, favorited: boolean) => Promise<void>;
    touchUpdatedAt: (id: string) => Promise<void>;
    /** Set last_user_message_at to the given epoch-ms timestamp. */
    markUserMessage: (id: string, timestampMs: number) => Promise<void>;
    /** Set last_completed_at to the given epoch-ms timestamp. */
    markCompleted: (id: string, timestampMs: number) => Promise<void>;
    delete: (id: string) => Promise<void>;
    upsertEntry: (sessionId: string, entryIndex: number, data: string) => Promise<void>;
    /**
     * Persist a `turn_end` entry and its optional attention milestone in ONE
     * transaction. Used only for turn_end — ordinary entry persistence stays on
     * `upsertEntry`.
     *
     * The milestone must be tied to the durable state that PROVES it: a
     * committed turn_end with no outbox row would lose the notification
     * forever, and an outbox row with no turn_end would notify about a turn
     * that never closed. Both writes are idempotent (entry upsert on
     * (session_id, entry_index), outbox on its deterministic id), so retrying
     * the whole operation is safe.
     */
    upsertTurnEndWithOutbox: (opts: {
      sessionId: string;
      entryIndex: number;
      entryData: string;
      outbox?: Omit<NotificationOutboxEvent, "seq">;
    }) => Promise<void>;
    getEntries: (sessionId: string) => Promise<Array<{ entry_index: number; data: string }>>;
    deleteEntries: (sessionId: string) => Promise<void>;
    countEntries: () => Promise<Array<{ session_id: string; cnt: number }>>;
  };
  agentInstructionDeliveries: {
    claim: (opts: {
      sessionId: string; idempotencyKey: string; contentHash: string; claimToken: string; leaseMs?: number;
    }) => Promise<"claimed" | "sent" | "busy" | "conflict">;
    markSent: (opts: {
      sessionId: string; idempotencyKey: string; claimToken: string;
    }) => Promise<boolean>;
    renewClaim: (opts: {
      sessionId: string; idempotencyKey: string; claimToken: string; leaseMs?: number;
    }) => Promise<boolean>;
    release: (opts: {
      sessionId: string; idempotencyKey: string; claimToken: string;
    }) => Promise<void>;
  };
  remoteSessionMappings: {
    /**
     * `notificationSyncStart` is applied ON INSERT ONLY (default `from_now`).
     * A re-upsert — reconnect re-mapping, or reusing a reviewer session for a
     * second review — must never reset the policy, the watch boundary, or the
     * import cursor, or the reused session would replay its whole history.
     */
    upsert: (
      localSessionId: string,
      projectId: string,
      remoteServerId: string,
      remoteSessionId: string,
      branch: string | null,
      notificationSyncStart?: NotificationSyncStart,
    ) => Promise<void>;
    getAll: () => Promise<RemoteSessionMapping[]>;
    /** Persisted remote mappings for exactly one project, capped in SQL. */
    listByProject: (projectId: string, limit: number) => Promise<RemoteSessionMapping[]>;
    getByLocal: (localSessionId: string) => Promise<RemoteSessionMapping | undefined>;
    /** Mapping only while its exact project-to-remote association still exists. */
    getAuthorizedByLocal: (localSessionId: string, projectId: string) => Promise<RemoteSessionMapping | undefined>;
    /** Resolve the local target of a milestone the worker reported. */
    getByRemote: (remoteServerId: string, remoteSessionId: string) => Promise<RemoteSessionMapping | undefined>;
    /** Move `notification_watch_until` forward (never backward). */
    extendNotificationWatch: (localSessionId: string, until: number) => Promise<void>;
    /**
     * Mappings periodic notification sync should poll. `includeExpired: false`
     * (ordinary polling) returns only mappings whose watch window is still
     * open, so a server with years of historical mappings doesn't poll them
     * forever. `includeExpired: true` is the bounded startup / remote-online
     * sweep, which must still recover durable events produced during downtime.
     */
    getNotificationSyncCandidates: (opts: { now: number; includeExpired: boolean }) => Promise<RemoteSessionMapping[]>;
    /** Also deletes the mapping's notification sync cursor. */
    delete: (localSessionId: string) => Promise<void>;
    isTitleResolved: (localSessionId: string) => Promise<boolean>;
    markTitleResolved: (localSessionId: string) => Promise<void>;
  };
  /**
   * Durable milestone outbox of *this* server, written in the same transaction
   * as the state that proves the milestone (turn_end / workflow transition).
   * Present on every server that executes work — a worker's outbox is pulled by
   * the front through /api/notification-outbox/query; a front's own outbox is
   * drained locally by NotificationService.
   */
  notificationOutbox: {
    /**
     * Insert with ON CONFLICT(id) DO NOTHING. Returns the assigned `seq` and
     * whether this call was the one that inserted (false = deterministic retry
     * or replay of an already-recorded milestone).
     */
    insert: (event: Omit<NotificationOutboxEvent, "seq">) => Promise<{ inserted: boolean; seq: number | null }>;
    /** Ordered page across all sessions — the local drain path. */
    listAfter: (afterSeq: number, limit: number) => Promise<NotificationOutboxEvent[]>;
    /** Ordered page for exactly one session — the remote query path. */
    listBySessionAfter: (sessionId: string, afterSeq: number, limit: number) => Promise<NotificationOutboxEvent[]>;
    /** Highest seq for a session, or 0 when it has no events. */
    headBySession: (sessionId: string) => Promise<number>;
    /** Highest seq in the whole outbox, or 0 when empty. */
    head: () => Promise<number>;
    /** Retention: drop rows created before `cutoffMs`. */
    pruneOlderThan: (cutoffMs: number) => Promise<void>;
  };
  /** User-scoped notification inbox of the user-facing server. */
  notifications: {
    /** Idempotent on `id`. Returns true only when this call inserted the row. */
    insert: (notification: Notification) => Promise<boolean>;
    /**
     * Insert an imported remote milestone and advance its per-session cursor in
     * ONE transaction. A crash between the two would otherwise either lose the
     * notification (cursor first) or need a separate reconciliation pass.
     */
    importRemote: (opts: {
      notification: Notification;
      remoteServerId: string;
      remoteSessionId: string;
      seq: number;
    }) => Promise<{ inserted: boolean }>;
    listForUser: (userId: string, opts: { limit: number; unreadOnly?: boolean }) => Promise<Notification[]>;
    /** False when the id doesn't exist OR isn't owned by `userId` — callers must not distinguish the two. */
    markRead: (id: string, userId: string) => Promise<boolean>;
    markAllRead: (userId: string) => Promise<void>;
    /** Keep every unread row and the newest `keepRead` read rows per user; delete the rest. */
    cleanup: (keepRead: number) => Promise<void>;
  };
  /** Last fully imported worker sequence per mapped remote session. */
  notificationSyncCursors: {
    get: (remoteServerId: string, remoteSessionId: string) => Promise<number | undefined>;
    getMany: (remoteServerId: string, remoteSessionIds: string[]) => Promise<Map<string, number>>;
    /** Monotonic: never moves a cursor backward. Use for IMPORT advancement. */
    set: (remoteServerId: string, remoteSessionId: string, lastSeq: number) => Promise<void>;
    /**
     * Record a `from_now` baseline exactly once. Returns true only when this
     * call created the cursor; an existing cursor is left completely untouched.
     *
     * NOT `set`: a baseline is a one-time initialization, and its value is a
     * head read at some earlier instant. Two callers can legitimately race to
     * establish it (a background sweep and `prepareForNewTurn`), and the slower
     * one's head may have been computed AFTER a new turn's milestone landed.
     * Applying that stale head would push the cursor past the milestone — and
     * because import advancement is MAX-guarded, it could never be walked back,
     * silently losing the notification forever. First writer wins; the DB
     * arbitrates, so this holds across processes too.
     */
    initializeIfAbsent: (remoteServerId: string, remoteSessionId: string, lastSeq: number) => Promise<boolean>;
  };
  searchCache: {
    /** Active workspace catalog rows for exactly one project, in stable target/branch order. */
    listWorkspacesByProject(projectId: string, limit: number): Promise<Array<{ targetId: string; branch: string | null }>>;
    listRemoteSessionActivityByProject(projectId: string, limit: number): Promise<AgentSessionActivity[]>;
    listRemoteSessionAttentionByProject(projectId: string, limit: number): Promise<AgentSessionActivity[]>;
    countRemoteSessionActivityByProject(projectId: string): Promise<{ running: number; failed: number }>;
    /**
     * Persist one live remote-stream transition only when the exact durable
     * mapping and project↔remote association still agree. Creates the cache
     * projection when a mapped live session was not catalogued yet.
     */
    updateRemoteSessionActivity(entry: {
      localSessionId: string; projectId: string; targetId: string; remoteSessionId: string;
      status: AgentSessionStatus; activityAt: number;
      lastUserMessageAt?: number; lastCompletedAt?: number;
    }): Promise<RemoteSessionActivityUpdateResult>;
    /** Bounded target list used to backfill pre-activity-schema cache rows. */
    listUnknownRemoteActivityTargets(userId?: string, limit?: number): Promise<Array<{
      projectId: string; targetId: string; remotePath: string;
    }>>;
    /** Fair, bounded authorized remote targets for automatic activity repair. */
    listRemoteActivityRefreshTargets(userId?: string, limit?: number): Promise<Array<{
      projectId: string; targetId: string; remotePath: string;
    }>>;
    /**
     * Reconcile one (project, target) snapshot into the cache. `collectedAt`
     * (default: now) is when the snapshot's data was collected — write-through
     * rows written at or after it are exempt from both the deletion sweep and
     * the upsert override, so an in-flight snapshot can never clobber a
     * create/delete/rename that happened while it was being fetched.
     */
    applyCatalogSnapshot(projectId: string, targetId: string, snapshot: SearchCatalogSnapshot, collectedAt?: number): Promise<void>;
    recordSyncFailure(projectId: string, targetId: string, error: string): Promise<void>;
    getSyncStates(projectIds: string[]): Promise<SearchSyncState[]>;
    updateCachedSessionTitle(localSessionId: string, title: string | null): Promise<void>;
    /**
     * Write-through for a remote session created via this server: surfaces it
     * in search immediately instead of after the next on-open refresh. The
     * row stays exempt from snapshot reconciliation until a snapshot collected
     * after this call confirms (or deletes) it.
     */
    noteSessionCreated(entry: {
      localSessionId: string; projectId: string; targetId: string; branch: string | null;
      title?: string | null; status?: AgentSessionStatus; agentType?: string | null;
      model?: string | null; lastUserMessageAt?: number | null; lastCompletedAt?: number | null;
    }): Promise<void>;
    /** Write-through for a remote session deleted via this server (soft-delete). */
    noteSessionDeleted(localSessionId: string): Promise<void>;
    /**
     * Cache-only tiered search across projects/workspaces/sessions, scoped to
     * `userId` (skipped in solo mode). Empty/whitespace `query` switches to
     * "recents" mode: sessions only (most-recently-active + all favorited),
     * recency-desc. Non-empty query ranks each group by match tier
     * (exact > prefix > substring), then favorited, then recency — each group
     * capped at `limitPerGroup`.
     */
    search(opts: { userId?: string; query: string; limitPerGroup: number }): Promise<SearchResults>;
  };
  settings: {
    get: (key: string) => Promise<string | undefined>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    /**
     * Atomically fetch the value for `key`, generating and persisting it via
     * `factory()` on first use (INSERT OR IGNORE + re-read, all inside one
     * storage call). Closes the race where two concurrent first-users of a
     * lazily-initialized settings value (e.g. a generated key pair) could
     * each see it missing and each generate + persist their own value, with
     * the loser's generated value silently discarded — worse, a caller that
     * cached its own locally-generated value instead of the persisted one
     * would disagree with what's on disk.
     */
    getOrCreate: (key: string, factory: () => string) => Promise<string>;
    /**
     * Atomically read-modify-write a settings JSON blob: `mergeFn` receives
     * the current raw value (or undefined if unset) and returns the new raw
     * value to persist. The read and write happen inside one storage call
     * with no intervening await, closing the lost-update race a caller's own
     * `get()` + merge-in-JS + `set()` sequence has under concurrent writers.
     * `mergeFn` may throw (e.g. on validation failure) to abort without
     * writing — the rejection propagates to the caller unchanged.
     */
    update: (key: string, mergeFn: (current: string | undefined) => string) => Promise<string>;
  };
  /**
   * Per-user settings, keyed by (userId, key). Use for user-level preferences
   * (terminal/conversation UI prefs, chat provider config incl. API keys) —
   * `settings` above stays reserved for server-level values (proxy, machine
   * identity keys, resource caps). `userId` is the Clerk user id, or the
   * "local" sentinel in no-auth solo mode — always a non-empty exact match,
   * never an optional filter (a falsy short-circuit here would silently
   * collapse tenants back onto one shared row).
   */
  userSettings: {
    get: (userId: string, key: string) => Promise<string | undefined>;
    set: (userId: string, key: string, value: string) => Promise<void>;
    /**
     * Atomic read-modify-write scoped to one user's row — same contract and
     * lost-update rationale as `settings.update` above; `mergeFn` may throw
     * to abort without writing.
     */
    update: (userId: string, key: string, mergeFn: (current: string | undefined) => string) => Promise<string>;
  };
  projectChatThreads: {
    create: (opts: { id: string; project_id: string; user_id: string; title: string | null }) => Promise<ProjectChatThread>;
    createWithInitialTurn: (opts: {
      id: string;
      project_id: string;
      user_id: string;
      title: string | null;
      initialTurn?: { messageId: string; workItemId: string; content: string };
    }) => Promise<ProjectChatThread>;
    createIdempotent: (opts: {
      id: string;
      project_id: string;
      user_id: string;
      title: string | null;
      create_request_id: string;
      create_payload_hash: string;
      initialTurn?: { messageId: string; workItemId: string; content: string };
    }) => Promise<{ thread: ProjectChatThread; created: boolean }>;
    listByProject: (projectId: string, userId: string, limit: number, opts?: { includeArchived?: boolean }) => Promise<ProjectChatThread[]>;
    /**
     * Discovery-only lookup for routes that receive no project id. Callers
     * must immediately authorize the returned project before reading or
     * mutating the thread, and mutations must use the full project/user scope.
     */
    getOwnedById: (id: string, userId: string) => Promise<ProjectChatThread | undefined>;
    getById: (id: string, projectId: string, userId: string) => Promise<ProjectChatThread | undefined>;
    update: (id: string, projectId: string, userId: string, patch: {
      title?: string | null;
      archived?: boolean;
    }) => Promise<ProjectChatThread | undefined>;
    updateTitle: (id: string, projectId: string, userId: string, title: string | null) => Promise<ProjectChatThread | undefined>;
    archive: (id: string, projectId: string, userId: string) => Promise<ProjectChatThread | undefined>;
    unarchive: (id: string, projectId: string, userId: string) => Promise<ProjectChatThread | undefined>;
    touchUpdatedAt: (id: string, projectId: string, userId: string) => Promise<ProjectChatThread | undefined>;
    delete: (id: string, projectId: string, userId: string) => Promise<void>;
  };
  projectChatMessages: {
    append: (opts: { id: string; thread_id: string; project_id: string; user_id: string; sequence: number; type: ProjectChatMessageType; content: string }) => Promise<ProjectChatMessage | undefined>;
    listByThread: (threadId: string, projectId: string, userId: string) => Promise<ProjectChatMessage[]>;
    listPageBefore: (
      threadId: string,
      projectId: string,
      userId: string,
      opts: { beforeSequence: number | null; limit: number; maxUtf8Bytes: number },
    ) => Promise<{
      messages: ProjectChatMessage[];
      hasMore: boolean;
      nextCursor: number | null;
      newestSequence: number;
    } | undefined>;
  };
  projectChatWorkItems: {
    listRecoveryPage: (
      cursor: ProjectChatRecoveryCursor | null,
      limit: number,
    ) => Promise<{
      candidates: ProjectChatRecoveryCandidate[];
      nextCursor: ProjectChatRecoveryCursor | null;
      hasMore: boolean;
    }>;
    quarantineRecovery: (id: string, reason: string) => Promise<boolean>;
    accept: (opts: {
      id: string;
      user_message_id: string;
      thread_id: string;
      project_id: string;
      user_id: string;
      content: string;
    }) => Promise<{ workItem: ProjectChatWorkItem; userMessage: ProjectChatMessage }>;
    listNonterminal: (
      threadId: string,
      projectId: string,
      userId: string,
    ) => Promise<ProjectChatWorkItem[]>;
    markRunning: (
      id: string,
      threadId: string,
      projectId: string,
      userId: string,
    ) => Promise<ProjectChatWorkItem | undefined>;
    markAccepted: (
      id: string,
      threadId: string,
      projectId: string,
      userId: string,
      attempt: number,
    ) => Promise<ProjectChatWorkItem | undefined>;
    appendEvent: (opts: {
      id: string;
      thread_id: string;
      project_id: string;
      user_id: string;
      attempt: number;
      is_current?: () => boolean;
      message_id: string;
      type: Exclude<ProjectChatMessageType, "user" | "turn_end">;
      content: string;
    }) => Promise<ProjectChatMessage | undefined>;
    finish: (opts: {
      id: string;
      thread_id: string;
      project_id: string;
      user_id: string;
      attempt: number;
      is_current?: () => boolean;
      status: Extract<ProjectChatWorkStatus, "completed" | "stopped" | "failed">;
      error: string | null;
      turn_end_id: string;
      turn_end_content: string;
    }) => Promise<{ workItem: ProjectChatWorkItem; turnEnd: ProjectChatMessage }>;
  };
  projectChatContextRefs: {
    touch: (threadId: string, projectId: string, userId: string, entityType: ProjectChatContextEntityType, entityId: string) => Promise<ProjectChatContextRef | undefined>;
    touchMany: (
      threadId: string,
      projectId: string,
      userId: string,
      refs: Array<{ entityType: ProjectChatContextEntityType; entityId: string }>,
    ) => Promise<ProjectChatContextRef[] | undefined>;
    listByThread: (threadId: string, projectId: string, userId: string, limit?: number) => Promise<ProjectChatContextRef[]>;
    resolveExisting: (
      projectId: string,
      refs: Array<{ entity_type: ProjectChatContextEntityType; entity_id: string }>,
    ) => Promise<ResolvedProjectChatContextRef[]>;
  };
  projectChatOperations: {
    create: (opts: {
      id: string;
      thread_id: string;
      project_id: string;
      user_id: string;
      kind: ProjectChatOperationKind;
      payload_version?: 1;
      status: ProjectChatOperationStatus;
      entity_type: ProjectChatContextEntityType | null;
      entity_id: string | null;
      idempotency_key: string;
      payload: ProjectChatOperationPayload;
      error: string | null;
    }) => Promise<ProjectChatOperation | undefined>;
    getById: (
      id: string, threadId: string, projectId: string, userId: string,
    ) => Promise<ProjectChatOperation | undefined>;
    listByCorrelation: (
      projectId: string,
      entityType: ProjectChatContextEntityType,
      entityId: string,
      limit: number,
    ) => Promise<ProjectChatOperation[]>;
    listNonterminal: (afterId: string | null, limit: number) => Promise<{
      operations: ProjectChatOperation[];
      nextCursor: string | null;
      hasMore: boolean;
      malformed: number;
    }>;
    recordRetry: (id: string, threadId: string, projectId: string, userId: string, delayMs: number) => Promise<number>;
    clearRetry: (id: string, threadId: string, projectId: string, userId: string) => Promise<void>;
    announce: (opts: {
      id: string;
      thread_id: string;
      project_id: string;
      user_id: string;
      message: { id: string; content: string };
    }) => Promise<ProjectChatMessage | undefined>;
    bindCorrelation: (opts: {
      id: string;
      thread_id: string;
      project_id: string;
      user_id: string;
      entity_type: ProjectChatContextEntityType;
      entity_id: string;
    }) => Promise<ProjectChatOperation | undefined>;
    claimWorkspaceSelection: (opts: {
      id: string;
      thread_id: string;
      project_id: string;
      user_id: string;
      workspace_id: string;
      session_id: string;
      claim_token: string;
      payload: Extract<ProjectChatOperationPayload, { kind: "agent_session_create" }>;
      message: { id: string; content: string };
    }) => Promise<{
      operation: ProjectChatOperation;
      claimed: boolean;
      message?: ProjectChatMessage;
    } | undefined>;
    transition: (opts: {
      id: string;
      thread_id: string;
      project_id: string;
      user_id: string;
      status: ProjectChatOperationStatus;
      payload: ProjectChatOperationPayload;
      error: string | null;
      message: { id: string; content: string };
    }) => Promise<{ operation: ProjectChatOperation; message: ProjectChatMessage; changed: boolean } | undefined>;
  };
  tasks: {
    create: (opts: { id: string; project_id: string; title: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => Promise<Task>;
    getByProjectId: (projectId: string, opts?: { includeArchived?: boolean }) => Promise<Task[]>;
    /** Project-scoped, SQL-bounded task lookup for read-only assistant tools. */
    queryByProject: (projectId: string, opts: { query?: string; status?: TaskStatus; limit: number }) => Promise<Task[]>;
    /** Active overview tasks ordered by in-progress, urgent, then high priority. */
    listPriorityByProject: (projectId: string, limit: number) => Promise<Task[]>;
    getById: (id: string) => Promise<Task | undefined>;
    update: (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null; position?: number }) => Promise<Task | undefined>;
    archive: (id: string) => Promise<Task | undefined>;
    unarchive: (id: string) => Promise<Task | undefined>;
    delete: (id: string) => Promise<void>;
    reorder: (projectId: string, orderedIds: string[]) => Promise<void>;
    /**
     * Atomically complete the FIRST non-archived task assigned to `branch`
     * (same selection order as `getByProjectId` — position ASC), but only if
     * that first match isn't already "done". If the first-by-position match
     * is done, this is a no-op even when a later-positioned assigned task
     * exists that isn't — exactly matching the original `getByProjectId` +
     * `.find()` + status-guard call site. Used by session-completion
     * auto-close, which previously did that sequence across two awaits — a
     * concurrent edit to the found task (reassignment, cancellation) in that
     * window would have been silently overwritten back to "done". Returns
     * the updated task, or undefined if nothing was completed.
     */
    completeIfAssigned: (projectId: string, branch: string) => Promise<Task | undefined>;
  };
  rules: {
    create: (opts: { id: string; project_id: string; branch: string | null; name: string; content: string; enabled?: boolean }) => Promise<Rule>;
    getByWorkspace: (projectId: string, branch: string | null) => Promise<Rule[]>;
    getById: (id: string) => Promise<Rule | undefined>;
    update: (id: string, opts: { name?: string; content?: string; enabled?: boolean; position?: number }) => Promise<Rule | undefined>;
    delete: (id: string) => Promise<void>;
    reorder: (projectId: string, branch: string | null, orderedIds: string[]) => Promise<void>;
  };
  commands: {
    create: (opts: { id: string; project_id: string; branch: string | null; name: string; content: string }) => Promise<Command>;
    getByWorkspace: (projectId: string, branch: string | null) => Promise<Command[]>;
    getById: (id: string) => Promise<Command | undefined>;
    update: (id: string, opts: { name?: string; content?: string; position?: number }) => Promise<Command | undefined>;
    delete: (id: string) => Promise<void>;
  };
  workflowRuns: {
    create(opts: {
      id: string;
      project_id: string;
      branch: string | null;
      source_session_id: string;
      source_turn_end_index: number;
      review_focus: string | null;
      review_target: string | null;
      reviewer_session_id?: string | null;
      review_span?: ReviewSpan;
    }): Promise<WorkflowRun>;
    getById(id: string): Promise<WorkflowRun | undefined>;
    getActive(projectId: string, branch: string | null): Promise<WorkflowRun[]>;
    getAllActive(): Promise<WorkflowRun[]>;
    getActiveBySession(sessionId: string): Promise<WorkflowRun | undefined>;
    getLatestCompletedBySource(sourceSessionId: string): Promise<WorkflowRun | undefined>;
    update(
      id: string,
      patch: Partial<Pick<WorkflowRun, "reviewer_session_id" | "review_target" | "feedback_snapshot" | "status" | "error">>,
    ): Promise<WorkflowRun | undefined>;
    transition(
      id: string,
      from: WorkflowRunStatus,
      to: WorkflowRunStatus,
      patch?: Partial<Pick<WorkflowRun, "feedback_snapshot" | "error">>,
    ): Promise<boolean>;
    /**
     * `transition` plus an attention milestone, in one transaction. The outbox
     * row is inserted ONLY when the guarded update actually changed a row, so a
     * lost CAS (someone else already advanced the run) can never notify about a
     * transition it didn't perform. Idempotent via the outbox's deterministic id.
     */
    transitionWithOutbox(
      id: string,
      from: WorkflowRunStatus,
      to: WorkflowRunStatus,
      patch: Partial<Pick<WorkflowRun, "feedback_snapshot" | "error">> | undefined,
      outbox: Omit<NotificationOutboxEvent, "seq">,
    ): Promise<boolean>;
  };
  turnSnapshots: {
    create(opts: {
      session_id: string;
      turn_end_index: number;
      head: string;
      dirty: Record<string, string>;
    }): Promise<void>;
    getStartBoundary(
      session_id: string,
      turnEndIndex: number,
    ): Promise<{ head: string; dirty: Record<string, string> } | undefined>;
    getSessionStart(
      session_id: string,
    ): Promise<{ head: string; dirty: Record<string, string> } | undefined>;
  };
  close: () => Promise<void>;
}
