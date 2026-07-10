import crypto from "crypto";
import type { Kysely, Selectable } from "kysely";
import type { DB, CrossRemoteAuditTable } from "../schema.js";
import type { Storage, CrossRemoteAuditRow, CrossRemoteAuditStatus } from "../types.js";

const mapRow = (row: Selectable<CrossRemoteAuditTable>): CrossRemoteAuditRow => ({
  id: row.id,
  user_id: row.user_id,
  session_id: row.session_id,
  source_remote_id: row.source_remote_id,
  target_remote_id: row.target_remote_id,
  tool_name: row.tool_name,
  args_summary: row.args_summary,
  exit_code: row.exit_code,
  duration_ms: row.duration_ms,
  status: row.status as CrossRemoteAuditStatus,
  created_at: row.created_at,
});

export const createCrossRemoteAuditRepo = (
  kdb: Kysely<DB>,
): Pick<Storage, "crossRemoteAudit"> => ({
  crossRemoteAudit: {
    insert: async (entry) => {
      await kdb
        .insertInto("cross_remote_audit")
        .values({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...entry })
        .execute();
    },

    listByTarget: async (targetRemoteId, limit = 100) => {
      const rows = await kdb
        .selectFrom("cross_remote_audit")
        .selectAll()
        .where("target_remote_id", "=", targetRemoteId)
        .orderBy("seq", "desc")
        .limit(limit)
        .execute();
      return rows.map(mapRow);
    },
  },
});
