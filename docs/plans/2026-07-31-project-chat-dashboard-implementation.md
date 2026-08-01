# Project Dashboard and Project Chat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the project Home workspace summary with a project activity dashboard and add persistent, project-scoped Chat Threads that coordinate tasks, schedules, workspaces, and agent sessions.

**Architecture:** Add Kysely-backed Project Chat thread/message/context repositories and a project-level activity query, expose authenticated REST and WebSocket APIs, and introduce a `ProjectChatManager` whose identity is `project + user + thread`, never a branch. Build the UI as an Overview dashboard plus a two-column Project Chat workbench with the chat in the main column and Threads/Context sharing one auxiliary rail.

**Tech Stack:** TypeScript, Fastify, Kysely, SQLite/better-sqlite3, AI SDK streaming, WebSocket JSON patches, Next.js 16, React 19, Tailwind CSS, Vitest, Testing Library.

---

## Implementation constraints

- Follow `docs/plans/2026-07-31-project-chat-dashboard-design.md`.
- Use @superpowers:test-driven-development for every production-code task.
- Use @superpowers:systematic-debugging for any unexpected failure.
- Use @superpowers:verification-before-completion before the final handoff.
- Do not retrofit project scope into the existing branch-scoped `ChatSessionManager`; keep the two identities explicit.
- Do not add a Mission entity.
- Do not let the browser query every branch or schedule to build the Overview.
- Every route and commander tool must authorize the thread and re-check that referenced entities belong to its project.
- Keep destructive commander tools out of V1.

### Task 1: Add Project Chat persistence

**Files:**
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Modify: `packages/vibedeckx/src/storage/schema.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Create: `packages/vibedeckx/src/storage/repositories/project-chat.ts`
- Create: `packages/vibedeckx/src/storage/project-chat.test.ts`

**Step 1: Write failing repository tests**

Create tests covering:

```ts
it("stores multiple project-scoped threads without a branch", async () => {
  const first = await storage.projectChatThreads.create({
    id: "t1", project_id: "p1", user_id: "u1", title: null,
  });
  const second = await storage.projectChatThreads.create({
    id: "t2", project_id: "p1", user_id: "u1", title: "Release check",
  });

  expect(first).not.toHaveProperty("branch");
  expect((await storage.projectChatThreads.listByProject("p1", "u1", 10)).map(t => t.id))
    .toEqual(["t2", "t1"]);
});

it("orders messages by sequence and upserts context references", async () => {
  await storage.projectChatMessages.append({
    id: "m2", thread_id: "t1", sequence: 2, type: "assistant", content: "done",
  });
  await storage.projectChatMessages.append({
    id: "m1", thread_id: "t1", sequence: 1, type: "user", content: "status?",
  });
  await storage.projectChatContextRefs.touch("t1", "agent_session", "s1");
  await storage.projectChatContextRefs.touch("t1", "agent_session", "s1");

  expect((await storage.projectChatMessages.list("t1")).map(m => m.id)).toEqual(["m1", "m2"]);
  expect(await storage.projectChatContextRefs.list("t1")).toHaveLength(1);
});
```

Also test user-scoped thread lookup, title update, archive/unarchive behavior, `updated_at` touching, and cascade deletion of messages/context refs.

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter vibedeckx test -- src/storage/project-chat.test.ts
```

Expected: FAIL because Project Chat storage members and tables do not exist.

**Step 3: Add schema types and storage interfaces**

Add these domain types to `storage/types.ts`:

```ts
export type ProjectChatMessageType =
  | "user" | "assistant" | "system" | "tool_use" | "tool_result"
  | "tool_approval_request" | "operation" | "error" | "turn_end";

export type ProjectChatContextEntityType =
  | "task" | "workspace" | "agent_session" | "schedule" | "schedule_run";

export interface ProjectChatThread {
  id: string;
  project_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived_at: number | null;
}
```

Add `ProjectChatMessage` and `ProjectChatContextRef` with the columns from the design. Add `projectChatThreads`, `projectChatMessages`, and `projectChatContextRefs` repository contracts to `Storage`.

Add corresponding Kysely table interfaces and `DB` keys in `storage/schema.ts`.

**Step 4: Add DDL and indexes**

In `createDatabase` add idempotent tables and indexes:

```sql
CREATE TABLE IF NOT EXISTS project_chat_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  archived_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_chat_threads_project_user_updated
  ON project_chat_threads(project_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(thread_id, sequence),
  FOREIGN KEY (thread_id) REFERENCES project_chat_threads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_chat_context_refs (
  thread_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  last_referenced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(thread_id, entity_type, entity_id),
  FOREIGN KEY (thread_id) REFERENCES project_chat_threads(id) ON DELETE CASCADE
);
```

**Step 5: Implement the Kysely repositories**

Create `createProjectChatRepos(kdb)` returning the three new repository groups. Use deterministic ordering (`updated_at DESC, id DESC` for threads; `sequence ASC` for messages), an atomic context-ref upsert, and project+user filters in thread reads.

Wire the repository into `createStorage` in `storage/sqlite.ts`.

**Step 6: Run storage tests and type-check**

Run:

```bash
pnpm --filter vibedeckx test -- src/storage/project-chat.test.ts
pnpm --filter vibedeckx exec tsc --noEmit -p tsconfig.json
```

Expected: PASS and no TypeScript errors.

**Step 7: Commit**

```bash
git add packages/vibedeckx/src/storage
git commit -m "feat(storage): persist project chat threads"
```

### Task 2: Add authenticated Thread CRUD routes

**Files:**
- Create: `packages/vibedeckx/src/routes/project-chat-routes.ts`
- Create: `packages/vibedeckx/src/routes/project-chat-routes.test.ts`
- Modify: `packages/vibedeckx/src/server.ts`

**Step 1: Write failing route tests**

Cover these endpoints:

```text
GET    /api/projects/:projectId/project-chat/threads
POST   /api/projects/:projectId/project-chat/threads
GET    /api/project-chat/threads/:threadId
PATCH  /api/project-chat/threads/:threadId
DELETE /api/project-chat/threads/:threadId
```

The create body accepts an optional first message but no branch/workspace:

```ts
const response = await app.inject({
  method: "POST",
  url: "/api/projects/p1/project-chat/threads",
  payload: { message: "Summarize current failures" },
});
expect(response.statusCode).toBe(201);
expect(response.json().thread).not.toHaveProperty("branch");
```

Test 404 for a foreign project and 403/404 without leaking existence for a thread owned by another user.

**Step 2: Run the test to verify it fails**

```bash
pnpm --filter vibedeckx test -- src/routes/project-chat-routes.test.ts
```

Expected: FAIL because the route plugin does not exist.

**Step 3: Implement route helpers and CRUD**

Use `requireAuth` and `resolveUserId`. Centralize:

```ts
async function getOwnedThread(fastify, threadId, userId) {
  return fastify.storage.projectChatThreads.getByIdForUser(threadId, userId);
}
```

Create uses `randomUUID()`. PATCH accepts exactly `{ title?: string | null, archived?: boolean }`, trims titles, and rejects empty overlong values. DELETE is a user action and may hard-delete after the existing UI confirmation; it is not exposed as a commander tool.

**Step 4: Register the plugin and run tests**

Register `projectChatRoutes` beside `chatSessionRoutes` in `server.ts`.

```bash
pnpm --filter vibedeckx test -- src/routes/project-chat-routes.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/project-chat-routes.ts packages/vibedeckx/src/routes/project-chat-routes.test.ts packages/vibedeckx/src/server.ts
git commit -m "feat(api): add project chat thread routes"
```

### Task 3: Build the persistent Project Chat streaming runtime

**Files:**
- Create: `packages/vibedeckx/src/project-chat-manager.ts`
- Create: `packages/vibedeckx/src/project-chat-manager.test.ts`
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts`
- Modify: `packages/vibedeckx/src/server-types.ts`
- Modify: `packages/vibedeckx/src/routes/project-chat-routes.ts`
- Modify: `packages/vibedeckx/src/routes/websocket-routes.ts`

**Step 1: Write failing manager tests**

Inject a fake model stream and verify:

- opening a thread rehydrates persisted messages;
- sending appends user/assistant/tool/turn-end messages with monotonic sequence;
- only one turn runs per thread and a second message queues;
- `stopGeneration` stops only the target thread;
- two threads in one project can run independently;
- process restart followed by manager construction restores the transcript.

Test the key identity explicitly:

```ts
expect(manager.getThread("t1")?.projectId).toBe("p1");
expect(manager.getThread("t1")).not.toHaveProperty("branch");
```

**Step 2: Run the manager test to verify it fails**

```bash
pnpm --filter vibedeckx test -- src/project-chat-manager.test.ts
```

Expected: FAIL because `ProjectChatManager` does not exist.

**Step 3: Implement the runtime boundary**

Keep this manager separate from `ChatSessionManager`. Reuse small pure helpers only after extracting them with characterization tests. Its public surface should be:

```ts
class ProjectChatManager {
  openThread(threadId: string, userId: string): Promise<ProjectChatSnapshot>;
  sendMessage(threadId: string, userId: string, content: string): Promise<void>;
  stopGeneration(threadId: string, userId: string): boolean;
  subscribe(threadId: string, socket: WebSocket): () => void;
  resolveToolApproval(threadId: string, userId: string, approvalId: string, approved: boolean): boolean;
  shutdown(): Promise<void>;
}
```

Persist every completed patch-worthy item before broadcasting it. Treat the database as the recovery source and the in-memory object as live execution state only.

**Step 4: Add REST message/stop/approval endpoints**

Add:

```text
POST /api/project-chat/threads/:threadId/messages
POST /api/project-chat/threads/:threadId/stop
POST /api/project-chat/threads/:threadId/tool-approval
```

All endpoints authorize through the stored thread before touching the manager.

**Step 5: Add the WebSocket stream**

Add `/api/project-chat/threads/:threadId/stream` to `websocket-routes.ts`. Authenticate before upgrade subscription, send a complete initial snapshot, then stream the same JSON-patch envelope shape used by the existing conversation UI where practical.

**Step 6: Wire lifecycle and run tests**

Construct/decorate `projectChatManager` in `shared-services.ts`, expose its type in `server-types.ts`, and include shutdown cleanup.

```bash
pnpm --filter vibedeckx test -- src/project-chat-manager.test.ts src/routes/project-chat-routes.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/vibedeckx/src/project-chat-manager.ts packages/vibedeckx/src/project-chat-manager.test.ts packages/vibedeckx/src/plugins/shared-services.ts packages/vibedeckx/src/server-types.ts packages/vibedeckx/src/routes/project-chat-routes.ts packages/vibedeckx/src/routes/websocket-routes.ts
git commit -m "feat: add persistent project chat runtime"
```

### Task 4: Add read-only Project Commander tools and context tracking

**Files:**
- Create: `packages/vibedeckx/src/project-chat-tools.ts`
- Create: `packages/vibedeckx/src/project-chat-tools.test.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`

**Step 1: Write authorization-first failing tests**

Test tools for:

- project summary;
- tasks;
- workspaces;
- agent sessions across local/remote workspaces;
- one agent session's status/recent transcript;
- schedules;
- recent schedule runs;
- one run's report/output.

For every entity tool, include a foreign-project test:

```ts
await expect(tools.getScheduleRun({ runId: "run-in-p2" }))
  .rejects.toThrow("Object is not part of this project");
expect(storage.projectChatContextRefs.touch).not.toHaveBeenCalled();
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter vibedeckx test -- src/project-chat-tools.test.ts
```

Expected: FAIL because the tool factory does not exist.

**Step 3: Implement a project-bound tool factory**

Create tools from an immutable authorization context:

```ts
createProjectChatTools({
  projectId,
  threadId,
  userId,
  storage,
  agentSessionManager,
  remoteSessionMap,
});
```

Never accept `projectId` as a model argument. Entity IDs are model arguments, but each handler loads the object and verifies its project before returning data. After a successful read, call `projectChatContextRefs.touch` with the correct structured type.

For remote sessions, reuse the existing remote mapping/proxy helpers rather than parsing synthetic IDs in the tool.

**Step 4: Register tools in the manager prompt/runtime**

The system prompt must state that Project Chat is project-scoped, may inspect multiple workspaces, and must not imply that it belongs to a branch.

**Step 5: Run tests**

```bash
pnpm --filter vibedeckx test -- src/project-chat-tools.test.ts src/project-chat-manager.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/vibedeckx/src/project-chat-tools.ts packages/vibedeckx/src/project-chat-tools.test.ts packages/vibedeckx/src/project-chat-manager.ts
git commit -m "feat: add project commander read tools"
```

### Task 5: Add safe state-changing commander tools and correlated events

**Files:**
- Modify: `packages/vibedeckx/src/project-chat-tools.ts`
- Modify: `packages/vibedeckx/src/project-chat-tools.test.ts`
- Modify: `packages/vibedeckx/src/project-chat-manager.ts`
- Modify: `packages/vibedeckx/src/event-bus.ts`

**Step 1: Write failing capability tests**

Cover V1 mutations:

- create/update Task;
- create Agent Session in an explicit workspace;
- send to an existing Agent Session;
- run an existing Schedule now.

Verify missing or ambiguous workspace yields a structured selection request, not a guessed branch. Verify the factory exposes no delete, worktree-create, schedule-update, stop-session, or Git mutation tools.

**Step 2: Write failing correlation tests**

When a thread starts an operation, persist a context reference and correlation record. Only matching `session:*`/`schedule:*` events may enqueue a reactive turn or update an operation card for that thread.

```ts
eventBus.emit({ type: "schedule:run-finished", projectId: "p1", scheduleId: "sch1", runId: "r1", status: "completed" });
expect(threadT1Updates).toContainEqual(expect.objectContaining({ entityId: "r1" }));
expect(threadT2Updates).toEqual([]);
```

If the existing event payload lacks `scheduleId`/`runId`, extend it at the scheduler emit sites in the same step and update the affected event tests.

**Step 3: Run tests to verify they fail**

```bash
pnpm --filter vibedeckx test -- src/project-chat-tools.test.ts src/project-chat-manager.test.ts
```

Expected: FAIL on missing mutation tools/correlation.

**Step 4: Implement the minimal mutation set**

Every mutation:

1. loads and authorizes its target under the thread's project;
2. records a structured `tool_use` message;
3. performs the operation through the existing service/manager;
4. records a context reference;
5. persists a structured result suitable for a UI card.

Represent ambiguous workspace selection as a persisted structured message with candidate branch/target IDs. A follow-up user selection resumes the queued intent; do not create a worktree automatically.

**Step 5: Subscribe only to correlated events**

Maintain recoverable operation correlation in persisted message content or a small explicit operation table if tests prove message scanning insufficient. Do not subscribe a thread to all project events.

**Step 6: Run tests**

```bash
pnpm --filter vibedeckx test -- src/project-chat-tools.test.ts src/project-chat-manager.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/vibedeckx/src/project-chat-tools.ts packages/vibedeckx/src/project-chat-tools.test.ts packages/vibedeckx/src/project-chat-manager.ts packages/vibedeckx/src/event-bus.ts
git commit -m "feat: let project chat coordinate project work"
```

### Task 6: Add the Project Activity aggregate endpoint

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/agent-sessions.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/scheduled.ts`
- Create: `packages/vibedeckx/src/project-activity.ts`
- Create: `packages/vibedeckx/src/routes/project-activity-routes.ts`
- Create: `packages/vibedeckx/src/routes/project-activity-routes.test.ts`
- Modify: `packages/vibedeckx/src/server.ts`

**Step 1: Write the failing aggregate route test**

Seed multiple branches, schedules, runs, tasks, and threads. Assert one request returns globally ordered bounded sets:

```ts
const body = (await app.inject({ method: "GET", url: "/api/projects/p1/activity" })).json();
expect(body.recentAgentSessions.map((x: { id: string }) => x.id)).toEqual(["newest", "older"]);
expect(body.recentScheduleRuns.map((x: { id: string }) => x.id)).toEqual(["run-new", "run-old"]);
expect(body.priorityTasks).toHaveLength(5);
expect(body.attention).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: "schedule_run", status: "failed" }),
]));
```

Test that project P2 data and archived tasks/threads are excluded.

**Step 2: Run the route test to verify it fails**

```bash
pnpm --filter vibedeckx test -- src/routes/project-activity-routes.test.ts
```

Expected: FAIL with route not found.

**Step 3: Add bounded repository queries**

Add:

- `agentSessions.listRecentByProject(projectId, limit)`;
- `scheduledTaskRuns.getRecentByProject(projectId, limit)` using a join with `scheduled_tasks`;
- any task query needed for priority ordering without loading unbounded history.

Return run summary/report preview but not raw output. Keep limits server-owned.

**Step 4: Implement the pure activity assembler**

Create `getProjectActivity(storage, projectId, userId)` that returns:

```ts
interface ProjectActivity {
  recentThreads: ProjectChatThread[];
  recentAgentSessions: AgentSessionActivity[];
  recentScheduleRuns: ScheduleRunActivity[];
  priorityTasks: Task[];
  attention: AttentionItem[];
  summary: { running: number; failed: number; nextScheduleAt: string | null };
}
```

Do not include workspace rows as a standalone section.

**Step 5: Implement/register the route and run tests**

```bash
pnpm --filter vibedeckx test -- src/routes/project-activity-routes.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/vibedeckx/src/storage packages/vibedeckx/src/project-activity.ts packages/vibedeckx/src/routes/project-activity-routes.ts packages/vibedeckx/src/routes/project-activity-routes.test.ts packages/vibedeckx/src/server.ts
git commit -m "feat(api): aggregate project activity"
```

### Task 7: Add frontend API types and reactive hooks

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts`
- Create: `apps/vibedeckx-ui/hooks/use-project-activity.ts`
- Create: `apps/vibedeckx-ui/hooks/use-project-activity.test.tsx`
- Create: `apps/vibedeckx-ui/hooks/use-project-chat.ts`
- Create: `apps/vibedeckx-ui/hooks/use-project-chat.test.tsx`

**Step 1: Write failing hook tests**

For activity, test project switches, stale-response rejection, clearing with no project, and coalesced refresh after bursts of `session:*`, `schedule:*`, and `task:*` events.

For Project Chat, test:

- create/list/open/rename/archive/delete Thread API calls;
- WebSocket snapshot rehydration;
- streamed patch application;
- cleanup/reconnect when switching Threads;
- sending and stopping a turn.

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter vibedeckx-ui test -- hooks/use-project-activity.test.tsx hooks/use-project-chat.test.tsx
```

Expected: FAIL because the hooks do not exist.

**Step 3: Add API contracts**

Add `ProjectActivity`, `ProjectChatThread`, `ProjectChatMessage`, `ProjectChatContextRef`, and structured operation-message types to `lib/api.ts`, plus methods for every new route.

**Step 4: Implement `useProjectActivity`**

Follow the generation/ref pattern in `use-schedules.ts` so stale requests from a prior project cannot overwrite current state. Coalesce event refreshes with one short timer and clean it up on project change/unmount.

**Step 5: Implement `useProjectChat`**

Adapt JSON-patch mechanics from `use-chat-session.ts`, but key cache and WebSocket ownership by `threadId`, not `projectId:branch`. Keep thread CRUD in the hook or a small companion hook; do not call the branch-scoped chat endpoint.

**Step 6: Run tests and type-check**

```bash
pnpm --filter vibedeckx-ui test -- hooks/use-project-activity.test.tsx hooks/use-project-chat.test.tsx
pnpm --filter vibedeckx-ui exec tsc --noEmit
```

Expected: PASS and no TypeScript errors.

**Step 7: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/hooks/use-project-activity.ts apps/vibedeckx-ui/hooks/use-project-activity.test.tsx apps/vibedeckx-ui/hooks/use-project-chat.ts apps/vibedeckx-ui/hooks/use-project-chat.test.tsx
git commit -m "feat(ui): add project activity and chat data hooks"
```

### Task 8: Replace Project Home cards with the activity dashboard

**Files:**
- Modify: `apps/vibedeckx-ui/components/project/project-info-view.tsx`
- Create: `apps/vibedeckx-ui/components/project/project-activity-view.tsx`
- Create: `apps/vibedeckx-ui/components/project/project-activity-view.test.tsx`
- Create: `apps/vibedeckx-ui/components/project/project-chat-card.tsx`
- Create: `apps/vibedeckx-ui/components/project/recent-agent-sessions-card.tsx`
- Create: `apps/vibedeckx-ui/components/project/schedule-results-card.tsx`
- Create: `apps/vibedeckx-ui/components/project/priority-tasks-card.tsx`
- Create: `apps/vibedeckx-ui/components/project/attention-required-card.tsx`
- Modify: `apps/vibedeckx-ui/app/page.tsx`

**Step 1: Write failing dashboard component tests**

Assert:

- no standalone Workspaces card;
- Project Chat composer and three recent Thread shortcuts;
- five-to-eight session rows with workspace context;
- five recent Schedule Runs with report preview;
- priority-task ordering/limit;
- Attention Required actions and All Clear collapse;
- click callbacks route to the correct Agent Session, Task, Schedule Run, or Chat Thread.

**Step 2: Run the component test to verify it fails**

```bash
pnpm --filter vibedeckx-ui test -- components/project/project-activity-view.test.tsx
```

Expected: FAIL because the dashboard does not exist.

**Step 3: Build focused card components**

Keep data fetching in `ProjectActivityView`; cards receive typed data and callbacks. Reuse existing status icon/color language from tasks, workspace status, and schedules, but do not copy entire view components.

The Project Chat composer should call one callback with trimmed text. Disable duplicate submission while thread creation is in flight and preserve input on recoverable failure.

**Step 4: Integrate into Project Home**

Keep the Home/Settings tabs in `ProjectInfoView`. Replace the Tasks/Workspaces grid with `ProjectActivityView`. Pass navigation callbacks from `app/page.tsx`; do not make cards mutate global URL state directly.

**Step 5: Run tests and lint**

```bash
pnpm --filter vibedeckx-ui test -- components/project/project-activity-view.test.tsx
pnpm --filter vibedeckx-ui lint -- components/project
```

Expected: PASS with no lint errors.

**Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/project apps/vibedeckx-ui/app/page.tsx
git commit -m "feat(ui): turn project home into activity dashboard"
```

### Task 9: Build the two-column Project Chat workbench

**Files:**
- Create: `apps/vibedeckx-ui/components/project-chat/project-chat-workbench.tsx`
- Create: `apps/vibedeckx-ui/components/project-chat/project-chat-workbench.test.tsx`
- Create: `apps/vibedeckx-ui/components/project-chat/project-chat-conversation.tsx`
- Create: `apps/vibedeckx-ui/components/project-chat/project-chat-auxiliary-rail.tsx`
- Create: `apps/vibedeckx-ui/components/project-chat/project-chat-thread-history.tsx`
- Create: `apps/vibedeckx-ui/components/project-chat/index.ts`
- Modify: `apps/vibedeckx-ui/components/layout/app-sidebar.tsx`
- Modify: `apps/vibedeckx-ui/lib/url-state.ts`
- Modify: `apps/vibedeckx-ui/app/page.tsx`

**Step 1: Write failing layout/navigation tests**

Test:

- one main conversation column plus one auxiliary rail, never a third nested column;
- Threads above Context in the same rail;
- five recent threads and View All;
- new/switch/rename/delete-confirm flows;
- rail collapse with header thread switching still available;
- Back to Overview;
- URL restoration for `/p/:projectId/chat/:threadId` (or the route shape selected consistently in `url-state.ts`).

**Step 2: Run the test to verify it fails**

```bash
pnpm --filter vibedeckx-ui test -- components/project-chat/project-chat-workbench.test.tsx
```

Expected: FAIL because the workbench does not exist.

**Step 3: Add a distinct active view and URL state**

Add `project-chat` to `ActiveView` and URL parsing/building. Project selection still opens `project-info`; only a new/recent Thread transition opens `project-chat` with a `threadId`.

**Step 4: Build the conversation surface**

Reuse presentational AI elements from `main-conversation.tsx` but bind them to `useProjectChat`. Do not pass `branch`. Render persisted user/assistant/tool/error/turn-boundary messages and expose send/stop.

**Step 5: Build the shared auxiliary rail**

Use two stacked collapsible sections. Context rows must resolve deleted entities to a disabled `Deleted` row. View All opens a searchable dialog/drawer. Keep the full rail hideable.

**Step 6: Integrate transitions**

- Overview send: create Thread with first message, set URL, show workbench.
- Recent Thread: set URL, show workbench.
- Recent Agent Session: preserve the existing concrete workspace/session navigation.
- Back: return to Project Overview without calling stop.

**Step 7: Run tests and type-check**

```bash
pnpm --filter vibedeckx-ui test -- components/project-chat/project-chat-workbench.test.tsx lib/url-state.test.ts
pnpm --filter vibedeckx-ui exec tsc --noEmit
```

If `lib/url-state.test.ts` does not yet exist, create it in this task with round-trip coverage for the new path.

Expected: PASS.

**Step 8: Commit**

```bash
git add apps/vibedeckx-ui/components/project-chat apps/vibedeckx-ui/components/layout/app-sidebar.tsx apps/vibedeckx-ui/lib/url-state.ts apps/vibedeckx-ui/lib/url-state.test.ts apps/vibedeckx-ui/app/page.tsx
git commit -m "feat(ui): add project chat workbench"
```

### Task 10: Render live operation cards and actionable errors

**Files:**
- Create: `apps/vibedeckx-ui/components/project-chat/project-operation-card.tsx`
- Create: `apps/vibedeckx-ui/components/project-chat/project-operation-card.test.tsx`
- Create: `apps/vibedeckx-ui/components/project-chat/workspace-selection-card.tsx`
- Modify: `apps/vibedeckx-ui/components/project-chat/project-chat-conversation.tsx`
- Modify: `apps/vibedeckx-ui/components/project-chat/project-chat-auxiliary-rail.tsx`

**Step 1: Write failing card tests**

Cover agent-session and schedule-run states: queued, running, completed, failed, timeout, remote offline, and deleted target. Verify safe actions:

- Open Session;
- View Output;
- Run Again;
- select one of explicit workspace candidates.

Verify no destructive action is rendered.

**Step 2: Run the test to verify it fails**

```bash
pnpm --filter vibedeckx-ui test -- components/project-chat/project-operation-card.test.tsx
```

Expected: FAIL because structured cards do not exist.

**Step 3: Implement cards as pure renderers**

Take a discriminated union from `lib/api.ts`; do not infer state by parsing assistant prose. Keep action callbacks outside the card so authorization and navigation stay in the workbench/hook.

**Step 4: Connect live updates and Context**

WebSocket operation patches update the message card and corresponding Context row. A completed/failed operation must remain readable after reload from persisted messages.

**Step 5: Run tests**

```bash
pnpm --filter vibedeckx-ui test -- components/project-chat/project-operation-card.test.tsx components/project-chat/project-chat-workbench.test.tsx
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/project-chat apps/vibedeckx-ui/lib/api.ts
git commit -m "feat(ui): show project chat operation status"
```

### Task 11: Add responsive behavior and end-to-end tracer coverage

**Files:**
- Modify: `apps/vibedeckx-ui/components/project-chat/project-chat-workbench.tsx`
- Modify: `apps/vibedeckx-ui/components/project-chat/project-chat-auxiliary-rail.tsx`
- Create: `apps/vibedeckx-ui/components/project-chat/project-chat-responsive.test.tsx`
- Create: `packages/vibedeckx/src/project-chat.integration.test.ts`

**Step 1: Write failing responsive tests**

Mock the mobile breakpoint and verify Threads and Context move together into one drawer, the main Chat remains usable, and switching a Thread closes the drawer without losing state.

**Step 2: Write the failing backend tracer integration test**

Exercise:

```text
create Project Chat Thread
  -> send a concrete coding request
  -> receive workspace selection request
  -> choose workspace
  -> spawn Agent Session
  -> receive correlated completion
  -> recreate ProjectChatManager
  -> reopen Thread with transcript + context intact
```

Include a second Thread and foreign project to prove no event or entity leakage.

**Step 3: Run tests to verify they fail**

```bash
pnpm --filter vibedeckx-ui test -- components/project-chat/project-chat-responsive.test.tsx
pnpm --filter vibedeckx test -- src/project-chat.integration.test.ts
```

Expected: FAIL on missing responsive/tracer behavior.

**Step 4: Implement the responsive rail/drawer**

Use the existing mobile hook and UI drawer/dialog primitives. Do not render duplicate live chat trees; move only the auxiliary content.

**Step 5: Fix only the tracer gaps**

Add the minimum runtime glue needed for correlation recovery and rehydration. Do not broaden commander capabilities.

**Step 6: Run focused tests**

```bash
pnpm --filter vibedeckx-ui test -- components/project-chat
pnpm --filter vibedeckx test -- src/project-chat.integration.test.ts src/project-chat-manager.test.ts src/project-chat-tools.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/vibedeckx-ui/components/project-chat packages/vibedeckx/src/project-chat.integration.test.ts packages/vibedeckx/src/project-chat-manager.ts
git commit -m "test: cover project chat coordination flow"
```

### Task 12: Full verification and documentation reconciliation

**Files:**
- Modify if needed: `docs/plans/2026-07-31-project-chat-dashboard-design.md`
- Modify if needed: `docs/plans/2026-07-31-project-chat-dashboard-implementation.md`

**Step 1: Run backend tests**

```bash
pnpm --filter vibedeckx test
```

Expected: all backend tests PASS.

**Step 2: Run frontend tests**

```bash
pnpm --filter vibedeckx-ui test
```

Expected: all frontend tests PASS.

**Step 3: Run type-checks, lint, and builds**

```bash
pnpm --filter vibedeckx exec tsc --noEmit -p tsconfig.json
pnpm --filter vibedeckx-ui exec tsc --noEmit
pnpm --filter vibedeckx-ui lint
pnpm build:main
pnpm build:ui
```

Expected: every command exits 0.

**Step 4: Perform manual acceptance**

Run the app and verify:

1. Project Home shows Project Chat, recent sessions, recent runs, priority tasks, and attention; no Workspaces card.
2. A new message creates a Thread and opens the two-column workbench.
3. Threads and Context share the same auxiliary rail.
4. A thread can discuss multiple workspaces without becoming branch-owned.
5. A concrete coding request asks for workspace selection when ambiguous.
6. Agent Session and Schedule Run status cards update and survive reload.
7. Back to Overview does not stop active child work.
8. The narrow layout uses one combined auxiliary drawer.

**Step 5: Reconcile documentation**

Update the design/plan only for intentional implementation deviations. Do not rewrite approved product decisions to match accidental code behavior.

**Step 6: Commit final verification adjustments**

```bash
git add docs/plans/2026-07-31-project-chat-dashboard-design.md docs/plans/2026-07-31-project-chat-dashboard-implementation.md
git commit -m "docs: reconcile project chat implementation"
```

## Implementation result

Implemented and automatically verified 2026-08-01, with a partial real-browser
smoke. The intentional durability, ownership, and scope refinements are
summarized in the design's Implementation reconciliation section. No Mission
entity was added, Project Chat remained project-scoped rather than
branch-scoped, and V1 did not gain destructive commander tools.

### Final verification evidence

- `pnpm --filter vibedeckx test`: exit 0; 1,612 tests passed, 11 skipped after
  the local ownership, child-route scope, tool revalidation, project-remote,
  remote-server, machine-identity, public-error, transcript-budget, and history
  pagination hardening.
- `pnpm --filter vibedeckx-ui test`: exit 0; 62 test files and 503 tests passed.
- `pnpm --filter vibedeckx exec tsc --noEmit`: exit 0.
- `pnpm --filter vibedeckx-ui exec tsc --noEmit`: exit 0.
- `pnpm build:main`: exit 0.
- `pnpm build:ui`: exit 0, including static-page generation.
- Feature-scope ESLint for Project Chat, Project Activity, their hooks/API/URL
  state, and `app/page.tsx`: exit 0 with no errors (seven existing warnings in
  `app/page.tsx`).
- Full `pnpm --filter vibedeckx-ui lint`: exit 1 with the repository's existing
  broad lint debt (75 errors and 32 warnings across 29 error-bearing files in
  unrelated agent, AI-elements, auth, hooks, and file-ref areas). None of the
  error-bearing files are Project Chat or Project Activity implementation
  files. This was recorded rather than expanding Task 12 into a cross-codebase
  lint refactor. Tests, type-checks, and production builds are green.

Automated acceptance was verified through executable tests and code inspection:

- `project-activity-view.test.tsx` verifies the Project Chat, Recent Agent
  Sessions, Schedule Results, Priority Tasks, and Attention Required cards and
  the absence of a standalone Workspaces card.
- `project-chat-workbench.test.tsx` verifies the two-column layout, Threads and
  Context in one rail, persistent/live operation cards, and that Back to
  Overview does not call Stop.
- `project-chat-responsive.test.tsx` verifies a single combined mobile drawer
  without duplicating the Chat tree and preserves per-thread drafts.
- `project-chat.integration.test.ts` drives authenticated Thread creation,
  ambiguous Workspace selection, Agent Session creation and completion,
  cross-thread/cross-project isolation, database reopen, and Manager
  reconstruction with transcript and Context intact.
- Storage and manager tests verify that Thread identity contains project/user
  scope but no branch/workspace ownership and that operation state survives
  reload.
- Security integration tests verify canonical local ownership and migration,
  user-facing child-route scope, live Commander tool revalidation,
  project-remote association scope, remote-server ownership, and legacy machine
  identity migration.
- Transcript and history tests verify independent live/model UTF-8 budgets,
  sequence-cursor message pagination, server-side Thread search beyond 100
  records, sanitized public errors, and expiry of stale approval actions.

### Real-browser smoke evidence

A fresh no-auth local server and data directory were used for a real-browser
smoke. It confirmed:

- the Project dashboard renders against fresh local data;
- the composer creates a Thread and navigates to its canonical Chat URL;
- the workbench has one conversation column and one shared Threads/Context rail;
- Back returns to Project Overview; and
- the narrow layout moves Threads and Context into one combined drawer.

The first smoke exposed a real `Project not found` ownership defect. The local
ownership and scope fixes above were applied, and a second fresh smoke confirmed
that error no longer occurs.

The external model turn then stopped at a DeepSeek 401 caused by the missing or
invalid API key. Therefore the ambiguous Workspace selection and full live
operation-card lifecycle were not completed manually in the browser. Those
scenarios remain covered by the real backend integration tracer and focused UI
tests; this document does not claim complete manual acceptance.
