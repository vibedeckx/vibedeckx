import { describe, expect, it } from "vitest";
import {
  reconcileActivitySnapshot,
  type ActivitySnapshotEntry,
  type BranchActivity,
} from "./use-branch-activity";

function snapshot(...entries: ActivitySnapshotEntry[]): ActivitySnapshotEntry[] {
  return entries;
}

describe("reconcileActivitySnapshot", () => {
  it("fresh project: trusts snapshot wholesale, no transitions reported", () => {
    const { nextActivity, nextSince, transitions } = reconcileActivitySnapshot(
      snapshot(
        { branch: "feat-a", activity: "working", since: 100 },
        { branch: null, activity: "completed", since: 50 },
      ),
      new Map(),
      new Map(),
      true,
    );

    expect(nextActivity.get("feat-a")).toBe("working");
    expect(nextActivity.get("")).toBe("completed");
    expect(nextSince.get("feat-a")).toBe(100);
    expect(nextSince.get("")).toBe(50);
    expect(transitions).toEqual([]);
  });

  it("regression: stale snapshot does not roll back a newer SSE update", () => {
    // Bug scenario: SSE already delivered branch:activity:working (since=200)
    // for feat-a; a /branches/activity REST snapshot taken before persistEntry
    // landed returns "idle" with since=0. Without per-branch `since`
    // filtering, that snapshot would clobber the SSE state and leave the dot
    // gray until a workspace switch triggered another refetch.
    const prevActivity = new Map<string, BranchActivity>([["feat-a", "working"]]);
    const prevSince = new Map<string, number>([["feat-a", 200]]);

    const { nextActivity, nextSince, transitions } = reconcileActivitySnapshot(
      snapshot({ branch: "feat-a", activity: "idle", since: 0 }),
      prevActivity,
      prevSince,
      false,
    );

    expect(nextActivity.get("feat-a")).toBe("working");
    expect(nextSince.get("feat-a")).toBe(200);
    expect(transitions).toEqual([]);
  });

  it("newer snapshot wins over older SSE state", () => {
    const prevActivity = new Map<string, BranchActivity>([["feat-a", "idle"]]);
    const prevSince = new Map<string, number>([["feat-a", 100]]);

    const { nextActivity, nextSince, transitions } = reconcileActivitySnapshot(
      snapshot({ branch: "feat-a", activity: "completed", since: 300 }),
      prevActivity,
      prevSince,
      false,
    );

    expect(nextActivity.get("feat-a")).toBe("completed");
    expect(nextSince.get("feat-a")).toBe(300);
    expect(transitions).toEqual(["feat-a"]);
  });

  it("equal `since`: snapshot wins (treated as not-stale)", () => {
    // Both sides describe the same logical state. Accepting either is fine;
    // we accept the snapshot for simplicity. No transition because activity
    // already matched.
    const prevActivity = new Map<string, BranchActivity>([["feat-a", "working"]]);
    const prevSince = new Map<string, number>([["feat-a", 200]]);

    const { nextActivity, nextSince, transitions } = reconcileActivitySnapshot(
      snapshot({ branch: "feat-a", activity: "working", since: 200 }),
      prevActivity,
      prevSince,
      false,
    );

    expect(nextActivity.get("feat-a")).toBe("working");
    expect(nextSince.get("feat-a")).toBe(200);
    expect(transitions).toEqual([]);
  });

  it("transitions only include branches whose activity actually changed", () => {
    const prevActivity = new Map<string, BranchActivity>([
      ["feat-a", "working"],
      ["feat-b", "idle"],
    ]);
    const prevSince = new Map<string, number>([
      ["feat-a", 100],
      ["feat-b", 50],
    ]);

    const { transitions } = reconcileActivitySnapshot(
      snapshot(
        { branch: "feat-a", activity: "completed", since: 200 },
        { branch: "feat-b", activity: "idle", since: 60 },
      ),
      prevActivity,
      prevSince,
      false,
    );

    expect(transitions).toEqual(["feat-a"]);
  });

  it("null branch maps to '' key consistently", () => {
    const prevActivity = new Map<string, BranchActivity>([["", "working"]]);
    const prevSince = new Map<string, number>([["", 200]]);

    const { nextActivity, nextSince } = reconcileActivitySnapshot(
      snapshot({ branch: null, activity: "idle", since: 0 }),
      prevActivity,
      prevSince,
      false,
    );

    // Stale → keep prev
    expect(nextActivity.get("")).toBe("working");
    expect(nextSince.get("")).toBe(200);
  });

  it("desync defense: prevSince has key but prevActivity doesn't → accept snapshot", () => {
    const { nextActivity, nextSince } = reconcileActivitySnapshot(
      snapshot({ branch: "feat-a", activity: "idle", since: 0 }),
      new Map<string, BranchActivity>(),
      new Map<string, number>([["feat-a", 999]]),
      false,
    );

    expect(nextActivity.get("feat-a")).toBe("idle");
    expect(nextSince.get("feat-a")).toBe(0);
  });

  it("branches missing from snapshot are dropped (matches previous behavior)", () => {
    // The backend returns one entry per branch with sessions. A branch that
    // disappears from the snapshot (e.g. deleted) shouldn't linger in state.
    const prevActivity = new Map<string, BranchActivity>([["feat-a", "working"]]);
    const prevSince = new Map<string, number>([["feat-a", 100]]);

    const { nextActivity, nextSince } = reconcileActivitySnapshot(
      snapshot({ branch: "feat-b", activity: "idle", since: 50 }),
      prevActivity,
      prevSince,
      false,
    );

    expect(nextActivity.has("feat-a")).toBe(false);
    expect(nextActivity.get("feat-b")).toBe("idle");
    expect(nextSince.has("feat-a")).toBe(false);
    expect(nextSince.get("feat-b")).toBe(50);
  });

  it("scenario walkthrough: new conversation → first send → late stale refetch", () => {
    // Mirrors the production race:
    //   1. SSE branch:activity:idle (since=T1) from createNewSession
    //   2. SSE branch:activity:working (since=T2 > T1) from persistEntry
    //   3. REST snapshot taken between createNewSession and persistEntry
    //      lands LATE — snapshot has "idle" with since=0
    const T1 = 1_000_000;
    const T2 = 1_000_500;

    // After step 2, in-memory state from SSE handler:
    const prevActivity = new Map<string, BranchActivity>([["feat-a", "working"]]);
    const prevSince = new Map<string, number>([["feat-a", T2]]);

    // Step 3: late stale snapshot arrives.
    const { nextActivity, nextSince, transitions } = reconcileActivitySnapshot(
      snapshot({ branch: "feat-a", activity: "idle", since: 0 }),
      prevActivity,
      prevSince,
      false,
    );

    // Working must survive — no transition, no onBackendUpdate fired.
    expect(nextActivity.get("feat-a")).toBe("working");
    expect(nextSince.get("feat-a")).toBe(T2);
    expect(transitions).toEqual([]);
    // Suppress unused-var warning for T1 (kept for narrative clarity above).
    expect(T1).toBeLessThan(T2);
  });
});
