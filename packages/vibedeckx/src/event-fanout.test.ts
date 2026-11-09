import { describe, expect, it, vi } from "vitest";
import type { GlobalEvent } from "./event-bus.js";
import { EventFanout } from "./event-fanout.js";

function ev(projectId: string, title = "t"): GlobalEvent {
  return { type: "session:title", projectId, branch: null, sessionId: "s", title };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("EventFanout", () => {
  it("delivers only to the project owner's connections", async () => {
    const owners: Record<string, string> = { p1: "alice", p2: "bob" };
    const fanout = new EventFanout({ getOwnerId: async (id) => owners[id] });
    const alice: GlobalEvent[] = [];
    const bob: GlobalEvent[] = [];
    fanout.add("alice", (e) => alice.push(e));
    fanout.add("bob", (e) => bob.push(e));

    fanout.dispatch(ev("p1"));
    fanout.dispatch(ev("p2"));
    await flush();

    expect(alice.map((e) => e.projectId)).toEqual(["p1"]);
    expect(bob.map((e) => e.projectId)).toEqual(["p2"]);
  });

  it("looks each owner up once regardless of connection count", async () => {
    const getOwnerId = vi.fn(async () => "alice");
    const fanout = new EventFanout({ getOwnerId });
    for (let i = 0; i < 20; i++) fanout.add(`user-${i}`, () => {});
    const got: GlobalEvent[] = [];
    fanout.add("alice", (e) => got.push(e));

    for (let i = 0; i < 5; i++) fanout.dispatch(ev("p1"));
    await flush();
    fanout.dispatch(ev("p1"));

    expect(getOwnerId).toHaveBeenCalledTimes(1);
    expect(got).toHaveLength(6);
  });

  it("delivers synchronously once the owner is cached", async () => {
    const fanout = new EventFanout({ getOwnerId: async () => "alice" });
    const got: GlobalEvent[] = [];
    fanout.add("alice", (e) => got.push(e));
    fanout.dispatch(ev("p1"));
    await flush();

    fanout.dispatch(ev("p1", "second"));
    expect(got).toHaveLength(2);
  });

  it("preserves emit order for events queued behind an in-flight lookup", async () => {
    const lookup = deferred<string | undefined>();
    const fanout = new EventFanout({ getOwnerId: () => lookup.promise });
    const got: string[] = [];
    fanout.add("alice", (e) => got.push((e as { title: string }).title));

    fanout.dispatch(ev("p1", "running"));
    fanout.dispatch(ev("p1", "stopped"));
    lookup.resolve("alice");
    await flush();
    fanout.dispatch(ev("p1", "after"));

    expect(got).toEqual(["running", "stopped", "after"]);
  });

  it("sends every event to trusted connections without any lookup", () => {
    const getOwnerId = vi.fn(async () => "alice");
    const fanout = new EventFanout({ getOwnerId });
    const got: GlobalEvent[] = [];
    fanout.add(null, (e) => got.push(e));

    fanout.dispatch(ev("p1"));
    fanout.dispatch(ev("p2"));

    expect(got).toHaveLength(2);
    expect(getOwnerId).not.toHaveBeenCalled();
  });

  it("does not cache a missing project", async () => {
    let owner: string | undefined;
    const getOwnerId = vi.fn(async () => owner);
    const fanout = new EventFanout({ getOwnerId });
    const got: GlobalEvent[] = [];
    fanout.add("alice", (e) => got.push(e));

    fanout.dispatch(ev("p1"));
    await flush();
    expect(got).toHaveLength(0);

    owner = "alice";
    fanout.dispatch(ev("p1"));
    await flush();
    expect(got).toHaveLength(1);
    expect(getOwnerId).toHaveBeenCalledTimes(2);
  });

  it("does not deliver to a solo-mode owner sentinel's namesake user", async () => {
    const fanout = new EventFanout({ getOwnerId: async () => "local" });
    const got: GlobalEvent[] = [];
    fanout.add("alice", (e) => got.push(e));
    fanout.dispatch(ev("p1"));
    await flush();
    expect(got).toHaveLength(0);
  });

  it("reports lookup failures and retries on the next event", async () => {
    const onError = vi.fn();
    const getOwnerId = vi.fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue("alice");
    const fanout = new EventFanout({ getOwnerId, onError });
    const got: GlobalEvent[] = [];
    fanout.add("alice", (e) => got.push(e));

    fanout.dispatch(ev("p1"));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(got).toHaveLength(0);

    fanout.dispatch(ev("p1"));
    await flush();
    expect(got).toHaveLength(1);
  });

  it("isolates a throwing sink from the others", async () => {
    const onError = vi.fn();
    const fanout = new EventFanout({ getOwnerId: async () => "alice", onError });
    const got: GlobalEvent[] = [];
    fanout.add("alice", () => { throw new Error("socket gone"); });
    fanout.add("alice", (e) => got.push(e));

    fanout.dispatch(ev("p1"));
    await flush();

    expect(got).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after a connection is removed", async () => {
    const fanout = new EventFanout({ getOwnerId: async () => "alice" });
    const got: GlobalEvent[] = [];
    const remove = fanout.add("alice", (e) => got.push(e));
    fanout.dispatch(ev("p1"));
    await flush();
    remove();
    fanout.dispatch(ev("p1"));
    expect(got).toHaveLength(1);
  });

  it("skips lookups entirely when no user-scoped connection exists", () => {
    const getOwnerId = vi.fn(async () => "alice");
    const fanout = new EventFanout({ getOwnerId });
    fanout.dispatch(ev("p1"));
    expect(getOwnerId).not.toHaveBeenCalled();
  });

  it("bounds the owner cache with least-recently-used eviction", async () => {
    const getOwnerId = vi.fn(async () => "alice");
    const fanout = new EventFanout({ getOwnerId, maxCachedOwners: 2 });
    fanout.add("alice", () => {});

    fanout.dispatch(ev("p1"));
    fanout.dispatch(ev("p2"));
    await flush();
    fanout.dispatch(ev("p1")); // p1 now most recent
    fanout.dispatch(ev("p3")); // evicts p2
    await flush();
    expect(fanout.cachedOwnerCount).toBe(2);

    getOwnerId.mockClear();
    fanout.dispatch(ev("p1"));
    fanout.dispatch(ev("p2"));
    expect(getOwnerId.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["p2"]);
  });
});
