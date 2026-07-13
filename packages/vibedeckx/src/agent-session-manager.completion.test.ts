import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import { EventBus, type GlobalEvent } from "./event-bus.js";
import { getProvider } from "./providers/index.js";
import type { CodexProvider } from "./providers/codex-provider.js";
import type { AgentSession, Storage } from "./storage/types.js";

/**
 * Wiring tests for turn-completion: replay real Claude Code stream-json
 * recordings (protocol/claude-code/__fixtures__) through the manager's
 * stdout path and assert the completion side effects fire exactly once,
 * on the final result of the turn.
 *
 * The state-machine decisions live in turn-completion.test.ts; these tests
 * prove the manager wires them to the real side effects (markCompleted,
 * session:taskCompleted, branch:activity, completeIfAssigned, status)
 * without double-firing across the async event pipeline and grace timer.
 */

const SESSION_ID = "s1";
const GRACE_MS = 40;

function fixture(name: string): string {
  return readFileSync(new URL(`./protocol/claude-code/__fixtures__/${name}`, import.meta.url), "utf-8");
}

function makeHarness(agentType: string = "claude-code") {
  const row: AgentSession = {
    id: SESSION_ID,
    project_id: "p1",
    branch: "main",
    status: "running",
    permission_mode: "edit",
    agent_type: agentType,
    title: "already titled",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_user_message_at: 1,
    last_completed_at: null,
  };

  const markCompleted = vi.fn(async (_id: string, ts: number) => {
    row.last_completed_at = ts;
  });
  const updateStatus = vi.fn(async (_id: string, status: AgentSession["status"]) => {
    row.status = status;
  });
  const completeIfAssigned = vi.fn(async () => undefined);

  const storage = {
    agentSessions: {
      getAll: async () => [row],
      getEntries: async () => [
        { session_id: SESSION_ID, entry_index: 0, data: JSON.stringify({ type: "user", content: "go", timestamp: 1 }) },
      ],
      getById: async () => row,
      listByBranch: async () => [row],
      markCompleted,
      updateStatus,
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      markUserMessage: vi.fn(async (_id: string, ts: number) => {
        row.last_user_message_at = ts;
      }),
      upsertEntry: vi.fn(async () => undefined),
      touchUpdatedAt: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
    },
    tasks: { completeIfAssigned },
  } as unknown as Storage;

  return { storage, row, markCompleted, updateStatus, completeIfAssigned };
}

/** Restore the fixture session into memory and put it in live-turn state. */
async function liveSession(manager: AgentSessionManager) {
  await manager.restoreSessionsFromDb();
  // Reach into internals: these tests exercise the stdout pipeline without a
  // real child process, which the public API can't do.
  const internals = manager as unknown as {
    sessions: Map<string, { dormant: boolean; status: string }>;
    handleStdout: (session: unknown, data: string) => Promise<void>;
  };
  const session = internals.sessions.get(SESSION_ID)!;
  session.dormant = false;
  session.status = "running";
  return { session, feed: (data: string) => internals.handleStdout(session, data) };
}

async function settle(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("agent-session-manager turn completion wiring", () => {
  it("race recording (two fast subagents, 3 results) completes exactly once", async () => {
    const { storage, markCompleted, updateStatus, completeIfAssigned } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const bus = new EventBus();
    const events: GlobalEvent[] = [];
    bus.subscribe((e) => events.push(e));
    manager.setEventBus(bus);

    const { feed } = await liveSession(manager);
    await feed(fixture("race-two-fast-subagents.jsonl"));
    await settle(GRACE_MS * 5);

    expect(markCompleted).toHaveBeenCalledTimes(1);
    expect(completeIfAssigned).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "session:taskCompleted")).toHaveLength(1);
    expect(events.filter((e) => e.type === "branch:activity" && e.activity === "completed")).toHaveLength(1);
    expect(updateStatus.mock.calls.filter(([, s]) => s === "stopped")).toHaveLength(1);
  });

  it("race recording carries the final result's payload in taskCompleted", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const bus = new EventBus();
    const events: GlobalEvent[] = [];
    bus.subscribe((e) => events.push(e));
    manager.setEventBus(bus);

    const lines = fixture("race-two-fast-subagents.jsonl").split("\n").filter((l) => l.trim());
    const results = lines.map((l) => JSON.parse(l)).filter((m) => m.type === "result");
    const finalResult = results[results.length - 1];

    const { feed } = await liveSession(manager);
    await feed(lines.join("\n") + "\n");
    await settle(GRACE_MS * 5);

    const completed = events.find((e) => e.type === "session:taskCompleted");
    expect(completed).toBeDefined();
    expect((completed as { duration_ms?: number }).duration_ms).toBe(finalResult.duration_ms);
  });

  it("in-turn consumption recording (single result) completes exactly once", async () => {
    const { storage, markCompleted, completeIfAssigned } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const bus = new EventBus();
    const events: GlobalEvent[] = [];
    bus.subscribe((e) => events.push(e));
    manager.setEventBus(bus);

    const { feed } = await liveSession(manager);
    await feed(fixture("in-turn-consumption.jsonl"));
    await settle(GRACE_MS * 5);

    expect(markCompleted).toHaveBeenCalledTimes(1);
    expect(completeIfAssigned).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "session:taskCompleted")).toHaveLength(1);
  });

  it("nested-restart recording (task_id restart, 3 results) completes exactly once", async () => {
    const { storage, markCompleted } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const bus = new EventBus();
    const events: GlobalEvent[] = [];
    bus.subscribe((e) => events.push(e));
    manager.setEventBus(bus);

    const { feed } = await liveSession(manager);
    await feed(fixture("nested-restart.jsonl"));
    await settle(GRACE_MS * 5);

    expect(markCompleted).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "session:taskCompleted")).toHaveLength(1);
  });

  it("codex fire-and-forget subagent: no completion while it runs, exactly one after it finishes", async () => {
    // Real codex 0.144.3 recording: the main thread's turn/completed arrives
    // while the collab subagent (a sibling thread in the same stdout) is
    // still running, and codex never auto-resumes the main thread. Split the
    // replay at the main turn/completed: phase 1 must complete NOTHING (the
    // result stays parked on the live subagent), phase 2 (subagent finishes)
    // must commit exactly once.
    const lines = fixture("../../codex/__fixtures__/subagent-session.jsonl").split("\n").filter((l) => l.trim());
    const mainThreadId = "019f5c02-2087-7023-b186-9c3b8595cf26";
    const mainTurnDone = lines.findIndex((l) => {
      const m = JSON.parse(l);
      return m.method === "turn/completed" && m.params?.threadId === mainThreadId;
    });
    expect(mainTurnDone).toBeGreaterThan(0);
    const phase1 = lines.slice(0, mainTurnDone + 1);
    const phase2 = lines.slice(mainTurnDone + 1);

    const { storage, markCompleted, completeIfAssigned, row } = makeHarness("codex");
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const bus = new EventBus();
    const events: GlobalEvent[] = [];
    bus.subscribe((e) => events.push(e));
    manager.setEventBus(bus);

    // The fixture's thread/start response can't seed the provider (fresh
    // state has no pending rpc id) — set the main threadId directly.
    (getProvider("codex") as CodexProvider).getSessionState(SESSION_ID).threadId = mainThreadId;
    try {
      const { feed } = await liveSession(manager);

      await feed(phase1.join("\n") + "\n");
      await settle(GRACE_MS * 5);
      expect(markCompleted).toHaveBeenCalledTimes(0); // parked: subagent still running
      expect(row.status).toBe("running");

      await feed(phase2.join("\n") + "\n");
      await settle(GRACE_MS * 5);
      expect(markCompleted).toHaveBeenCalledTimes(1);
      expect(completeIfAssigned).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === "session:taskCompleted")).toHaveLength(1);
      expect(row.status).toBe("stopped");
    } finally {
      getProvider("codex").onSessionDestroyed?.(SESSION_ID);
    }
  });

  it("a plain turn with no background tasks completes with zero grace delay", async () => {
    const { storage, markCompleted } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: 60_000 });
    manager.setEventBus(new EventBus());

    const { feed } = await liveSession(manager);
    const line = JSON.stringify({ type: "result", subtype: "success", duration_ms: 5, cost_usd: 0.001 });
    await feed(line + "\n");

    // Committed synchronously within the stdout pipeline — a 60s grace would
    // time the test out if the no-background fast path regressed.
    expect(markCompleted).toHaveBeenCalledTimes(1);
  });
});
