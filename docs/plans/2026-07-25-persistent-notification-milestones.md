# Persistent Notification Milestones Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace branch-activity-derived browser notifications with durable, user-scoped attention milestones that survive browser, SSE, front-server, and worker disconnects.

**Architecture:** Execution servers atomically write deterministic milestone events to a SQLite outbox. The user-facing server imports local and remote outbox events into a user notification inbox, using per-remote-session cursors and the existing direct/reverse-connect HTTP proxy. The browser hydrates from the inbox API, consumes `notification:created` SSE for low latency, and auto-reads only notifications targeting the active session.

**Tech Stack:** TypeScript, Fastify, Kysely/SQLite, React 19, Next.js, Vitest, pnpm.

---

### Task 1: Add notification storage contracts and schema

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/schema.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Create: `packages/vibedeckx/src/storage/repositories/notifications.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/agent-sessions.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/core.ts`
- Test: `packages/vibedeckx/src/storage/notifications.test.ts`

**Step 1: Write failing storage tests**

Cover:

- deterministic outbox IDs are unique;
- outbox rows are returned in `seq` order for one requested session only;
- notifications are listed and mutated only for the supplied `userId`;
- inserting an inbox row and advancing its `(remoteServerId, remoteSessionId)`
  cursor is one transaction;
- remote-session lookup resolves a persisted mapping;
- project ownership lookup returns the stored user.

Use a real temporary SQLite database:

```ts
it("imports a remote event and advances the session cursor atomically", async () => {
  const result = await storage.notifications.importRemote({
    notification: {
      id: "remote:srv1:session:r1:turn:3:result-ready",
      user_id: "u1",
      kind: "session_result_ready",
      project_id: "p1",
      branch: "dev",
      session_id: "remote-srv1-p1-r1",
      workflow_run_id: null,
      title: "Session completed",
      body: null,
      created_at: 10,
    },
    remoteServerId: "srv1",
    remoteSessionId: "r1",
    seq: 7,
  });

  expect(result.inserted).toBe(true);
  expect(await storage.notificationSyncCursors.get("srv1", "r1")).toBe(7);
});
```

**Step 2: Run the test and verify failure**

Run:

```bash
pnpm --filter vibedeckx test -- src/storage/notifications.test.ts
```

Expected: FAIL because the notification storage contracts do not exist.

**Step 3: Add domain types and storage interfaces**

In `storage/types.ts`, add:

```ts
export type NotificationKind =
  | "review_ready"
  | "session_result_ready"
  | "session_failed"
  | "workflow_failed";

export interface NotificationOutboxEvent {
  seq: number;
  id: string;
  kind: NotificationKind;
  project_id: string;
  branch: string | null;
  session_id: string;
  workflow_run_id: string | null;
  title: string;
  body: string | null;
  created_at: number;
}

export interface Notification extends Omit<NotificationOutboxEvent, "seq"> {
  user_id: string;
  read_at: number | null;
}
```

Add `notificationOutbox`, `notifications`, and `notificationSyncCursors`
repository contracts. Add:

```ts
remoteSessionMappings.getByRemote(
  remoteServerId: string,
  remoteSessionId: string,
): Promise<RemoteSessionMapping | undefined>;

projects.getOwnerId(projectId: string): Promise<string | undefined>;
```

**Step 4: Add SQLite DDL and Kysely table types**

Create:

```sql
CREATE TABLE IF NOT EXISTS notification_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch TEXT,
  session_id TEXT NOT NULL,
  workflow_run_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_session_seq
  ON notification_outbox(session_id, seq);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch TEXT,
  session_id TEXT,
  workflow_run_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_sync_cursors (
  remote_server_id TEXT NOT NULL,
  remote_session_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (remote_server_id, remote_session_id)
);
```

Represent all three tables in `storage/schema.ts` and add them to `DB`.

**Step 5: Implement repositories**

In `repositories/notifications.ts`, use `onConflict(...).doNothing()` for
outbox and inbox IDs. Implement `importRemote` with `kdb.transaction()`:

```ts
const result = await trx.insertInto("notifications")
  .values(notification)
  .onConflict((oc) => oc.column("id").doNothing())
  .executeTakeFirst();

await trx.insertInto("notification_sync_cursors")
  .values({ remote_server_id, remote_session_id, last_seq: seq, updated_at: Date.now() })
  .onConflict((oc) => oc.columns(["remote_server_id", "remote_session_id"])
    .doUpdateSet({ last_seq: seq, updated_at: Date.now() }))
  .execute();
```

Return whether the notification row was newly inserted. Never move a cursor
backward; guard the update with `last_seq < seq`.

Wire the repository factory into `createSqliteStorage`.

**Step 6: Run tests**

Run:

```bash
pnpm --filter vibedeckx test -- src/storage/notifications.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/vibedeckx/src/storage
git commit -m "feat(notifications): add outbox and inbox storage"
```

### Task 2: Persist per-turn notification disposition and atomic session milestones

**Files:**
- Modify: `packages/vibedeckx/src/agent-types.ts`
- Modify: `packages/vibedeckx/src/agent-session-manager.ts`
- Modify: `packages/vibedeckx/src/workflow-engine.ts`
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/agent-sessions.ts`
- Test: `packages/vibedeckx/src/agent-session-manager.completion.test.ts`
- Test: `packages/vibedeckx/src/agent-session-manager.turn-end.test.ts`
- Test: `packages/vibedeckx/src/workflow-engine.test.ts`

**Step 1: Write failing disposition tests**

Add tests proving:

- a normal user turn persists `notificationDisposition: "result"`;
- a reviewer workflow prompt persists `"milestone-managed"`;
- approved feedback sent to the source persists `"result"`;
- completed `result` creates one `session_result_ready` outbox row;
- failed/process-exit `result` creates `session_failed`;
- stopped `result` creates no row;
- completed `internal` and `milestone-managed` turns create no generic row;
- retrying the same turn-end write creates no duplicate.

Assert IDs include the real `turn_end` entry index.

**Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter vibedeckx test -- \
  src/agent-session-manager.completion.test.ts \
  src/agent-session-manager.turn-end.test.ts \
  src/workflow-engine.test.ts
```

Expected: FAIL because disposition and atomic milestone creation do not exist.

**Step 3: Extend persisted message types**

Add:

```ts
export type NotificationDisposition =
  | "result"
  | "internal"
  | "milestone-managed";
```

Persist it on the user entry and `turn_end` entry. Extend
`sendUserMessage` options:

```ts
opts?: {
  origin?: "workflow";
  notificationDisposition?: NotificationDisposition;
}
```

Default to `"result"` only for an ordinary user turn. Require workflow callers
to pass an explicit disposition; do not infer every `origin: "workflow"` turn
as internal because approved feedback starts a user-visible source result.

**Step 4: Add one atomic repository operation**

Add:

```ts
agentSessions.upsertTurnEndWithOutbox(opts: {
  sessionId: string;
  entryIndex: number;
  entryData: string;
  outbox?: Omit<NotificationOutboxEvent, "seq">;
}): Promise<void>;
```

Implement the entry upsert and optional outbox insert in one Kysely transaction.
Use this operation only for `turn_end`; keep ordinary entry persistence
unchanged.

**Step 5: Generate the deterministic milestone in `endActiveTurn`**

After allocating the entry index, build:

```ts
const outbox =
  disposition === "result" && outcome === "completed"
    ? {
        id: `session:${session.id}:turn:${index}:result-ready`,
        kind: "session_result_ready" as const,
        // remaining display and routing fields
      }
    : disposition === "result" &&
        (outcome === "failed" || outcome === "process_exit")
      ? {
          id: `session:${session.id}:turn:${index}:failed`,
          kind: "session_failed" as const,
          // remaining fields
        }
      : undefined;
```

Persist the `turn_end` and outbox together. Ensure the in-memory entry and WS
patch still follow the existing ordering contract.

**Step 6: Mark workflow calls explicitly**

Reviewer prompt:

```ts
{ origin: "workflow", notificationDisposition: "milestone-managed" }
```

Approved feedback to source:

```ts
{ origin: "workflow", notificationDisposition: "result" }
```

Internal workflow helper turns use `"internal"`.

**Step 7: Run focused tests**

Run the command from Step 2.

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/vibedeckx/src/agent-types.ts \
  packages/vibedeckx/src/agent-session-manager.ts \
  packages/vibedeckx/src/workflow-engine.ts \
  packages/vibedeckx/src/storage \
  packages/vibedeckx/src/agent-session-manager.completion.test.ts \
  packages/vibedeckx/src/agent-session-manager.turn-end.test.ts \
  packages/vibedeckx/src/workflow-engine.test.ts
git commit -m "feat(notifications): persist session result milestones"
```

### Task 3: Create workflow milestones atomically

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/workflow-runs.ts`
- Modify: `packages/vibedeckx/src/workflow-engine.ts`
- Test: `packages/vibedeckx/src/storage/workflow-runs.test.ts`
- Test: `packages/vibedeckx/src/workflow-engine.test.ts`

**Step 1: Write failing workflow milestone tests**

Cover:

- `waiting_reviewer -> waiting_feedback` creates exactly one `review_ready`;
- the event targets the reviewer session;
- reviewer `taskCompleted` does not also create a generic result notification;
- approval and feedback delivery create no workflow notification;
- the source's later completion remains a separate session milestone;
- a workflow transition to `failed` creates one `workflow_failed`;
- cancellation creates no failure notification;
- a failed compare-and-set creates no outbox event.

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter vibedeckx test -- \
  src/storage/workflow-runs.test.ts \
  src/workflow-engine.test.ts
```

Expected: FAIL because workflow transitions cannot write outbox events.

**Step 3: Add an atomic transition API**

Add:

```ts
workflowRuns.transitionWithOutbox(
  id: string,
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
  patch: WorkflowRunPatch | undefined,
  outbox: Omit<NotificationOutboxEvent, "seq">,
): Promise<boolean>;
```

Inside one transaction, perform the guarded update first. Insert the outbox row
only when exactly one workflow row changed.

**Step 4: Emit `review_ready` from the successful workflow transition**

Use:

```ts
id: `workflow:${run.id}:review-ready`
kind: "review_ready"
session_id: run.reviewer_session_id!
workflow_run_id: run.id
```

Do not create this event from `session:taskCompleted` before the state
transition succeeds.

For workflow failures, include a stable state version in the ID. In v1 use the
terminal transition name, for example:

```text
workflow:{runId}:failed:waiting_reviewer
```

**Step 5: Run tests**

Run the command from Step 2.

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/vibedeckx/src/storage/types.ts \
  packages/vibedeckx/src/storage/repositories/workflow-runs.ts \
  packages/vibedeckx/src/storage/workflow-runs.test.ts \
  packages/vibedeckx/src/workflow-engine.ts \
  packages/vibedeckx/src/workflow-engine.test.ts
git commit -m "feat(notifications): persist workflow milestones"
```

### Task 4: Import local outbox events and expose notification APIs

**Files:**
- Create: `packages/vibedeckx/src/notification-service.ts`
- Create: `packages/vibedeckx/src/notification-service.test.ts`
- Create: `packages/vibedeckx/src/routes/notification-routes.ts`
- Create: `packages/vibedeckx/src/routes/notification-routes.test.ts`
- Modify: `packages/vibedeckx/src/event-bus.ts`
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts`
- Modify: `packages/vibedeckx/src/server-types.ts`
- Modify: `packages/vibedeckx/src/server.ts`

**Step 1: Write failing service and route tests**

Service tests:

- drain imports each local outbox event once;
- the user is derived from `projects.getOwnerId`;
- import emits `notification:created` only for a newly inserted inbox row;
- a crash/retry window does not emit a duplicate;
- startup drain recovers an event committed before service startup.

Route tests:

- `GET /api/notifications` returns only the authenticated user's rows;
- `PATCH /api/notifications/:id/read` cannot mutate another user's row;
- `POST /api/notifications/read-all` is user-scoped;
- solo mode uses `resolveUserId`'s `local` sentinel.

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter vibedeckx test -- \
  src/notification-service.test.ts \
  src/routes/notification-routes.test.ts
```

Expected: FAIL because service and routes do not exist.

**Step 3: Add the event-bus event**

```ts
| {
    type: "notification:created";
    projectId: string;
    notification: Notification;
  }
```

Keep `projectId` at the event top level so the existing SSE tenant filter
continues to work.

**Step 4: Implement local draining**

`NotificationService.drainLocal()` pages outbox rows after a durable local
cursor, imports them into `notifications`, advances the cursor, and emits only
new inserts. Use a reserved local cursor identity rather than an in-memory
offset.

Start one immediate drain during shared-services initialization and a short
unref'd interval for crash-window recovery. Also request a drain immediately
after successful milestone creation where practical; correctness must not
depend on that fast path.

**Step 5: Implement authenticated browser routes**

Use `requireAuth` and `resolveUserId`. Return stable JSON:

```ts
{ notifications: Notification[] }
```

For mark-read, return 404 when the ID is not owned by the caller; do not reveal
that another user's notification exists.

**Step 6: Register and decorate the service**

Expose `fastify.notificationService` through `server-types.ts`, instantiate it
in `shared-services.ts`, stop its interval in the plugin close hook, and
register `notificationRoutes` in `server.ts`.

**Step 7: Run tests**

Run the command from Step 2.

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/vibedeckx/src/notification-service.ts \
  packages/vibedeckx/src/notification-service.test.ts \
  packages/vibedeckx/src/routes/notification-routes.ts \
  packages/vibedeckx/src/routes/notification-routes.test.ts \
  packages/vibedeckx/src/event-bus.ts \
  packages/vibedeckx/src/plugins/shared-services.ts \
  packages/vibedeckx/src/server-types.ts \
  packages/vibedeckx/src/server.ts
git commit -m "feat(notifications): add durable inbox service and API"
```

### Task 5: Add the worker outbox query protocol

**Files:**
- Create: `packages/vibedeckx/src/routes/notification-outbox-routes.ts`
- Create: `packages/vibedeckx/src/routes/notification-outbox-routes.test.ts`
- Modify: `packages/vibedeckx/src/server.ts`

**Step 1: Write failing machine-route tests**

Cover:

- API-key authenticated callers can query requested session IDs;
- response never includes an unrequested session;
- each requested session uses its own `after` cursor;
- results are ordered and limited per session;
- malformed, duplicate, excessive session arrays and excessive limits return
  400;
- ordinary unauthenticated browser callers cannot use the endpoint when auth
  is enabled.

Expected response:

```ts
{
  sessions: [{
    sessionId: "r1",
    events: [/* ordered rows */],
    nextCursor: 12,
    hasMore: false,
  }]
}
```

**Step 2: Run the route test and verify failure**

Run:

```bash
pnpm --filter vibedeckx test -- src/routes/notification-outbox-routes.test.ts
```

Expected: FAIL because the route is absent.

**Step 3: Implement bounded validation and query**

Use constants such as:

```ts
const MAX_SESSIONS_PER_REQUEST = 100;
const MAX_EVENTS_PER_SESSION = 100;
```

Query only `notification_outbox.session_id` values explicitly present in the
request. Do not expose user IDs or front inbox read state.

**Step 4: Register and test**

Run the command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/notification-outbox-routes.ts \
  packages/vibedeckx/src/routes/notification-outbox-routes.test.ts \
  packages/vibedeckx/src/server.ts
git commit -m "feat(notifications): expose worker outbox cursor API"
```

### Task 6: Synchronize remote outboxes through direct and reverse-connect transports

**Files:**
- Create: `packages/vibedeckx/src/remote-notification-sync.ts`
- Create: `packages/vibedeckx/src/remote-notification-sync.test.ts`
- Modify: `packages/vibedeckx/src/notification-service.ts`
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts`
- Modify: `packages/vibedeckx/src/routes/workflow-run-routes.ts`
- Test: `packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts`

**Step 1: Write failing remote sync tests**

Cover:

- mappings are grouped by `remoteServerId` and chunked;
- every session sends its own persisted cursor;
- `proxyToRemoteAuto` receives `reverseConnectManager`;
- response session IDs must match the requested mapping;
- remote session and workflow IDs are mapped into front-local IDs;
- notification IDs are prefixed with `remote:{serverId}:`;
- the front derives `userId` from the local project owner;
- insert and cursor update are atomic;
- replay after a simulated crash does not duplicate;
- a proxy error leaves all affected cursors unchanged;
- a newly added mapping starts at zero and can import an older event;
- direct URL and reverse-connect calls use the same sync logic.

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter vibedeckx test -- \
  src/remote-notification-sync.test.ts \
  src/routes/workflow-run-remote-routes.test.ts
```

Expected: FAIL because remote synchronization does not exist.

**Step 3: Implement ID mapping**

Resolve each returned remote session through:

```ts
remoteSessionMappings.getByRemote(remoteServerId, remoteSessionId)
```

Map:

```ts
notification.id = `remote:${remoteServerId}:${event.id}`;
notification.project_id = mapping.project_id;
notification.session_id = mapping.local_session_id;
notification.workflow_run_id = event.workflow_run_id
  ? `remote-${remoteServerId}-${mapping.project_id}-${event.workflow_run_id}`
  : null;
```

Reject the session batch if any event's `session_id` differs from the requested
remote session. Never accept worker `project_id` or user identity as the front
authorization scope.

**Step 4: Schedule synchronization**

Run:

- once after shared services hydrate persisted mappings;
- immediately when a remote server transitions online;
- periodically with an unref'd timer;
- immediately after workflow reviewer mapping is persisted.

Avoid replacing existing reverse-connect status handlers. If
`ReverseConnectManager` supports only one handler, first add a listener
subscription API and migrate existing handlers to it.

**Step 5: Run tests**

Run the command from Step 2.

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/vibedeckx/src/remote-notification-sync.ts \
  packages/vibedeckx/src/remote-notification-sync.test.ts \
  packages/vibedeckx/src/notification-service.ts \
  packages/vibedeckx/src/plugins/shared-services.ts \
  packages/vibedeckx/src/routes/workflow-run-routes.ts \
  packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts
git commit -m "feat(notifications): sync remote milestone outboxes"
```

### Task 7: Move the browser notification center to the server inbox

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts`
- Modify: `apps/vibedeckx-ui/hooks/use-completion-notifications.ts`
- Modify: `apps/vibedeckx-ui/hooks/use-completion-notifications.test.ts`
- Modify: `apps/vibedeckx-ui/components/layout/completion-notifications-menu.tsx`
- Modify: `apps/vibedeckx-ui/components/layout/completion-notifications-menu.test.tsx`
- Modify: `apps/vibedeckx-ui/app/page.tsx`

**Step 1: Write failing hook and menu tests**

Cover:

- initial server hydration replaces legacy branch-keyed state;
- `notification:created` inserts by notification ID;
- SSE replay does not duplicate an existing row;
- active exact session is optimistically read and invokes the read API;
- another session on the same branch remains unread;
- navigating into a target session marks its notifications read;
- read-all updates the server and local state;
- success, review-ready, and failure kinds render distinct copy/icons;
- clicking navigates to `notification.session_id`;
- `branch:activity` no longer creates a bell entry or sound.

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter vibedeckx-ui test -- \
  hooks/use-completion-notifications.test.ts \
  components/layout/completion-notifications-menu.test.tsx
```

Expected: FAIL because the hook still derives notifications from
`branch:activity` and `localStorage`.

**Step 3: Add API functions**

Add typed functions:

```ts
getNotifications(opts?: { unread?: boolean; limit?: number })
markNotificationRead(id: string)
markAllNotificationsRead()
```

Use the existing `authFetch` wrapper.

**Step 4: Refactor the hook**

Keep the public hook surface stable where practical, but change the internal
source of truth:

```ts
useEffect(() => {
  void getNotifications({ limit: 100 }).then(setNotifications);
}, []);

useGlobalEventStream((event) => {
  if (event.type !== "notification:created") return;
  upsertById(event.notification);
});
```

Accept the exact `activeSessionId`, not only a branch key. Auto-read with:

```ts
notification.session_id === activeSessionId
```

On first successful server hydration, remove the legacy
`vibedeckx:completion-notifications` localStorage key. Do not upload legacy
entries.

**Step 5: Update presentation**

Map kinds to copy and icon:

```text
review_ready          -> Review feedback is ready
session_result_ready  -> Session result is ready
session_failed        -> Session failed
workflow_failed       -> Workflow needs attention
```

Retain the current sound for successful result/review notifications. Add no new
failure audio in v1 unless an existing asset is approved; use visual styling
only.

**Step 6: Run tests**

Run the command from Step 2.

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts \
  apps/vibedeckx-ui/hooks/use-completion-notifications.ts \
  apps/vibedeckx-ui/hooks/use-completion-notifications.test.ts \
  apps/vibedeckx-ui/components/layout/completion-notifications-menu.tsx \
  apps/vibedeckx-ui/components/layout/completion-notifications-menu.test.tsx \
  apps/vibedeckx-ui/app/page.tsx
git commit -m "feat(ui): consume persistent notification milestones"
```

### Task 8: Remove reviewer notification reconciliation and decouple branch activity

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts`
- Delete: `packages/vibedeckx/src/agent-session-manager.reviewer-reconcile.test.ts`
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts`
- Modify: `packages/vibedeckx/src/routes/remote-status-bridge.ts`
- Modify: `packages/vibedeckx/src/routes/remote-status-bridge.test.ts`
- Modify: `packages/vibedeckx/src/routes/workflow-run-routes.ts`
- Modify: `packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts`
- Test: `apps/vibedeckx-ui/hooks/use-branch-activity.test.ts`

**Step 1: Add regression tests for the final separation**

Assert:

- reviewer registration may update the branch dot to `working`, but no
  notification behavior depends on it;
- remote replayed `turn_end` does not call a reviewer reconcile marker;
- two independent sessions on one branch each create their own notification
  despite consecutive branch-level `completed` states;
- a reused reviewer session creates a new `review_ready` by workflow run ID,
  without scanning old `turn_end` entries.

**Step 2: Run focused tests before removal**

Run:

```bash
pnpm --filter vibedeckx test -- \
  src/routes/remote-status-bridge.test.ts \
  src/routes/workflow-run-remote-routes.test.ts
pnpm --filter vibedeckx-ui test -- hooks/use-branch-activity.test.ts
```

Expected: new separation tests FAIL while reconcile code remains.

**Step 3: Remove the temporary notification bridge**

Remove:

- `remoteReviewerReconcile`;
- `markRemoteReviewerForReconcile`;
- `clearRemoteReviewerReconcile`;
- `reconcileRemoteReviewerTurnEnd`;
- `reviewerTurnEndOutcomeFromRemotePatch`;
- the live/replay reconcile scans and their tests.

Keep reviewer `branch:activity:working` only if product UI still wants the
branch/workspace dot to show active work. Update its comments to state that it
has no notification role.

**Step 4: Run focused tests**

Run the commands from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/vibedeckx/src apps/vibedeckx-ui/hooks/use-branch-activity.test.ts
git commit -m "refactor(notifications): decouple bell from branch activity"
```

### Task 9: Verify persistence, recovery, and complete suite

**Files:**
- Create: `packages/vibedeckx/src/notification-recovery.integration.test.ts`
- Modify: `docs/plans/2026-07-25-persistent-notification-milestones-design.md` only if implementation discoveries require documented changes

**Step 1: Add recovery integration tests**

Use real temporary SQLite databases for front and worker. Cover:

1. worker creates an event while front sync is stopped;
2. front sync starts and imports it;
3. front storage closes and reopens with the notification still unread;
4. importing the same page again does not duplicate it;
5. active-session read persists across another reopen;
6. two sessions on the same branch retain separate notification IDs;
7. review-ready and later source-result notifications both exist.

Mock transport only at `proxyToRemoteAuto`; exercise real storage and
`NotificationService`.

**Step 2: Run the recovery integration test**

Run:

```bash
pnpm --filter vibedeckx test -- src/notification-recovery.integration.test.ts
```

Expected: PASS.

**Step 3: Run backend tests and type-check**

Run:

```bash
pnpm --filter vibedeckx test
pnpm --filter vibedeckx exec tsc --noEmit
```

Expected: all tests PASS and TypeScript reports no errors.

**Step 4: Run frontend tests, lint, and type-check**

Run:

```bash
pnpm --filter vibedeckx-ui test
pnpm --filter vibedeckx-ui lint
pnpm --filter vibedeckx-ui exec tsc --noEmit
```

Expected: all commands exit 0.

**Step 5: Run production builds**

Run:

```bash
pnpm --filter vibedeckx build
pnpm --filter vibedeckx-ui build
```

Expected: both builds exit 0.

**Step 6: Perform manual remote smoke tests**

Verify both direct and reverse-connect deployments:

- close the browser, complete an independent remote session, reopen, and see
  one unread notification;
- disconnect the front, complete a reviewer, reconnect, and see
  `review_ready`;
- approve feedback, let the source finish, and see a second source result
  notification;
- view Session A while same-branch Session B completes and confirm B remains
  unread;
- Stop a session and confirm no notification is created.

**Step 7: Commit**

```bash
git add packages/vibedeckx/src/notification-recovery.integration.test.ts \
  docs/plans/2026-07-25-persistent-notification-milestones-design.md
git commit -m "test(notifications): verify durable recovery"
```

Skip the design-document path in `git add` if it did not change.
