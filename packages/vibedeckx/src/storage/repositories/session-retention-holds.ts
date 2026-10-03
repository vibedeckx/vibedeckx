import type { Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { RetentionHold, Storage } from "../types.js";

/**
 * Retention holds of the sessions this machine owns
 * (agent_session_retention_holds). The retention predicate reads the table
 * directly; this repo is only the write side the hub's sync drives.
 */
export const createSessionRetentionHoldRepo = (
  kdb: Kysely<DB>,
): Pick<Storage, "sessionRetentionHolds"> => ({
  sessionRetentionHolds: {
    list: async (sessionId) => {
      const rows = await kdb
        .selectFrom("agent_session_retention_holds")
        .select(["holder_kind", "holder_id"])
        .where("session_id", "=", sessionId)
        .orderBy("holder_kind", "asc")
        .orderBy("holder_id", "asc")
        .execute();
      return rows.map((row) => ({ kind: row.holder_kind, id: row.holder_id }));
    },

    listSessionIds: async () => {
      const rows = await kdb
        .selectFrom("agent_session_retention_holds")
        .select("session_id")
        .distinct()
        .orderBy("session_id", "asc")
        .execute();
      return rows.map((row) => row.session_id);
    },

    replace: async (sessionId, holds) => {
      const unique = new Map<string, RetentionHold>();
      for (const hold of holds) unique.set(`${hold.kind}\u0000${hold.id}`, hold);
      const createdAt = new Date().toISOString();
      await kdb.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("agent_session_retention_holds")
          .where("session_id", "=", sessionId)
          .execute();
        if (unique.size > 0) {
          await trx
            .insertInto("agent_session_retention_holds")
            .values([...unique.values()].map((hold) => ({
              session_id: sessionId,
              holder_kind: hold.kind,
              holder_id: hold.id,
              created_at: createdAt,
            })))
            .execute();
        }
      });
    },
  },
});
