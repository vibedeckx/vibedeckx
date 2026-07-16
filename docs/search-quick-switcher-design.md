# Global Search & Quick Switcher — Design

Date: 2026-07-16 (revised twice same day after external design review rounds)
Status: approved direction, pending implementation plan

## Problem

As the number of projects grows, finding the right project / workspace (branch) /
agent session requires walking the sidebar tree: select project → select branch →
scan sessions. With N projects × M branches × K sessions this is the dominant
navigation cost. Users need a single search box that finds any of the three and
jumps straight to it.

Primary deployment target is the SaaS form factor: a front server
(vibedeckx.dev, Docker, Clerk multi-tenant) plus reverse-connect workers owned
by the user. In this topology **session data lives on the workers**, not the
front server — the server's `agent_sessions` table is (nearly) empty and remote
session titles are fetched live through the proxy on every list request. The
design must work in that topology first; the solo/local form factor falls out
as the degenerate case (everything local, no fan-out).

## Non-goals (v1)

- Full-text search over conversation content (v2, federated).
- Server-side retention of conversation content (v3, opt-in paid feature; the
  v1.5 summary layer is a scoped-down instance of the same thing and shares its
  consent/retention mechanics).
- Searching files/symbols (exists separately in the Files view).
- Fuzzy-matching engine; v1 uses exact/prefix/substring tiers, no fuzzy.
- Incremental (cursor-based) catalog sync — full snapshots are small enough at
  current scale; the catalog endpoint leaves room to add `updatedAfter` later.

## Roadmap shape

Search capability grows in independent layers, each shippable on its own:

| Layer | What becomes searchable | Where the data lives |
|-------|------------------------|----------------------|
| v1 | project names, workspaces (worktrees/branches), session titles | front server (SQLite, cached) |
| v1.5 | per-session first-user-message snippet — **opt-in retention** | front server, ~1 KB/session |
| v2 | full conversation content, online workers only | worker-local FTS5, federated fan-out |
| v3 | full conversation content, offline workers too | front server, **opt-in paid tier** |

## v1 — Quick Switcher

### UX

- Global **Cmd+K / Ctrl+K** opens a `CommandDialog` palette (cmdk + shadcn
  `components/ui/command.tsx` are already installed; no palette is wired up yet).
  Quick-switch searches **only** projects/workspaces/sessions; content search
  (v2) gets its own entry point (e.g. Cmd+Shift+F) rather than mixing message
  hits into the switcher.
- Results in three groups: **Projects**, **Workspaces**, **Sessions**. Each row
  shows enough context to disambiguate (session row: title · project · branch ·
  relative last-active time).
- **Empty query state**: recent sessions (ordered by last activity) and
  favorited sessions. This is expected to serve the majority of switches.
- ↑/↓ + Enter to jump. Esc closes. Search input is debounced (~150 ms) and hits
  the server; cmdk client-side filtering is disabled (`shouldFilter={false}`).
  In-flight requests are aborted on new input (AbortController) so a stale
  response can never overwrite a newer query's results.
- A failed search request shows an error row with retry — not an empty
  "No results" state. A cold or refreshing cache (`cacheState` from the API,
  below) shows a "syncing history…" hint instead of "No results".
- Jumping reuses the existing navigation machinery — no URL-schema changes:
  - Project → `onSelectProject` + `buildUrl("/p/:id/...")`
  - Workspace → same + `?branch=` (lib/url-state.ts)
  - Session → same + the orthogonal `?session=<id>` param
    (`app/page.tsx` history.replaceState mechanism).
- **Cross-target navigation**: search results carry `targetId`
  (`"local"` or a remote server id). If a result's target differs from the
  project's current `agent_mode`, the click handler first PATCHes the project
  (`agent_mode` update — existing PUT route supports it), awaits success, then
  switches branch/session. This keeps `agent_mode` the single source of truth
  for which worker a project talks to, matching how the list proxy resolves it
  today. Putting the target into the URL state (stable deep links to a
  specific worker) is a future enhancement — it would need reconciliation
  rules between URL and persisted `agent_mode` and is out of v1 scope.
- Component: `components/search/quick-switcher.tsx`, mounted in `app/page.tsx`
  (it needs the selection callbacks that live there). Global `keydown` listener
  follows the pattern of the sidebar's Cmd+B toggle (`components/ui/sidebar.tsx`).

### Worker catalog endpoint: `GET /api/path/search-catalog?path=`

The existing session list endpoints are deliberately branch-scoped (both the
project-id and path variants always filter by branch to avoid leaking other
branches' sessions into the dropdown), so they cannot enumerate a project's
full workspace/session set for cache refresh. New worker-side endpoint, one
call per (project path):

```
{
  snapshotAt: number,
  workspaces: [{ branch }],                     // from git worktree enumeration
  sessions:   [{ id, branch, title, lastActiveAt, favoritedAt, entryCount }]
}
```

- `workspaces` comes from the same worktree enumeration the sidebar uses
  (`getWorktreeBranches`), so worktrees **without** sessions are searchable
  too (the session-derived-only approach missed them). No `updatedAt` — git
  worktree enumeration doesn't provide one; workspace ranking falls back to
  branch-name ordering within a match tier (a recency signal can later be
  derived from session activity on the branch).
- **Branch sentinel convention**: the API uses `branch: null` for the main
  workspace (matching `getWorktreeBranches`); the DB uses the empty-string
  `""` sentinel (matching the existing `agent_sessions` convention). The
  repository layer converts at the boundary in both directions — no other
  layer may do its own conversion. Main-workspace rows must round-trip
  (upsert, search, navigate) under test.
- `sessions` applies the same `shouldShowBranchSessionInList` filtering as the
  dropdown (hide empty sessions).
- Full snapshot per call — no cursor/`updatedAfter` in v1 (payload is a few KB
  to tens of KB per project at realistic scale). The full snapshot doubles as
  deletion detection: anything cached but absent from the snapshot is marked
  deleted.
- The local (non-remote) case calls the same logic in-process instead of over
  HTTP.

### Server-side search cache

`remote_session_mappings` stays **routing-only** (id/branch mapping for
URL → proxy resolution); reconciling a search cache must never delete mapping
rows that old session URLs depend on. New tables:

```
session_search_cache
  local_session_id TEXT PRIMARY KEY
  project_id TEXT NOT NULL
  target_id TEXT NOT NULL           -- "local" or remote server id
  branch TEXT NOT NULL              -- "" sentinel for main
  title TEXT
  last_active_at INTEGER
  favorited_at INTEGER
  entry_count INTEGER
  generation INTEGER NOT NULL      -- snapshot generation that last contained this row
  deleted_at INTEGER               -- set when absent from a newer snapshot

workspace_search_cache
  project_id TEXT NOT NULL
  target_id TEXT NOT NULL           -- "local" or remote server id
  branch TEXT NOT NULL              -- "" sentinel for main
  generation INTEGER NOT NULL
  deleted_at INTEGER
  PRIMARY KEY (project_id, target_id, branch)

search_catalog_sync_state
  project_id TEXT NOT NULL
  target_id TEXT NOT NULL
  last_success_at INTEGER
  last_attempt_at INTEGER
  snapshot_generation INTEGER NOT NULL DEFAULT 0
  last_error TEXT
  PRIMARY KEY (project_id, target_id)
```

`workspace_search_cache.target_id` covers **both local and remote**: local
worktree enumeration spawns git subprocesses, so it runs during refresh and is
cached like remote data — `GET /api/search` reads only the database.
`session_search_cache` holds **remote targets only** in v1: local sessions
already live in this same database (`agent_sessions`) and are UNIONed into the
search query directly — copying them into the cache would be pointless
double-writing. (The `target_id` column keeps the generic name so local rows
can be added later if that ever changes.) `target_id` is part of workspace identity because a project can have
multiple remotes configured (`project_remotes` is UNIQUE(project_id,
remote_server_id)); cached rows from a previously-active remote must not
collide with the current one. Favorited state for remote sessions lives on the
worker (the favorite route proxies), so it must be cached here for the
empty-query favorites view.

**Sync state is per (project, target), not per row.** Row-level timestamps
cannot represent "successfully synced an empty catalog" (no rows to stamp) or
distinguish it from "never synced" — the TTL check reads
`search_catalog_sync_state.last_success_at`. Reconciliation is
generation-based, in one transaction after a **fully successful** catalog
fetch: bump `snapshot_generation`, upsert snapshot rows with the new
generation (clearing `deleted_at` on rows that reappear), mark rows of the
same (project, target) with an older generation as deleted, update
`last_success_at`. A timeout, partial failure, or parse failure records
`last_attempt_at`/`last_error` and **never runs deletion reconciliation**.

Opportunistic freshness: wherever titles/favorites already transit the server
(list proxy, title PATCH proxy, `session:title` events), update the cache rows
in passing (without touching generation).

### Refresh: explicit, singleflight, never on the search path

- `GET /api/search?q=` is **cache-only** — it never triggers proxy traffic or
  subprocesses.
- `POST /api/search/refresh` is called once when the palette opens. Per
  (project, target) it applies a TTL (~30 s against
  `sync_state.last_success_at`, skip if fresh) and singleflight (concurrent
  refreshes coalesce). Fan-out is **grouped by worker** — many projects can
  point at the same worker, so concurrency is capped per worker (e.g. 3
  catalog calls in flight) with a per-call timeout (2 s) and an **overall
  refresh deadline** (~5 s) after which the endpoint returns with whatever
  completed. The frontend re-queries once on completion — no SSE/versioning
  machinery needed for v1.
- The refresh (and search) response includes `cacheState: cold | stale |
  fresh` derived from sync state, so the palette can distinguish "still
  syncing" from "genuinely no results".
- Proxy failures during refresh are logged into `sync_state.last_error` and
  skipped; cache stays stale. Stale titles are cosmetically harmless for
  navigation.
- Offline workers: their sessions remain searchable by cached title; jumping
  into one shows the existing "remote unavailable" behavior.

### Search endpoint: `GET /api/search?q=<query>&limitPerGroup=<n>`

Single tenant-scoped endpoint, one SQLite round-trip. Returns
`{ projects, workspaces, sessions }`, capped **per group** (default 10).

Sources (all filtered by the authenticated user's projects — `requireAuth` +
`userId` scoping on every subquery; this is a cross-project aggregation
endpoint, exactly the shape where authz bugs have happened before):

- **Projects**: `projects.name` / `projects.path`.
- **Workspaces**: `workspace_search_cache` (local + remote targets alike).
- **Sessions**: local `agent_sessions` UNION `session_search_cache` (remote),
  excluding `deleted_at` rows.
- Remote-target rows are **joined against `project_remotes`** so caches for a
  remote that has since been unlinked from the project drop out of results
  automatically (self-healing; no unlink-time cleanup hook required).

Query handling:

- Max query length 256 chars; `%`, `_`, and the escape char are escaped before
  building `LIKE` patterns.
- Matching/ranking tiers: exact match > prefix match > substring match;
  favorited rows get a boost within their tier; `last_active_at` desc breaks
  ties. (Implemented as a computed rank column in the query — portable SQL.)
- Substring `LIKE` works for CJK queries as-is. Queries must be portable
  Kysely (case-insensitivity via `lower()`), not SQLite-specific — the front
  server is slated to move to Postgres.
- Empty `q` returns the recents/favorites payload instead of matches.

### Testing

- Repository: vitest unit tests for the search query (tier ranking, tenant
  scoping, LIKE-wildcard escaping, empty-query recents, deleted_at exclusion,
  unlinked-remote rows excluded via project_remotes join, main-workspace ""
  sentinel round-trip) and snapshot reconciliation (upsert, generation-based
  mark-deleted, reappearing rows clear deleted_at, **failed/partial snapshot
  never deletes**, empty snapshot updates sync state, mapping table untouched).
- Routes: authz test — user A must not see user B's projects/sessions in
  results; refresh singleflight/TTL behavior; cacheState cold vs fresh.
- Frontend: stale-request cancellation (old response must not overwrite newer
  query), cross-target navigation (agent_mode PATCH before branch/session
  switch), main-workspace navigation from a search result.
- Manual e2e: palette open latency with a remote project configured; second
  query reflects refreshed titles; worker offline → cached results still shown.

## v1.5 — First-message snippets (opt-in lightweight retention)

Persist on the front server, per session, the first user message (truncated
~500 chars) and include it in the v1 sessions match columns. Users typically
remember *what they asked for*, so this covers many "recall" queries cheaply
(~1 KB/session).

This **is** conversation content — first messages routinely contain code,
customer data, tokens, or internal paths. It is therefore not framed as
metadata: it requires the same explicit opt-in, retention, and deletion
mechanics as v3 (it is effectively v3's smallest increment, shipped early).
An AI-generated one-line summary is explicitly deferred — validate first
whether first-message search actually improves recall before adding generation
cost.

## v2 — Federated full-text content search

Content search over conversation entries without moving data off workers.
Separate entry point from the quick switcher (Cmd+Shift+F / "Search history"),
so message hits don't add noise and latency to navigation.

- **Extraction table**: new worker-side `session_search_documents` table
  storing extracted plain text (user/assistant text, optionally touched file
  paths) per entry — tool params, diffs, and Bash output are noise. FTS5
  **external-content** requires the content source to serve the indexed
  columns (snippet/highlight read from it), so the extracted text must be
  materialized; pointing FTS at the raw entry JSON does not work.
- **Index**: FTS5 external-content over `session_search_documents`, maintained
  in the same transaction as `upsertEntry`. No third-party search service —
  per-machine volume (hundreds of MB) is well inside FTS5's comfort zone.
- **CJK tokenization**: built-in `trigram` tokenizer. Queries shorter than
  3 chars cannot use the trigram index; whether to allow them via `LIKE` over
  the documents table (a scan) or enforce a 3-char minimum is decided by
  benchmark on realistic data, not assumed.
- **Worker endpoint**: `POST /api/search/content` (query in the body, not the
  URL — search terms are user content and must not land in access logs, proxy
  logs, or monitoring; responses carry `Cache-Control: no-store` and the query
  body is excluded from request logging). Returns matches with local rank and
  `snippet()` highlights.
- **Federation & merging**: front server fans out through the existing
  reverse-connect tunnels (persistent — one RTT), 1–2 s per-worker timeout.
  Raw BM25 scores are **not comparable across workers** (corpus-dependent
  statistics), so the server merges by Reciprocal Rank Fusion over each
  worker's local ranking, with a recency weight.
- **Response shape**: first iteration returns a single JSON response after all
  workers answer or time out (worst case ~2 s, acceptable for an explicit
  search action). If progressive rendering proves necessary, that's an
  explicit protocol change (SSE or NDJSON) — a plain JSON endpoint cannot
  stream partial results.

## v3 — Opt-in server-side retention (paid tier)

Product decision (confirmed direction): offer paid users an option to retain
conversation content on the server so history is searchable **even when the
worker is offline or gone** — the one capability federation cannot provide.
Gets its own spec; requirements that spec must cover:

- **Ingestion**: tapping the proxied WS stream is the cheap bulk path, but it
  is not sufficient by itself — content produced while the server⇄worker link
  is down never transits the tap, and deletions/imports don't appear on the
  stream at all. The protocol needs: per-session watermark (entry_index /
  version) with reconnect backfill, idempotent writes, and tombstone-based
  deletion sync.
- **Lifecycle**: retention period settings, plan-downgrade behavior (what
  happens to retained data when the subscription lapses), hard delete, export.
- **Security**: encryption at rest, audit of access.
- **Query-time version selection**: when a worker is online, its live index is
  fresher than the server replica — define which answers and how results dedup
  (by session id).
- Storage/index: Postgres FTS (`tsvector` + `pg_trgm`) once the pg migration
  lands; SQLite FTS5 in the interim. Still no external search service — revisit
  only if real multi-tenant scale/SLO data shows pg FTS insufficient.

## Implementation order (v1)

1. Worker catalog endpoint (`/api/path/search-catalog`) + local in-process
   equivalent (branch sentinel conversion at the repository boundary).
2. Server cache tables + sync-state table + generation-based reconciliation +
   refresh endpoint (singleflight/TTL, per-worker concurrency cap, overall
   deadline) + tests.
3. Cache-only `GET /api/search` (ranking tiers, escaping, authz,
   project_remotes join, cacheState) + tests.
4. Quick Switcher palette + Cmd+K wiring + navigation glue (incl. cross-target
   agent_mode switch) + e2e pass.
5. v1.5, v2, v3 as separate specs/plans when scheduled.
