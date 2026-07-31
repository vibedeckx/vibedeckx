# Project Chat Mutations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tightly authorized Project Commander mutations, explicit restart-safe workspace selection, and exact persistent session/schedule event correlations.

**Architecture:** Extend the project-chat storage boundary with a single operation repository and versioned discriminated payloads. Expose narrow injected mutation services from the tool factory, and let `ProjectChatManager` translate exact EventBus matches into persistence-first operation updates without reactive model turns.

**Tech Stack:** TypeScript, Zod, Kysely, SQLite, Vitest, Vercel AI SDK tools, Node EventEmitter.

---

### Task 1: Operation Persistence

**Files:**
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Modify: `packages/vibedeckx/src/storage/schema.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Test: `packages/vibedeckx/src/storage/project-chat.test.ts`

1. Write failing real-SQLite tests for idempotent migration, thread cascade, exact correlation indexes, authorized bounded lookups, deterministic transition insertion, and terminal-state monotonicity.
2. Run `pnpm --filter vibedeckx test -- src/storage/project-chat.test.ts`; confirm failures name the missing operation API/table.
3. Add the minimal typed table, migration, repository, and storage wiring. Store versioned bounded payload JSON and immutable operation identity/scope.
4. Re-run the focused test and preserve all existing project-chat storage tests.
5. Commit the persistence slice.

### Task 2: Mutation Tool Capability and Authorization

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Test: `packages/vibedeckx/src/project-chat-tools.test.ts`

1. Write failing tests for the exact five mutation names plus `select_workspace`, forbidden-tool absence, strict bounded schemas, and absence of model-supplied `projectId`.
2. Run the focused tool test; confirm missing-tool RED.
3. Add narrow task/session/schedule mutation service interfaces and minimal tool handlers.
4. Add failing authorization tests proving target and bound project/user revalidation occurs immediately before every side effect and foreign IDs create no context or operation.
5. Add the minimal authorized lookups, bounded structured success/failure operations, and context touches; run focused tests green.
6. Commit the capability slice.

### Task 3: Durable Workspace Selection

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Test: `packages/vibedeckx/src/project-chat-tools.test.ts`
- Test: `packages/vibedeckx/src/storage/project-chat.test.ts`

1. Write failing tests for zero/one/many workspace candidates, no implicit choice, injective canonical candidate IDs, stale/foreign selections, restart recovery, concurrent selection, and crash-after-create recovery.
2. Run focused tests and confirm failures are caused by missing pending-intent resolution.
3. Persist a stable request/idempotency key and preallocated session ID. Implement claim/recovery APIs and a narrow session mutation adapter that returns an existing session for the durable identity before creating.
4. Revalidate the selected workspace at resolution and transition exactly once; never create a worktree.
5. Run both focused suites green and commit.

### Task 4: Event Payload and Correlation Routing

**Files:**
- Modify: `packages/vibedeckx/src/event-bus.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify emission tests/sites only if exact identifiers are absent.
- Test: `packages/vibedeckx/src/project-chat-manager.test.ts`
- Test: `packages/vibedeckx/src/scheduler.test.ts`
- Test: relevant agent-session completion tests.

1. Write failing manager tests for exact T1-only routing, two legitimate thread correlations, foreign-project rejection, duplicate/out-of-order monotonicity, absent subscriber persistence, restart recovery, and subscribe-once/shutdown cleanup.
2. Run the required tools/manager RED command and verify correlation failures.
3. Extend EventBus payload types only where required, then add one manager subscription that queries exact correlations, persists deterministic operation updates first, and broadcasts only to the matched live thread.
4. Do not enqueue model turns. Run focused manager, scheduler, and session-emitter tests green.
5. Commit the event slice.

### Task 5: Production Integration and Verification

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: production construction/wiring sites discovered by TypeScript.
- Test: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Write a failing integration test proving the manager supplies existing local/remote session and scheduler adapters while fake runners remain injectable.
2. Wire the narrow services and validate remote operations through persisted mappings and `project_remotes` authorization.
3. Run `pnpm --filter vibedeckx test -- src/project-chat-tools.test.ts src/project-chat-manager.test.ts`.
4. Run focused storage/scheduler/session tests, TypeScript/build, then the complete backend test suite.
5. Run `git diff --check`, inspect the full diff for scope and unsafe capabilities, and commit as `feat: let project chat coordinate project work`.
