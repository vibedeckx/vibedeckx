# Persistent Notification Milestones

Date: 2026-07-25

## Problem

The notification bell currently consumes `branch:activity` SSE events. That
event describes the aggregate state of a `projectId + branch`, not the
completion of a particular user-visible unit of work.

This coupling creates two classes of error:

- two sessions on the same branch can both complete, but the second
  `completed` is deduplicated as if nothing changed;
- workflow implementation steps can complete without deserving a user
  notification, while a reviewer result does deserve one.

The remote-review fix currently compensates by seeding
`branch:activity:working` and reconciling a replayed reviewer `turn_end`. That
restores a state transition, but it still treats a branch-state mechanism as a
notification transport. Reused reviewer sessions also make historical replay
ambiguous unless every marker is tied to an exact turn boundary.

Notifications are additionally stored only in browser `localStorage`. An SSE
disconnect, a closed browser, or a front-server restart can therefore lose a
completion notification permanently.

## Product Semantics

A notification represents an **attention milestone**: a durable result or
failure that the user may need to return to.

The following events notify:

- an independent session turn completes successfully;
- an independent session turn fails, exits unexpectedly, or is repaired as
  interrupted after a server/worker restart;
- a workflow reviewer produces feedback and the run enters
  `waiting_feedback`;
- a source session finishes the modification turn started by approved review
  feedback;
- a workflow fails in a state that requires user intervention.

The following events do not notify:

- workflow plumbing and internal helper steps;
- feedback being delivered to the source session;
- a reviewer session's raw completion in addition to `review_ready`;
- a user-initiated Stop;
- workflow state changes that do not produce a result or require attention.

Reviewer feedback and the source's later modification are separate attention
milestones and therefore produce two notifications.

## Goals

- Separate notification semantics from branch and session status display.
- Persist notifications and read state on the front server.
- Recover milestones produced while the browser or front server was offline.
- Support direct and reverse-connect worker deployments.
- Deduplicate retries and replay with deterministic notification IDs.
- Auto-read only when the user is viewing the exact target session.
- Preserve distinct success, review-ready, and failure presentation, including
  a distinct failure sound.

## Non-goals

- Email, mobile push, or third-party notification delivery.
- Per-device read state.
- User-configurable notification rules in the first version.
- Importing legacy `localStorage` entries into the server database.
- A general workflow orchestration redesign.

## Chosen Architecture

Keep the three existing concerns independent:

| Concern | Key | Source of truth |
|---|---|---|
| Session running indicator | `sessionId` | `session:status` / `session:process` |
| Workspace activity indicator | `projectId + branch` | `branch:activity` |
| Notification bell | deterministic milestone ID | persisted notifications |

Every server that executes work writes durable milestone events to an outbox.
The user-facing front server imports those events into its notification inbox.
For local execution, the same service imports the local outbox immediately.
For remote execution, the front pulls the worker outbox through
`proxyToRemoteAuto`, which already supports direct HTTP and reverse-connect
HTTP.

SSE remains a low-latency signal, not the reliability mechanism. The browser
hydrates notifications through HTTP and uses SSE only to learn that a newly
persisted notification is available.

## Data Model

### Milestone outbox

Every execution server stores immutable events:

```ts
interface NotificationOutboxEvent {
  seq: number;
  id: string;
  kind:
    | "review_ready"
    | "session_result_ready"
    | "session_failed"
    | "workflow_failed";
  projectId: string;
  branch: string | null;
  sessionId: string;
  workflowRunId: string | null;
  createdAt: number;
}
```

`seq` is a monotonically increasing cursor local to one execution server.
Every event has a target session, including workflow failures (which target the
participant the user should inspect). `id` is stable for the underlying
milestone:

```text
session:{sessionId}:turn:{turnEndEntryIndex}:result-ready
session:{sessionId}:turn:{turnEndEntryIndex}:failed
workflow:{workflowRunId}:review-ready
workflow:{workflowRunId}:failed:{stateVersion}
```

The outbox has a unique constraint on `id`. Retrying the business transition
cannot create a second event.

The outbox deliberately stores semantic identity, not mutable presentation
text. The front generates `title` and `body` while importing, when it can use
the local session mapping and latest known title.

### Front-server notifications

The user-facing server stores:

```ts
interface Notification {
  id: string;
  userId: string;
  kind: NotificationKind;
  projectId: string;
  branch: string | null;
  sessionId: string | null;
  workflowRunId: string | null;
  title: string;
  body: string | null;
  createdAt: number;
  readAt: number | null;
}
```

Remote IDs are translated into the front server's existing local ID space.
The persisted notification ID is namespaced as
`remote:{remoteServerId}:{outboxEventId}` so independent workers cannot
collide. The front derives `userId` from the owned local project; it does not
trust a worker-supplied tenant identifier.

### Remote sync cursor

The front stores the last fully imported sequence for each mapped remote
session:

```ts
interface NotificationSyncCursor {
  remoteServerId: string;
  remoteSessionId: string;
  lastSeq: number;
  updatedAt: number;
}
```

The cursor advances only after the corresponding notifications are committed.
If the front crashes after insertion but before cursor advancement, the same
events are fetched again and ignored by the notification ID unique constraint.
Per-session cursors avoid importing worker-local sessions that do not belong to
this front, while allowing each mapping's initialization policy to choose
between create-race recovery and historical-backfill suppression.

### Mapping initialization and polling

Every persisted remote-session mapping records a notification sync policy:

```ts
type NotificationSyncStart = "from_start" | "from_now";
```

- A session newly created through this front, including a newly created
  workflow reviewer, uses `from_start`. It has no unrelated historical work,
  and sequence zero closes the race where it completes before mapping setup.
- A historical session discovered through search, session listing, or opening
  an existing worker session uses `from_now`. Its first sync records the
  worker's current per-session head without importing or emitting old
  milestones.
- Re-upserting an existing mapping preserves its cursor and initial policy.
  Reusing a reviewer therefore continues from the already imported boundary.

Before this front starts a new turn in a `from_now` mapping that has no cursor,
it synchronously records the worker's current head, then sends the turn. If
baseline initialization fails, the turn is not started. This ordering prevents
the new turn's fast completion from being mistaken for historical data and
suppressed.

This prevents a fresh front database or a second front attached to a
long-lived worker from turning months of history into unread notifications and
sound.

Mappings also carry a persisted `notification_watch_until`. Creating a session,
sending a turn, starting a workflow, or observing live remote activity extends
the watch window. Periodic sync queries only watched mappings. Startup and a
remote-server-online transition perform a bounded full sweep so durable events
still recover after downtime; ordinary polling does not query every historical
mapping forever.

## Per-turn Notification Intent

Each user turn carries an explicit disposition:

```ts
type NotificationDisposition =
  | "result"
  | "internal"
  | "milestone-managed";
```

The disposition is persisted with the user turn and copied to its `turn_end`.
It must not exist only in process memory because process repair and remote
outbox generation need the same decision after a restart.

For a legacy opening user entry without a disposition, ordinary user input
defaults to `result`; `origin: "workflow"` defaults to `internal` to avoid a
false generic notification for an old reviewer/helper turn. Newly written
workflow turns always carry an explicit disposition.

Defaults:

| Turn | Disposition |
|---|---|
| User-started independent turn | `result` |
| Reviewer's workflow prompt | `milestone-managed` |
| Workflow helper turn | `internal` |
| Approved feedback sent to source | `result` |

A `result` turn produces:

- `session_result_ready` for `outcome === "completed"`;
- `session_failed` for `outcome === "failed"`, `"process_exit"`, or
  `"server_restart"`;
- nothing for `outcome === "stopped"`.

A `milestone-managed` turn never emits a generic session notification. Its
workflow owns the attention event. This prevents reviewer completion from
creating both `session_result_ready` and `review_ready`.

## Atomicity and Repair

Milestone creation must be tied to the durable state that proves the event:

- session milestones are inserted in the same storage transaction as their
  `turn_end` entry;
- startup `server_restart` repair derives the interrupted turn's persisted
  disposition from its opening user entry and uses that same atomic
  turn-end/outbox operation;
- `review_ready` is inserted in the same transaction as
  `waiting_reviewer -> waiting_feedback`;
- workflow failure is inserted with the transition to `failed`.

Both operations use deterministic IDs, so transaction retry is safe. Startup
repair may scan terminal state for a missing deterministic outbox event as a
defence against databases created by older versions, but normal correctness
does not depend on an in-memory marker.

## Remote Outbox Synchronization

Workers expose an authenticated batched cursor endpoint:

```text
POST /api/notification-outbox/query

{
  "sessions": [
    { "sessionId": "remote-session-1", "after": 42 },
    { "sessionId": "remote-session-2", "after": 8 }
  ],
  "limitPerSession": 100
}
```

The response includes ordered events, `headCursor`, and `nextCursor` per
requested session. It never returns events for unrequested sessions. A
`from_now` initialization requests only `headCursor` and persists it without
importing rows. The endpoint is
machine-facing and uses the existing API-key/reverse-connect trust boundary.

The front's notification sync service:

1. groups eligible persisted remote-session mappings by remote server;
2. reads the saved cursor for each mapped remote session;
3. initializes `from_now` mappings at `headCursor`, or requests bounded event
   batches for established/from-start mappings through `proxyToRemoteAuto`;
4. maps remote project, session, and workflow IDs to local IDs;
5. verifies that the local project belongs to a user;
6. inserts notifications idempotently;
7. commits the new cursor;
8. emits `notification:created` only for newly inserted rows;
9. continues until the page is not full.

Sync runs immediately when a remote server becomes available and periodically
for watched mappings. Startup and online sweeps are bounded and chunked so a
server with many historical mappings cannot create an unbounded request.
Workflow reviewer registration also requests an immediate sync. This makes
recovery independent of whether a particular session WebSocket or browser tab
is open without continuously polling dead sessions.

Because the front only requests persisted mappings, every returned event has a
known local target. Deleting a mapping also deletes its cursor. Worker outbox
rows older than 90 days may be pruned after all supported recovery windows.

## Local Notification Flow

For local work:

```text
durable turn/workflow transition
  -> outbox event
  -> local import into notifications
  -> notification:created EventBus event
  -> SSE
  -> browser notification center
```

The importer may run immediately after the transaction, but a startup and
periodic drain ensure that a crash between commit and import cannot lose the
notification.

### Notification copy

The front uses stable semantic titles:

| Kind | Title |
|---|---|
| `review_ready` | `Review feedback is ready` |
| `session_result_ready` | `Session result is ready` |
| `session_failed` | `Session failed` |
| `workflow_failed` | `Workflow needs attention` |

`body` uses the latest front-known session title when it is non-empty and not a
placeholder such as `New Session`; otherwise it uses the branch name, then the
project name, and finally remains `null`. Copy is generated at inbox import
time, so a stale worker-side title is never baked into the outbox protocol.

## HTTP and SSE API

Browser-facing endpoints:

```text
GET   /api/notifications?unread=true&limit=100
PATCH /api/notifications/:id/read
POST  /api/notifications/read-all
```

Every read and mutation is scoped to the authenticated user. In solo mode the
existing `local` user sentinel is used.

The event bus adds:

```ts
{
  type: "notification:created";
  projectId: string;
  notification: Notification;
}
```

The existing SSE project ownership filter remains a second authorization
layer. `branch:activity` continues to update workspace dots but no longer
creates notification entries.

## Browser Behavior

On startup the notification hook fetches server notifications, then subscribes
to `notification:created`. The server database is authoritative; local storage
is only an optional rendering cache and is not used for read state.

When a notification arrives:

- add or replace it by notification ID;
- play the success sound for `session_result_ready`, the review sound for
  `review_ready`, and a distinct failure sound for `session_failed` and
  `workflow_failed`;
- if `notification.sessionId === activeSessionId`, optimistically mark it read
  and call the read endpoint;
- do not auto-read merely because another session on the same branch is open.

Navigation targets:

| Kind | Target |
|---|---|
| `review_ready` | reviewer session and its review controls |
| `session_result_ready` | completed session |
| `session_failed` | failed session |
| `workflow_failed` | workflow detail or relevant participant session |

Legacy branch-keyed `localStorage` notifications are not uploaded because they
lack stable milestone and user identity. They may be discarded after the first
successful server hydration.

The inbox retains all unread rows and the newest 500 read rows per user.
Periodic cleanup deletes older read rows. This replaces the old browser-only
50-entry cap without allowing read history to grow indefinitely.

## Failure Handling

- A duplicate outbox delivery is harmless.
- An inbox insertion followed by a crash before cursor update is replayed and
  deduplicated.
- A transient remote error leaves the cursor unchanged and retries later.
- A `from_now` mapping advances to the returned head without creating inbox
  rows or SSE events.
- An event with a response session ID that does not match the requested mapping
  fails that session batch and leaves its cursor unchanged.
- A failed read mutation remains unread on the server and is reconciled on the
  next fetch.
- A user Stop creates no notification.
- A worker cannot select the target user; the front derives ownership locally.

## Migration from the Reviewer Reconcile Fix

Once milestone delivery is active:

- remove the notification hook's consumption of `branch:activity`;
- remove `remoteReviewerReconcile` and replayed `turn_end` notification
  reconciliation;
- stop seeding `branch:activity:working` solely to force a later completion
  notification.

The front may still emit reviewer `working` for an accurate workspace activity
dot. That state update is retained only for display semantics, not for
notification delivery.

## Testing

Storage tests cover:

- outbox and notification ID uniqueness;
- atomic turn-end/outbox and workflow-transition/outbox writes;
- ordered cursor pagination;
- per-user unread queries and read mutations;
- cursor advancement in the same transaction as inbox insertion.

Backend service tests cover:

- independent success and failure milestones;
- Stop suppression;
- `server_restart` repair producing `session_failed` only for `result` turns;
- reviewer generic-notification suppression;
- exactly one `review_ready`;
- source feedback turn producing a later result notification;
- local crash-window drain;
- remote retry, replay dedupe, ID mapping, ownership derivation, and blocked
  mapping behavior;
- `from_now` initialization suppressing stale history and `from_start`
  initialization recovering a create/complete race;
- watched periodic polling plus bounded startup/online sweeps;
- direct and reverse-connect proxy paths.

Frontend tests cover:

- server hydration and SSE insertion;
- notification-ID dedupe;
- exact-session auto-read;
- same-branch/different-session remaining unread;
- success, review, and failure presentation and distinct sounds;
- refresh restoring unread state from the server;
- no remaining notification dependency on `branch:activity`.

End-to-end verification covers:

1. an independent local session;
2. an independent remote session with the browser closed;
3. a remote reviewer completing while the front is offline;
4. review approval followed by source modification completion;
5. front crash after inbox insertion but before cursor advancement.
