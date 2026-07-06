# Resident Agent Processes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support multiple live local and remote agent sessions with a configurable resident process cap, LRU idle eviction, and sidebar visibility.

**Architecture:** Put capacity enforcement in `AgentSessionManager`, where processes are actually spawned. Expose process liveness through existing session list APIs and global SSE events; front-end state derives resident rows from REST snapshots plus SSE updates.

**Tech Stack:** TypeScript, Fastify, Vitest, Next.js/React, existing `/api/events` global event stream.

---

### Task 1: Backend Resident Pool Core

**Files:**
- Create: `packages/vibedeckx/src/resident-agent-processes.ts`
- Test: `packages/vibedeckx/src/resident-agent-processes.test.ts`
- Modify: `packages/vibedeckx/src/agent-session-manager.ts`

**Steps:**
1. Write failing tests for default/max settings validation and LRU idle eviction selection.
2. Run `pnpm --filter vibedeckx test -- resident-agent-processes.test.ts` and verify failures.
3. Implement resident helper functions and wire manager capacity checks before `spawnAgent` calls.
4. Re-run the test and a TypeScript build.

### Task 2: API Surface

**Files:**
- Modify: `packages/vibedeckx/src/event-bus.ts`
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts`
- Modify: `packages/vibedeckx/src/routes/settings-routes.ts`
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts`

**Steps:**
1. Add `processAlive` fields to session responses and `session:process` to the event union.
2. Add `/api/settings/agent-processes` GET/PUT.
3. Pass `force` through remote new-session calls and preserve 409 responses.
4. Re-run backend tests/build.

### Task 3: Frontend Behavior

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts`
- Modify: `apps/vibedeckx-ui/hooks/use-agent-session.ts`
- Create: `apps/vibedeckx-ui/hooks/use-resident-sessions.ts`
- Modify: `apps/vibedeckx-ui/app/page.tsx`
- Modify: `apps/vibedeckx-ui/components/layout/app-sidebar.tsx`

**Steps:**
1. Write failing tests for `createNewAgentSession` surfacing resident-limit errors.
2. Remove New Conversation’s unconditional stop call.
3. Add resident sessions hook and sidebar nested rows.
4. Re-run UI tests/build.

### Task 4: Final Verification

**Steps:**
1. Run targeted backend and frontend tests.
2. Run `pnpm build:main`.
3. Run `pnpm --filter vibedeckx-ui test` for touched UI tests, and build if feasible.
