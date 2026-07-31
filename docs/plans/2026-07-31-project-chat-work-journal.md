# Project Chat Work Journal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace transcript scheduling markers with an atomic internal work journal and make Project Chat recovery, deletion, shutdown, and eviction deterministic.

**Architecture:** SQLite/Kysely owns accepted work state through a dedicated repository. The manager hydrates public messages and work items separately, fences asynchronous continuations with lifecycle generations, and detaches abort-ignoring runners after an injected timeout.

**Tech Stack:** TypeScript, Kysely, SQLite, Vitest, Fastify WebSockets.

---

### Task 1: Add the work journal schema and repository contracts

**Files:**
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Modify: `packages/vibedeckx/src/storage/schema.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Test: `packages/vibedeckx/src/storage/project-chat.test.ts`

1. Add failing tests for table constraints, cascade deletion, recovery index, atomic acceptance, in-transaction sequence allocation, and rollback when thread touch/validation fails.
2. Run `pnpm --filter vibedeckx exec vitest run src/storage/project-chat.test.ts` and confirm the missing repository/table failures.
3. Add `ProjectChatWorkItem`, status types, schema mapping, and repository methods:
   - `accept({id,user_message_id,thread_id,project_id,user_id,content})`
   - `listNonterminal(threadId,projectId,userId)`
   - `markRunning(id,threadId)`
   - `finish({id,thread scope,status,error,turnEndId,turnEndContent})`
4. Ensure `accept` calculates `max(sequence)+1` inside its transaction and validates the scoped thread update count.
5. Ensure `finish` appends `turn_end` and updates journal status in one transaction.
6. Rerun the storage test until GREEN and commit.

### Task 2: Recover all accepted work without transcript markers

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Add RED tests for first idle-turn acceptance followed by crash/restart, accepted/running recovery, terminal suppression, no duplicate user message, and no `operation` entries in transcript/model input.
2. Replace `QueuedTurn` marker fields with a persisted work item ID and user message.
3. Change send acceptance to call journal `accept`, then append the returned user message to live state/broadcast and queue the work.
4. Hydrate `listByThread` and `listNonterminal` together; queue nonterminal work in creation order.
5. Mark work running before invoking the runner and use journal `finish` for terminal state.
6. Remove marker emission and marker parser recovery.
7. Run manager tests until GREEN and commit.

### Task 3: Fence hydration, acceptance, and shutdown

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Add RED tests for delete during deferred hydration and send deferred in authorization/hydration while shutdown completes.
2. Add per-thread generation records and permanent deletion tombstones.
3. Capture/recheck generation after every async authorization, load, and accept boundary.
4. Track outstanding load/accept promises and await their settlement during shutdown without allowing their continuation to enqueue work.
5. Reject or settle every send continuation after shutdown/deletion fencing.
6. Run manager tests until GREEN and commit.

### Task 4: Bound cancellation and contain background failures

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Add RED tests where a runner ignores `AbortSignal` during delete and shutdown, later yields output, and where terminal persistence fails.
2. Add constructor options with a default 2000 ms drain timeout.
3. Invalidate a turn token before bounded draining; every append/broadcast checks the token and lifecycle generation.
4. Detach timed-out work after observing its eventual resolution/rejection; never let late output mutate storage/live state.
5. Make pump observe every run rejection and leave terminal-persistence failures nonterminal for recovery.
6. Run manager tests until GREEN and commit.

### Task 5: Preserve public REST/WS contracts and evict idle state

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.test.ts`
- Modify: `packages/vibedeckx/src/routes/project-chat-routes.test.ts`
- Modify: `packages/vibedeckx/src/routes/project-chat-websocket-routes.test.ts`

1. Add RED tests proving journal rows never appear in snapshots, model input, or JSON Patch frames, and that idle unsubscribed threads evict/rehydrate while active/subscribed threads remain.
2. Keep public user messages broadcast only after atomic acceptance commits.
3. Add eviction checks after unsubscribe and idle transition, with an injectable observer/test hook only if necessary.
4. Update message-index assertions after operation-marker removal.
5. Run focused manager/REST/WS tests until GREEN and commit.

### Task 6: Verify and review

**Files:**
- Review all files changed since `ff68dec85a5f8d16e3c7a8ce9ba47b213280a3d3`.

1. Run focused storage, manager, REST, and WebSocket tests.
2. Run `pnpm --filter vibedeckx exec tsc --noEmit -p tsconfig.json`.
3. Run `pnpm --filter vibedeckx build`.
4. Run the full backend test suite.
5. Run `git diff --check` and inspect status/diff scope.
6. Request an independent code review against the approved design; fix all Critical/Important findings via RED/GREEN.
7. Commit the final verified implementation and report schema, evidence, tradeoffs, and SHAs.
