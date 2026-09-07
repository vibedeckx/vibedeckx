import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "@/lib/api";
import type { ResidentSidebarSession } from "./use-resident-sessions";
import {
  PLACEHOLDER_TTL_MS,
  TOMBSTONE_TTL_MS,
  applyBranchListing,
  applyRunUpdate,
  emptyPreparingReviews,
  expirePlaceholders,
  markAppeared,
  mergePreparingRows,
  preparingReviewRow,
  resolvePreparingSwitch,
  runVersion,
} from "./preparing-reviews";

const T0 = Date.parse("2026-09-07T08:36:19.000Z");

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    project_id: "p1",
    branch: "3004",
    source_session_id: "src-1",
    source_turn_end_index: 12,
    reviewer_session_id: "rev-1",
    review_focus: null,
    review_target: null,
    feedback_snapshot: null,
    status: "preparing",
    error: null,
    created_at: new Date(T0).toISOString(),
    updated_at: new Date(T0).toISOString(),
    ...overrides,
  };
}

const later = (ms: number) => new Date(T0 + ms).toISOString();

describe("runVersion", () => {
  it("ranks the status machine ahead of the timestamp", () => {
    const olderButAdvanced = run({ status: "waiting_reviewer", updated_at: later(-5_000) });
    const newerButPreparing = run({ status: "preparing", updated_at: later(5_000) });
    expect(runVersion(olderButAdvanced)).toBeGreaterThan(runVersion(newerButPreparing));
  });

  it("orders same-status updates by timestamp", () => {
    expect(runVersion(run({ updated_at: later(1) }))).toBeGreaterThan(runVersion(run()));
  });
});

describe("applyRunUpdate", () => {
  it("inserts a placeholder for a preparing run of the current project", () => {
    const state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0, "导出报错邻接不对称");
    const entry = state.entries.get("run-1");
    expect(entry).toMatchObject({
      kind: "preparing-review",
      runId: "run-1",
      reviewerSessionId: "rev-1",
      sourceSessionId: "src-1",
      branch: "3004",
      titleHint: "导出报错邻接不对称",
      insertedAt: T0,
    });
  });

  it("ignores runs of another project", () => {
    const state = applyRunUpdate(emptyPreparingReviews("p1"), run({ project_id: "p2" }), T0);
    expect(state.entries.size).toBe(0);
  });

  it("never creates a placeholder for a run first seen past preparing", () => {
    const state = applyRunUpdate(emptyPreparingReviews("p1"), run({ status: "waiting_reviewer" }), T0);
    expect(state.entries.size).toBe(0);
  });

  it("never creates a placeholder for a run without a reviewer id", () => {
    const state = applyRunUpdate(emptyPreparingReviews("p1"), run({ reviewer_session_id: null }), T0);
    expect(state.entries.size).toBe(0);
  });

  it("advances an existing entry and keeps its title hint", () => {
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0, "hint");
    state = applyRunUpdate(state, run({ status: "waiting_reviewer", updated_at: later(40_000) }), T0 + 40_000);
    expect(state.entries.get("run-1")).toMatchObject({ titleHint: "hint" });
    expect(state.entries.get("run-1")?.run.status).toBe("waiting_reviewer");
  });

  it("drops a lower-version update (a late poll cannot revert waiting_reviewer)", () => {
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    state = applyRunUpdate(state, run({ status: "waiting_reviewer", updated_at: later(40_000) }), T0 + 40_000);
    const reverted = applyRunUpdate(state, run({ status: "preparing", updated_at: later(30_000) }), T0 + 41_000);
    expect(reverted).toBe(state);
    expect(reverted.entries.get("run-1")?.run.status).toBe("waiting_reviewer");
  });

  it("removes the entry on a terminal status and tombstones it", () => {
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    state = applyRunUpdate(state, run({ status: "failed", error: "boom", updated_at: later(1_000) }), T0 + 1_000);
    expect(state.entries.size).toBe(0);
    expect(state.tombstones.get("run-1")).toBe(T0 + 1_000 + TOMBSTONE_TTL_MS);
  });

  it("does not resurrect a tombstoned run from a stale preparing snapshot", () => {
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    state = applyRunUpdate(state, run({ status: "cancelled", updated_at: later(1_000) }), T0 + 1_000);
    const stale = applyRunUpdate(state, run(), T0 + 2_000);
    expect(stale.entries.size).toBe(0);
  });

  it("lets the run back in once its tombstone expired", () => {
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    state = applyRunUpdate(state, run({ status: "cancelled", updated_at: later(1_000) }), T0 + 1_000);
    const revived = applyRunUpdate(state, run(), T0 + 1_000 + TOMBSTONE_TTL_MS + 1);
    expect(revived.entries.size).toBe(1);
  });

  it("ignores a terminal update for a run it never held", () => {
    const empty = emptyPreparingReviews("p1");
    expect(applyRunUpdate(empty, run({ status: "completed" }), T0)).toBe(empty);
  });
});

describe("applyBranchListing", () => {
  it("removes placeholders of that branch missing from a successful listing", () => {
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    state = applyRunUpdate(state, run({ id: "run-2", branch: "other", reviewer_session_id: "rev-2" }), T0);
    const next = applyBranchListing(state, "3004", [], T0 + 5_000);
    expect([...next.entries.keys()]).toEqual(["run-2"]);
    expect(next.tombstones.has("run-1")).toBe(true);
  });

  it("keeps placeholders the listing still carries and folds their updates", () => {
    const state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    const next = applyBranchListing(
      state, "3004", [run({ status: "waiting_reviewer", updated_at: later(40_000) })], T0 + 40_000,
    );
    expect(next.entries.get("run-1")?.run.status).toBe("waiting_reviewer");
  });

  it("treats null and the empty branch key as the same main workspace", () => {
    const state = applyRunUpdate(emptyPreparingReviews("p1"), run({ branch: null }), T0);
    expect(applyBranchListing(state, null, [], T0 + 1).entries.size).toBe(0);
  });

  it("does not remove a placeholder inserted after the listing was issued", () => {
    // Read issued at T0, Start clicked at T0+1s, read lands empty at T0+2s.
    const state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0 + 1_000);
    const next = applyBranchListing(state, "3004", [], T0 + 2_000, T0);
    expect(next.entries.size).toBe(1);
    expect(next.tombstones.size).toBe(0);
  });

  it("can seed a placeholder the listing reports as preparing", () => {
    const next = applyBranchListing(emptyPreparingReviews("p1"), "3004", [run()], T0);
    expect(next.entries.size).toBe(1);
  });
});

describe("expirePlaceholders", () => {
  it("hides a placeholder past the display bound and blocks its re-insertion", () => {
    const state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    const expired = expirePlaceholders(state, T0 + PLACEHOLDER_TTL_MS);
    expect(expired.entries.size).toBe(0);
    expect(applyRunUpdate(expired, run(), T0 + PLACEHOLDER_TTL_MS + 1).entries.size).toBe(0);
  });

  it("keeps a placeholder inside the bound and returns the same state", () => {
    const state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    expect(expirePlaceholders(state, T0 + PLACEHOLDER_TTL_MS - 1)).toBe(state);
  });

  it("forgets tombstones once they expire", () => {
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    state = applyRunUpdate(state, run({ status: "failed", updated_at: later(1) }), T0 + 1);
    expect(expirePlaceholders(state, T0 + 1 + TOMBSTONE_TTL_MS).tombstones.size).toBe(0);
  });
});

describe("preparingReviewRow / mergePreparingRows", () => {
  const entryOf = (state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0, null)) =>
    state.entries.get("run-1")!;

  it("builds a stand-in row under the reviewer id with a Review title", () => {
    expect(preparingReviewRow(entryOf(), "导出报错邻接不对称")).toEqual({
      id: "rev-1",
      projectId: "p1",
      branch: "3004",
      title: "Review - 导出报错邻接不对称",
      status: "preparing",
      processAlive: false,
      updated_at: new Date(T0).toISOString(),
      kind: "preparing-review",
      runId: "run-1",
    });
  });

  it("falls back to a bare Review title without a usable source title", () => {
    expect(preparingReviewRow(entryOf(), null).title).toBe("Review");
    expect(preparingReviewRow(entryOf(), "New Session").title).toBe("Review");
  });

  it("adds the placeholder to its branch ahead of the live rows", () => {
    const live: ResidentSidebarSession = {
      id: "src-1", projectId: "p1", branch: "3004", title: "源", status: "idle", processAlive: true,
    };
    const merged = mergePreparingRows(new Map([["3004", [live]]]), [entryOf()], () => "源");
    expect(merged.get("3004")?.map((row) => row.id)).toEqual(["rev-1", "src-1"]);
    expect(merged.get("3004")?.[0].title).toBe("Review - 源");
  });

  it("lets the live row win once /alive lists the reviewer", () => {
    const real: ResidentSidebarSession = {
      id: "rev-1", projectId: "p1", branch: "3004", title: "Review - 源", status: "running", processAlive: true,
    };
    const resident = new Map([["3004", [real]]]);
    const merged = mergePreparingRows(resident, [entryOf()], () => null);
    expect(merged.get("3004")).toEqual([real]);
  });

  it("keeps the placeholder retired after the reviewer's process exits", () => {
    // The run is still active (waiting_feedback) long after the reviewer's
    // turn ended, and a hibernated reviewer drops out of /alive. Without the
    // appearedAt latch the grey preparing row would reappear over a session
    // that exists and opens fine.
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    state = applyRunUpdate(state, run({ status: "waiting_feedback", updated_at: later(60_000) }), T0 + 60_000);
    state = markAppeared(state, new Set(["rev-1"]), T0 + 61_000);
    const entry = state.entries.get("run-1")!;
    expect(entry.appearedAt).toBe(T0 + 61_000);
    expect(mergePreparingRows(new Map(), [entry], () => null).size).toBe(0);
    expect(resolvePreparingSwitch(entry, new Set())).toEqual({
      kind: "switch", branch: "3004", sessionId: "rev-1",
    });
  });

  it("returns the input map untouched when nothing is preparing", () => {
    const resident = new Map<string, ResidentSidebarSession[]>();
    expect(mergePreparingRows(resident, [], () => null)).toBe(resident);
  });
});

describe("markAppeared", () => {
  const preparing = () => applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);

  it("keeps the first sighting and returns the same state afterwards", () => {
    const marked = markAppeared(preparing(), new Set(["rev-1"]), T0 + 1_000);
    expect(marked.entries.get("run-1")!.appearedAt).toBe(T0 + 1_000);
    expect(markAppeared(marked, new Set(["rev-1"]), T0 + 9_000)).toBe(marked);
    expect(markAppeared(marked, new Set(), T0 + 9_000)).toBe(marked);
  });

  it("leaves a reviewer that is not listed alone", () => {
    const state = preparing();
    expect(markAppeared(state, new Set(["other"]), T0 + 1_000)).toBe(state);
  });

  it("survives a later run update", () => {
    let state = markAppeared(preparing(), new Set(["rev-1"]), T0 + 1_000);
    state = applyRunUpdate(state, run({ status: "waiting_feedback", updated_at: later(2_000) }), T0 + 2_000);
    expect(state.entries.get("run-1")!.appearedAt).toBe(T0 + 1_000);
  });
});

describe("resolvePreparingSwitch", () => {
  const entryWith = (status: WorkflowRun["status"]) => {
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    if (status !== "preparing") {
      state = applyRunUpdate(state, run({ status, updated_at: later(1_000) }), T0 + 1_000);
    }
    return state.entries.get("run-1");
  };

  it("waits while the run is still preparing", () => {
    expect(resolvePreparingSwitch(entryWith("preparing"), new Set(["rev-1"]))).toEqual({ kind: "wait" });
  });

  it("waits on waiting_reviewer until /alive lists the reviewer", () => {
    expect(resolvePreparingSwitch(entryWith("waiting_reviewer"), new Set())).toEqual({ kind: "wait" });
  });

  it("switches once the reviewer is live", () => {
    expect(resolvePreparingSwitch(entryWith("waiting_reviewer"), new Set(["rev-1"]))).toEqual({
      kind: "switch", branch: "3004", sessionId: "rev-1",
    });
  });

  it("reports a removed run as gone", () => {
    expect(resolvePreparingSwitch(undefined, new Set(["rev-1"]))).toEqual({ kind: "gone" });
    expect(resolvePreparingSwitch(entryWith("failed"), new Set(["rev-1"]))).toEqual({ kind: "gone" });
  });
});
