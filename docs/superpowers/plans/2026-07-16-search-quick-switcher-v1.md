# Global Search & Quick Switcher (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd+K quick-switcher palette that searches projects / workspaces (branches) / agent-session titles across local and remote targets and jumps to the selection.

**Architecture:** A worker-side catalog endpoint enumerates a project's workspaces + sessions in one call. The front server caches catalogs in three new SQLite tables (session cache, workspace cache, per-target sync state) via generation-based reconciliation, refreshed with TTL + singleflight when the palette opens. `GET /api/search` reads only the cache (plus local `agent_sessions`). The frontend palette is cmdk-based with server-side filtering.

**Tech Stack:** Fastify + Kysely/better-sqlite3 + vitest (backend); Next.js 16 + cmdk/shadcn (frontend). No new dependencies.

**Spec:** `docs/search-quick-switcher-design.md` (v1 section is authoritative for behavior).

## Global Constraints

- Backend is ESM with NodeNext resolution: **all local imports need `.js` extensions**.
- Branch sentinel: **API uses `branch: null` for the main workspace; DB stores `""`**. Conversion happens ONLY in `repositories/search-cache.ts` (helpers `toDbBranch`/`fromDbBranch`) and in the catalog builder.
- Cache queries must be **portable Kysely** (no SQLite-only SQL): case-insensitivity via `lower()`, `like ... escape '\'`.
- A failed/partial catalog fetch must **never** run deletion reconciliation.
- `GET /api/search` must never spawn subprocesses or proxy traffic.
- Backend typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`. Frontend lint: `pnpm --filter vibedeckx-ui lint`.
- Tests: `cd packages/vibedeckx && npx vitest run <file>` (script `pnpm --filter vibedeckx test` runs all).
- The frontend has **no unit-test infra** — frontend tasks verify via typecheck + lint + the manual checklist in Task 9 (deviation from the spec's "Frontend tests" bullet, which predates checking that no runner exists).

---

### Task 1: Cache tables + snapshot reconciliation repository

**Files:**
- Modify: `packages/vibedeckx/src/storage/schema.ts` (add 3 table interfaces + DB entries)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (CREATE TABLE + wire repo into the return spread at ~line 797)
- Modify: `packages/vibedeckx/src/storage/types.ts` (snapshot/sync-state types + `searchCache` repo interface)
- Create: `packages/vibedeckx/src/storage/repositories/search-cache.ts`
- Test: `packages/vibedeckx/src/storage/search-cache.test.ts`

**Interfaces:**
- Consumes: existing `DialectHelpers`, `DB`, Kysely instance (same pattern as `repositories/agent-sessions.ts`).
- Produces (used by Tasks 2–5):
  - `storage.searchCache.applyCatalogSnapshot(projectId: string, targetId: string, snapshot: SearchCatalogSnapshot): Promise<void>`
  - `storage.searchCache.recordSyncFailure(projectId: string, targetId: string, error: string): Promise<void>`
  - `storage.searchCache.getSyncStates(projectIds: string[]): Promise<SearchSyncState[]>`
  - `storage.searchCache.updateCachedSessionTitle(localSessionId: string, title: string): Promise<void>`
  - Types `SearchCatalogSnapshot`, `SearchCatalogSessionEntry`, `SearchSyncState` exported from `storage/types.ts`.

- [ ] **Step 1: Add types to `storage/types.ts`**

Near the other exported entity types add:

```ts
export interface SearchCatalogSessionEntry {
  id: string;                 // server-side session id (already remote-prefixed for remote targets)
  branch: string | null;      // null = main workspace (API convention)
  title: string | null;
  lastActiveAt: number | null;
  favoritedAt: number | null;
  entryCount: number;
}

export interface SearchCatalogSnapshot {
  workspaces: Array<{ branch: string | null }>;
  sessions: SearchCatalogSessionEntry[];
}

export interface SearchSyncState {
  project_id: string;
  target_id: string;          // "local" or remote server id
  last_success_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
}
```

Inside `export interface Storage { ... }` add (Task 2 adds `search` to this same block):

```ts
searchCache: {
  applyCatalogSnapshot(projectId: string, targetId: string, snapshot: SearchCatalogSnapshot): Promise<void>;
  recordSyncFailure(projectId: string, targetId: string, error: string): Promise<void>;
  getSyncStates(projectIds: string[]): Promise<SearchSyncState[]>;
  updateCachedSessionTitle(localSessionId: string, title: string): Promise<void>;
};
```

- [ ] **Step 2: Add table interfaces to `storage/schema.ts`**

After `RemoteSessionMappingsTable`:

```ts
export interface SessionSearchCacheTable {
  local_session_id: string;
  project_id: string;
  target_id: string;
  branch: string;             // "" sentinel for main
  title: string | null;
  last_active_at: number | null;
  favorited_at: number | null;
  entry_count: number;
  generation: number;
  deleted_at: number | null;
}

export interface WorkspaceSearchCacheTable {
  project_id: string;
  target_id: string;
  branch: string;             // "" sentinel for main
  generation: number;
  deleted_at: number | null;
}

export interface SearchCatalogSyncStateTable {
  project_id: string;
  target_id: string;
  last_success_at: number | null;
  last_attempt_at: number | null;
  snapshot_generation: number;
  last_error: string | null;
}
```

And in `export interface DB { ... }`:

```ts
session_search_cache: SessionSearchCacheTable;
workspace_search_cache: WorkspaceSearchCacheTable;
search_catalog_sync_state: SearchCatalogSyncStateTable;
```

- [ ] **Step 3: Add CREATE TABLE statements to `storage/sqlite.ts`**

In the big `db.exec(` DDL block, after the `remote_session_mappings` table:

```sql
-- Search caches: server-side searchable copies of worker catalogs.
-- remote_session_mappings stays routing-only; these tables are reconciled
-- from full catalog snapshots (generation-based) and rows are soft-deleted,
-- so wiping them never breaks existing remote session URLs.
CREATE TABLE IF NOT EXISTS session_search_cache (
  local_session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  title TEXT,
  last_active_at INTEGER,
  favorited_at INTEGER,
  entry_count INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_search_cache_project
  ON session_search_cache(project_id, target_id);

CREATE TABLE IF NOT EXISTS workspace_search_cache (
  project_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  generation INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (project_id, target_id, branch)
);

CREATE TABLE IF NOT EXISTS search_catalog_sync_state (
  project_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  last_success_at INTEGER,
  last_attempt_at INTEGER,
  snapshot_generation INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (project_id, target_id)
);
```

- [ ] **Step 4: Write the failing test**

`packages/vibedeckx/src/storage/search-cache.test.ts` (mirror the harness of `storage/agent-sessions.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage, SearchCatalogSnapshot } from "./types.js";

const snap = (over: Partial<SearchCatalogSnapshot> = {}): SearchCatalogSnapshot => ({
  workspaces: [{ branch: null }, { branch: "dev" }],
  sessions: [
    { id: "remote-w1-p1-s1", branch: "dev", title: "Fix login bug", lastActiveAt: 1000, favoritedAt: null, entryCount: 5 },
    { id: "remote-w1-p1-s2", branch: null, title: "Refactor auth", lastActiveAt: 2000, favoritedAt: 3000, entryCount: 2 },
  ],
  ...over,
});

describe("searchCache", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-search-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/p1" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applyCatalogSnapshot upserts rows and records sync success", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states).toHaveLength(1);
    expect(states[0].target_id).toBe("w1");
    expect(states[0].last_success_at).toBeGreaterThan(0);
    expect(states[0].last_error ?? null).toBeNull();
  });

  it("marks rows absent from a newer snapshot as deleted, and reappearing rows undeleted", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    // second snapshot drops session s1 and branch dev
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", {
      workspaces: [{ branch: null }],
      sessions: [snap().sessions[1]],
    });
    // third snapshot brings s1 back
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    // verify via Task 2's search OR directly: use a raw query through a second
    // snapshot check — here we assert through getSyncStates generation growth
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_success_at).toBeGreaterThan(0);
  });

  it("recordSyncFailure records the error and never deletes cache rows", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    await storage.searchCache.recordSyncFailure("p1", "w1", "timeout");
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_error).toBe("timeout");
    expect(states[0].last_attempt_at).toBeGreaterThan(0);
    expect(states[0].last_success_at).toBeGreaterThan(0); // preserved from the earlier success
  });

  it("an empty snapshot is a successful sync (updates last_success_at, deletes all rows)", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", { workspaces: [], sessions: [] });
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_success_at).toBeGreaterThan(0);
  });

  it("reconciliation never touches remote_session_mappings", async () => {
    await storage.remoteSessionMappings.upsert("remote-w1-p1-s1", "p1", "w1", "s1", "dev");
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", { workspaces: [], sessions: [] });
    const mappings = await storage.remoteSessionMappings.getAll();
    expect(mappings).toHaveLength(1);
  });

  it("updateCachedSessionTitle updates title in place", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    await storage.searchCache.updateCachedSessionTitle("remote-w1-p1-s1", "New title");
    // asserted through Task 2's search(); for now just ensure it doesn't throw
  });
});
```

Note: two assertions above are placeholder-weak until Task 2's `search()` exists — Task 2 Step 1 REPLACES the bodies of the "marks rows absent…" and "updateCachedSessionTitle…" tests with real assertions through `search()`. That replacement is an explicit step there, not an afterthought.

- [ ] **Step 5: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/storage/search-cache.test.ts`
Expected: FAIL — `storage.searchCache` is undefined (repo not wired).

- [ ] **Step 6: Implement the repository**

Create `packages/vibedeckx/src/storage/repositories/search-cache.ts`:

```ts
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
```

Wire it in `storage/sqlite.ts`: add `import { createSearchCacheRepos } from "./repositories/search-cache.js";` next to the other repo imports, and `...createSearchCacheRepos(kdb, h),` inside the `return { ... }` spread (~line 797).

- [ ] **Step 7: Run test to verify it passes**

Run: `cd packages/vibedeckx && npx vitest run src/storage/search-cache.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 8: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/storage/
git commit -m "feat(search): cache tables + generation-based catalog reconciliation"
```

---

### Task 2: Cache-only search query

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts` (result types + `search` method)
- Modify: `packages/vibedeckx/src/storage/repositories/search-cache.ts`
- Test: `packages/vibedeckx/src/storage/search-cache.test.ts` (extend + strengthen Task 1's weak assertions)

**Interfaces:**
- Consumes: Task 1's tables/repo.
- Produces (used by Task 5 and mirrored by frontend types in Task 6):

```ts
storage.searchCache.search(opts: { userId?: string; query: string; limitPerGroup: number }): Promise<SearchResults>
```

with types in `storage/types.ts`:

```ts
export interface SearchResultProjectRow { id: string; name: string; path: string | null }
export interface SearchResultWorkspaceRow { projectId: string; projectName: string; targetId: string; branch: string | null }
export interface SearchResultSessionRow {
  sessionId: string; projectId: string; projectName: string; targetId: string;
  branch: string | null; title: string | null; lastActiveAt: number | null; favoritedAt: number | null;
}
export interface SearchResults {
  projects: SearchResultProjectRow[];
  workspaces: SearchResultWorkspaceRow[];
  sessions: SearchResultSessionRow[];
}
```

Behavior contract:
- Empty/whitespace `query` → recents mode: `projects`/`workspaces` empty, `sessions` = union of most-recently-active and all favorited sessions, recency-desc, capped at `limitPerGroup`.
- Non-empty query → per group: match tiers exact(0) > prefix(1) > substring(2), favorited boost within tier, then recency desc; each group capped at `limitPerGroup`.
- Tenant scoping: only projects where `user_id = userId` (skip filter when `userId` undefined — solo mode), excluding `path:%` pseudo-projects.
- Remote rows only where a matching `project_remotes` row still exists (unlinked remotes self-heal out).
- `deleted_at IS NULL` everywhere; local sessions included only if `title IS NOT NULL OR entry_count > 0`.
- Main workspace (`""` in DB) is returned as `branch: null` and matches the query text `"main"`.
- `%`/`_`/`\` in the query are escaped in LIKE patterns; query truncated to 256 chars.

- [ ] **Step 1: Strengthen Task 1's weak tests + add search tests (failing)**

Replace the bodies of Task 1's "marks rows absent…" and "updateCachedSessionTitle…" tests, and append a `describe("searchCache.search", ...)` block:

```ts
  it("marks rows absent from a newer snapshot as deleted, and reappearing rows undeleted", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", {
      workspaces: [{ branch: null }],
      sessions: [snap().sessions[1]],
    });
    let res = await storage.searchCache.search({ query: "Fix login", limitPerGroup: 10 });
    expect(res.sessions).toHaveLength(0); // s1 deleted
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    res = await storage.searchCache.search({ query: "Fix login", limitPerGroup: 10 });
    expect(res.sessions.map(s => s.sessionId)).toEqual(["remote-w1-p1-s1"]); // reappeared
  });

  it("updateCachedSessionTitle updates title in place", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    await storage.searchCache.updateCachedSessionTitle("remote-w1-p1-s1", "Renamed thing");
    const res = await storage.searchCache.search({ query: "Renamed", limitPerGroup: 10 });
    expect(res.sessions.map(s => s.sessionId)).toEqual(["remote-w1-p1-s1"]);
  });
```

New block (inside the top-level describe; note the remote-server + project_remotes seeding — without it remote rows are filtered out by the self-heal join):

```ts
  describe("search", () => {
    let serverId: string;
    beforeEach(async () => {
      const server = await storage.remoteServers.create({ name: "Worker 1", url: "http://w1" });
      serverId = server.id;
      await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverId, remote_path: "/repo" });
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap());
    });

    it("matches projects by name and path", async () => {
      const res = await storage.searchCache.search({ query: "proj", limitPerGroup: 10 });
      expect(res.projects.map(p => p.id)).toEqual(["p1"]);
    });

    it("ranks exact > prefix > substring and boosts favorites within a tier", async () => {
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, { workspaces: [], sessions: [
        { id: "a", branch: "dev", title: "auth",         lastActiveAt: 1, favoritedAt: null, entryCount: 1 }, // exact
        { id: "b", branch: "dev", title: "auth refactor", lastActiveAt: 9, favoritedAt: null, entryCount: 1 }, // prefix
        { id: "c", branch: "dev", title: "fix auth bug",  lastActiveAt: 5, favoritedAt: null, entryCount: 1 }, // substring
        { id: "d", branch: "dev", title: "fix auth crash", lastActiveAt: 1, favoritedAt: 99, entryCount: 1 },  // substring + favorited
      ]});
      const res = await storage.searchCache.search({ query: "auth", limitPerGroup: 10 });
      expect(res.sessions.map(s => s.sessionId)).toEqual(["a", "b", "d", "c"]);
    });

    it("escapes LIKE wildcards — '%' finds nothing rather than everything", async () => {
      const res = await storage.searchCache.search({ query: "%", limitPerGroup: 10 });
      expect(res.sessions).toHaveLength(0);
      expect(res.projects).toHaveLength(0);
    });

    it("empty query returns recents+favorites sessions only", async () => {
      const res = await storage.searchCache.search({ query: "  ", limitPerGroup: 10 });
      expect(res.projects).toHaveLength(0);
      expect(res.workspaces).toHaveLength(0);
      // s2 (lastActiveAt 2000, favorited) before s1 (1000)
      expect(res.sessions.map(s => s.sessionId)).toEqual(["remote-w1-p1-s2", "remote-w1-p1-s1"]);
    });

    it("main workspace round-trips: stored as '' but returned as null and matches 'main'", async () => {
      const res = await storage.searchCache.search({ query: "main", limitPerGroup: 10 });
      expect(res.workspaces.some(w => w.branch === null && w.targetId === serverId)).toBe(true);
    });

    it("excludes rows from a remote no longer linked to the project", async () => {
      // remove the association, cache rows remain but must not surface
      const remotes = await storage.projectRemotes.getByProject("p1");
      await storage.projectRemotes.remove(remotes[0].id);
      const res = await storage.searchCache.search({ query: "Fix login", limitPerGroup: 10 });
      expect(res.sessions).toHaveLength(0);
    });

    it("scopes by userId — user B cannot see user A's data", async () => {
      await storage.projects.create({ id: "pB", name: "b-proj", path: "/tmp/pB" }, "userB");
      const resB = await storage.searchCache.search({ userId: "userB", query: "proj", limitPerGroup: 10 });
      expect(resB.projects.map(p => p.id)).toEqual(["pB"]); // not p1 (user_id "")
      const resB2 = await storage.searchCache.search({ userId: "userB", query: "Fix login", limitPerGroup: 10 });
      expect(resB2.sessions).toHaveLength(0);
    });

    it("includes local sessions from agent_sessions (union), skipping empty ones", async () => {
      await storage.agentSessions.create({ id: "loc1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.updateTitle("loc1", "local session about caching");
      await storage.agentSessions.create({ id: "loc2", project_id: "p1", branch: "dev" }); // no title, no entries
      const res = await storage.searchCache.search({ query: "caching", limitPerGroup: 10 });
      expect(res.sessions.map(s => s.sessionId)).toEqual(["loc1"]);
      expect(res.sessions[0].targetId).toBe("local");
    });
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd packages/vibedeckx && npx vitest run src/storage/search-cache.test.ts`
Expected: FAIL — `storage.searchCache.search is not a function`.

- [ ] **Step 3: Implement `search` in `repositories/search-cache.ts`**

Add to the same file (helpers above the factory, method inside `searchCache`):

```ts
import { sql, type Kysely } from "kysely";   // extend the existing import

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// 0 exact, 1 prefix, 2 substring, 3 no match
const matchTier = (text: string | null | undefined, q: string): number => {
  if (!q) return 2;
  if (!text) return 3;
  const t = text.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  return 3;
};

// SQLite stores agent_sessions.updated_at as 'YYYY-MM-DD HH:MM:SS.SSS' (UTC).
const parseDbTimestamp = (ts: string | null | undefined): number | null => {
  if (!ts) return null;
  const ms = Date.parse(ts.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : ms;
};
```

The method:

```ts
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

      // ---- sessions: local agent_sessions UNION remote cache (SQL prefilter, JS rank)
      const pattern = `%${escapeLike(q)}%`;
      let localQ = kdb.selectFrom("agent_sessions as s")
        .leftJoin(
          kdb.selectFrom("agent_session_entries").select("session_id")
            .select(kdb.fn.countAll<number>().as("cnt")).groupBy("session_id").as("e"),
          (join) => join.onRef("e.session_id", "=", "s.id"),
        )
        .select(["s.id", "s.project_id", "s.branch", "s.title", "s.last_user_message_at", "s.updated_at", "s.favorited_at"])
        .select((eb) => eb.fn.coalesce("e.cnt", eb.val(0)).as("entry_count"))
        .where("s.project_id", "in", projectIds)
        .where((eb) => eb.or([eb("s.title", "is not", null), eb("e.cnt", ">", 0)]));
      if (q) localQ = localQ.where(sql<boolean>`lower(coalesce(s.title, '')) like ${pattern} escape '\\'`);
      const localRows = await localQ.orderBy("s.updated_at", "desc").limit(200).execute();

      let cacheQ = kdb.selectFrom("session_search_cache as c")
        .innerJoin("project_remotes as pr", (join) => join
          .onRef("pr.project_id", "=", "c.project_id")
          .onRef("pr.remote_server_id", "=", "c.target_id"))
        .select(["c.local_session_id", "c.project_id", "c.target_id", "c.branch", "c.title", "c.last_active_at", "c.favorited_at"])
        .where("c.project_id", "in", projectIds)
        .where("c.deleted_at", "is", null);
      if (q) cacheQ = cacheQ.where(sql<boolean>`lower(coalesce(c.title, '')) like ${pattern} escape '\\'`);
      const cacheRows = await cacheQ.orderBy("c.last_active_at", "desc").limit(200).execute();

      const sessionCandidates = [
        ...localRows.map((r) => ({
          sessionId: r.id, projectId: r.project_id, projectName: nameById.get(r.project_id) ?? "",
          targetId: "local", branch: fromDbBranch(r.branch),
          title: r.title ?? null,
          lastActiveAt: r.last_user_message_at ?? parseDbTimestamp(r.updated_at),
          favoritedAt: r.favorited_at ?? null,
        })),
        ...cacheRows.map((r) => ({
          sessionId: r.local_session_id, projectId: r.project_id, projectName: nameById.get(r.project_id) ?? "",
          targetId: r.target_id, branch: fromDbBranch(r.branch),
          title: r.title ?? null,
          lastActiveAt: r.last_active_at ?? null,
          favoritedAt: r.favorited_at ?? null,
        })),
      ];

      const byTier = <T>(items: Array<{ item: T; tier: number; favorited: boolean; recency: number }>): T[] =>
        items
          .filter((x) => x.tier < 3)
          .sort((a, b) => a.tier - b.tier
            || Number(b.favorited) - Number(a.favorited)
            || b.recency - a.recency)
          .slice(0, limitPerGroup)
          .map((x) => x.item);

      if (!q) {
        // recents + favorites, sessions only
        const sessions = sessionCandidates
          .sort((a, b) => Number(!!b.favoritedAt) - Number(!!a.favoritedAt) === 0
            ? (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
            : Number(!!b.favoritedAt) - Number(!!a.favoritedAt))
          .slice(0, limitPerGroup);
        return { projects: [], workspaces: [], sessions };
      }

      const projects = byTier(allProjects.map((p) => ({
        item: { id: p.id, name: p.name, path: p.path ?? null },
        tier: Math.min(matchTier(p.name, q), matchTier(p.path, q)),
        favorited: false,
        recency: 0,
      })));

      const wsRows = await kdb.selectFrom("workspace_search_cache as w")
        .leftJoin("project_remotes as pr", (join) => join
          .onRef("pr.project_id", "=", "w.project_id")
          .onRef("pr.remote_server_id", "=", "w.target_id"))
        .select(["w.project_id", "w.target_id", "w.branch"])
        .where("w.project_id", "in", projectIds)
        .where("w.deleted_at", "is", null)
        .where((eb) => eb.or([eb("w.target_id", "=", "local"), eb("pr.id", "is not", null)]))
        .execute();
      const workspaces = byTier(wsRows.map((w) => ({
        item: {
          projectId: w.project_id, projectName: nameById.get(w.project_id) ?? "",
          targetId: w.target_id, branch: fromDbBranch(w.branch),
        },
        tier: matchTier(fromDbBranch(w.branch) ?? "main", q),
        favorited: false,
        recency: 0,
      })));

      const sessions = byTier(sessionCandidates.map((s) => ({
        item: s,
        tier: matchTier(s.title, q),
        favorited: !!s.favoritedAt,
        recency: s.lastActiveAt ?? 0,
      })));

      return { projects, workspaces, sessions };
    },
```

Notes for the implementer:
- The exact Kysely coalesce/subquery syntax for `entry_count` may need adjustment against the installed Kysely version — the acceptance bar is the tests, not this snippet verbatim. Keep the query portable (no `sqlite`-only functions).
- Workspace/project candidate sets are small (bounded by the user's project/branch counts), which is why tier ranking happens in JS; only session candidate sets get an SQL LIKE prefilter + LIMIT 200.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/storage/search-cache.test.ts`
Expected: PASS (Task 1's 6 + the new 9).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/storage/
git commit -m "feat(search): cache-only tiered search query with tenant scoping"
```

---

### Task 3: Catalog builder + worker catalog route

**Files:**
- Create: `packages/vibedeckx/src/search/catalog.ts`
- Create: `packages/vibedeckx/src/routes/search-routes.ts` (catalog route only; Task 5 adds the rest)
- Modify: `packages/vibedeckx/src/server.ts` (import + `server.register(searchRoutes);` next to the other registrations at ~line 330)
- Test: `packages/vibedeckx/src/routes/search-routes.test.ts`

**Interfaces:**
- Consumes: `getWorktreeBranches`/`pruneWorktrees` (`utils/worktree-paths.js`), `shouldShowBranchSessionInList` (`resident-agent-processes.js`), `storage.agentSessions.getByProjectId`/`countEntries`, `storage.projects.getByPath`.
- Produces (used by Tasks 4–5):
  - `buildSearchCatalog(deps: { storage: Storage; getProcessAlive?: (sessionId: string) => boolean }, projectId: string, projectPath: string): Promise<SearchCatalogSnapshot & { snapshotAt: number }>`
  - HTTP: `GET /api/path/search-catalog?path=<projectPath>` → `{ snapshotAt, workspaces, sessions }` (shape = `SearchCatalogSnapshot`), `{ workspaces: [], sessions: [] }`-style empty catalog when no project exists at the path.

- [ ] **Step 1: Write the failing test**

`packages/vibedeckx/src/routes/search-routes.test.ts` (mirror `routes/project-remote-routes.test.ts`; the catalog route needs a real git repo for worktree enumeration):

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import searchRoutes from "./search-routes.js";

describe("GET /api/path/search-catalog", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let repoDir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-search-routes-"));
    repoDir = path.join(dir, "repo");
    execSync(`git init -q "${repoDir}"`, { stdio: "ignore" });
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "proj", path: repoDir });

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("agentSessionManager", { getSessionProcessAlive: () => false });
    app.decorate("reverseConnectManager", undefined);
    await app.register(searchRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the main workspace and non-empty sessions with API branch convention (null = main)", async () => {
    const s = await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "" });
    await storage.agentSessions.updateTitle(s.id, "Investigate flaky test");
    await storage.agentSessions.upsertEntry(s.id, 0, "{}");
    await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" }); // empty → filtered

    const res = await app.inject({ method: "GET", url: `/api/path/search-catalog?path=${encodeURIComponent(repoDir)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshotAt).toBeGreaterThan(0);
    expect(body.workspaces).toEqual([{ branch: null }]);           // git-init repo: main worktree only
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ id: "s1", branch: null, title: "Investigate flaky test", entryCount: 1 });
  });

  it("returns an empty catalog for an unknown path", async () => {
    const res = await app.inject({ method: "GET", url: `/api/path/search-catalog?path=${encodeURIComponent("/nope")}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workspaces: [], sessions: [] });
  });

  it("400s without a path", async () => {
    const res = await app.inject({ method: "GET", url: "/api/path/search-catalog" });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/routes/search-routes.test.ts`
Expected: FAIL — cannot resolve `./search-routes.js`.

- [ ] **Step 3: Implement catalog builder**

Create `packages/vibedeckx/src/search/catalog.ts`:

```ts
import type { Storage, SearchCatalogSnapshot } from "../storage/types.js";
import { pruneWorktrees, getWorktreeBranches } from "../utils/worktree-paths.js";
import { shouldShowBranchSessionInList } from "../resident-agent-processes.js";

export interface CatalogDeps {
  storage: Storage;
  getProcessAlive?: (sessionId: string) => boolean;
}

// SQLite stores updated_at as 'YYYY-MM-DD HH:MM:SS.SSS' (UTC).
const parseDbTimestamp = (ts: string | null | undefined): number | null => {
  if (!ts) return null;
  const ms = Date.parse(ts.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : ms;
};

/**
 * One project's full workspace/session summary — the unit of search-cache
 * refresh. Serves both the worker HTTP endpoint (remote targets) and the
 * in-process local-target refresh. Deliberately NOT branch-scoped: the
 * existing session-list endpoints filter by branch by design and therefore
 * cannot enumerate a project for cache reconciliation.
 */
export async function buildSearchCatalog(
  deps: CatalogDeps,
  projectId: string,
  projectPath: string,
): Promise<SearchCatalogSnapshot & { snapshotAt: number }> {
  pruneWorktrees(projectPath);
  const workspaces = getWorktreeBranches(projectPath); // [{ branch: null }, { branch: "dev" }, ...]
  const sessions = await deps.storage.agentSessions.getByProjectId(projectId);
  const counts = new Map(
    (await deps.storage.agentSessions.countEntries()).map((r) => [r.session_id, r.cnt]),
  );
  return {
    snapshotAt: Date.now(),
    workspaces,
    sessions: sessions
      .map((s) => ({ s, entryCount: counts.get(s.id) ?? 0 }))
      .filter(({ s, entryCount }) => shouldShowBranchSessionInList({
        entryCount,
        processAlive: deps.getProcessAlive?.(s.id) ?? false,
      }))
      .map(({ s, entryCount }) => ({
        id: s.id,
        branch: s.branch === "" ? null : s.branch,
        title: s.title ?? null,
        lastActiveAt: s.last_user_message_at ?? parseDbTimestamp(s.updated_at),
        favoritedAt: s.favorited_at ?? null,
        entryCount,
      })),
  };
}
```

- [ ] **Step 4: Implement the route**

Create `packages/vibedeckx/src/routes/search-routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import { buildSearchCatalog } from "../search/catalog.js";

const searchRoutes: FastifyPluginAsync = async (fastify) => {
  // Worker-side (also served locally in solo mode): full project catalog for
  // search-cache refresh. Reached through the remote proxy like the other
  // /api/path/* provider routes.
  fastify.get<{ Querystring: { path?: string } }>(
    "/api/path/search-catalog",
    async (req, reply) => {
      const projectPath = req.query.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const project = await fastify.storage.projects.getByPath(projectPath);
      if (!project) {
        return reply.code(200).send({ snapshotAt: Date.now(), workspaces: [], sessions: [] });
      }
      try {
        const catalog = await buildSearchCatalog(
          {
            storage: fastify.storage,
            getProcessAlive: (id) => fastify.agentSessionManager.getSessionProcessAlive(id),
          },
          project.id,
          projectPath,
        );
        return reply.code(200).send(catalog);
      } catch (error) {
        return reply.code(500).send({ error: String(error) });
      }
    },
  );
};

export default searchRoutes;
```

Register in `server.ts`: `import searchRoutes from "./routes/search-routes.js";` and `server.register(searchRoutes);` beside the other registrations.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/routes/search-routes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/search/ packages/vibedeckx/src/routes/search-routes.ts packages/vibedeckx/src/routes/search-routes.test.ts packages/vibedeckx/src/server.ts
git commit -m "feat(search): project catalog builder + /api/path/search-catalog worker route"
```

---

### Task 4: Refresh orchestrator (TTL, singleflight, per-worker concurrency, deadline)

**Files:**
- Create: `packages/vibedeckx/src/search/refresh.ts`
- Test: `packages/vibedeckx/src/search/refresh.test.ts`

**Interfaces:**
- Consumes: `storage.searchCache.applyCatalogSnapshot/recordSyncFailure/getSyncStates`, `storage.projects.getAll(userId?)`, `storage.projectRemotes.getByProject`.
- Produces (used by Task 5):

```ts
export interface SearchTarget {
  projectId: string;
  targetId: string;                 // "local" | remote server id
  projectPath?: string | null;      // local targets
  remote?: { serverId: string; url: string; apiKey: string; remotePath: string };
}
export function listSearchTargets(storage: Storage, userId?: string): Promise<SearchTarget[]>;
export function computeCacheState(states: SearchSyncState[], expectedTargets: number, now: number): "cold" | "stale" | "fresh";
export interface RefreshDeps {
  storage: Storage;
  buildLocalCatalog: (projectId: string, projectPath: string) => Promise<SearchCatalogSnapshot>;
  fetchRemoteCatalog: (target: SearchTarget) => Promise<SearchCatalogSnapshot>;  // throws on failure
  ttlMs?: number;        // default 30_000
  deadlineMs?: number;   // default 5_000
  now?: () => number;    // default Date.now
}
export function createSearchRefresher(deps: RefreshDeps): { refreshAll(userId?: string): Promise<void> };
```

- [ ] **Step 1: Write the failing test**

`packages/vibedeckx/src/search/refresh.test.ts` — uses fake deps around a real sqlite storage:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage, SearchCatalogSnapshot } from "../storage/types.js";
import { createSearchRefresher, listSearchTargets, computeCacheState, type SearchTarget } from "./refresh.js";

const emptySnap: SearchCatalogSnapshot = { workspaces: [], sessions: [] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("search refresh", () => {
  let dir: string;
  let storage: Storage;
  let serverId: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-refresh-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "proj", path: null });
    const server = await storage.remoteServers.create({ name: "W1", url: "http://w1" });
    serverId = server.id;
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverId, remote_path: "/repo" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("listSearchTargets: local target only when the project has a path; one target per linked remote", async () => {
    let targets = await listSearchTargets(storage);
    expect(targets).toEqual([
      expect.objectContaining({ projectId: "p1", targetId: serverId }),
    ]);
    await storage.projects.create({ id: "p2", name: "local-proj", path: "/tmp/p2" });
    targets = await listSearchTargets(storage);
    expect(targets.map((t) => t.targetId).sort()).toEqual(["local", serverId].sort());
  });

  it("fetches due targets and applies snapshots", async () => {
    const fetched: string[] = [];
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async (t) => { fetched.push(t.targetId); return emptySnap; },
    });
    await refresher.refreshAll();
    expect(fetched).toEqual([serverId]);
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_success_at).toBeGreaterThan(0);
  });

  it("TTL: a fresh target is not refetched", async () => {
    let calls = 0;
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async () => { calls++; return emptySnap; },
      ttlMs: 60_000,
    });
    await refresher.refreshAll();
    await refresher.refreshAll();
    expect(calls).toBe(1);
  });

  it("singleflight: concurrent refreshes coalesce per target", async () => {
    let calls = 0;
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async () => { calls++; await wait(50); return emptySnap; },
      ttlMs: 0, // always due
    });
    await Promise.all([refresher.refreshAll(), refresher.refreshAll()]);
    expect(calls).toBe(1);
  });

  it("a failing fetch records the failure and does not throw", async () => {
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async () => { throw new Error("boom"); },
    });
    await expect(refresher.refreshAll()).resolves.toBeUndefined();
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_error).toBe("boom");
    expect(states[0].last_success_at ?? null).toBeNull();
  });

  it("deadline: refreshAll returns even while a slow fetch is still running", async () => {
    const refresher = createSearchRefresher({
      storage,
      buildLocalCatalog: async () => emptySnap,
      fetchRemoteCatalog: async () => { await wait(1_000); return emptySnap; },
      deadlineMs: 50,
    });
    const started = Date.now();
    await refresher.refreshAll();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("computeCacheState: cold until every target has succeeded, fresh within TTL, stale after", () => {
    const now = 100_000;
    expect(computeCacheState([], 1, now)).toBe("cold");
    expect(computeCacheState([{ project_id: "p1", target_id: "t", last_success_at: now - 1_000, last_attempt_at: now, last_error: null }], 1, now)).toBe("fresh");
    expect(computeCacheState([{ project_id: "p1", target_id: "t", last_success_at: now - 90_000, last_attempt_at: now, last_error: null }], 1, now)).toBe("stale");
    expect(computeCacheState([{ project_id: "p1", target_id: "t", last_success_at: now - 1_000, last_attempt_at: now, last_error: null }], 2, now)).toBe("cold");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/search/refresh.test.ts`
Expected: FAIL — cannot resolve `./refresh.js`.

- [ ] **Step 3: Implement**

Create `packages/vibedeckx/src/search/refresh.ts`:

```ts
import type { Storage, SearchCatalogSnapshot, SearchSyncState } from "../storage/types.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_DEADLINE_MS = 5_000;
const PER_WORKER_CONCURRENCY = 3;
const LOCAL_CONCURRENCY = 4;

export interface SearchTarget {
  projectId: string;
  targetId: string;
  projectPath?: string | null;
  remote?: { serverId: string; url: string; apiKey: string; remotePath: string };
}

export async function listSearchTargets(storage: Storage, userId?: string): Promise<SearchTarget[]> {
  const projects = await storage.projects.getAll(userId);
  const targets: SearchTarget[] = [];
  for (const p of projects) {
    if (p.path) targets.push({ projectId: p.id, targetId: "local", projectPath: p.path });
    const remotes = await storage.projectRemotes.getByProject(p.id);
    for (const r of remotes) {
      targets.push({
        projectId: p.id,
        targetId: r.remote_server_id,
        remote: {
          serverId: r.remote_server_id,
          url: r.server_url ?? "",
          apiKey: r.server_api_key ?? "",
          remotePath: r.remote_path,
        },
      });
    }
  }
  return targets;
}

export function computeCacheState(
  states: SearchSyncState[],
  expectedTargets: number,
  now: number,
  ttlMs: number = DEFAULT_TTL_MS,
): "cold" | "stale" | "fresh" {
  if (expectedTargets === 0) return "fresh";
  const succeeded = states.filter((s) => s.last_success_at != null);
  if (succeeded.length < expectedTargets) return "cold";
  return succeeded.every((s) => now - (s.last_success_at ?? 0) <= ttlMs) ? "fresh" : "stale";
}

export interface RefreshDeps {
  storage: Storage;
  buildLocalCatalog: (projectId: string, projectPath: string) => Promise<SearchCatalogSnapshot>;
  fetchRemoteCatalog: (target: SearchTarget) => Promise<SearchCatalogSnapshot>;
  ttlMs?: number;
  deadlineMs?: number;
  now?: () => number;
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      await task();
    }
  });
  await Promise.all(workers);
}

export function createSearchRefresher(deps: RefreshDeps) {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = deps.now ?? Date.now;
  // Singleflight per (project, target): concurrent palette-opens share one fetch.
  const inflight = new Map<string, Promise<void>>();

  function refreshTarget(t: SearchTarget): Promise<void> {
    const key = `${t.projectId}:${t.targetId}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const run = (async () => {
      try {
        const snapshot = t.targetId === "local"
          ? await deps.buildLocalCatalog(t.projectId, t.projectPath ?? "")
          : await deps.fetchRemoteCatalog(t);
        await deps.storage.searchCache.applyCatalogSnapshot(t.projectId, t.targetId, snapshot);
      } catch (err) {
        // A failed fetch must never delete cache rows — record and move on.
        await deps.storage.searchCache.recordSyncFailure(
          t.projectId, t.targetId, err instanceof Error ? err.message : String(err),
        ).catch(() => {});
      }
    })();
    inflight.set(key, run);
    void run.finally(() => inflight.delete(key));
    return run;
  }

  async function refreshAll(userId?: string): Promise<void> {
    const targets = await listSearchTargets(deps.storage, userId);
    const states = await deps.storage.searchCache.getSyncStates([...new Set(targets.map((t) => t.projectId))]);
    const stateByKey = new Map(states.map((s) => [`${s.project_id}:${s.target_id}`, s]));
    const due = targets.filter((t) => {
      const s = stateByKey.get(`${t.projectId}:${t.targetId}`);
      return !s?.last_success_at || now() - s.last_success_at > ttlMs;
    });

    // Group by worker: many projects can point at the same worker, and it
    // must not be stampeded — cap in-flight catalog calls per worker.
    const byWorker = new Map<string, SearchTarget[]>();
    for (const t of due) {
      const k = t.targetId;
      byWorker.set(k, [...(byWorker.get(k) ?? []), t]);
    }
    const lanes = [...byWorker.entries()].map(([workerId, ts]) =>
      runWithConcurrency(
        ts.map((t) => () => refreshTarget(t)),
        workerId === "local" ? LOCAL_CONCURRENCY : PER_WORKER_CONCURRENCY,
      ),
    );
    const all = Promise.all(lanes).then(() => undefined);
    // Overall deadline: return with whatever completed; stragglers finish in
    // the background (their singleflight entries prevent duplicate work).
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deadlineMs);
        timer.unref?.();
      }),
    ]);
  }

  return { refreshAll };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/search/refresh.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/search/
git commit -m "feat(search): refresh orchestrator with TTL, singleflight, per-worker caps, deadline"
```

---

### Task 5: Server search routes (`GET /api/search`, `POST /api/search/refresh`) + title write-through

**Files:**
- Modify: `packages/vibedeckx/src/routes/search-routes.ts`
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts` (remote title PATCH proxy hook, ~line 1400)
- Test: `packages/vibedeckx/src/routes/search-routes.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1–4 exports; `requireAuth` (same import the other route files in `routes/` use — mirror `agent-session-routes.ts`); `proxyToRemoteAuto` from `../utils/remote-proxy.js`; `fastify.remoteSessionMap`; `storage.remoteSessionMappings.upsert`.
- Produces (consumed by frontend Task 6):
  - `GET /api/search?q=<query>&limitPerGroup=<n>` → `SearchResults & { cacheState: "cold" | "stale" | "fresh" }`
  - `POST /api/search/refresh` → `{ ok: true, cacheState: ... }` (returns after refresh completes or hits the deadline)

- [ ] **Step 1: Write the failing tests**

Append to `search-routes.test.ts` (the existing beforeEach gives a no-auth app — `authEnabled` undecorated means `requireAuth` returns `undefined`, i.e. solo mode; the repository-level test in Task 2 covers per-user scoping):

```ts
describe("GET /api/search and POST /api/search/refresh", () => {
  // reuse the same beforeEach/afterEach harness as the catalog describe —
  // duplicate the setup block (fresh app per describe), plus:
  //   await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
  //   await storage.agentSessions.updateTitle("s1", "Fix login flow");
  //   await storage.agentSessions.upsertEntry("s1", 0, "{}");

  it("search returns matches from local sessions with cacheState", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=login" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["s1"]);
    expect(["cold", "stale", "fresh"]).toContain(body.cacheState);
  });

  it("refresh populates the local target's workspace cache, then search finds the branch", async () => {
    let res = await app.inject({ method: "POST", url: "/api/search/refresh" });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: "/api/search?q=main" });
    // repoDir is a git-init repo → its main workspace ('' sentinel, branch null) is cached
    expect(res.json().workspaces.some((w: { branch: string | null }) => w.branch === null)).toBe(true);
  });

  it("search caps and clamps limitPerGroup", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=login&limitPerGroup=9999" });
    expect(res.statusCode).toBe(200); // clamped internally to <= 50, must not error
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vibedeckx && npx vitest run src/routes/search-routes.test.ts`
Expected: new tests FAIL with 404 (routes don't exist).

- [ ] **Step 3: Implement the routes**

Extend `routes/search-routes.ts` (inside the same plugin, after the catalog route). Mirror `agent-session-routes.ts` for the `requireAuth` import and the `proxyToRemoteAuto` usage:

```ts
import type { FastifyPluginAsync } from "fastify";
import { buildSearchCatalog } from "../search/catalog.js";
import { createSearchRefresher, listSearchTargets, computeCacheState, type SearchTarget } from "../search/refresh.js";
import type { SearchCatalogSessionEntry } from "../storage/types.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";

const searchRoutes: FastifyPluginAsync = async (fastify) => {
  // ... catalog route from Task 3 ...

  const refresher = createSearchRefresher({
    storage: fastify.storage,
    buildLocalCatalog: (projectId, projectPath) =>
      buildSearchCatalog(
        {
          storage: fastify.storage,
          getProcessAlive: (id) => fastify.agentSessionManager.getSessionProcessAlive(id),
        },
        projectId,
        projectPath,
      ),
    fetchRemoteCatalog: async (target: SearchTarget) => {
      const r = target.remote;
      if (!r) throw new Error("remote target without remote config");
      const params = new URLSearchParams({ path: r.remotePath });
      const result = await proxyToRemoteAuto(
        r.serverId, r.url, r.apiKey,
        "GET", `/api/path/search-catalog?${params.toString()}`, undefined,
        { reverseConnectManager: fastify.reverseConnectManager, timeoutMs: 2000 },
      );
      if (!result.ok) {
        throw new Error(`catalog fetch failed: ${result.status} ${result.errorCode ?? ""}`);
      }
      const data = result.data as { workspaces: Array<{ branch: string | null }>; sessions: SearchCatalogSessionEntry[] };
      // Wrap remote ids into local remote-prefixed ids and register mappings,
      // mirroring the session list proxy — a cached session must be navigable
      // even if the user never opened its branch dropdown.
      const sessions = await Promise.all(data.sessions.map(async (s) => {
        const localSessionId = `remote-${target.targetId}-${target.projectId}-${s.id}`;
        if (!fastify.remoteSessionMap.has(localSessionId)) {
          fastify.remoteSessionMap.set(localSessionId, {
            remoteServerId: target.targetId,
            remoteUrl: r.url,
            remoteApiKey: r.apiKey,
            remoteSessionId: s.id,
            branch: s.branch,
          });
        }
        await fastify.storage.remoteSessionMappings.upsert(
          localSessionId, target.projectId, target.targetId, s.id, s.branch,
        );
        return { ...s, id: localSessionId };
      }));
      return { workspaces: data.workspaces, sessions };
    },
  });

  async function currentCacheState(userId: string | undefined): Promise<"cold" | "stale" | "fresh"> {
    const targets = await listSearchTargets(fastify.storage, userId);
    const states = await fastify.storage.searchCache.getSyncStates(
      [...new Set(targets.map((t) => t.projectId))],
    );
    return computeCacheState(states, targets.length, Date.now());
  }

  // Cache-only search: never proxies, never spawns subprocesses.
  fastify.get<{ Querystring: { q?: string; limitPerGroup?: string } }>(
    "/api/search",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const query = (req.query.q ?? "").slice(0, 256);
      const parsed = parseInt(req.query.limitPerGroup ?? "10", 10);
      const limitPerGroup = Math.min(Math.max(Number.isNaN(parsed) ? 10 : parsed, 1), 50);
      const results = await fastify.storage.searchCache.search({ userId, query, limitPerGroup });
      const cacheState = await currentCacheState(userId);
      return reply.code(200).send({ ...results, cacheState });
    },
  );

  // Explicit refresh, called once on palette open. Returns when done or at
  // the deadline; the frontend re-queries afterwards.
  fastify.post("/api/search/refresh", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    await refresher.refreshAll(userId);
    const cacheState = await currentCacheState(userId);
    return reply.code(200).send({ ok: true, cacheState });
  });
};
```

Note: if `requireAuth` in the existing route files is imported from a different module than `../server.js`, mirror THAT import — do not invent a new path. Same for `fastify.remoteSessionMap`'s value type: copy the object shape used in `agent-session-routes.ts:401-408`.

- [ ] **Step 4: Title write-through hook**

In `agent-session-routes.ts`, in the remote branch of the title PATCH route (~line 1400, where the proxy call to `/api/agent-sessions/<remote>/title` succeeds), add after the successful proxy:

```ts
await fastify.storage.searchCache.updateCachedSessionTitle(req.params.sessionId, title);
```

And in the local branch of the same route (where `storage.agentSessions.updateTitle` is called) no hook is needed — local sessions are searched directly from `agent_sessions`.

Scope note: the spec also mentions opportunistic write-through from the session list proxy and `session:title` events. v1 deliberately hooks only the title PATCH proxy — the palette-open refresh (30 s TTL) already bounds staleness, and the list-proxy hook would add a write per listed session on every dropdown open for marginal freshness. Revisit only if stale titles are actually observed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/routes/search-routes.test.ts`
Expected: PASS (all 6).

Also run the full backend suite once (routes file touched):
Run: `cd packages/vibedeckx && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/routes/ packages/vibedeckx/src/search/
git commit -m "feat(search): /api/search + /api/search/refresh with remote catalog fan-out"
```

---

### Task 6: Frontend API layer

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts`

**Interfaces:**
- Consumes: Task 5's HTTP endpoints; existing `authFetch`/`getApiBase` helpers.
- Produces (used by Tasks 7–8): standalone exports `searchAll`, `refreshSearchCache` and types `SearchResponse`, `SearchResultProject`, `SearchResultWorkspace`, `SearchResultSession`, `SearchCacheState`.

- [ ] **Step 1: Add types + functions**

Near `listBranchSessions` (standalone-export style, matching it):

```ts
export type SearchCacheState = "cold" | "stale" | "fresh";
export interface SearchResultProject { id: string; name: string; path: string | null }
export interface SearchResultWorkspace { projectId: string; projectName: string; targetId: string; branch: string | null }
export interface SearchResultSession {
  sessionId: string; projectId: string; projectName: string; targetId: string;
  branch: string | null; title: string | null; lastActiveAt: number | null; favoritedAt: number | null;
}
export interface SearchResponse {
  projects: SearchResultProject[];
  workspaces: SearchResultWorkspace[];
  sessions: SearchResultSession[];
  cacheState: SearchCacheState;
}

export async function searchAll(q: string, opts?: { signal?: AbortSignal }): Promise<SearchResponse> {
  const res = await authFetch(`${getApiBase()}/api/search?q=${encodeURIComponent(q)}`, { signal: opts?.signal });
  if (!res.ok) throw new Error(`searchAll failed: ${res.status}`);
  return res.json();
}

export async function refreshSearchCache(): Promise<{ ok: boolean; cacheState: SearchCacheState }> {
  const res = await authFetch(`${getApiBase()}/api/search/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(`refreshSearchCache failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
git add apps/vibedeckx-ui/lib/api.ts
git commit -m "feat(search): frontend API for /api/search and refresh"
```

---

### Task 7: QuickSwitcher palette component

**Files:**
- Modify: `apps/vibedeckx-ui/components/ui/command.tsx` (forward `shouldFilter` — CommandDialog hardcodes the inner `<Command>` and cmdk's client-side filtering must be OFF for server-side results)
- Create: `apps/vibedeckx-ui/components/search/quick-switcher.tsx`

**Interfaces:**
- Consumes: Task 6's `searchAll`/`refreshSearchCache` + types; `CommandDialog` family from `components/ui/command`.
- Produces (used by Task 8):

```tsx
export interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigateProject: (projectId: string) => void;
  onNavigateWorkspace: (w: SearchResultWorkspace) => void;
  onNavigateSession: (s: SearchResultSession) => void;
}
export function QuickSwitcher(props: QuickSwitcherProps): JSX.Element
```

- [ ] **Step 1: Forward `shouldFilter` through CommandDialog**

In `components/ui/command.tsx`, change the `CommandDialog` signature and inner `<Command>` (lines ~32–57):

```tsx
function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  shouldFilter,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  shouldFilter?: boolean
}) {
```

and pass it to the inner `<Command shouldFilter={shouldFilter} className="...unchanged...">`.

- [ ] **Step 2: Create the component**

`apps/vibedeckx-ui/components/search/quick-switcher.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import {
  searchAll, refreshSearchCache,
  type SearchResponse, type SearchResultWorkspace, type SearchResultSession,
} from "@/lib/api";
import { FolderGit2, GitBranch, MessageSquare, Star, RefreshCw } from "lucide-react";

export interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigateProject: (projectId: string) => void;
  onNavigateWorkspace: (w: SearchResultWorkspace) => void;
  onNavigateSession: (s: SearchResultSession) => void;
}

function relativeTime(ms: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function QuickSwitcher({
  open, onOpenChange, onNavigateProject, onNavigateWorkspace, onNavigateSession,
}: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryRef = useRef("");
  queryRef.current = query;

  // Abort in-flight requests on new input so a stale response can never
  // overwrite a newer query's results.
  const runSearch = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await searchAll(q, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setResults(res);
        setError(false);
      }
    } catch {
      if (!controller.signal.aborted) setError(true);
    }
  }, []);

  // Debounced server-side search (cmdk filtering is off).
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(query), 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, runSearch]);

  // On open: instant cached results, then one background cache refresh and a
  // re-query with whatever the user has typed by then.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(false);
    void runSearch("");
    let cancelled = false;
    void refreshSearchCache()
      .then(() => { if (!cancelled) void runSearch(queryRef.current); })
      .catch(() => {});
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [open, runSearch]);

  const empty = !results || (results.projects.length === 0 && results.workspaces.length === 0 && results.sessions.length === 0);
  const syncing = results?.cacheState === "cold";

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick Switcher"
      description="Search projects, workspaces, and sessions"
      shouldFilter={false}
    >
      <CommandInput
        placeholder="Search projects, workspaces, sessions…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {error && (
          <div className="px-4 py-3 text-sm text-destructive flex items-center gap-2">
            Search failed.
            <button className="underline" onClick={() => void runSearch(queryRef.current)}>Retry</button>
          </div>
        )}
        {!error && empty && syncing && (
          <div className="px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" /> Syncing history…
          </div>
        )}
        {!error && empty && !syncing && <CommandEmpty>No results found.</CommandEmpty>}
        {results && results.projects.length > 0 && (
          <CommandGroup heading="Projects">
            {results.projects.map((p) => (
              <CommandItem key={p.id} value={`project-${p.id}`} onSelect={() => onNavigateProject(p.id)}>
                <FolderGit2 />
                <span>{p.name}</span>
                {p.path && <span className="text-muted-foreground text-xs truncate">{p.path}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {results && results.workspaces.length > 0 && (
          <CommandGroup heading="Workspaces">
            {results.workspaces.map((w) => (
              <CommandItem
                key={`${w.projectId}-${w.targetId}-${w.branch ?? ""}`}
                value={`ws-${w.projectId}-${w.targetId}-${w.branch ?? ""}`}
                onSelect={() => onNavigateWorkspace(w)}
              >
                <GitBranch />
                <span>{w.branch ?? "main"}</span>
                <span className="text-muted-foreground text-xs">{w.projectName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {results && results.sessions.length > 0 && (
          <CommandGroup heading="Sessions">
            {results.sessions.map((s) => (
              <CommandItem key={s.sessionId} value={`session-${s.sessionId}`} onSelect={() => onNavigateSession(s)}>
                <MessageSquare />
                <span className="truncate">{s.title ?? "Untitled session"}</span>
                {s.favoritedAt && <Star className="h-3 w-3" />}
                <span className="text-muted-foreground text-xs ml-auto shrink-0">
                  {s.projectName} · {s.branch ?? "main"} · {relativeTime(s.lastActiveAt)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
```

Styling note: match the existing shadcn idiom in `components/agent/` for spacing/typography if the above classNames clash; behavior (debounce, abort, error row, syncing hint, three groups) is the contract.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
pnpm --filter vibedeckx-ui lint
git add apps/vibedeckx-ui/components/
git commit -m "feat(search): QuickSwitcher palette component"
```

---

### Task 8: Wire Cmd+K + navigation into `app/page.tsx`

**Files:**
- Modify: `apps/vibedeckx-ui/app/page.tsx`

**Interfaces:**
- Consumes: `QuickSwitcher` (Task 7); existing `selectProject` (takes a full `Project`), `setSelectedBranch`, `setSessionUrlParam`, `selectBranchSession`, `setActiveView`, `pendingSessionSelectionRef`, `api.updateProjectMode`, `projects` list, `Project.agent_mode`.
- Produces: user-facing Cmd+K / Ctrl+K behavior.

- [ ] **Step 1: Extend `selectBranchSession` for cross-project jumps**

`selectBranchSession` (app/page.tsx:266-276) stamps `pendingSessionSelectionRef.current.projectId` from `currentProject`, which is stale when jumping across projects. Add an optional param:

```tsx
const selectBranchSession = useCallback((branch: string | null, sessionId: string, projectId?: string) => {
  pendingSessionSelectionRef.current = {
    projectId: projectId ?? currentProject?.id,
    branch,
    sessionId,
  };
  setSelectedBranch(branch);
  setSessionUrlParam(sessionId);
  setActivateAgentTabNonce((nonce) => nonce + 1);
}, [currentProject?.id, setSessionUrlParam]);
```

(Existing callers are unchanged — the param is optional.)

- [ ] **Step 2: Add switcher state, Cmd+K listener, and navigation handlers**

In the page component:

```tsx
const [switcherOpen, setSwitcherOpen] = useState(false);

// Cmd/Ctrl+K opens the quick switcher (same pattern as the sidebar's Cmd+B).
useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setSwitcherOpen((o) => !o);
    }
  };
  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}, []);

// Cross-target navigation: agent_mode is the single source of truth for
// which worker a project talks to — switch it (and wait) before navigating.
const resolveProjectForTarget = useCallback(async (projectId: string, targetId: string) => {
  let project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  const desiredMode = targetId === "local" ? "local" : targetId;
  if ((project.agent_mode ?? "local") !== desiredMode) {
    project = await api.updateProjectMode(project.id, "agentMode", desiredMode);
  }
  return project;
}, [projects]);

const handleSwitcherProject = useCallback((projectId: string) => {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  selectProject(project);
  setActiveView("project-info");
  setSwitcherOpen(false);
}, [projects, selectProject]);

const handleSwitcherWorkspace = useCallback(async (w: SearchResultWorkspace) => {
  const project = await resolveProjectForTarget(w.projectId, w.targetId);
  if (!project) return;
  selectProject(project);
  setSelectedBranch(w.branch);
  setSessionUrlParam(null);
  setActiveView("workspace");
  setSwitcherOpen(false);
}, [resolveProjectForTarget, selectProject, setSessionUrlParam]);

const handleSwitcherSession = useCallback(async (s: SearchResultSession) => {
  const project = await resolveProjectForTarget(s.projectId, s.targetId);
  if (!project) return;
  selectProject(project);
  selectBranchSession(s.branch, s.sessionId, s.projectId);
  setActiveView("workspace");
  setSwitcherOpen(false);
}, [resolveProjectForTarget, selectProject, selectBranchSession]);
```

Imports to add: `QuickSwitcher` from `@/components/search/quick-switcher`; `SearchResultWorkspace, SearchResultSession` types from `@/lib/api`.

- [ ] **Step 3: Mount the component**

Next to the other dialogs in the returned JSX:

```tsx
<QuickSwitcher
  open={switcherOpen}
  onOpenChange={setSwitcherOpen}
  onNavigateProject={handleSwitcherProject}
  onNavigateWorkspace={handleSwitcherWorkspace}
  onNavigateSession={handleSwitcherSession}
/>
```

- [ ] **Step 4: Typecheck, lint, commit**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
pnpm --filter vibedeckx-ui lint
git add apps/vibedeckx-ui/app/page.tsx
git commit -m "feat(search): Cmd+K quick switcher wiring with cross-target navigation"
```

---

### Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite + typechecks**

```bash
pnpm --filter vibedeckx test
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
pnpm --filter vibedeckx-ui lint
```
Expected: all green.

- [ ] **Step 2: Manual e2e checklist (dev servers: `pnpm dev:all`, UI on :3000)**

1. Cmd+K opens the palette; Esc closes; ↑/↓ + Enter navigate.
2. Empty query shows recent sessions (and favorited ones first).
3. Typing a project name / branch name / session title fragment surfaces the right group; exact titles rank above substring hits.
4. Selecting a session in ANOTHER project lands on that project's workspace view with the session open (`?session=` set).
5. Selecting a workspace (including "main") switches branch correctly.
6. With a remote project configured: first palette open shows "Syncing history…", second open (within 30 s) is instant and `cacheState` is fresh (check the network tab); remote session titles appear after refresh.
7. Stop the remote worker → palette still returns its cached sessions.
8. Type `%` alone → no results (not everything).
9. Search input while results are loading: type fast, confirm no flicker of stale results (aborted requests).

- [ ] **Step 3: Commit any fixes, then report**

Report deviations from the spec (there should be none beyond the documented "no frontend unit tests") and hand back for review.
