import type { Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage } from "../types.js";

/**
 * Where a session's cross-remote gateway calls actually ran, one row per
 * (session, machine). Written by the gateway, read by artifact-read-targets.ts
 * to find which machine's filesystem an absolute path in the conversation
 * belongs to.
 */
export const createSessionRemoteTouchRepo = (
  kdb: Kysely<DB>,
): Pick<Storage, "sessionRemoteTouches"> => ({
  sessionRemoteTouches: {
    record: async (sessionId, userId, remoteServerId) => {
      const now = new Date().toISOString();
      await kdb
        .insertInto("agent_session_remote_touches")
        .values({ session_id: sessionId, remote_server_id: remoteServerId, user_id: userId, last_used_at: now })
        .onConflict((oc) => oc.columns(["session_id", "remote_server_id"]).doUpdateSet({ last_used_at: now }))
        .execute();
    },

    list: async (sessionId, userId, limit = 8) => {
      let query = kdb
        .selectFrom("agent_session_remote_touches")
        .select("remote_server_id")
        .where("session_id", "=", sessionId);
      // Unscoped in solo mode, where there is no tenant to scope to (the same
      // `userId?` convention the rest of the repos use).
      if (userId) query = query.where("user_id", "=", userId);
      const rows = await query
        .orderBy("last_used_at", "desc")
        .orderBy("remote_server_id", "asc")
        .limit(limit)
        .execute();
      return rows.map((row) => row.remote_server_id);
    },
  },
});
