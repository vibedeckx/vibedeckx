import { sql, type Kysely, type Selectable } from "kysely";
import type { DB, NotificationOutboxTable, NotificationsTable } from "../schema.js";
import type {
  Notification,
  NotificationKind,
  NotificationOutboxEvent,
  Storage,
} from "../types.js";

const mapOutbox = (row: Selectable<NotificationOutboxTable>): NotificationOutboxEvent => ({
  seq: row.seq,
  id: row.id,
  kind: row.kind as NotificationKind,
  project_id: row.project_id,
  branch: row.branch,
  session_id: row.session_id,
  workflow_run_id: row.workflow_run_id,
  created_at: row.created_at,
});

const mapNotification = (row: Selectable<NotificationsTable>): Notification => ({
  id: row.id,
  user_id: row.user_id,
  kind: row.kind as NotificationKind,
  project_id: row.project_id,
  branch: row.branch,
  session_id: row.session_id,
  workflow_run_id: row.workflow_run_id,
  title: row.title,
  body: row.body,
  created_at: row.created_at,
  read_at: row.read_at,
});

export const createNotificationRepos = (
  kdb: Kysely<DB>,
): Pick<Storage, "notificationOutbox" | "notifications" | "notificationSyncCursors"> => ({
  notificationOutbox: {
    // ON CONFLICT(id) DO NOTHING is what makes retrying the *business*
    // transition safe: the milestone id is derived from durable state
    // (session + turn_end index, or workflow run id), so a retried transaction
    // re-derives the same id and the second insert is a no-op rather than a
    // second ding. `inserted: false` still returns the existing seq so callers
    // that want to trigger a drain can do so either way.
    insert: async (event) => {
      const result = await kdb.insertInto("notification_outbox")
        .values(event)
        .onConflict((oc) => oc.column("id").doNothing())
        .executeTakeFirst();
      const inserted = (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
      const row = await kdb.selectFrom("notification_outbox")
        .select("seq")
        .where("id", "=", event.id)
        .executeTakeFirst();
      return { inserted, seq: row?.seq ?? null };
    },

    listAfter: async (afterSeq, limit) => {
      const rows = await kdb.selectFrom("notification_outbox").selectAll()
        .where("seq", ">", afterSeq)
        .orderBy("seq", "asc")
        .limit(limit)
        .execute();
      return rows.map(mapOutbox);
    },

    listBySessionAfter: async (sessionId, afterSeq, limit) => {
      const rows = await kdb.selectFrom("notification_outbox").selectAll()
        .where("session_id", "=", sessionId)
        .where("seq", ">", afterSeq)
        .orderBy("seq", "asc")
        .limit(limit)
        .execute();
      return rows.map(mapOutbox);
    },

    headBySession: async (sessionId) => {
      const row = await kdb.selectFrom("notification_outbox")
        .select(kdb.fn.max<number | null>("seq").as("head"))
        .where("session_id", "=", sessionId)
        .executeTakeFirst();
      return row?.head ?? 0;
    },

    head: async () => {
      const row = await kdb.selectFrom("notification_outbox")
        .select(kdb.fn.max<number | null>("seq").as("head"))
        .executeTakeFirst();
      return row?.head ?? 0;
    },

    pruneOlderThan: async (cutoffMs) => {
      await kdb.deleteFrom("notification_outbox").where("created_at", "<", cutoffMs).execute();
    },
  },

  notifications: {
    insert: async (notification) => {
      const result = await kdb.insertInto("notifications")
        .values(notification)
        .onConflict((oc) => oc.column("id").doNothing())
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    // One transaction on purpose. Insert-then-crash-then-replay is safe (the id
    // unique constraint absorbs it), but cursor-advance-then-crash would lose
    // the notification permanently — so the two writes must commit together.
    importRemote: async ({ notification, remoteServerId, remoteSessionId, seq }) => {
      return kdb.transaction().execute(async (trx) => {
        const result = await trx.insertInto("notifications")
          .values(notification)
          .onConflict((oc) => oc.column("id").doNothing())
          .executeTakeFirst();

        await trx.insertInto("notification_sync_cursors")
          .values({
            remote_server_id: remoteServerId,
            remote_session_id: remoteSessionId,
            last_seq: seq,
            updated_at: Date.now(),
          })
          .onConflict((oc) => oc.columns(["remote_server_id", "remote_session_id"]).doUpdateSet({
            // MAX(existing, incoming) — pages can be retried out of order after
            // a transient remote error, and a cursor that moved backward would
            // re-import (and re-ding) everything after it.
            last_seq: sql<number>`MAX(notification_sync_cursors.last_seq, excluded.last_seq)`,
            updated_at: Date.now(),
          }))
          .execute();

        return { inserted: (result.numInsertedOrUpdatedRows ?? 0n) > 0n };
      });
    },

    listForUser: async (userId, opts) => {
      let query = kdb.selectFrom("notifications").selectAll().where("user_id", "=", userId);
      if (opts.unreadOnly) query = query.where("read_at", "is", null);
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(opts.limit)
        .execute();
      return rows.map(mapNotification);
    },

    // The user_id predicate is load-bearing authorization, not a filter: a
    // caller must not be able to mutate — or learn the existence of — another
    // tenant's notification by guessing its (deterministic, guessable) id.
    markRead: async (id, userId) => {
      const result = await kdb.updateTable("notifications")
        .set({ read_at: Date.now() })
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .where("read_at", "is", null)
        .executeTakeFirst();
      if ((result.numUpdatedRows ?? 0n) > 0n) return true;
      // Already-read rows are idempotent successes, not 404s.
      const existing = await kdb.selectFrom("notifications")
        .select("id")
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return existing !== undefined;
    },

    markAllRead: async (userId) => {
      await kdb.updateTable("notifications")
        .set({ read_at: Date.now() })
        .where("user_id", "=", userId)
        .where("read_at", "is", null)
        .execute();
    },

    // Unread rows are never deleted — an unread milestone is the whole point of
    // the feature. Read history is capped per user so it can't grow forever.
    cleanup: async (keepRead) => {
      const users = await kdb.selectFrom("notifications")
        .select("user_id")
        .where("read_at", "is not", null)
        .groupBy("user_id")
        .execute();
      for (const { user_id } of users) {
        const keep = await kdb.selectFrom("notifications")
          .select("id")
          .where("user_id", "=", user_id)
          .where("read_at", "is not", null)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(keepRead)
          .execute();
        let query = kdb.deleteFrom("notifications")
          .where("user_id", "=", user_id)
          .where("read_at", "is not", null);
        if (keep.length > 0) {
          query = query.where("id", "not in", keep.map((r) => r.id));
        }
        await query.execute();
      }
    },
  },

  notificationSyncCursors: {
    get: async (remoteServerId, remoteSessionId) => {
      const row = await kdb.selectFrom("notification_sync_cursors")
        .select("last_seq")
        .where("remote_server_id", "=", remoteServerId)
        .where("remote_session_id", "=", remoteSessionId)
        .executeTakeFirst();
      return row?.last_seq;
    },

    getMany: async (remoteServerId, remoteSessionIds) => {
      if (remoteSessionIds.length === 0) return new Map();
      const rows = await kdb.selectFrom("notification_sync_cursors")
        .select(["remote_session_id", "last_seq"])
        .where("remote_server_id", "=", remoteServerId)
        .where("remote_session_id", "in", remoteSessionIds)
        .execute();
      return new Map(rows.map((r) => [r.remote_session_id, r.last_seq]));
    },

    set: async (remoteServerId, remoteSessionId, lastSeq) => {
      await kdb.insertInto("notification_sync_cursors")
        .values({
          remote_server_id: remoteServerId,
          remote_session_id: remoteSessionId,
          last_seq: lastSeq,
          updated_at: Date.now(),
        })
        .onConflict((oc) => oc.columns(["remote_server_id", "remote_session_id"]).doUpdateSet({
          last_seq: sql<number>`MAX(notification_sync_cursors.last_seq, excluded.last_seq)`,
          updated_at: Date.now(),
        }))
        .execute();
    },
  },
});
