import type { Kysely } from "kysely";
import type { DB } from "../schema.js";

/**
 * Per-session rows that cannot hang off a foreign key: they key both local
 * sessions (`agent_sessions.id`) and remote ones (`remote_session_mappings.
 * local_session_id`), so there is no single parent for ON DELETE CASCADE.
 *
 * Every path that deletes a session — local or remote, by id, by retention,
 * by tombstone GC, or by deleting the project — must call this in the same
 * transaction. It is done here rather than with database triggers so the
 * rule stays in portable Kysely (a Postgres port rewrites none of it) and is
 * visible at each delete site. session-side-rows.test.ts drives every path.
 */
export async function deleteSessionSideRows(trx: Kysely<DB>, sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const ids = [...sessionIds];
  await trx.deleteFrom("agent_session_remote_grants").where("session_id", "in", ids).execute();
  await trx.deleteFrom("agent_session_remote_touches").where("session_id", "in", ids).execute();
  await trx.deleteFrom("agent_session_retention_holds").where("session_id", "in", ids).execute();
}
