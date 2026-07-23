import type { Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage } from "../types.js";

export const createTurnSnapshotRepos = (kdb: Kysely<DB>): Pick<Storage, "turnSnapshots"> => ({
  turnSnapshots: {
    create: async (opts) => {
      await kdb
        .insertInto("turn_snapshots")
        .values({
          session_id: opts.session_id,
          turn_end_index: opts.turn_end_index,
          head: opts.head,
          dirty: JSON.stringify(opts.dirty),
          captured_at: Date.now(),
        })
        .onConflict((oc) => oc.columns(["session_id", "turn_end_index"]).doNothing())
        .execute();
    },
    getStartBoundary: async (session_id, turnEndIndex) => {
      const row = await kdb
        .selectFrom("turn_snapshots")
        .select(["head", "dirty"])
        .where("session_id", "=", session_id)
        .where("turn_end_index", "<", turnEndIndex)
        .orderBy("turn_end_index", "desc")
        .limit(1)
        .executeTakeFirst();
      if (!row) return undefined;
      return { head: row.head, dirty: JSON.parse(row.dirty) as Record<string, string> };
    },
  },
});
