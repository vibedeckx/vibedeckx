import type { ColumnType, Generated } from "kysely";
import type {
  ProjectChatContextEntityType,
  ProjectChatMessageType,
  ProjectChatOperationKind,
  ProjectChatOperationStatus,
  ProjectChatWorkStatus,
} from "./types.js";

/** Boolean column: 0/1 under sqlite, native boolean under pg. Always read via fromDbBool(), write via DialectHelpers.toDbBool(). */
export type DbBool = ColumnType<number | boolean, number | boolean, number | boolean>;

/**
 * Boolean column that also has a SQL DEFAULT (optional on insert/update).
 * NOT `Generated<DbBool>` — Kysely's Selectable/Insertable/Updateable helpers
 * only unwrap one level of `ColumnType` (see kysely's util/column-type.d.ts:
 * `SelectType`/`InsertType`/`UpdateType`), so nesting `Generated<>` around the
 * `DbBool` `ColumnType` leaves the projected field typed as the raw `DbBool`
 * marker object instead of `number | boolean`. Flattened by hand instead.
 */
export type GeneratedDbBool = ColumnType<number | boolean, number | boolean | undefined, number | boolean>;

export interface ProjectsTable {
  id: string;
  name: string;
  path: string | null;
  remote_path: string | null;
  is_remote: DbBool;
  // Inert columns kept to describe the on-disk shape of existing DBs. No code
  // reads or writes them: remote_url/remote_api_key are leftovers from the
  // removed direct-URL (outbound) transport, remote_project_id was never used.
  remote_url: string | null;
  remote_api_key: string | null;
  remote_project_id: string | null;
  user_id: Generated<string>;
  agent_mode: string | null;
  executor_mode: string | null;
  sync_up_config: string | null;   // JSON: SyncButtonConfig
  sync_down_config: string | null; // JSON: SyncButtonConfig
  created_at: Generated<string>;
}

export interface BranchMergeTargetsTable {
  project_id: string;
  branch: string;
  target: string;
  updated_at: Generated<string>;
}

export interface WorkspacesTable {
  id: string;
  project_id: string;
  /** Empty string is the main-workspace sentinel. */
  branch: string;
  status: string;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WorkspaceCheckoutsTable {
  id: string;
  workspace_id: string;
  /** "local" on the machine owning the checkout, or a remote server id on the hub. */
  target_id: string;
  worktree_path: string;
  /** Origin of the persisted path; controls whether a later worker report may replace it. */
  path_source: Generated<string>;
  expected_branch: string;
  status: string;
  error: string | null;
  /** Tombstone timestamp. NULL identifies the one active incarnation. */
  deleted_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ExecutorsTable {
  id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  command: string;
  executor_type: Generated<string>;
  prompt_provider: string | null;
  cwd: string | null;
  pty: GeneratedDbBool;
  position: Generated<number>;
  disabled_targets: Generated<string>; // JSON: string[]
  created_at: Generated<string>;
}

export interface ExecutorProcessesTable {
  id: string;
  executor_id: string;
  pid: number | null;
  status: Generated<string>;
  exit_code: number | null;
  started_at: Generated<string>;
  finished_at: string | null;
}

export interface RemoteExecutorProcessesTable {
  local_process_id: string;
  remote_server_id: string;
  remote_url: string;
  remote_api_key: string;
  remote_process_id: string;
  executor_id: string;
  project_id: string | null;
  branch: string | null;
  started_at: Generated<string>;
  status: Generated<string>;
  exit_code: number | null;
  finished_at: string | null;
  machine_id: string | null;
}

export interface MachineIdentityTable {
  machine_id: string;
  public_key: string;
  user_id: Generated<string>;
  created_at: Generated<string>;
  last_seen_at: string | null;
}

export interface AgentSessionsTable {
  id: string;
  project_id: string;
  branch: Generated<string>;
  /** Durable identity of the exact checkout incarnation used by this session. */
  workspace_checkout_id: Generated<string | null>;
  status: Generated<string>;
  permission_mode: string | null;
  agent_type: string | null;
  title: string | null;
  model: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  activity_at: Generated<number>;
  last_user_message_at: number | null;
  last_completed_at: number | null;
  favorited_at: number | null;
  /**
   * The agent CLI's own session identity (Claude Code `system/init`
   * session_id; Codex `thread/start` thread.id — also the uuid in its rollout
   * filename). Joins a session to the CLI's on-disk transcript, the only copy
   * of the conversation that survives a vibedeckx DB loss.
   */
  native_session_id: string | null;
}

/**
 * DEVIATION from the plan doc: the real CREATE TABLE (sqlite.ts:436-446) also
 * has an autoincrement `id` primary key and a `created_at` column that the
 * plan's schema omitted. Added here so the Kysely type matches the actual
 * table shape.
 */
export interface AgentSessionEntriesTable {
  id: Generated<number>;
  session_id: string;
  entry_index: number;
  data: string;
  created_at: Generated<string>;
}

export interface AgentInstructionDeliveriesTable {
  session_id: string;
  idempotency_key: string;
  content_hash: string;
  status: "pending" | "sent";
  claim_token: string | null;
  owner_token: string | null;
  lease_expires_at: number | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface TasksTable {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: Generated<string>;
  priority: Generated<string>;
  assigned_branch: string | null;
  position: Generated<number>;
  archived_at: number | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ProjectChatThreadsTable {
  id: string;
  project_id: string;
  user_id: string;
  title: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  archived_at: number | null;
  create_request_id: Generated<string | null>;
  create_payload_hash: Generated<string | null>;
}

export interface ProjectChatMessagesTable {
  id: string;
  thread_id: string;
  sequence: number;
  type: ProjectChatMessageType;
  content: string;
  created_at: Generated<string>;
}

export interface ProjectChatWorkItemsTable {
  id: string;
  thread_id: string;
  user_message_id: string;
  content: string;
  status: ProjectChatWorkStatus;
  attempt: Generated<number>;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ProjectChatContextRefsTable {
  thread_id: string;
  entity_type: ProjectChatContextEntityType;
  entity_id: string;
  last_referenced_at: Generated<string>;
}

export interface ProjectChatOperationsTable {
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
  payload: string;
  error: string | null;
  retry_count: Generated<number>;
  next_retry_at: number | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface RulesTable {
  id: string;
  project_id: string;
  branch: string | null;
  name: string;
  content: string;
  enabled: GeneratedDbBool;
  position: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface CommandsTable {
  id: string;
  project_id: string;
  branch: string | null;
  name: string;
  content: string;
  position: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface GlobalSettingsTable {
  key: string;
  value: string;
}

export interface UserSettingsTable {
  user_id: string;
  key: string;
  value: string;
}

export interface RemoteServersTable {
  id: string;
  name: string;
  // Inert columns from the removed direct-URL (outbound) transport, kept to
  // describe the on-disk shape of existing DBs. Every server is reverse-connect
  // now; nothing reads these and inserts leave them at their column defaults.
  url: string | null;
  api_key: string | null;
  connection_mode: Generated<string>;
  connect_token: string | null;
  connect_token_created_at: string | null;
  status: Generated<string>;
  last_connected_at: string | null;
  cross_remote_access: Generated<string>;
  user_id: Generated<string>;
  worker_version: string | null;
  worker_capabilities: string | null; // JSON: string[]
  worker_version_reported_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ProjectRemotesTable {
  id: string;
  project_id: string;
  remote_server_id: string;
  remote_path: string;
  sort_order: Generated<number>;
  sync_up_config: string | null;   // JSON: SyncButtonConfig
  sync_down_config: string | null; // JSON: SyncButtonConfig
}

export interface RemoteSessionMappingsTable {
  local_session_id: string;
  project_id: string;
  remote_server_id: string;
  remote_session_id: string;
  branch: string | null;
  workspace_checkout_id: Generated<string | null>;
  title_resolved: GeneratedDbBool;
  notification_sync_start: Generated<string>;
  notification_watch_until: number | null;
}

export interface RemoteSessionCreationIntentsTable {
  local_session_id: string;
  remote_session_id: string;
  project_id: string;
  remote_server_id: string;
  branch: string | null;
  remote_path: string;
  permission_mode: string;
  agent_type: string | null;
  model: string | null;
  force: GeneratedDbBool;
  user_id: string | null;
  operation_kind: Generated<string>;
  source_remote_session_id: string | null;
  up_to_entry_index: number | null;
  status: Generated<string>;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface RemoteReviewerCreationIntentsTable {
  local_reviewer_session_id: string;
  remote_reviewer_session_id: string;
  remote_run_id: string;
  project_id: string;
  remote_server_id: string;
  branch: string | null;
  remote_path: string;
  source_remote_session_id: string;
  review_focus: string | null;
  source_turn_end_index: number | null;
  review_span: string;
  agent_type: string;
  intent_brief: string | null;
  user_id: string | null;
  status: Generated<string>;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface NotificationOutboxTable {
  seq: Generated<number>;
  id: string;
  kind: string;
  project_id: string;
  branch: string | null;
  session_id: string;
  workflow_run_id: string | null;
  created_at: number;
}

export interface NotificationsTable {
  id: string;
  user_id: string;
  kind: string;
  project_id: string;
  branch: string | null;
  session_id: string | null;
  workflow_run_id: string | null;
  title: string;
  body: string | null;
  created_at: number;
  read_at: number | null;
}

export interface NotificationSyncCursorsTable {
  remote_server_id: string;
  remote_session_id: string;
  last_seq: number;
  updated_at: number;
}

export interface SessionSearchCacheTable {
  local_session_id: string;
  project_id: string;
  target_id: string;
  branch: string;             // "" sentinel for main
  title: string | null;
  last_active_at: number | null;
  favorited_at: number | null;
  entry_count: number;
  status: Generated<string>;
  agent_type: string | null;
  model: string | null;
  last_user_message_at: number | null;
  last_completed_at: number | null;
  generation: number;
  deleted_at: number | null;
  written_at: number | null;  // monotonic live-write/snapshot watermark; null = legacy unwatermarked row
}

export interface WorkspaceSearchCacheTable {
  project_id: string;
  target_id: string;
  branch: string;             // "" sentinel for main
  generation: number;
  deleted_at: number | null;
}

export interface SearchCatalogSyncStateTable {
  project_id: string;
  target_id: string;
  last_success_at: number | null;
  last_attempt_at: number | null;
  snapshot_generation: number;
  last_error: string | null;
}

export interface ScheduledTasksTable {
  id: string;
  project_id: string;
  name: string;
  cron_expr: string;
  timezone: string;
  target: Generated<string>;
  enabled: GeneratedDbBool;
  run_type: Generated<string>;
  prompt_provider: string | null;
  content: string;
  cwd_mode: Generated<string>;
  branch: string | null;
  directory: string | null;
  timeout_seconds: Generated<number>;
  next_run_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ScheduledTaskRunsTable {
  id: string;
  schedule_id: string;
  project_id: string | null;
  status: Generated<string>;
  exit_code: number | null;
  output: string | null;
  report: string | null;
  process_id: string | null;
  started_at: Generated<string>;
  finished_at: string | null;
}

export interface ScheduledTaskExecutionClaimsTable {
  schedule_id: string;
  run_id: string;
  process_id: string;
  owner_token: string;
  lease_expires_at: number;
  effect_fingerprint: string;
  created_at: Generated<string>;
}

export interface ScheduledTaskRunRequestsTable {
  request_id: string;
  run_id: string;
  project_id: string;
  schedule_id: string;
  source_run_id: string | null;
  created_at: Generated<string>;
  terminal_status: string | null;
  terminal_finished_at: string | null;
  terminal_exit_code: number | null;
  terminal_error: string | null;
  terminal_response_status: number | null;
}

export interface WorkflowRunsTable {
  id: string;
  project_id: string;
  branch: string | null;
  source_session_id: string;
  source_turn_end_index: number;
  reviewer_session_id: string | null;
  review_focus: string | null;
  review_target: string | null;
  review_span: Generated<string>;
  feedback_snapshot: string | null;
  status: string;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface TurnSnapshotsTable {
  session_id: string;
  turn_end_index: number;
  head: string;
  dirty: string; // JSON: Record<string, string> (path -> blobSha | "absent")
  captured_at: number;
}

export interface CrossRemoteAuditTable {
  seq: Generated<number>;
  id: string;
  user_id: string;
  session_id: string;
  source_remote_id: string | null;
  target_remote_id: string;
  tool_name: string;
  args_summary: string;
  exit_code: number | null;
  duration_ms: number;
  status: string;
  created_at: string;
}

export interface DB {
  projects: ProjectsTable;
  workspaces: WorkspacesTable;
  workspace_checkouts: WorkspaceCheckoutsTable;
  branch_merge_targets: BranchMergeTargetsTable;
  executors: ExecutorsTable;
  executor_processes: ExecutorProcessesTable;
  remote_executor_processes: RemoteExecutorProcessesTable;
  machine_identity: MachineIdentityTable;
  agent_sessions: AgentSessionsTable;
  agent_session_entries: AgentSessionEntriesTable;
  agent_instruction_deliveries: AgentInstructionDeliveriesTable;
  tasks: TasksTable;
  project_chat_threads: ProjectChatThreadsTable;
  project_chat_messages: ProjectChatMessagesTable;
  project_chat_work_items: ProjectChatWorkItemsTable;
  project_chat_context_refs: ProjectChatContextRefsTable;
  project_chat_operations: ProjectChatOperationsTable;
  rules: RulesTable;
  commands: CommandsTable;
  global_settings: GlobalSettingsTable;
  user_settings: UserSettingsTable;
  remote_servers: RemoteServersTable;
  project_remotes: ProjectRemotesTable;
  remote_session_mappings: RemoteSessionMappingsTable;
  remote_session_creation_intents: RemoteSessionCreationIntentsTable;
  remote_reviewer_creation_intents: RemoteReviewerCreationIntentsTable;
  notification_outbox: NotificationOutboxTable;
  notifications: NotificationsTable;
  notification_sync_cursors: NotificationSyncCursorsTable;
  session_search_cache: SessionSearchCacheTable;
  workspace_search_cache: WorkspaceSearchCacheTable;
  search_catalog_sync_state: SearchCatalogSyncStateTable;
  scheduled_tasks: ScheduledTasksTable;
  scheduled_task_runs: ScheduledTaskRunsTable;
  scheduled_task_execution_claims: ScheduledTaskExecutionClaimsTable;
  scheduled_task_run_requests: ScheduledTaskRunRequestsTable;
  cross_remote_audit: CrossRemoteAuditTable;
  workflow_runs: WorkflowRunsTable;
  turn_snapshots: TurnSnapshotsTable;
}
