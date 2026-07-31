# Project Chat Durable Effects Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Project Chat mutations and schedule execution safely recoverable, authenticated, deduplicated, live-retried, and isolated from malformed journal rows.

**Architecture:** Extend the existing typed SQLite operation journal with narrowly named receiver-delivery and execution-claim state. Persist every stable identity before effects, use compare-and-claim repository methods, reconcile authoritative state after gates, and run bounded manager-owned retries.

**Tech Stack:** TypeScript, Fastify, SQLite/Kysely, Vitest, EventBus, existing reverse-connect proxy and process managers.

---

### Task 1: Authenticated split remote session identities and stored-only recovery

**Files:**
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts`
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts`
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Modify: `packages/vibedeckx/src/agent-session-manager.ts`
- Test: route, remote-session, manager, and integration tests beside these files

1. Write failing tests for unauthenticated path create, wrong owner/path/session scope, authorized create/reuse, stored-only row recovery, and separate front/worker IDs through a real front-to-worker route harness.
2. Run focused tests and confirm failures are authorization bypass, `remote-*` worker routing, and stored-only 409.
3. Add typed `workerSessionId`, owner-scoped path resolution, UUID worker identity allocation, mapping recreation, and validated stored-only rehydration/spawn.
4. Run focused tests; review auth, identity namespaces, and collision invariants.
5. Commit the critical slice.

### Task 2: Durable receiver instruction delivery

**Files:**
- Modify: `packages/vibedeckx/src/storage/schema.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/agent-sessions.ts`
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts`
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts`
- Test: storage, route, and remote integration tests

1. Write failing migration/repository tests for pending/sent delivery claims, canonical content hashes, conflicts, and concurrent claims.
2. Write route tests for lost response, pre-write failure retry, sent replay, and conflicting content.
3. Add `agent_instruction_deliveries`, atomic claim/confirm repository methods, and a shared receiver delivery service used by local worker routes.
4. Verify receiver tests and remote Project Chat stable-key delivery; review write-before-confirm semantics.
5. Commit the critical slice.

### Task 3: Durable schedule run/executor claims

**Files:**
- Modify: `packages/vibedeckx/src/storage/schema.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/scheduled-tasks.ts`
- Modify: `packages/vibedeckx/src/scheduler.ts`
- Modify: local/remote executor start APIs as required for deterministic process IDs
- Test: `packages/vibedeckx/src/scheduler.test.ts` and executor route/repository tests

1. Write failing local and remote tests for concurrent same-run calls, crash before spawn, crash after spawn, restart discovery, and spawn failure.
2. Add migration-safe queued/starting states and atomic run claim methods.
3. Derive deterministic local/remote process identity from run ID and make receiver start idempotent.
4. Resume queued/starting claims without duplicate spawn; terminalize spawn rejection.
5. Verify side-effect count exactly one and review both crash boundaries.
6. Commit the critical slice.

### Task 4: Live retries and authoritative confirmation rereads

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Write failing tests for transient create/send/run failures succeeding without restart, persistent bounded retry state, shutdown timer cleanup, and terminal session/run state racing before confirmation.
2. Add injectable retry policy, tracked timers, permanent/transient classification, and authoritative rereads after confirmation.
3. Verify no listener/timer leaks and monotonic final status.
4. Commit.

### Task 5: Durable task create/update reconciliation

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Test: tool and manager tests

1. Write failing tests for crashes before mutation, after mutation before context, and after context before terminal transition for create and update.
2. Expand typed task payloads to complete bounded intents and journal before mutation.
3. Reconcile matching stable creates and idempotent updates; reject foreign/deleted conflicts truthfully.
4. Verify exactly one task and restored context/status.
5. Commit.

### Task 6: Malformed-row isolation and bounded startup continuation

**Files:**
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Test: storage and manager tests

1. Write failing tests with a malformed first row and valid later rows/pages, raw-safe quarantine, observable event failure, slow calls, and operations beyond the initial cap.
2. Add per-row decode results, scoped raw-safe quarantine, structured reconciliation report/logging, initial count/time cap, and tracked background continuation.
3. Replace fixed selector polling failure with durable in-progress return/notification behavior.
4. Verify shutdown cancels continuation and event/listener counts remain stable.
5. Commit.

### Task 7: Final integration and verification

1. Run focused auth/routes/remote/storage/scheduler/tools/manager suites.
2. Run `pnpm exec tsc -p packages/vibedeckx/tsconfig.json --noEmit`.
3. Run `pnpm --filter vibedeckx build`.
4. Run `pnpm --filter vibedeckx test`.
5. Run `git diff --check`, inspect the complete diff, and perform invariant review for scope, claims, crash windows, boundedness, and shutdown cleanup.
6. Commit any direct minor fixes with their tests and report all verification evidence.
