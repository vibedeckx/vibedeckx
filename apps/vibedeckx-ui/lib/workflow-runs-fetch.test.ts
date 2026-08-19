import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRun } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: { getActiveWorkflowRuns: vi.fn() },
}));

import { api } from "@/lib/api";
import { fetchActiveWorkflowRuns, resetWorkflowRunsInflightForTests } from "./workflow-runs-fetch";

const getActiveWorkflowRuns = api.getActiveWorkflowRuns as unknown as ReturnType<typeof vi.fn>;

function deferred() {
  let resolve!: (v: WorkflowRun[]) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<WorkflowRun[]>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("fetchActiveWorkflowRuns", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetWorkflowRunsInflightForTests();
  });

  it("shares one request between concurrent same-key callers", async () => {
    const d = deferred();
    getActiveWorkflowRuns.mockReturnValue(d.promise);
    const a = fetchActiveWorkflowRuns("p1", "dev");
    const b = fetchActiveWorkflowRuns("p1", "dev");
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(1);
    d.resolve([]);
    expect(await a).toEqual([]);
    expect(await b).toEqual([]);
  });

  it("does not cache: a call after settlement issues a new request", async () => {
    getActiveWorkflowRuns.mockResolvedValue([]);
    await fetchActiveWorkflowRuns("p1", "dev");
    await fetchActiveWorkflowRuns("p1", "dev");
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(2);
  });

  it("keys by project + branch (null branch distinct from a named one)", () => {
    getActiveWorkflowRuns.mockReturnValue(deferred().promise);
    fetchActiveWorkflowRuns("p1", "dev");
    fetchActiveWorkflowRuns("p1", null);
    fetchActiveWorkflowRuns("p2", "dev");
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(3);
  });

  it("force bypasses and replaces an in-flight entry issued in an earlier tick", async () => {
    const first = deferred();
    const second = deferred();
    getActiveWorkflowRuns.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = fetchActiveWorkflowRuns("p1", "dev");
    await Promise.resolve(); // `a` predates the event that motivates the force
    const b = fetchActiveWorkflowRuns("p1", "dev", { force: true });
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(b).not.toBe(a);
    // A later non-force caller rides the newer (forced) request.
    expect(fetchActiveWorkflowRuns("p1", "dev")).toBe(b);
    // The superseded request settling must not evict the newer entry.
    first.resolve([]);
    await a;
    expect(fetchActiveWorkflowRuns("p1", "dev")).toBe(b);
    second.resolve([]);
    await b;
  });

  it("same-tick forces share one request (two components reacting to one event)", async () => {
    // ReviewRunPanel and useReviewerRun both compute force=true on the same
    // streamEpoch bump and run in the same effect flush. Both are issued after
    // the event, so the second can ride the first: one tunnel round-trip, not two.
    const d = deferred();
    getActiveWorkflowRuns.mockReturnValueOnce(d.promise).mockReturnValue(deferred().promise);
    const a = fetchActiveWorkflowRuns("p1", "dev", { force: true });
    const b = fetchActiveWorkflowRuns("p1", "dev", { force: true });
    const c = fetchActiveWorkflowRuns("p1", "dev"); // non-force rides along too
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    // Next tick: a force is a genuinely later read and must not reuse `a`.
    await Promise.resolve();
    const later = fetchActiveWorkflowRuns("p1", "dev", { force: true });
    expect(later).not.toBe(a);
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(2);
    d.resolve([]);
    await a;
  });

  it("a rejected request is cleared and surfaces to callers", async () => {
    const d = deferred();
    getActiveWorkflowRuns.mockReturnValueOnce(d.promise);
    const a = fetchActiveWorkflowRuns("p1", "dev");
    d.reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    getActiveWorkflowRuns.mockResolvedValue([]);
    await fetchActiveWorkflowRuns("p1", "dev");
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(2);
  });
});
