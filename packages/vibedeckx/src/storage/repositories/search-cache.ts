import { sql, type Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { AgentSessionActivity, AgentSessionActivityStatus, Storage, SearchResultProjectRow, SearchResultSessionRow, SearchResultWorkspaceRow } from "../types.js";
import type { DialectHelpers } from "../dialect.js";
import { recordWorkspaceBindingRead, type WorkspaceBindingReadConsumer } from "../../workspace-binding-metrics.js";

export const toDbBranch = (branch: string | null): string => branch ?? "";
export const fromDbBranch = (branch: string): string | null => (branch === "" ? null : branch);

// Escapes LIKE metacharacters so user-typed '%'/'_' are matched literally
// rather than acting as wildcards; paired with `escape '\'` at call sites.
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// 0 exact, 1 prefix, 2 substring, 3 no match. `q` is expected pre-lowercased.
const matchTier = (text: string | null | undefined, q: string): number => {
  if (!q) return 2;
  if (!text) return 3;
  const t = text.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  return 3;
};

// agent_sessions.updated_at is stored as 'YYYY-MM-DD HH:MM:SS.SSS' (UTC, see
// dialect.ts nowMs()) — used as a recency fallback when a local session has
// no last_user_message_at yet.
const parseDbTimestamp = (ts: string | null | undefined): number | null => {
  if (!ts) return null;
  const ms = Date.parse(ts.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : ms;
};

interface RankInput<T> {
  item: T;
  tier: number;
  favorited: boolean;
  recency: number;
}

// Shared tiered ranking: tier asc, then favorited desc, then recency desc.
// Candidate sets here are already bounded (per-user project/branch counts,
// or a 200-row SQL prefilter for sessions), so ranking in JS is cheap and
// keeps the SQL portable across backends.
const rankAndCap = <T>(items: Array<RankInput<T>>, limit: number): T[] =>
  items
    .filter((x) => x.tier < 3)
    .sort((a, b) => a.tier - b.tier
      || Number(b.favorited) - Number(a.favorited)
      || b.recency - a.recency)
    .slice(0, limit)
    .map((x) => x.item);

interface SessionCandidate {
  sessionId: string;
  projectId: string;
  projectName: string;
  targetId: string;
  branch: string | null;
  title: string | null;
  lastActiveAt: number | null;
  favoritedAt: number | null;
}

const activityStatus = (status: string): AgentSessionActivityStatus =>
  status === "running" || status === "stopped" || status === "error" ? status : "unknown";

const mapRemoteActivity = (row: {
  local_session_id: string; project_id: string; target_id: string; branch: string;
  snapshot_project_id: string; snapshot_target_id: string; snapshot_branch: string | null;
  worktree_path: string | null; checkout_deleted_at: string | null;
  checkout_status: string | null;
  workspace_checkout_id: string | null;
  title: string | null; last_active_at: number | null; status: string;
  agent_type: string | null; model: string | null; last_user_message_at: number | null;
  last_completed_at: number | null; favorited_at: number | null;
}): AgentSessionActivity => {
  const branch = fromDbBranch(row.branch);
  return {
    id: row.local_session_id,
    projectId: row.project_id,
    branch,
    status: activityStatus(row.status),
    title: row.title,
    target: row.target_id,
    workspace: { target: row.target_id, branch },
    worktreePath: row.worktree_path,
    checkoutDeletedAt: row.checkout_deleted_at,
    checkoutStatus: row.checkout_status as AgentSessionActivity["checkoutStatus"],
    binding: row.workspace_checkout_id === null ? "legacy" : "checkout",
    agentType: row.agent_type,
    model: row.model,
    lastActiveAt: row.last_active_at,
    lastUserMessageAt: row.last_user_message_at,
    lastCompletedAt: row.last_completed_at,
    favoritedAt: row.favorited_at,
  };
};

const observeRemoteActivity = (consumer: WorkspaceBindingReadConsumer | undefined, row: {
  workspace_checkout_id: string | null;
  snapshot_project_id: string;
  snapshot_target_id: string;
  snapshot_branch: string | null;
  project_id: string;
  target_id: string;
  branch: string;
}) => {
  if (!consumer) return;
  if (row.workspace_checkout_id === null) {
    recordWorkspaceBindingRead(consumer, "legacy-fallback");
  } else if (row.snapshot_project_id !== row.project_id
    || row.snapshot_target_id !== row.target_id
    || (row.snapshot_branch ?? "") !== row.branch) {
    recordWorkspaceBindingRead(consumer, "mismatch");
  } else {
    recordWorkspaceBindingRead(consumer, "checkout-hit");
  }
};

const observeDanglingRemoteActivity = async (
  kdb: Kysely<DB>,
  consumer: WorkspaceBindingReadConsumer | undefined,
  projectId: string,
) => {
  if (!consumer) return;
  const row = await kdb.selectFrom("session_search_cache as c")
    .innerJoin("remote_session_mappings as mapping", "mapping.local_session_id", "c.local_session_id")
    .leftJoin("workspace_checkouts as checkout", "checkout.id", "mapping.workspace_checkout_id")
    .select(kdb.fn.countAll<number>().as("count"))
    .where("mapping.workspace_checkout_id", "is not", null)
    .where("checkout.id", "is", null)
    .where("mapping.project_id", "=", projectId)
    .where("c.deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  recordWorkspaceBindingRead(consumer, "dangling", Number(row.count));
};

const observeLocalSearchRow = (row: {
  workspace_checkout_id: string | null;
  snapshot_project_id: string;
  snapshot_branch: string;
  project_id: string;
  branch: string;
  target_id: string;
}) => {
  if (row.workspace_checkout_id === null) {
    recordWorkspaceBindingRead("search", "legacy-fallback");
  } else if (row.snapshot_project_id !== row.project_id
    || row.snapshot_branch !== row.branch
    || row.target_id !== "local") {
    recordWorkspaceBindingRead("search", "mismatch");
  } else {
    recordWorkspaceBindingRead("search", "checkout-hit");
  }
};

const remoteSessionScope = (kdb: Kysely<DB>, projectId: string) => kdb
  .selectFrom("session_search_cache as c")
  .innerJoin("remote_session_mappings as mapping", "mapping.local_session_id", "c.local_session_id")
  .leftJoin("workspace_checkouts as checkout", "checkout.id", "mapping.workspace_checkout_id")
  .leftJoin("workspaces as workspace", "workspace.id", "checkout.workspace_id")
  .innerJoin("project_remotes as association", (join) => join.on((eb) => eb.or([
    eb.and([
      eb("mapping.workspace_checkout_id", "is", null),
      eb("association.project_id", "=", eb.ref("mapping.project_id")),
      eb("association.remote_server_id", "=", eb.ref("mapping.remote_server_id")),
    ]),
    eb.and([
      eb("mapping.workspace_checkout_id", "is not", null),
      eb("association.project_id", "=", eb.ref("workspace.project_id")),
      eb("association.remote_server_id", "=", eb.ref("checkout.target_id")),
    ]),
  ])))
  .where((eb) => eb.or([
    eb.and([
      eb("mapping.workspace_checkout_id", "is", null),
      eb("mapping.project_id", "=", projectId),
      eb("mapping.remote_server_id", "!=", "local"),
      // Legacy fallback is valid only if the cache and mapping snapshots agree.
      eb("c.project_id", "=", eb.ref("mapping.project_id")),
      eb("c.target_id", "=", eb.ref("mapping.remote_server_id")),
    ]),
    eb.and([
      eb("mapping.workspace_checkout_id", "is not", null),
      eb("checkout.id", "is not", null),
      eb("workspace.id", "is not", null),
      eb("workspace.project_id", "=", projectId),
      eb("checkout.target_id", "!=", "local"),
    ]),
  ]))
  .where("c.deleted_at", "is", null);

const remoteActivityBase = (kdb: Kysely<DB>, projectId: string) => remoteSessionScope(kdb, projectId)
  .select([
    "c.local_session_id", "mapping.workspace_checkout_id", "c.title",
    "mapping.project_id as snapshot_project_id", "mapping.remote_server_id as snapshot_target_id",
    "mapping.branch as snapshot_branch",
    "c.last_active_at", "c.status", "c.agent_type", "c.model",
    "c.last_user_message_at", "c.last_completed_at", "c.favorited_at",
    "checkout.worktree_path", "checkout.deleted_at as checkout_deleted_at", "checkout.status as checkout_status",
    sql<string>`case when mapping.workspace_checkout_id is null then mapping.project_id else workspace.project_id end`.as("project_id"),
    sql<string>`case when mapping.workspace_checkout_id is null then mapping.remote_server_id else checkout.target_id end`.as("target_id"),
    sql<string>`case when mapping.workspace_checkout_id is null then coalesce(mapping.branch, '') else workspace.branch end`.as("branch"),
  ]);

export const createSearchCacheRepos = (
  kdb: Kysely<DB>,
  _h: DialectHelpers,
): Pick<Storage, "searchCache"> => ({
  searchCache: {
    listWorkspacesByProject: async (projectId, limit) => {
      const rows = await kdb.selectFrom("workspace_search_cache")
        .select(["target_id", "branch"])
        .where("project_id", "=", projectId)
        .where("deleted_at", "is", null)
        .orderBy("target_id", "asc")
        .orderBy("branch", "asc")
        .limit(limit)
        .execute();
      return rows.map((row) => ({ targetId: row.target_id, branch: fromDbBranch(row.branch) }));
    },

    listRemoteSessionActivityByProject: async (projectId, limit, consumer) => {
      const rows = await remoteActivityBase(kdb, projectId)
        .orderBy("c.last_active_at", "desc")
        .orderBy("c.local_session_id", "asc")
        .limit(limit)
        .execute();
      rows.forEach((row) => observeRemoteActivity(consumer, row));
      await observeDanglingRemoteActivity(kdb, consumer, projectId);
      return rows.map(mapRemoteActivity);
    },

    listRemoteSessionAttentionByProject: async (projectId, limit, consumer) => {
      const rows = await remoteActivityBase(kdb, projectId)
        .where((eb) => eb.or([
          eb("c.status", "=", "error"),
          eb.and([
            eb("c.status", "=", "stopped"),
            eb("c.last_user_message_at", "is not", null),
            eb.or([
              eb("c.last_completed_at", "is", null),
              eb("c.last_completed_at", "<", eb.ref("c.last_user_message_at")),
            ]),
          ]),
        ]))
        .orderBy("c.last_active_at", "desc")
        .orderBy("c.local_session_id", "asc")
        .limit(limit)
        .execute();
      rows.forEach((row) => observeRemoteActivity(consumer, row));
      await observeDanglingRemoteActivity(kdb, consumer, projectId);
      return rows.map(mapRemoteActivity);
    },

    listRemoteSessionFavoritesByProject: async (projectId, limit, consumer) => {
      const rows = await remoteActivityBase(kdb, projectId)
        .where("c.favorited_at", "is not", null)
        .orderBy("c.favorited_at", "desc")
        .orderBy("c.local_session_id", "asc")
        .limit(limit)
        .execute();
      rows.forEach((row) => observeRemoteActivity(consumer, row));
      await observeDanglingRemoteActivity(kdb, consumer, projectId);
      return rows.map(mapRemoteActivity);
    },

    countRemoteSessionActivityByProject: async (projectId) => {
      const row = await remoteSessionScope(kdb, projectId)
        .select([
          sql<number>`coalesce(sum(case when c.status = 'running' then 1 else 0 end), 0)`.as("running"),
        ])
        .executeTakeFirstOrThrow();
      return { running: Number(row.running) };
    },

    countRunningRemoteSessions: async () => {
      // Same validity joins as remoteSessionScope (mapping + association must
      // still exist), minus the per-project filter: this is the fleet total.
      const row = await kdb
        .selectFrom("session_search_cache as c")
        .innerJoin("remote_session_mappings as mapping", (join) => join
          .onRef("mapping.local_session_id", "=", "c.local_session_id")
          .onRef("mapping.project_id", "=", "c.project_id")
          .onRef("mapping.remote_server_id", "=", "c.target_id"))
        .innerJoin("project_remotes as association", (join) => join
          .onRef("association.project_id", "=", "c.project_id")
          .onRef("association.remote_server_id", "=", "c.target_id"))
        .where("c.target_id", "!=", "local")
        .where("c.deleted_at", "is", null)
        .where("c.status", "=", "running")
        .select([sql<number>`count(*)`.as("n")])
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },

    updateRemoteSessionActivity: async (entry) => {
      return kdb.transaction().execute(async (trx) => {
        const authorized = await trx.selectFrom("remote_session_mappings as mapping")
          .innerJoin("project_remotes as association", (join) => join
            .onRef("association.project_id", "=", "mapping.project_id")
            .onRef("association.remote_server_id", "=", "mapping.remote_server_id"))
          .select("mapping.branch")
          .where("mapping.local_session_id", "=", entry.localSessionId)
          .where("mapping.project_id", "=", entry.projectId)
          .where("mapping.remote_server_id", "=", entry.targetId)
          .where("mapping.remote_session_id", "=", entry.remoteSessionId)
          .executeTakeFirst();
        if (!authorized) return false;

        const existing = await trx.selectFrom("session_search_cache")
          .select(["project_id", "target_id"])
          .where("local_session_id", "=", entry.localSessionId)
          .executeTakeFirst();
        if (existing && (existing.project_id !== entry.projectId || existing.target_id !== entry.targetId)) {
          return false;
        }

        const sets: Record<string, unknown> = {
          status: entry.status,
          last_active_at: sql`max(coalesce(last_active_at, 0), ${entry.activityAt})`,
          deleted_at: null,
          written_at: entry.activityAt,
        };
        if (entry.lastUserMessageAt !== undefined) {
          sets.last_user_message_at = sql`max(coalesce(last_user_message_at, 0), ${entry.lastUserMessageAt})`;
        }
        if (entry.lastCompletedAt !== undefined) {
          sets.last_completed_at = sql`max(coalesce(last_completed_at, 0), ${entry.lastCompletedAt})`;
        }
        const result = await trx.insertInto("session_search_cache")
          .values({
            local_session_id: entry.localSessionId,
            project_id: entry.projectId,
            target_id: entry.targetId,
            branch: toDbBranch(authorized.branch),
            title: null,
            last_active_at: entry.activityAt,
            favorited_at: null,
            entry_count: 0,
            status: entry.status,
            agent_type: null,
            model: null,
            last_user_message_at: entry.lastUserMessageAt ?? null,
            last_completed_at: entry.lastCompletedAt ?? null,
            generation: 0,
            deleted_at: null,
            written_at: entry.activityAt,
          })
          .onConflict((conflict) => conflict.column("local_session_id").doUpdateSet(sets)
            .where("session_search_cache.project_id", "=", entry.projectId)
            .where("session_search_cache.target_id", "=", entry.targetId)
            .where((eb) => eb.or([
              eb("session_search_cache.written_at", "is", null),
              eb("session_search_cache.written_at", "<", entry.activityAt),
              eb.and([
                eb("session_search_cache.written_at", "=", entry.activityAt),
                ...(entry.status === "running"
                  ? [eb("session_search_cache.status", "not in", ["stopped", "error"])]
                  : []),
              ]),
            ])))
          .executeTakeFirst();
        return (result.numInsertedOrUpdatedRows ?? 0n) > 0n ? true : "stale";
      });
    },

    listUnknownRemoteActivityTargets: async (userId, limit = 100) => {
      let query = kdb.selectFrom("session_search_cache as c")
        .innerJoin("remote_session_mappings as mapping", (join) => join
          .onRef("mapping.local_session_id", "=", "c.local_session_id")
          .onRef("mapping.project_id", "=", "c.project_id")
          .onRef("mapping.remote_server_id", "=", "c.target_id"))
        .innerJoin("project_remotes as association", (join) => join
          .onRef("association.project_id", "=", "c.project_id")
          .onRef("association.remote_server_id", "=", "c.target_id"))
        .innerJoin("projects as project", "project.id", "c.project_id")
        .leftJoin("search_catalog_sync_state as sync", (join) => join
          .onRef("sync.project_id", "=", "c.project_id")
          .onRef("sync.target_id", "=", "c.target_id"))
        .select([
          "c.project_id as projectId",
          "c.target_id as targetId",
          "association.remote_path as remotePath",
        ])
        .where("c.target_id", "!=", "local")
        .where("c.deleted_at", "is", null)
        .where("c.status", "=", "unknown")
        .groupBy(["c.project_id", "c.target_id", "association.remote_path", "sync.last_attempt_at"])
        // Fair retry: a legacy worker that cannot yet return activity fields
        // must not occupy the first page forever and starve later targets.
        .orderBy(sql`coalesce(sync.last_attempt_at, 0)`, "asc")
        .orderBy("c.project_id", "asc")
        .orderBy("c.target_id", "asc")
        .limit(Math.max(1, Math.min(limit, 100)));
      if (userId) query = query.where("project.user_id", "=", userId);
      return query.execute();
    },

    listRemoteActivityRefreshTargets: async (userId, limit = 100) => {
      let query = kdb.selectFrom("project_remotes as association")
        .innerJoin("projects as project", "project.id", "association.project_id")
        .leftJoin("search_catalog_sync_state as sync", (join) => join
          .onRef("sync.project_id", "=", "association.project_id")
          .onRef("sync.target_id", "=", "association.remote_server_id"))
        .select([
          "association.project_id as projectId",
          "association.remote_server_id as targetId",
          "association.remote_path as remotePath",
        ])
        // Every authorized target is eventually revisited. Ordering by the
        // oldest attempt makes a bounded page fair across repeated intervals.
        .orderBy(sql`coalesce(sync.last_attempt_at, 0)`, "asc")
        .orderBy("association.project_id", "asc")
        .orderBy("association.remote_server_id", "asc")
        .limit(Math.max(1, Math.min(limit, 100)));
      if (userId) query = query.where("project.user_id", "=", userId);
      return query.execute();
    },

    // Generation-based reconciliation: only a FULLY successful snapshot may
    // mark rows deleted. Runs in one transaction so a crash mid-apply can't
    // leave a half-deleted cache.
    //
    // Write-through exemption: a snapshot is a photo of the worker taken at
    // `collectedAt`; session rows written through AT or AFTER that instant
    // (written_at >= collectedAt) are newer than the photo, so their absence
    // from it proves nothing and their local state must win. They are skipped
    // by both the upsert (a stale snapshot must not resurrect a just-deleted
    // row or clobber a fresh rename) and the deletion sweep (it must not kill
    // a just-created row). The next snapshot — collected after the
    // write-through — confirms or deletes them normally. Every applied
    // snapshot advances written_at too, so an older outbound ACK arriving
    // after reconciliation cannot overwrite or revive the snapshot result.
    applyCatalogSnapshot: async (projectId, targetId, snapshot, collectedAt) => {
      const now = Date.now();
      const snapshotCollectedAt = collectedAt ?? now;
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
              favorited_at: s.favoritedAt, entry_count: s.entryCount,
              status: s.status ?? "unknown", agent_type: s.agentType ?? null, model: s.model ?? null,
              last_user_message_at: s.lastUserMessageAt ?? null,
              last_completed_at: s.lastCompletedAt ?? null,
              generation, deleted_at: null,
              written_at: snapshotCollectedAt,
            })
            .onConflict((oc) => oc.column("local_session_id").doUpdateSet({
              project_id: projectId, target_id: targetId, branch: toDbBranch(s.branch),
              title: s.title, last_active_at: s.lastActiveAt, favorited_at: s.favoritedAt,
              entry_count: s.entryCount, status: s.status ?? "unknown",
              agent_type: s.agentType ?? null, model: s.model ?? null,
              last_user_message_at: s.lastUserMessageAt ?? null,
              last_completed_at: s.lastCompletedAt ?? null,
              generation, deleted_at: null, written_at: snapshotCollectedAt,
            }).where((eb) => eb.or([
              eb("session_search_cache.written_at", "is", null),
              eb("session_search_cache.written_at", "<", snapshotCollectedAt),
            ])))
            .execute();
        }
        await trx.updateTable("workspace_search_cache")
          .set({ deleted_at: now })
          .where("project_id", "=", projectId).where("target_id", "=", targetId)
          .where("generation", "<", generation).where("deleted_at", "is", null)
          .execute();
        await trx.updateTable("session_search_cache")
          .set({ deleted_at: now, written_at: snapshotCollectedAt })
          .where("project_id", "=", projectId).where("target_id", "=", targetId)
          .where("generation", "<", generation).where("deleted_at", "is", null)
          .where((eb) => eb.or([
            eb("written_at", "is", null),
            eb("written_at", "<", snapshotCollectedAt),
          ]))
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
    // anyway (remote title PATCH proxy + local AI title generation).
    // UPDATE-only — a title alone must not fabricate a session's existence.
    // Stamps written_at so an in-flight snapshot doesn't clobber the fresher
    // title with its stale copy.
    updateCachedSessionTitle: async (localSessionId, title) => {
      await kdb.updateTable("session_search_cache")
        .set({ title, written_at: Date.now() })
        .where("local_session_id", "=", localSessionId)
        .execute();
    },

    // Star write-through. Unlike the title and delete write-throughs this one
    // may CREATE the row: the remote favorite PATCH has already succeeded on
    // the worker, so the session provably exists, and the path that lists a
    // remote's sessions (where the star button lives) binds only a mapping —
    // no cache row. Before that target's first catalog snapshot there would be
    // nothing to update and the star would sit invisible, which is the exact
    // latency this write-through exists to remove. Only starring creates a
    // row; an unstar with no row has nothing to hide (see noteSessionDeleted).
    updateCachedSessionFavorited: async (localSessionId, favoritedAt) => {
      const now = Date.now();
      const updated = await kdb.updateTable("session_search_cache")
        .set({ favorited_at: favoritedAt, written_at: now })
        .where("local_session_id", "=", localSessionId)
        .executeTakeFirst();
      if (Number(updated?.numUpdatedRows ?? 0) > 0 || favoritedAt === null) return;

      // The durable mapping is the only thing that can place the row in a
      // project and target; without it the row would be unreachable anyway.
      const mapping = await kdb.selectFrom("remote_session_mappings")
        .select(["project_id", "remote_server_id", "branch"])
        .where("local_session_id", "=", localSessionId)
        .executeTakeFirst();
      if (!mapping || mapping.remote_server_id === "local") return;

      // generation 0 + written_at now: same snapshot-reconciliation exemption
      // noteSessionCreated relies on. last_active_at stays NULL — starring is
      // passive and must never promote a session up the recent-activity list.
      await kdb.insertInto("session_search_cache")
        .values({
          local_session_id: localSessionId,
          project_id: mapping.project_id,
          target_id: mapping.remote_server_id,
          branch: toDbBranch(mapping.branch),
          title: null, last_active_at: null, favorited_at: favoritedAt,
          entry_count: 0, status: "unknown", agent_type: null, model: null,
          last_user_message_at: null, last_completed_at: null,
          generation: 0, deleted_at: null, written_at: now,
        })
        .onConflict((oc) => oc.column("local_session_id")
          .doUpdateSet({ favorited_at: favoritedAt, written_at: now }))
        .execute();
    },

    // Create write-through: called where a remote session's creation transits
    // the server (UI create proxy, commander spawn, branch-from-history). The
    // written_at stamp keeps the row exempt from snapshot reconciliation until
    // a snapshot collected after this instant confirms or deletes it — see
    // applyCatalogSnapshot. generation 0 marks it as never snapshot-confirmed.
    noteSessionCreated: async ({
      localSessionId, projectId, targetId, branch, title, status, agentType, model,
      lastUserMessageAt, lastCompletedAt,
    }) => {
      const now = Date.now();
      await kdb.insertInto("session_search_cache")
        .values({
          local_session_id: localSessionId, project_id: projectId, target_id: targetId,
          branch: toDbBranch(branch), title: title ?? null, last_active_at: now,
          favorited_at: null, entry_count: 0, status: status ?? "unknown",
          agent_type: agentType ?? null, model: model ?? null,
          last_user_message_at: lastUserMessageAt ?? null,
          last_completed_at: lastCompletedAt ?? null,
          generation: 0, deleted_at: null, written_at: now,
        })
        .onConflict((oc) => oc.column("local_session_id").doUpdateSet({
          project_id: projectId, target_id: targetId, branch: toDbBranch(branch),
          last_active_at: now, deleted_at: null, written_at: now,
          ...(title !== undefined ? { title } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(agentType !== undefined ? { agent_type: agentType } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(lastUserMessageAt !== undefined ? { last_user_message_at: lastUserMessageAt } : {}),
          ...(lastCompletedAt !== undefined ? { last_completed_at: lastCompletedAt } : {}),
        }))
        .execute();
    },

    // Delete write-through: soft-delete on the proxied DELETE path. UPDATE-only
    // (no row → nothing to hide). If the worker-side delete actually failed,
    // the next snapshot — collected after this instant — resurrects the row:
    // the worker's catalog stays the source of truth.
    noteSessionDeleted: async (localSessionId) => {
      const now = Date.now();
      await kdb.updateTable("session_search_cache")
        .set({ deleted_at: now, written_at: now })
        .where("local_session_id", "=", localSessionId)
        .execute();
    },

    search: async ({ userId, query, limitPerGroup }) => {
      const q = query.trim().slice(0, 256).toLowerCase();

      let projQuery = kdb.selectFrom("projects")
        .select(["id", "name", "path"])
        .where("id", "not like", "path:%");
      if (userId) projQuery = projQuery.where("user_id", "=", userId);
      const allProjects = await projQuery.execute();
      const projectIds = allProjects.map((p) => p.id);
      const nameById = new Map(allProjects.map((p) => [p.id, p.name]));
      if (projectIds.length === 0) return { projects: [], workspaces: [], sessions: [], favorites: [] };

      const pattern = `%${escapeLike(q)}%`;

      // ---- local sessions (agent_sessions) ------------------------------
      // The qualifying filter (title present OR has entries) runs in SQL,
      // BEFORE the ORDER BY/LIMIT recency window — otherwise 200+ newer
      // non-qualifying rows would fill the window and silently crowd out
      // qualifying sessions. Portable correlated EXISTS, no dialect-specific
      // aggregates.
      let localBase = kdb.selectFrom("agent_sessions as s")
        .leftJoin("workspace_checkouts as checkout", "checkout.id", "s.workspace_checkout_id")
        .leftJoin("workspaces as workspace", "workspace.id", "checkout.workspace_id")
        .select([
          "s.id", "s.title", "s.last_user_message_at", "s.updated_at", "s.favorited_at",
          "s.workspace_checkout_id", "s.project_id as snapshot_project_id", "s.branch as snapshot_branch",
          sql<string>`case when s.workspace_checkout_id is null then s.project_id else workspace.project_id end`.as("project_id"),
          sql<string>`case when s.workspace_checkout_id is null then s.branch else workspace.branch end`.as("branch"),
          sql<string>`case when s.workspace_checkout_id is null then 'local' else checkout.target_id end`.as("target_id"),
        ])
        .where((eb) => eb.or([
          eb.and([eb("s.workspace_checkout_id", "is", null), eb("s.project_id", "in", projectIds)]),
          eb.and([
            eb("s.workspace_checkout_id", "is not", null),
            eb("checkout.id", "is not", null),
            eb("workspace.id", "is not", null),
            eb("workspace.project_id", "in", projectIds),
          ]),
        ]))
        .where((eb) => eb.or([
          eb("s.title", "is not", null),
          eb.exists(
            eb.selectFrom("agent_session_entries")
              .select("agent_session_entries.session_id")
              .whereRef("agent_session_entries.session_id", "=", "s.id"),
          ),
        ]));
      if (q) localBase = localBase.where(sql<boolean>`lower(coalesce(s.title, '')) like ${pattern} escape '\\'`);
      const localRows = await localBase.orderBy("s.updated_at", "desc").limit(200).execute();
      // Favorites are exempt from the recency window: the contract includes
      // ALL favorited sessions, and favorites are inherently few — no cap.
      const localFavRows = await localBase.where("s.favorited_at", "is not", null).execute();

      // ---- remote sessions (session_search_cache) ------------------------
      // Self-heal: a cache row for a non-local target ONLY surfaces while a
      // matching project_remotes link still exists. Unlinking a remote from
      // the project drops its cached rows out of search without an explicit
      // purge; re-linking makes them reappear on the next snapshot.
      let cacheBase = kdb.selectFrom("session_search_cache as c")
        .leftJoin("remote_session_mappings as mapping", "mapping.local_session_id", "c.local_session_id")
        .leftJoin("workspace_checkouts as checkout", "checkout.id", "mapping.workspace_checkout_id")
        .leftJoin("workspaces as workspace", "workspace.id", "checkout.workspace_id")
        .leftJoin("project_remotes as pr", (join) => join.on((eb) => eb.or([
          eb.and([
            eb("mapping.local_session_id", "is", null),
            eb("pr.project_id", "=", eb.ref("c.project_id")),
            eb("pr.remote_server_id", "=", eb.ref("c.target_id")),
          ]),
          eb.and([
            eb("mapping.local_session_id", "is not", null),
            eb("mapping.workspace_checkout_id", "is", null),
            eb("pr.project_id", "=", eb.ref("mapping.project_id")),
            eb("pr.remote_server_id", "=", eb.ref("mapping.remote_server_id")),
          ]),
          eb.and([
            eb("mapping.workspace_checkout_id", "is not", null),
            eb("pr.project_id", "=", eb.ref("workspace.project_id")),
            eb("pr.remote_server_id", "=", eb.ref("checkout.target_id")),
          ]),
        ])))
        .select([
          "c.local_session_id", "c.title", "c.last_active_at", "c.favorited_at",
          "mapping.local_session_id as mapping_local_session_id", "mapping.workspace_checkout_id",
          "mapping.project_id as snapshot_project_id", "mapping.remote_server_id as snapshot_target_id",
          "mapping.branch as snapshot_branch",
          sql<string>`case when mapping.local_session_id is null then c.project_id when mapping.workspace_checkout_id is null then mapping.project_id else workspace.project_id end`.as("project_id"),
          sql<string>`case when mapping.local_session_id is null then c.target_id when mapping.workspace_checkout_id is null then mapping.remote_server_id else checkout.target_id end`.as("target_id"),
          sql<string>`case when mapping.local_session_id is null then c.branch when mapping.workspace_checkout_id is null then coalesce(mapping.branch, '') else workspace.branch end`.as("branch"),
        ])
        .where("c.deleted_at", "is", null)
        .where((eb) => eb.or([
          eb.and([
            eb("mapping.local_session_id", "is", null),
            eb("c.project_id", "in", projectIds),
            eb("c.target_id", "!=", "local"),
            eb("pr.id", "is not", null),
          ]),
          eb.and([
            eb("mapping.local_session_id", "is not", null),
            eb("mapping.workspace_checkout_id", "is", null),
            eb("mapping.project_id", "in", projectIds),
            eb("mapping.remote_server_id", "!=", "local"),
            eb("c.project_id", "=", eb.ref("mapping.project_id")),
            eb("c.target_id", "=", eb.ref("mapping.remote_server_id")),
            eb("pr.id", "is not", null),
          ]),
          eb.and([
            eb("mapping.workspace_checkout_id", "is not", null),
            eb("checkout.id", "is not", null),
            eb("workspace.id", "is not", null),
            eb("workspace.project_id", "in", projectIds),
            eb("checkout.target_id", "!=", "local"),
            eb("pr.id", "is not", null),
          ]),
        ]));
      if (q) cacheBase = cacheBase.where(sql<boolean>`lower(coalesce(c.title, '')) like ${pattern} escape '\\'`);
      const cacheRows = await cacheBase.orderBy("c.last_active_at", "desc").limit(200).execute();
      const cacheFavRows = await cacheBase.where("c.favorited_at", "is not", null).execute();

      const [danglingLocal, danglingRemote] = await Promise.all([
        kdb.selectFrom("agent_sessions as s")
          .leftJoin("workspace_checkouts as checkout", "checkout.id", "s.workspace_checkout_id")
          .select(kdb.fn.countAll<number>().as("count"))
          .where("s.workspace_checkout_id", "is not", null)
          .where("checkout.id", "is", null)
          .where("s.project_id", "in", projectIds)
          .executeTakeFirstOrThrow(),
        kdb.selectFrom("session_search_cache as c")
          .innerJoin("remote_session_mappings as mapping", "mapping.local_session_id", "c.local_session_id")
          .leftJoin("workspace_checkouts as checkout", "checkout.id", "mapping.workspace_checkout_id")
          .select(kdb.fn.countAll<number>().as("count"))
          .where("mapping.workspace_checkout_id", "is not", null)
          .where("checkout.id", "is", null)
          .where("mapping.project_id", "in", projectIds)
          .where("c.deleted_at", "is", null)
          .executeTakeFirstOrThrow(),
      ]);
      recordWorkspaceBindingRead("search", "dangling", Number(danglingLocal.count) + Number(danglingRemote.count));

      // Union of the recency windows and the uncapped favorites, deduped by
      // sessionId (a favorited session inside the window appears in both).
      const candidateById = new Map<string, SessionCandidate>();
      for (const r of [...localRows, ...localFavRows]) {
        if (candidateById.has(r.id)) continue;
        observeLocalSearchRow(r);
        candidateById.set(r.id, {
          sessionId: r.id,
          projectId: r.project_id,
          projectName: nameById.get(r.project_id) ?? "",
          targetId: r.target_id,
          branch: fromDbBranch(r.branch),
          title: r.title ?? null,
          lastActiveAt: r.last_user_message_at ?? parseDbTimestamp(r.updated_at),
          favoritedAt: r.favorited_at ?? null,
        });
      }
      for (const r of [...cacheRows, ...cacheFavRows]) {
        if (candidateById.has(r.local_session_id)) continue;
        if (r.mapping_local_session_id === null || r.workspace_checkout_id === null) {
          recordWorkspaceBindingRead("search", "legacy-fallback");
        } else if (r.snapshot_project_id !== r.project_id
          || r.snapshot_target_id !== r.target_id
          || (r.snapshot_branch ?? "") !== r.branch) {
          recordWorkspaceBindingRead("search", "mismatch");
        } else {
          recordWorkspaceBindingRead("search", "checkout-hit");
        }
        candidateById.set(r.local_session_id, {
          sessionId: r.local_session_id,
          projectId: r.project_id,
          projectName: nameById.get(r.project_id) ?? "",
          targetId: r.target_id,
          branch: fromDbBranch(r.branch),
          title: r.title ?? null,
          lastActiveAt: r.last_active_at ?? null,
          favoritedAt: r.favorited_at ?? null,
        });
      }
      const sessionCandidates: SessionCandidate[] = [...candidateById.values()];

      if (!q) {
        // Recents mode: projects/workspaces are irrelevant without a query
        // term. Two groups over the (already project-scoped, self-healed)
        // candidate set — ALL favorited sessions (uncapped side queries)
        // plus the most-recently-active ones (200-row windows):
        //   sessions  — pure recency desc, so many favorites can never crowd
        //               the actually-recent sessions out of the cut;
        //   favorites — favorited rows that DIDN'T make the recency cut
        //               (recency desc, deduped), so an old favorite still
        //               surfaces instead of losing to the N most-recent rows.
        const byRecency = [...sessionCandidates]
          .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
        const sessions = byRecency.slice(0, limitPerGroup);
        const inSessions = new Set(sessions.map((s) => s.sessionId));
        const favorites = byRecency
          .filter((s) => s.favoritedAt && !inSessions.has(s.sessionId))
          .slice(0, limitPerGroup);
        return { projects: [], workspaces: [], sessions, favorites };
      }

      const projects: SearchResultProjectRow[] = rankAndCap(allProjects.map((p) => ({
        item: { id: p.id, name: p.name, path: p.path ?? null },
        tier: Math.min(matchTier(p.name, q), matchTier(p.path, q)),
        favorited: false,
        recency: 0,
      })), limitPerGroup);

      const wsRows = await kdb.selectFrom("workspace_search_cache as w")
        .leftJoin("project_remotes as pr", (join) => join
          .onRef("pr.project_id", "=", "w.project_id")
          .onRef("pr.remote_server_id", "=", "w.target_id"))
        .select(["w.project_id", "w.target_id", "w.branch"])
        .where("w.project_id", "in", projectIds)
        .where("w.deleted_at", "is", null)
        .where((eb) => eb.or([
          eb("w.target_id", "=", "local"),
          eb("pr.id", "is not", null),
        ]))
        .execute();
      const workspaces: SearchResultWorkspaceRow[] = rankAndCap(wsRows.map((w) => ({
        item: {
          projectId: w.project_id,
          projectName: nameById.get(w.project_id) ?? "",
          targetId: w.target_id,
          branch: fromDbBranch(w.branch),
        },
        tier: matchTier(fromDbBranch(w.branch) ?? "main", q),
        favorited: false,
        recency: 0,
      })), limitPerGroup);

      const sessions: SearchResultSessionRow[] = rankAndCap(sessionCandidates.map((s) => ({
        item: s,
        tier: matchTier(s.title, q),
        favorited: !!s.favoritedAt,
        recency: s.lastActiveAt ?? 0,
      })), limitPerGroup);

      return { projects, workspaces, sessions, favorites: [] };
    },
  },
});
