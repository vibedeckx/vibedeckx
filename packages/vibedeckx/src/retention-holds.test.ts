import { describe, expect, it } from "vitest";
import { RELEASE_STALE_MAX_SESSIONS, RetentionHoldSync, type RetentionHoldSource } from "./retention-holds.js";
import type { Storage } from "./storage/types.js";
import type { ProxyResult } from "./utils/remote-proxy.js";

/**
 * Whole-set replacement is only correct if sets land in the order their
 * queries ran. These drive the per-session serialization with a worker whose
 * answers the test releases by hand.
 */
describe("RetentionHoldSync ordering", () => {
  const SESSION = "remote-srv-p-abc";

  const harness = () => {
    let holders: string[] = ["A"];
    const source: RetentionHoldSource = {
      kind: "schedule", listHolders: async () => [...holders],
    };
    const landed: string[][] = [];
    const pending: Array<() => void> = [];
    const sync = new RetentionHoldSync({
      storage: {} as Storage,
      remoteSessionMap: new Map([[SESSION, { remoteServerId: "srv", remoteSessionId: "abc" }]]),
      sources: [source],
      proxy: async (_s, _m, _p, payload) => {
        const ids = (payload as { holds: Array<{ id: string }> }).holds.map((h) => h.id);
        await new Promise<void>((resolve) => pending.push(resolve));
        landed.push(ids);
        return { ok: true, status: 200, data: {} } satisfies ProxyResult;
      },
    });
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    return {
      sync, landed, pending, flush,
      setHolders: (next: string[]) => { holders = next; },
    };
  };

  it("does not let an older set overwrite a newer one", async () => {
    const h = harness();
    // Delete of A: its query runs and reads {} — but the write hangs.
    h.setHolders([]);
    const releaseA = h.sync.sync(SESSION);
    await h.flush();
    expect(h.pending).toHaveLength(1);

    // Create of B starts meanwhile. It must not even query yet.
    h.setHolders(["B"]);
    const createB = h.sync.sync(SESSION);
    await h.flush();
    expect(h.pending).toHaveLength(1);

    h.pending.shift()!();
    await releaseA;
    await h.flush();
    h.pending.shift()!();
    await createB;

    expect(h.landed).toEqual([[], ["B"]]);
  });

  it("keeps the queue moving after a failed write", async () => {
    let calls = 0;
    const landed: string[][] = [];
    const sync = new RetentionHoldSync({
      storage: {} as Storage,
      remoteSessionMap: new Map([[SESSION, { remoteServerId: "srv", remoteSessionId: "abc" }]]),
      sources: [{ kind: "schedule", listHolders: async () => ["X"] }],
      proxy: async (_s, _m, _p, payload) => {
        if (++calls === 1) return { ok: false, status: 0, data: {} };
        landed.push((payload as { holds: Array<{ id: string }> }).holds.map((x) => x.id));
        return { ok: true, status: 200, data: {} };
      },
    });
    const first = sync.sync(SESSION);
    const second = sync.sync(SESSION);
    await expect(first).rejects.toThrow("not connected");
    await expect(second).resolves.toBeUndefined();
    expect(landed).toEqual([["X"]]);
  });

  it("treats a session the worker no longer has as nothing to hold", async () => {
    const sync = new RetentionHoldSync({
      storage: {} as Storage,
      remoteSessionMap: new Map([[SESSION, { remoteServerId: "srv", remoteSessionId: "abc" }]]),
      sources: [],
      proxy: async () => ({ ok: false, status: 404, data: {} }),
    });
    await expect(sync.sync(SESSION)).resolves.toBeUndefined();
  });
});

describe("RetentionHoldSync.releaseStale", () => {
  it("joins a pass already running for the same worker instead of starting another", async () => {
    let lists = 0;
    let answer!: () => void;
    const sync = new RetentionHoldSync({
      storage: {} as Storage,
      remoteSessionMap: new Map(),
      sources: [],
      proxy: async () => {
        lists++;
        await new Promise<void>((resolve) => { answer = resolve; });
        return { ok: true, status: 200, data: { sessionIds: [] } } satisfies ProxyResult;
      },
    });
    const first = sync.releaseStale("srv");
    const second = sync.releaseStale("srv");
    expect(second).toBe(first);
    answer();
    expect(await first).toBe(0);
    expect(lists).toBe(1);
    // Once settled, the next tick starts a fresh pass.
    const third = sync.releaseStale("srv");
    expect(third).not.toBe(first);
    answer();
    await third;
    expect(lists).toBe(2);
  });

  it("checks at most RELEASE_STALE_MAX_SESSIONS of what the worker lists", async () => {
    let pushes = 0;
    const sync = new RetentionHoldSync({
      storage: { remoteSessionMappings: { getByRemote: async () => undefined } } as unknown as Storage,
      remoteSessionMap: new Map(),
      sources: [],
      proxy: async (_server, method) => {
        if (method === "GET") {
          const sessionIds = Array.from({ length: RELEASE_STALE_MAX_SESSIONS + 5 }, (_, i) => `s${i}`);
          return { ok: true, status: 200, data: { sessionIds } } satisfies ProxyResult;
        }
        pushes++;
        return { ok: true, status: 204, data: null } satisfies ProxyResult;
      },
    });
    expect(await sync.releaseStale("srv")).toBe(0);
    expect(pushes).toBe(RELEASE_STALE_MAX_SESSIONS);
  });
});
