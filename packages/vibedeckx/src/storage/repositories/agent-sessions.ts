import { sql, type Kysely, type Selectable, type SqlBool } from "kysely";
import type { DB, AgentSessionsTable, RemoteSessionMappingsTable, RemoteSessionCreationIntentsTable, RemoteReviewerCreationIntentsTable } from "../schema.js";
import { fromDbBool, type DialectHelpers } from "../dialect.js";
import type {
  Storage,
  AgentSession,
  AgentSessionActivity,
  AgentSessionStatus,
  NotificationSyncStart,
  RemoteSessionMapping,
  WorkspaceCheckoutRecord,
  RemoteSessionCreationIntent,
  RemoteReviewerCreationIntent,
  WorkspaceBindingIssue,
  WorkspaceBindingIssueReason,
} from "../types.js";
import {
  recordWorkspaceBindingRead,
  type WorkspaceBindingReadConsumer,
} from "../../workspace-binding-metrics.js";
import { WORKFLOW_ACTIVE_STATUSES } from "../workflow-run-status.js";
// NotificationOutboxEvent is referenced only through Storage's method
// signatures, which this factory's return type already pins.

const mapRemoteSessionMapping = (
  row: Pick<Selectable<RemoteSessionMappingsTable>,
    "local_session_id" | "project_id" | "remote_server_id" | "remote_session_id"
    | "branch" | "workspace_checkout_id" | "notification_sync_start" | "notification_watch_until">,
): RemoteSessionMapping => ({
  local_session_id: row.local_session_id,
  project_id: row.project_id,
  remote_server_id: row.remote_server_id,
  remote_session_id: row.remote_session_id,
  branch: row.branch,
  workspace_checkout_id: row.workspace_checkout_id,
  notification_sync_start: row.notification_sync_start as NotificationSyncStart,
  notification_watch_until: row.notification_watch_until,
});

const projectedRemoteMappingBase = (kdb: Kysely<DB>) => kdb
  .selectFrom("remote_session_mappings as mapping")
  .leftJoin("workspace_checkouts as checkout", "checkout.id", "mapping.workspace_checkout_id")
  .leftJoin("workspaces as workspace", "workspace.id", "checkout.workspace_id")
  .innerJoin("project_remotes as association", (join) => join.on((eb) => eb.or([
    eb.and([
      eb("mapping.workspace_checkout_id", "is", null),
      eb("association.project_id", "=", eb.ref("mapping.project_id")),
      eb("association.remote_server_id", "=", eb.ref("mapping.remote_server_id")),
    ]),
    eb.and([
      eb("mapping.workspace_checkout_id", "is not", null),
      eb("association.project_id", "=", eb.ref("workspace.project_id")),
      eb("association.remote_server_id", "=", eb.ref("checkout.target_id")),
    ]),
  ])))
  .select([
    "mapping.local_session_id", "mapping.remote_session_id", "mapping.workspace_checkout_id",
    "mapping.notification_sync_start", "mapping.notification_watch_until",
    "mapping.project_id as snapshot_project_id", "mapping.remote_server_id as snapshot_remote_server_id",
    "mapping.branch as snapshot_branch",
    sql<string>`case when mapping.workspace_checkout_id is null then mapping.project_id else workspace.project_id end`.as("project_id"),
    sql<string>`case when mapping.workspace_checkout_id is null then mapping.remote_server_id else checkout.target_id end`.as("remote_server_id"),
    sql<string | null>`case when mapping.workspace_checkout_id is null then mapping.branch else nullif(workspace.branch, '') end`.as("branch"),
  ])
  .where((eb) => eb.or([
    eb("mapping.workspace_checkout_id", "is", null),
    eb.and([
      eb("checkout.id", "is not", null),
      eb("workspace.id", "is not", null),
    ]),
  ]));

const observeProjectedRemoteMapping = (
  consumer: WorkspaceBindingReadConsumer | undefined,
  row: {
    workspace_checkout_id: string | null;
    snapshot_project_id: string;
    snapshot_remote_server_id: string;
    snapshot_branch: string | null;
    project_id: string;
    remote_server_id: string;
    branch: string | null;
  },
) => {
  if (!consumer) return;
  if (row.workspace_checkout_id === null) {
    recordWorkspaceBindingRead(consumer, "legacy-fallback");
  } else if (row.snapshot_project_id !== row.project_id
    || row.snapshot_remote_server_id !== row.remote_server_id
    || (row.snapshot_branch ?? "") !== (row.branch ?? "")) {
    recordWorkspaceBindingRead(consumer, "mismatch");
  } else {
    recordWorkspaceBindingRead(consumer, "checkout-hit");
  }
};

const mapAgentSession = (row: Selectable<AgentSessionsTable>): AgentSession => ({
  id: row.id,
  project_id: row.project_id,
  branch: row.branch,
  workspace_checkout_id: row.workspace_checkout_id,
  status: row.status as AgentSessionStatus,
  // permission_mode/agent_type are nullable columns but always populated
  // with a default by create() below; ?? undefined only matters for a
  // hand-edited/legacy NULL row and mirrors mapProject's optional-string
  // handling (core.ts).
  permission_mode: row.permission_mode ?? undefined,
  agent_type: row.agent_type ?? undefined,
  title: row.title,
  model: row.model ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at,
  last_user_message_at: row.last_user_message_at,
  last_completed_at: row.last_completed_at,
  favorited_at: row.favorited_at,
  native_session_id: row.native_session_id,
});

const parseActivityTimestamp = (value: string): number | null => {
  const explicitZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(value);
  const parsed = Date.parse(explicitZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? null : parsed;
};

const mapLocalActivity = (row: {
  id: string;
  snapshot_project_id: string;
  snapshot_branch: string;
  projected_project_id: string;
  projected_branch: string;
  projected_target_id: string;
  worktree_path: string | null;
  checkout_deleted_at: string | null;
  checkout_status: string | null;
  workspace_checkout_id: string | null;
  status: string;
  title: string | null;
  agent_type: string | null;
  model: string | null;
  activity_at: number;
  created_at: string;
  updated_at: string;
  last_user_message_at: number | null;
  last_completed_at: number | null;
}): AgentSessionActivity => {
  const branch = row.projected_branch === "" ? null : row.projected_branch;
  return {
    id: row.id,
    projectId: row.projected_project_id,
    branch,
    status: row.status as AgentSessionActivity["status"],
    title: row.title,
    target: row.projected_target_id,
    workspace: { target: row.projected_target_id, branch },
    worktreePath: row.worktree_path,
    checkoutDeletedAt: row.checkout_deleted_at,
    checkoutStatus: row.checkout_status as AgentSessionActivity["checkoutStatus"],
    binding: row.workspace_checkout_id === null ? "legacy" : "checkout",
    agentType: row.agent_type,
    model: row.model,
    lastActiveAt: Math.max(
      row.last_user_message_at ?? 0,
      row.last_completed_at ?? 0,
      parseActivityTimestamp(row.updated_at) ?? 0,
      parseActivityTimestamp(row.created_at) ?? 0,
    ),
    lastUserMessageAt: row.last_user_message_at,
    lastCompletedAt: row.last_completed_at,
  };
};

const observeLocalActivity = (
  consumer: WorkspaceBindingReadConsumer | undefined,
  row: {
    workspace_checkout_id: string | null;
    snapshot_project_id: string;
    snapshot_branch: string;
    projected_project_id: string;
    projected_branch: string;
    projected_target_id: string;
  },
) => {
  if (!consumer) return;
  if (row.workspace_checkout_id === null) {
    recordWorkspaceBindingRead(consumer, "legacy-fallback");
  } else if (row.snapshot_project_id !== row.projected_project_id
    || row.snapshot_branch !== row.projected_branch
    || row.projected_target_id !== "local") {
    recordWorkspaceBindingRead(consumer, "mismatch");
  } else {
    recordWorkspaceBindingRead(consumer, "checkout-hit");
  }
};

const localActivityBase = (kdb: Kysely<DB>, projectId?: string) => {
  let query = kdb
  .selectFrom("agent_sessions as s")
  .leftJoin("workspace_checkouts as checkout", "checkout.id", "s.workspace_checkout_id")
  .leftJoin("workspaces as workspace", "workspace.id", "checkout.workspace_id")
  .select([
    "s.id", "s.workspace_checkout_id", "s.status", "s.title", "s.agent_type", "s.model",
    "s.project_id as snapshot_project_id", "s.branch as snapshot_branch",
    "s.activity_at", "s.created_at", "s.updated_at", "s.last_user_message_at", "s.last_completed_at",
    "checkout.worktree_path", "checkout.deleted_at as checkout_deleted_at", "checkout.status as checkout_status",
    sql<string>`case when s.workspace_checkout_id is null then s.project_id else workspace.project_id end`.as("projected_project_id"),
    sql<string>`case when s.workspace_checkout_id is null then s.branch else workspace.branch end`.as("projected_branch"),
    sql<string>`case when s.workspace_checkout_id is null then 'local' else checkout.target_id end`.as("projected_target_id"),
  ])
  // A non-NULL missing checkout is a broken binding, not a legacy row. The
  // explicit validity arm prevents CASE/LEFT JOIN NULLs from becoming a
  // snapshot fallback.
  .where((eb) => eb.or([
    eb.and([
      eb("s.workspace_checkout_id", "is", null),
      ...(projectId === undefined ? [] : [eb("s.project_id", "=", projectId)]),
    ]),
    eb.and([
      eb("s.workspace_checkout_id", "is not", null),
      eb("checkout.id", "is not", null),
      eb("workspace.id", "is not", null),
      ...(projectId === undefined ? [] : [eb("workspace.project_id", "=", projectId)]),
    ]),
  ]));
  return query;
};

const projectedSessionByBranchBase = (
  kdb: Kysely<DB>,
  projectId: string,
  branch: string,
) => kdb
  .selectFrom("agent_sessions as s")
  .leftJoin("workspace_checkouts as checkout", "checkout.id", "s.workspace_checkout_id")
  .leftJoin("workspaces as workspace", "workspace.id", "checkout.workspace_id")
  .selectAll("s")
  .select([
    sql<string>`case when s.workspace_checkout_id is null then s.project_id else workspace.project_id end`.as("projected_project_id"),
    sql<string>`case when s.workspace_checkout_id is null then s.branch else workspace.branch end`.as("projected_branch"),
  ])
  .where((eb) => eb.or([
    eb.and([
      eb("s.workspace_checkout_id", "is", null),
      eb("s.project_id", "=", projectId),
      eb("s.branch", "=", branch),
    ]),
    eb.and([
      eb("s.workspace_checkout_id", "is not", null),
      eb("checkout.id", "is not", null),
      eb("workspace.id", "is not", null),
      eb("workspace.project_id", "=", projectId),
      eb("workspace.branch", "=", branch),
    ]),
  ]));

const mapProjectedAgentSession = (row: Selectable<AgentSessionsTable> & {
  projected_project_id: string;
  projected_branch: string;
}): AgentSession => ({
  ...mapAgentSession(row),
  project_id: row.projected_project_id,
  branch: row.projected_branch,
});

const observeProjectedSession = (
  consumer: WorkspaceBindingReadConsumer | undefined,
  row: Selectable<AgentSessionsTable> & { projected_project_id: string; projected_branch: string },
) => {
  if (!consumer) return;
  if (row.workspace_checkout_id === null) {
    recordWorkspaceBindingRead(consumer, "legacy-fallback");
  } else if (row.project_id !== row.projected_project_id || row.branch !== row.projected_branch) {
    recordWorkspaceBindingRead(consumer, "mismatch");
  } else {
    recordWorkspaceBindingRead(consumer, "checkout-hit");
  }
};

const projectedSessionsByProject = async (
  kdb: Kysely<DB>,
  projectId: string,
  consumer?: WorkspaceBindingReadConsumer,
) => {
  const rows = await kdb
    .selectFrom("agent_sessions as s")
    .leftJoin("workspace_checkouts as checkout", "checkout.id", "s.workspace_checkout_id")
    .leftJoin("workspaces as workspace", "workspace.id", "checkout.workspace_id")
    .selectAll("s")
    .select([
      sql<string>`case when s.workspace_checkout_id is null then s.project_id else workspace.project_id end`.as("projected_project_id"),
      sql<string>`case when s.workspace_checkout_id is null then s.branch else workspace.branch end`.as("projected_branch"),
    ])
    .where((eb) => eb.or([
      eb.and([
        eb("s.workspace_checkout_id", "is", null),
        eb("s.project_id", "=", projectId),
      ]),
      eb.and([
        eb("s.workspace_checkout_id", "is not", null),
        eb("checkout.id", "is not", null),
        eb("workspace.id", "is not", null),
        eb("workspace.project_id", "=", projectId),
      ]),
    ]))
    .orderBy("s.updated_at", "desc")
    .execute();
  rows.forEach((row) => observeProjectedSession(consumer, row));
  if (consumer) {
    const dangling = await kdb.selectFrom("agent_sessions as s")
      .leftJoin("workspace_checkouts as checkout", "checkout.id", "s.workspace_checkout_id")
      .select(kdb.fn.countAll<number>().as("count"))
      .where("s.workspace_checkout_id", "is not", null)
      .where("checkout.id", "is", null)
      .where("s.project_id", "=", projectId)
      .executeTakeFirstOrThrow();
    recordWorkspaceBindingRead(consumer, "dangling", Number(dangling.count));
  }
  return rows.map(mapProjectedAgentSession);
};

const observeDanglingLocalScope = async (
  kdb: Kysely<DB>,
  consumer: WorkspaceBindingReadConsumer | undefined,
  projectId: string,
  branch?: string,
) => {
  if (!consumer) return;
  let query = kdb.selectFrom("agent_sessions as s")
    .leftJoin("workspace_checkouts as checkout", "checkout.id", "s.workspace_checkout_id")
    .select(kdb.fn.countAll<number>().as("count"))
    .where("s.workspace_checkout_id", "is not", null)
    .where("checkout.id", "is", null)
    .where("s.project_id", "=", projectId);
  if (branch !== undefined) query = query.where("s.branch", "=", branch);
  const row = await query.executeTakeFirstOrThrow();
  recordWorkspaceBindingRead(consumer, "dangling", Number(row.count));
};

const mapRemoteCreationIntent = (
  row: Selectable<RemoteSessionCreationIntentsTable>,
): RemoteSessionCreationIntent => ({
  local_session_id: row.local_session_id,
  remote_session_id: row.remote_session_id,
  project_id: row.project_id,
  remote_server_id: row.remote_server_id,
  branch: row.branch,
  remote_path: row.remote_path,
  permission_mode: row.permission_mode as "plan" | "edit",
  agent_type: row.agent_type,
  model: row.model,
  force: fromDbBool(row.force),
  user_id: row.user_id,
  operation_kind: row.operation_kind as "new" | "branch",
  source_remote_session_id: row.source_remote_session_id,
  up_to_entry_index: row.up_to_entry_index,
  status: row.status as "pending" | "confirmed",
  error: row.error,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const mapRemoteReviewerCreationIntent = (
  row: Selectable<RemoteReviewerCreationIntentsTable>,
): RemoteReviewerCreationIntent => ({
  ...row,
  review_span: row.review_span as "this_turn" | "session_start",
  status: row.status as "pending" | "confirmed",
});

const nowActivityAt = () => sql<number>`cast((julianday('now') - 2440587.5) * 86400000 as integer)`;
const touchActivityAt = () => sql<number>`max(activity_at, ${nowActivityAt()})`;

/**
 * The session-retention predicate, in ONE place
 * (docs/plans/2026-08-08-session-retention.md §1.2). Both the candidate scan
 * and the conditional delete embed this same fragment, which is what makes
 * the pre-delete re-check exact rather than approximate: a candidate rescued
 * between the two statements simply fails the DELETE's own WHERE and the
 * caller sees zero affected rows (§1.5).
 *
 * `activity_at` (not `created_at`) is the semantic max of every activity
 * source, so a session created a year ago but used last week is not expired.
 * `status <> 'running'` was written as a defensive clause that "almost never
 * matches past the day threshold". Measured on a real worker (2026-08-09) it
 * matched 63 rows, none of them live: `create` writes `running` BEFORE the
 * process is spawned, so a session that never produced an entry keeps that
 * value forever. Those rows are now reconciled at startup by
 * `AgentSessionManager.repairOrphanedRunningRows`, which is what makes them
 * reachable by retention at all — but the clause stays, and stays load-
 * bearing: it is the SQL-side half of "never delete a session someone is
 * using", the other half being the in-memory check in
 * `deleteDormantSessionIfExpired`. Do not drop it on the grounds that the
 * memory check already covers it; deletion is irreversible and the two
 * checks fail differently. The workflow clause
 * is load-bearing: `workflow_runs.source_session_id` / `reviewer_session_id`
 * carry no foreign key, and an active run's participants are routinely
 * `stopped` while waiting for the reviewer, so without it retention would
 * delete a session the engine is still delivering to.
 */
const retentionPredicate = (cutoff: number) => sql<SqlBool>`
  activity_at < ${cutoff}
  AND favorited_at IS NULL
  AND status <> 'running'
  AND NOT EXISTS (
    SELECT 1 FROM workflow_runs wr
    WHERE wr.status IN (${sql.join(WORKFLOW_ACTIVE_STATUSES.map((s) => sql`${s}`))})
      AND (wr.source_session_id = agent_sessions.id OR wr.reviewer_session_id = agent_sessions.id)
  )
`;

const mapWorkspaceCheckout = (row: {
  id: string;
  workspace_id: string;
  target_id: string;
  worktree_path: string;
  path_source: string;
  expected_branch: string;
  status: string;
  error: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}): WorkspaceCheckoutRecord => ({
  ...row,
  status: row.status as WorkspaceCheckoutRecord["status"],
  path_source: row.path_source as WorkspaceCheckoutRecord["path_source"],
});

const emptyBindingReasonCounts = (): Record<WorkspaceBindingIssueReason, number> => ({
  project_missing: 0,
  workspace_missing: 0,
  checkout_missing: 0,
  main_not_registered: 0,
  target_missing: 0,
  multiple_incarnations: 0,
  dangling_checkout: 0,
  snapshot_mismatch: 0,
});

const classifyUnboundCheckout = async (
  kdb: Kysely<DB>,
  row: { id: string; project_id: string; branch: string | null; target_id: string },
): Promise<{ checkoutId?: string; issue?: WorkspaceBindingIssue }> => {
  const kind = row.target_id === "local" ? "local" : "remote";
  const issue = (reason: WorkspaceBindingIssueReason): { issue: WorkspaceBindingIssue } => ({
    issue: { kind, id: row.id, reason },
  });
  const project = await kdb.selectFrom("projects").select("id")
    .where("id", "=", row.project_id).executeTakeFirst();
  if (!project) return issue("project_missing");

  const branch = row.branch ?? "";
  const workspace = await kdb.selectFrom("workspaces").select("id")
    .where("project_id", "=", row.project_id).where("branch", "=", branch).executeTakeFirst();
  if (!workspace) return issue(branch === "" ? "main_not_registered" : "workspace_missing");

  const candidates = await kdb.selectFrom("workspace_checkouts").select("id")
    .where("workspace_id", "=", workspace.id).where("target_id", "=", row.target_id).execute();
  if (candidates.length > 1) return issue("multiple_incarnations");
  if (candidates.length === 1) return { checkoutId: candidates[0].id };

  const anyCheckout = await kdb.selectFrom("workspace_checkouts").select("id")
    .where("workspace_id", "=", workspace.id).limit(1).executeTakeFirst();
  return issue(anyCheckout ? "target_missing" : "checkout_missing");
};

export const createAgentSessionRepos = (
  kdb: Kysely<DB>,
  h: DialectHelpers,
): Pick<Storage, "agentSessions" | "agentInstructionDeliveries" | "remoteSessionMappings" | "remoteSessionCreationIntents" | "remoteReviewerCreationIntents" | "workspaceBindingMigration"> => ({
  agentSessions: {
    // Millisecond-precision timestamps (h.nowMs()) are set explicitly here
    // (and in the UPDATE statements below) so existing databases whose
    // DEFAULTs still resolve to CURRENT_TIMESTAMP also get sub-second
    // writes — this is what lets getLatestByBranch break ties
    // deterministically (see the schema.ts / sqlite.ts DDL comment on
    // agent_sessions).
    create: async ({ id, project_id, branch, permission_mode, agent_type, model }) => {
      await kdb.insertInto("agent_sessions").values({
        id,
        project_id,
        branch,
        status: "running",
        permission_mode: permission_mode ?? "edit",
        agent_type: agent_type ?? "claude-code",
        model: model ?? null,
        created_at: h.nowMs(),
        updated_at: h.nowMs(),
        activity_at: nowActivityAt(),
      }).execute();
      const row = await kdb.selectFrom("agent_sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapAgentSession(row);
    },

    createBound: async ({
      id, project_id, branch, target_id, checkout_id, permission_mode, agent_type, model,
    }) => kdb.transaction().execute(async (trx) => {
      let query = trx.selectFrom("workspace_checkouts")
        .innerJoin("workspaces", "workspaces.id", "workspace_checkouts.workspace_id")
        .selectAll("workspace_checkouts")
        .where("workspaces.project_id", "=", project_id)
        .where("workspaces.branch", "=", branch)
        .where("workspace_checkouts.target_id", "=", target_id)
        .where("workspace_checkouts.deleted_at", "is", null)
        .where("workspace_checkouts.status", "=", "ready");
      if (checkout_id) {
        query = query.where("workspace_checkouts.id", "=", checkout_id);
      }
      const checkout = await query.executeTakeFirst();
      if (!checkout) {
        throw new Error(checkout_id
          ? `Workspace checkout ${checkout_id} is not available for this session`
          : `No ready workspace checkout for project ${project_id}, branch ${branch}, target ${target_id}`);
      }

      await trx.insertInto("agent_sessions").values({
        id,
        project_id,
        branch,
        workspace_checkout_id: checkout.id,
        status: "running",
        permission_mode: permission_mode ?? "edit",
        agent_type: agent_type ?? "claude-code",
        model: model ?? null,
        created_at: h.nowMs(),
        updated_at: h.nowMs(),
        activity_at: nowActivityAt(),
      }).execute();
      const session = await trx.selectFrom("agent_sessions").selectAll()
        .where("id", "=", id).executeTakeFirstOrThrow();
      return { session: mapAgentSession(session), checkout: mapWorkspaceCheckout(checkout) };
    }),

    getAll: async () => {
      const rows = await kdb.selectFrom("agent_sessions").selectAll().orderBy("updated_at", "desc").execute();
      return rows.map(mapAgentSession);
    },

    getById: async (id) => {
      const row = await kdb.selectFrom("agent_sessions").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapAgentSession(row) : undefined;
    },

    getByProjectId: async (projectId) => {
      const rows = await kdb.selectFrom("agent_sessions").selectAll()
        .where("project_id", "=", projectId)
        .orderBy("updated_at", "desc")
        .execute();
      return rows.map(mapAgentSession);
    },

    getProjectedByProjectId: async (projectId, consumer) => projectedSessionsByProject(kdb, projectId, consumer),

    listByProject: async (projectId, limit) => {
      const rows = await kdb.selectFrom("agent_sessions").selectAll()
        .where("project_id", "=", projectId)
        .orderBy("updated_at", "desc")
        .orderBy("id", "asc")
        .limit(limit)
        .execute();
      return rows.map(mapAgentSession);
    },

    listRecentByProject: async (projectId, limit) => {
      const rows = await kdb.selectFrom("agent_sessions").selectAll()
        .where("project_id", "=", projectId)
        .orderBy("activity_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(mapAgentSession);
    },

    listRecentActivityByProject: async (projectId, limit, consumer) => {
      const rows = await localActivityBase(kdb, projectId)
        .orderBy("s.activity_at", "desc")
        .orderBy("s.id", "desc")
        .limit(limit)
        .execute();
      rows.forEach((row) => observeLocalActivity(consumer, row));
      await observeDanglingLocalScope(kdb, consumer, projectId);
      return rows.map(mapLocalActivity);
    },

    getActivityById: async (id, consumer) => {
      const row = await localActivityBase(kdb).where("s.id", "=", id).executeTakeFirst();
      if (row) {
        observeLocalActivity(consumer, row);
      } else if (consumer) {
        const raw = await kdb.selectFrom("agent_sessions")
          .select("workspace_checkout_id").where("id", "=", id).executeTakeFirst();
        if (raw?.workspace_checkout_id) recordWorkspaceBindingRead(consumer, "dangling");
      }
      return row ? mapLocalActivity(row) : undefined;
    },

    listAttentionByProject: async (projectId, limit) => {
      const rows = await kdb.selectFrom("agent_sessions").selectAll()
        .where("project_id", "=", projectId)
        .where((eb) => eb.or([
          eb("status", "=", "error"),
          eb.and([
            eb("status", "=", "stopped"),
            eb("last_user_message_at", "is not", null),
            eb.or([
              eb("last_completed_at", "is", null),
              eb("last_completed_at", "<", eb.ref("last_user_message_at")),
            ]),
          ]),
        ]))
        .orderBy("activity_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(mapAgentSession);
    },

    listAttentionActivityByProject: async (projectId, limit, consumer) => {
      const rows = await localActivityBase(kdb, projectId)
        .where((eb) => eb.or([
          eb("s.status", "=", "error"),
          eb.and([
            eb("s.status", "=", "stopped"),
            eb("s.last_user_message_at", "is not", null),
            eb.or([
              eb("s.last_completed_at", "is", null),
              eb("s.last_completed_at", "<", eb.ref("s.last_user_message_at")),
            ]),
          ]),
        ]))
        .orderBy("s.activity_at", "desc")
        .orderBy("s.id", "desc")
        .limit(limit)
        .execute();
      rows.forEach((row) => observeLocalActivity(consumer, row));
      await observeDanglingLocalScope(kdb, consumer, projectId);
      return rows.map(mapLocalActivity);
    },

    countRunningByProject: async (projectId) => {
      const row = await kdb.selectFrom("agent_sessions")
        .select(kdb.fn.countAll<number>().as("count"))
        .where("project_id", "=", projectId)
        .where("status", "=", "running")
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    countRunningActivityByProject: async (projectId) => {
      const row = await localActivityBase(kdb, projectId)
        .where("s.status", "=", "running")
        .clearSelect()
        .select(kdb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    getByBranch: async (projectId, branch) => {
      const row = await projectedSessionByBranchBase(kdb, projectId, branch)
        .orderBy("s.updated_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return row ? mapProjectedAgentSession(row) : undefined;
    },

    listByBranch: async (projectId, branch, consumer) => {
      const rows = await projectedSessionByBranchBase(kdb, projectId, branch)
        .orderBy("s.updated_at", "desc")
        .orderBy("s.created_at", "desc")
        .execute();
      rows.forEach((row) => observeProjectedSession(consumer, row));
      await observeDanglingLocalScope(kdb, consumer, projectId, branch);
      return rows.map(mapProjectedAgentSession);
    },

    getLatestByBranch: async (projectId, branch, consumer) => {
      const row = await projectedSessionByBranchBase(kdb, projectId, branch)
        .orderBy("s.updated_at", "desc")
        .orderBy("s.created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      if (row) observeProjectedSession(consumer, row);
      await observeDanglingLocalScope(kdb, consumer, projectId, branch);
      return row ? mapProjectedAgentSession(row) : undefined;
    },

    updateStatus: async (id, status) => {
      await kdb.updateTable("agent_sessions")
        .set({ status, updated_at: h.nowMs(), activity_at: touchActivityAt() })
        .where("id", "=", id)
        .execute();
    },

    updateStatusPreservingTimestamp: async (id, status) => {
      await kdb.updateTable("agent_sessions").set({ status }).where("id", "=", id).execute();
    },

    updatePermissionMode: async (id, mode) => {
      await kdb.updateTable("agent_sessions")
        .set({ permission_mode: mode, updated_at: h.nowMs(), activity_at: touchActivityAt() })
        .where("id", "=", id)
        .execute();
    },

    updateAgentType: async (id, agent_type) => {
      await kdb.updateTable("agent_sessions")
        .set({ agent_type, updated_at: h.nowMs(), activity_at: touchActivityAt() })
        .where("id", "=", id)
        .execute();
    },

    updateModel: async (id, model) => {
      await kdb.updateTable("agent_sessions")
        .set({ model, updated_at: h.nowMs(), activity_at: touchActivityAt() })
        .where("id", "=", id)
        .execute();
    },

    updateTitle: async (id, title) => {
      await kdb.updateTable("agent_sessions")
        .set({ title, updated_at: h.nowMs(), activity_at: touchActivityAt() })
        .where("id", "=", id)
        .execute();
    },

    setNativeSessionId: async (id, nativeSessionId, agentType) => {
      await kdb.transaction().execute(async (trx) => {
        await trx.updateTable("agent_sessions")
          .set({ native_session_id: nativeSessionId })
          .where("id", "=", id)
          .execute();
        // Append-only history: a wake/mode-switch/restart spawns a fresh CLI
        // process with a NEW native session — the older transcripts still
        // hold the turns that ran in them, so their associations must never
        // be overwritten, only added to.
        await trx.insertInto("agent_session_native_ids")
          .values({ session_id: id, native_session_id: nativeSessionId, agent_type: agentType })
          .onConflict((oc) => oc.columns(["session_id", "native_session_id"]).doNothing())
          .execute();
      });
    },

    getNativeSessionIds: async (id) => {
      return kdb.selectFrom("agent_session_native_ids")
        .select(["native_session_id", "agent_type", "created_at"])
        .where("session_id", "=", id)
        .orderBy("created_at", "asc")
        .execute();
    },

    // Toggle favorite without touching updated_at — favoriting is a passive
    // bookmark, not a "this session was active" signal, so it must not
    // disturb the dropdown's recency ordering.
    setFavorited: async (id, favorited) => {
      await kdb.updateTable("agent_sessions")
        .set({ favorited_at: favorited ? Date.now() : null })
        .where("id", "=", id)
        .execute();
    },

    touchUpdatedAt: async (id) => {
      await kdb.updateTable("agent_sessions")
        .set({ updated_at: h.nowMs(), activity_at: touchActivityAt() })
        .where("id", "=", id).execute();
    },

    markUserMessage: async (id, timestampMs) => {
      await kdb.updateTable("agent_sessions")
        .set({ last_user_message_at: timestampMs, activity_at: sql<number>`max(activity_at, ${timestampMs})` })
        .where("id", "=", id).execute();
    },

    markCompleted: async (id, timestampMs) => {
      await kdb.updateTable("agent_sessions")
        .set({ last_completed_at: timestampMs, activity_at: sql<number>`max(activity_at, ${timestampMs})` })
        .where("id", "=", id).execute();
    },

    delete: async (id) => {
      await kdb.deleteFrom("agent_sessions").where("id", "=", id).execute();
    },

    // The original inline statement is `INSERT ... ON CONFLICT(session_id,
    // entry_index) DO UPDATE SET data = excluded.data` (NOT `INSERT OR
    // REPLACE`), so it already preserves row identity (the autoincrement
    // `id` and `created_at`) on a repeat write to the same index — no
    // delete-and-reinsert semantics to reconcile. DB-arbitrated single
    // statement; no transaction needed.
    upsertEntry: async (sessionId, entryIndex, data) => {
      await kdb.insertInto("agent_session_entries")
        .values({ session_id: sessionId, entry_index: entryIndex, data })
        .onConflict((oc) => oc.columns(["session_id", "entry_index"]).doUpdateSet({ data }))
        .execute();
    },

    // One transaction, both writes idempotent — see the contract note in
    // types.ts for why the milestone must ride with the turn_end rather than
    // being written next to it.
    upsertTurnEndWithOutbox: async ({ sessionId, entryIndex, entryData, outbox }) => {
      await kdb.transaction().execute(async (trx) => {
        await trx.insertInto("agent_session_entries")
          .values({ session_id: sessionId, entry_index: entryIndex, data: entryData })
          .onConflict((oc) => oc.columns(["session_id", "entry_index"]).doUpdateSet({ data: entryData }))
          .execute();
        if (outbox) {
          await trx.insertInto("notification_outbox")
            .values(outbox)
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
        }
      });
    },

    getEntries: async (sessionId) => {
      return kdb.selectFrom("agent_session_entries")
        .select(["entry_index", "data"])
        .where("session_id", "=", sessionId)
        .orderBy("entry_index", "asc")
        .execute();
    },

    deleteEntries: async (sessionId) => {
      await kdb.deleteFrom("agent_session_entries").where("session_id", "=", sessionId).execute();
    },

    countEntries: async () => {
      return kdb.selectFrom("agent_session_entries")
        .select("session_id")
        .select(kdb.fn.countAll<number>().as("cnt"))
        .groupBy("session_id")
        .execute();
    },

    listRetentionCandidates: async ({ cutoff, limit, after }) => {
      let query = kdb.selectFrom("agent_sessions")
        .select(["id", "project_id", "branch", "activity_at"])
        .where(retentionPredicate(cutoff));
      if (after) {
        // Keyset, matching the ORDER BY below exactly: strictly after
        // (activity_at, id) so a page of skipped candidates can never be
        // re-read within the same sweep.
        query = query.where(sql<SqlBool>`
          (activity_at > ${after.activityAt}
            OR (activity_at = ${after.activityAt} AND id > ${after.id}))
        `);
      }
      return query
        .orderBy("activity_at", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .execute();
    },

    deleteIfExpired: async (id, cutoff) => {
      const result = await kdb.deleteFrom("agent_sessions")
        .where("id", "=", id)
        .where(retentionPredicate(cutoff))
        .executeTakeFirst();
      return (result.numDeletedRows ?? 0n) > 0n;
    },

    listIdsByProject: async (projectId) => {
      const rows = await kdb.selectFrom("agent_sessions")
        .select("id")
        .where("project_id", "=", projectId)
        .orderBy("id", "asc")
        .execute();
      return rows.map((r) => r.id);
    },
  },

  agentInstructionDeliveries: {
    claim: async ({ sessionId, idempotencyKey, contentHash, claimToken, leaseMs = 30_000 }) => kdb.transaction()
      .execute(async (trx) => {
        const leaseExpiresAt = Date.now() + leaseMs;
        const existing = await trx.selectFrom("agent_instruction_deliveries")
          .selectAll()
          .where("session_id", "=", sessionId)
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (!existing) {
          await trx.insertInto("agent_instruction_deliveries").values({
            session_id: sessionId, idempotency_key: idempotencyKey,
            content_hash: contentHash, status: "pending", claim_token: claimToken,
            owner_token: claimToken, lease_expires_at: leaseExpiresAt,
            updated_at: h.nowMs(),
          }).execute();
          return "claimed" as const;
        }
        if (existing.content_hash !== contentHash) return "conflict" as const;
        if (existing.status === "sent") return "sent" as const;
        if (existing.owner_token !== claimToken
          && existing.lease_expires_at !== null && existing.lease_expires_at > Date.now()) {
          return "busy" as const;
        }
        const result = await trx.updateTable("agent_instruction_deliveries")
          .set({ claim_token: claimToken, owner_token: claimToken, lease_expires_at: leaseExpiresAt, updated_at: h.nowMs() })
          .where("session_id", "=", sessionId)
          .where("idempotency_key", "=", idempotencyKey)
          .where("status", "=", "pending")
          .where((eb) => eb.or([
            eb("owner_token", "=", claimToken), eb("lease_expires_at", "is", null),
            eb("lease_expires_at", "<=", Date.now()),
          ]))
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1 ? "claimed" as const : "busy" as const;
      }),
    markSent: async ({ sessionId, idempotencyKey, claimToken }) => {
      const result = await kdb.updateTable("agent_instruction_deliveries")
        .set({ status: "sent", claim_token: null, owner_token: null, lease_expires_at: null, updated_at: h.nowMs() })
        .where("session_id", "=", sessionId)
        .where("idempotency_key", "=", idempotencyKey)
        .where("status", "=", "pending")
        .where("claim_token", "=", claimToken)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    renewClaim: async ({ sessionId, idempotencyKey, claimToken, leaseMs = 30_000 }) => {
      const result = await kdb.updateTable("agent_instruction_deliveries")
        .set({ lease_expires_at: Date.now() + leaseMs, updated_at: h.nowMs() })
        .where("session_id", "=", sessionId).where("idempotency_key", "=", idempotencyKey)
        .where("status", "=", "pending").where("owner_token", "=", claimToken)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    release: async ({ sessionId, idempotencyKey, claimToken }) => {
      await kdb.updateTable("agent_instruction_deliveries")
        .set({ claim_token: null, owner_token: null, lease_expires_at: null, updated_at: h.nowMs() })
        .where("session_id", "=", sessionId)
        .where("idempotency_key", "=", idempotencyKey)
        .where("status", "=", "pending")
        .where("claim_token", "=", claimToken)
        .execute();
    },
  },

  remoteSessionMappings: {
    // ON CONFLICT SET deliberately omits title_resolved — a re-upsert (e.g.
    // the remote session getting re-mapped after a reconnect) must not reset
    // the "AI title already generated" flag back to false. It omits
    // notification_sync_start and notification_watch_until for the same reason:
    // re-mapping a session (reconnect) or reusing a reviewer for a second
    // review must not downgrade an established from_start policy, and must not
    // rewind the watch window mid-flight. The sync cursor lives in its own
    // table and is likewise untouched — a reused reviewer continues from the
    // boundary it already imported instead of replaying its whole history.
    upsert: async (localSessionId, projectId, remoteServerId, remoteSessionId, branch, notificationSyncStart) => {
      await kdb.insertInto("remote_session_mappings")
        .values({
          local_session_id: localSessionId,
          project_id: projectId,
          remote_server_id: remoteServerId,
          remote_session_id: remoteSessionId,
          branch,
          notification_sync_start: notificationSyncStart ?? "from_now",
        })
        .onConflict((oc) => oc.column("local_session_id").doUpdateSet({
          project_id: projectId,
          remote_server_id: remoteServerId,
          remote_session_id: remoteSessionId,
          branch,
        }))
        .execute();
    },

    upsertBound: async ({
      localSessionId, projectId, remoteServerId, remoteSessionId, branch, checkoutId, notificationSyncStart,
    }) => kdb.transaction().execute(async (trx) => {
      const checkout = await trx.selectFrom("workspace_checkouts")
        .innerJoin("workspaces", "workspaces.id", "workspace_checkouts.workspace_id")
        .select("workspace_checkouts.id")
        .where("workspace_checkouts.id", "=", checkoutId)
        .where("workspace_checkouts.target_id", "=", remoteServerId)
        .where("workspace_checkouts.deleted_at", "is", null)
        .where("workspace_checkouts.status", "=", "ready")
        .where("workspaces.project_id", "=", projectId)
        .where("workspaces.branch", "=", branch ?? "")
        .executeTakeFirst();
      if (!checkout) throw new Error(`Workspace checkout ${checkoutId} is not available for remote session`);

      await trx.insertInto("remote_session_mappings").values({
        local_session_id: localSessionId,
        project_id: projectId,
        remote_server_id: remoteServerId,
        remote_session_id: remoteSessionId,
        branch,
        workspace_checkout_id: checkoutId,
        notification_sync_start: notificationSyncStart ?? "from_now",
      }).onConflict((oc) => oc.column("local_session_id").doUpdateSet({
        project_id: projectId,
        remote_server_id: remoteServerId,
        remote_session_id: remoteSessionId,
        branch,
        workspace_checkout_id: checkoutId,
      })).execute();
    }),

    getAll: async () => {
      const rows = await kdb.selectFrom("remote_session_mappings").selectAll().execute();
      return rows.map(mapRemoteSessionMapping);
    },

    listByProject: async (projectId, limit, consumer) => {
      const rows = await projectedRemoteMappingBase(kdb)
        .where(sql<boolean>`case when mapping.workspace_checkout_id is null then mapping.project_id else workspace.project_id end = ${projectId}`)
        .orderBy("mapping.local_session_id", "asc")
        .limit(limit)
        .execute();
      rows.forEach((row) => observeProjectedRemoteMapping(consumer, row));
      if (consumer) {
        const dangling = await kdb.selectFrom("remote_session_mappings as mapping")
          .leftJoin("workspace_checkouts as checkout", "checkout.id", "mapping.workspace_checkout_id")
          .select(kdb.fn.countAll<number>().as("count"))
          .where("mapping.workspace_checkout_id", "is not", null)
          .where("checkout.id", "is", null)
          .where("mapping.project_id", "=", projectId)
          .executeTakeFirstOrThrow();
        recordWorkspaceBindingRead(consumer, "dangling", Number(dangling.count));
      }
      return rows.map(mapRemoteSessionMapping);
    },

    getByLocal: async (localSessionId) => {
      const row = await kdb.selectFrom("remote_session_mappings").selectAll()
        .where("local_session_id", "=", localSessionId)
        .executeTakeFirst();
      return row ? mapRemoteSessionMapping(row) : undefined;
    },

    getAuthorizedByLocal: async (localSessionId, projectId, consumer) => {
      const row = await projectedRemoteMappingBase(kdb)
        .where("mapping.local_session_id", "=", localSessionId)
        .where(sql<boolean>`case when mapping.workspace_checkout_id is null then mapping.project_id else workspace.project_id end = ${projectId}`)
        .executeTakeFirst();
      if (row) {
        observeProjectedRemoteMapping(consumer, row);
      } else if (consumer) {
        const raw = await kdb.selectFrom("remote_session_mappings")
          .select("workspace_checkout_id")
          .where("local_session_id", "=", localSessionId)
          .executeTakeFirst();
        if (raw?.workspace_checkout_id) recordWorkspaceBindingRead(consumer, "dangling");
      }
      return row ? mapRemoteSessionMapping(row) : undefined;
    },

    getByRemote: async (remoteServerId, remoteSessionId) => {
      const row = await kdb.selectFrom("remote_session_mappings").selectAll()
        .where("remote_server_id", "=", remoteServerId)
        .where("remote_session_id", "=", remoteSessionId)
        .executeTakeFirst();
      return row ? mapRemoteSessionMapping(row) : undefined;
    },

    // MAX(existing, incoming): concurrent extenders (a new turn plus live
    // stream activity) must not shorten a longer window one of them already set.
    extendNotificationWatch: async (localSessionId, until) => {
      await kdb.updateTable("remote_session_mappings")
        .set({
          notification_watch_until:
            sql<number>`MAX(COALESCE(notification_watch_until, 0), ${until})`,
        })
        .where("local_session_id", "=", localSessionId)
        .execute();
    },

    getNotificationSyncCandidates: async ({ now, includeExpired }, consumer) => {
      // Unlike user-facing authorized lists, the sweep deliberately retains
      // legacy mappings whose association disappeared so resolveTarget() can
      // skip them explicitly without changing the established recovery
      // contract. Bound rows still project ownership through their checkout;
      // only a non-NULL dangling binding is excluded.
      let query = kdb.selectFrom("remote_session_mappings as mapping")
        .leftJoin("workspace_checkouts as checkout", "checkout.id", "mapping.workspace_checkout_id")
        .leftJoin("workspaces as workspace", "workspace.id", "checkout.workspace_id")
        .select([
          "mapping.local_session_id", "mapping.remote_session_id", "mapping.workspace_checkout_id",
          "mapping.notification_sync_start", "mapping.notification_watch_until",
          "mapping.project_id as snapshot_project_id", "mapping.remote_server_id as snapshot_remote_server_id",
          "mapping.branch as snapshot_branch",
          sql<string>`case when mapping.workspace_checkout_id is null then mapping.project_id else workspace.project_id end`.as("project_id"),
          sql<string>`case when mapping.workspace_checkout_id is null then mapping.remote_server_id else checkout.target_id end`.as("remote_server_id"),
          sql<string | null>`case when mapping.workspace_checkout_id is null then mapping.branch else nullif(workspace.branch, '') end`.as("branch"),
        ])
        .where((eb) => eb.or([
          eb("mapping.workspace_checkout_id", "is", null),
          eb.and([eb("checkout.id", "is not", null), eb("workspace.id", "is not", null)]),
        ]));
      if (!includeExpired) {
        query = query.where("mapping.notification_watch_until", ">", now);
      }
      const rows = await query.orderBy("mapping.local_session_id", "asc").execute();
      if (consumer) {
        for (const row of rows) {
          if (row.workspace_checkout_id === null) {
            recordWorkspaceBindingRead(consumer, "legacy-fallback");
          } else if (row.snapshot_project_id !== row.project_id
            || row.snapshot_remote_server_id !== row.remote_server_id
            || (row.snapshot_branch ?? "") !== (row.branch ?? "")) {
            recordWorkspaceBindingRead(consumer, "mismatch");
          } else {
            recordWorkspaceBindingRead(consumer, "checkout-hit");
          }
        }
        let danglingQuery = kdb.selectFrom("remote_session_mappings as mapping")
          .leftJoin("workspace_checkouts as checkout", "checkout.id", "mapping.workspace_checkout_id")
          .select(kdb.fn.countAll<number>().as("count"))
          .where("mapping.workspace_checkout_id", "is not", null)
          .where("checkout.id", "is", null);
        if (!includeExpired) danglingQuery = danglingQuery.where("mapping.notification_watch_until", ">", now);
        const dangling = await danglingQuery.executeTakeFirstOrThrow();
        recordWorkspaceBindingRead(consumer, "dangling", Number(dangling.count));
      }
      return rows.map(mapRemoteSessionMapping);
    },

    // The cursor is deleted with the mapping: without a mapping the front has
    // no local target for the worker's events, so a stale cursor would only
    // suppress a legitimate re-mapping's from_start replay.
    delete: async (localSessionId, expect) => {
      return kdb.transaction().execute(async (trx) => {
        const row = await trx.selectFrom("remote_session_mappings")
          .select(["remote_server_id", "remote_session_id"])
          .where("local_session_id", "=", localSessionId)
          .executeTakeFirst();
        // Read and delete share one transaction, so `expect` is a real
        // compare-and-delete rather than another check-then-act.
        if (expect && (!row
          || row.remote_server_id !== expect.remoteServerId
          || row.remote_session_id !== expect.remoteSessionId)) {
          return false;
        }
        const result = await trx.deleteFrom("remote_session_mappings")
          .where("local_session_id", "=", localSessionId).executeTakeFirst();
        if (row) {
          await trx.deleteFrom("notification_sync_cursors")
            .where("remote_server_id", "=", row.remote_server_id)
            .where("remote_session_id", "=", row.remote_session_id)
            .execute();
        }
        return (result.numDeletedRows ?? 0n) > 0n;
      });
    },

    isTitleResolved: async (localSessionId) => {
      const row = await kdb.selectFrom("remote_session_mappings")
        .select("title_resolved")
        .where("local_session_id", "=", localSessionId)
        .executeTakeFirst();
      return fromDbBool(row?.title_resolved);
    },

    markTitleResolved: async (localSessionId) => {
      await kdb.updateTable("remote_session_mappings")
        .set({ title_resolved: h.toDbBool(true) })
        .where("local_session_id", "=", localSessionId)
        .execute();
    },
  },

  remoteSessionCreationIntents: {
    begin: async (intent) => kdb.transaction().execute(async (trx) => {
      await trx.insertInto("remote_session_creation_intents").values({
        local_session_id: intent.localSessionId,
        remote_session_id: intent.remoteSessionId,
        project_id: intent.projectId,
        remote_server_id: intent.remoteServerId,
        branch: intent.branch,
        remote_path: intent.remotePath,
        permission_mode: intent.permissionMode,
        agent_type: intent.agentType ?? null,
        model: intent.model ?? null,
        force: h.toDbBool(intent.force ?? false),
        user_id: intent.userId ?? null,
        operation_kind: intent.operationKind ?? "new",
        source_remote_session_id: intent.sourceRemoteSessionId ?? null,
        up_to_entry_index: intent.upToEntryIndex ?? null,
        status: "pending",
        error: null,
        created_at: h.nowMs(),
        updated_at: h.nowMs(),
      }).onConflict((oc) => oc.column("local_session_id").doNothing()).execute();
      const row = await trx.selectFrom("remote_session_creation_intents").selectAll()
        .where("local_session_id", "=", intent.localSessionId).executeTakeFirstOrThrow();
      const sameIdentity = row.remote_session_id === intent.remoteSessionId
        && row.project_id === intent.projectId
        && row.remote_server_id === intent.remoteServerId
        && (row.branch ?? "") === (intent.branch ?? "")
        && row.remote_path === intent.remotePath
        && row.permission_mode === intent.permissionMode
        && row.agent_type === (intent.agentType ?? null)
        && row.model === (intent.model ?? null)
        && fromDbBool(row.force) === (intent.force ?? false)
        && row.user_id === (intent.userId ?? null);
      const sameOperation = row.operation_kind === (intent.operationKind ?? "new")
        && row.source_remote_session_id === (intent.sourceRemoteSessionId ?? null)
        && row.up_to_entry_index === (intent.upToEntryIndex ?? null);
      if (!sameIdentity || !sameOperation) throw new Error(`Remote creation intent ${intent.localSessionId} has conflicting identity`);
      return mapRemoteCreationIntent(row);
    }),

    confirm: async (localSessionId) => {
      await kdb.updateTable("remote_session_creation_intents")
        .set({ status: "confirmed", error: null, updated_at: h.nowMs() })
        .where("local_session_id", "=", localSessionId).execute();
    },

    discard: async (localSessionId) => {
      await kdb.deleteFrom("remote_session_creation_intents")
        .where("local_session_id", "=", localSessionId).execute();
    },

    recordError: async (localSessionId, error) => {
      await kdb.updateTable("remote_session_creation_intents")
        .set({ error, updated_at: h.nowMs() })
        .where("local_session_id", "=", localSessionId)
        .where("status", "=", "pending").execute();
    },

    listPending: async (remoteServerId) => {
      let query = kdb.selectFrom("remote_session_creation_intents").selectAll()
        .where("status", "=", "pending");
      if (remoteServerId) query = query.where("remote_server_id", "=", remoteServerId);
      return (await query.orderBy("updated_at", "asc").orderBy("local_session_id", "asc").execute())
        .map(mapRemoteCreationIntent);
    },
  },

  remoteReviewerCreationIntents: {
    begin: async (intent) => kdb.transaction().execute(async (trx) => {
      await trx.insertInto("remote_reviewer_creation_intents").values({
        local_reviewer_session_id: intent.localReviewerSessionId,
        remote_reviewer_session_id: intent.remoteReviewerSessionId,
        remote_run_id: intent.remoteRunId,
        project_id: intent.projectId,
        remote_server_id: intent.remoteServerId,
        branch: intent.branch,
        remote_path: intent.remotePath,
        source_remote_session_id: intent.sourceRemoteSessionId,
        review_focus: intent.reviewFocus ?? null,
        source_turn_end_index: intent.sourceTurnEndIndex ?? null,
        review_span: intent.reviewSpan,
        agent_type: intent.agentType,
        intent_brief: intent.intentBrief ?? null,
        user_id: intent.userId ?? null,
        status: "pending",
        error: null,
        created_at: h.nowMs(),
        updated_at: h.nowMs(),
      }).onConflict((oc) => oc.column("local_reviewer_session_id").doNothing()).execute();
      const row = await trx.selectFrom("remote_reviewer_creation_intents").selectAll()
        .where("local_reviewer_session_id", "=", intent.localReviewerSessionId)
        .executeTakeFirstOrThrow();
      const sameIdentity = row.remote_reviewer_session_id === intent.remoteReviewerSessionId
        && row.remote_run_id === intent.remoteRunId
        && row.project_id === intent.projectId
        && row.remote_server_id === intent.remoteServerId
        && (row.branch ?? "") === (intent.branch ?? "")
        && row.remote_path === intent.remotePath
        && row.source_remote_session_id === intent.sourceRemoteSessionId
        && row.review_focus === (intent.reviewFocus ?? null)
        && row.source_turn_end_index === (intent.sourceTurnEndIndex ?? null)
        && row.review_span === intent.reviewSpan
        && row.agent_type === intent.agentType
        && row.intent_brief === (intent.intentBrief ?? null)
        && row.user_id === (intent.userId ?? null);
      if (!sameIdentity) {
        throw new Error(`Remote reviewer creation intent ${intent.localReviewerSessionId} has conflicting identity`);
      }
      return mapRemoteReviewerCreationIntent(row);
    }),

    confirm: async (localReviewerSessionId) => {
      await kdb.updateTable("remote_reviewer_creation_intents")
        .set({ status: "confirmed", error: null, updated_at: h.nowMs() })
        .where("local_reviewer_session_id", "=", localReviewerSessionId).execute();
    },

    discard: async (localReviewerSessionId) => {
      await kdb.deleteFrom("remote_reviewer_creation_intents")
        .where("local_reviewer_session_id", "=", localReviewerSessionId).execute();
    },

    recordError: async (localReviewerSessionId, error) => {
      await kdb.updateTable("remote_reviewer_creation_intents")
        .set({ error, updated_at: h.nowMs() })
        .where("local_reviewer_session_id", "=", localReviewerSessionId)
        .where("status", "=", "pending").execute();
    },

    listPending: async (remoteServerId) => {
      let query = kdb.selectFrom("remote_reviewer_creation_intents").selectAll()
        .where("status", "=", "pending");
      if (remoteServerId) query = query.where("remote_server_id", "=", remoteServerId);
      return (await query.orderBy("updated_at", "asc")
        .orderBy("local_reviewer_session_id", "asc").execute())
        .map(mapRemoteReviewerCreationIntent);
    },
  },

  workspaceBindingMigration: {
    listUnboundLocalProjects: async () => {
      const rows = await kdb.selectFrom("agent_sessions as s")
        .innerJoin("projects as p", "p.id", "s.project_id")
        .select(["p.id", "p.path"])
        .where("s.workspace_checkout_id", "is", null)
        .where("p.path", "is not", null)
        .where("p.path", "<>", "")
        .groupBy(["p.id", "p.path"])
        .execute();
      return rows.map((row) => ({ id: row.id, path: row.path! }));
    },

    backfill: async ({ kind, dryRun = true, batchSize = 100, afterId = "" }) => {
      const limit = Math.max(1, Math.min(1000, batchSize));
      const source = kind === "local"
        ? await kdb.selectFrom("agent_sessions")
          .select(["id", "project_id", "branch"])
          .where("workspace_checkout_id", "is", null)
          .where("id", ">", afterId).orderBy("id", "asc").limit(limit).execute()
        : await kdb.selectFrom("remote_session_mappings")
          .select(["local_session_id as id", "project_id", "branch", "remote_server_id"])
          .where("workspace_checkout_id", "is", null)
          .where("local_session_id", ">", afterId).orderBy("local_session_id", "asc").limit(limit).execute();
      let updated = 0;
      const reasons = emptyBindingReasonCounts();
      const issues: WorkspaceBindingIssue[] = [];
      for (const row of source) {
        const targetId = kind === "local" ? "local" : (row as typeof row & { remote_server_id: string }).remote_server_id;
        const classification = await classifyUnboundCheckout(kdb, {
          id: row.id, project_id: row.project_id, branch: row.branch, target_id: targetId,
        });
        if (classification.issue) {
          reasons[classification.issue.reason]++;
          issues.push(classification.issue);
          continue;
        }
        if (!dryRun) {
          const result = kind === "local"
            ? await kdb.updateTable("agent_sessions")
              .set({ workspace_checkout_id: classification.checkoutId! })
              .where("id", "=", row.id).where("workspace_checkout_id", "is", null).executeTakeFirst()
            : await kdb.updateTable("remote_session_mappings")
              .set({ workspace_checkout_id: classification.checkoutId! })
              .where("local_session_id", "=", row.id).where("workspace_checkout_id", "is", null).executeTakeFirst();
          if (Number(result.numUpdatedRows) > 0) updated++;
        }
      }
      return {
        scanned: source.length,
        updated,
        nextCursor: source.length === limit ? source[source.length - 1].id : null,
        reasons,
        issues,
      };
    },

    diagnose: async () => {
      const scalar = async (query: ReturnType<typeof sql<{ count: number }>>) =>
        Number((await query.execute(kdb)).rows[0]?.count ?? 0);
      const unboundLocalRows = await kdb.selectFrom("agent_sessions")
        .select(["id", "project_id", "branch"]).where("workspace_checkout_id", "is", null).execute();
      const unboundRemoteRows = await kdb.selectFrom("remote_session_mappings")
        .select(["local_session_id as id", "project_id", "branch", "remote_server_id"])
        .where("workspace_checkout_id", "is", null).execute();
      const issues: WorkspaceBindingIssue[] = [];
      for (const row of unboundLocalRows) {
        const result = await classifyUnboundCheckout(kdb, { ...row, target_id: "local" });
        if (result.issue) issues.push(result.issue);
      }
      for (const row of unboundRemoteRows) {
        const result = await classifyUnboundCheckout(kdb, { ...row, target_id: row.remote_server_id });
        if (result.issue) issues.push(result.issue);
      }
      const danglingLocalRows = await sql<{ id: string }>`SELECT s.id FROM agent_sessions s LEFT JOIN workspace_checkouts c ON c.id=s.workspace_checkout_id WHERE s.workspace_checkout_id IS NOT NULL AND c.id IS NULL`.execute(kdb);
      const danglingRemoteRows = await sql<{ id: string }>`SELECT m.local_session_id AS id FROM remote_session_mappings m LEFT JOIN workspace_checkouts c ON c.id=m.workspace_checkout_id WHERE m.workspace_checkout_id IS NOT NULL AND c.id IS NULL`.execute(kdb);
      const localMismatchRows = await sql<{ id: string }>`SELECT s.id FROM agent_sessions s JOIN workspace_checkouts c ON c.id=s.workspace_checkout_id JOIN workspaces w ON w.id=c.workspace_id WHERE s.project_id<>w.project_id OR s.branch<>w.branch OR c.target_id<>'local'`.execute(kdb);
      const remoteMismatchRows = await sql<{ id: string }>`SELECT m.local_session_id AS id FROM remote_session_mappings m JOIN workspace_checkouts c ON c.id=m.workspace_checkout_id JOIN workspaces w ON w.id=c.workspace_id WHERE m.project_id<>w.project_id OR coalesce(m.branch,'')<>w.branch OR m.remote_server_id<>c.target_id`.execute(kdb);
      issues.push(...danglingLocalRows.rows.map(({ id }) => ({ kind: "local" as const, id, reason: "dangling_checkout" as const })));
      issues.push(...danglingRemoteRows.rows.map(({ id }) => ({ kind: "remote" as const, id, reason: "dangling_checkout" as const })));
      issues.push(...localMismatchRows.rows.map(({ id }) => ({ kind: "local" as const, id, reason: "snapshot_mismatch" as const })));
      issues.push(...remoteMismatchRows.rows.map(({ id }) => ({ kind: "remote" as const, id, reason: "snapshot_mismatch" as const })));
      const reasons = emptyBindingReasonCounts();
      for (const issue of issues) reasons[issue.reason]++;
      return {
        unboundLocal: unboundLocalRows.length,
        unboundRemote: unboundRemoteRows.length,
        danglingLocal: danglingLocalRows.rows.length,
        danglingRemote: danglingRemoteRows.rows.length,
        localSnapshotMismatch: localMismatchRows.rows.length,
        remoteSnapshotMismatch: remoteMismatchRows.rows.length,
        conventionalRemoteCheckouts: await scalar(sql`SELECT count(*) AS count FROM workspace_checkouts WHERE target_id<>'local' AND deleted_at IS NULL AND path_source='conventional'`),
        reasons,
        issues,
      };
    },
  },
});
