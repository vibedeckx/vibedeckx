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
- an independent session turn fails or exits unexpectedly;
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
- Preserve distinct success, review-ready, and failure presentation.

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
  sessionId: string | null;
  workflowRunId: string | null;
  title: string;
  body: string | null;
  createdAt: number;
}
```

`seq` is a monotonically increasing cursor local to one server. `id` is stable
for the underlying milestone:

```text
session:{sessionId}:turn:{turnEndEntryIndex}:result-ready
session:{sessionId}:turn:{turnEndEntryIndex}:failed
workflow:{workflowRunId}:review-ready
workflow:{workflowRunId}:failed:{stateVersion}
```

The outbox has a unique constraint on `id`. Retrying the business transition
cannot create a second event.

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

The front stores the last fully imported sequence for each remote server:

```ts
interface NotificationSyncCursor {
  remoteServerId: string;
  lastSeq: number;
  updatedAt: number;
}
```

The cursor advances only after the corresponding notifications are committed.
If the front crashes after insertion but before cursor advancement, the same
events are fetched again and ignored by the notification ID unique constraint.

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

Defaults:

| Turn | Disposition |
|---|---|
| User-started independent turn | `result` |
| Reviewer's workflow prompt | `milestone-managed` |
| Workflow helper turn | `internal` |
| Approved feedback sent to source | `result` |

A `result` turn produces:

- `session_result_ready` for `outcome === "completed"`;
- `session_failed` for `outcome === "failed"` or `"process_exit"`;
- nothing for `outcome === "stopped"`.

A `milestone-managed` turn never emits a generic session notification. Its
workflow owns the attention event. This prevents reviewer completion from
creating both `session_result_ready` and `review_ready`.

## Atomicity and Repair

Milestone creation must be tied to the durable state that proves the event:

- session milestones are inserted in the same storage transaction as their
  `turn_end` entry;
- `review_ready` is inserted in the same transaction as
  `waiting_reviewer -> waiting_feedback`;
- workflow failure is inserted with the transition to `failed`.

Both operations use deterministic IDs, so transaction retry is safe. Startup
repair may scan terminal state for a missing deterministic outbox event as a
defence against databases created by older versions, but normal correctness
does not depend on an in-memory marker.

## Remote Outbox Synchronization

Workers expose an authenticated cursor endpoint:

```text
GET /api/notification-outbox?after=<seq>&limit=<n>
```

The response includes ordered events and `nextCursor`. The endpoint is
machine-facing and uses the existing API-key/reverse-connect trust boundary.

The front's notification sync service:

1. reads the saved cursor for a remote server;
2. requests the next page through `proxyToRemoteAuto`;
3. maps remote project, session, and workflow IDs to local IDs;
4. verifies that the local project belongs to a user;
5. inserts notifications idempotently;
6. commits the new cursor;
7. emits `notification:created` only for newly inserted rows;
8. continues until the page is not full.

Sync runs immediately when a remote server becomes available and periodically
while configured remotes exist. Workflow reviewer registration also requests
an immediate sync. This makes recovery independent of whether a particular
session WebSocket or browser tab is open.

An outbox event whose remote session cannot yet be mapped is not skipped and
does not advance the cursor. The front retries after the workflow/session
mapping has been persisted.

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
- play the sound associated with its kind;
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

## Failure Handling

- A duplicate outbox delivery is harmless.
- An inbox insertion followed by a crash before cursor update is replayed and
  deduplicated.
- A transient remote error leaves the cursor unchanged and retries later.
- A missing mapping blocks that cursor page rather than silently losing an
  event.
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
- reviewer generic-notification suppression;
- exactly one `review_ready`;
- source feedback turn producing a later result notification;
- local crash-window drain;
- remote retry, replay dedupe, ID mapping, ownership derivation, and blocked
  mapping behavior;
- direct and reverse-connect proxy paths.

Frontend tests cover:

- server hydration and SSE insertion;
- notification-ID dedupe;
- exact-session auto-read;
- same-branch/different-session remaining unread;
- success, review, and failure presentation;
- refresh restoring unread state from the server;
- no remaining notification dependency on `branch:activity`.

End-to-end verification covers:

1. an independent local session;
2. an independent remote session with the browser closed;
3. a remote reviewer completing while the front is offline;
4. review approval followed by source modification completion;
5. front crash after inbox insertion but before cursor advancement.
