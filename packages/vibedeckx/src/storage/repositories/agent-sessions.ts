import { sql, type Kysely, type Selectable } from "kysely";
import type { DB, AgentSessionsTable, RemoteSessionMappingsTable } from "../schema.js";
import { fromDbBool, type DialectHelpers } from "../dialect.js";
import type {
  Storage,
  AgentSession,
  AgentSessionStatus,
  NotificationSyncStart,
  RemoteSessionMapping,
} from "../types.js";
// NotificationOutboxEvent is referenced only through Storage's method
// signatures, which this factory's return type already pins.

const mapRemoteSessionMapping = (
  row: Selectable<RemoteSessionMappingsTable>,
): RemoteSessionMapping => ({
  local_session_id: row.local_session_id,
  project_id: row.project_id,
  remote_server_id: row.remote_server_id,
  remote_session_id: row.remote_session_id,
  branch: row.branch,
  notification_sync_start: row.notification_sync_start as NotificationSyncStart,
  notification_watch_until: row.notification_watch_until,
});

const mapAgentSession = (row: Selectable<AgentSessionsTable>): AgentSession => ({
  id: row.id,
  project_id: row.project_id,
  branch: row.branch,
  status: row.status as AgentSessionStatus,
  // permission_mode/agent_type are nullable columns but always populated
  // with a default by create() below; ?? undefined only matters for a
  // hand-edited/legacy NULL row and mirrors mapProject's optional-string
  // handling (core.ts).
  permission_mode: row.permission_mode ?? undefined,
  agent_type: row.agent_type ?? undefined,
  title: row.title,
  created_at: row.created_at,
  updated_at: row.updated_at,
  last_user_message_at: row.last_user_message_at,
  last_completed_at: row.last_completed_at,
  favorited_at: row.favorited_at,
});

export const createAgentSessionRepos = (
  kdb: Kysely<DB>,
  h: DialectHelpers,
): Pick<Storage, "agentSessions" | "remoteSessionMappings"> => ({
  agentSessions: {
    // Millisecond-precision timestamps (h.nowMs()) are set explicitly here
    // (and in the UPDATE statements below) so existing databases whose
    // DEFAULTs still resolve to CURRENT_TIMESTAMP also get sub-second
    // writes — this is what lets getLatestByBranch break ties
    // deterministically (see the schema.ts / sqlite.ts DDL comment on
    // agent_sessions).
    create: async ({ id, project_id, branch, permission_mode, agent_type }) => {
      await kdb.insertInto("agent_sessions").values({
        id,
        project_id,
        branch,
        status: "running",
        permission_mode: permission_mode ?? "edit",
        agent_type: agent_type ?? "claude-code",
        created_at: h.nowMs(),
        updated_at: h.nowMs(),
      }).execute();
      const row = await kdb.selectFrom("agent_sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapAgentSession(row);
    },

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

    getByBranch: async (projectId, branch) => {
      const row = await kdb.selectFrom("agent_sessions").selectAll()
        .where("project_id", "=", projectId)
        .where("branch", "=", branch)
        .orderBy("updated_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return row ? mapAgentSession(row) : undefined;
    },

    listByBranch: async (projectId, branch) => {
      const rows = await kdb.selectFrom("agent_sessions").selectAll()
        .where("project_id", "=", projectId)
        .where("branch", "=", branch)
        .orderBy("updated_at", "desc")
        .orderBy("created_at", "desc")
        .execute();
      return rows.map(mapAgentSession);
    },

    getLatestByBranch: async (projectId, branch) => {
      const row = await kdb.selectFrom("agent_sessions").selectAll()
        .where("project_id", "=", projectId)
        .where("branch", "=", branch)
        .orderBy("updated_at", "desc")
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return row ? mapAgentSession(row) : undefined;
    },

    updateStatus: async (id, status) => {
      await kdb.updateTable("agent_sessions")
        .set({ status, updated_at: h.nowMs() })
        .where("id", "=", id)
        .execute();
    },

    updateStatusPreservingTimestamp: async (id, status) => {
      await kdb.updateTable("agent_sessions").set({ status }).where("id", "=", id).execute();
    },

    updatePermissionMode: async (id, mode) => {
      await kdb.updateTable("agent_sessions")
        .set({ permission_mode: mode, updated_at: h.nowMs() })
        .where("id", "=", id)
        .execute();
    },

    updateAgentType: async (id, agent_type) => {
      await kdb.updateTable("agent_sessions")
        .set({ agent_type, updated_at: h.nowMs() })
        .where("id", "=", id)
        .execute();
    },

    updateTitle: async (id, title) => {
      await kdb.updateTable("agent_sessions")
        .set({ title, updated_at: h.nowMs() })
        .where("id", "=", id)
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
      await kdb.updateTable("agent_sessions").set({ updated_at: h.nowMs() }).where("id", "=", id).execute();
    },

    markUserMessage: async (id, timestampMs) => {
      await kdb.updateTable("agent_sessions").set({ last_user_message_at: timestampMs }).where("id", "=", id).execute();
    },

    markCompleted: async (id, timestampMs) => {
      await kdb.updateTable("agent_sessions").set({ last_completed_at: timestampMs }).where("id", "=", id).execute();
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

    getAll: async () => {
      const rows = await kdb.selectFrom("remote_session_mappings").selectAll().execute();
      return rows.map(mapRemoteSessionMapping);
    },

    getByLocal: async (localSessionId) => {
      const row = await kdb.selectFrom("remote_session_mappings").selectAll()
        .where("local_session_id", "=", localSessionId)
        .executeTakeFirst();
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

    getNotificationSyncCandidates: async ({ now, includeExpired }) => {
      let query = kdb.selectFrom("remote_session_mappings").selectAll();
      if (!includeExpired) {
        query = query.where("notification_watch_until", ">", now);
      }
      const rows = await query.orderBy("local_session_id", "asc").execute();
      return rows.map(mapRemoteSessionMapping);
    },

    // The cursor is deleted with the mapping: without a mapping the front has
    // no local target for the worker's events, so a stale cursor would only
    // suppress a legitimate re-mapping's from_start replay.
    delete: async (localSessionId) => {
      await kdb.transaction().execute(async (trx) => {
        const row = await trx.selectFrom("remote_session_mappings")
          .select(["remote_server_id", "remote_session_id"])
          .where("local_session_id", "=", localSessionId)
          .executeTakeFirst();
        await trx.deleteFrom("remote_session_mappings").where("local_session_id", "=", localSessionId).execute();
        if (row) {
          await trx.deleteFrom("notification_sync_cursors")
            .where("remote_server_id", "=", row.remote_server_id)
            .where("remote_session_id", "=", row.remote_session_id)
            .execute();
        }
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
});
