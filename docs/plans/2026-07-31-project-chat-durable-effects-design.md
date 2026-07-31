# Project Chat Durable Effects Design

## Goals

Project Chat mutations and scheduled execution must converge truthfully across process crashes, lost responses, concurrent retries, authorization changes, and malformed persisted rows. Every external effect receives a durable identity and claim before it can run. A frontend handle, worker-local identity, delivery key, schedule run, and task mutation are separate typed concepts and are never inferred from transcripts or transient memory.

## Authenticated worker session creation

Path-based worker session creation uses `requireAuth` and `resolveUserId`, relying on the reverse-connect client's existing API-key injection for server-to-worker calls. A path project is resolved or created under that authenticated owner. Existing projects and preallocated sessions must belong to the same owner and exact normalized path, branch, permission mode, agent type, and model. Unauthorized, partial, or conflicting matches fail before spawn.

Session identity is split in two. `frontHandle` remains the frontend's opaque `remote-*` handle. `workerSessionId` is a separately preallocated UUID/non-proxy ID. Both are persisted in the operation intent before the effect. Remote mappings bind the two. A retry after worker creation but before mapping persistence sends the same worker ID, receives the existing worker session, rebuilds the mapping, and then retries initial delivery.

A matching stored-only worker session row is a recoverable creation claim, not a permanent conflict. The agent session manager validates the complete scope, registers/rehydrates the same ID, and spawns it. Conflicting rows fail closed. Startup restoration includes valid zero-entry incomplete sessions or explicitly recognizes their creation state.

## Receiver delivery deduplication

`agent_instruction_deliveries` is a narrowly scoped durable receiver table keyed by `(session_id, idempotency_key)`, with an FK to the session, bounded content hash/metadata, and `pending|sent` status. The message route accepts an idempotency key, validates the canonical content hash on reuse, atomically claims concurrent delivery, writes input once, and marks `sent` only after the write succeeds. A prior sent claim returns success without another write; the same key with different content returns 409. A pending claim can retry after a pre-write failure or worker restart. Local Project Chat delivery uses the same service where practical.

## Durable schedule execution claim

The scheduler creates or claims the caller's preallocated run row before any local or remote spawn. A migration-safe `queued|starting|running|terminal` lifecycle and stable executor process identity derived from the run ID make retries discoverable. Concurrent calls with the same run ID share one claim. A crash before spawn resumes the queued claim; a crash after spawn discovers the same deterministic process rather than starting another. Spawn rejection terminalizes the claimed run as failed. Local and remote paths use the same claim semantics, with remote execution forwarding the deterministic process ID to an idempotent receiver start route.

## Operation recovery and live retries

Session creation, instruction delivery, schedule runs, and task mutations keep complete typed intents in `project_chat_operations`. Task create journals its stable task ID and complete create data before insert. Task update journals its complete patch before update. Reconciliation reuses a matching existing entity or reapplies the intended patch, restores scoped context, rereads authoritative state, and only then transitions terminal/running.

Pending retryable operations enter a manager-owned retry queue with injectable bounded exponential backoff and an attempt cap. Timers are tracked and cancelled during shutdown. Permanent authorization, identity, and content conflicts terminalize; transient transport or lost-response errors remain retryable. Confirmation gates immediately reread the authoritative session/run state so an event that raced before confirmation is not lost.

## Malformed rows and bounded startup

Operation listing exposes rows individually without allowing one malformed payload to abort a page. Malformed rows are logged and quarantined/failed through a raw-safe scoped repository path. Valid later rows continue. `ready()` returns a reconciliation report or rejects only for a meaningful infrastructure-level failure. The initial reconciliation phase has a fixed row/time cap; remaining pages run as tracked background continuation with bounded concurrency and shutdown cancellation. Event-handler failures are logged/observable and do not crash the event bus.

## Testing and review

Strict red-green-refactor tests cover authentication and ownership, real front-to-worker identity flow, stored-only recovery, receiver delivery concurrency/crash windows, local and remote schedule claim crash windows, live retry behavior, task crash recovery, confirmation-state rereads, malformed-row isolation, and bounded startup continuation. Each critical cluster receives an internal diff and invariant review before the next cluster. Final verification includes focused suites, full backend tests, TypeScript, build, and diff checks.
