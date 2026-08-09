import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import type { AgentSession, Storage } from "./storage/types.js";

/**
 * Retention's delete path inside the manager
 * (docs/plans/2026-08-08-session-retention.md §1.4 / §1.5).
 *
 * The two races this covers are both about a session that looks dormant:
 *  - a wake that has started but not yet spawned, and
 *  - a delete whose conditional DELETE is still in flight.
 * Each side plants its marker synchronously before its own first `await`, so
 * neither can act while the other is mid-flight. The tests drive both by
 * suspending the exact await in question.
 */

const CUTOFF = Date.now() - 90 * 86_400_000;
const PROJECT_PATH = "/tmp/project";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Harness {
  manager: AgentSessionManager;
  storage: Storage;
  deleteIfExpired: ReturnType<typeof vi.fn>;
  /**
   * Gates workspaceRegistry.getCheckoutById — the first await inside both a
   * wake and a restart. One shared gate for every call.
   */
  gateCheckoutLookup: () => { release: () => void };
  /**
   * Per-call gates, so two overlapping operations can be settled
   * independently. Each getCheckoutById call awaits its own entry in the
   * returned array, in call order.
   */
  gateEachCheckoutLookup: () => Array<{ resolve: () => void; reject: () => void }>;
  getCheckoutById: ReturnType<typeof vi.fn>;
  sent: string[];
}

async function makeHarness(): Promise<Harness> {
  const row: AgentSession = {
    id: "s1", project_id: "p1", branch: "dev", status: "stopped",
    permission_mode: "edit", agent_type: "claude-code", title: "t",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_user_message_at: 1, last_completed_at: null,
    workspace_checkout_id: "co1",
  } as AgentSession;

  const checkout = {
    checkout: { id: "co1", worktree_path: PROJECT_PATH, deleted_at: null, status: "ready", target_id: "local" },
    workspace: { id: "w1", project_id: "p1", branch: "dev" },
  };

  let checkoutGate: { promise: Promise<void>; resolve: () => void } | null = null;
  let perCallGates: Array<{ promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void }> | null = null;
  const deleteIfExpired = vi.fn(async () => true);
  const sent: string[] = [];

  const getCheckoutById = vi.fn(async () => {
    if (perCallGates) {
      const gate = deferred<void>();
      perCallGates.push(gate);
      await gate.promise;
    }
    if (checkoutGate) await checkoutGate.promise;
    return checkout;
  });

  const storage = {
    agentSessions: {
      getAll: async () => [row],
      getById: async () => row,
      getEntries: async () => [
        { entry_index: 0, data: JSON.stringify({ type: "user", content: "hi", timestamp: 1 }) },
        { entry_index: 1, data: JSON.stringify({ type: "turn_end", timestamp: 2 }) },
      ],
      listByBranch: async () => [row],
      updateStatus: vi.fn(async () => undefined),
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      touchUpdatedAt: vi.fn(async () => undefined),
      markUserMessage: vi.fn(async () => undefined),
      upsertEntry: vi.fn(async () => undefined),
      upsertTurnEndWithOutbox: vi.fn(async () => undefined),
      deleteIfExpired,
      delete: vi.fn(async () => undefined),
      getActivityById: async () => undefined,
      listRecentActivityByProject: async () => [],
    },
    workspaceRegistry: { getCheckoutById },
    projects: { getById: async () => ({ id: "p1", name: "p", path: PROJECT_PATH }) },
    turnSnapshots: { create: vi.fn(async () => undefined), getStartBoundary: async () => undefined },
  } as unknown as Storage;

  const manager = new AgentSessionManager(storage);
  await manager.restoreSessionsFromDb();

  return {
    manager, storage, deleteIfExpired, sent, getCheckoutById,
    gateCheckoutLookup: () => {
      const gate = deferred<void>();
      checkoutGate = { promise: gate.promise, resolve: gate.resolve };
      return { release: () => { checkoutGate = null; gate.resolve(); } };
    },
    gateEachCheckoutLookup: () => {
      perCallGates = [];
      return perCallGates as unknown as Array<{ resolve: () => void; reject: () => void }>;
    },
  };
}

/** Minimal WebSocket stand-in so broadcasts are observable. */
function fakeSocket(frames: string[]) {
  return { send: (data: string) => frames.push(data) } as unknown as import("ws").WebSocket;
}

describe("retention delete path", () => {
  it("deletes a dormant session and tells its subscribers it is finished", async () => {
    const h = await makeHarness();
    const frames: string[] = [];
    h.manager.subscribe("s1", fakeSocket(frames));

    expect(await h.manager.deleteDormantSessionIfExpired("s1", CUTOFF)).toBe(true);
    expect(h.deleteIfExpired).toHaveBeenCalledWith("s1", CUTOFF);
    expect(h.manager.getSession("s1")).toBeNull();
    expect(frames.some((f) => JSON.parse(f).finished === true)).toBe(true);
  });

  it("never stops anything — the old stop-first delete is not reused", async () => {
    const h = await makeHarness();
    const stopSpy = vi.spyOn(h.manager, "stopSession");
    await h.manager.deleteDormantSessionIfExpired("s1", CUTOFF);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("skips a session that has a live process", async () => {
    const h = await makeHarness();
    // Resident session: the LRU will hibernate it eventually, and a later
    // sweep can take it then. Retention must not touch it now.
    h.manager.getSession("s1")!.process = { exitCode: null } as never;
    expect(await h.manager.deleteDormantSessionIfExpired("s1", CUTOFF)).toBe(false);
    expect(h.deleteIfExpired).not.toHaveBeenCalled();
  });

  it("does nothing at all when the conditional DELETE misses", async () => {
    const h = await makeHarness();
    const frames: string[] = [];
    h.manager.subscribe("s1", fakeSocket(frames));
    h.deleteIfExpired.mockResolvedValueOnce(false);

    expect(await h.manager.deleteDormantSessionIfExpired("s1", CUTOFF)).toBe(false);
    // Rescued in the meantime: still in memory, subscribers not disturbed.
    expect(h.manager.getSession("s1")).not.toBeNull();
    expect(frames.some((f) => JSON.parse(f).finished === true)).toBe(false);
  });

  it("still deletes the row for a session that is not in memory", async () => {
    const h = await makeHarness();
    expect(await h.manager.deleteDormantSessionIfExpired("never-restored", CUTOFF)).toBe(true);
    expect(h.deleteIfExpired).toHaveBeenCalledWith("never-restored", CUTOFF);
  });
});

describe("wake / retention race", () => {
  it("an in-flight wake blocks a sweep that arrives mid-wake", async () => {
    const h = await makeHarness();
    const gate = h.gateCheckoutLookup();

    // Wake starts and suspends on its first await, still process-less and
    // still status "stopped" — exactly the state a naive sweep would delete.
    const wake = h.manager.sendUserMessage("s1", "hello", PROJECT_PATH);
    await Promise.resolve();
    expect(h.manager.getSession("s1")!.processStartsInFlight).toBeGreaterThan(0);

    expect(await h.manager.deleteDormantSessionIfExpired("s1", CUTOFF)).toBe(false);
    expect(h.deleteIfExpired).not.toHaveBeenCalled();
    expect(h.manager.getSession("s1")).not.toBeNull();

    gate.release();
    await wake.catch(() => undefined); // spawn is out of scope here
    expect(h.manager.getSession("s1")!.processStartsInFlight).toBe(0);
  });

  it("retentionDeleting blocks a wake that arrives mid-delete", async () => {
    const h = await makeHarness();
    const deleteGate = deferred<boolean>();
    h.deleteIfExpired.mockReturnValueOnce(deleteGate.promise);

    // Delete has passed its re-check and is awaiting the conditional DELETE.
    // The session is still in the map, so sendUserMessage can reach it.
    const deleting = h.manager.deleteDormantSessionIfExpired("s1", CUTOFF);
    await Promise.resolve();

    expect(await h.manager.sendUserMessage("s1", "hello", PROJECT_PATH)).toBe(false);
    // Nothing was spawned and no wake bookkeeping happened.
    expect(h.manager.getSession("s1")!.process).toBeNull();

    deleteGate.resolve(true);
    expect(await deleting).toBe(true);
    expect(h.manager.getSession("s1")).toBeNull();
  });

  it("releases the claim when the DELETE misses, so wake works again", async () => {
    const h = await makeHarness();
    const deleteGate = deferred<boolean>();
    h.deleteIfExpired.mockReturnValueOnce(deleteGate.promise);

    const deleting = h.manager.deleteDormantSessionIfExpired("s1", CUTOFF);
    await Promise.resolve();
    expect(await h.manager.sendUserMessage("s1", "hello", PROJECT_PATH)).toBe(false);

    deleteGate.resolve(false);
    expect(await deleting).toBe(false);

    // The claim is gone: a wake is accepted again (it will fail later on the
    // spawn, which this harness does not provide — reaching the checkout
    // lookup is proof enough that it was not refused up front).
    const gate = h.gateCheckoutLookup();
    const wake = h.manager.sendUserMessage("s1", "hello", PROJECT_PATH);
    await Promise.resolve();
    expect(h.manager.getSession("s1")!.processStartsInFlight).toBeGreaterThan(0);
    gate.release();
    await wake.catch(() => undefined);
  });

  it("releases the claim when the DELETE throws", async () => {
    const h = await makeHarness();
    h.deleteIfExpired.mockRejectedValueOnce(new Error("database is locked"));
    await expect(h.manager.deleteDormantSessionIfExpired("s1", CUTOFF)).rejects.toThrow("database is locked");

    const gate = h.gateCheckoutLookup();
    const wake = h.manager.sendUserMessage("s1", "hello", PROJECT_PATH);
    await Promise.resolve();
    expect(h.manager.getSession("s1")!.processStartsInFlight).toBeGreaterThan(0);
    gate.release();
    await wake.catch(() => undefined);
  });

  it("keeps the guard up while a SECOND overlapping wake is still in flight", async () => {
    // `dormant` is only cleared after the checkout lookup, so two messages
    // arriving together both enter the wake path. With a boolean guard the
    // first to settle would clear it out from under the second and hand
    // retention a session that is still on its way to spawning.
    const h = await makeHarness();
    const gates = h.gateEachCheckoutLookup();

    const first = h.manager.sendUserMessage("s1", "one", PROJECT_PATH);
    const second = h.manager.sendUserMessage("s1", "two", PROJECT_PATH);
    await Promise.resolve();
    expect(gates).toHaveLength(2);
    expect(h.manager.getSession("s1")!.processStartsInFlight).toBe(2);

    // Settle only the first. (Failing it keeps the test off the real spawn
    // path; success and failure run the same release in `finally`.)
    gates[0].reject();
    await first.catch(() => undefined);

    expect(h.manager.getSession("s1")!.processStartsInFlight).toBe(1);
    expect(await h.manager.deleteDormantSessionIfExpired("s1", CUTOFF)).toBe(false);
    expect(h.deleteIfExpired).not.toHaveBeenCalled();

    gates[1].reject();
    await second.catch(() => undefined);
    expect(h.manager.getSession("s1")!.processStartsInFlight).toBe(0);
  });
});

describe("restart / retention race", () => {
  it("an in-flight restart blocks a sweep", async () => {
    // Restart is the other path that spawns a process for an existing
    // session, and it stays process-less across several awaits — the same
    // window a wake has.
    const h = await makeHarness();
    const gate = h.gateCheckoutLookup();

    const restart = h.manager.restartSession("s1", PROJECT_PATH);
    await Promise.resolve();
    expect(h.manager.getSession("s1")!.processStartsInFlight).toBe(1);

    expect(await h.manager.deleteDormantSessionIfExpired("s1", CUTOFF)).toBe(false);
    expect(h.deleteIfExpired).not.toHaveBeenCalled();
    expect(h.manager.getSession("s1")).not.toBeNull();

    gate.release();
    await restart.catch(() => undefined);
    expect(h.manager.getSession("s1")?.processStartsInFlight ?? 0).toBe(0);
  });

  it("refuses a restart that arrives mid-delete, before it touches anything", async () => {
    const h = await makeHarness();
    const deleteGate = deferred<boolean>();
    h.deleteIfExpired.mockReturnValueOnce(deleteGate.promise);

    const deleting = h.manager.deleteDormantSessionIfExpired("s1", CUTOFF);
    await Promise.resolve();

    h.getCheckoutById.mockClear(); // startup restore already looked it up once
    expect(await h.manager.restartSession("s1", PROJECT_PATH)).toBe(false);
    // Refused up front: it never reached the checkout lookup, so it never
    // wiped entries or spawned anything for a row that is being deleted.
    expect(h.getCheckoutById).not.toHaveBeenCalled();

    deleteGate.resolve(true);
    expect(await deleting).toBe(true);
    expect(h.manager.getSession("s1")).toBeNull();
  });
});
