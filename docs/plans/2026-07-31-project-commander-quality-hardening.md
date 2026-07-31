# Project Commander Quality Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the remaining authorization, streaming, identity, atomicity, query-performance, budgeting, and event-ordering gaps in Project Commander.

**Architecture:** Keep Project Commander read-only and project/user scoped. Enforce remote association at the storage boundary immediately before proxying, expose only round-trippable selectors, atomically persist context refs, and adapt AI tools through a turn-scoped concurrency-safe budget. Keep list queries SQL-bounded with deterministic composite indexes.

**Tech Stack:** TypeScript, Vitest, Kysely/SQLite, Vercel AI SDK.

---

### Task 1: Remote association revocation

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.test.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/agent-sessions.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`

1. Add failing tests proving a retained mapping is omitted/rejected after its `project_remotes` association is removed and no proxy/context write occurs.
2. Add scoped mapping list/detail reads joined to the current association, or validate `projectRemotes.getByProjectAndServer` immediately before every proxy.
3. Run the focused remote tool/storage tests to GREEN.

### Task 2: Production stream errors, aborts, and provider ordering

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Add production-runner seam tests for `fullStream` error and abort parts and interleaved text/tool parts.
2. Inject or export the production adapter seam without changing fake-runner behavior.
3. Flush assistant text before tool events, throw a bounded normalized stream error, and map abort to abort/stopped semantics.
4. Run manager tests to GREEN.

### Task 3: Selector round-trip and injective workspace IDs

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.test.ts`

1. Add failing schema-parse tests proving every listed selector is accepted by its detail schema and overlong IDs are skipped.
2. Define `MAX_TOOL_SELECTOR_ID = 512`, use it for list eligibility and detail Zod schemas, and never emit truncated selector IDs.
3. Encode workspace identity injectively with bounded JSON tuple encoding; test null versus `"main"` and delimiter-containing pairs.
4. Run tool tests to GREEN.

### Task 4: Atomic context batches

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Modify: `packages/vibedeckx/src/storage/project-chat.test.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.test.ts`

1. Add RED repository tests for scoped all-or-nothing `touchMany`, including a later invalid ref rolling back earlier refs.
2. Implement one transaction that authorizes the thread and upserts all refs.
3. Replace sequential tool touches with one `touchMany` call per result/detail.
4. Run repository/tool tests to GREEN.

### Task 5: SQL limits, ordering, and indexes

**Files:**
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/agent-sessions.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/search-cache.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/scheduled.ts`
- Modify: `packages/vibedeckx/src/storage/agent-sessions.test.ts`
- Modify: `packages/vibedeckx/src/storage/scheduled-tasks.test.ts`

1. Add RED tests for stable bounded project lists and SQLite index presence/query plans.
2. Add composite indexes for project/order columns and schedule-run join/order columns.
3. Keep `listRecentByProject` as a single SQL join/order/limit and verify its plan/large-seed behavior.
4. Run storage tests to GREEN.

### Task 6: Turn-scoped tool budget

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Add RED AI-adapter tests for more than eight parallel calls and cumulative results over 64 KiB.
2. Wrap adapted tools with a shared per-run budget that synchronously reserves calls, serializes results, and atomically accounts bytes before returning.
3. Emit bounded budget errors and keep `stepCountIs(8)` as a secondary bound.
4. Run manager tests to GREEN.

### Task 7: Verification and commit

1. Run targeted project-chat tool/manager/storage tests.
2. Run `tsc --noEmit`, build, full backend tests, and `git diff --check`.
3. Self-review remote revocation, selector/schema round-trip, atomic context writes, query plans, parallel budget races, and stream event ordering.
4. Commit the scoped changes with a concise hardening message.
