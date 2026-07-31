# Project Chat Mutation Correctness Design

Project Chat mutation durability is implemented as a typed, immutable-scope operation journal. The existing `project_chat_operations` table is migrated to store `project_id`, `user_id`, `kind`, and `payload_version` independently of the bounded JSON payload. Database checks constrain the independent columns, repository writes validate typed payloads before serialization, and repository reads validate both payload shape and agreement with the row discriminants. Invalid legacy data is surfaced as a bounded data-integrity error rather than silently ignored.

The migration rebuilds and backfills operation scope from the owning thread. Foreign keys and insert/update triggers require the stored thread, project, and user scope to agree, and immutable-update triggers prevent scope, kind, version, and identity from changing. Correlation queries start from the stored project scope and use an index beginning with `project_id, entity_type, entity_id, status`, with a stable ID tie breaker.

Workspace selection uses a single conditional repository update. A pending selection can be claimed only once with its stable idempotency token, canonical workspace identity, and preallocated session identity. The winner advances it to `resolving` before the external effect. A same-selection loser follows the durable claim and reuses its eventual result; a conflicting loser receives a bounded already-resolved error. A restart resumes the claimed intent without changing its identity.

Session creation persists a complete bounded typed intent and preallocated identity before any service call. Pending and resolving creates are restart-reconciled by discovering an already-created canonical session or retrying the idempotent creation service. This covers crashes before the effect and after the effect but before the journal transition without creating a second session.

Instruction delivery is explicitly at-least-once. The journal distinguishes pending delivery from confirmed-after-send delivery and carries a stable idempotency key to remote transports when supported. A persisted transcript message is never treated as transport acknowledgement. Pending attempts are retried after a crash; confirmed attempts are reused. The unavoidable raw-stdin crash window may duplicate an instruction, but the system never falsely reports an unsent instruction as delivered.

The manager subscribes to EventBus before starting bounded, paginated reconciliation. Reconciliation is tracked as manager work, checks nonterminal session and schedule operations against canonical durable state, and applies the same atomic monotonic transitions as live events. Shutdown waits for tracked reconciliation only within the existing bounded drain policy and always removes the listener. No page or subscriber is needed for persistence.

Task branch assignment revalidates the exact branch against the current authorized workspace list immediately before the task write. Duplicate branches across targets remain valid because task assignment stores only the branch; null clears are allowed.

The system prompt accurately lists the six safe mutations and retains the hard boundaries: no delete, worktree creation, schedule configuration, session stop, or Git operation.

Testing follows strict red-green-refactor cycles. Real SQLite tests cover migration, invalid payloads, triggers, immutable scope, index shape, and concurrent claims. Tool tests cover selection races, restart recovery, delivery crash windows, and branch revalidation. Manager tests cover missed terminal events, pending effects, foreign scope, listener ordering and cleanup, and bounded lifecycle tracking.
