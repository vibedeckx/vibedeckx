# Global Search & Quick Switcher — Design

Date: 2026-07-16
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
- Server-side retention of conversation content (v3, opt-in paid feature).
- Searching files/symbols (exists separately in the Files view).
- Fuzzy-matching engine; v1 uses substring match + recency ranking.

## Roadmap shape

Search capability grows in independent layers, each shippable on its own:

| Layer | What becomes searchable | Where the data lives |
|-------|------------------------|----------------------|
| v1 | project names, branch names, session titles | front server (SQLite, cached) |
| v1.5 | per-session "search summary" (first user message, optional AI one-liner) | front server, ~1 KB/session |
| v2 | full conversation content, online workers only | worker-local FTS5, federated fan-out |
| v3 | full conversation content, offline workers too | front server, **opt-in paid tier** |

## v1 — Quick Switcher

### UX

- Global **Cmd+K / Ctrl+K** opens a `CommandDialog` palette (cmdk + shadcn
  `components/ui/command.tsx` are already installed; no palette is wired up yet).
- Results in three groups: **Projects**, **Workspaces**, **Sessions**. Each row
  shows enough context to disambiguate (session row: title · project · branch ·
  relative last-active time).
- **Empty query state**: recent sessions (ordered by last activity) and
  favorited sessions. This is expected to serve the majority of switches.
- ↑/↓ + Enter to jump. Esc closes. Search input is debounced (~150 ms) and hits
  the server; cmdk client-side filtering is disabled (`shouldFilter={false}`)
  because results come from the API.
- Jumping reuses the existing navigation machinery — no routing changes:
  - Project → `onSelectProject` + `buildUrl("/p/:id/...")`
  - Workspace → same + `?branch=` (lib/url-state.ts)
  - Session → same + the orthogonal `?session=<id>` param
    (`app/page.tsx` history.replaceState mechanism).
- Component: `components/search/quick-switcher.tsx`, mounted in `app/page.tsx`
  (it needs the selection callbacks that live there). Global `keydown` listener
  follows the pattern of the sidebar's Cmd+B toggle (`components/ui/sidebar.tsx`).

### Backend: `GET /api/search?q=<query>&limit=<n>`

Single tenant-scoped endpoint, one SQLite round-trip, no live fan-out on the
request path. Returns `{ projects, workspaces, sessions }`.

Sources (all filtered by the authenticated user's projects — `requireAuth` +
`userId` scoping on every subquery; this is a cross-project aggregation
endpoint, exactly the shape where authz bugs have happened before):

- **Projects**: `projects.name` / `projects.path` substring match.
- **Workspaces**: distinct `branch` values from `agent_sessions` (local) and
  `remote_session_mappings` (remote), per project. Limitation: a branch with no
  sessions yet won't appear — acceptable; branch creation flows already live in
  the sidebar.
- **Sessions**: local `agent_sessions.title` plus the new remote title cache
  (below). Substring match on title.

Ranking: within each group, matches ordered by `last_active_at` desc. Substring
(`LIKE '%q%'`) matching works for CJK queries as-is. Queries must be written as
portable Kysely `LIKE` (case-insensitivity via `lower()`), not SQLite-specific
constructs — the front server is slated to move to Postgres.

Empty `q` returns the recents/favorites payload instead of matches.

### Remote session title cache (stale-while-revalidate)

`remote_session_mappings` currently stores only id/branch mapping. Add:

- `title TEXT`
- `last_active_at INTEGER`

Write path: the existing remote list proxy
(`agent-session-routes.ts` GET `/api/projects/:projectId/agent-sessions`,
remote branch) already upserts one mapping row per remote session — extend the
upsert to persist `title` and `last_active_at` from the proxied response.
Titles also flow through the title PATCH proxy and `session:title` events;
update the cache opportunistically wherever a title transits the server.

Freshness: opening the palette triggers a server-side background refresh —
`GET /api/search` kicks off (fire-and-forget) the same list-proxy logic for any
of the user's remote projects whose cache is older than a TTL (~30 s), bounded
by a per-worker timeout (2 s). The search response itself always returns
cached data immediately; the frontend re-queries on subsequent keystrokes and
naturally picks up refreshed rows. Stale titles are cosmetically harmless for
navigation.

Offline workers: their sessions remain searchable by cached title; jumping into
one shows the existing "remote unavailable" behavior. Rows may carry a
`workerOnline` hint if cheaply available, purely for display.

### Error handling

- Search endpoint never blocks on remotes; proxy failures during background
  refresh are logged and skipped (cache stays stale).
- Frontend treats a failed search request as "no results" with a retry on next
  keystroke; the palette never traps the user (Esc always closes).

### Testing

- Repository: vitest unit tests for the search query (matching, tenant scoping,
  recency ordering, empty-query recents) and the extended mapping upsert.
- Routes: authz test — user A must not see user B's projects/sessions in
  results.
- Manual e2e: palette open latency with a remote project configured; cache
  refresh observable on second query.

## v1.5 — Search summaries (small, high leverage)

Per session, persist on the front server a compact search surface:
first user message (truncated ~500 chars) + optional AI-generated one-line
summary (the title generator infra already exists). ~1 KB/session, a few MB per
tenant. Covers most "recall" queries — users remember *what they asked for*,
which is the first message — without retaining conversation content. Include in
the v1 `sessions` match columns when present. Trust story stays clean: the
server stores task-description-level metadata, not transcripts.

## v2 — Federated full-text content search

Content search over `agent_session_entries` without moving data off workers:

- **Worker-side index**: SQLite **FTS5**, external-content table over extracted
  text (no duplicate storage), maintained in the same transaction as
  `upsertEntry`. No third-party search service — data volume per machine is
  hundreds of MB, well inside FTS5's comfort zone; adding Elasticsearch/
  Meilisearch would add a process (or a centralized privacy problem) for zero
  user-visible gain.
- **Text extraction**: parse the entry JSON, index only user/assistant text
  (optionally touched file paths). Tool params, diffs, and Bash output are
  noise that bloats the index and pollutes results.
- **CJK tokenization**: FTS5's default `unicode61` does not segment CJK. Use
  the built-in `trigram` tokenizer (works for CJK and substring queries).
  Queries shorter than 3 chars fall back to `LIKE` (fast enough at this scale).
- **Endpoint**: worker exposes `GET /api/search/content?q=`, returning matches
  with BM25 rank and `snippet()` highlights.
- **Federation**: front server fans out to the user's online workers through
  the existing reverse-connect proxy (persistent tunnels — one RTT), 1–2 s
  timeout per worker, merges and returns; frontend renders progressively.
  End-to-end latency budget: 100–300 ms typical. Centralizing data purely for
  speed would save one RTT and is not justified.
- Content search results appear in the palette as a fourth group ("Messages")
  with highlighted snippets, likely triggered on Enter or after a longer
  debounce rather than per keystroke.

## v3 — Opt-in server-side retention (paid tier)

Product decision (confirmed direction): offer paid users an option to retain
conversation content on the server so history is searchable **even when the
worker is offline or gone** — the one capability federation cannot provide.

Sketch (full design deferred to its own spec):

- Ingestion: conversation content already transits the server (proxied WS
  streams). Tap the existing stream to persist extracted text; backfill gaps on
  reconnect using `entry_index`. No new worker→server upload protocol.
- Storage/index: Postgres FTS (`tsvector` + `pg_trgm`) once the pg migration
  lands; SQLite FTS5 in the interim. Still no external search service — the
  multi-tenant central index is the only scenario where one could be argued,
  and pg FTS covers it at these volumes.
- Controls: per-project opt-in toggle, retention period setting, hard delete.
  Billing-gated.
- Search merge: server-retained index answers for offline workers; online
  workers can still be queried live (fresher). Dedup by session id.

## Implementation order

1. v1 backend: mapping-table columns + cache write-through + `/api/search` +
   tests.
2. v1 frontend: quick-switcher palette + Cmd+K wiring + navigation glue.
3. v1.5 summaries (optional fast-follow).
4. v2 and v3 as separate specs/plans when scheduled.
