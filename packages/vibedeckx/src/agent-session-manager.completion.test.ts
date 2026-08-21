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
  // status: "stopped" — liveSession() below uses restoreSessionsFromDb() purely
  // as a session-construction helper (then flips dormant/status/turnOpenSince
  // in memory to simulate a live process). A "running" DB row would instead
  // trip the restore-time crash-repair gate (agent-session-manager.restore-repair.test.ts),
  // which is unrelated to what these completion-wiring tests exercise.
  const row: AgentSession = {
    id: SESSION_ID,
    project_id: "p1",
    branch: "main",
    status: "stopped",
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
      setNativeSessionId: vi.fn(async () => undefined),
      upsertEntry: vi.fn(async () => undefined),
      deleteEntries: vi.fn(async () => undefined),
      incrementHistoryEpoch: vi.fn(async () => 1),
      updateAgentType: vi.fn(async () => undefined),
      touchUpdatedAt: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
    },
    tasks: { completeIfAssigned },
    // Restart consults the resident-process cap on its way to respawn.
    settings: { get: async () => null },
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

/** Raw WS frames a subscriber would receive, in order. */
function attachSubscriber(manager: AgentSessionManager): string[] {
  const internals = manager as unknown as { sessions: Map<string, { subscribers: Set<unknown> }> };
  const frames: string[] = [];
  internals.sessions.get(SESSION_ID)!.subscribers.add({ send: (raw: string) => frames.push(raw) });
  return frames;
}

function backgroundFrames(frames: string[]): Array<{ tasks: unknown[]; turnParked: boolean }> {
  return frames
    .map((raw) => JSON.parse(raw) as { backgroundTasks?: { tasks: unknown[]; turnParked: boolean } })
    .flatMap((msg) => (msg.backgroundTasks ? [msg.backgroundTasks] : []));
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
      // Simulate the live-turn DB state (the harness seeds "stopped" to stay
      // clear of the restore-time crash-repair gate); the assertions below
      // check phase 1 does NOT write "stopped" and phase 2 does.
      row.status = "running";

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

  // Killing the process kills its background tasks with it, but subscribers
  // keep their socket across a Stop — so the empty snapshot is the only thing
  // that stops the bar from counting up dead tasks forever.
  it("a Stop with a live background task tells subscribers the tasks are gone", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: 60_000 });
    manager.setEventBus(new EventBus());

    const { feed } = await liveSession(manager);
    const frames = attachSubscriber(manager);
    await feed([
      JSON.stringify({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "b1", task_type: "local_bash", description: "long build" }],
      }),
      JSON.stringify({ type: "result", subtype: "success", duration_ms: 5 }),
    ].join("\n") + "\n");

    // The turn is parked: the agent answered, the task is what holds it open.
    const parked = backgroundFrames(frames).at(-1);
    expect(parked).toEqual({
      tasks: [{ taskId: "b1", taskType: "local_bash", description: "long build", startedAt: expect.any(Number) }],
      turnParked: true,
    });

    await manager.stopSession(SESSION_ID);
    expect(backgroundFrames(frames).at(-1)).toEqual({ tasks: [], turnParked: false });
  });

  // Restart kills the process, then does five awaits before spawnAgent's own
  // reset. A grace timer armed for the killed turn firing inside that window
  // would commit a turn whose history is about to be wiped — and the bar would
  // keep listing tasks that died with the process.
  it("a restart clears the ledger before its first await, not at respawn", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: 60_000 });
    manager.setEventBus(new EventBus());

    const { feed } = await liveSession(manager);
    const frames = attachSubscriber(manager);
    await feed([
      JSON.stringify({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "b1", task_type: "local_bash", description: "long build" }],
      }),
      JSON.stringify({ type: "result", subtype: "success", duration_ms: 5 }),
    ].join("\n") + "\n");
    expect(backgroundFrames(frames).at(-1)!.turnParked).toBe(true);

    // Sample the ledger from inside the FIRST await of the restart. If the
    // reset moved back to spawnAgent, this observes the still-parked turn.
    const internals = manager as unknown as {
      sessions: Map<string, { completion: { hasPendingCompletion: boolean; pendingTaskCount: number } }>;
      spawnAgent: (session: unknown, cwd: string) => Promise<void>;
    };
    let atFirstAwait: { parked: boolean; tasks: number } | null = null;
    vi.mocked(storage.agentSessions.deleteEntries).mockImplementation(async () => {
      const ledger = internals.sessions.get(SESSION_ID)!.completion;
      atFirstAwait = { parked: ledger.hasPendingCompletion, tasks: ledger.pendingTaskCount };
    });
    internals.spawnAgent = async () => undefined;

    await manager.restartSession(SESSION_ID, "/tmp/p1");

    expect(atFirstAwait).toEqual({ parked: false, tasks: 0 });
    expect(backgroundFrames(frames).at(-1)).toEqual({ tasks: [], turnParked: false });
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
