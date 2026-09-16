import type { Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage } from "../types.js";

/**
 * Session-scoped cross-remote allowlist (docs/cross-remote-session-grants-design.md §4).
 *
 * Reads are unscoped by user on purpose: the gateway has already resolved the
 * session from a signed token, and the machine tier check downstream is what
 * enforces tenancy. `user_id` is recorded for audit and for the route-level
 * scoping of writes.
 */
export const createSessionRemoteGrantRepo = (
  kdb: Kysely<DB>,
): Pick<Storage, "sessionRemoteGrants"> => ({
  sessionRemoteGrants: {
    list: async (sessionId) => {
      const rows = await kdb
        .selectFrom("agent_session_remote_grants")
        .select("remote_server_id")
        .where("session_id", "=", sessionId)
        .orderBy("granted_at", "asc")
        .orderBy("remote_server_id", "asc")
        .execute();
      return rows.map((row) => row.remote_server_id);
    },

    replace: async (sessionId, userId, remoteServerIds) => {
      const unique = [...new Set(remoteServerIds)];
      const grantedAt = new Date().toISOString();
      await kdb.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("agent_session_remote_grants")
          .where("session_id", "=", sessionId)
          .execute();
        if (unique.length === 0) return;
        await trx
          .insertInto("agent_session_remote_grants")
          .values(unique.map((remoteServerId) => ({
            session_id: sessionId,
            remote_server_id: remoteServerId,
            user_id: userId,
            granted_at: grantedAt,
          })))
          .execute();
      });
    },

    deleteBySession: async (sessionId) => {
      await kdb
        .deleteFrom("agent_session_remote_grants")
        .where("session_id", "=", sessionId)
        .execute();
    },
  },
});
