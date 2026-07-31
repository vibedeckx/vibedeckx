# Project Chat Work Journal Design

## Goal

Make every accepted Project Chat send durable and recoverable without exposing internal scheduling state in the public transcript, while bounding deletion and shutdown even when a runner ignores cancellation.

## Persistence model

Add `project_chat_work_items` with a stable work ID, thread ID, unique user-message ID, content, status (`accepted`, `running`, `completed`, `stopped`, or `failed`), optional error, and timestamps. The thread foreign key cascades on deletion. A bounded composite index on thread, status, creation time, and ID supports deterministic recovery. Journal records are internal and are never returned by transcript repositories, snapshots, model input, or WebSocket frames.

Acceptance is a single Kysely/SQLite transaction. It authorizes the owned thread, calculates the next transcript sequence inside the transaction, inserts the public user message, inserts the accepted work item, and touches the thread. Any failure rolls back every write. The manager queues the work and resolves the send only after commit.

Terminal completion is also atomic: append `turn_end` at the next sequence and transition the matching running/accepted work item to a terminal status in one transaction. If this transaction fails, the work remains nonterminal and is recoverable. Starting a runner transitions the work item to `running` before model execution.

## Runtime lifecycle

Hydration loads public transcript messages and nonterminal work items separately. Every accepted or running item is requeued, including a first idle turn; its already-persisted user message is not appended again. Terminal items never rerun. The old `operation` message protocol and marker recovery are removed.

Each thread has a lifecycle generation and deletion tombstone. Loads capture a generation and may publish a live thread only if the generation is still current, the thread is not deleted, and the manager is not shutting down. Open, send, and subscribe recheck lifecycle state after asynchronous authorization, hydration, and acceptance. Deletion permanently tombstones the thread for the manager lifetime.

The manager tracks outstanding loads and acceptances. Shutdown first fences new continuations, then settles pending queue promises and approvals, aborts active turns, and waits at most two seconds by default. Tests inject a short timeout. A timed-out runner is detached, not assumed stopped: its generation/turn token becomes invalid, so late output cannot persist or broadcast. Delete uses the same bounded drain behavior.

Every background turn promise has an observed rejection path. Failure to persist terminal state is contained and intentionally leaves the work nonterminal for restart recovery.

Idle live threads with no subscribers, queued work, or active turn are evicted immediately after their operation settles. Active and subscribed threads remain resident and rehydrate on future access after eviction.

## External behavior

REST authorization, 202 acceptance, per-thread serialization, approval handling, and snapshot-first WebSocket behavior remain unchanged. Public live frames remain JSON Patch frames containing only real public messages (`user`, assistant/tool events, errors, and `turn_end`) plus status/queue patches. Internal work rows never affect public message indices.

## Verification

Strict RED/GREEN tests cover: first-turn crash recovery, atomic acceptance rollback, delete during hydration, shutdown during auth/load/accept, abort-ignoring runners, terminal persistence failure containment and recovery, journal invisibility, and idle eviction/rehydration. Existing storage, manager, REST, WebSocket, authorization, queue, and approval tests remain green, followed by typecheck, build, the full backend suite, diff checks, and an independent code review.
