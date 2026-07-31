# Project Chat Mutation and Correlation Design

## Scope

Project Commander gains five state-changing capabilities: create and update a task, create an agent session in an explicit existing workspace, send a supplemental instruction to an existing session, and run an existing schedule immediately. A sixth tool, `select_workspace`, only resolves a persisted pending session-creation intent. No destructive, Git, worktree-creation, session-stop, or schedule-configuration capability is exposed.

Every tool is bound to the manager-supplied project and user. Model inputs never include `projectId`. Inputs are strict, bounded schemas. Immediately before a side effect, the handler revalidates the bound project and target ownership/association. Remote operations use persisted mappings, project-remotes authorization, and existing proxy paths rather than decoding synthetic IDs.

## Persistent Operations

A `project_chat_operations` table stores both pending workspace-selection intents and session/schedule correlations. Each row is owned by a chat thread through a cascading foreign key, carries immutable project and user scope, and has stable operation and idempotency identities. Exact indexes cover thread/status lookup and project/entity-type/entity-ID event correlation. Repository reads are bounded and authorize through the owning thread.

Operation payloads and public `operation` messages use bounded, versioned, discriminated JSON shapes. Status transitions are monotonic: terminal states cannot regress, and duplicate or stale transitions are no-ops. Public update message IDs and operation transition identities are deterministic where practical, allowing duplicate events to be safely replayed.

## Explicit Workspace Selection

`create_agent_session` requires an explicit canonical workspace target. When it is missing, the tool persists a selection-request operation with a stable request ID and a bounded list of injective candidate identities. It never guesses a branch, chooses a sole candidate automatically, creates a worktree, or creates a session.

`select_workspace` loads the pending intent in the bound project/user/thread, validates the selected candidate still exists and is authorized, then resumes the stored creation request. Exactly-once recovery uses a persisted idempotency key and preallocated session ID passed through the narrow mutation-service boundary. Before retrying, the adapter looks up that identity and reuses the already-created session, covering a restart or crash after the external side effect but before the operation status write. An atomic claim prevents concurrent resolution; durable identity, not an in-memory lock alone, prevents duplicate side effects.

## Mutation Services and Auditing

The tool factory receives narrow injected mutation services backed in production by existing task storage/services, `AgentSessionManager`, remote mapping/proxy infrastructure, and `SchedulerService.runNow`. Successful task mutations touch task context. Session creation touches workspace and session context and creates a correlation. Sending an instruction touches session context. Schedule execution touches schedule and run context and creates a run correlation.

Normal model streaming continues to persist structured `tool_use` and `tool_result` messages. Each mutation additionally persists a public operation card. Partial or service failures create bounded structured error results and failure operation updates; they never claim success.

## Event Flow

Session completion/failure and schedule run start/finish/failure events carry stable `projectId` and exact session or schedule/run identity. A manager subscribes once and unsubscribes during shutdown. For an event, it queries only exact correlated operations, applies an idempotent monotonic transition, persists the public operation message, and only then emits WebSocket frames to subscribers of the originating threads. Unrelated threads and foreign-project events receive nothing. Multiple threads legitimately correlated to the same entity each receive their own update. With no subscriber or after restart, persisted operations/messages retain the update.

V1 does not enqueue an AI reactive turn; persisted operation cards are safer and do not consume thread turn or tool budgets.

## Testing

Tests first cover the exact exposed tool names and forbidden absence, strict schemas, per-operation authorization revalidation, bounded failures, and audit/context behavior. Workspace tests cover zero, one, and many candidates; missing explicit selection; stale and foreign candidates; restart recovery; crash-window recovery; concurrent retries; and exactly-once session creation.

Real SQLite tests cover idempotent migration, indexes, scope enforcement, bounded queries, and thread cascade. Manager tests cover exact event routing, two valid correlations to one entity, foreign-project rejection, duplicate and out-of-order monotonicity, persistence without subscribers, restart restoration, and subscription lifecycle. Focused suites run at each RED/GREEN step, followed by TypeScript, build, and the full backend suite.
