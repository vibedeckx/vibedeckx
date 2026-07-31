# Project Commander Query Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Project Commander task, recent-run, and context-reference database work predictably bounded and migration-safe.

**Architecture:** Add access paths that exactly match the production filters and deterministic ordering. Denormalize a nullable, database-derived `project_id` onto schedule runs so the limit is applied on an indexed project stream, and restrict context-ref batch reads to the composite keys just written.

**Tech Stack:** TypeScript, Kysely, SQLite/better-sqlite3, Vitest.

---

### Task 1: Task list query plans

**Files:**
- Modify: `packages/vibedeckx/src/storage/repositories/workspace.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Test: `packages/vibedeckx/src/storage/workspace.test.ts`

1. Add populated-database EXPLAIN tests for unfiltered, status-filtered, text-filtered, and status-plus-text `queryByProject` variants; require indexed task search and no temporary ordering B-tree.
2. Run the focused test and verify RED because the existing plans scan/sort.
3. Add `id ASC` as the stable tie-breaker and migration-safe indexes `(project_id, archived_at, position, id)` and `(project_id, archived_at, status, position, id)`.
4. Run the focused test and existing workspace tests to verify GREEN.

### Task 2: Globally bounded recent project runs

**Files:**
- Modify: `packages/vibedeckx/src/storage/schema.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/scheduled.ts`
- Test: `packages/vibedeckx/src/storage/scheduled-tasks.test.ts`

1. Add an old-schema upgrade test proving existing rows gain/backfill `project_id`, new writes derive it from their schedule, foreign projects stay excluded, ordering is stable, and the actual recent query uses no full scan or temporary sort.
2. Run the focused test and verify RED because the column/index do not exist and the join sorts globally.
3. Add nullable `project_id` migration/backfill, database consistency triggers, schema/storage typing, and `(project_id, started_at DESC, id DESC)` index.
4. Make run creation derive project scope from the parent schedule and query the indexed run stream directly before LIMIT.
5. Re-run scheduled storage tests and verify GREEN, including reopen/idempotence.

### Task 3: Bounded context-ref batch reads

**Files:**
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Test: `packages/vibedeckx/src/storage/project-chat.test.ts`

1. Seed thousands of historical refs, touch a small batch, and assert the composite-key lookup plan uses the primary-key index and returns only requested rows.
2. Run the focused test and verify RED because production selects every ref for the thread.
3. Replace the thread-wide read with a requested-key predicate inside the existing transaction while preserving scope checks and rollback behavior.
4. Re-run project-chat storage tests and verify GREEN.

### Task 4: Verification and commit

1. Run focused storage/tool/manager tests.
2. Run `tsc --noEmit`, build, the full backend suite, and `git diff --check`.
3. Review migration ordering, FK/trigger behavior, EXPLAIN output, and the full diff.
4. Commit the scoped changes with a concise message and report the SHA and verification counts.
