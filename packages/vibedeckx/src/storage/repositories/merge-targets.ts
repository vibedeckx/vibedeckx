import type { Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage } from "../types.js";

export const createMergeTargetsRepo = (
  kdb: Kysely<DB>,
): Pick<Storage, "mergeTargets"> => ({
  mergeTargets: {
    getForBranches: async (projectId, branches) => {
      if (branches.length === 0) return new Map();

      const rows = await kdb
        .selectFrom("branch_merge_targets")
        .select(["branch", "target"])
        .where("project_id", "=", projectId)
        .where("branch", "in", branches)
        .execute();

      return new Map(rows.map((row) => [row.branch, row.target]));
    },

    upsert: async (projectId, branch, target) => {
      await kdb
        .insertInto("branch_merge_targets")
        .values({ project_id: projectId, branch, target })
        .onConflict((conflict) =>
          conflict.columns(["project_id", "branch"]).doUpdateSet({
            target,
            updated_at: new Date().toISOString(),
          }),
        )
        .execute();
    },

    insertIfAbsent: async (projectId, branch, target) => {
      const result = await kdb
        .insertInto("branch_merge_targets")
        .values({ project_id: projectId, branch, target })
        .onConflict((conflict) => conflict.columns(["project_id", "branch"]).doNothing())
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    delete: async (projectId, branch) => {
      const result = await kdb
        .deleteFrom("branch_merge_targets")
        .where("project_id", "=", projectId)
        .where("branch", "=", branch)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },
  },
});
