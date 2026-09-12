// The hub hears "this session lost its process" only on that session's own WS
// stream, so every session it holds no stream for — anything nobody reopened
// since this process started, or since the tunnel dropped — can lose a death
// silently and leave a sidebar row claiming a process that is gone. These
// tests pin the recovery: every authoritative alive answer announces what it
// dropped, and overlapping reads never let an older answer decide.
import { describe, it, expect, vi } from "vitest";
import {
  RemoteLivenessTracker,
  reconcileRemoteLiveness,
  type RemoteLivenessProxyResult,
} from "./remote-liveness-reconcile.js";
import type { EventBus } from "./event-bus.js";

const SERVER = "srv1";
const PROJECT = "p1";
const PATH = "/worker/p1";

const A = { localSessionId: "remote-srv1-p1-a", remoteSessionId: "a", branch: null };
const B = { localSessionId: "remote-srv1-p1-b", remoteSessionId: "b", branch: "dev" };
const C = { localSessionId: "remote-srv1-p1-c", remoteSessionId: "c", branch: null };

function busSpy() {
  const emit = vi.fn();
  return { bus: { emit } as unknown as EventBus, emit };
}

/** A tracker holding one accepted baseline, as a browser's `/alive` read leaves it. */
function trackerWith(sessions: Array<typeof A>) {
  const { bus, emit } = busSpy();
  const tracker = new RemoteLivenessTracker(bus);
  tracker.accept(PROJECT, SERVER, PATH, sessions, tracker.nextReadSeq());
  emit.mockClear(); // the first baseline has no predecessor to diff against
  return { tracker, emit };
}

const aliveAnswer = (ids: Array<{ id: string; branch?: string | null }>): RemoteLivenessProxyResult => ({
  ok: true,
  status: 200,
  data: { complete: true, sessions: ids.map((s) => ({ id: s.id, branch: s.branch ?? null })) },
});

describe("RemoteLivenessTracker.accept", () => {
  // The plain, no-reconcile-in-sight case: one browser opens the project and
  // its own read is the first thing to notice B is gone. Nothing else will
  // ever tell the browser that is NOT reading.
  it("announces the sessions an authoritative read dropped", () => {
    const { tracker, emit } = trackerWith([A, B]);

    const retired = tracker.accept(PROJECT, SERVER, PATH, [A], tracker.nextReadSeq());

    expect(retired).toEqual([B.localSessionId]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: "session:process",
      projectId: PROJECT,
      branch: "dev",
      sessionId: B.localSessionId,
      alive: false,
    });
  });

  it("announces a death once, not on every later read", () => {
    const { tracker, emit } = trackerWith([A, B]);

    tracker.accept(PROJECT, SERVER, PATH, [A], tracker.nextReadSeq());
    emit.mockClear();
    tracker.accept(PROJECT, SERVER, PATH, [A], tracker.nextReadSeq());

    expect(emit).not.toHaveBeenCalled();
  });

  // Reads overlap. An answer taken before a session existed — or before it was
  // woken — must not get to decide, in either direction.
  it("drops an answer older than the one already accepted", () => {
    const { tracker, emit } = trackerWith([A]);
    const older = tracker.nextReadSeq();
    const newer = tracker.nextReadSeq();

    tracker.accept(PROJECT, SERVER, PATH, [A, C], newer);
    emit.mockClear();
    const retired = tracker.accept(PROJECT, SERVER, PATH, [A], older);

    expect(retired).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    // The newer baseline stands: C is still tracked, so a real death of C is
    // still announceable.
    expect(tracker.accept(PROJECT, SERVER, PATH, [A], tracker.nextReadSeq()))
      .toEqual([C.localSessionId]);
  });
});

describe("reconcileRemoteLiveness", () => {
  it("announces the sessions that no longer hold a process, and only those", async () => {
    const { tracker, emit } = trackerWith([A, B]);
    const proxy = vi.fn(async () => aliveAnswer([{ id: "a" }]));

    const result = await reconcileRemoteLiveness(SERVER, { tracker, proxy });

    expect(proxy).toHaveBeenCalledWith(SERVER, PATH);
    expect(result.dead).toEqual([B.localSessionId]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ sessionId: B.localSessionId, branch: "dev", alive: false });
  });

  it("does not repeat a death on the next round", async () => {
    const { tracker, emit } = trackerWith([A, B]);
    const proxy = vi.fn(async () => aliveAnswer([{ id: "a" }]));

    await reconcileRemoteLiveness(SERVER, { tracker, proxy });
    emit.mockClear();
    await reconcileRemoteLiveness(SERVER, { tracker, proxy });

    expect(emit).not.toHaveBeenCalled();
  });

  // Failure is not death: a worker that is offline, erroring, or too old to
  // enumerate its live sessions must leave the rows alone rather than blank a
  // sidebar that is merely unobservable right now.
  it.each([
    ["an offline worker", { ok: false, status: 0, data: { errorCode: "network_error" } }],
    ["an erroring worker", { ok: false, status: 500, data: {} }],
    ["a worker too old to enumerate", { ok: true, status: 200, data: { complete: false, sessions: [] } }],
    ["a shapeless answer", { ok: true, status: 200, data: { sessions: "nope" } }],
  ])("declares nothing dead on %s", async (_label, answer) => {
    const { tracker, emit } = trackerWith([A]);

    const result = await reconcileRemoteLiveness(SERVER, {
      tracker, proxy: async () => answer as RemoteLivenessProxyResult,
    });

    expect(emit).not.toHaveBeenCalled();
    expect(result.dead).toEqual([]);
    // The baseline survives, so the next successful round can still catch it.
    await reconcileRemoteLiveness(SERVER, { tracker, proxy: async () => aliveAnswer([]) });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("survives a proxy that throws", async () => {
    const { tracker, emit } = trackerWith([A]);

    const result = await reconcileRemoteLiveness(SERVER, {
      tracker, proxy: async () => { throw new Error("tunnel gone"); },
    });

    expect(result).toEqual({ projects: 0, dead: [] });
    expect(emit).not.toHaveBeenCalled();
  });

  it("touches only the projects of the server that came back", async () => {
    const { bus, emit } = busSpy();
    const tracker = new RemoteLivenessTracker(bus);
    tracker.accept(PROJECT, SERVER, PATH, [A], tracker.nextReadSeq());
    tracker.accept("p2", "srv2", "/worker/p2", [
      { localSessionId: "remote-srv2-p2-z", remoteSessionId: "z", branch: null },
    ], tracker.nextReadSeq());
    const proxy = vi.fn(async () => aliveAnswer([]));

    await reconcileRemoteLiveness(SERVER, { tracker, proxy });

    expect(proxy).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ sessionId: A.localSessionId });
  });

  it("keeps the freshest branch for a session that stayed alive", async () => {
    const { tracker, emit } = trackerWith([A]);

    await reconcileRemoteLiveness(SERVER, {
      tracker, proxy: async () => aliveAnswer([{ id: "a", branch: "dev" }]),
    });
    await reconcileRemoteLiveness(SERVER, { tracker, proxy: async () => aliveAnswer([]) });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ sessionId: A.localSessionId, branch: "dev" });
  });

  // Two browsers and a reconnect, interleaved. Browser 1 holds [A, B]; B dies
  // unheard during the outage; browser 2's read lands while the reconnect
  // query is still in flight, and that query was taken before B died — so it
  // still lists B. Whoever answers first must announce B, and the loser must
  // neither undo it nor resurrect anything.
  it("announces the death exactly once when a browser read overtakes the query", async () => {
    const { tracker, emit } = trackerWith([A, B]);
    const proxy = vi.fn(async () => {
      tracker.accept(PROJECT, SERVER, PATH, [A], tracker.nextReadSeq()); // browser 2
      return aliveAnswer([{ id: "a" }, { id: "b" }]);
    });

    const result = await reconcileRemoteLiveness(SERVER, { tracker, proxy });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ sessionId: B.localSessionId, alive: false });
    // The stale query answered second and decided nothing — B stays dead.
    expect(result.dead).toEqual([]);
    emit.mockClear();
    await reconcileRemoteLiveness(SERVER, { tracker, proxy: async () => aliveAnswer([{ id: "a" }]) });
    expect(emit).not.toHaveBeenCalled();
  });

  // The mirror case: the query is the older answer AND misses a session that
  // was created while it was in flight. It must not declare that one dead.
  it("cannot bury a session created while its query was in flight", async () => {
    const { tracker, emit } = trackerWith([A]);
    const proxy = vi.fn(async () => {
      tracker.accept(PROJECT, SERVER, PATH, [A, C], tracker.nextReadSeq()); // C created
      return aliveAnswer([{ id: "a" }]);
    });

    const result = await reconcileRemoteLiveness(SERVER, { tracker, proxy });

    expect(result.dead).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    // C is still tracked: a later round can still judge it.
    await reconcileRemoteLiveness(SERVER, { tracker, proxy: async () => aliveAnswer([{ id: "a" }]) });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ sessionId: C.localSessionId });
  });
});
