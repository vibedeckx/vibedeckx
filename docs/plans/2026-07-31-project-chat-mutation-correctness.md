# Project Chat Mutation Correctness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Project Chat mutations race-safe, restart-recoverable, immutably scoped, and runtime-typed without expanding the safe tool surface.

**Architecture:** Evolve the operation journal into a versioned typed state machine with database-enforced immutable ownership and atomic claim/delivery transitions. Reconcile nonterminal effects from durable agent-session and schedule-run state on manager startup while retaining monotonic event transitions. Keep instruction delivery explicitly at-least-once and validate task branch assignments against current authorized workspaces at mutation time.

**Tech Stack:** TypeScript, Zod, Kysely, SQLite/better-sqlite3, Vitest, EventBus.

---

### Task 1: Typed immutable operation migration

**Files:**
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Modify: `packages/vibedeckx/src/storage/schema.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Test: `packages/vibedeckx/src/storage/project-chat.test.ts`

1. Write real-SQLite failing tests that open a Task 5 intermediate database and require `project_id`/`user_id` backfill, independent constrained `kind`/`payload_version`, JSON validity, exact scope-leading correlation index, parent-scope validation triggers, and immutable scope/discriminant updates.
2. Run the focused storage tests and confirm failures are caused by missing migration/schema behavior.
3. Add a migration-safe table rebuild/backfill and triggers. Add statuses `resolving` and `confirmed` only where required by typed operation state.
4. Define a Zod discriminated payload union for task create/update, workspace selection/session create, instruction delivery, schedule run, and event update state. Make repository writes accept typed payloads and serialize internally; parse every read and reject malformed/version-mismatched rows with bounded integrity errors.
5. Run focused storage tests until green, then refactor common validation/mapping code while keeping them green.

### Task 2: Atomic workspace selection claims

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Test: `packages/vibedeckx/src/storage/project-chat.test.ts`
- Test: `packages/vibedeckx/src/project-chat-tools.test.ts`

1. Write failing repository and tool tests for simultaneous same selection, simultaneous different selection, exact one side effect, and restart from a claimed `resolving` intent.
2. Verify RED with deterministic barriers around the service call.
3. Implement `claimWorkspaceSelection` as one conditional scoped update from pending/unclaimed to resolving with stable claim token, canonical workspace, and preallocated session ID. Never overwrite an existing claim.
4. Make losers reload the claim: same selection follows/reuses its durable result; conflicting selection returns a bounded already-resolved error.
5. Verify focused races repeatedly and keep all existing selection tests green.

### Task 3: Durable at-least-once instruction delivery

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts`
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts`
- Test: `packages/vibedeckx/src/project-chat-tools.test.ts`
- Test: `packages/vibedeckx/src/remote-agent-sessions.test.ts`

1. Write failing crash-window tests for crash before transport send, retry of an unconfirmed send regardless of transcript, confirmed-send replay, and forwarding a stable remote idempotency key when supported.
2. Verify RED and record that the current transcript check falsely treats persistence as delivery.
3. Persist typed pending delivery before transport. Send using stable operation/idempotency identity, then atomically mark confirmed and publish success. Pending retry sends again; confirmed replay does not.
4. Document in the tool/service API that local raw stdin is at-least-once across crash-after-write-before-confirm and may duplicate, but unsent work is never reported delivered.
5. Verify focused local/remote delivery tests and existing session transport tests.

### Task 4: Durable session creation and startup reconciliation

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts`
- Test: `packages/vibedeckx/src/project-chat-tools.test.ts`
- Test: `packages/vibedeckx/src/project-chat-manager.test.ts`

1. Write failing tests proving direct explicit create persists the full bounded intent before effect and that manager restart converges both crash-before-effect and crash-after-effect-before-status without a second session.
2. Write failing manager tests for bounded pagination over missed completed/failed local or remote sessions and schedule runs, pending create/run effects, foreign scope exclusion, subscribe-before-reconcile event races, and listener cleanup/bounded shutdown tracking.
3. Verify each RED failure is the absent discovery/retry/reconciliation behavior.
4. Add bounded nonterminal operation listing and service reconciliation probes. Subscribe first, then start a tracked reconciliation promise; use the same monotonic transitions for scan and EventBus races.
5. Discover canonical preallocated sessions/runs before retrying pending/resolving effects. Retry only through stable idempotent service identities. Bound pages and shutdown wait.
6. Verify manager/tool tests, including restart with no live page/subscriber.

### Task 5: Prompt and task branch revalidation

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Test: `packages/vibedeckx/src/project-chat-manager.test.ts`
- Test: `packages/vibedeckx/src/project-chat-tools.test.ts`

1. Write failing prompt assertions enumerating safe create/update/session/instruction/run/select capabilities and prohibiting delete, worktree, schedule configuration, stop, and Git operations.
2. Write failing task tests for valid, stale/nonexistent, foreign, duplicate-across-targets, null clear, and mutation-time workspace revalidation.
3. Verify RED.
4. Update the production prompt and add immediate authorized workspace branch validation before task write/context/operation.
5. Verify focused prompt/tool tests green.

### Task 6: Review and full verification

**Files:**
- Review all modified production and test files.

1. Run focused storage, tools, manager, shared-service, event, scheduler, and remote-session suites.
2. Run `pnpm exec tsc --noEmit` and `pnpm run build` from `packages/vibedeckx`.
3. Run the complete backend test suite.
4. Run `git diff --check` and inspect the full diff specifically for claim races, restart reconciliation ordering, instruction acknowledgement semantics, immutable scope, migration behavior, and payload/discriminant agreement.
5. Commit the verified fixes with an intentional message and keep the worktree for parent integration.
