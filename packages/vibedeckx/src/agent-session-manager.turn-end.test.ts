import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import { getProvider } from "./providers/index.js";
import type { AgentSession, NotificationOutboxEvent, Storage } from "./storage/types.js";
import type { AgentMessage } from "./agent-types.js";

type OutboxWrite = Omit<NotificationOutboxEvent, "seq">;
type TurnEndWrite = { sessionId: string; entryIndex: number; entryData: string; outbox?: OutboxWrite };

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

function makeHarness(agentType: "claude-code" | "codex" = "claude-code") {
  // status: "stopped" — liveSession() below uses restoreSessionsFromDb() purely
  // as a session-construction helper (then flips dormant/status/turnOpenSince
  // in memory to simulate a live process). A "running" DB row would instead
  // trip the restore-time crash-repair gate (agent-session-manager.restore-repair.test.ts),
  // which is unrelated to what these turn_end-on-live-paths tests exercise.
  const row: AgentSession = {
    id: SESSION_ID, project_id: "p1", branch: "main", status: "stopped",
    permission_mode: "edit", agent_type: agentType, title: "t",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_user_message_at: 1, last_completed_at: null,
  };
  const ops: string[] = [];
  const turnEnds: Array<AgentMessage & { type: "turn_end" }> = [];
  const userEntries: Array<AgentMessage & { type: "user" }> = [];
  const outbox: OutboxWrite[] = [];
  // Mirrors the real ON CONFLICT(id) DO NOTHING so "retrying the same turn-end
  // write creates no duplicate" is a genuine assertion, not a harness artifact.
  const outboxIds = new Set<string>();
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
        if (msg.type === "user") userEntries.push(msg);
        // turn_end must NOT arrive here any more — it goes through the atomic
        // turn-end/outbox operation below.
        if (msg.type === "turn_end") turnEnds.push(msg);
      }),
      upsertTurnEndWithOutbox: vi.fn(async (o: TurnEndWrite) => {
        const msg = JSON.parse(o.entryData) as AgentMessage;
        ops.push(`entry:${msg.type}`);
        if (msg.type === "turn_end") turnEnds.push(msg);
        if (o.outbox && !outboxIds.has(o.outbox.id)) {
          outboxIds.add(o.outbox.id);
          outbox.push(o.outbox);
        }
      }),
      touchUpdatedAt: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
    },
    tasks: { completeIfAssigned: vi.fn(async () => undefined) },
  } as unknown as Storage;
  return { storage, ops, turnEnds, userEntries, outbox };
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

/**
 * Codex first-turn race: the first sendUserMessage lands before the
 * thread/start response, so formatUserInput buffers the content and returns
 * an empty stdin payload. The send IS initiated (the provider flushes the
 * buffered turn/start itself once threadId arrives), so the turn must open
 * on the buffered send — otherwise turn/completed → result(success) →
 * endActiveTurn hits the turnOpenSince===null guard and the conversation
 * never gets its turn_end stop point (missing divider + Branch affordance).
 */
describe("codex buffered first turn", () => {
  type FakeProcess = { stdin: { write: (s: string) => boolean }; exitCode: null; pid: number };

  async function codexLiveSession(manager: AgentSessionManager) {
    const { internals, session } = await liveSession(manager, null);
    const writes: string[] = [];
    (session as unknown as { process: FakeProcess }).process = {
      stdin: { write: (s: string) => { writes.push(s); return true; } },
      exitCode: null, pid: 1234,
    };
    // Simulate spawn-time handshake: initialize + thread/start written to the
    // codex app-server, response not yet arrived (state: initialized, no threadId).
    const provider = getProvider("codex");
    provider.onSessionDestroyed?.(SESSION_ID);
    provider.onSessionCreated?.(SESSION_ID, "edit");
    const init = provider.getInitializationMessages!(SESSION_ID)!;
    const threadStartId = init.trim().split("\n").map((l) => JSON.parse(l) as { id: number; method: string })
      .find((m) => m.method === "thread/start")!.id;
    const feed = (obj: unknown) => internals.handleStdout(session, JSON.stringify(obj) + "\n");
    return { session, writes, threadStartId, feed };
  }

  it("opens the turn on a buffered send and writes turn_end when the flushed turn completes", async () => {
    const { storage, turnEnds } = makeHarness("codex");
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const { session, writes, threadStartId, feed } = await codexLiveSession(manager);

    const ok = await manager.sendUserMessage(SESSION_ID, "hello codex");
    expect(ok).toBe(true);
    expect(writes).toHaveLength(0); // buffered — nothing on stdin yet
    expect(session.turnOpenSince).not.toBeNull(); // buffered send still opens the turn

    // thread/start responds → provider flushes the buffered turn/start
    await feed({ jsonrpc: "2.0", id: threadStartId, result: { thread: { id: "th-1" } } });
    expect(writes.some((w) => w.includes("turn/start"))).toBe(true);

    await feed({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "th-1", turnId: "turn-1", item: { type: "agentMessage", text: "done" } } });
    await feed({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "th-1", turn: { id: "turn-1", status: "completed" } } });
    await settle(GRACE_MS * 5);

    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].outcome).toBe("completed");
    expect(session.turnOpenSince).toBeNull();
  });

  it("a second message inside the buffering window does not reset the turn start", async () => {
    const { storage } = makeHarness("codex");
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const { session } = await codexLiveSession(manager);

    await manager.sendUserMessage(SESSION_ID, "first");
    const openedAt = session.turnOpenSince;
    expect(openedAt).not.toBeNull();
    await settle(5);
    await manager.sendUserMessage(SESSION_ID, "second (steering)");
    expect(session.turnOpenSince).toBe(openedAt);
  });

  it("a synchronous stdin failure does not open a turn (no phantom turn_end)", async () => {
    const { storage, turnEnds } = makeHarness(); // claude-code: non-empty payload path
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const { session } = await liveSession(manager, null);
    (session as unknown as { process: FakeProcess }).process = {
      stdin: { write: () => { throw new Error("EPIPE"); } },
      exitCode: null, pid: 1234,
    };

    const ok = await manager.sendUserMessage(SESSION_ID, "hello");
    expect(ok).toBe(false);
    expect(session.turnOpenSince).toBeNull();

    await manager.stopSession(SESSION_ID);
    expect(turnEnds).toHaveLength(0);
  });
});

/**
 * Per-turn notification disposition. The decision of whether a turn's outcome
 * deserves a user-facing notification is made when the turn is *started* and
 * PERSISTED on the opening user entry — not held in process memory — because
 * crash repair and remote outbox generation must reach the same decision after
 * a restart. See docs/plans/2026-07-25-persistent-notification-milestones-design.md
 * §Per-turn Notification Intent.
 */
describe("notification disposition persistence", () => {
  type FakeProcess = { stdin: { write: (s: string) => boolean }; exitCode: null; pid: number };

  async function writableSession(manager: AgentSessionManager) {
    const { session } = await liveSession(manager, null);
    (session as unknown as { process: FakeProcess }).process = {
      stdin: { write: () => true }, exitCode: null, pid: 1234,
    };
    return session;
  }

  it("an ordinary user turn persists disposition=result", async () => {
    const { storage, userEntries } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    await writableSession(manager);
    await manager.sendUserMessage(SESSION_ID, "do the thing");
    expect(userEntries.at(-1)?.notificationDisposition).toBe("result");
  });

  it("a reviewer workflow prompt persists disposition=milestone-managed", async () => {
    const { storage, userEntries } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    await writableSession(manager);
    await manager.sendUserMessage(SESSION_ID, "review this", undefined, "local", {
      origin: "workflow",
      notificationDisposition: "milestone-managed",
    });
    expect(userEntries.at(-1)?.notificationDisposition).toBe("milestone-managed");
    expect(userEntries.at(-1)?.origin).toBe("workflow");
  });

  it("approved feedback sent to the source persists disposition=result", async () => {
    const { storage, userEntries } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    await writableSession(manager);
    await manager.sendUserMessage(SESSION_ID, "[Review Feedback] fix it", undefined, "local", {
      origin: "workflow",
      notificationDisposition: "result",
    });
    expect(userEntries.at(-1)?.notificationDisposition).toBe("result");
  });

  it("copies the opening turn's disposition onto its turn_end", async () => {
    const { storage, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    await writableSession(manager);
    await manager.sendUserMessage(SESSION_ID, "internal helper", undefined, "local", {
      origin: "workflow",
      notificationDisposition: "internal",
    });
    await manager.stopSession(SESSION_ID);
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].notificationDisposition).toBe("internal");
  });

  it("a steering message inside an open turn does not change the turn's disposition", async () => {
    const { storage, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    await writableSession(manager);
    await manager.sendUserMessage(SESSION_ID, "review this", undefined, "local", {
      origin: "workflow",
      notificationDisposition: "milestone-managed",
    });
    // Steering: a second send while the turn is already open.
    await manager.sendUserMessage(SESSION_ID, "also check tests");
    await manager.stopSession(SESSION_ID);
    expect(turnEnds[0].notificationDisposition).toBe("milestone-managed");
  });
});

/**
 * Deterministic session milestones. A `result` turn's terminal outcome writes
 * exactly one outbox row, in the same storage operation as its turn_end, keyed
 * on the REAL turn_end entry index so a retried write is absorbed by the
 * outbox's UNIQUE(id) instead of producing a second notification.
 */
describe("session result milestones", () => {
  type FakeProcess = { stdin: { write: (s: string) => boolean }; exitCode: null; pid: number };

  async function turnFrom(
    manager: AgentSessionManager,
    opts?: { origin?: "workflow"; notificationDisposition?: "result" | "internal" | "milestone-managed" },
  ) {
    const { session } = await liveSession(manager, null);
    (session as unknown as { process: FakeProcess }).process = {
      stdin: { write: () => true }, exitCode: null, pid: 1234,
    };
    await manager.sendUserMessage(SESSION_ID, "go", undefined, "local", opts);
    return session;
  }

  it("a completed result turn creates exactly one session_result_ready keyed on the turn_end index", async () => {
    const { storage, outbox, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const session = await turnFrom(manager);

    await (manager as unknown as {
      endActiveTurn: (s: unknown, o: string) => Promise<number | null>;
    }).endActiveTurn(session, "completed");

    expect(turnEnds).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    // Index 2: restore seeds entry 0 (user "go"), sendUserMessage adds 1, turn_end is 2.
    expect(outbox[0].id).toBe(`session:${SESSION_ID}:turn:2:result-ready`);
    expect(outbox[0].kind).toBe("session_result_ready");
    expect(outbox[0].session_id).toBe(SESSION_ID);
    expect(outbox[0].project_id).toBe("p1");
    expect(outbox[0].branch).toBe("main");
    expect(outbox[0].workflow_run_id).toBeNull();
    // The outbox stores semantic identity only — copy is the front's job.
    expect(outbox[0]).not.toHaveProperty("title");
    expect(outbox[0]).not.toHaveProperty("body");
  });

  it.each(["failed", "process_exit"] as const)(
    "a %s result turn creates one session_failed",
    async (outcome) => {
      const { storage, outbox } = makeHarness();
      const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
      const session = await turnFrom(manager);

      await (manager as unknown as {
        endActiveTurn: (s: unknown, o: string) => Promise<number | null>;
      }).endActiveTurn(session, outcome);

      expect(outbox).toHaveLength(1);
      expect(outbox[0].id).toBe(`session:${SESSION_ID}:turn:2:failed`);
      expect(outbox[0].kind).toBe("session_failed");
    },
  );

  it("a stopped result turn creates no milestone (user-initiated Stop never dings)", async () => {
    const { storage, outbox, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    await turnFrom(manager);
    await manager.stopSession(SESSION_ID);
    expect(turnEnds[0].outcome).toBe("stopped");
    expect(outbox).toHaveLength(0);
  });

  it.each(["internal", "milestone-managed"] as const)(
    "a completed %s turn creates no generic session milestone",
    async (disposition) => {
      const { storage, outbox, turnEnds } = makeHarness();
      const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
      const session = await turnFrom(manager, { origin: "workflow", notificationDisposition: disposition });

      await (manager as unknown as {
        endActiveTurn: (s: unknown, o: string) => Promise<number | null>;
      }).endActiveTurn(session, "completed");

      expect(turnEnds).toHaveLength(1);
      expect(outbox).toHaveLength(0);
    },
  );

  it("a failed milestone-managed turn creates no generic session milestone either", async () => {
    const { storage, outbox } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const session = await turnFrom(manager, { origin: "workflow", notificationDisposition: "milestone-managed" });

    await (manager as unknown as {
      endActiveTurn: (s: unknown, o: string) => Promise<number | null>;
    }).endActiveTurn(session, "failed");

    expect(outbox).toHaveLength(0);
  });

  it("re-writing the same turn end does not create a duplicate milestone", async () => {
    const { storage, outbox } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const session = await turnFrom(manager);
    const internals = manager as unknown as {
      endActiveTurn: (s: unknown, o: string) => Promise<number | null>;
      pushTurnEnd: (s: unknown, o: string, d: string, endedAt: number, dur?: number, index?: number) => Promise<number>;
    };

    await internals.endActiveTurn(session, "completed");
    // Replay the identical persistence step (same session + same turn_end
    // index): the deterministic id must collapse it.
    await internals.pushTurnEnd(session, "completed", "result", Date.now(), 1, 2);

    expect(outbox).toHaveLength(1);
  });

  it("legacy user entries with no persisted disposition default by origin", async () => {
    const { storage, outbox } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const { session } = await liveSession(manager, Date.now() - 10);
    const internals = manager as unknown as {
      sessions: Map<string, { store: { entries: AgentMessage[] } }>;
      endActiveTurn: (s: unknown, o: string) => Promise<number | null>;
    };
    const entries = internals.sessions.get(SESSION_ID)!.store.entries;

    // Entry 0 is a legacy ordinary user turn (no notificationDisposition
    // field at all) → treated as "result".
    expect(entries[0]).toMatchObject({ type: "user" });
    await internals.endActiveTurn(session, "completed");
    expect(outbox).toHaveLength(1);
    expect(outbox[0].kind).toBe("session_result_ready");
  });

  it("a legacy origin:workflow user entry with no disposition defaults to internal", async () => {
    const { storage, outbox } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const { session } = await liveSession(manager, Date.now() - 10);
    const internals = manager as unknown as {
      sessions: Map<string, { store: { entries: AgentMessage[] } }>;
      endActiveTurn: (s: unknown, o: string) => Promise<number | null>;
    };
    // Rewrite entry 0 as a pre-feature workflow turn (origin set, no disposition).
    internals.sessions.get(SESSION_ID)!.store.entries[0] = {
      type: "user", content: "old reviewer prompt", timestamp: 1, origin: "workflow",
    };

    await internals.endActiveTurn(session, "completed");
    expect(outbox).toHaveLength(0);
  });

  /**
   * The defect the milestone redesign exists to remove: `branch:activity`
   * describes a `projectId + branch`, so a second session completing on a branch
   * already sitting at `completed` was deduplicated away and never notified.
   * Milestones are keyed per session+turn, so each gets its own row.
   */
  it("two independent sessions on one branch each create their own milestone", async () => {
    const { storage, outbox } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const { session } = await liveSession(manager, null);
    const internals = manager as unknown as {
      sessions: Map<string, unknown>;
      endActiveTurn: (s: unknown, o: string) => Promise<number | null>;
    };

    // Session A completes.
    (session as unknown as { turnOpenSince: number | null; turnDisposition: string }).turnOpenSince = Date.now();
    (session as unknown as { turnDisposition: string }).turnDisposition = "result";
    await internals.endActiveTurn(session, "completed");

    // Session B: same project + branch, different session id.
    const sessionB = {
      ...(session as object),
      id: "s2",
      turnOpenSince: Date.now(),
      turnDisposition: "result",
      store: { entries: [], indexProvider: { next: () => 7 }, patches: [] },
      subscribers: new Set(),
    };
    await internals.endActiveTurn(sessionB, "completed");

    expect(outbox).toHaveLength(2);
    expect(outbox.map((e) => e.session_id).sort()).toEqual(["s1", "s2"]);
    // Distinct ids — nothing collapses them, unlike the old branch-keyed entry.
    expect(new Set(outbox.map((e) => e.id)).size).toBe(2);
  });

  it("a skipDb session produces no durable milestone", async () => {
    const { storage, outbox, turnEnds } = makeHarness();
    const manager = new AgentSessionManager(storage, { completionGraceMs: GRACE_MS });
    const { session } = await liveSession(manager, Date.now() - 10);
    (session as unknown as { skipDb: boolean }).skipDb = true;

    await (manager as unknown as {
      endActiveTurn: (s: unknown, o: string) => Promise<number | null>;
    }).endActiveTurn(session, "completed");

    // The in-memory turn boundary still exists for the UI, but nothing is
    // persisted — skipDb sessions are an explicit non-durable internal path,
    // not a silent promise of recovery.
    expect(turnEnds).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });
});
