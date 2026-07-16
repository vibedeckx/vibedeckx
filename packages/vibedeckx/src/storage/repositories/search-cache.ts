import { type Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage } from "../types.js";
import type { DialectHelpers } from "../dialect.js";

export const toDbBranch = (branch: string | null): string => branch ?? "";
export const fromDbBranch = (branch: string): string | null => (branch === "" ? null : branch);

export const createSearchCacheRepos = (
  kdb: Kysely<DB>,
  _h: DialectHelpers,
): Pick<Storage, "searchCache"> => ({
  searchCache: {
    // Generation-based reconciliation: only a FULLY successful snapshot may
    // mark rows deleted. Runs in one transaction so a crash mid-apply can't
    // leave a half-deleted cache.
    applyCatalogSnapshot: async (projectId, targetId, snapshot) => {
      const now = Date.now();
      await kdb.transaction().execute(async (trx) => {
        const state = await trx.selectFrom("search_catalog_sync_state")
          .select("snapshot_generation")
          .where("project_id", "=", projectId)
          .where("target_id", "=", targetId)
          .executeTakeFirst();
        const generation = (state?.snapshot_generation ?? 0) + 1;

        for (const w of snapshot.workspaces) {
          await trx.insertInto("workspace_search_cache")
            .values({ project_id: projectId, target_id: targetId, branch: toDbBranch(w.branch), generation, deleted_at: null })
            .onConflict((oc) => oc.columns(["project_id", "target_id", "branch"])
              .doUpdateSet({ generation, deleted_at: null }))
            .execute();
        }
        for (const s of snapshot.sessions) {
          await trx.insertInto("session_search_cache")
            .values({
              local_session_id: s.id, project_id: projectId, target_id: targetId,
              branch: toDbBranch(s.branch), title: s.title, last_active_at: s.lastActiveAt,
              favorited_at: s.favoritedAt, entry_count: s.entryCount, generation, deleted_at: null,
            })
            .onConflict((oc) => oc.column("local_session_id").doUpdateSet({
              project_id: projectId, target_id: targetId, branch: toDbBranch(s.branch),
              title: s.title, last_active_at: s.lastActiveAt, favorited_at: s.favoritedAt,
              entry_count: s.entryCount, generation, deleted_at: null,
            }))
            .execute();
        }
        await trx.updateTable("workspace_search_cache")
          .set({ deleted_at: now })
          .where("project_id", "=", projectId).where("target_id", "=", targetId)
          .where("generation", "<", generation).where("deleted_at", "is", null)
          .execute();
        await trx.updateTable("session_search_cache")
          .set({ deleted_at: now })
          .where("project_id", "=", projectId).where("target_id", "=", targetId)
          .where("generation", "<", generation).where("deleted_at", "is", null)
          .execute();
        await trx.insertInto("search_catalog_sync_state")
          .values({
            project_id: projectId, target_id: targetId,
            last_success_at: now, last_attempt_at: now,
            snapshot_generation: generation, last_error: null,
          })
          .onConflict((oc) => oc.columns(["project_id", "target_id"]).doUpdateSet({
            last_success_at: now, last_attempt_at: now,
            snapshot_generation: generation, last_error: null,
          }))
          .execute();
      });
    },

    recordSyncFailure: async (projectId, targetId, error) => {
      const now = Date.now();
      await kdb.insertInto("search_catalog_sync_state")
        .values({
          project_id: projectId, target_id: targetId,
          last_success_at: null, last_attempt_at: now,
          snapshot_generation: 0, last_error: error,
        })
        .onConflict((oc) => oc.columns(["project_id", "target_id"])
          .doUpdateSet({ last_attempt_at: now, last_error: error }))
        .execute();
    },

    getSyncStates: async (projectIds) => {
      if (projectIds.length === 0) return [];
      return kdb.selectFrom("search_catalog_sync_state")
        .select(["project_id", "target_id", "last_success_at", "last_attempt_at", "last_error"])
        .where("project_id", "in", projectIds)
        .execute();
    },

    // Opportunistic freshness: called where a title transits the server
    // anyway (remote title PATCH proxy). UPDATE-only — inserting here would
    // fabricate a row outside snapshot generations.
    updateCachedSessionTitle: async (localSessionId, title) => {
      await kdb.updateTable("session_search_cache")
        .set({ title })
        .where("local_session_id", "=", localSessionId)
        .execute();
    },
  },
});
