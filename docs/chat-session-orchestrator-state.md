# Chat Session Orchestrator: Turns, Pending Work, Watchdog & Workspace Dot

How the Main Chat orchestrator (the "commander") organizes its work into turns,
keeps track of what it still owes, enforces its turn contract, and drives the
workspace dot — and how that coexists with the coding agent's own state.

Code: `packages/vibedeckx/src/chat-session-manager.ts` unless noted, plus
`commander-turn.ts` (turn object, pending registry), `commander-operations.ts`
(identity ledgers) and `chat-history.ts` (what the model is shown).

---

## 1. Background: two actors, one dot

A workspace branch has **two** independent AI actors:

| Actor | Where | Manager | What it does |
|-------|-------|---------|--------------|
| **Coding agent** | the lower "agent window" | `AgentSessionManager` | spawns Claude Code as a child process, does the heavy code edits |
| **Chat orchestrator** | the Main Chat panel | `ChatSessionManager` | answers questions, runs executors/terminal/browser tools, dispatches coding agents, summarizes events |

Both report activity for the **same** sidebar dot (`StatusDot` in
`apps/vibedeckx-ui/components/layout/app-sidebar.tsx`). The most recent emit
(by `since`) wins.

| State | Color | Meaning | Emitted by |
|-------|-------|---------|------------|
| `idle` | gray | no activity yet / fresh conversation | both |
| `working` | blue pulse | coding agent running | `AgentSessionManager` |
| `completed` | lime | coding agent finished its task | `AgentSessionManager` |
| `stopped` | amber | stopped / abandoned / stalled | both |
| `main-running` | violet pulse | orchestrator streaming a reply | `ChatSessionManager` |
| `main-waiting` | hollow violet ring, slow pulse | orchestrator still on the task between replies, waiting for results or for the user | `ChatSessionManager` |
| `main-completed` | emerald | a turn the user opened ended normally — over to the user (failed stream → `stopped`) | `ChatSessionManager` |

`computeBranchActivity` (`branch-activity.ts`) only derives the agent states
from `agent_sessions`. The orchestrator emits `main-*` itself via
`emitChatActivity`, through the same `BranchActivityDedupe` gate and
`branch:activity` SSE channel; `overlayOrchestratorActivity` replays live
`main-*` states into the REST snapshot. `main-running` and `main-waiting` are
live work: they win over a New Conversation placeholder
(`lib/workspace-status.ts`).

---

## 2. Three layers: session, turn, step

- **Step** — one model call plus the tool calls it makes inline
  (`ObservedStep`; at most `MAX_COMMANDER_STEPS = 6` per stream).
- **Stream** — one `streamText` run (`runStream`).
- **Turn** — one user message (or a listened event) and *all* the work it
  leads to, across as many streams as it takes, until the commander owes
  nothing. A hub-side bookkeeping object (`CommanderTurn`, on
  `ChatSession.turn`); the model API is unchanged.

A session has at most one open turn, so a turn is a contiguous range of
conversation entries starting at `turn.firstEntryIndex`. One `turn_end` divider
is written when a turn ends, however many streams it took.

The rule borrowed from eve: **a result of work the commander started never
opens a turn of its own — it joins the turn that started the work, waking it
if it waits; and that turn does not end while it still owes results.**

### `CommanderTurn` fields

| Field | Meaning |
|-------|---------|
| `openedBy` | `user`, or `listened_event` (an event the user opted to listen to, a browser event, a late result of abandoned work) |
| `status` | `running` (a stream is live or parked on an approval) / `waiting` (no stream; results or the user owed) |
| `userPresent` | whether the user was there when the current stream started — gates outbound agent actions (§8) |
| `toolless` | a browser-event turn: no tools, and nothing else joins it |
| `inbox` | arrivals not yet shown to the model; the next stream starts with them |
| `messages` | the turn as the model sees it, in full (§9) |
| `firstEntryIndex`, `streams`, `startedAt` | bookkeeping; `startedAt` anchors `getExecutorStatus`'s `startedThisTurn` |

---

## 3. Turn lifecycle

Everything entering the conversation goes through `deliver(sessionId, arrival)`.
An arrival is `user`, `result` (of the chat's own work), `notice` (a listened
event), `browser`, `nudge` (the turn contract) or `wait_timeout`.

- **No open turn** → the arrival opens one (`route` → `startStream`).
- **Open turn** → the arrival joins its inbox. A `waiting` turn wakes at once
  (next stream, same turn id); a `running` one shows it to the model when the
  current stream ends.
- **Browser events** never join an open turn, and nothing joins a browser
  turn: such arrivals wait in `ChatSession.outside` for the next turn.

A user message during a stream therefore no longer starts a second, concurrent
stream; it joins the turn.

### When a stream ends (`afterStream`)

Checked in order, first match wins:

| # | Condition | Result |
|---|-----------|--------|
| 1 | parked on a tool approval | nothing (the turn stays `running`) |
| 2 | aborted (Stop) | turn ends `cancelled` (§6) |
| 3 | inbox non-empty | next stream at once, same turn |
| 4 | pending work, or the plan's `waitingOn` is set | turn `waiting`; no `turn_end`, no watchdog; dot `main-waiting` |
| 5–6 | otherwise | the turn may end: `enforceTurnContract` decides (§5) |

```
            openTurn ──► running ◄──┐ inbox non-empty / nudge: next stream
                          │  ▲  ────┘
   owed / wait / waitingOn │  │ result, user message, wait timeout, deadline
                          ▼  │
                        waiting ──Stop──► ended
                          running ──(stream end, nothing owed)──► ended
                          running ──Stop──► ended
```

`ended` is `completed`, `cancelled` or `stalled`.

---

## 4. Pending work

`PendingRegistry` (`commander-turn.ts`, on `ChatSession.pending`) answers one
question: *what does the chat still owe itself?* Every item reaches exactly one
outcome — `completed`, `failed`, `cancelled` or `interrupted` (unknown).

| Kind | Owed from | Settled when | Deadline |
|------|-----------|--------------|----------|
| `executor` | `runExecutor` registers the operation | its finish has been **delivered** to the turn; a reconcile with no exit code → `interrupted` | none (the reconciler checks the process) |
| executor, service | same | its start is confirmed (`completed`): a service is done once up | — |
| `agent_dispatch` | spawn activation / `sendToAgentSession` | its turn end is matched; a later dispatch's turn end → `interrupted` | 2 h → `[Agent Event: No Reply]`, `interrupted` |
| `spawn` | `spawnAgentSession` call | the call returns | 5 min: the call itself answers "start not confirmed" |
| `terminal_watch` | `runInTerminal` | output flushed, or 60 s idle → `[Terminal Event: No New Output]` | idle timer |

Rules that keep it honest:

- **Identity stays with the ledgers.** `CommanderOperationLedger` and
  `AgentDispatchLedger` still match events to work by exact identity, and
  notify the registry on every change (constructor listener), so the mirror is
  exact whoever drives them.
- **An item settles in the same tick its result enters the turn.** Settling
  earlier (e.g. while a finish's lookups are still awaited) lets a stream end
  the turn in between, and the result then opens a turn of its own.
- **Work belongs to the turn whose tool call started it.** `createTools`
  captures that turn's id; `owe()` registers an item only while that turn is
  still open. A tool call still finishing after Stop, or a late confirmation
  arriving in a newer turn, is owed to nobody.
- **In-stream waits answer the tool call.** A deadline for something the
  model is blocked on inside a tool call (the spawn) must make that call
  return; posting to the inbox is useless until the stream ends.
- **Exit codes are facts.** A run whose finish was never observed and whose
  process record has no exit code is reported as `Exit Code: unknown`, never
  as a made-up `1`.

The sweep for deadlines (`expireOverdue`) rides the 30 s reconcile timer.

---

## 5. The turn contract (watchdog)

`enforceTurnContract` runs only at §3 row 5–6: the stream ended, nothing is
owed, nobody is waited for. It returns a verdict instead of injecting messages
itself:

| Verdict | Meaning |
|---------|---------|
| `pass` | the turn ends `completed`, or `failed` if its stream failed (`complete_task` was called, the plan is done or blocked/stalled, a plan-less stream called a non-lookup tool, or the budget gave up on a turn that never started work) |
| `nudged` | a `[Plan Continuation]` or `[System Invariant Violation]` message went into the inbox; the turn goes on |
| `retry` | the stream failed with a plan owing steps; the turn waits out `stallRetryDelayMs`, then decides again |
| `stalled` | the budget ran out on a plan, or on a plan-less turn that started work: `[Plan Stalled]` / `[Commander Stalled]` entry, dot `stopped`, durable `commander_stalled` milestone |

- **Unfinished plan → plan-idle rule.** Tools called do not count; re-drive
  with `[Plan Continuation]` up to `MAX_TURN_NUDGES = 3`, then stall.
- **No unfinished plan → no-tool rule.** A stream that called nothing but
  lookups (`LOOKUP_TOOLS`) gets a correction, up to the same budget. Then a
  turn that started work (`turn.startedWork`) stalls; one that never did is
  left alone. Because rule 4 runs first, a text-only reply while work is in
  flight is compliant.
- Browser turns always pass (they have no tools to call).
- Budget (`ChatPlanState.nudges`) resets on a compliant stream, async work
  starting, or the user speaking.

`setPlan` refuses to mark a step `completed` while its latest executor run is
still in flight — except a service that is up.

---

## 6. `complete_task`, `wait`, Stop

**`complete_task`** declares the turn finished, once. It is refused while work
the turn started is still owed or a result has arrived the model has not read
yet; a second call in the same turn changes nothing. New work registered after
it withdraws the completion. It does not paint the dot: the dot follows the
turn (`main-completed` when it ends).

**`wait({ timeoutSeconds? })`** is the model's "nothing to tell the user,
waiting on results". It ends the response; any result, the user speaking, or
the timeout (default 600 s, max 3600 s, `[Wait Timeout]`) wakes the turn. It
returns at once if an unread result is already in the inbox, and is refused
when nothing is owed. It stops nothing.

**Stop** ends the turn `cancelled` — a running stream, one parked on an
approval, or a waiting turn. Everything still owed settles `cancelled`; the
processes and agents keep running (they are the user's); the chat stops
watching terminals. Of the unread inbox, the user's own words open the next
turn and results are kept only as events when the user listens. A later
result of abandoned work reaches the chat only as a listened event
(`deliverOwn`) — except a service's exit (§7).

---

## 7. Services

An executor with `lifecycle: "service"` (`executors.lifecycle`; the "Long-running
service" switch in the executor form, on for the Dev Server preset) is done
once its start is confirmed: it is not owed, the response goes on instead of
handing off, its plan step can be completed, and `getExecutorStatus` shows the
lifecycle. Its later exit is news, not a result: delivered as an event even
with listening off and after Stop. A service that dies before its start is
confirmed is still the result its turn waits for; one whose start was unknown
and is confirmed later delivers `[Executor Event: Service Started]`.

---

## 8. Approval and untrusted events

`spawnAgentSession` / `sendToAgentSession` need the user's approval in a
stream nobody is watching: `needsApproval = turn.userPresent === false`.
`userPresent` follows the arrivals that start a stream (`userPresentAfter`): a
user message → present; a result, event or timeout → not; a nudge alone →
unchanged. This replaces the old `wokenByEvent` content sniffing with the same
effect: "agent finishes → commander wakes → dispatches again" still asks first
(see [`event-driven-outbound-approval-design.md`](./event-driven-outbound-approval-design.md)).

Browser events are page-controlled: their turns get no tools, and they never
join a turn that has them.

The orchestrator dot follows only turns the user opened (`drivesDot`);
listened-event turns leave the dot to the subsystem that fired.

---

## 9. What the model is shown

Built per stream by `historyPrefix` + `turn.messages` (`chat-history.ts`):

1. the rolling summary, if any;
2. the words (user/assistant text) of every ended turn the summary does not
   cover;
3. the open turn in full — its user messages and every stream's assistant
   messages, tool calls and tool results (`result.response.messages`), each
   tool result cut to 8 KB, the turn kept under ~120 KB by dropping its oldest
   tool outputs first.

Once more than `KEEP_RECENT_TURNS = 3` turns have ended, the oldest are folded
into the summary by the user's fast model, in the background at a turn end,
batch by batch (`summaryBatch`; the summary only advances over what was
actually handed over). The active plan travels in the system prompt as
`<current-plan>`.

---

## 10. UI

- Chat status (`STATUS` patch) is `running`, `waiting` or `stopped`
  (`ChatSessionStatus`; agent sessions never send `waiting`), kept in line by
  `syncStatus`.
- A `TurnState` frame `{ status, waitingFor }` is pushed on every turn change
  and on (re)connect; Main Chat shows "Waiting for …" above the composer.
- While waiting the composer stays open (a message joins the same task) and
  Stop is offered; while a reply streams the composer is locked.

---

## 11. File / symbol index

| Concern | Location |
|---------|----------|
| Turn object, pending registry, arrival rules | `commander-turn.ts` |
| Identity ledgers (executor operations, agent dispatches) | `commander-operations.ts` |
| `deliver` / `route` / `startStream` / `afterStream` / `endTurn` | `chat-session-manager.ts` |
| `enforceTurnContract`, `stallPlan`, `expireOverdue`, `reconcileInFlight` | `chat-session-manager.ts` |
| `complete_task`, `wait`, `setPlan` tools | `createTools()` in `chat-session-manager.ts` |
| History and summary | `chat-history.ts`, `historyPrefix` / `maybeSummarize` |
| `BranchActivity`, overlay, `shouldEmitMainCompleted` | `branch-activity.ts` |
| Chat status / `TurnState` on the frontend | `apps/vibedeckx-ui/hooks/chat-stream.ts`, `components/conversation/main-conversation.tsx` |
| Dot rendering | `apps/vibedeckx-ui/components/layout/app-sidebar.tsx`, `lib/workspace-status.ts` |
| Tests | `chat-session-manager.turn.test.ts`, `.continuation.test.ts`, `.operations.test.ts`, `commander-turn.test.ts`, `chat-history.test.ts` |
