# Branch from Historical Stop Points — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist an explicit `turn_end` entry at every agent-turn stop point so the UI can render a per-turn duration divider with a Branch button at every historical stop point, and `branchSession` can copy a validated prefix of the history.

**Architecture:** `turn_end` is a new variant of the existing `AgentMessage` union that rides the normal entry pipeline (pushEntry → SQLite `agent_session_entries` → JSON Patch broadcast). The manager tracks `turnOpenSince` per running session and closes it via `endActiveTurn(outcome)` at the four real turn-ending transitions; `restoreSessionsFromDb` repairs crash-interrupted turns. `branchSession` gains an inclusive `upToEntryIndex` cutoff that must land on a `turn_end` row. The frontend renders each `turn_end` as a divider (duration + BranchMenu) and drops the legacy tail Branch row.

**Tech Stack:** TypeScript ESM (NodeNext — local imports need `.js`), Fastify, better-sqlite3 (via existing Storage), vitest; Next.js 16 / React 19, Tailwind v4, shadcn/ui.

**Spec:** `docs/branch-from-history-design.md` — read it before starting; it records the decided trade-offs (no `turn_start`, no strict persistence, wall-clock durations only, lockstep remote upgrades).

## Global Constraints

- Backend local imports use `.js` extensions (NodeNext).
- Backend typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`; frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`.
- Backend tests: `pnpm --filter vibedeckx test -- <file>`; frontend tests: `pnpm --filter vibedeckx-ui test -- <file>`.
- `turn_end` durations are wall clock only — never use the CLI's `payload.duration_ms`.
- Old sessions (no `turn_end` entries) get no fallback rendering — do not add heuristics.
- Do not add retry/strict-persistence plumbing for `turn_end` — it shares `persistEntry`'s best-effort path by design.

---

### Task 1: `turn_end` type + `turnOpenSince` + `endActiveTurn` + success path

**Files:**
- Modify: `packages/vibedeckx/src/agent-types.ts:17-27`
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` (RunningSession ~78, sendUserMessage ~1400, wakeDormantSession ~1996, commitCompletion status flip ~1131, buildFullConversationContext ~1937)
- Test: `packages/vibedeckx/src/agent-session-manager.turn-end.test.ts` (new)

**Interfaces:**
- Consumes: existing `pushEntry(sessionId, message, broadcast)`; `TurnCompletionLedger` commit flow.
- Produces: `TurnOutcome` exported from `agent-types.ts`; `RunningSession.turnOpenSince: number | null`; `private endActiveTurn(session: RunningSession, outcome: Exclude<TurnOutcome, "server_restart">): Promise<void>`. Tasks 2–3 call/extend these.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/agent-session-manager.turn-end.test.ts`. Mirror the harness in `agent-session-manager.completion.test.ts` (fixture replay through `handleStdout`), with an `ops` log shared by `upsertEntry` and `updateStatus` so relative order is assertable:

```ts
import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import type { AgentSession, Storage } from "./storage/types.js";
import type { AgentMessage } from "./agent-types.js";

/**
 * turn_end lifecycle wiring: a completed turn writes exactly one turn_end
 * entry (wall-clock duration, outcome) BEFORE the status flips to stopped,
 * and the conversation-summary replay skips turn_end entries.
 */

const SESSION_ID = "s1";
const GRACE_MS = 40;

function fixture(name: string): string {
  return readFileSync(new URL(`./protocol/claude-code/__fixtures__/${name}`, import.meta.url), "utf-8");
}

function makeHarness() {
  const row: AgentSession = {
    id: SESSION_ID, project_id: "p1", branch: "main", status: "running",
    permission_mode: "edit", agent_type: "claude-code", title: "t",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_user_message_at: 1, last_completed_at: null,
  };
  const ops: string[] = [];
  const turnEnds: Array<AgentMessage & { type: "turn_end" }> = [];
  const storage = {
    agentSessions: {
      getAll: async () => [row],
      getEntries: async () => [
        { session_id: SESSION_ID, entry_index: 0, data: JSON.stringify({ type: "user", content: "go", timestamp: 1 }) },
      ],
      getById: async () => row,
      listByBranch: async () => [row],
      markCompleted: vi.fn(async () => undefined),
      updateStatus: vi.fn(async (_id: string, status: AgentSession["status"]) => { ops.push(`status:${status}`); row.status = status; }),
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      markUserMessage: vi.fn(async () => undefined),
      upsertEntry: vi.fn(async (_id: string, _idx: number, data: string) => {
        const msg = JSON.parse(data) as AgentMessage;
        ops.push(`entry:${msg.type}`);
        if (msg.type === "turn_end") turnEnds.push(msg);
      }),
      touchUpdatedAt: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
    },
    tasks: { completeIfAssigned: vi.fn(async () => undefined) },
  } as unknown as Storage;
  return { storage, ops, turnEnds };
}

async function liveSession(manager: AgentSessionManager, openSince: number | null) {
  await manager.restoreSessionsFromDb();
  const internals = manager as unknown as {
    sessions: Map<string, { dormant: boolean; status: string; turnOpenSince: number | null }>;
    handleStdout: (session: unknown, data: string) => Promise<void>;
    buildFullConversationContext: (entries: AgentMessage[]) => string | null;
  };
  const session = internals.sessions.get(SESSION_ID)!;
  session.dormant = false;
  session.status = "running";
  session.turnOpenSince = openSince;
  return { internals, session, feed: (d: string) => internals.handleStdout(session, d) };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("turn_end on turn completion", () => {
  it("writes exactly one turn_end (outcome=completed, wall-clock duration) before status:stopped", async () => {
    const { storage, ops, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const openSince = Date.now() - 5000;
    const { feed } = await liveSession(manager, openSince);

    await feed(fixture("stream-session.jsonl"));
    await settle(GRACE_MS * 5);

    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].outcome).toBe("completed");
    // Wall clock, and timestamp is the end bound of durationMs.
    expect(turnEnds[0].durationMs).toBe(turnEnds[0].timestamp - openSince);
    expect(turnEnds[0].durationMs!).toBeGreaterThanOrEqual(5000);
    // turn_end persisted before the stopped status write.
    expect(ops.indexOf("entry:turn_end")).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf("entry:turn_end")).toBeLessThan(ops.indexOf("status:stopped"));
    // The open turn is closed.
    const internals = manager as unknown as { sessions: Map<string, { turnOpenSince: number | null }> };
    expect(internals.sessions.get(SESSION_ID)!.turnOpenSince).toBeNull();
  });

  it("no-ops when no turn is open (turnOpenSince=null)", async () => {
    const { storage, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const { feed } = await liveSession(manager, null);
    await feed(fixture("stream-session.jsonl"));
    await settle(GRACE_MS * 5);
    expect(turnEnds).toHaveLength(0);
  });

  it("buildFullConversationContext skips turn_end entries", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const { internals } = await liveSession(manager, null);
    const ctx = internals.buildFullConversationContext([
      { type: "user", content: "hi", timestamp: 1 },
      { type: "turn_end", timestamp: 2, durationMs: 1, outcome: "completed" },
      { type: "assistant", content: "done", timestamp: 3 },
    ] as AgentMessage[]);
    expect(ctx).toContain("hi");
    expect(ctx).toContain("done");
    expect(ctx).not.toContain("turn_end");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.turn-end.test.ts`
Expected: FAIL — TS error `'turn_end'` not assignable / `turnOpenSince` missing, or `turnEnds` empty at runtime.

- [ ] **Step 3: Extend the shared type** (`agent-types.ts`)

```ts
export type TurnOutcome = "completed" | "failed" | "stopped" | "process_exit" | "server_restart";
```

and replace the `turn_end` variant in `AgentMessage`:

```ts
  | { type: 'turn_end'; timestamp: number; durationMs?: number; outcome?: TurnOutcome }
```

(Both fields optional — `chat-session-manager.ts`'s existing bare `turn_end` writes stay valid.)

- [ ] **Step 4: Add `turnOpenSince` to RunningSession and all constructor literals**

In the `RunningSession` interface (after `lastActiveAt`):

```ts
  /**
   * Wall-clock start of the currently open user turn, or null when no turn
   * is in flight. Set when a user message actually starts a turn (steering
   * messages don't reset it); cleared by endActiveTurn after the turn_end
   * entry is written. In-memory only — a crash mid-turn is repaired by
   * restoreSessionsFromDb (see repairInterruptedTurn).
   */
  turnOpenSince: number | null;
```

Add `turnOpenSince: null,` to every `RunningSession` object literal. Find them with `grep -n "completion: new TurnCompletionLedger()" packages/vibedeckx/src/agent-session-manager.ts` (createNewSession/spawn path, restoreSessionsFromDb, branchSession — add to each).

- [ ] **Step 5: Open the turn in sendUserMessage and wakeDormantSession**

In `sendUserMessage` (~line 1412), right after `session.process.stdin.write(formatted);` and before `return true;`:

```ts
      // A turn is now genuinely in flight. Steering messages (sent while a
      // turn is already open) must not reset the clock.
      if (session.turnOpenSince === null) session.turnOpenSince = Date.now();
```

In `wakeDormantSession` (~line 2001), right after the `await this.pushEntry(...)` of the user message (spawn already succeeded by then — a failed spawn throws before this point and must not leave a phantom open turn):

```ts
    session.turnOpenSince = Date.now();
```

- [ ] **Step 6: Add `endActiveTurn` and call it in commitCompletion**

Add next to `finalizeStreamingEntry`:

```ts
  /**
   * Close the open turn with a persisted turn_end stop-point entry.
   * turn_end entries are constructed ONLY here and in repairInterruptedTurn
   * (restore path). Wall clock only — see design doc for why the CLI's
   * payload.duration_ms is not used. Rides the normal best-effort entry
   * persistence on purpose (no strict path — design decision).
   */
  private async endActiveTurn(
    session: RunningSession,
    outcome: Exclude<TurnOutcome, "server_restart">,
  ): Promise<void> {
    if (session.turnOpenSince === null) return; // no turn in flight
    const endedAt = Date.now(); // single clock read: timestamp === end bound of durationMs
    const durationMs = endedAt - session.turnOpenSince;
    await this.pushEntry(session.id, { type: "turn_end", timestamp: endedAt, durationMs, outcome }, true);
    session.turnOpenSince = null; // cleared only after the write resolves
  }
```

Import `TurnOutcome` from `./agent-types.js`. In `commitCompletion`, immediately BEFORE the "Turn finished — process stays alive" status-flip block (~line 1131):

```ts
    // Stop point: persist the turn_end marker before the status flips, so
    // subscribers never see "stopped" without a tail Branch divider.
    await this.endActiveTurn(session, "completed");
```

- [ ] **Step 7: Make buildFullConversationContext explicitly skip turn_end**

In the `switch` (~line 1937), alongside the `system` case:

```ts
        case "turn_end":
          // UI stop-point marker, not conversation content.
          break;
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.turn-end.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Typecheck + full backend tests**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: clean; pre-existing suites (completion, branch, resident) still green.

- [ ] **Step 10: Commit**

```bash
git add packages/vibedeckx/src/agent-types.ts packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/agent-session-manager.turn-end.test.ts
git commit -m "feat: persist turn_end stop-point entry on turn completion"
```

---

### Task 2: turn_end on error result, user stop, and process exit

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` (error-result block ~1125, stopSession ~1528, process close handler ~673)
- Test: `packages/vibedeckx/src/agent-session-manager.turn-end.test.ts` (extend)

**Interfaces:**
- Consumes: `endActiveTurn(session, outcome)` from Task 1.
- Produces: nothing new — completes the four call sites listed in the design.

- [ ] **Step 1: Write the failing test (user stop)**

Append to the describe block in `agent-session-manager.turn-end.test.ts`:

```ts
  it("stopSession writes turn_end (outcome=stopped) after the system entry and before status:stopped", async () => {
    const { storage, ops, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    await liveSession(manager, Date.now() - 1000);

    await manager.stopSession(SESSION_ID);

    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].outcome).toBe("stopped");
    expect(ops.indexOf("entry:system")).toBeLessThan(ops.indexOf("entry:turn_end"));
    expect(ops.indexOf("entry:turn_end")).toBeLessThan(ops.indexOf("status:stopped"));
  });

  it("hibernateSession / switch paths write no turn_end (turnOpenSince already null)", async () => {
    const { storage, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    await liveSession(manager, null); // between turns
    await manager.stopSession(SESSION_ID); // any stop transition with no open turn
    expect(turnEnds).toHaveLength(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.turn-end.test.ts`
Expected: FAIL — first new test: `turnEnds` empty.

- [ ] **Step 3: Wire the three remaining call sites**

**stopSession** (~1555): after the "Session stopped by user." `pushEntry`, before `session.dormant = true;`:

```ts
      // Stop point: user interrupted the turn. Written after the visible
      // system note so the divider closes the turn's rendering.
      await this.endActiveTurn(session, "stopped");
```

**error-result block** (~1128, inside `if (event.subtype === "error")`): after `this.applyCompletionTimerAction(session, session.completion.errorResult());`, before the status-flip `if`:

```ts
          await this.endActiveTurn(session, "failed");
```

**process close handler** (~695): after the `if (action.kind === "commit") { ... }` block and before `session.status = code === 0 ? "stopped" : "error";`:

```ts
      // Stop point for a turn the process took down with it. If a held
      // completion just committed above, endActiveTurn already ran inside
      // commitCompletion and this is a no-op.
      await this.endActiveTurn(session, "process_exit");
```

Also in the same handler, make the startup-failure error entry awaited (design: content entries precede turn_end/status). Replace the fire-and-forget `this.pushEntry({type:"error",...}).catch(...)` (~714) with:

```ts
      if (code !== 0 && !spawnFailed && !session.producedOutput) {
        // Awaited so the error entry lands before the final status broadcast
        // (turn_end/status ordering guarantee). Persistence errors are still
        // swallowed inside persistEntry; this only fixes ordering.
        try {
          await this.pushEntry(session.id, {
            type: "error",
            message: this.buildStartupFailureMessage(session.agentType, stderrTail),
            timestamp: Date.now(),
          }, true);
        } catch (err) {
          console.error(`[AgentSession] Failed to push startup-failure entry for ${session.id}:`, err);
        }
      }
```

Note: the handler already runs inside `enqueueSessionWork(async () => ...)`, so `await` is legal. Move the `endActiveTurn("process_exit")` call to AFTER this error entry (content before marker): final order in the close handler is: commit block → startup-failure entry (if any) → `endActiveTurn` → status assignment/persist → broadcasts. The error-result and process-exit paths have no fixture-driven unit test (no recorded error stream); they are covered by the shared `endActiveTurn` tests, typecheck, and the live verification in Task 8.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.turn-end.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Full backend tests + typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/agent-session-manager.turn-end.test.ts
git commit -m "feat: write turn_end on error result, user stop, and process exit"
```

---

### Task 3: Restore-time repair for crash-interrupted turns

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` (restoreSessionsFromDb ~2071)
- Test: `packages/vibedeckx/src/agent-session-manager.restore-repair.test.ts` (new)

**Interfaces:**
- Consumes: `storage.agentSessions.getEntries/upsertEntry`; `rebuildStoreFromRows`.
- Produces: `private repairInterruptedTurn(sessionId, rows): Promise<rows>` — returns the (possibly extended) row list that `rebuildStoreFromRows` must consume.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import type { AgentSession, Storage } from "./storage/types.js";
import type { AgentMessage } from "./agent-types.js";

/**
 * Crash repair: a session whose DB status was still "running" and whose
 * entry tail is not a turn_end gets a server_restart turn_end appended at
 * restore. Status-stopped sessions (incl. pre-feature histories) and clean
 * tails are untouched; repair is idempotent across restarts.
 */

type Row = { session_id: string; entry_index: number; data: string };
const entry = (i: number, msg: object): Row => ({ session_id: "s1", entry_index: i, data: JSON.stringify(msg) });

function makeHarness(status: AgentSession["status"], rows: Row[]) {
  const row: AgentSession = {
    id: "s1", project_id: "p1", branch: "main", status,
    permission_mode: "edit", agent_type: "claude-code", title: "t",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_user_message_at: 1, last_completed_at: null,
  };
  const upserts: Array<{ index: number; msg: AgentMessage }> = [];
  const storage = {
    agentSessions: {
      getAll: async () => [row],
      getEntries: async () => [...rows],
      getById: async () => row,
      listByBranch: async () => [row],
      updateStatusPreservingTimestamp: vi.fn(async (_id: string, s: AgentSession["status"]) => { row.status = s; }),
      upsertEntry: vi.fn(async (_id: string, index: number, data: string) => {
        const msg = JSON.parse(data) as AgentMessage;
        upserts.push({ index, msg });
        rows.push(entry(index, msg)); // simulate persistence for a second restore
      }),
      touchUpdatedAt: vi.fn(async () => undefined),
    },
  } as unknown as Storage;
  return { storage, row, rows, upserts };
}

describe("restore-time turn repair", () => {
  it("appends a server_restart turn_end when DB status was running and the tail is mid-turn", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1 }),
      entry(1, { type: "tool_use", tool: "Bash", input: {}, timestamp: 2 }),
    ]);
    const manager = new AgentSessionManager(h.storage);
    await manager.restoreSessionsFromDb();

    const turnEnds = h.upserts.filter((u) => u.msg.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].index).toBe(2); // maxIndex + 1
    expect((turnEnds[0].msg as { outcome?: string }).outcome).toBe("server_restart");
    expect((turnEnds[0].msg as { durationMs?: number }).durationMs).toBeUndefined();
    // The rebuilt in-memory store includes the repair entry.
    const msgs = manager.getMessages("s1");
    expect(msgs[2]?.type).toBe("turn_end");
  });

  it("is idempotent: a second restore appends nothing", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1 }),
      entry(1, { type: "assistant", content: "half", timestamp: 2 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    await new AgentSessionManager(h.storage).restoreSessionsFromDb(); // fresh manager, same DB
    expect(h.upserts.filter((u) => u.msg.type === "turn_end")).toHaveLength(1);
  });

  it("leaves status-stopped marker-less (pre-feature) sessions untouched", async () => {
    const h = makeHarness("stopped", [
      entry(0, { type: "user", content: "old", timestamp: 1 }),
      entry(1, { type: "assistant", content: "old answer", timestamp: 2 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    expect(h.upserts).toHaveLength(0);
  });

  it("skips trailing system entries when checking the tail (hibernate note after turn_end)", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1 }),
      entry(1, { type: "turn_end", timestamp: 2, durationMs: 1, outcome: "completed" }),
      entry(2, { type: "system", content: "Agent process hibernated to free resident capacity. Send a message to wake it.", timestamp: 3 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    expect(h.upserts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.restore-repair.test.ts`
Expected: FAIL — no turn_end upsert happens yet.

- [ ] **Step 3: Implement `repairInterruptedTurn` and wire it into restore**

Add near `restoreSessionsFromDb`:

```ts
  /**
   * Crash repair (restore path): if the previous process died mid-turn, the
   * history has no closing turn_end — append one with outcome
   * "server_restart" and no duration (the crash time is unknown; the UI
   * shows "interrupted" instead of a fabricated number). Runs BEFORE
   * rebuildStoreFromRows so the store is built from the repaired rows.
   * The other constructor of turn_end entries is endActiveTurn (live paths).
   */
  private async repairInterruptedTurn(
    sessionId: string,
    rows: Array<{ session_id: string; entry_index: number; data: string }>,
  ): Promise<Array<{ session_id: string; entry_index: number; data: string }>> {
    // Scan past trailing system entries (e.g. the hibernate note lands after
    // the turn's turn_end).
    let landing: AgentMessage | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(rows[i].data) as AgentMessage;
        if (msg.type === "system") continue;
        landing = msg;
      } catch { /* unparsable row — treat as content, repair below */ }
      break;
    }
    if (landing === null || landing.type === "turn_end") return rows;

    const maxIndex = rows.reduce((m, r) => Math.max(m, r.entry_index), -1);
    const repair: AgentMessage = { type: "turn_end", timestamp: Date.now(), outcome: "server_restart" };
    const data = JSON.stringify(repair);
    await this.storage.agentSessions.upsertEntry(sessionId, maxIndex + 1, data);
    console.log(`[AgentSession] Repaired interrupted turn for ${sessionId} (server_restart turn_end at ${maxIndex + 1})`);
    return [...rows, { session_id: sessionId, entry_index: maxIndex + 1, data }];
  }
```

In `restoreSessionsFromDb`, replace:

```ts
      const entries = await this.storage.agentSessions.getEntries(dbSession.id);
      // Skip sessions with no entries (stale metadata)
      if (entries.length === 0) continue;

      const store = this.rebuildStoreFromRows(entries, dbSession.id);
```

with:

```ts
      let entries = await this.storage.agentSessions.getEntries(dbSession.id);
      // Skip sessions with no entries (stale metadata)
      if (entries.length === 0) continue;

      // Only sessions the crash left as "running" can hold an interrupted
      // turn. The gate also keeps pre-feature (marker-less, cleanly stopped)
      // histories untouched and makes repair idempotent — this run resets
      // the row to "stopped" below.
      if (dbSession.status === "running") {
        entries = await this.repairInterruptedTurn(dbSession.id, entries);
      }

      const store = this.rebuildStoreFromRows(entries, dbSession.id);
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.restore-repair.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Full backend tests + typecheck, commit**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`

```bash
git add packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/agent-session-manager.restore-repair.test.ts
git commit -m "feat: repair crash-interrupted turns with server_restart turn_end at restore"
```

---

### Task 4: `branchSession` cutoff + `BranchResult` union + route mapping

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` (branchSession ~2136)
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts` (performLocalBranch ~95, UI route ~1041, path route — grep `path/agent-sessions/:sessionId/branch`)
- Test: `packages/vibedeckx/src/agent-session-manager.branch.test.ts` (update + extend)
- Test: `packages/vibedeckx/src/routes/agent-session-branch-routes.test.ts` (update + extend)

**Interfaces:**
- Consumes: entry rows from `storage.agentSessions.getEntries`.
- Produces (exported from `agent-session-manager.ts`):

```ts
export type BranchResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "not-found" | "empty-history" | "invalid-cutoff" | "running-needs-cutoff" };
```

  `branchSession(sourceSessionId, agentTypeOverride?, opts?: { sessionId?; crossRemoteMcp?; upToEntryIndex?: number }): Promise<BranchResult>`. Task 5 and the frontend rely on route status codes: invalid-cutoff → 400, running-needs-cutoff → 409, not-found/empty-history → 404.

- [ ] **Step 1: Update existing tests to the new return shape, add cutoff tests**

In `agent-session-manager.branch.test.ts`, the existing assertion changes from `expect(newId).toBe(preSessionId)` to:

```ts
    expect(result).toEqual({ ok: true, sessionId: preSessionId });
    expect(manager.getSession(preSessionId)?.crossRemoteMcp).toEqual(crossRemoteMcp);
```

Extend the harness `getEntries` to return a turn-shaped history and add a describe block:

```ts
const HISTORY = [
  { session_id: SOURCE_ID, entry_index: 0, data: JSON.stringify({ type: "user", content: "hello", timestamp: 1 }) },
  { session_id: SOURCE_ID, entry_index: 1, data: JSON.stringify({ type: "assistant", content: "hi", timestamp: 2 }) },
  { session_id: SOURCE_ID, entry_index: 2, data: JSON.stringify({ type: "turn_end", timestamp: 3, durationMs: 2, outcome: "completed" }) },
  { session_id: SOURCE_ID, entry_index: 3, data: JSON.stringify({ type: "user", content: "more", timestamp: 4 }) },
  { session_id: SOURCE_ID, entry_index: 4, data: JSON.stringify({ type: "assistant", content: "again", timestamp: 5 }) },
  { session_id: SOURCE_ID, entry_index: 5, data: JSON.stringify({ type: "turn_end", timestamp: 6, durationMs: 2, outcome: "completed" }) },
];
```

(use `getEntries: async () => HISTORY` in the harness), then:

```ts
describe("branchSession cutoff", () => {
  it("copies exactly the prefix up to a turn_end cutoff", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b1", upToEntryIndex: 2 });
    expect(result).toEqual({ ok: true, sessionId: "b1" });
    const msgs = manager.getMessages("b1");
    expect(msgs.filter(Boolean)).toHaveLength(3);
    expect(msgs[2]?.type).toBe("turn_end");
    expect(msgs[3]).toBeUndefined();
  });

  it("rejects a cutoff that is not a turn_end entry", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b2", upToEntryIndex: 1 });
    expect(result).toEqual({ ok: false, reason: "invalid-cutoff" });
  });

  it("rejects a missing cutoff index", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b3", upToEntryIndex: 99 });
    expect(result).toEqual({ ok: false, reason: "invalid-cutoff" });
  });
});
```

And an in-memory-session block (harness via `restoreSessionsFromDb`, like the turn-end test) proving the running rules:

```ts
describe("branchSession while running", () => {
  async function runningManager() {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();
    const internals = manager as unknown as {
      sessions: Map<string, { status: string; dormant: boolean }>;
      finalizeStreamingEntry: (s: unknown) => Promise<void>;
    };
    const s = internals.sessions.get(SOURCE_ID)!;
    s.status = "running";
    s.dormant = false;
    return { manager, internals };
  }

  it("historical branch with cutoff works while running and never touches the source", async () => {
    const { manager, internals } = await runningManager();
    const finalizeSpy = vi.spyOn(internals as never, "finalizeStreamingEntry" as never);
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b4", upToEntryIndex: 2 });
    expect(result).toEqual({ ok: true, sessionId: "b4" });
    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  it("running without a cutoff is rejected (no half-turn copies)", async () => {
    const { manager } = await runningManager();
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b5" });
    expect(result).toEqual({ ok: false, reason: "running-needs-cutoff" });
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.branch.test.ts`
Expected: FAIL — TS: `branchSession` returns `string | null`, no `upToEntryIndex` opt.

- [ ] **Step 3: Rewrite `branchSession`**

Export `BranchResult` (shape above) from `agent-session-manager.ts`. Change the signature/body — the head becomes:

```ts
  async branchSession(
    sourceSessionId: string,
    agentTypeOverride?: AgentType,
    opts: { sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig; upToEntryIndex?: number } = {},
  ): Promise<BranchResult> {
    const source = this.sessions.get(sourceSessionId);
    const sourceRow = await this.storage.agentSessions.getById(sourceSessionId);
    if (!source && !sourceRow) return { ok: false, reason: "not-found" };
    // skipDb sessions have no persisted entries to copy
    if (source?.skipDb) return { ok: false, reason: "empty-history" };

    if (opts.upToEntryIndex === undefined) {
      // Legacy full-copy path (no-cutoff callers). Refused mid-turn so a
      // half-finished turn can never be copied; historical branches pass a
      // cutoff and are always allowed.
      if (source?.status === "running") return { ok: false, reason: "running-needs-cutoff" };
      // Flush any in-flight streaming assistant entry so the copy is complete
      if (source) await this.finalizeStreamingEntry(source);
    }

    let entryRows = await this.storage.agentSessions.getEntries(sourceSessionId);
    if (opts.upToEntryIndex !== undefined) {
      // The cutoff must be a stop point: every branched copy ends with a
      // turn_end so the new session has its own tail divider. With a cutoff
      // we read persisted rows only — never finalize the source's stream.
      const cut = entryRows.find((r) => r.entry_index === opts.upToEntryIndex);
      let cutType: string | null = null;
      if (cut) { try { cutType = (JSON.parse(cut.data) as AgentMessage).type; } catch { /* unparsable → invalid */ } }
      if (cutType !== "turn_end") return { ok: false, reason: "invalid-cutoff" };
      entryRows = entryRows.filter((r) => r.entry_index <= opts.upToEntryIndex!);
    }
    if (entryRows.length === 0) return { ok: false, reason: "empty-history" };
```

The rest of the body is unchanged except the final `return newId;` becomes `return { ok: true, sessionId: newId };` (and the two early `return null;` sites are covered above). Keep the existing title-fallback loop — it operates on the (now possibly truncated) `entryRows`.

- [ ] **Step 4: Adapt `performLocalBranch` and both routes**

`performLocalBranch` signature gains `upToEntryIndex` and maps reasons:

```ts
  async function performLocalBranch(
    sourceSessionId: string,
    userId: string | undefined,
    opts: { agentType?: string; sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig; upToEntryIndex?: number },
  ) {
    const sourceRow = await fastify.storage.agentSessions.getById(sourceSessionId);
    if (!sourceRow || !(await fastify.storage.projects.getById(sourceRow.project_id, userId))) {
      return { ok: false as const, code: 404, error: "Session not found" };
    }

    const result = await fastify.agentSessionManager.branchSession(
      sourceSessionId,
      opts.agentType as AgentType | undefined,
      { sessionId: opts.sessionId, crossRemoteMcp: opts.crossRemoteMcp, upToEntryIndex: opts.upToEntryIndex },
    );
    if (!result.ok) {
      if (result.reason === "invalid-cutoff") {
        return { ok: false as const, code: 400, error: "upToEntryIndex must reference a turn_end stop point" };
      }
      if (result.reason === "running-needs-cutoff") {
        return { ok: false as const, code: 409, error: "Session is running; branching requires a stop-point cutoff" };
      }
      return { ok: false as const, code: 404, error: "Session not found or has no history to branch" };
    }
    const newSessionId = result.sessionId;
    // ... existing payload assembly unchanged ...
```

Both routes (`/api/agent-sessions/:sessionId/branch` and `/api/path/agent-sessions/:sessionId/branch`) accept and validate the body field before calling `performLocalBranch`:

```ts
      const { agentType, upToEntryIndex } = (req.body || {}) as { agentType?: string; upToEntryIndex?: number };
      if (upToEntryIndex !== undefined && (!Number.isInteger(upToEntryIndex) || upToEntryIndex < 0)) {
        return reply.code(400).send({ error: "upToEntryIndex must be a non-negative integer" });
      }
```

(The remote-proxy arm of the UI route is Task 5; in this task just thread `upToEntryIndex` into the two `performLocalBranch` call sites.)

- [ ] **Step 5: Update route tests**

In `agent-session-branch-routes.test.ts`: `const branchSession = vi.fn(async () => ({ ok: true, sessionId: BRANCH_ID }));` — and add:

```ts
  it("threads upToEntryIndex to branchSession and maps invalid-cutoff to 400", async () => {
    const h = makeApp();
    app = h.app;
    await app.register(agentSessionRoutes);
    await app.ready();

    await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: { upToEntryIndex: 7 } });
    expect(h.branchSession.mock.calls[0][2].upToEntryIndex).toBe(7);

    h.branchSession.mockResolvedValueOnce({ ok: false, reason: "invalid-cutoff" });
    const bad = await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: { upToEntryIndex: 3 } });
    expect(bad.statusCode).toBe(400);

    h.branchSession.mockResolvedValueOnce({ ok: false, reason: "running-needs-cutoff" });
    const busy = await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: {} });
    expect(busy.statusCode).toBe(409);

    const nonInt = await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: { upToEntryIndex: -1 } });
    expect(nonInt.statusCode).toBe(400);
  });
```

Also update `agent-session-remote-branch-routes.test.ts`'s local mock: `branchSession = vi.fn(async () => ({ ok: true, sessionId: "new-local-id" }))`.

- [ ] **Step 6: Run tests, typecheck, commit**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.branch.test.ts src/routes/agent-session-branch-routes.test.ts src/routes/agent-session-remote-branch-routes.test.ts && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

```bash
git add packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/agent-session-manager.branch.test.ts packages/vibedeckx/src/routes/agent-session-routes.ts packages/vibedeckx/src/routes/agent-session-branch-routes.test.ts packages/vibedeckx/src/routes/agent-session-remote-branch-routes.test.ts
git commit -m "feat: branchSession stop-point cutoff with BranchResult union"
```

---

### Task 5: Remote proxy cutoff pass-through + old-remote overflow guard

**Files:**
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts` (remote arm of the UI branch route ~1048-1096)
- Test: `packages/vibedeckx/src/routes/agent-session-remote-branch-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `upToEntryIndex` parsed in Task 4; `proxyAuto` body already carrying `{ agentType, sessionId, crossRemoteMcp }`.
- Produces: proxied body gains `upToEntryIndex`; new 409 on cutoff overflow.

- [ ] **Step 1: Write the failing tests**

Append to `agent-session-remote-branch-routes.test.ts` (the `echoOk` helper already echoes the center-supplied id; give it a messages override):

```ts
  it("threads upToEntryIndex to the remote and accepts a compliant reply", async () => {
    proxyMock.mockImplementation(async (...args: unknown[]) => {
      const body = args[5] as { sessionId: string; upToEntryIndex?: number };
      expect(body.upToEntryIndex).toBe(2);
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [{}, {}, {}] } }; // 3 ≤ 2+1
    });
    const res = await app.inject({ method: "POST", url: `/api/agent-sessions/${SRC_SESSION_ID}/branch`, payload: { upToEntryIndex: 2 } });
    expect(res.statusCode).toBe(200);
  });

  it("fails closed with 409 and no registration when the remote ignored the cutoff", async () => {
    proxyMock.mockImplementation(async (...args: unknown[]) => {
      const body = args[5] as { sessionId: string };
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [{}, {}, {}, {}, {}] } }; // 5 > 2+1
    });
    const res = await app.inject({ method: "POST", url: `/api/agent-sessions/${SRC_SESSION_ID}/branch`, payload: { upToEntryIndex: 2 } });
    expect(res.statusCode).toBe(409);
    expect([...ctx.remoteSessionMap.keys()]).toEqual([SRC_SESSION_ID]);
    expect(ctx.upsert).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter vibedeckx test -- src/routes/agent-session-remote-branch-routes.test.ts`
Expected: FAIL — `body.upToEntryIndex` undefined; overflow case returns 200.

- [ ] **Step 3: Implement**

In the remote arm of the UI branch route, add `upToEntryIndex` to the proxied body:

```ts
          { agentType, sessionId: newRemoteSessionId, crossRemoteMcp, upToEntryIndex }
```

After the existing unexpected-session-id 409 check and before `fastify.remoteSessionMap.set(...)`:

```ts
        // Old-remote guard (post-hoc by design — lockstep upgrades assumed,
        // same pattern as the id check above): a remote that ignored the
        // cutoff copied the full history. Fail closed and don't register.
        if (upToEntryIndex !== undefined && remoteData.messages.length > upToEntryIndex + 1) {
          console.error(
            `[Branch] Remote ${remoteInfo.remoteServerId} ignored branch cutoff (${remoteData.messages.length} messages > cutoff ${upToEntryIndex}) — version drift, upgrade the remote`,
          );
          return reply.code(409).send({ error: "Remote ignored branch cutoff; upgrade the remote" });
        }
```

(`remoteData` needs `messages: unknown[]` in its cast — it already has it.)

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `pnpm --filter vibedeckx test -- src/routes/agent-session-remote-branch-routes.test.ts && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`

```bash
git add packages/vibedeckx/src/routes/agent-session-routes.ts packages/vibedeckx/src/routes/agent-session-remote-branch-routes.test.ts
git commit -m "feat: thread branch cutoff to remotes, fail closed on version drift"
```

---

### Task 6: Frontend foundation — types, `formatDuration`, API client, `BranchMenu` extraction

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-agent-session.ts:23-31`
- Modify: `apps/vibedeckx-ui/lib/api.ts:841-855`
- Create: `apps/vibedeckx-ui/lib/format-duration.ts`
- Create: `apps/vibedeckx-ui/components/agent/branch-menu.tsx`
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` (~809-872 replace inline dropdown with `<BranchMenu>`)
- Test: `apps/vibedeckx-ui/lib/format-duration.test.ts`

**Interfaces:**
- Produces:
  - `AgentMessage` union gains `| { type: "turn_end"; timestamp: number; durationMs?: number; outcome?: "completed" | "failed" | "stopped" | "process_exit" | "server_restart" }`
  - `formatDuration(ms: number): string`
  - `branchAgentSession(sessionId: string, agentType?: string, upToEntryIndex?: number)`
  - `BranchMenu` props: `{ agentType: AgentType; currentAgentName: string; alternateProviders: Array<{ type: AgentType; displayName: string }>; onBranch: (agentType?: AgentType) => void; disabled?: boolean; emphasis?: "normal" | "subtle" }`
- Task 7 consumes all four.

- [ ] **Step 1: Write the failing formatDuration test**

`apps/vibedeckx-ui/lib/format-duration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it("formats seconds", () => expect(formatDuration(9_000)).toBe("9s"));
  it("formats zero", () => expect(formatDuration(300)).toBe("0s"));
  it("formats minutes+seconds", () => expect(formatDuration(134_000)).toBe("2m 14s"));
  it("drops zero seconds", () => expect(formatDuration(120_000)).toBe("2m"));
  it("formats hours+minutes", () => expect(formatDuration(3_900_000)).toBe("1h 5m"));
  it("drops zero minutes", () => expect(formatDuration(7_200_000)).toBe("2h"));
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `pnpm --filter vibedeckx-ui test -- lib/format-duration.test.ts`

- [ ] **Step 3: Implement `lib/format-duration.ts`**

```ts
// Compact human duration for the turn_end divider: "9s", "2m 14s", "1h 5m".
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${h}h ${min}m` : `${h}h`;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter vibedeckx-ui test -- lib/format-duration.test.ts`

- [ ] **Step 5: Extend the frontend `AgentMessage` union**

In `hooks/use-agent-session.ts` append to the union (after `approval_request`):

```ts
  | { type: "turn_end"; timestamp: number; durationMs?: number; outcome?: "completed" | "failed" | "stopped" | "process_exit" | "server_restart" };
```

- [ ] **Step 6: Extend `branchAgentSession`**

In `lib/api.ts`, change signature and body line:

```ts
export async function branchAgentSession(
  sessionId: string,
  agentType?: string,
  upToEntryIndex?: number
): Promise<{ ... unchanged ... }> {
  ...
    body: JSON.stringify({ agentType, upToEntryIndex }),
  ...
```

(`JSON.stringify` drops `undefined` fields — legacy no-cutoff calls are unaffected.)

- [ ] **Step 7: Extract `BranchMenu`**

Create `components/agent/branch-menu.tsx` by moving the dropdown JSX from `agent-conversation.tsx` (~811-870) verbatim into a component — same imports (`DropdownMenu*`, `Button`, `Bot`, `Split`, `Loader2`, `cn`):

```tsx
"use client";

import { Bot, Loader2, Split } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AgentType } from "@/lib/api";

interface BranchMenuProps {
  agentType: AgentType;
  currentAgentName: string;
  alternateProviders: Array<{ type: AgentType; displayName: string }>;
  onBranch: (agentType?: AgentType) => void;
  disabled?: boolean;
  /** "subtle" = low-contrast historical divider; parent raises contrast via group-hover/group-focus-within. */
  emphasis?: "normal" | "subtle";
}

const agentDot = (type: AgentType) =>
  cn(
    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
    type === "codex" ? "bg-emerald-500/10 text-emerald-600" : "bg-violet-500/10 text-violet-600",
  );

export function BranchMenu({ agentType, currentAgentName, alternateProviders, onBranch, disabled, emphasis = "normal" }: BranchMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7 rounded-md transition-colors hover:bg-muted hover:text-foreground",
            emphasis === "subtle"
              ? "text-muted-foreground/50 group-hover:text-muted-foreground group-focus-within:text-muted-foreground"
              : "text-muted-foreground",
          )}
          disabled={disabled}
          aria-label="Branch conversation"
        >
          {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <Split className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 p-1.5">
        <DropdownMenuLabel className="px-2 py-1.5">
          <div className="text-xs font-medium">Branch conversation</div>
        </DropdownMenuLabel>
        <DropdownMenuItem className="h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs" onSelect={() => onBranch()}>
          <div className={agentDot(agentType)}><Bot className="h-3 w-3" /></div>
          <span className="min-w-0 flex-1 truncate">{currentAgentName}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">current</span>
        </DropdownMenuItem>
        {alternateProviders.length > 0 && (
          <>
            <DropdownMenuSeparator className="my-1" />
            {alternateProviders.map((p) => (
              <DropdownMenuItem key={p.type} className="h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs" onSelect={() => onBranch(p.type)}>
                <div className={agentDot(p.type)}><Bot className="h-3 w-3" /></div>
                <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

In `agent-conversation.tsx`, replace the inline `<DropdownMenu>...</DropdownMenu>` inside the legacy tail row block with:

```tsx
                    <BranchMenu
                      agentType={session?.agentType ?? agentType}
                      currentAgentName={currentAgentName}
                      alternateProviders={alternateBranchProviders}
                      onBranch={(t) => handleBranch(t)}
                      disabled={isBranching}
                    />
```

(The legacy row itself is removed in Task 7 — this step is a pure extraction so the diff stays reviewable. Remove now-unused imports from agent-conversation.tsx if lint flags them.)

- [ ] **Step 8: Typecheck + lint + commit**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../.. && pnpm --filter vibedeckx-ui lint && pnpm --filter vibedeckx-ui test -- lib/format-duration.test.ts`

```bash
git add apps/vibedeckx-ui/hooks/use-agent-session.ts apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/lib/format-duration.ts apps/vibedeckx-ui/lib/format-duration.test.ts apps/vibedeckx-ui/components/agent/branch-menu.tsx apps/vibedeckx-ui/components/agent/agent-conversation.tsx
git commit -m "refactor: extract BranchMenu; add turn_end type, formatDuration, cutoff API param"
```

---

### Task 7: `TurnEndDivider` rendering + wiring, remove legacy tail row

**Files:**
- Create: `apps/vibedeckx-ui/components/agent/turn-end-divider.tsx`
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` (messages.map ~788-797, handleBranch ~315, delete legacy tail row ~805-872)
- Modify: `apps/vibedeckx-ui/components/agent/agent-message.tsx` (switch ~65 — add `case "turn_end": return null;` as a safety net; the conversation map intercepts it first)
- Test: `apps/vibedeckx-ui/components/agent/turn-end-divider.test.tsx`

**Interfaces:**
- Consumes: `BranchMenu`, `formatDuration`, `branchAgentSession(sessionId, agentType?, upToEntryIndex?)`, `AgentMessage` `turn_end` variant (Task 6).
- Produces: `TurnEndDivider` props `{ durationMs?: number; outcome?: string; emphasis: "normal" | "subtle"; ...BranchMenu pass-through }`.

- [ ] **Step 1: Write the failing divider test**

`apps/vibedeckx-ui/components/agent/turn-end-divider.test.tsx` (mirror the `createRoot`/`act` pattern of `agent-message.agent-type.test.tsx`):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TurnEndDivider } from "./turn-end-divider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const baseProps = {
  agentType: "claude-code" as const,
  currentAgentName: "Claude Code",
  alternateProviders: [],
  onBranch: () => {},
  emphasis: "subtle" as const,
};

describe("TurnEndDivider", () => {
  it("shows the formatted duration and an always-rendered branch button", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TurnEndDivider {...baseProps} durationMs={134_000} outcome="completed" />);
    });
    expect(container.textContent).toContain("2m 14s");
    expect(container.querySelector('button[aria-label="Branch conversation"]')).not.toBeNull();
  });

  it('shows "interrupted" when durationMs is absent (server_restart)', async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TurnEndDivider {...baseProps} outcome="server_restart" />);
    });
    expect(container.textContent).toContain("interrupted");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/turn-end-divider.test.tsx`

- [ ] **Step 3: Implement `turn-end-divider.tsx`**

```tsx
"use client";

import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-duration";
import { BranchMenu } from "./branch-menu";
import type { AgentType } from "@/lib/api";

interface TurnEndDividerProps {
  durationMs?: number;
  outcome?: string;
  /** "normal" for the last stop point (discoverable tail affordance), "subtle" for history. */
  emphasis: "normal" | "subtle";
  agentType: AgentType;
  currentAgentName: string;
  alternateProviders: Array<{ type: AgentType; displayName: string }>;
  onBranch: (agentType?: AgentType) => void;
  disabled?: boolean;
}

/**
 * Stop-point divider rendered for each persisted turn_end entry:
 *   ─────────────────────────  2m 14s  [⑂]
 * The button is always rendered and interactive (no hover-only visibility —
 * touch devices and keyboard focus); "subtle" emphasis is raised via the
 * row's group-hover / group-focus-within.
 */
export function TurnEndDivider({
  durationMs, outcome, emphasis,
  agentType, currentAgentName, alternateProviders, onBranch, disabled,
}: TurnEndDividerProps) {
  const label = durationMs !== undefined ? formatDuration(durationMs) : outcome === "server_restart" ? "interrupted" : null;
  return (
    <div className="group flex items-center gap-2 py-0.5" data-turn-end>
      <div className="h-px flex-1 bg-border/60" />
      {label !== null && (
        <span
          className={cn(
            "shrink-0 text-[11px] tabular-nums transition-colors",
            emphasis === "subtle"
              ? "text-muted-foreground/50 group-hover:text-muted-foreground group-focus-within:text-muted-foreground"
              : "text-muted-foreground",
          )}
        >
          {label}
        </span>
      )}
      <BranchMenu
        agentType={agentType}
        currentAgentName={currentAgentName}
        alternateProviders={alternateProviders}
        onBranch={onBranch}
        disabled={disabled}
        emphasis={emphasis}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/turn-end-divider.test.tsx`

- [ ] **Step 5: Wire into agent-conversation.tsx**

1. `handleBranch` gains the cutoff (only the signature and API call change):

```ts
  const handleBranch = async (branchAgentType?: AgentType, upToEntryIndex?: number) => {
    ...
      await branchAgentSession(session.id, branchAgentType, upToEntryIndex);
    ...
```

2. Last stop point (above the `return`, near the other memos):

```ts
  const lastTurnEndIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.type === "turn_end") return i;
    }
    return -1;
  }, [messages]);
```

3. In `messages.map`, intercept `turn_end` before the generic wrapper:

```tsx
                  {messages.map((msg, index) =>
                    msg?.type === "turn_end" ? (
                      <TurnEndDivider
                        key={index}
                        durationMs={msg.durationMs}
                        outcome={msg.outcome}
                        emphasis={index === lastTurnEndIndex ? "normal" : "subtle"}
                        agentType={session?.agentType ?? agentType}
                        currentAgentName={currentAgentName}
                        alternateProviders={alternateBranchProviders}
                        onBranch={(t) => handleBranch(t, index)}
                        disabled={isBranching}
                      />
                    ) : (
                      <div
                        key={index}
                        data-message-idx={index}
                        {...(msg.type === "user" ? { "data-user-msg-idx": index } : {})}
                        className="scroll-mt-2"
                      >
                        <AgentMessageItem message={msg} messageIndex={index} />
                      </div>
                    )
                  )}
```

4. **Delete the legacy tail Branch row** — the whole `{session && status !== "running" && !isLoading && messages.length > 0 && (...)}` block (including the `<BranchMenu>` placed there in Task 6). Remove imports that become unused. Note: no `status !== "running"` gate anywhere — dividers stay interactive while the agent runs (design decision).

5. In `agent-message.tsx`, add to the switch:

```tsx
    case "turn_end":
      return null; // rendered by agent-conversation as TurnEndDivider
```

- [ ] **Step 6: Typecheck + lint + all frontend tests**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../.. && pnpm --filter vibedeckx-ui lint && pnpm --filter vibedeckx-ui test`
Expected: clean, all green.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/turn-end-divider.tsx apps/vibedeckx-ui/components/agent/turn-end-divider.test.tsx apps/vibedeckx-ui/components/agent/agent-conversation.tsx apps/vibedeckx-ui/components/agent/agent-message.tsx
git commit -m "feat: render turn_end stop-point dividers with branch-from-history"
```

---

### Task 8: End-to-end verification (live)

**Files:** none (verification only) — use the `verify` skill if available.

- [ ] **Step 1: Full suites + typechecks one more time**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test && cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../.. && pnpm --filter vibedeckx-ui test && pnpm --filter vibedeckx-ui lint`

- [ ] **Step 2: Live flow (headless backend works in sandbox)**

Start: `pnpm build:main && node packages/vibedeckx/dist/bin.js start --data-dir /tmp/vdx-turnend` (real `claude` binary exists in the sandbox). Note the dev-UI gotcha from memory: drive the UI via `/?project=<id>&tab=workspace&session=<sid>`, not `/p/:id/...`.

Verify, in order:
1. Run a short agent turn to completion → a divider with a plausible duration appears at the tail; DB check: `sqlite3 /tmp/vdx-turnend/data.sqlite "SELECT data FROM agent_session_entries ORDER BY entry_index DESC LIMIT 1"` shows `turn_end` with `outcome":"completed"`.
2. Send a second message → first divider remains (subtle), new turn runs; after it stops there are two dividers.
3. Branch from the FIRST divider → new "Branch - …" session contains only turn 1 + its `turn_end`; send a message there → wake replays truncated context.
4. Stop a turn mid-run with the Stop button → divider shows with a duration (`outcome":"stopped"`).
5. Kill the server mid-turn (`kill -9`), restart → the session shows an "interrupted" divider (`server_restart`), branchable.
6. While a turn is running, branch from a historical divider → succeeds; source session unaffected.

- [ ] **Step 3: Final commit if verification produced fixes**

```bash
git add -A && git commit -m "fix: adjustments from live verification of branch-from-history"
```

---

## Plan Self-Review Notes

- Spec coverage: type change (T1), turnOpenSince open/close + wall-clock + ordering (T1-T2), restore repair + status gate + idempotency (T3), cutoff + BranchResult + no-finalize + running rules + route codes (T4), remote pass-through + overflow 409 + log (T5), frontend types/API/BranchMenu/divider/legacy-row removal/no running gate/a11y emphasis (T6-T7), live verify incl. crash repair (T8). Adjacency-check note from spec: no code change required — `agent-message.tsx` answered-detection unaffected because `turn_end` never lands between an interactive `tool_use` and its answering user message except after a user Stop, where a new turn is the correct reading.
- Known accepted gaps (per spec): error-result and process-exit call sites have no fixture-driven unit test (no recorded error stream); covered by shared-helper tests + live step 4/5.
- Deviation from spec naming: the spec's `appendTurnEnd` indirection collapses — the repair path runs before the in-memory session exists, so it cannot share `pushEntry` plumbing. The invariant is kept as "turn_end entries are constructed only in `endActiveTurn` and `repairInterruptedTurn`", enforced by comments at both sites.
