import { describe, it, expect, vi } from "vitest";
import { SessionRetentionSweeper } from "./session-retention.js";
import {
  parseRetentionDays,
  retentionCutoff,
  SESSION_RETENTION_SETTING_KEY,
} from "./session-retention-config.js";
import type { Storage } from "./storage/types.js";

/**
 * The sweep loop: configuration handling, single-flight, the intra-sweep
 * keyset cursor and the soft time budget
 * (docs/plans/2026-08-08-session-retention.md §1.3).
 *
 * The predicate itself is exercised against real SQL in
 * storage/session-retention.test.ts; here the candidate source is a fake so
 * the loop's own behaviour — how many times it queries, with which cutoff,
 * and in which order — is directly observable.
 */

const DAY = 86_400_000;

interface FakeSession {
  id: string;
  activityAt: number;
  /** Simulates "rescued between scan and delete": the delete reports a miss. */
  rescued?: boolean;
}

function makeHarness(opts: {
  sessions: FakeSession[];
  settingValue?: string;
  batchSize?: number;
  tickBudgetMs?: number;
  now?: () => number;
}) {
  const state = {
    setting: opts.settingValue ?? "90",
    sessions: [...opts.sessions],
    scans: [] as Array<{ cutoff: number; after?: { activityAt: number; id: string } }>,
    considered: [] as string[],
    deleted: [] as string[],
    settingReads: 0,
  };

  const storage = {
    settings: {
      get: vi.fn(async (key: string) => {
        expect(key).toBe(SESSION_RETENTION_SETTING_KEY);
        state.settingReads++;
        return state.setting;
      }),
    },
    agentSessions: {
      listRetentionCandidates: vi.fn(async ({ cutoff, limit, after }: {
        cutoff: number; limit: number; after?: { activityAt: number; id: string };
      }) => {
        state.scans.push({ cutoff, after });
        return state.sessions
          .filter((s) => s.activityAt < cutoff)
          .filter((s) => !after
            || s.activityAt > after.activityAt
            || (s.activityAt === after.activityAt && s.id > after.id))
          .sort((a, b) => a.activityAt - b.activityAt || a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((s) => ({ id: s.id, project_id: "p1", branch: "dev", activity_at: s.activityAt }));
      }),
    },
  } as unknown as Storage;

  const sweeper = new SessionRetentionSweeper({
    storage,
    deleteIfExpired: async (sessionId, cutoff) => {
      state.considered.push(sessionId);
      const found = state.sessions.find((s) => s.id === sessionId);
      if (!found || found.rescued || found.activityAt >= cutoff) return false;
      state.sessions = state.sessions.filter((s) => s.id !== sessionId);
      state.deleted.push(sessionId);
      return true;
    },
    now: opts.now,
    batchSize: opts.batchSize ?? 20,
    tickBudgetMs: opts.tickBudgetMs,
    // The timers are never armed in these tests; sweep() is driven directly.
    startupDelayMs: 10 ** 9,
    intervalMs: 10 ** 9,
  });

  return { sweeper, state };
}

const aged = (id: string, days: number, rescued = false): FakeSession =>
  ({ id, activityAt: Date.now() - days * DAY, rescued });

describe("SessionRetentionSweeper", () => {
  it("deletes expired sessions oldest first, across batches", async () => {
    const h = makeHarness({
      sessions: [aged("mid", 120), aged("oldest", 300), aged("newest", 91)],
      batchSize: 2,
    });
    const result = await h.sweeper.sweep();
    expect(h.state.deleted).toEqual(["oldest", "mid", "newest"]);
    expect(result).toMatchObject({ scanned: 3, deleted: 3, disabled: false, budgetExhausted: false });
  });

  it("is a single empty query when nothing is expired — the steady state", async () => {
    const h = makeHarness({ sessions: [aged("fresh", 10)] });
    const result = await h.sweeper.sweep();
    expect(h.state.scans).toHaveLength(1);
    expect(result).toMatchObject({ scanned: 0, deleted: 0 });
  });

  it("is a single empty query on a machine with no sessions at all (no hub branch)", async () => {
    const h = makeHarness({ sessions: [] });
    await h.sweeper.sweep();
    expect(h.state.scans).toHaveLength(1);
    expect(h.state.considered).toEqual([]);
  });

  it("is idempotent — the second tick does nothing", async () => {
    const h = makeHarness({ sessions: [aged("old", 100)] });
    await h.sweeper.sweep();
    h.state.considered = [];
    const second = await h.sweeper.sweep();
    expect(h.state.considered).toEqual([]);
    expect(second).toMatchObject({ scanned: 0, deleted: 0 });
  });

  describe("configuration", () => {
    for (const [label, value] of [
      ["empty", ""],
      ["zero", "0"],
      ["negative", "-30"],
      ["non-numeric", "forever"],
      ["fractional", "12.5"],
      ["over the maximum", "99999"],
    ] as const) {
      it(`treats ${label} as disabled and deletes nothing`, async () => {
        const h = makeHarness({ sessions: [aged("ancient", 5000)], settingValue: value });
        const result = await h.sweeper.sweep();
        expect(result.disabled).toBe(true);
        expect(h.state.deleted).toEqual([]);
        expect(h.state.scans).toEqual([]);
      });
    }

    it("re-reads the setting at every batch boundary", async () => {
      const h = makeHarness({
        sessions: [aged("a", 300), aged("b", 200), aged("c", 100)],
        batchSize: 1,
      });
      await h.sweeper.sweep();
      // One read per batch, plus the read that finds the empty final page.
      expect(h.state.settingReads).toBe(h.state.scans.length);
      expect(h.state.settingReads).toBeGreaterThan(1);
    });

    it("stops deleting the moment retention is switched off mid-sweep", async () => {
      const h = makeHarness({
        sessions: [aged("a", 300), aged("b", 200), aged("c", 100)],
        batchSize: 1,
      });
      // Disable as soon as the first batch has been processed — the change
      // must be visible to the very next batch, not the one after it.
      const storage = h.sweeper as unknown as { storage: Storage };
      const realGet = storage.storage.settings.get;
      storage.storage.settings.get = async (key: string) => {
        if (h.state.deleted.length >= 1) h.state.setting = "";
        return realGet(key);
      };
      const result = await h.sweeper.sweep();
      expect(result.disabled).toBe(true);
      expect(h.state.deleted).toEqual(["a"]);
    });

    it("picks up a widened window mid-sweep instead of using the entry cutoff", async () => {
      const h = makeHarness({
        sessions: [aged("a", 300), aged("b", 100)],
        batchSize: 1,
      });
      const storage = h.sweeper as unknown as { storage: Storage };
      const realGet = storage.storage.settings.get;
      storage.storage.settings.get = async (key: string) => {
        // After the first delete the operator widens 90 → 200 days, which
        // takes "b" (100 days old) back out of scope.
        if (h.state.deleted.length >= 1) h.state.setting = "200";
        return realGet(key);
      };
      await h.sweeper.sweep();
      expect(h.state.deleted).toEqual(["a"]);
      expect(h.state.scans.at(-1)!.cutoff).toBeLessThan(h.state.scans[0].cutoff);
    });
  });

  it("advances the cursor past skipped candidates instead of re-reading them", async () => {
    // Every candidate in the first page is rescued between scan and delete.
    // Without a cursor the next query returns the same page forever and the
    // deletable session behind it is never reached.
    const h = makeHarness({
      sessions: [
        aged("skip1", 300, true), aged("skip2", 290, true),
        aged("deletable", 200),
      ],
      batchSize: 2,
    });
    const result = await h.sweeper.sweep();
    expect(h.state.deleted).toEqual(["deletable"]);
    // Each candidate considered at most once in the round.
    expect(h.state.considered).toEqual(["skip1", "skip2", "deletable"]);
    expect(result.scanned).toBe(3);
    expect(h.state.scans[1].after).toEqual({
      activityAt: expect.any(Number), id: "skip2",
    });
  });

  it("yields to the event loop before every delete, not once per batch", async () => {
    // better-sqlite3 is synchronous, so back-to-back deletes freeze the whole
    // server. Measured at 3k entries/session: ~916ms of dead event loop when
    // yielding per batch of 20, ~36ms when yielding per session.
    const h = makeHarness({ sessions: [aged("a", 300), aged("b", 200), aged("c", 100)], batchSize: 20 });
    const ticksSeen: number[] = [];
    const sweeper = h.sweeper as unknown as {
      deleteIfExpired: (id: string, cutoff: number) => Promise<boolean>;
    };
    const real = sweeper.deleteIfExpired;
    let macrotasks = 0;
    const bump = () => { macrotasks++; setImmediate(bump); };
    setImmediate(bump);
    sweeper.deleteIfExpired = async (id, cutoff) => {
      ticksSeen.push(macrotasks);
      return real(id, cutoff);
    };

    await h.sweeper.sweep();

    // All three landed in one batch (batchSize 20), yet each ran on a
    // different macrotask turn — i.e. the loop gave the runtime a chance to
    // serve traffic between them.
    expect(new Set(ticksSeen).size).toBe(3);
  });

  it("isolates a failing candidate instead of starving everything behind it", async () => {
    // Every sweep restarts from the oldest session, so one candidate that
    // always throws would block the whole tail forever if it aborted the round.
    const h = makeHarness({ sessions: [aged("poison", 300), aged("healthy", 200)] });
    const sweeper = h.sweeper as unknown as {
      deleteIfExpired: (id: string, cutoff: number) => Promise<boolean>;
    };
    const real = sweeper.deleteIfExpired;
    sweeper.deleteIfExpired = async (id, cutoff) => {
      if (id === "poison") throw new Error("row is locked");
      return real(id, cutoff);
    };

    const result = await h.sweeper.sweep();

    expect(h.state.deleted).toEqual(["healthy"]);
    expect(result).toMatchObject({ scanned: 2, deleted: 1 });
  });

  it("stops on the soft time budget and leaves the rest for the next tick", async () => {
    // Wall clock stays realistic (the cutoff is derived from it) but jumps a
    // minute per read, so the budget check at the first batch boundary already
    // sees itself overrun.
    let clock = Date.now();
    const h = makeHarness({
      sessions: [aged("a", 300), aged("b", 200), aged("c", 100)],
      batchSize: 1,
      tickBudgetMs: 50,
      now: () => { clock += 60_000; return clock; },
    });
    const result = await h.sweeper.sweep();
    expect(result.budgetExhausted).toBe(true);
    expect(h.state.deleted.length).toBeLessThan(3);
  });

  describe("logging", () => {
    // Retention destroys conversation history unattended. The log is the only
    // place a user can later find out what happened to a session.
    const captureLogs = () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
      });
      return { lines, restore: () => spy.mockRestore() };
    };

    it("names every session it deletes, and summarizes the sweep", async () => {
      const h = makeHarness({ sessions: [aged("s-alpha", 300), aged("s-beta", 400)] });
      const log = captureLogs();
      try {
        await h.sweeper.sweep();
      } finally {
        log.restore();
      }

      expect(log.lines.filter((l) => l.includes("deleted session s-alpha"))).toHaveLength(1);
      expect(log.lines.filter((l) => l.includes("deleted session s-beta"))).toHaveLength(1);
      // Identifying detail, not just an id: project, branch, and staleness.
      expect(log.lines.find((l) => l.includes("s-beta"))).toMatch(/project=p1 branch=dev, inactive 400 days/);
      expect(log.lines.some((l) => /deleted 2 expired session\(s\) of 2 candidate\(s\)/.test(l))).toBe(true);
      expect(log.lines.some((l) => l.includes("retention window 90 days"))).toBe(true);
    });

    it("says nothing at all on a tick that deletes nothing", async () => {
      // Runs every 6 hours on every machine, hub included. A heartbeat line
      // here would only teach people to filter the channel out.
      const h = makeHarness({ sessions: [aged("fresh", 10)] });
      const log = captureLogs();
      try {
        await h.sweeper.sweep();
      } finally {
        log.restore();
      }
      expect(log.lines).toEqual([]);
    });

    it("says nothing when retention is disabled", async () => {
      const h = makeHarness({ sessions: [aged("ancient", 5000)], settingValue: "" });
      const log = captureLogs();
      try {
        await h.sweeper.sweep();
      } finally {
        log.restore();
      }
      expect(log.lines).toEqual([]);
    });

    it("flags that work remains when the budget cut the sweep short", async () => {
      let clock = Date.now();
      const h = makeHarness({
        sessions: [aged("a", 300), aged("b", 200), aged("c", 100)],
        batchSize: 1,
        tickBudgetMs: 50,
        now: () => { clock += 60_000; return clock; },
      });
      const log = captureLogs();
      try {
        await h.sweeper.sweep();
      } finally {
        log.restore();
      }
      expect(log.lines.some((l) => l.includes("more remain for the next tick"))).toBe(true);
    });
  });

  describe("single-flight", () => {
    it("coalesces a concurrent trigger into the running sweep", async () => {
      const h = makeHarness({ sessions: [aged("a", 300), aged("b", 200)], batchSize: 1 });
      const [first, second] = await Promise.all([h.sweeper.sweep(), h.sweeper.sweep()]);
      // Same promise, so the same result object — and each candidate handled once.
      expect(second).toBe(first);
      expect(h.state.considered).toEqual(["a", "b"]);
    });

    it("allows a new sweep after the previous one settles", async () => {
      const h = makeHarness({ sessions: [aged("a", 300)] });
      await h.sweeper.sweep();
      const again = await h.sweeper.sweep();
      expect(again).toMatchObject({ scanned: 0 });
    });

    it("survives a failing sweep and keeps accepting triggers", async () => {
      const h = makeHarness({ sessions: [aged("a", 300)] });
      const storage = h.sweeper as unknown as { storage: Storage };
      const realList = storage.storage.agentSessions.listRetentionCandidates;
      storage.storage.agentSessions.listRetentionCandidates = async () => {
        throw new Error("database is locked");
      };
      await expect(h.sweeper.sweep()).resolves.toMatchObject({ deleted: 0 });
      storage.storage.agentSessions.listRetentionCandidates = realList;
      await expect(h.sweeper.sweep()).resolves.toMatchObject({ deleted: 1 });
    });
  });

  it("close() stops the timers and waits for an in-flight sweep", async () => {
    const h = makeHarness({ sessions: [aged("a", 300)] });
    const running = h.sweeper.sweep();
    await h.sweeper.close();
    await expect(running).resolves.toMatchObject({ deleted: 1 });
  });
});

describe("retention configuration parsing", () => {
  it("accepts whole numbers inside the range", () => {
    expect(parseRetentionDays("90")).toBe(90);
    expect(parseRetentionDays(1)).toBe(1);
    expect(parseRetentionDays(3650)).toBe(3650);
  });

  it("rejects — never clamps — anything outside it", () => {
    for (const bad of [null, undefined, "", "   ", "0", 0, -1, "-30", "abc", 12.5, NaN, Infinity, 3651]) {
      expect(parseRetentionDays(bad)).toBeNull();
    }
  });

  it("cutoff is `days` before the given instant", () => {
    expect(retentionCutoff(90, 1_000 * DAY)).toBe(910 * DAY);
  });
});
