# Storage Async + Kysely Rewrite — Design

**Date:** 2026-07-05
**Status:** Approved for planning
**Scope:** Phase "B" — make the `Storage` interface async and rewrite the sqlite backend's query layer on Kysely, with zero behavior change. A Postgres backend is explicitly out of scope for this phase but is the reason this phase exists.

## Motivation

Vibedeckx's SaaS deployment will need Postgres on the server side for stability, concurrent multi-user writes, managed backups. Remote nodes will **always** use sqlite. Both backends must therefore coexist in the same npm package, selected at runtime by configuration.

Two obstacles stand between today's code and that goal:

1. **The `Storage` interface is synchronous.** better-sqlite3 returns values directly; every Postgres driver is async. Converting the interface — and its ~38 calling files — to async is unavoidable, and gets more expensive the longer it waits.
2. **~2,200 lines of hand-written sqlite SQL.** Maintaining a second hand-written pg copy would double every future schema change. A dialect-portable query layer lets both backends share one query codebase.

## Decision: Kysely

[Kysely](https://kysely.dev) — a type-safe SQL query builder (not a heavyweight ORM).

- One set of table type definitions; the dialect (better-sqlite3 or pg, both built in) is injected at runtime. Query code is dialect-agnostic.
- Pure JS, no binary engines — safe for npm CLI distribution (Prisma's engine binaries ruled it out).
- Drizzle was rejected because its sqlite and pg schemas are separate APIs (`sqliteTable` / `pgTable`), forcing two schema definitions — exactly the duplication we're trying to avoid.
- Hand-writing a second pg implementation was rejected: highest long-term cost (every change × 2).

New dependency: `kysely` only. better-sqlite3 stays.

## Design

### 1. Interface change (`storage/types.ts`)

Every method of the `Storage` interface returns `Promise<T>`. Signatures and semantics are otherwise unchanged (`getById(id, userId?) => Promise<Project | undefined>`). Entity types (`Project`, `Executor`, …) are untouched; callers receive identically-shaped objects.

### 2. New structure

```
storage/
  types.ts        # Storage interface (async) + entity types; no DB details
  schema.ts       # Kysely Database table types (one set, shared by both dialects)
  repositories.ts # All query logic: takes a Kysely<DB> instance, returns a Storage
                  # implementation (may split into repositories/*.ts by size)
  sqlite.ts       # sqlite backend: create better-sqlite3 → run existing DDL/
                  # migrations → wrap the same db instance in Kysely
```

Key invariant: **repositories depend only on the Kysely instance and never know the dialect.** Adding pg later means a new `postgres.ts` (pg pool + pg bootstrap DDL) plus a handful of dialect helpers (e.g. boolean 0/1 vs native, JSON columns) injected into the repositories — zero changes to query code.

### 3. DDL / migration strategy — deliberately untouched this phase

The existing "startup CREATE TABLE IF NOT EXISTS + idempotent ALTER TABLE patches" code is **kept verbatim**, running on the raw better-sqlite3 handle (Kysely's SqliteDialect wraps that same instance, so DDL and queries share one connection). Rationale: this code is battle-tested against every user database in the wild; rewriting it as a Kysely Migrator is high risk, zero reward.

**Postgres-era migration path (documented now, built later):**

- *Frozen baseline:* the sqlite legacy bootstrap never changes again. pg gets a one-time fresh-create script (no pg databases exist, so no incremental history is needed). This is the only "written twice" moment.
- *Shared incremental migrations:* after the baseline, every schema change is written **once** using Kysely's schema builder (`addColumn`, `createTable` — dialect-portable) in a shared ordered migration list that both backends run at startup. Only rare dialect-sensitive changes need an `if (dialect)` branch.
- This phase creates the mount point: sqlite startup = frozen legacy migrations → shared incremental list (empty today).

### 4. Caller conversion + race audit

All ~38 calling files gain `await`. Two categories need care:

- **Sync-context call sites** (constructors, event callbacks, getters using return values inline) must become async or be restructured. This is the main workload uncertainty; `tsc` exposes every one — none can be missed silently.
- **Race audit:** with sync storage, two consecutive calls could never be interleaved by another request; after asyncification every `await` is a yield point. Since the SaaS deployment is **multi-user**, read-then-write sequences at call sites (check-then-create, read-modify-write) are real race windows under pg. Individual storage methods remain internally atomic (sync under sqlite; single statement or transaction under pg). Any cross-call sequence found to depend on non-interleaving is pushed down into a single storage method (which may use a transaction internally). The audit's findings are reported in the delivery notes.

## Acceptance criteria

- Backend `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` clean.
- `scheduled-tasks.test.ts` passes (rewritten for the async interface).
- Production build boots against a **pre-existing** sqlite database and a smoke pass succeeds: project list, agent session history replay, executor run records, scheduled tasks all read/write correctly — proving zero breakage of existing data.
- No behavior or measurable performance change for sqlite users (the sync engine still executes underneath; per-call overhead is one promise/microtask, sub-microsecond).

## Out of scope

- Postgres backend implementation (`postgres.ts`, pg bootstrap DDL, connection config).
- Rewriting the legacy sqlite migration code.
- Any schema changes.
