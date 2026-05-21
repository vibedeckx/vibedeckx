# Chat Session Orchestrator: State, Watchdog & Workspace Dot

How the main chat session (the "orchestrator") tracks its run state, enforces a
per-turn tool invariant, and drives the workspace dot color — and how that
coexists with the coding agent's own state.

All code referenced here lives in `packages/vibedeckx/src/chat-session-manager.ts`
unless otherwise noted.

---

## 1. Background: two actors, one dot

A workspace branch has **two** independent AI actors:

| Actor | Where | Manager | What it does |
|-------|-------|---------|--------------|
| **Coding agent** | the lower "agent window" | `AgentSessionManager` | spawns Claude Code as a child process, does the heavy code edits |
| **Chat orchestrator** | the main chat panel | `ChatSessionManager` | answers questions, runs executors/terminal/browser tools, summarizes events |

Both report activity for the **same** sidebar dot (`StatusDot` in
`apps/vibedeckx-ui/components/layout/app-sidebar.tsx`). The dot shows one color
at a time; the most recent emit (by `since` timestamp) wins.

### Color reference

`BranchActivity` / `WorkspaceStatus` values and their dot colors:

| State | Color | Meaning | Emitted by |
|-------|-------|---------|------------|
| `idle` | gray | no activity yet / fresh conversation | both |
| `working` | blue pulse | **coding agent** actively running | `AgentSessionManager` |
| `completed` | emerald | **coding agent** finished its task | `AgentSessionManager` |
| `stopped` | amber | stopped / abandoned mid-turn | both |
| `main-running` | **violet pulse** | **chat orchestrator** actively processing | `ChatSessionManager` |
| `main-completed` | **cyan** | **chat orchestrator** finished its response ("over to you") | `ChatSessionManager` |

The `main-*` variants exist specifically so the user can visually tell
"orchestrator is working" (violet) apart from "coding agent is working" (blue),
and "orchestrator done responding" (cyan) apart from "coding agent task done"
(emerald).

Type definitions (kept in sync manually across the process boundary):
- Backend: `BranchActivity` in `branch-activity.ts`; event payload in `event-bus.ts`.
- Frontend: `BranchActivity` in `hooks/use-branch-activity.ts`; `WorkspaceStatus`
  in `lib/workspace-status.ts`.

### Emit plumbing

`computeBranchActivity` (in `branch-activity.ts`) **only** derives the four
agent states from the `agent_sessions` DB table. It never returns `main-*`.

The chat orchestrator emits its states directly via
`ChatSessionManager.emitChatActivity(session, activity)`, which forwards to
`AgentSessionManager.emitBranchActivityIfChanged(...)`. Both actors share the
same `BranchActivityDedupe` gate (a redundant emit of the same value is
dropped) and the same SSE channel (`branch:activity` events → `/api/events`).
The frontend `useBranchActivity` hook applies the most-recent-by-`since` event.

---

## 2. Chat orchestrator turn lifecycle

A "turn" is one `sendMessage(sessionId, content, eventDriven?)` invocation:
push a user/event message, stream the model response (with up to
`stepCountIs(3)` tool-use rounds), finalize.

### Dot transitions on a user-initiated turn

```
user sends message
   │
   ▼
sendMessage start ──────────────► emit main-running  (violet)
   │  taskCompleted = false
   │
   ▼
stream loop
   ├─ tool-call ────────────────► emit (taskCompleted ? main-completed : main-running)
   │                                (refreshes `since`; sticky-cyan within the turn)
   ├─ complete_task tool ───────► markCompleted: taskCompleted = true, emit main-completed (cyan)
   └─ trailing text ────────────► (no emit)
   │
   ▼
stream ends
   ├─ watchdog check (§3)
   └─ finally: status=stopped (internal WS patch, NOT a dot emit), drainQueue
```

The next user turn resets `taskCompleted` and emits `main-running` again — so
the dot goes **violet → cyan → (next message) violet → cyan → …**.

`complete_task` means **"this response is finished, over to you"** — cyan. It is
NOT a permanent "task closed" state; every new turn is fresh work (violet).

### Per-session state flags (`ChatSession`)

| Field | Lifetime | Purpose |
|-------|----------|---------|
| `status` | per-stream | internal `running`/`stopped` — drives the WS `/status` patch for the chat UI, **not** the dot |
| `taskCompleted` | sticky within a turn, reset at next `sendMessage` start | set by `complete_task`; keeps cyan for the rest of the turn (handles the tool-call/execute emit-ordering race and post-complete tool calls) and tells the watchdog the turn is well-formed |
| `eventDrivenTurn` | per turn | true if the turn is a reactive system event; gates all orchestrator dot emits off (see §5) |

### Lifecycle emits

- `stopGeneration` (user clicks Stop) → emit `stopped` (amber).
- `resetSession` (New Conversation) → clears `taskCompleted`, clears the
  watchdog counter, emit `idle` (gray).

---

## 3. The per-turn tool invariant & watchdog (implemented)

### Problem

The model sometimes **claims** it called a tool ("I ran the build", "已修改…")
without actually emitting a `tool_use` block. The action silently never
happens, no completion event fires, and the workflow stalls.

### The invariant

> **Every assistant turn must contain at least one `tool_use` block.**

A turn ends legitimately in exactly three ways:
1. invoke a real tool (make progress),
2. invoke `complete_task` (done responding),
3. the user aborts.

`complete_task` is itself a tool, so the invariant collapses to a single
**structural** check — no LLM judge needed for hallucination detection. It is
taught to the model in the system prompt's `<critical-rules>` section (see
`getSystemPrompt`).

### The watchdog

Implemented inline at the end of the `sendMessage` stream loop:

- `toolCallCountInStream` increments on every `tool-call` part.
- After the stream completes, if `toolCallCountInStream === 0` **and** the turn
  was not aborted **and** `taskCompleted` is false → the model just talked
  without acting. Inject a correction message back through the queue;
  `finally → drainQueue` picks it up and starts a fresh stream so the model can
  invoke a tool this time.
- `correctionCounts` (per session) caps consecutive corrections at
  `MAX_CHAT_CORRECTIONS = 2` to prevent infinite nudge loops. A well-formed turn
  (≥1 tool call) resets the counter.

### Why no `since`-debounce / LLM judge here

`stop_reason === end_turn` (a stream that ends with no tool call) is a
deterministic signal — there is nothing in flight to wait for, so the check is
synchronous. The structural invariant replaces the probabilistic
"LLM-as-judge" approach we considered for hallucination detection.

---

## 4. `complete_task` tool (implemented)

```
complete_task({ summary?: string })
```

- Calls `markCompleted(sessionId)`: sets `taskCompleted = true` and (on
  non-event turns) emits `main-completed` (cyan).
- Does **NOT** abort the stream — the tool-result and any trailing assistant
  text still render, and the user can keep chatting.
- On the next turn, `taskCompleted` resets and the dot returns to violet.

Documented to the model under `<lifecycle-tools>` in the system prompt.

---

## 5. Event-driven turn gating (implemented)

### Problem

When a subsystem fires (coding agent finishes, executor exits, terminal output,
browser error), `ChatSessionManager` injects a synthetic `[X Event: …]` message
into the chat to summarize it. Without gating, this reactive turn emits
`main-running` and **repaints the dot violet** — even though the user never
engaged the orchestrator and the real subsystem (e.g. the agent) just reported
`completed` (emerald).

### The rule

> Reactive system-event turns must **not** drive the orchestrator dot. The dot
> keeps showing the real subsystem state.

### Mechanism

- `isSystemEventMessage(content)` matches `^\[(Executor|Agent|Terminal|Browser) Event`.
- `sendMessage` sets `session.eventDrivenTurn = eventDriven ?? isSystemEventMessage(content)`.
  An explicit `eventDriven` override from the caller wins over content sniffing.
- All three orchestrator emit sites — `sendMessage` start, the `tool-call`
  handler, and `markCompleted` — are gated behind `!session.eventDrivenTurn`.
  (`markCompleted` still **sets** `taskCompleted` so the watchdog treats the
  turn as well-formed; it just skips the cyan emit.)

So an agent-window task completing → agent emits emerald → chat summarizes
silently → dot stays emerald.

---

## 6. `chatInitiatedAgentTasks` discriminator (scaffolded)

### The distinction

| Scenario | Dot behavior | Why |
|----------|--------------|-----|
| User starts a task **in the chat**, chat delegates to the agent, agent finishes, **chat continues** the workflow | agent emerald, then **violet** when chat continues | the continuation is genuine orchestrator work the user initiated |
| User starts a task **in the agent window**, agent finishes, chat just auto-summarizes | stays agent emerald (**no violet**) | incidental reactive summary; the user never engaged the orchestrator |

The single discriminator is: **did the chat orchestrator start this agent task?**

### Implementation

- `chatInitiatedAgentTasks: Set<string>` — coding-agent sessionIds delegated by
  the chat.
- `registerChatInitiatedAgentTask(agentSessionId)` — public hook for a future
  chat tool that delegates to the agent to call on delegation.
- The `eventDriven` flag is threaded through `enqueueOrSend` → `messageQueue`
  (now `{ content, eventDriven? }`) → `drainQueue` → `sendMessage`, so the
  classification survives queuing.
- `handleSessionTaskCompleted` computes
  `isChatInitiated = chatInitiatedAgentTasks.delete(event.sessionId)` and passes
  `eventDriven: !isChatInitiated`. Chat-initiated completions therefore drive
  the dot (violet on the chat's response); agent-window ones stay gated.

### Current behavior

No chat tool delegates to the agent yet, so the set is **always empty**:
`isChatInitiated` is always false, every agent event takes the gated path, and
behavior is identical to §5. The discriminator is wired ahead of the feature so
it only needs to call `registerChatInitiatedAgentTask` once it exists.

---

## 7. Designed but NOT implemented (future work)

These were designed in discussion but deliberately left unbuilt — they depend on
the not-yet-existing "chat delegates to agent" feature and would be dead code
without it.

### 7a. Stuck-tool watchdog (timer-based, "Case 2")

Distinct from the §3 structural watchdog. Catches the *opposite* failure: a
`tool_use` **was** emitted but `tool-result` never returns (executor hung,
remote died, etc.).

Design: arm a per-tool timer on `tool-call`; cancel it on the matching
`tool-result`; on timeout do a cheap liveness check (child process alive?
recent stdout? WS connected?) and only escalate to an LLM judge if the signals
are ambiguous. Timeout length should vary by tool (`Bash` build vs `Read`).

### 7b. Response watchdog for chat-initiated agent tasks (Q2)

For tasks in `chatInitiatedAgentTasks`, the chat has an outstanding obligation:
when the agent completes, the chat *should* continue. If it doesn't (event
dropped, listening disabled, chat errored) the workflow stalls.

Design: arm a long watchdog at delegation (agent never reports back) and a short
watchdog after the `[Agent Event]` arrives (chat doesn't start responding).
**Gated on the same `chatInitiatedAgentTasks` bit** — agent-window tasks carry no
chat obligation, so they never arm a judge.

---

## 8. File / symbol index

| Concern | Location |
|---------|----------|
| Orchestrator state, watchdog, tools, gating | `packages/vibedeckx/src/chat-session-manager.ts` |
| `complete_task` tool | `createTools()` in the above |
| Watchdog | end of `sendMessage` stream loop (§3) |
| `emitChatActivity`, `markCompleted` | `ChatSessionManager` methods |
| `isSystemEventMessage`, `MAX_CHAT_CORRECTIONS` | module-level in the above |
| `BranchActivity` type, `computeBranchActivity`, `BranchActivityDedupe`, `emitBranchActivityIfChanged` | `packages/vibedeckx/src/branch-activity.ts`, `agent-session-manager.ts` |
| `branch:activity` event payload | `packages/vibedeckx/src/event-bus.ts` |
| SSE fan-out | `packages/vibedeckx/src/routes/event-routes.ts` |
| Dot rendering (`StatusDot`) | `apps/vibedeckx-ui/components/layout/app-sidebar.tsx` |
| Frontend activity hook | `apps/vibedeckx-ui/hooks/use-branch-activity.ts` |
| `WorkspaceStatus` + projection | `apps/vibedeckx-ui/lib/workspace-status.ts` |
