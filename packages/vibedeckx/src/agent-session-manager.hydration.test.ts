import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager, SpawnSupersededError } from "./agent-session-manager.js";
import type { AgentSession, Storage } from "./storage/types.js";
import type { AgentMessage } from "./agent-types.js";

/**
 * Process-bound history hydration
 * (docs/plans/2026-09-05-session-history-lazy-hydration-b.md).
 *
 * A session's transcript lives in memory for exactly as long as it owns an
 * agent process. Boot loads metadata only; reads of a dormant session go to
 * storage; appends to a dormant session go straight to storage; and every
 * point where a process goes away drops the transcript again.
 *
 * The invariant these tests defend is not "memory is smaller" but "cold and
 * hot are indistinguishable to callers" — a cold session that quietly answers
 * "no history" would corrupt turn dispositions, retention decisions and
 * replayed context, all silently.
 */

// All processes in this suite are fixtures. Never signal the host machine.
beforeEach(() => {
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Row = { session_id: string; entry_index: number; data: string };

const row = (sessionId: string, index: number, msg: object): Row =>
  ({ session_id: sessionId, entry_index: index, data: JSON.stringify(msg) });

const HISTORY: Row[] = [
  row("s1", 0, { type: "user", content: "hello", timestamp: 1, notificationDisposition: "result" }),
  row("s1", 1, { type: "assistant", content: "hi", timestamp: 2 }),
  row("s1", 2, { type: "turn_end", timestamp: 3, durationMs: 2, outcome: "completed", notificationDisposition: "result" }),
];

interface HarnessOpts {
  status?: AgentSession["status"];
  rows?: Row[];
}

function makeHarness(opts: HarnessOpts = {}) {
  const rows: Row[] = [...(opts.rows ?? HISTORY)];
  const sessionRow: AgentSession = {
    id: "s1", project_id: "p1", branch: "main", status: opts.status ?? "stopped",
    permission_mode: "edit", agent_type: "claude-code", title: "t",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_user_message_at: 1, last_completed_at: null,
  };

  /** Lets a test hold `getEntries` open to construct a race. */
  let gate: { promise: Promise<void>; release: () => void } | null = null;

  /** `agentProcesses` settings read — the await inside ensureResidentCapacity. */
  const settingsGet = vi.fn(async (_key: string): Promise<string | undefined> => undefined);
  /** A ready checkout, so `resolveSessionWorktreePath` has a real await to gate. */
  const checkoutFixture = {
    workspace: {
      id: "w1", project_id: "p1", branch: "main", status: "ready", error: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    },
    checkout: {
      id: "c1", workspace_id: "w1", target_id: "local", worktree_path: "/tmp/p1",
      expected_branch: "main", status: "ready" as const, error: null, deleted_at: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    },
  };
  const getCheckoutById = vi.fn(async (_id: string) => checkoutFixture);

  /** switchMode's first persistence await, after it has hydrated. */
  const updatePermissionMode = vi.fn(async (_id: string, mode: "plan" | "edit") => {
    sessionRow.permission_mode = mode;
  });

  const getEntries = vi.fn(async (id: string) => {
    if (gate) await gate.promise;
    return rows.filter((r) => r.session_id === id).sort((a, b) => a.entry_index - b.entry_index);
  });

  const upsertEntry = vi.fn(async (id: string, index: number, data: string) => {
    const existing = rows.findIndex((r) => r.session_id === id && r.entry_index === index);
    if (existing >= 0) rows[existing] = { session_id: id, entry_index: index, data };
    else rows.push({ session_id: id, entry_index: index, data });
  });

  const storage = {
    agentSessions: {
      getAll: async () => [{ ...sessionRow }],
      getById: async () => sessionRow,
      getEntries,
      getEntryMetaAll: vi.fn(async () => {
        const byId = new Map<string, { cnt: number; max_index: number }>();
        for (const r of rows) {
          const cur = byId.get(r.session_id) ?? { cnt: 0, max_index: -1 };
          byId.set(r.session_id, {
            cnt: cur.cnt + 1,
            max_index: Math.max(cur.max_index, r.entry_index),
          });
        }
        return [...byId].map(([session_id, m]) => ({ session_id, ...m }));
      }),
      getEntriesBefore: vi.fn(async (id: string, before: number | null, limit: number) =>
        rows
          .filter((r) => r.session_id === id && (before === null || r.entry_index < before))
          .sort((a, b) => b.entry_index - a.entry_index)
          .slice(0, limit)),
      deleteEntries: vi.fn(async (id: string) => {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].session_id === id) rows.splice(i, 1);
      }),
      incrementHistoryEpoch: vi.fn(async () => 1),
      upsertEntry,
      upsertTurnEndWithOutbox: vi.fn(async (o: { sessionId: string; entryIndex: number; entryData: string }) => {
        await upsertEntry(o.sessionId, o.entryIndex, o.entryData);
      }),
      updateStatus: vi.fn(async (_id: string, s: AgentSession["status"]) => { sessionRow.status = s; }),
      updateStatusPreservingTimestamp: vi.fn(async (_id: string, s: AgentSession["status"]) => { sessionRow.status = s; }),
      updateAgentType: vi.fn(async () => undefined),
      updateModel: vi.fn(async () => undefined),
      updatePermissionMode,
      touchUpdatedAt: vi.fn(async () => undefined),
      markUserMessage: vi.fn(async () => undefined),
      markCompleted: vi.fn(async () => undefined),
      listByBranch: async () => [sessionRow],
      deleteIfEmpty: vi.fn(async () => true),
      deleteIfExpired: vi.fn(async () => true),
    },
    projects: { getById: async () => ({ id: "p1", name: "p", path: "/tmp/does-not-exist-p1" }) },
    settings: { get: settingsGet },
    workspaceRegistry: { getCheckoutById },
  } as unknown as Storage;

  return {
    storage,
    rows,
    sessionRow,
    getEntries,
    upsertEntry,
    getEntriesBefore: storage.agentSessions.getEntriesBefore as unknown as ReturnType<typeof vi.fn>,
    settingsGet,
    updatePermissionMode,
    getCheckoutById,
    checkoutFixture,
    /** Suspend the next `getEntries` calls until `release()` is called. */
    blockReads() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      gate = { promise, release };
      return () => { gate = null; release(); };
    },
  };
}

/** Internals a test needs to reach: `RunningSession` is not exported. */
function session(manager: AgentSessionManager, id = "s1") {
  return manager.getSession(id) as unknown as {
    hot: boolean;
    historyMeta: { entryCount: number; maxEntryIndex: number };
    clearGeneration: number;
    store: { entries: Array<AgentMessage | undefined>; patches: unknown[]; indexProvider: { current(): number } };
    workspaceCheckoutId: string | null;
    processStartsInFlight: number;
    dormant: boolean;
    status: string;
    process: unknown;
    turnOpenSince: number | null;
    subscribers: Set<unknown>;
  };
}

async function restored(opts: HarnessOpts = {}) {
  const h = makeHarness(opts);
  const manager = new AgentSessionManager(h.storage);
  await manager.restoreSessionsFromDb();
  return { ...h, manager };
}

describe("startup restores metadata, not transcripts", () => {
  it("reads no entry data for a cleanly-stopped session", async () => {
    const { manager, getEntries, getEntriesBefore } = await restored();

    expect(getEntries).not.toHaveBeenCalled();
    expect(getEntriesBefore).not.toHaveBeenCalled();
    const s = session(manager);
    expect(s.hot).toBe(false);
    expect(s.historyMeta).toEqual({ entryCount: 3, maxEntryIndex: 2 });
    expect(s.store.entries).toHaveLength(0);
    expect(s.store.patches).toHaveLength(0);
  });

  it("positions a cold session's index provider past the persisted tail", async () => {
    // Invariant B4: this is what lets a cold append allocate the right index
    // without reading anything.
    const { manager } = await restored();
    expect(session(manager).store.indexProvider.current()).toBe(3);
  });

  it("still skips sessions whose metadata says zero entries", async () => {
    const { manager } = await restored({ rows: [] });
    expect(manager.getSession("s1")).toBeNull();
  });
});

describe("crash repair walks back to the turn boundary", () => {
  it("does not repair a clean tail, and reads only the tail page to decide", async () => {
    const { manager, getEntriesBefore, upsertEntry } = await restored({ status: "running" });
    expect(upsertEntry).not.toHaveBeenCalled();
    expect(getEntriesBefore).toHaveBeenCalledTimes(1);
    expect(session(manager).historyMeta).toEqual({ entryCount: 3, maxEntryIndex: 2 });
  });

  it("advances the metadata by the repair entry it wrote", async () => {
    const rows = [
      row("s1", 0, { type: "user", content: "go", timestamp: 1 }),
      row("s1", 1, { type: "tool_use", tool: "Bash", input: {}, timestamp: 2 }),
    ];
    const { manager } = await restored({ status: "running", rows });
    expect(session(manager).historyMeta).toEqual({ entryCount: 3, maxEntryIndex: 2 });
    const messages = await manager.loadMessages("s1");
    expect(messages[2]?.type).toBe("turn_end");
  });

  it("finds an opener that lies beyond the first page, so an internal turn stays silent", async () => {
    // The regression this guards: a fixed tail window would miss the opening
    // user entry of a long tool-heavy turn, `resolveNotificationDisposition`
    // would fall through to "result", and an internal reviewer turn would
    // produce a spurious "session failed" notification.
    const rows: Row[] = [
      row("s1", 0, { type: "turn_end", timestamp: 1, outcome: "completed" }),
      row("s1", 1, { type: "user", content: "review this", timestamp: 2, origin: "workflow", notificationDisposition: "internal" }),
    ];
    for (let i = 2; i < 160; i++) rows.push(row("s1", i, { type: "tool_use", tool: "Bash", input: {}, timestamp: i }));

    const h = makeHarness({ status: "running", rows });
    const manager = new AgentSessionManager(h.storage);
    await manager.restoreSessionsFromDb();

    const written = h.rows.find((r) => r.entry_index === 160)!;
    const repair = JSON.parse(written.data) as AgentMessage & { notificationDisposition?: string };
    expect(repair.type).toBe("turn_end");
    expect(repair.notificationDisposition).toBe("internal");
    // More than one page: the walk did not stop at the first batch.
    expect(h.getEntriesBefore.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not invent a turn for a history of nothing but system entries", async () => {
    // Matches the old scan's `landingType === null` conclusion. Writing a
    // turn_end here would fabricate a turn and, with no opener to read a
    // disposition off, notify about its failure.
    const rows: Row[] = [];
    for (let i = 0; i < 80; i++) rows.push(row("s1", i, { type: "system", content: "note", timestamp: i }));
    const { manager, upsertEntry } = await restored({ status: "running", rows });
    expect(upsertEntry).not.toHaveBeenCalled();
    expect(session(manager).historyMeta).toEqual({ entryCount: 80, maxEntryIndex: 79 });
  });

  it("repairs a first-turn crash by walking off the front of the transcript", async () => {
    const rows = [
      row("s1", 0, { type: "user", content: "first ever", timestamp: 1, notificationDisposition: "internal" }),
      row("s1", 1, { type: "assistant", content: "half", timestamp: 2 }),
    ];
    const h = makeHarness({ status: "running", rows });
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    const repair = JSON.parse(h.rows.find((r) => r.entry_index === 2)!.data) as { notificationDisposition?: string };
    expect(repair.notificationDisposition).toBe("internal");
  });
});

describe("cold reads match hot reads", () => {
  it("loadMessages / loadRawMessages / window agree with the hydrated session", async () => {
    const { manager } = await restored();
    const coldDense = await manager.loadMessages("s1");
    const coldRaw = await manager.loadRawMessages("s1");
    const coldWindow = await manager.loadHistoryWindow("s1", { turns: 5 });
    const coldHead = await manager.loadHistoryHead("s1");

    await hydrate(manager);
    expect(session(manager).hot).toBe(true);

    expect(await manager.loadMessages("s1")).toEqual(coldDense);
    expect(await manager.loadRawMessages("s1")).toEqual(coldRaw);
    expect(await manager.loadHistoryWindow("s1", { turns: 5 })).toEqual(coldWindow);
    expect(await manager.loadHistoryHead("s1")).toEqual(coldHead);
  });

  it("the synchronous getters throw on a cold session instead of answering empty", async () => {
    const { manager } = await restored();
    expect(() => manager.getMessages("s1")).toThrow(/cold/);
    expect(() => manager.getRawMessages("s1")).toThrow(/cold/);
  });

  it("emptiness checks never touch storage", async () => {
    // Retention and the discard compensator ask this of every candidate; if
    // the question could hydrate, one sweep would undo the whole design.
    const { manager, getEntries } = await restored();
    expect(await manager.discardSessionIfEmpty("s1")).toBe(false);
    expect(await manager.deleteDormantSessionIfExpired("s1", Date.now())).toBe(true);
    expect(getEntries).not.toHaveBeenCalled();
  });

  it("a cold subscribe replays the same frames a hot one does", async () => {
    const { manager } = await restored();
    const coldFrames = await collectSubscribeFrames(manager);
    await hydrate(manager);
    const hotFrames = await collectSubscribeFrames(manager);
    expect(coldFrames).toEqual(hotFrames);
  });
});

describe("cold writes go straight to storage", () => {
  it("switchAgentType on a dormant session appends without hydrating", async () => {
    const { manager, getEntries, rows } = await restored();
    expect(await manager.switchAgentType("s1", "codex")).toBe("ok");

    expect(getEntries).not.toHaveBeenCalled();
    const s = session(manager);
    expect(s.hot).toBe(false);
    expect(s.historyMeta).toEqual({ entryCount: 4, maxEntryIndex: 3 });
    const appended = JSON.parse(rows.find((r) => r.entry_index === 3)!.data) as AgentMessage;
    expect(appended.type).toBe("system");
  });

  it("stopping an already-cold session works, twice, without hydrating", async () => {
    const { manager, getEntries, rows } = await restored();
    expect(await manager.stopSession("s1")).toBe(true);
    expect(await manager.stopSession("s1")).toBe(true);

    expect(getEntries).not.toHaveBeenCalled();
    expect(session(manager).hot).toBe(false);
    expect(session(manager).dormant).toBe(true);
    expect(session(manager).status).toBe("stopped");
    expect(rows.filter((r) => r.entry_index > 2)).toHaveLength(2);
  });

  it("a cold append leaves the next index free for the wake that follows it", async () => {
    const { manager } = await restored();
    await manager.switchAgentType("s1", "codex");
    await hydrate(manager);
    // Hydration rebuilt the store from storage, which now includes the note.
    const s = session(manager);
    expect(s.hot).toBe(true);
    expect(s.store.entries.filter(Boolean)).toHaveLength(4);
    expect(s.store.indexProvider.current()).toBe(4);
  });
});

describe("unload happens wherever the process does", () => {
  it("returns the session to cold with metadata matching what it dropped", async () => {
    const { manager } = await restored();
    await hydrate(manager);
    const before = session(manager).store.entries.filter(Boolean).length;

    unload(manager);

    const s = session(manager);
    expect(s.hot).toBe(false);
    expect(s.store.entries).toHaveLength(0);
    expect(s.historyMeta.entryCount).toBe(before);
    expect(s.historyMeta.maxEntryIndex).toBe(2);
  });

  it("refuses to unload a session that still has a process", async () => {
    const { manager } = await restored();
    await hydrate(manager);
    session(manager).process = { pid: 1 };
    unload(manager);
    expect(session(manager).hot).toBe(true);
  });

  it("re-hydration reproduces the store it unloaded", async () => {
    const { manager } = await restored();
    await hydrate(manager);
    const first = session(manager).store.entries.slice();
    const firstIndex = session(manager).store.indexProvider.current();

    unload(manager);
    await hydrate(manager);

    expect(session(manager).store.entries).toEqual(first);
    expect(session(manager).store.indexProvider.current()).toBe(firstIndex);
  });
});

describe("races with restart", () => {
  it("a wake whose hydration is overtaken by restart aborts instead of spawning", async () => {
    const { manager, storage, blockReads, getEntries } = await restored();
    const s = session(manager);
    const release = blockReads();

    const hydrating = hydrate(manager);
    // Let the hydration reach its (blocked) read, so the restart below really
    // does land mid-flight rather than before the read ever started.
    await Promise.resolve();
    expect(getEntries).toHaveBeenCalledTimes(1);
    // Restart runs its synchronous half — kill, bump generation, install the
    // empty shell — while the read above is suspended.
    s.clearGeneration += 1;
    s.hot = true;
    s.historyMeta = { entryCount: 0, maxEntryIndex: -1 };
    await storage.agentSessions.deleteEntries("s1");
    release();

    await expect(hydrating).rejects.toBeInstanceOf(SpawnSupersededError);
    // The assertion that matters is about the OPERATION, not about `hot`:
    // restart leaves `hot === true`, which is exactly why it cannot stand in
    // for "my wake is still valid".
    expect(s.hot).toBe(true);
    expect(s.store.entries.filter(Boolean)).toHaveLength(0);
  });

  it("a subscribe reading storage when restart lands replays no stale entries", async () => {
    const { manager, storage, blockReads } = await restored();
    const s = session(manager);
    const release = blockReads();
    const ws = fakeSocket();

    const subscribing = manager.subscribe("s1", ws as never, {});
    await Promise.resolve();

    s.clearGeneration += 1;
    s.hot = true;
    s.historyMeta = { entryCount: 0, maxEntryIndex: -1 };
    s.store.entries.length = 0;
    s.store.patches.length = 0;
    await storage.agentSessions.deleteEntries("s1");
    release();

    await subscribing;
    const addedIndices = ws.sent
      .flatMap((frame) => (frame as { JsonPatch?: Array<{ op: string; path: string }> }).JsonPatch ?? [])
      .filter((op) => op.op === "add" && /^\/entries\/\d+$/.test(op.path));
    expect(addedIndices).toHaveLength(0);
    // Two HistorySync frames: the discarded first pass and the retry.
    expect(ws.sent.filter((f) => "HistorySync" in (f as object))).toHaveLength(2);
  });

  it("a cold append and a hydration cannot lose each other", async () => {
    const { manager, blockReads, rows } = await restored();
    const release = blockReads();

    const hydrating = hydrate(manager);
    const appending = manager.switchAgentType("s1", "codex");
    release();
    await Promise.all([hydrating, appending]);

    // Whichever order the serial chain picked, nothing was dropped. The
    // failure this rules out is the hydration snapshot landing on top of an
    // append it never saw, leaving three entries in memory against four rows.
    // (switchAgentType unloads on the way out, so the session ends cold and
    // its metadata is the thing to check.)
    const s = session(manager);
    expect(s.hot).toBe(false);
    expect(s.historyMeta).toEqual({ entryCount: 4, maxEntryIndex: 3 });
    expect(rows.filter((r) => r.session_id === "s1")).toHaveLength(4);
  });
});

describe("a spawn owns its transcript from hydration to process", () => {
  // The window these two cover is the one B1 is stated over: between
  // `hydrateForSpawn` and the process actually attaching, the session is hot
  // with no process. Anything that unloads in that window, or any exit that
  // leaves it without a process, breaks the invariant in one of two
  // directions — a process with no transcript, or a transcript with no owner.

  it("keeps the transcript through an agent switch that lands mid-wake", async () => {
    const { manager, settingsGet } = await restored();
    const spawnedHot: boolean[] = [];
    const spawn = vi
      .spyOn(manager as never, "spawnAgent" as never)
      .mockImplementation((async (s: { hot: boolean; process: unknown }) => {
        spawnedHot.push(s.hot);
        s.process = { pid: 1, exitCode: null, stdin: { write: () => true } };
      }) as never);

    // Suspend inside ensureResidentCapacity: hydration has run, the process
    // has not been spawned yet.
    const gate = deferred();
    settingsGet.mockImplementation(async () => { await gate.promise; return undefined; });

    const sending = manager.sendUserMessage("s1", "hello", "/tmp/p1");
    await vi.waitFor(() => expect(settingsGet).toHaveBeenCalled());

    // Legal today: the session still reads as dormant/stopped, so the switch
    // is not refused as busy.
    expect(await manager.switchAgentType("s1", "codex")).toBe("ok");
    gate.resolve();
    await sending;

    expect(spawn).toHaveBeenCalledTimes(1);
    // A spawned process with an empty store cannot replay context, and its
    // first stdout entry would throw in stageEntry.
    expect(spawnedHot).toEqual([true]);
  });

  it("keeps the transcript through an agent switch that lands mid-mode-switch", async () => {
    // Same defect as the wake case on the other spawn path: switchMode kills
    // the old process up front, so between its hydration and its respawn the
    // session also reads as process-less and not-yet-running.
    const { manager, updatePermissionMode } = await restored();
    const spawnedHot: boolean[] = [];
    vi.spyOn(manager as never, "spawnAgent" as never)
      .mockImplementation((async (s: { hot: boolean; process: unknown }) => {
        spawnedHot.push(s.hot);
        s.process = { pid: 1, exitCode: null, stdin: { write: () => true } };
      }) as never);

    const gate = deferred();
    updatePermissionMode.mockImplementation(async () => { await gate.promise; });

    const switching = manager.switchMode("s1", "/tmp/p1", "plan");
    await vi.waitFor(() => expect(updatePermissionMode).toHaveBeenCalled());

    expect(await manager.switchAgentType("s1", "codex")).toBe("ok");
    gate.resolve();
    expect(await switching).toBe(true);

    expect(spawnedHot).toEqual([true]);
  });

  it("claims the session before resolving its checkout, so retention cannot delete it mid-resolution", async () => {
    // `processStartsInFlight` is only a guard if it is taken before the
    // operation's FIRST await — its own contract says so. Resolving the
    // checkout first leaves a window in which retention can run to completion:
    // it deletes the row, drops the map entry and clears its own flag, after
    // which the claim succeeds on a detached session and the switch spawns a
    // process for a session that no longer exists.
    const { manager, getCheckoutById, checkoutFixture } = await restored();
    session(manager).workspaceCheckoutId = "c1";

    const spawnedFor: string[] = [];
    vi.spyOn(manager as never, "spawnAgent" as never)
      .mockImplementation((async (x: { id: string; process: unknown }) => {
        spawnedFor.push(x.id);
        x.process = { pid: 1, exitCode: null, stdin: { write: () => true } };
      }) as never);

    const gate = deferred();
    getCheckoutById.mockImplementation(async () => { await gate.promise; return checkoutFixture; });

    const switching = manager.switchMode("s1", "/tmp/p1", "plan");
    await vi.waitFor(() => expect(getCheckoutById).toHaveBeenCalled());

    expect(await manager.deleteDormantSessionIfExpired("s1", Date.now())).toBe(false);
    expect(manager.getSession("s1")).not.toBeNull();

    gate.resolve();
    expect(await switching).toBe(true);
    expect(spawnedFor).toEqual(["s1"]);
    expect(session(manager).processStartsInFlight).toBe(0);
  });

  it("releases the transcript when the wake is rejected for resident capacity", async () => {
    const { manager, settingsGet, getEntries } = await restored();
    settingsGet.mockImplementation(async () => JSON.stringify({ maxResidentAgentProcesses: 1 }));

    // A neighbour in the same scope that is alive and mid-turn, so it is not
    // an eviction candidate and capacity is genuinely exhausted.
    const internals = manager as unknown as { sessions: Map<string, unknown> };
    internals.sessions.set("s2", {
      ...(session(manager) as unknown as object),
      id: "s2",
      process: { pid: 2, exitCode: null },
      dormant: false,
      status: "running",
    });

    await expect(manager.sendUserMessage("s1", "hello", "/tmp/p1")).rejects.toThrow(/resident/i);

    // The wake loaded the transcript and then never got a process. Leaving it
    // resident would make every rejected send a permanent leak.
    expect(getEntries).toHaveBeenCalled();
    const s = session(manager);
    expect(s.process).toBeNull();
    expect(s.hot).toBe(false);
    expect(s.store.entries).toHaveLength(0);
    expect(s.historyMeta).toEqual({ entryCount: 3, maxEntryIndex: 2 });
  });
});

describe("subscribe and disconnect", () => {
  it("drops a client that closes while its history is being read", async () => {
    const { manager, blockReads } = await restored();
    const release = blockReads();
    const ws = fakeSocket();

    const subscribing = manager.subscribe("s1", ws as never, {});
    await Promise.resolve();
    ws.readyState = 3; // CLOSED
    release();

    expect(await subscribing).toBeNull();
    expect(session(manager).subscribers.size).toBe(0);
    // Only the frames sent before the read; nothing was pushed at a dead socket.
    expect(ws.sent.some((f) => "Ready" in (f as object))).toBe(false);
  });

  it("refuses a socket that is already closed", async () => {
    const { manager, getEntries } = await restored();
    const ws = fakeSocket();
    ws.readyState = 3;
    expect(await manager.subscribe("s1", ws as never, {})).toBeNull();
    expect(getEntries).not.toHaveBeenCalled();
  });
});

describe("hydration stats", () => {
  it("counts resident sessions and resident entries", async () => {
    const { manager } = await restored();
    expect(manager.hydrationStats()).toEqual({ total: 1, hot: 0, cold: 1, hot_entries: 0 });
    await hydrate(manager);
    expect(manager.hydrationStats()).toEqual({ total: 1, hot: 1, cold: 0, hot_entries: 3 });
  });
});

describe("unloading cannot strand the session's serial work queue", () => {
  // The Stop button runs off the event chain, and it nulls `process` before
  // it unloads. A stdout chunk already queued on the chain therefore resumes
  // against a session that went cold underneath it, and its append takes the
  // cold branch — which serializes on the same chain the append is running
  // on. Enqueuing there waits for the caller, wedging the chain forever: the
  // session can then never be hydrated, so it can never be woken again.

  it("lets queued work finish appending when Stop lands mid-flight", async () => {
    const { manager, rows } = await restored();
    const s = session(manager);
    await hydrate(manager);
    s.process = { pid: 1, exitCode: null, stdin: { write: () => true } };
    s.dormant = false;
    s.status = "running";

    const internals = manager as unknown as {
      enqueueSessionWork(s: unknown, w: () => Promise<void>, label: string): void;
      pushEntry(id: string, m: AgentMessage, b?: boolean): Promise<number>;
    };

    // A stdout handler suspended on its storage write when Stop arrives.
    const suspended = deferred();
    let appended: number | undefined;
    const queued = new Promise<void>((resolveQueued) => {
      internals.enqueueSessionWork(s, async () => {
        await suspended.promise;
        appended = await internals.pushEntry("s1", {
          type: "system", content: "late stdout", timestamp: 9,
        });
        resolveQueued();
      }, "test-stdout");
    });

    expect(await manager.stopSession("s1")).toBe(true);
    suspended.resolve();

    await expectSettled(queued, "queued append after Stop");
    // Persisted at the index a hot append would have used, not dropped.
    expect(appended).toBeGreaterThanOrEqual(0);
    expect(rows.some((r) => r.entry_index === appended && r.data.includes("late stdout"))).toBe(true);
    // Still in the store: Stop's unload waited for the chain to drain rather
    // than yanking the transcript out from under work already running on it.
    expect(s.store.entries[appended!]).toBeDefined();

    // ...and once the chain does drain, the unload it deferred still happens.
    await expectSettled(
      new Promise<void>((done) => internals.enqueueSessionWork(s, async () => done(), "drain")),
      "chain drain",
    );
    expect(s.hot).toBe(false);
  });

  it("lets work that lands behind the unload append on the cold path", async () => {
    // The other half. Deferring the unload only protects work that was
    // ALREADY in flight; a chunk the dying process flushed can still queue
    // behind it and run against a session that is by then cold. Its append
    // therefore takes the cold path from inside the chain — which is only
    // survivable because cold appends have their own queue.
    const { manager, rows } = await restored();
    const s = session(manager);
    await hydrate(manager);
    s.process = { pid: 1, exitCode: null, stdin: { write: () => true } };
    s.dormant = false;
    s.status = "running";

    const internals = manager as unknown as {
      enqueueSessionWork(s: unknown, w: () => Promise<void>, label: string): void;
      pushEntry(id: string, m: AgentMessage, b?: boolean): Promise<number>;
    };

    const suspended = deferred();
    internals.enqueueSessionWork(s, () => suspended.promise, "test-stdout");
    await manager.stopSession("s1");

    // Queued after Stop, so it sits behind the deferred unload.
    let appended: number | undefined;
    const trailing = new Promise<void>((resolveTrailing) => {
      internals.enqueueSessionWork(s, async () => {
        appended = await internals.pushEntry("s1", {
          type: "system", content: "trailing stdout", timestamp: 10,
        });
        resolveTrailing();
      }, "test-stdout-late");
    });
    suspended.resolve();

    await expectSettled(trailing, "append behind the unload");
    expect(s.hot).toBe(false);
    expect(rows.some((r) => r.entry_index === appended && r.data.includes("trailing stdout"))).toBe(true);
  });

  it("can still wake the session afterwards", async () => {
    const { manager } = await restored();
    const s = session(manager);
    await hydrate(manager);
    s.process = { pid: 1, exitCode: null, stdin: { write: () => true } };
    s.dormant = false;
    s.status = "running";

    const internals = manager as unknown as {
      enqueueSessionWork(s: unknown, w: () => Promise<void>, label: string): void;
      pushEntry(id: string, m: AgentMessage, b?: boolean): Promise<number>;
    };
    const suspended = deferred();
    internals.enqueueSessionWork(s, async () => {
      await suspended.promise;
      await internals.pushEntry("s1", { type: "system", content: "late", timestamp: 9 });
    }, "test-stdout");

    await manager.stopSession("s1");
    suspended.resolve();

    // Hydration serializes on the same chain, so a wedged chain shows up here
    // as a session that can never be loaded again.
    await expectSettled(hydrate(manager), "hydrate after Stop");
    expect(session(manager).hot).toBe(true);
  });
});

// ---------- helpers ----------

/**
 * Fail with a named message instead of hanging until vitest's global timeout,
 * so a wedged serial chain reports as a test failure that says which await
 * never settled.
 */
async function expectSettled<T>(work: Promise<T>, what: string, ms = 1000): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} never settled within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function hydrate(manager: AgentSessionManager, id = "s1"): Promise<void> {
  const internals = manager as unknown as {
    hydrateForSpawn(s: unknown): Promise<void>;
    sessions: Map<string, unknown>;
  };
  return internals.hydrateForSpawn(internals.sessions.get(id));
}

function unload(manager: AgentSessionManager, id = "s1"): void {
  const internals = manager as unknown as {
    unloadHistory(s: unknown, reason: string): void;
    sessions: Map<string, unknown>;
  };
  internals.unloadHistory(internals.sessions.get(id), "test");
}

function fakeSocket() {
  const sent: unknown[] = [];
  return {
    readyState: 1,
    sent,
    send(payload: string) {
      if (this.readyState !== 1) throw new Error("send on a closed socket");
      sent.push(JSON.parse(payload));
    },
  };
}

async function collectSubscribeFrames(manager: AgentSessionManager): Promise<unknown[]> {
  const ws = fakeSocket();
  const unsubscribe = await manager.subscribe("s1", ws as never, {});
  unsubscribe?.();
  return ws.sent;
}
