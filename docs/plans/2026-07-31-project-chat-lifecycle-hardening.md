# Project Chat Lifecycle Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make stop, terminal completion, delete, and shutdown bounded and retry-safe while restoring the approved public `operation` message contract.

**Architecture:** A shared local detach primitive fences an active turn immediately, independently of persistence. Stop then durably terminalizes the exact attempt; shutdown makes reset best-effort within a second bound; delete skips reset and relies on the cascading delete. Normal model completion remains active in a pending-terminal phase and retries the same atomic finish transaction with bounded backoff, while deletion uses a transient closing fence and only commits a permanent tombstone after storage deletion succeeds.

**Tech Stack:** TypeScript, Vitest, Kysely, SQLite, Fastify.

---

### Task 1: Restore the operation-message contract

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Test: `packages/vibedeckx/src/storage/project-chat.test.ts`
- Test: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Add a failing storage test that appends a legitimate `operation` message and proves work rows remain absent from transcript/model/WS output.
2. Run the focused test and confirm the SQL/type contract fails.
3. Restore `operation` to `ProjectChatMessageType` and the fresh-table CHECK constraint; remove only the mistaken rejection assertion.
4. Run storage and manager tests to green.

### Task 2: Bound REST stop and stalled detach persistence

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Test: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Add failing tests for an abort-ignoring runner with queued work, late output, and stalled/rejected reset persistence.
2. Verify stop/shutdown currently exceed the injected deadline or leave the thread running.
3. Extract a local detach operation that invalidates the turn token and releases the queue before storage I/O.
4. For stop, race exact-attempt stopped terminalization against the configured timeout and contain rejection; for shutdown, race `markAccepted` against the timeout and contain rejection; for delete, skip reset and continue to cascading deletion.
5. Run the adversarial manager tests to green.

### Task 3: Retry terminal persistence while the live turn remains active

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Test: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Replace the existing fail-once expectation with a failing subscriber-visible retry test and add a persistent-failure bounded retry test.
2. Add injectable terminal retry delay/count options.
3. Keep the active work/status until the same atomic finish succeeds or the bounded retry policy is exhausted; never rerun the model or duplicate public events.
4. On exhaustion, detach locally and leave the journal nonterminal for recovery without unhandled rejection or spin.
5. Run manager tests to green.

### Task 4: Make deletion retryable and route results truthful

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/routes/project-chat-routes.ts`
- Test: `packages/vibedeckx/src/project-chat-manager.test.ts`
- Test: `packages/vibedeckx/src/routes/project-chat-routes.test.ts`

1. Add failing fail-once storage-delete and route-false tests.
2. Use generation plus `closingThreads` as the in-progress fence; set `deleted=true` only after storage delete commits.
3. On failure, clear the live/loading cache and closing fence, retain the advanced generation, and permit a fresh open/delete retry.
4. Make DELETE return 404 when the manager reports false and propagate storage failures as 500.
5. Run manager and route tests to green.

### Task 5: Documentation and verification

**Files:**
- Modify: `docs/plans/2026-07-31-project-chat-work-journal-design.md`

1. Document the configurable 30-second idle grace, exact drain policies, attempt fencing, retryable deletion, and public `operation` messages.
2. Run focused adversarial tests, all project-chat tests, typecheck, build, full backend, and `git diff --check`.
3. Request an independent Critical/Important-only lifecycle re-review.
4. Commit the verified changes.
