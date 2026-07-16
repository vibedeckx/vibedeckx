import { sql, type Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage, SearchResultProjectRow, SearchResultSessionRow, SearchResultWorkspaceRow } from "../types.js";
import type { DialectHelpers } from "../dialect.js";

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

    search: async ({ userId, query, limitPerGroup }) => {
      const q = query.trim().slice(0, 256).toLowerCase();

      let projQuery = kdb.selectFrom("projects")
        .select(["id", "name", "path"])
        .where("id", "not like", "path:%");
      if (userId) projQuery = projQuery.where("user_id", "=", userId);
      const allProjects = await projQuery.execute();
      const projectIds = allProjects.map((p) => p.id);
      const nameById = new Map(allProjects.map((p) => [p.id, p.name]));
      if (projectIds.length === 0) return { projects: [], workspaces: [], sessions: [] };

      const pattern = `%${escapeLike(q)}%`;

      // ---- local sessions (agent_sessions) ------------------------------
      // The qualifying filter (title present OR has entries) runs in SQL,
      // BEFORE the ORDER BY/LIMIT recency window — otherwise 200+ newer
      // non-qualifying rows would fill the window and silently crowd out
      // qualifying sessions. Portable correlated EXISTS, no dialect-specific
      // aggregates.
      let localBase = kdb.selectFrom("agent_sessions as s")
        .select(["s.id", "s.project_id", "s.branch", "s.title", "s.last_user_message_at", "s.updated_at", "s.favorited_at"])
        .where("s.project_id", "in", projectIds)
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
        .leftJoin("project_remotes as pr", (join) => join
          .onRef("pr.project_id", "=", "c.project_id")
          .onRef("pr.remote_server_id", "=", "c.target_id"))
        .select(["c.local_session_id", "c.project_id", "c.target_id", "c.branch", "c.title", "c.last_active_at", "c.favorited_at"])
        .where("c.project_id", "in", projectIds)
        .where("c.deleted_at", "is", null)
        .where((eb) => eb.or([
          eb("c.target_id", "=", "local"),
          eb("pr.id", "is not", null),
        ]));
      if (q) cacheBase = cacheBase.where(sql<boolean>`lower(coalesce(c.title, '')) like ${pattern} escape '\\'`);
      const cacheRows = await cacheBase.orderBy("c.last_active_at", "desc").limit(200).execute();
      const cacheFavRows = await cacheBase.where("c.favorited_at", "is not", null).execute();

      // Union of the recency windows and the uncapped favorites, deduped by
      // sessionId (a favorited session inside the window appears in both).
      const candidateById = new Map<string, SessionCandidate>();
      for (const r of [...localRows, ...localFavRows]) {
        if (candidateById.has(r.id)) continue;
        candidateById.set(r.id, {
          sessionId: r.id,
          projectId: r.project_id,
          projectName: nameById.get(r.project_id) ?? "",
          targetId: "local",
          branch: fromDbBranch(r.branch),
          title: r.title ?? null,
          lastActiveAt: r.last_user_message_at ?? parseDbTimestamp(r.updated_at),
          favoritedAt: r.favorited_at ?? null,
        });
      }
      for (const r of [...cacheRows, ...cacheFavRows]) {
        if (candidateById.has(r.local_session_id)) continue;
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
        // term; sessions are the full (already project-scoped, self-healed)
        // candidate set — ALL favorited sessions (uncapped side queries)
        // plus the most-recently-active ones (200-row windows). Sorted
        // favorited-first (then recency desc) BEFORE the limitPerGroup cap —
        // otherwise an old favorite loses out to the N most-recently-active
        // unfavorited sessions and never makes the cut, defeating the
        // "recents AND favorited" contract at the default limit.
        const sessions = [...sessionCandidates]
          .sort((a, b) => Number(!!b.favoritedAt) - Number(!!a.favoritedAt)
            || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
          .slice(0, limitPerGroup);
        return { projects: [], workspaces: [], sessions };
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

      return { projects, workspaces, sessions };
    },
  },
});
