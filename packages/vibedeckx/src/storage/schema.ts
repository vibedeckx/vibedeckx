import type { ColumnType, Generated } from "kysely";

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

export interface ExecutorGroupsTable {
  id: string;
  project_id: string;
  name: string;
  branch: Generated<string>;
  created_at: Generated<string>;
}

export interface ExecutorsTable {
  id: string;
  project_id: string;
  group_id: string | null;
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
  status: Generated<string>;
  permission_mode: string | null;
  agent_type: string | null;
  title: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  last_user_message_at: number | null;
  last_completed_at: number | null;
  favorited_at: number | null;
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
  url: string | null;
  api_key: string | null;
  connection_mode: Generated<string>;
  connect_token: string | null;
  connect_token_created_at: string | null;
  status: Generated<string>;
  last_connected_at: string | null;
  cross_remote_access: Generated<string>;
  user_id: Generated<string>;
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
  title_resolved: GeneratedDbBool;
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
  generation: number;
  deleted_at: number | null;
  written_at: number | null;  // last out-of-band write-through; null = snapshot-owned
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
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ScheduledTaskRunsTable {
  id: string;
  schedule_id: string;
  status: Generated<string>;
  exit_code: number | null;
  output: string | null;
  report: string | null;
  process_id: string | null;
  started_at: Generated<string>;
  finished_at: string | null;
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
  branch_merge_targets: BranchMergeTargetsTable;
  executor_groups: ExecutorGroupsTable;
  executors: ExecutorsTable;
  executor_processes: ExecutorProcessesTable;
  remote_executor_processes: RemoteExecutorProcessesTable;
  machine_identity: MachineIdentityTable;
  agent_sessions: AgentSessionsTable;
  agent_session_entries: AgentSessionEntriesTable;
  tasks: TasksTable;
  rules: RulesTable;
  commands: CommandsTable;
  global_settings: GlobalSettingsTable;
  user_settings: UserSettingsTable;
  remote_servers: RemoteServersTable;
  project_remotes: ProjectRemotesTable;
  remote_session_mappings: RemoteSessionMappingsTable;
  session_search_cache: SessionSearchCacheTable;
  workspace_search_cache: WorkspaceSearchCacheTable;
  search_catalog_sync_state: SearchCatalogSyncStateTable;
  scheduled_tasks: ScheduledTasksTable;
  scheduled_task_runs: ScheduledTaskRunsTable;
  cross_remote_audit: CrossRemoteAuditTable;
  workflow_runs: WorkflowRunsTable;
  turn_snapshots: TurnSnapshotsTable;
}
