export type ExecutionMode = 'local' | string;

export type SyncActionType = 'command' | 'prompt';

export interface SyncButtonConfig {
  actionType: SyncActionType;
  executionMode: ExecutionMode;
  content: string;
}

export type RemoteServerConnectionMode = 'outbound' | 'inbound';
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
  url: string | null;
  api_key?: string;
  connection_mode: RemoteServerConnectionMode;
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
export type ScheduledTaskRunStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'killed' | 'skipped';

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
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRun {
  id: string;
  schedule_id: string;
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
  /** Epoch ms when the user favorited this session, or null if not favorited. */
  favorited_at?: number | null;
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
    }, userId?: string) => Promise<Project>;
    getAll: (userId?: string) => Promise<Project[]>;
    getById: (id: string, userId?: string) => Promise<Project | undefined>;
    getByPath: (path: string) => Promise<Project | undefined>;
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
    }, userId?: string) => Promise<Project | undefined>;
    delete: (id: string, userId?: string) => Promise<void>;
  };
  remoteServers: {
    create(server: { name: string; url: string | null; api_key?: string; connection_mode?: RemoteServerConnectionMode }, userId?: string): Promise<RemoteServer>;
    getAll(userId?: string): Promise<RemoteServer[]>;
    getById(id: string, userId?: string): Promise<RemoteServer | undefined>;
    getByUrl(url: string): Promise<RemoteServer | undefined>;
    getByToken(token: string): Promise<RemoteServer | undefined>;
    /** Owner user_id of a server, unscoped — for ownership checks without a request context. */
    getOwnerId(id: string): Promise<string | undefined>;
    update(id: string, opts: { name?: string; url?: string; api_key?: string; connection_mode?: RemoteServerConnectionMode; cross_remote_access?: CrossRemoteAccess }, userId?: string): Promise<RemoteServer | undefined>;
    updateStatus(id: string, status: RemoteServerStatus): Promise<void>;
    generateToken(id: string, userId?: string): Promise<string | undefined>;
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
    }): Promise<ProjectRemote | undefined>;
    setPrimary(projectId: string, remoteId: string): Promise<boolean>;
    remove(id: string): Promise<boolean>;
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
    getById: (id: string) => Promise<ScheduledTask | undefined>;
    getAllEnabled: () => Promise<ScheduledTask[]>;
    update: (id: string, opts: { name?: string; cron_expr?: string; timezone?: string; enabled?: boolean; run_type?: ScheduledTaskRunType; prompt_provider?: PromptProvider | null; content?: string; cwd_mode?: ScheduledTaskCwdMode; branch?: string | null; directory?: string | null; timeout_seconds?: number; target?: string }) => Promise<ScheduledTask | undefined>;
    delete: (id: string) => Promise<void>;
  };
  scheduledTaskRuns: {
    create: (opts: { id: string; schedule_id: string; status?: ScheduledTaskRunStatus; process_id?: string | null }) => Promise<ScheduledTaskRun>;
    getById: (id: string) => Promise<ScheduledTaskRun | undefined>;
    /** Newest first. Never includes the output column (always null) — use getById for output. */
    getByScheduleId: (scheduleId: string, limit?: number) => Promise<ScheduledTaskRun[]>;
    /** Most recent run per schedule for the given IDs (output omitted). */
    getLastByScheduleIds: (scheduleIds: string[]) => Promise<Record<string, ScheduledTaskRun>>;
    finish: (id: string, opts: { status: ScheduledTaskRunStatus; exit_code?: number | null; output?: string | null; report?: string | null }) => Promise<void>;
    /** Delete all but the newest `keep` runs for a schedule. */
    prune: (scheduleId: string, keep: number) => Promise<void>;
  };
  remoteExecutorProcesses: {
    insert(localProcessId: string, info: { remoteServerId: string; remoteUrl: string; remoteApiKey: string; remoteProcessId: string; executorId: string; projectId?: string; branch?: string | null; machineId?: string | null }): Promise<void>;
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
    create: (opts: { id: string; project_id: string; branch: string; permission_mode?: string; agent_type?: string }) => Promise<AgentSession>;
    getAll: () => Promise<AgentSession[]>;
    getById: (id: string) => Promise<AgentSession | undefined>;
    getByProjectId: (projectId: string) => Promise<AgentSession[]>;
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
    getEntries: (sessionId: string) => Promise<Array<{ entry_index: number; data: string }>>;
    deleteEntries: (sessionId: string) => Promise<void>;
    countEntries: () => Promise<Array<{ session_id: string; cnt: number }>>;
  };
  remoteSessionMappings: {
    upsert: (localSessionId: string, projectId: string, remoteServerId: string, remoteSessionId: string, branch: string | null) => Promise<void>;
    getAll: () => Promise<Array<{ local_session_id: string; project_id: string; remote_server_id: string; remote_session_id: string; branch: string | null }>>;
    delete: (localSessionId: string) => Promise<void>;
    isTitleResolved: (localSessionId: string) => Promise<boolean>;
    markTitleResolved: (localSessionId: string) => Promise<void>;
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
  tasks: {
    create: (opts: { id: string; project_id: string; title: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => Promise<Task>;
    getByProjectId: (projectId: string, opts?: { includeArchived?: boolean }) => Promise<Task[]>;
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
  close: () => Promise<void>;
}
