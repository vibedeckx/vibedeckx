# Remote Ad-hoc Review (Phase 1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Phase 1 ad-hoc review loop (完成 → Review → 确认 → Feedback) work for remote workspaces, per spec §6 "Phase 1.5" in `docs/superpowers/specs/2026-07-17-workflow-engine-review-loop-design.md`.

**Architecture:** The WorkflowEngine keeps running **on the worker** where the sessions/worktree live (it already exists there — same server binary). The front server only proxies: workflow-run routes gain remote mirrors (following the existing `agent-session-routes.ts` branch-route proxy pattern), run transitions ride the existing resident per-session `/stream` WS as a new `{ workflowRunUpdated }` frame, and the worker marks reviewer completions with a `workflowSuppressed` flag on the `{ taskCompleted }` frame so the front commander never double-handles them. No new transport mechanism is invented.

**Tech Stack:** Fastify + better-sqlite3/Kysely (backend), `utils/remote-proxy.ts` (`proxyToRemoteAuto` — transparent over direct-URL and reverse-connect), Next.js 16 + React 19 (frontend), vitest.

## Global Constraints

- Backend is ESM with NodeNext resolution — **all local imports need `.js` extensions**.
- Backend typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`. Frontend lint: `pnpm --filter vibedeckx-ui lint` (pre-existing failures in untouched files are acceptable; touched files must be clean).
- Tests: vitest, colocated `*.test.ts`, run with `pnpm --filter vibedeckx test` (or `cd packages/vibedeckx && npx vitest run <file>`).
- Every relay still requires explicit user confirmation (spec §1.3) — nothing in this plan adds an auto path.
- Remote session id convention (existing, do not change): `remote-{remoteServerId}-{projectId}-{bareSessionId}`. Remote **run** ids introduced here use the same shape: `remote-{remoteServerId}-{projectId}-{bareRunId}`.
- `/api/path/*` routes are automatically 404'd unless the server runs with `--accept-remote` (hook in `server.ts:235-243`) — new path-based mirrors MUST live under that prefix to inherit the gate.
- Authorization pattern for remote ids on the front (from `agent-session-routes.ts:76-86`): never trust a bare `remoteSessionMap.get` — always re-check `projects.getById(projectIdFromRemoteSessionId(...), userId)` with the **raw** `requireAuth` result (undefined in solo mode is fine; never `resolveUserId`).
- Worker-side auth is already handled: direct-URL proxying sends `X-Vibedeckx-Api-Key` (`remote-proxy.ts:70-74`); reverse-connect trusts the tunnel. No auth code changes in this plan.

## File Structure

- `packages/vibedeckx/src/agent-session-manager.ts` — (modify) taskCompleted WS frame gains `turnEndEntryIndex` + `workflowSuppressed`; public `broadcastRawToSession`.
- `packages/vibedeckx/src/plugins/shared-services.ts` — (modify) wire the suppression check into the manager.
- `packages/vibedeckx/src/event-bus.ts` — (modify) `session:taskCompleted` gains `workflowSuppressed?`.
- `packages/vibedeckx/src/routes/remote-status-bridge.ts` — (modify) pure frame→event helpers: `taskCompletedEventFromRemoteFrame`, `runUpdatedEventFromRemoteFrame`, `mapRemoteRun`. This file already holds the pure remote-frame helpers (`projectIdFromRemoteSessionId`, `statusEventFromRemotePatch`).
- `packages/vibedeckx/src/routes/remote-status-bridge.test.ts` — (create) tests for the pure helpers.
- `packages/vibedeckx/src/remote-agent-sessions.ts` — (modify) `handleLiveMessage`: use the taskCompleted helper; new `workflowRunUpdated` branch.
- `packages/vibedeckx/src/chat-session-manager.ts` — (modify) one-line suppression check extension.
- `packages/vibedeckx/src/workflow-engine.ts` — (modify) `AgentOps` gains optional `broadcastRawToSession`; `emitRunUpdated` mirrors onto participant streams.
- `packages/vibedeckx/src/workflow-engine.test.ts` — (modify) frame-mirror test.
- `packages/vibedeckx/src/routes/workflow-run-routes.ts` — (modify) worker path-based mirrors + front proxy branches + `remoteRunMap`.
- `packages/vibedeckx/src/routes/workflow-run-routes.test.ts` — (modify) path-mirror tests.
- `packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts` — (create) front proxy tests (mocked `proxyToRemoteAuto`).
- `apps/vibedeckx-ui/components/agent/review-dialog.tsx` — (modify) drop the `remote-` null guard.

---

### Task 1: Worker — taskCompleted WS frame carries `turnEndEntryIndex` + `workflowSuppressed`

The worker's `broadcastRaw` `{ taskCompleted: {...} }` frame (which the front's bridge consumes) currently carries only duration/cost/tokens/summaryText. Add the turn boundary and a suppression mark set when the worker's own WorkflowEngine claimed this completion (i.e. it's a reviewer session of an active run).

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` (~line 862 `broadcastRaw` in `commitCompletion`; new field + setter near the `eventBus` field ~line 170s)
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts` (~line 213-217, the WorkflowEngine wiring block)

**Interfaces:**
- Consumes: `WorkflowEngine.shouldSuppressAgentEvent(sessionId: string): boolean` (exists, `workflow-engine.ts`).
- Produces: WS frame shape `{ taskCompleted: { duration_ms?, cost_usd?, input_tokens?, output_tokens?, summaryText?, turnEndEntryIndex?: number, workflowSuppressed?: true } }` — consumed by Task 2's bridge helper. `AgentSessionManager.setWorkflowSuppressionCheck(check: (sessionId: string) => boolean): void`.

- [ ] **Step 1: Add the suppression-check hook to AgentSessionManager**

In `agent-session-manager.ts`, next to the existing `setEventBus` method (search `setEventBus(`), add a private field and setter:

```ts
  private workflowSuppressionCheck: ((sessionId: string) => boolean) | null = null;

  /**
   * Injected by shared-services: lets commitCompletion mark taskCompleted WS
   * frames whose completion the local WorkflowEngine claims (reviewer
   * sessions of active runs). A front server bridging this frame must not
   * wake its commander for it (spec §Phase 1.5 抑制协调).
   */
  setWorkflowSuppressionCheck(check: (sessionId: string) => boolean): void {
    this.workflowSuppressionCheck = check;
  }
```

- [ ] **Step 2: Extend the broadcastRaw frame in commitCompletion**

Locate this block in `commitCompletion` (line ~862; `turnEndEntryIndex` is already in scope — `endActiveTurn` runs before it since the Phase 1 reorder):

```ts
    this.broadcastRaw(sessionId, {
      taskCompleted: {
        duration_ms: payload.duration_ms,
        cost_usd: payload.cost_usd,
        input_tokens: payload.input_tokens,
        output_tokens: payload.output_tokens,
        summaryText,
      },
    });
```

Replace with:

```ts
    this.broadcastRaw(sessionId, {
      taskCompleted: {
        duration_ms: payload.duration_ms,
        cost_usd: payload.cost_usd,
        input_tokens: payload.input_tokens,
        output_tokens: payload.output_tokens,
        summaryText,
        turnEndEntryIndex: turnEndEntryIndex ?? undefined,
        workflowSuppressed: this.workflowSuppressionCheck?.(sessionId) || undefined,
      },
    });
```

- [ ] **Step 3: Wire the check in shared-services**

In `plugins/shared-services.ts`, in the existing engine block:

```ts
  const workflowEngine = new WorkflowEngine(opts.storage, agentSessionManager);
  workflowEngine.setEventBus(eventBus);   // subscribe BEFORE chatSessionManager so ordering is explicit
  await workflowEngine.init();
  fastify.decorate("workflowEngine", workflowEngine);
  chatSessionManager.setWorkflowEngine(workflowEngine);
```

add one line after `chatSessionManager.setWorkflowEngine(workflowEngine);`:

```ts
  agentSessionManager.setWorkflowSuppressionCheck((sessionId) => workflowEngine.shouldSuppressAgentEvent(sessionId));
```

- [ ] **Step 4: Typecheck + full backend suite**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` — expected: clean.
Run: `pnpm --filter vibedeckx test` — expected: all pass (no behavior change for existing consumers; the two new frame fields are additive and `undefined`-elided in JSON).

(No new unit test here: `commitCompletion` has no light test seam. The new fields' contract is pinned by Task 2's pure-helper tests, and the live frame is asserted in Task 7's two-server e2e.)

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/plugins/shared-services.ts
git commit -m "feat(workflow): taskCompleted WS frame carries turnEndEntryIndex + workflowSuppressed"
```

---

### Task 2: Front bridge — forward the new fields and honor the suppression flag

The front's per-session stream handler re-emits worker `taskCompleted` frames onto the front EventBus. Extract that construction into a pure, tested helper that forwards the two new fields, and make ChatSessionManager honor `workflowSuppressed` (the front's own engine doesn't know worker-side runs).

**Files:**
- Modify: `packages/vibedeckx/src/event-bus.ts` (the `session:taskCompleted` variant, line ~9)
- Modify: `packages/vibedeckx/src/routes/remote-status-bridge.ts`
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts` (`handleLiveMessage`, the `"taskCompleted" in parsed` branch, lines ~251-276)
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` (`handleSessionTaskCompleted`, suppression check line ~367)
- Test: `packages/vibedeckx/src/routes/remote-status-bridge.test.ts` (create)

**Interfaces:**
- Consumes: frame shape from Task 1; `projectIdFromRemoteSessionId(sessionId, remoteInfo)` and `RemoteSessionInfo` (existing).
- Produces: `taskCompletedEventFromRemoteFrame(parsed: Record<string, unknown>, sessionId: string, remoteInfo: RemoteSessionInfo): Extract<GlobalEvent, { type: "session:taskCompleted" }> | null` exported from `remote-status-bridge.ts`; `session:taskCompleted` events may carry `workflowSuppressed?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/routes/remote-status-bridge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { taskCompletedEventFromRemoteFrame } from "./remote-status-bridge.js";
import type { RemoteSessionInfo } from "../server-types.js";

const remoteInfo: RemoteSessionInfo = {
  remoteServerId: "srv1",
  remoteUrl: "http://r",
  remoteApiKey: "k",
  remoteSessionId: "bare1",
  branch: "dev",
};
const localId = "remote-srv1-p1-bare1";

describe("taskCompletedEventFromRemoteFrame", () => {
  it("maps ids and forwards turnEndEntryIndex + workflowSuppressed", () => {
    const evt = taskCompletedEventFromRemoteFrame(
      { taskCompleted: { summaryText: "done", turnEndEntryIndex: 7, workflowSuppressed: true } },
      localId,
      remoteInfo,
    );
    expect(evt).toMatchObject({
      type: "session:taskCompleted",
      projectId: "p1",
      branch: "dev",
      sessionId: localId,
      summaryText: "done",
      turnEndEntryIndex: 7,
      workflowSuppressed: true,
    });
  });

  it("omits optional fields when absent and returns null for other frames", () => {
    const evt = taskCompletedEventFromRemoteFrame({ taskCompleted: {} }, localId, remoteInfo);
    expect(evt?.turnEndEntryIndex).toBeUndefined();
    expect(evt?.workflowSuppressed).toBeUndefined();
    expect(taskCompletedEventFromRemoteFrame({ finished: true }, localId, remoteInfo)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/routes/remote-status-bridge.test.ts`
Expected: FAIL — `taskCompletedEventFromRemoteFrame` is not exported.

- [ ] **Step 3: Implement**

(a) `event-bus.ts` — extend the `session:taskCompleted` variant with a trailing optional field:

```ts
  | { type: "session:taskCompleted"; projectId: string; branch: string | null; sessionId: string; duration_ms?: number; cost_usd?: number; input_tokens?: number; output_tokens?: number; summaryText?: string; turnEndEntryIndex?: number; workflowSuppressed?: boolean }
```

(b) `routes/remote-status-bridge.ts` — add (it already imports `GlobalEvent` and `RemoteSessionInfo` types; extend imports if needed):

```ts
/**
 * Build the front-server `session:taskCompleted` event from a worker's
 * `{ taskCompleted: {...} }` stream frame. Forwards the turn boundary (needed
 * by the front's event-card Review button) and the workflow-suppression mark
 * (the worker's WorkflowEngine claimed this completion — the front commander
 * must not double-handle it).
 */
export function taskCompletedEventFromRemoteFrame(
  parsed: Record<string, unknown>,
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
): Extract<GlobalEvent, { type: "session:taskCompleted" }> | null {
  if (!("taskCompleted" in parsed)) return null;
  const tc = parsed.taskCompleted as Record<string, unknown> | undefined;
  return {
    type: "session:taskCompleted",
    projectId: projectIdFromRemoteSessionId(sessionId, remoteInfo),
    branch: remoteInfo.branch ?? null,
    sessionId,
    duration_ms: tc?.duration_ms as number | undefined,
    cost_usd: tc?.cost_usd as number | undefined,
    input_tokens: tc?.input_tokens as number | undefined,
    output_tokens: tc?.output_tokens as number | undefined,
    summaryText: tc?.summaryText as string | undefined,
    turnEndEntryIndex: tc?.turnEndEntryIndex as number | undefined,
    workflowSuppressed: tc?.workflowSuppressed === true ? true : undefined,
  };
}
```

(c) `remote-agent-sessions.ts` — in `handleLiveMessage`, replace the body of the `"taskCompleted" in parsed` branch's `if (eventBus) { ... }` block (currently an inline `eventBus.emit({ type: "session:taskCompleted", ... })` plus `emitBranchActivityIfChanged`) with:

```ts
      if (eventBus) {
        const evt = taskCompletedEventFromRemoteFrame(parsed, sessionId, remoteInfo);
        if (evt) {
          eventBus.emit(evt);
          agentSessionManager?.emitBranchActivityIfChanged(evt.projectId, evt.branch, {
            activity: "completed",
            since: Date.now(),
            sessionId,
          });
        }
      }
```

Keep the preceding `cache.appendMessage(sessionId, raw, false); cache.broadcast(sessionId, raw);` lines untouched. Import `taskCompletedEventFromRemoteFrame` from `./routes/remote-status-bridge.js` (the file already imports `projectIdFromRemoteSessionId` from there — extend that import).

(d) `chat-session-manager.ts` — in `handleSessionTaskCompleted`, the suppression check currently reads:

```ts
      if (this.workflowEngine?.shouldSuppressAgentEvent(event.sessionId)) {
```

Change the condition to:

```ts
      if (event.workflowSuppressed || this.workflowEngine?.shouldSuppressAgentEvent(event.sessionId)) {
```

(Keep the block body/comment as-is. The flag path covers worker-side runs the local engine doesn't know; the local check stays for local runs.)

- [ ] **Step 4: Run tests**

Run: `cd packages/vibedeckx && npx vitest run src/routes/remote-status-bridge.test.ts` — expected: PASS (2 tests).
Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` — expected: clean.
Run: `pnpm --filter vibedeckx test` — expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/event-bus.ts packages/vibedeckx/src/routes/remote-status-bridge.ts packages/vibedeckx/src/routes/remote-status-bridge.test.ts packages/vibedeckx/src/remote-agent-sessions.ts packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat(workflow): bridge forwards turnEndEntryIndex + workflowSuppressed; commander honors the flag"
```

---

### Task 3: Worker — mirror run updates onto participant session streams

There is no worker→front global event channel; the only worker→front push is per-session `/stream` WS frames. Mirror every `workflow:run-updated` onto the run's participant sessions' streams as `{ workflowRunUpdated: run }` so a subscribed front server sees transitions live (Task 6 consumes it; the front's own resident subscription to the reviewer stream is established in Task 5).

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` (public wrapper next to `getRawMessages`, ~line 1540)
- Modify: `packages/vibedeckx/src/workflow-engine.ts` (`AgentOps` + `emitRunUpdated`)
- Test: `packages/vibedeckx/src/workflow-engine.test.ts`

**Interfaces:**
- Produces: `AgentSessionManager.broadcastRawToSession(sessionId: string, payload: Record<string, unknown>): void`; `AgentOps.broadcastRawToSession?(sessionId: string, payload: Record<string, unknown>): void` (optional — structural match with the manager); WS frame `{ workflowRunUpdated: WorkflowRun }` (worker-local ids).

- [ ] **Step 1: Write the failing test**

In `packages/vibedeckx/src/workflow-engine.test.ts`, add `broadcastRawToSession: vi.fn()` to the `agentOps` fake object (next to `getRawMessages`), and add this test inside the `WorkflowEngine` describe (after the existing "creates a run..." test; `start()` is the existing helper that runs `startAdhocReview` with the standard opts):

```ts
  it("mirrors run updates onto participant session streams", async () => {
    await start();
    const frames = agentOps.broadcastRawToSession.mock.calls.map(
      ([sid, frame]: [string, Record<string, unknown>]) => [sid, Object.keys(frame)[0]],
    );
    expect(frames).toContainEqual(["s-src", "workflowRunUpdated"]);
    expect(frames).toContainEqual(["s-rev", "workflowRunUpdated"]);
  });
```

Also add a `beforeEach`-level `agentOps.broadcastRawToSession.mockClear()` alongside the existing mock resets if the file resets mocks per test (match the file's existing pattern — if it uses `vi.clearAllMocks()` or per-mock resets, follow that).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/workflow-engine.test.ts`
Expected: FAIL — `broadcastRawToSession` never called (0 calls).

- [ ] **Step 3: Implement**

(a) `agent-session-manager.ts` — next to `getRawMessages`:

```ts
  /**
   * Public wrapper over broadcastRaw for the WorkflowEngine: mirror a raw WS
   * frame to a session's stream subscribers (a front server subscribed to
   * this stream relies on it for run-transition delivery — spec §Phase 1.5).
   */
  broadcastRawToSession(sessionId: string, payload: Record<string, unknown>): void {
    this.broadcastRaw(sessionId, payload);
  }
```

(b) `workflow-engine.ts` — extend `AgentOps` (after `getRawMessages`):

```ts
  /** Optional: push a raw WS frame to a session's stream subscribers. */
  broadcastRawToSession?(sessionId: string, payload: Record<string, unknown>): void;
```

(c) `workflow-engine.ts` — locate the private `emitRunUpdated(run: WorkflowRun)` method (it emits `workflow:run-updated` on `this.eventBus`). Append to its body:

```ts
    // Mirror the update onto the participant sessions' WS streams: the only
    // worker→front push channel is the per-session stream, so a front server
    // subscribed to either participant sees run transitions live without a
    // dedicated cross-machine event channel. Duplicate delivery (both streams
    // subscribed) is harmless — the front-side panel refresh is idempotent.
    for (const sid of [run.source_session_id, run.reviewer_session_id]) {
      if (sid) this.agentOps.broadcastRawToSession?.(sid, { workflowRunUpdated: run });
    }
```

- [ ] **Step 4: Run tests**

Run: `cd packages/vibedeckx && npx vitest run src/workflow-engine.test.ts` — expected: PASS (all, incl. the new test).
Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` — expected: clean (the real manager satisfies the optional member structurally).
Run: `pnpm --filter vibedeckx test` — expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/workflow-engine.ts packages/vibedeckx/src/workflow-engine.test.ts
git commit -m "feat(workflow): mirror run updates as workflowRunUpdated frames on participant streams"
```

---

### Task 4: Worker — path-based remote-provider mirrors for workflow runs

A front server knows the worker's bare session id (via `remoteSessionMap`) and the workspace's `remote_path`, but not the worker-local project id. Add two `/api/path/` mirrors that derive the project themselves (POST from the source session row; GET from the path, using the same resolution as `/api/path/agent-sessions`: `projects.getByPath(path)` falling back to the pseudo id `path:${path}`). Gate/cancel/get-by-id need no mirrors — they operate on bare run ids against the existing routes.

**Files:**
- Modify: `packages/vibedeckx/src/routes/workflow-run-routes.ts` (append the two routes inside the existing `routes` plugin function, after the `/cancel` route)
- Test: `packages/vibedeckx/src/routes/workflow-run-routes.test.ts`

**Interfaces:**
- Consumes: `storage.agentSessions.getById(id)`, `storage.projects.getById(id)` / `getByPath(path)`, `storage.workflowRuns.getActive(projectId, branch)`, `workflowEngine.startAdhocReview(opts)`, the existing `errStatus` helper in this file.
- Produces: `POST /api/path/workflow-runs` body `{ sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number }` → `201 { run }` (worker-local ids); `GET /api/path/workflow-runs?path=&branch=` → `200 { runs }`. Task 5's front proxy calls both.

- [ ] **Step 1: Write the failing tests**

In `workflow-run-routes.test.ts`:

(a) In `makeApp`, add `getByPath` to the projects fake:

```ts
    projects: {
      getById: async (id: string) => (id === "p1" ? project : undefined),
      getByPath: async (p: string) => (p === "/tmp/p" ? project : undefined),
    },
```

(b) Add tests at the end of the describe block:

```ts
  it("path POST derives project and branch from the source session", async () => {
    const startMock = vi.fn(async () => run);
    const app = makeApp({ engine: { startAdhocReview: startMock } });
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/path/workflow-runs",
      payload: { sourceSessionId: "s-src", reviewFocus: "tests", sourceTurnEndIndex: 4 },
    });
    expect(res.statusCode).toBe(201);
    expect(startMock.mock.calls[0][0]).toMatchObject({
      project: { id: "p1", path: "/tmp/p" },
      branch: "dev",
      sourceSessionId: "s-src",
      reviewFocus: "tests",
      sourceTurnEndIndex: 4,
    });
  });

  it("path POST 404s an unknown source session and maps engine errors", async () => {
    const app = makeApp({
      engine: { startAdhocReview: vi.fn(async () => { throw new WorkflowError("session-busy", "busy"); }) },
    });
    await app.register(workflowRunRoutes);
    const missing = await app.inject({ method: "POST", url: "/api/path/workflow-runs", payload: { sourceSessionId: "nope" } });
    expect(missing.statusCode).toBe(404);
    const busy = await app.inject({ method: "POST", url: "/api/path/workflow-runs", payload: { sourceSessionId: "s-src" } });
    expect(busy.statusCode).toBe(409);
  });

  it("path GET lists active runs for a path-resolved project", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const ok = await app.inject({ method: "GET", url: "/api/path/workflow-runs?path=%2Ftmp%2Fp&branch=dev" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().runs).toHaveLength(1);
    const unknown = await app.inject({ method: "GET", url: "/api/path/workflow-runs?path=%2Fnope" });
    expect(unknown.json().runs).toEqual([]);
    const noPath = await app.inject({ method: "GET", url: "/api/path/workflow-runs" });
    expect(noPath.statusCode).toBe(400);
  });
```

Note: `makeApp`'s `project` fixture must have `path: "/tmp/p"` (it already does) and the `agentSessions.getById` fake already returns `{ id, project_id: "p1", branch: "dev" }` for `"s-src"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vibedeckx && npx vitest run src/routes/workflow-run-routes.test.ts`
Expected: the three new tests FAIL with 404s (routes don't exist).

- [ ] **Step 3: Implement the two routes**

Append inside the `routes` plugin function in `workflow-run-routes.ts`, after the `/cancel` handler:

```ts
  // ---- Remote-provider (path-based) mirrors --------------------------------
  // Served under /api/path/* so the --accept-remote gate in server.ts applies.
  // A front server proxies here for remote workspaces: it knows the worker's
  // bare session id and the workspace's remote_path, but not the worker-local
  // project id — so these mirrors derive the project themselves. Gate/cancel/
  // get-by-id need no mirrors (bare run ids work on the normal routes).

  fastify.post<{
    Body: { sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number };
  }>("/api/path/workflow-runs", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { sourceSessionId, reviewFocus, sourceTurnEndIndex } = req.body ?? {};
    if (!sourceSessionId) return reply.code(400).send({ error: "sourceSessionId is required" });
    const sourceSession = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceSession) return reply.code(404).send({ error: "Session not found" });
    const project = await fastify.storage.projects.getById(sourceSession.project_id);
    if (!project) return reply.code(404).send({ error: "Session not found" });
    if (!project.path) return reply.code(400).send({ error: "Project has no local path" });
    try {
      const run = await fastify.workflowEngine.startAdhocReview({
        project: { id: project.id, path: project.path },
        branch: sourceSession.branch || null,
        sourceSessionId,
        reviewFocus,
        sourceTurnEndIndex,
      });
      return reply.code(201).send({ run });
    } catch (err) {
      const status = errStatus(err);
      if (status) return reply.code(status).send({ error: (err as Error).message });
      throw err;
    }
  });

  fastify.get<{
    Querystring: { path?: string; branch?: string };
  }>("/api/path/workflow-runs", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { path: projectPath, branch } = req.query;
    if (!projectPath) return reply.code(400).send({ error: "path is required" });
    // Same resolution as /api/path/agent-sessions: real project by path,
    // else the pseudo project id used for path-created sessions.
    const project =
      (await fastify.storage.projects.getByPath(projectPath)) ??
      (await fastify.storage.projects.getById(`path:${projectPath}`));
    if (!project) return reply.send({ runs: [] });
    const runs = await fastify.storage.workflowRuns.getActive(project.id, branch || null);
    return reply.send({ runs });
  });
```

- [ ] **Step 4: Run tests**

Run: `cd packages/vibedeckx && npx vitest run src/routes/workflow-run-routes.test.ts` — expected: PASS (all).
Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` — expected: clean. (If `projects.getByPath` is missing from the `Storage` interface, check `storage/types.ts` — it exists; the test fake must simply include it.)

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/workflow-run-routes.ts packages/vibedeckx/src/routes/workflow-run-routes.test.ts
git commit -m "feat(workflow): path-based /api/path/workflow-runs mirrors for remote fronts"
```

---

### Task 5: Front — proxy remote workspaces in workflow-run routes

Replace the front's `remote-` 400 with real proxying: POST for a `remote-` source session goes to the worker's path mirror; GET list for a remote workspace proxies via `remote_path`; gate/cancel/get-by-id accept `remote-` run ids via an in-memory `remoteRunMap` (hydrate-by-use, like `remoteSessionMap`). The POST handler also registers the worker-created reviewer session on the front and opens its resident stream — that stream is what carries the suppressed `taskCompleted` and `workflowRunUpdated` frames back.

**Files:**
- Modify: `packages/vibedeckx/src/routes/remote-status-bridge.ts` (add `mapRemoteRun`)
- Modify: `packages/vibedeckx/src/routes/workflow-run-routes.ts`
- Test: `packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts` (create)
- Test: `packages/vibedeckx/src/routes/remote-status-bridge.test.ts` (add `mapRemoteRun` cases)

**Interfaces:**
- Consumes: `proxyToRemoteAuto` / `proxyStatus` (`utils/remote-proxy.ts`), `projectIdFromRemoteSessionId`, `ensureRemoteAgentStream(localSessionId, deps)` (`remote-agent-sessions.ts`), `storage.projectRemotes.getByProjectAndServer(projectId, serverId)`, `storage.remoteSessionMappings.upsert(localSessionId, projectId, remoteServerId, remoteSessionId, branch)`, fastify decorations `remoteSessionMap`, `remotePatchCache`, `reverseConnectManager`, `eventBus`, `agentSessionManager`. Worker endpoints from Task 4.
- Produces: `mapRemoteRun<T extends { id: string; project_id: string; source_session_id: string; reviewer_session_id: string | null }>(run: T, remoteServerId: string, projectId: string): T` exported from `remote-status-bridge.ts` (Task 6 reuses it). Front API behavior: all four workflow-run endpoints work transparently with `remote-` ids; responses carry front-space ids so the frontend's `sessionBusy` predicate and panel jump links keep working unchanged.

- [ ] **Step 1: Write the failing `mapRemoteRun` test**

Append to `routes/remote-status-bridge.test.ts`:

```ts
import { mapRemoteRun } from "./remote-status-bridge.js";

describe("mapRemoteRun", () => {
  it("prefixes run + participant ids and rewrites project_id", () => {
    const mapped = mapRemoteRun(
      { id: "run1", project_id: "wp1", source_session_id: "src1", reviewer_session_id: "rev1" },
      "srv1",
      "p1",
    );
    expect(mapped).toEqual({
      id: "remote-srv1-p1-run1",
      project_id: "p1",
      source_session_id: "remote-srv1-p1-src1",
      reviewer_session_id: "remote-srv1-p1-rev1",
    });
  });

  it("keeps a null reviewer null", () => {
    const mapped = mapRemoteRun(
      { id: "run1", project_id: "wp1", source_session_id: "src1", reviewer_session_id: null },
      "srv1",
      "p1",
    );
    expect(mapped.reviewer_session_id).toBeNull();
  });
});
```

Run: `cd packages/vibedeckx && npx vitest run src/routes/remote-status-bridge.test.ts` — expected: FAIL (no export).

- [ ] **Step 2: Implement `mapRemoteRun`**

In `routes/remote-status-bridge.ts`:

```ts
/**
 * Rewrite a worker-local workflow run into the front server's id space: the
 * run id and both participant session ids gain the standard
 * `remote-{serverId}-{projectId}-` prefix (same shape as remote session ids,
 * so the frontend's session-matching predicates keep working), and
 * project_id becomes the front's project id. Branch names are shared
 * vocabulary across machines and pass through untouched.
 */
export function mapRemoteRun<
  T extends { id: string; project_id: string; source_session_id: string; reviewer_session_id: string | null },
>(run: T, remoteServerId: string, projectId: string): T {
  const prefix = `remote-${remoteServerId}-${projectId}-`;
  return {
    ...run,
    id: `${prefix}${run.id}`,
    project_id: projectId,
    source_session_id: `${prefix}${run.source_session_id}`,
    reviewer_session_id: run.reviewer_session_id ? `${prefix}${run.reviewer_session_id}` : null,
  };
}
```

Run the bridge test again — expected: PASS.

- [ ] **Step 3: Write the failing front-proxy tests**

Create `packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts` (mock pattern copied from `agent-session-remote-branch-routes.test.ts`):

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { proxyMock, ensureStreamMock } = vi.hoisted(() => ({
  proxyMock: vi.fn(),
  ensureStreamMock: vi.fn(),
}));
vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, proxyToRemoteAuto: proxyMock };
});
vi.mock("../remote-agent-sessions.js", () => ({ ensureRemoteAgentStream: ensureStreamMock }));

import workflowRunRoutes from "./workflow-run-routes.js";

const SRC = "remote-srv1-p1-src1";
const bareRun = {
  id: "run1", project_id: "wp1", branch: "dev",
  source_session_id: "src1", source_turn_end_index: 4,
  reviewer_session_id: "rev1", review_focus: null, review_target: null,
  feedback_snapshot: null, status: "waiting_reviewer", error: null,
  created_at: "", updated_at: "",
};

let app: FastifyInstance;
afterEach(async () => { if (app) await app.close(); vi.clearAllMocks(); });

function makeApp() {
  const remoteSessionMap = new Map<string, unknown>();
  remoteSessionMap.set(SRC, {
    remoteServerId: "srv1", remoteUrl: "http://r", remoteApiKey: "k",
    remoteSessionId: "src1", branch: "dev",
  });
  const upsert = vi.fn(async () => undefined);
  const emit = vi.fn();
  app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    projects: { getById: async (id: string) => (id === "p1" ? { id: "p1", name: "p", path: null, agent_mode: "srv1" } : undefined) },
    projectRemotes: {
      getByProjectAndServer: async (pid: string, sid: string) =>
        pid === "p1" && sid === "srv1"
          ? { remote_path: "/w/repo", server_url: "http://r", server_api_key: "k", remote_server_id: "srv1" }
          : undefined,
    },
    remoteSessionMappings: { upsert },
    workflowRuns: { getActive: async () => [], getById: async () => undefined },
    agentSessions: { getById: async () => undefined },
  } as never);
  app.decorate("workflowEngine", {} as never);
  app.decorate("remoteSessionMap", remoteSessionMap as never);
  app.decorate("remotePatchCache", {} as never);
  app.decorate("reverseConnectManager", null);
  app.decorate("eventBus", { emit } as never);
  app.decorate("agentSessionManager", {} as never);
  return { remoteSessionMap, upsert, emit };
}

describe("workflow-run remote proxying (front server)", () => {
  it("POST proxies to the worker path mirror, maps ids, registers the reviewer stream", async () => {
    const { remoteSessionMap, upsert, emit } = makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, reviewFocus: "tests", sourceTurnEndIndex: 4 },
    });
    expect(res.statusCode).toBe(201);
    const [serverId, url, key, method, apiPath, body] = proxyMock.mock.calls[0];
    expect([serverId, url, key, method, apiPath]).toEqual(["srv1", "http://r", "k", "POST", "/api/path/workflow-runs"]);
    expect(body).toMatchObject({ sourceSessionId: "src1", reviewFocus: "tests", sourceTurnEndIndex: 4 });

    const run = res.json().run;
    expect(run.id).toBe("remote-srv1-p1-run1");
    expect(run.project_id).toBe("p1");
    expect(run.source_session_id).toBe(SRC);
    expect(run.reviewer_session_id).toBe("remote-srv1-p1-rev1");

    expect(remoteSessionMap.get("remote-srv1-p1-rev1")).toMatchObject({ remoteSessionId: "rev1", remoteServerId: "srv1" });
    expect(upsert).toHaveBeenCalledWith("remote-srv1-p1-rev1", "p1", "srv1", "rev1", "dev");
    expect(ensureStreamMock).toHaveBeenCalledWith("remote-srv1-p1-rev1", expect.anything());
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "workflow:run-updated", projectId: "p1" }));
  });

  it("POST forwards the worker's semantic 4xx body and 404s an unmapped source", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: false, status: 409, data: { error: "该 session 已在一个进行中的 review 里" } });
    const busy = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/review/);

    const unmapped = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: "remote-srv1-p1-ghost" },
    });
    expect(unmapped.statusCode).toBe(404);
  });

  it("GET list proxies via remote_path and gate reaches the worker through remoteRunMap", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { runs: [bareRun] } });
    const list = await app.inject({ method: "GET", url: "/api/workflow-runs?projectId=p1&branch=dev" });
    expect(list.statusCode).toBe(200);
    expect(list.json().runs[0].id).toBe("remote-srv1-p1-run1");
    const listPath = proxyMock.mock.calls[0][4] as string;
    expect(listPath).toContain("/api/path/workflow-runs?");
    expect(listPath).toContain("branch=dev");

    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { run: { ...bareRun, status: "completed" } } });
    const gate = await app.inject({
      method: "POST", url: "/api/workflow-runs/remote-srv1-p1-run1/gate",
      payload: { action: "approve", editedPayload: "edited" },
    });
    expect(gate.statusCode).toBe(200);
    expect(gate.json().run.status).toBe("completed");
    expect(proxyMock.mock.calls[1][4]).toBe("/api/workflow-runs/run1/gate");
    expect(proxyMock.mock.calls[1][5]).toMatchObject({ action: "approve", editedPayload: "edited" });
  });

  it("gate 404s an unknown remote run id (empty remoteRunMap)", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs/remote-srv1-p1-unknown/gate",
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

Run: `cd packages/vibedeckx && npx vitest run src/routes/workflow-run-remote-routes.test.ts` — expected: FAIL (POST currently 400s remote ids; gate 404s differently is fine but POST/GET assertions fail).

- [ ] **Step 4: Implement the front proxy branches**

In `routes/workflow-run-routes.ts`:

(a) Add imports:

```ts
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { projectIdFromRemoteSessionId, mapRemoteRun } from "./remote-status-bridge.js";
import { ensureRemoteAgentStream } from "../remote-agent-sessions.js";
import type { WorkflowRun } from "../storage/types.js";
```

(b) At the top of the `routes` plugin function, add the run-handle map and two helpers:

```ts
  /**
   * Front-side handles for runs living on a worker. Mirrors remoteSessionMap's
   * hydrate-by-use model: populated on POST/GET responses, so after a front
   * restart the panel's first proxied list fetch re-learns every active run
   * before any gate could be clicked. Not persisted on purpose.
   */
  interface RemoteRunInfo {
    remoteServerId: string;
    remoteUrl: string;
    remoteApiKey: string;
    bareRunId: string;
    projectId: string;
  }
  const remoteRunMap = new Map<string, RemoteRunInfo>();

  const proxyAuto = (
    info: { remoteServerId: string; remoteUrl: string; remoteApiKey: string },
    method: string,
    apiPath: string,
    body?: unknown,
  ) =>
    proxyToRemoteAuto(info.remoteServerId, info.remoteUrl, info.remoteApiKey, method, apiPath, body, {
      reverseConnectManager: fastify.reverseConnectManager,
    });

  /** status 0 = never reached the worker; otherwise forward its semantic body. */
  const sendProxyFailure = (reply: FastifyReply, result: { status: number; data: unknown; errorCode?: string }) =>
    reply.code(proxyStatus(result)).send(
      result.status === 0 ? { error: `Remote proxy failed: ${result.errorCode || "unknown"}` } : result.data,
    );
```

(`FastifyReply` — add to the existing fastify type import.)

(c) In the **POST /api/workflow-runs** handler, right after the `if (!projectId || !sourceSessionId)` validation and **before** the local `agentSessions.getById` ownership check, insert:

```ts
    if (sourceSessionId.startsWith("remote-")) {
      // Remote workspace: the run lives on the worker (spec §Phase 1.5 —
      // engine runs where the session/worktree live). Authz follows the
      // getAuthorizedRemoteSessionInfo pattern: derive the project from the
      // id and re-check ownership; never trust the map entry alone.
      const remoteInfo = fastify.remoteSessionMap.get(sourceSessionId);
      if (!remoteInfo) return reply.code(404).send({ error: "Session not found" });
      const derivedProjectId = projectIdFromRemoteSessionId(sourceSessionId, remoteInfo);
      if (derivedProjectId !== projectId) return reply.code(404).send({ error: "Session not found" });
      const remoteProject = await fastify.storage.projects.getById(projectId, userId);
      if (!remoteProject) return reply.code(404).send({ error: "Project not found" });

      // The worker derives branch from its own session row — the body branch
      // is not forwarded (server-derived branch, same rule as the local path).
      const result = await proxyAuto(remoteInfo, "POST", "/api/path/workflow-runs", {
        sourceSessionId: remoteInfo.remoteSessionId,
        reviewFocus,
        sourceTurnEndIndex,
      });
      if (!result.ok) return sendProxyFailure(reply, result);

      const bareRun = (result.data as { run: WorkflowRun }).run;
      const localRun = mapRemoteRun(bareRun, remoteInfo.remoteServerId, projectId);
      remoteRunMap.set(localRun.id, {
        remoteServerId: remoteInfo.remoteServerId,
        remoteUrl: remoteInfo.remoteUrl,
        remoteApiKey: remoteInfo.remoteApiKey,
        bareRunId: bareRun.id,
        projectId,
      });

      // Surface the worker-created reviewer on the front: register the handle
      // and open the resident stream — that stream is what carries the
      // reviewer's suppressed taskCompleted and the workflowRunUpdated frames.
      if (bareRun.reviewer_session_id && localRun.reviewer_session_id) {
        fastify.remoteSessionMap.set(localRun.reviewer_session_id, {
          remoteServerId: remoteInfo.remoteServerId,
          remoteUrl: remoteInfo.remoteUrl,
          remoteApiKey: remoteInfo.remoteApiKey,
          remoteSessionId: bareRun.reviewer_session_id,
          branch: bareRun.branch,
        });
        await fastify.storage.remoteSessionMappings.upsert(
          localRun.reviewer_session_id, projectId, remoteInfo.remoteServerId,
          bareRun.reviewer_session_id, bareRun.branch,
        );
        ensureRemoteAgentStream(localRun.reviewer_session_id, {
          remoteSessionMap: fastify.remoteSessionMap,
          remotePatchCache: fastify.remotePatchCache,
          reverseConnectManager: fastify.reverseConnectManager,
          eventBus: fastify.eventBus,
          agentSessionManager: fastify.agentSessionManager,
        });
      }
      fastify.eventBus.emit({ type: "workflow:run-updated", projectId, branch: bareRun.branch, run: localRun });
      return reply.code(201).send({ run: localRun });
    }
```

Then **delete** the now-dead local rejection line:

```ts
    if (sourceSessionId.startsWith("remote-")) return reply.code(400).send({ error: "Remote sessions are not supported in ad-hoc review yet" });
```

(Keep the `!project.path` 400 in the local path — it now only guards genuinely path-less local projects.)

(d) In the **GET /api/workflow-runs** (list) handler, after the project fetch/ownership check and before the local `getActive` call, insert:

```ts
    if (project.agent_mode && project.agent_mode !== "local") {
      const remoteConfig = await fastify.storage.projectRemotes.getByProjectAndServer(projectId, project.agent_mode);
      if (remoteConfig) {
        const q = new URLSearchParams({ path: remoteConfig.remote_path ?? "" });
        if (branch) q.set("branch", branch);
        const info = {
          remoteServerId: project.agent_mode,
          remoteUrl: remoteConfig.server_url ?? "",
          remoteApiKey: remoteConfig.server_api_key || "",
        };
        const result = await proxyAuto(info, "GET", `/api/path/workflow-runs?${q}`);
        if (!result.ok) return sendProxyFailure(reply, result);
        const bareRuns = (result.data as { runs: WorkflowRun[] }).runs ?? [];
        const runs = bareRuns.map((r) => {
          const mapped = mapRemoteRun(r, info.remoteServerId, projectId);
          remoteRunMap.set(mapped.id, { ...info, bareRunId: r.id, projectId });
          return mapped;
        });
        return reply.send({ runs });
      }
    }
```

(e) In the **GET /:id**, **POST /:id/gate**, and **POST /:id/cancel** handlers, at the top of each (after `requireAuth`), insert the remote branch. Shared resolver first (place next to `proxyAuto`):

```ts
  const resolveRemoteRun = async (runId: string, userId: string | undefined) => {
    const info = remoteRunMap.get(runId);
    if (!info) return null;
    const project = await fastify.storage.projects.getById(info.projectId, userId);
    if (!project) return null;
    return info;
  };
```

Gate handler insert (before the local `workflowRuns.getById` lookup):

```ts
    if (req.params.id.startsWith("remote-")) {
      const info = await resolveRemoteRun(req.params.id, userId);
      if (!info) return reply.code(404).send({ error: "Run not found" });
      const result = await proxyAuto(info, "POST", `/api/workflow-runs/${info.bareRunId}/gate`, req.body ?? {});
      if (!result.ok) return sendProxyFailure(reply, result);
      const localRun = mapRemoteRun((result.data as { run: WorkflowRun }).run, info.remoteServerId, info.projectId);
      fastify.eventBus.emit({ type: "workflow:run-updated", projectId: info.projectId, branch: localRun.branch, run: localRun });
      return reply.send({ run: localRun });
    }
```

Cancel handler insert — identical but proxying `"POST", `/api/workflow-runs/${info.bareRunId}/cancel`` with no body.
GET /:id insert — identical but `"GET", `/api/workflow-runs/${info.bareRunId}`` and **no** `eventBus.emit`.

- [ ] **Step 5: Run tests**

Run: `cd packages/vibedeckx && npx vitest run src/routes/workflow-run-remote-routes.test.ts src/routes/workflow-run-routes.test.ts src/routes/remote-status-bridge.test.ts` — expected: PASS (all).
Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` — expected: clean.
Run: `pnpm --filter vibedeckx test` — expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/routes/workflow-run-routes.ts packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts packages/vibedeckx/src/routes/remote-status-bridge.ts packages/vibedeckx/src/routes/remote-status-bridge.test.ts
git commit -m "feat(workflow): front-server proxying for remote ad-hoc review runs"
```

---

### Task 6: Front bridge — handle `workflowRunUpdated` stream frames

Close the live-update loop: when a participant stream delivers `{ workflowRunUpdated }` (Task 3), map it into front id space and re-emit `workflow:run-updated` on the front bus — the existing `ChatSessionManager.handleWorkflowRunUpdated` then pushes it to the Main Chat WS and the panel refreshes.

**Files:**
- Modify: `packages/vibedeckx/src/routes/remote-status-bridge.ts` (add `runUpdatedEventFromRemoteFrame`)
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts` (`handleLiveMessage`)
- Test: `packages/vibedeckx/src/routes/remote-status-bridge.test.ts`

**Interfaces:**
- Consumes: `mapRemoteRun` (Task 5), frame `{ workflowRunUpdated: WorkflowRun }` (Task 3).
- Produces: `runUpdatedEventFromRemoteFrame(parsed: Record<string, unknown>, sessionId: string, remoteInfo: RemoteSessionInfo): Extract<GlobalEvent, { type: "workflow:run-updated" }> | null`.

- [ ] **Step 1: Write the failing test**

Append to `routes/remote-status-bridge.test.ts` (reuses the `remoteInfo`/`localId` fixtures from Task 2):

```ts
import { runUpdatedEventFromRemoteFrame } from "./remote-status-bridge.js";

describe("runUpdatedEventFromRemoteFrame", () => {
  const bare = {
    id: "run1", project_id: "wp1", branch: "dev",
    source_session_id: "src1", source_turn_end_index: 4,
    reviewer_session_id: "rev1", review_focus: null, review_target: null,
    feedback_snapshot: null, status: "waiting_feedback", error: null,
    created_at: "", updated_at: "",
  };

  it("maps run + participant ids into the front id space", () => {
    const evt = runUpdatedEventFromRemoteFrame({ workflowRunUpdated: bare }, localId, remoteInfo);
    expect(evt).toMatchObject({ type: "workflow:run-updated", projectId: "p1", branch: "dev" });
    expect(evt?.run).toMatchObject({
      id: "remote-srv1-p1-run1",
      project_id: "p1",
      source_session_id: "remote-srv1-p1-src1",
      reviewer_session_id: "remote-srv1-p1-rev1",
      status: "waiting_feedback",
    });
  });

  it("returns null for other frames", () => {
    expect(runUpdatedEventFromRemoteFrame({ taskCompleted: {} }, localId, remoteInfo)).toBeNull();
  });
});
```

Run: `cd packages/vibedeckx && npx vitest run src/routes/remote-status-bridge.test.ts` — expected: FAIL (no export).

- [ ] **Step 2: Implement**

(a) `routes/remote-status-bridge.ts` (import `WorkflowRun` type from `../storage/types.js`):

```ts
/**
 * Build the front-server `workflow:run-updated` event from a worker's
 * `{ workflowRunUpdated: run }` stream frame (mirrored by the worker's
 * WorkflowEngine onto participant streams — spec §Phase 1.5 事件回传).
 */
export function runUpdatedEventFromRemoteFrame(
  parsed: Record<string, unknown>,
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
): Extract<GlobalEvent, { type: "workflow:run-updated" }> | null {
  if (!("workflowRunUpdated" in parsed)) return null;
  const bare = parsed.workflowRunUpdated as WorkflowRun;
  const projectId = projectIdFromRemoteSessionId(sessionId, remoteInfo);
  const run = mapRemoteRun(bare, remoteInfo.remoteServerId, projectId);
  return { type: "workflow:run-updated", projectId, branch: run.branch, run };
}
```

(b) `remote-agent-sessions.ts` — in `handleLiveMessage`, add a new branch right after the `"taskCompleted" in parsed` branch:

```ts
    } else if ("workflowRunUpdated" in parsed) {
      // Worker-side WorkflowEngine mirrors run transitions onto participant
      // session streams. Re-emit on the front bus (ChatSessionManager pushes
      // it to the Main Chat WS). Both participant streams may deliver the
      // same update — duplicate emits are harmless, the panel refresh is
      // idempotent. Not broadcast to agent-stream subscribers: the frame is
      // not part of the agent conversation protocol.
      if (eventBus) {
        const evt = runUpdatedEventFromRemoteFrame(parsed, sessionId, remoteInfo);
        if (evt) eventBus.emit(evt);
      }
```

Extend the existing `./routes/remote-status-bridge.js` import with `runUpdatedEventFromRemoteFrame`.

- [ ] **Step 3: Run tests**

Run: `cd packages/vibedeckx && npx vitest run src/routes/remote-status-bridge.test.ts` — expected: PASS (all).
Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` — expected: clean.
Run: `pnpm --filter vibedeckx test` — expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/routes/remote-status-bridge.ts packages/vibedeckx/src/routes/remote-status-bridge.test.ts packages/vibedeckx/src/remote-agent-sessions.ts
git commit -m "feat(workflow): bridge workflowRunUpdated frames to the front event bus"
```

---

### Task 7: Frontend unlock + full checks + two-server remote e2e + spec status

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/review-dialog.tsx` (line ~25)
- Modify: `docs/superpowers/specs/2026-07-17-workflow-engine-review-loop-design.md` (status header)

- [ ] **Step 1: Unlock the ReviewDialog for remote sessions**

In `review-dialog.tsx` change:

```ts
  if (!sessionId || sessionId.startsWith("remote-")) return null;
```

to:

```ts
  if (!sessionId) return null;
```

(The event-card Review button in `main-conversation.tsx` has no remote gate — nothing to change there; it starts rendering for remote sessions automatically once the bridge forwards `turnEndEntryIndex`.)

- [ ] **Step 2: Full checks**

Run all four; expected results:
- `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` — clean.
- `pnpm --filter vibedeckx test` — all pass.
- `cd apps/vibedeckx-ui && npx tsc --noEmit` — clean.
- `pnpm --filter vibedeckx-ui lint` — only pre-existing failures in files this feature never touched (diff `main..HEAD` to identify touched files; run targeted `npx eslint` on them — must be clean).

- [ ] **Step 3: Two-server e2e smoke (real claude CLI, front + worker on localhost)**

Build once: `pnpm build:main`.

**Worker** (owns the repo + sessions):
```bash
rm -rf /tmp/vdx15-w /tmp/vdx15-repo && mkdir -p /tmp/vdx15-w/.vibedeckx /tmp/vdx15-repo
cd /tmp/vdx15-repo && git init -q && git config user.email t@t && git config user.name t
echo "# remote smoke" > README.md && git add . && git commit -qm init
cd /var/tmp/vibedeckx/worktrees/vibedeckx-49e0cefb/dev1
VIBEDECKX_API_KEY=smokekey nohup node packages/vibedeckx/dist/bin.js start --no-ui --port 5391 --accept-remote --data-dir /tmp/vdx15-w/.vibedeckx > /tmp/vdx15-w/server.log 2>&1 &
```

**Front** (proxies; no local repo path):
```bash
rm -rf /tmp/vdx15-f && mkdir -p /tmp/vdx15-f/.vibedeckx
nohup node packages/vibedeckx/dist/bin.js start --no-ui --port 5390 --data-dir /tmp/vdx15-f/.vibedeckx > /tmp/vdx15-f/server.log 2>&1 &
```

**Configure the front** — create a remote server + a project bound to it. Discover the exact route shapes first (`grep -n "fastify.post\|fastify.put" packages/vibedeckx/src/routes/remote-server-routes.ts packages/vibedeckx/src/routes/project-routes.ts` and read the handlers): you need (1) a remote-server row with `url=http://127.0.0.1:5391`, `api_key=smokekey`, connection_mode outbound; (2) a project with `agent_mode=<serverId>`; (3) a `projectRemotes` row with `remote_path=/tmp/vdx15-repo`. If any of these lacks a REST route, fall back to direct sqlite inserts into `/tmp/vdx15-f/.vibedeckx/data.sqlite` (`sqlite3` CLI; inspect the schema first with `.schema remote_servers` etc.) and restart the front.

**Drive the loop** (all against the FRONT, port 5390; `$PID` = front project id):
1. `POST /api/projects/$PID/agent-sessions/new` `{"branch": null, "permissionMode": "edit", "agentType": "claude-code"}` → expect a `remote-`-prefixed session id `$RID`.
2. `POST /api/agent-sessions/$RID/message` `{"content": "Create a file hello-remote.txt containing hello-remote. Then stop."}`.
3. Poll the WORKER directly for turn completion (the front's patch cache is only hydrated once a stream is attached — headless polling goes to the source): `curl -H "X-Vibedeckx-Api-Key: smokekey" http://127.0.0.1:5391/api/agent-sessions/<bareId>` where `<bareId>` = `$RID` minus the `remote-<serverId>-<projectId>-` prefix, until a `turn_end` entry appears. Verify `/tmp/vdx15-repo/hello-remote.txt` exists.
4. `POST http://127.0.0.1:5390/api/workflow-runs` `{"projectId": "$PID", "branch": null, "sourceSessionId": "$RID"}` → expect **201**, `run.id` `remote-`-prefixed, `reviewer_session_id` `remote-`-prefixed. A second identical POST while active → **409** (worker's session lock, forwarded).
5. Poll `GET http://127.0.0.1:5390/api/workflow-runs?projectId=$PID` until `status == "waiting_feedback"`; assert `feedback_snapshot` is non-empty full text.
6. Suppression check: `grep "\[Agent Event: Task Completed\]" /tmp/vdx15-f/server.log` must show **no** entry for the reviewer's bare/local id after its completion (the frame carried `workflowSuppressed`), and `grep workflowRunUpdated /tmp/vdx15-f/server.log` (or the passing step 5 via push rather than poll) confirms frames arrived.
7. `POST http://127.0.0.1:5390/api/workflow-runs/<remoteRunId>/gate` `{"action": "approve", "editedPayload": "REMOTE-SMOKE-EDITED: <original text prefix>"}` → **200**, `status == "completed"`.
8. Verify on the worker that the source session received the feedback: `curl -H "X-Vibedeckx-Api-Key: smokekey" http://127.0.0.1:5391/api/agent-sessions/<bareId>` — last user message contains `[Review Feedback]` and `REMOTE-SMOKE-EDITED`.

Cleanup: kill both node processes, `rm -rf /tmp/vdx15-w /tmp/vdx15-f /tmp/vdx15-repo`, verify no stray `claude` processes.

If step 4 or 5 fails, read BOTH server logs before touching code — misconfigured remote rows (step "Configure the front") are the most likely cause; distinguish config errors from code bugs before fixing anything.

- [ ] **Step 4: Update spec status + commit**

In `docs/superpowers/specs/2026-07-17-workflow-engine-review-loop-design.md`, change the header line:

```markdown
> 状态：**Phase 1 已实现**（实现计划 docs/superpowers/plans/2026-07-17-adhoc-review-phase1.md）。
```

to:

```markdown
> 状态：**Phase 1 + 1.5 已实现**（实现计划 docs/superpowers/plans/2026-07-17-adhoc-review-phase1.md、
> docs/superpowers/plans/2026-07-17-remote-adhoc-review-phase15.md）。
```

```bash
git add apps/vibedeckx-ui/components/agent/review-dialog.tsx docs/superpowers/specs/2026-07-17-workflow-engine-review-loop-design.md
git commit -m "feat(ui): enable Review entry for remote sessions; mark spec Phase 1.5 implemented"
```

---

## Known limitations (documented, not blocking)

- **Legacy `agent_mode === "remote"`** (pre-multi-remote projects): the GET-list proxy resolves config via `getByProjectAndServer(projectId, agent_mode)` which misses the legacy sentinel — such workspaces fall through to the (empty) local list. The new-session route has legacy resolution; porting it here is a follow-up if any legacy project still exists.
- **`remoteRunMap` is in-memory**: a front restart forgets run handles until the panel's next proxied GET re-populates them (≤5s while a run is active). Deliberate — mirrors `remoteSessionMap`'s hydrate-by-use model.
- **Duplicate `workflowRunUpdated` delivery** when both participant streams are attached — harmless, panel refresh is idempotent.
