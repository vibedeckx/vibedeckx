# Project Chat Work Journal Design

## Goal

Make every accepted Project Chat send durable and recoverable without exposing internal scheduling state in the public transcript, while bounding deletion and shutdown even when a runner ignores cancellation.

## Persistence model

Add `project_chat_work_items` with a stable work ID, thread ID, unique user-message ID, content, status (`accepted`, `running`, `completed`, `stopped`, or `failed`), optional error, and timestamps. The thread foreign key cascades on deletion. A bounded composite index on thread, status, creation time, and ID supports deterministic recovery. Journal records are internal and are never returned by transcript repositories, snapshots, model input, or WebSocket frames.

Acceptance is a single Kysely/SQLite transaction. It authorizes the owned thread, calculates the next transcript sequence inside the transaction, inserts the public user message, inserts the accepted work item, and touches the thread. Any failure rolls back every write. The manager queues the work and resolves the send only after commit.

Terminal completion is also atomic: append `turn_end` at the next sequence and transition the matching running work item and attempt to a terminal status in one transaction. A stable opaque turn-end ID makes retry idempotent when commit succeeds but its response is lost. The live manager keeps the turn in running/pending-terminal state and retries transient failure with configurable per-attempt timeout, bounded attempt count, and backoff, without rerunning the model. A timed-out attempt gets a fresh in-memory write lane so the retry cannot remain blocked behind it. If retries are exhausted, the work remains nonterminal and is recoverable. Starting a runner transitions the work item to `running` and increments its persisted attempt epoch before model execution; every append, reset, and terminal write must match that epoch.

## Runtime lifecycle

Hydration loads public transcript messages and nonterminal work items separately. Every accepted or running item is requeued, including a first idle turn; its already-persisted user message is not appended again. Terminal items never rerun. Old queue-marker recovery through transcript messages is removed. `operation` remains a legitimate public message type for structured status cards; journal rows and internal marker content are never synthesized as operation messages.

Each thread has a lifecycle generation, an owner-checked shared in-progress deletion promise/fence, and a committed deletion tombstone. Loads capture a generation and may publish a live thread only if the generation is still current, the thread is not deleted, and the manager is not shutting down. Open, send, and subscribe recheck lifecycle state after asynchronous authorization, hydration, and acceptance. Deletion advances the generation immediately and blocks runner publication, but permanently tombstones only after the storage delete commits. Concurrent same-user deletes share one operation, so one caller cannot clear another caller's fence. A failed storage delete clears caches and the transient fence so a fresh open or delete can retry without allowing stale loads or runner output to resurrect.

The manager tracks outstanding loads and acceptances. Shutdown first fences new continuations, then settles pending queue promises and approvals, aborts active turns, and gives each active runner a configurable drain window of two seconds by default. A timed-out runner is detached locally before any persistence call, so its turn token becomes invalid and late output cannot persist or broadcast. Shutdown then attempts `running -> accepted` reset only as best effort within another explicit persistence window; stalled or rejected reset cannot delay or reject shutdown, and the nonterminal row remains recoverable.

REST Stop uses the same runner drain and local detach. Cooperative runners atomically finish as stopped. An abort-ignoring runner is detached after the drain window, receives a fresh local write lane plus an immediate repository-entry fence, and its exact attempt is terminalized as stopped within a bounded persistence window. The next queued item may start without waiting for the stale lane; rejected or stalled terminal persistence is contained and leaves a fenced nonterminal row for recovery. Delete drains only the runner, then proceeds directly to the thread delete without resetting work because the database cascade removes the work rows. These bounds cover runner drain and detach persistence, not already-authorized acceptance/hydration operations tracked by the manager.

Every background turn and late persistence promise has an observed rejection path. Exhausted terminal retries intentionally leave the work nonterminal for restart recovery without an unhandled rejection or unbounded retry loop.

Idle live threads with no subscribers, queued work, or active turn are evicted after a configurable grace period of 30 seconds by default. Active and subscribed threads remain resident and rehydrate on future access after eviction.

## External behavior

REST authorization, 202 acceptance, per-thread serialization, approval handling, and snapshot-first WebSocket behavior remain unchanged. Public live frames remain JSON Patch frames containing only real public messages (`user`, assistant/tool events, legitimate `operation` status cards, errors, and `turn_end`) plus status/queue patches. Internal work rows never affect public message indices, model input, snapshots, or WebSocket payloads.

## Verification

Strict RED/GREEN tests cover: first-turn crash recovery, atomic acceptance rollback, delete during hydration, shutdown during auth/load/accept, abort-ignoring runners, terminal persistence failure containment and recovery, journal invisibility, and idle eviction/rehydration. Existing storage, manager, REST, WebSocket, authorization, queue, and approval tests remain green, followed by typecheck, build, the full backend suite, diff checks, and an independent code review.
