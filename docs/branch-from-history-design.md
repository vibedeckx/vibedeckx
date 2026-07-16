# Branch from Historical Stop Points — Design

## Problem

The post-run Branch button (bottom of the agent conversation) only appears
after the latest run finishes. Once the user continues the conversation, the
previous stop point can no longer be branched — only the tail. We want every
historical stop point (each place where an agent turn finished) to remain
branchable, and to show per-turn duration at each stop point.

## Approach: explicit `turn_end` entries

Agent sessions persist an explicit `turn_end` entry whenever a turn actually
ends — the same pattern chat sessions already use. Stop points are exact
facts in the entry stream, not heuristics:

- Steering messages (user input sent while the agent is running — allowed by
  `sendUserMessage`, which writes to stdin mid-turn) can never be mistaken
  for stop points: no `turn_end` is written there.
- Per-turn duration and the way the turn ended ride on the entry.
- Old sessions (no `turn_end` entries) are explicitly out of scope: they
  show no stop points and no tail Branch button. No heuristic fallback.

Type change (`agent-types.ts`; chat's existing `turn_end` writes stay valid —
both new fields are optional):

```ts
type TurnOutcome = "completed" | "failed" | "stopped" | "process_exit" | "server_restart";

| { type: 'turn_end'; timestamp: number; durationMs?: number; outcome?: TurnOutcome }
```

## Backend

### Turn lifecycle tracking (`agent-session-manager.ts`)

`RunningSession` gains `turnOpenSince: number | null`.

- **Open**: set to `Date.now()` when a user turn starts and it is currently
  `null` — in `sendUserMessage`, **after** the send has actually been
  initiated (user entry pushed / stdin write or wake path underway). If
  wake/spawn fails synchronously, `turnOpenSince` must not be left set — a
  failed send must not create a phantom open turn. Steering messages while a
  turn is open do NOT reset it: duration is measured from the message that
  opened the turn.
- **Close**: `turn_end` entries are written by exactly one function,
  `appendTurnEnd`, with two callers:

```ts
// The single writer — normal entry path (pushEntry → persist → broadcast).
private async appendTurnEnd(session, entry: TurnEndEntry): Promise<void>

// Live paths: computes duration, closes the open turn.
private async endActiveTurn(session, outcome: Exclude<TurnOutcome, "server_restart">): Promise<void> {
  if (session.turnOpenSince === null) return;   // no turn in flight — no-op
  const endedAt = Date.now();                    // single clock read: timestamp === end of durationMs
  const durationMs = endedAt - session.turnOpenSince;
  await this.appendTurnEnd(session, { type: "turn_end", timestamp: endedAt, durationMs, outcome });
  session.turnOpenSince = null;                  // cleared only after the write resolves
}

// Restore path: no open turn, no duration — see "Restore-time repair".
private async repairInterruptedTurn(sessionId, rows): Promise<void>
```

**Durability stance.** `turn_end` rides the same best-effort persistence as
every other entry (`persistEntry` logs and swallows DB errors by design). A
strict write path + retry policy for this one entry type was reviewed and
**rejected**: turn markers share fate with the conversation content around
them — if local SQLite writes are failing (disk full), content entries are
being lost too and a durable `turn_end` after lost content is worthless. If
best-effort entry persistence ever becomes a real problem, it is an
all-entries concern, not a `turn_end` one. (Restore-time repair additionally
self-heals the lost-`turn_end` case when the DB status stayed "running".)

**Duration is wall clock only.** The CLI-reported `payload.duration_ms` is
NOT used: in background-task chains the ledger commits with the *last*
result's payload, which does not span from the user's message, and mixing
two notions of time under one UI label is worse than including the few
seconds of grace delay. If CLI-reported time is ever wanted, it gets its own
field (`agentDurationMs`) — out of scope.

`endActiveTurn` call sites and outcomes:

| Call site | outcome |
|---|---|
| `commitCompletion` (success result, after grace ledger) | `"completed"` |
| error-result handling (`subtype === "error"` block) | `"failed"` |
| `stopSession` (user stop) — after the "Session stopped by user." system entry | `"stopped"` |
| process exit/crash handler | `"process_exit"` |

**Ordering (all four paths):** finish the turn's content entries → `await
endActiveTurn(...)` → flip `session.status` / persist → broadcast the
**final status** (stopped, or error for a non-zero exit code — matching the
existing `code === 0 ? "stopped" : "error"` logic). `turn_end` must be on
the wire before the final status, otherwise the UI briefly shows a finished
conversation with no tail Branch affordance (the legacy tail row is
removed). The process-exit path currently persists its error entry
fire-and-forget — make it awaited as part of this sequencing.

The `turnOpenSince` guard makes every other `status → stopped` transition a
natural no-op: hibernation (LRU eviction), `switchAgentType`, `switchMode`,
`restoreSessionsFromDb` bulk reset — none of these end a turn, so no
spurious `turn_end` and no last-entry-scanning dedup.

Known edge (accepted): if the user sends the next message while a completion
candidate is held in the grace window, the ledger discards the candidate and
`commitCompletion` never runs — the two turns merge with no `turn_end`
between them. Status never returned to "stopped" in that window, so no stop
point existed there under the current UI either.

### Restore-time repair (server crash mid-turn)

`turnOpenSince` is in-memory, so a server restart during a turn would leave
the history without a closing `turn_end` (no tail stop point, no Branch
button). Every clean turn end writes `turn_end`, so an unclosed turn is
detectable by absence. In `restoreSessionsFromDb`, per session, **before**
`rebuildStoreFromRows` (repair the DB rows first, then build the store from
the repaired rows):

1. **Only when the session's persisted status is `"running"`** (read before
   the bulk reset to "stopped"). This gate does two jobs: it stops
   cleanly-stopped-but-marker-less sessions from being read as crashes —
   in particular it keeps the upgrade's first restart from mass-appending
   `server_restart` markers to every pre-feature session — and it makes
   repair idempotent (the repaired session is reset to "stopped", so a
   second restore never re-enters).
2. Scan entries from the tail, skipping trailing `system` entries
   (hibernation appends a "process hibernated" system entry *after* the
   turn's `turn_end`).
3. If the landing entry exists and is not `turn_end` → the previous process
   died mid-turn → `repairInterruptedTurn` appends (via `appendTurnEnd`
   plumbing against the DB rows)
   `{ type: "turn_end", timestamp: Date.now(), outcome: "server_restart" }`
   — **no `durationMs`** (the crash time is unknown; the UI shows
   "interrupted" instead of a fabricated duration).
4. If it is `turn_end` (or the session has no entries), do nothing.

(`turn_start` pairing was considered and rejected: detection power is
equivalent — unclosed-start vs. tail-not-end — and since the crash time is
unknown it could not provide a truthful duration either; it would only add a
second invisible entry type to skip everywhere.)

### Replay / wake

`buildFullConversationContext` gets a case to **skip** `turn_end` entries —
they are UI markers, not conversation content. (`rebuildStoreFromRows`, the
patch stream, and `remotePatchCache` are entry-type-agnostic — no changes.)

### Branch cutoff

`branchSession` gains `opts.upToEntryIndex?: number` (inclusive) and returns
a discriminated union instead of the current `string | null` (a string
sentinel like `"invalid-cutoff"` would itself be assignable to the
session-id case):

```ts
type BranchResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "not-found" | "empty-history" | "invalid-cutoff" | "running-needs-cutoff" };
```

Rules:

- **With `upToEntryIndex`** (the normal path — the UI always sends the
  `turn_end` entry's own index, including for the tail): read persisted
  rows only and **do NOT call `finalizeStreamingEntry`** — a historical
  branch must not mutate the source session (today's unconditional
  finalize would persist the in-flight partial assistant entry). Validate
  the row at `entry_index === upToEntryIndex` exists, parses, and has
  `type === "turn_end"` → else `invalid-cutoff` (route: 400). This keeps
  "branch only at stop points" a backend-enforced invariant — not for
  security (the caller owns the session), but because the design relies on
  every branched copy ending with `turn_end` so the new session immediately
  has its own tail stop point. Branching **while the session is running is
  allowed**: `turn_end` rows are immutable and the last one is by
  definition before the in-flight turn.
- **Without `upToEntryIndex`** (legacy full-copy path, kept for API
  compatibility): allowed only when the session is not running — reject
  running sessions with `running-needs-cutoff` (route: 409) so a mid-turn
  half-history can never be copied. The stopped-session behavior (finalize
  + full copy) is unchanged.

Truncation is safe at the protocol level because wake replay is a text
summary (`<conversation_summary>`), not structured messages. Everything
downstream (row copy, `rebuildStoreFromRows`, dormant creation,
`Branch - <title>` naming, activity emit) is unchanged.

### Routes (`agent-session-routes.ts`)

- `POST /api/agent-sessions/:sessionId/branch` body gains
  `upToEntryIndex?: number` (integer ≥ 0, else 400); `performLocalBranch`
  passes it to `branchSession` and maps `BranchResult` reasons:
  `not-found`/`empty-history` → 404, `invalid-cutoff` → 400,
  `running-needs-cutoff` → 409.
- Remote proxy: include `upToEntryIndex` in the `proxyAuto` body to
  `/api/path/agent-sessions/:id/branch`. Entry indices are shared verbatim
  between center and remote, so no translation.
- **Old-remote guard**: if `upToEntryIndex` was requested and the remote
  returned `messages.length > upToEntryIndex + 1`, respond
  `409 "Remote ignored branch cutoff; upgrade the remote"`, log the
  mismatch (`console.error` with remote server id — the operator's signal
  for a version drift), and do not register the mapping. This is post-hoc
  by design — same pattern as the existing unexpected-session-id 409.
  Center and remotes share one release pipeline and are upgraded in
  lockstep; capability negotiation was considered and rejected as
  over-engineering. The 409 can strand an orphan dormant branch on an
  outdated remote; acceptable as a misconfiguration backstop, not a
  supported state.

## Frontend

### `lib/api.ts`

`branchAgentSession(sessionId, agentType?, upToEntryIndex?)` — include
`upToEntryIndex` in the POST body when set. The agent-conversation UI always
sets it (the `turn_end` entry's index); only legacy callers omit it.

### `components/agent/branch-menu.tsx` (new)

Extract the existing inline dropdown (trigger + current-agent item +
alternate providers, `agent-conversation.tsx` ~809–872) into `BranchMenu`.
Props: `onBranch(agentType?)`, `providers`, `agentType`, `disabled`,
`emphasis?: "normal" | "subtle"`.

### `turn_end` rendering — `TurnEndDivider`

Each `turn_end` entry renders as a slim divider row:

```
──────────────────────────────  2m 14s  [⑂ Branch]
```

- hairline rule filling the width, then the duration label immediately
  **before** the branch trigger (`formatDuration(durationMs)` → "2m 14s",
  muted small text). When `durationMs` is absent (`server_restart`), show
  "interrupted" instead. The label is always visible.
- the `BranchMenu` trigger is **always rendered and always interactive** —
  no hover-only visibility (touch devices have no hover; an `opacity-0`
  button would still sit in the tab order and take invisible keyboard
  focus). Historical dividers use `emphasis="subtle"` (low-contrast, e.g.
  `text-muted-foreground/50`), raised to full contrast via the divider
  row's `group-hover` and `group-focus-within` (the div itself is not
  focusable — the focus signal comes from the button inside); the **last**
  `turn_end` uses `emphasis="normal"` — preserving today's tail-button
  discoverability.
- clicking branch calls `handleBranch(agentType, thisEntryIndex)` — the
  `turn_end` entry's own index as the inclusive cutoff.

The legacy tail Branch row (the `status !== "running" && messages.length > 0`
block) is **removed** — the last `turn_end` divider replaces it. Branch
affordances are NOT gated on `status !== "running"`: historical stop points
stay branchable while the agent works (the whole point of keeping them).

### Adjacency-check note

The "tool_use answered iff next message is user" check stays safe:
`turn_end` is only written when a turn ends. The one sequence where it lands
after a pending interactive `tool_use` is a user Stop — and there the next
user message genuinely starts a new turn rather than answering the old
prompt, which is the correct reading. Defensively, adjacency helpers may
skip `turn_end` entries when peeking at "the next message".

## Testing

- `agent-session-manager`:
  - exactly one `turn_end` per turn with the right `outcome` (success /
    error / user stop / process exit); its `timestamp` equals the end bound
    of `durationMs`; ordering — the `turn_end` patch precedes the final
    status patch (stopped *or* error);
  - no `turn_end` on hibernate / `switchAgentType` / `switchMode`;
  - steering mid-turn writes none and doesn't reset `turnOpenSince`;
  - restore repair: DB-status-running + mid-turn tail → one `server_restart`
    `turn_end`; restoring twice → still exactly one (idempotent);
    DB-status-stopped with marker-less tail (pre-feature session) →
    untouched; trailing-system-after-`turn_end` (hibernate) → untouched;
  - `buildFullConversationContext` skips `turn_end`.
- `branchSession`:
  - `upToEntryIndex` at a `turn_end` copies exactly the prefix;
    non-`turn_end` index → `invalid-cutoff`;
  - works while `status === "running"` **without** calling
    `finalizeStreamingEntry` and without persisting the in-flight partial
    assistant entry;
  - no cutoff + running → `running-needs-cutoff`; no cutoff + stopped →
    legacy full copy.
- `agent-session-branch-routes.test.ts`: body pass-through local + proxied;
  invalid cutoff → 400; running without cutoff → 409; old-remote overflow →
  409.
- Frontend: `formatDuration` unit test; divider renders duration /
  "interrupted"; branch click sends the entry's own index; subtle→normal
  emphasis on hover and focus-within.

## Out of scope

- Heuristic stop-point derivation for pre-feature histories.
- `turn_start` entries; `agentDurationMs` (CLI-reported time).
- A strict-persistence write path for `turn_end` (rejected — shares
  best-effort fate with all entries by design).
- Remote capability negotiation (lockstep upgrades assumed).
- Branch-tree visualization / provenance links.
- Edit-and-resend at the fork point (natural follow-up: after branching at a
  divider, prefill the input with the following user message).
