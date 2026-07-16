# Global Search & Quick Switcher — Design

Date: 2026-07-16 (revised same day after external design review)
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
  "No results" state.
- Jumping reuses the existing navigation machinery — no routing changes:
  - Project → `onSelectProject` + `buildUrl("/p/:id/...")`
  - Workspace → same + `?branch=` (lib/url-state.ts)
  - Session → same + the orthogonal `?session=<id>` param
    (`app/page.tsx` history.replaceState mechanism).
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
  workspaces: [{ branch, updatedAt }],          // from git worktree enumeration
  sessions:   [{ id, branch, title, lastActiveAt, favoritedAt, entryCount }]
}
```

- `workspaces` comes from the same worktree enumeration the sidebar uses, so
  worktrees **without** sessions are searchable too (the session-derived-only
  approach missed them).
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
remote_session_cache
  local_session_id TEXT PRIMARY KEY
  project_id TEXT NOT NULL
  remote_server_id TEXT NOT NULL
  branch TEXT
  title TEXT
  last_active_at INTEGER
  favorited_at INTEGER
  entry_count INTEGER
  last_seen_at INTEGER NOT NULL     -- last snapshot that contained this row
  deleted_at INTEGER                -- set when absent from a newer snapshot

remote_workspace_cache
  project_id TEXT NOT NULL
  remote_server_id TEXT NOT NULL
  branch TEXT NOT NULL
  updated_at INTEGER
  last_seen_at INTEGER NOT NULL
  deleted_at INTEGER
  PRIMARY KEY (project_id, remote_server_id, branch)
```

`remote_server_id` is part of workspace identity because a project can have
multiple remotes configured (`project_remotes` is UNIQUE(project_id,
remote_server_id)); cached rows from a previously-active remote must not
collide with the current one. Favorited state for remote sessions lives on the
worker (the favorite route proxies), so it must be cached here for the
empty-query favorites view.

Opportunistic freshness: wherever titles/favorites already transit the server
(list proxy, title PATCH proxy, `session:title` events), update the cache rows
in passing.

### Refresh: explicit, singleflight, never on the search path

- `GET /api/search?q=` is **cache-only** — it never triggers proxy traffic.
- `POST /api/search/refresh` is called once when the palette opens. Per
  (project, remote) it applies a TTL (~30 s, skip if fresh) and singleflight
  (concurrent refreshes coalesce). Fan-out to the user's remotes runs in
  parallel with a per-worker timeout (2 s); the endpoint returns when done
  (bounded by the timeout), and the frontend re-queries once on completion —
  no SSE/versioning machinery needed for v1.
- Proxy failures during refresh are logged and skipped; cache stays stale.
  Stale titles are cosmetically harmless for navigation.
- Offline workers: their sessions remain searchable by cached title; jumping
  into one shows the existing "remote unavailable" behavior.

### Search endpoint: `GET /api/search?q=<query>&limitPerGroup=<n>`

Single tenant-scoped endpoint, one SQLite round-trip. Returns
`{ projects, workspaces, sessions }`, capped **per group** (default 10).

Sources (all filtered by the authenticated user's projects — `requireAuth` +
`userId` scoping on every subquery; this is a cross-project aggregation
endpoint, exactly the shape where authz bugs have happened before):

- **Projects**: `projects.name` / `projects.path`.
- **Workspaces**: `remote_workspace_cache` (remote) + distinct branches from
  local `agent_sessions` + local worktree enumeration for local projects.
- **Sessions**: local `agent_sessions.title` + `remote_session_cache.title`,
  excluding `deleted_at` rows.

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
  scoping, LIKE-wildcard escaping, empty-query recents, deleted_at exclusion)
  and snapshot reconciliation (upsert, mark-deleted, mapping table untouched).
- Routes: authz test — user A must not see user B's projects/sessions in
  results; refresh singleflight/TTL behavior.
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
- **Worker endpoint**: `GET /api/search/content?q=` returning matches with
  local rank and `snippet()` highlights.
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
   equivalent.
2. Server cache tables + snapshot reconciliation + refresh endpoint
   (singleflight/TTL) + tests.
3. Cache-only `GET /api/search` (ranking tiers, escaping, authz) + tests.
4. Quick Switcher palette + Cmd+K wiring + navigation glue + e2e pass.
5. v1.5, v2, v3 as separate specs/plans when scheduled.
