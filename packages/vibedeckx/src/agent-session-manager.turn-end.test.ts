import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import type { AgentSession, Storage } from "./storage/types.js";
import type { AgentMessage } from "./agent-types.js";

/**
 * turn_end lifecycle wiring: a completed turn writes exactly one turn_end
 * entry (wall-clock duration, outcome) BEFORE the status flips to stopped,
 * and the conversation-summary replay skips turn_end entries.
 *
 * Fixture: in-turn-consumption.jsonl (not stream-session.jsonl — that
 * recording is a two-session concatenation used elsewhere only for schema
 * validation; one of its two background tasks (`bjpgos1hw`) never gets a
 * matching finish event, so the turn-completion ledger parks the result
 * forever and commitCompletion — hence endActiveTurn — never fires. Verified
 * with a throwaway probe: pendingTaskCount stays 1 through the whole replay).
 * in-turn-consumption.jsonl resolves its background task via an authoritative
 * `background_tasks_changed` snapshot and reaches a real commit, matching the
 * "single result, completes exactly once" case already exercised in
 * agent-session-manager.completion.test.ts.
 */

const SESSION_ID = "s1";
const GRACE_MS = 40;

function fixture(name: string): string {
  return readFileSync(new URL(`./protocol/claude-code/__fixtures__/${name}`, import.meta.url), "utf-8");
}

function makeHarness() {
  // status: "stopped" — liveSession() below uses restoreSessionsFromDb() purely
  // as a session-construction helper (then flips dormant/status/turnOpenSince
  // in memory to simulate a live process). A "running" DB row would instead
  // trip the restore-time crash-repair gate (agent-session-manager.restore-repair.test.ts),
  // which is unrelated to what these turn_end-on-live-paths tests exercise.
  const row: AgentSession = {
    id: SESSION_ID, project_id: "p1", branch: "main", status: "stopped",
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

    await feed(fixture("in-turn-consumption.jsonl"));
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
    await feed(fixture("in-turn-consumption.jsonl"));
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

  it("stop with no open turn writes no turn_end (turnOpenSince already null)", async () => {
    const { storage, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    await liveSession(manager, null); // between turns
    await manager.stopSession(SESSION_ID); // any stop transition with no open turn
    expect(turnEnds).toHaveLength(0);
  });
});
