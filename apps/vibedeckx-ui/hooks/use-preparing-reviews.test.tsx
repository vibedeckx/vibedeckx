// @vitest-environment jsdom
//
// The preparing-review store's inputs race: the create response, the global
// SSE event and a per-branch listing that is a proxied remote read for remote
// projects. These cases pin the behaviours the sidebar depends on — a
// placeholder appears from the create response alone, a listing that
// predates it cannot remove it, a later listing that lacks it does, a failed
// read never does, and a slower earlier read cannot land over a newer one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRun } from "@/lib/api";

type Deferred = {
  resolve: (runs: WorkflowRun[]) => void;
  reject: (err: unknown) => void;
  request: Promise<WorkflowRun[]>;
  issuedAt: number;
};
const pending: Deferred[] = [];
const fetchActiveWorkflowRunsAt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workflow-runs-fetch", () => ({ fetchActiveWorkflowRunsAt }));

let capturedListener: ((evt: { type?: string; [k: string]: unknown }) => void) | null = null;
vi.mock("@/hooks/global-event-stream", () => ({
  useGlobalEventStream: (listener: (evt: unknown) => void) => {
    capturedListener = listener;
  },
  useConnectionStatus: () => ({ state: "live" }),
}));

import { usePreparingReviews, PREPARING_REVIEW_POLL_MS, type PreparingReviews } from "./use-preparing-reviews";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const probe: { current: PreparingReviews | null } = { current: null };

function Probe({ projectId, branch }: { projectId: string | null; branch: string | null }) {
  probe.current = usePreparingReviews(projectId, branch);
  return null;
}

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

let root: Root;
let container: HTMLDivElement;

async function mount(projectId: string | null = "p1", branch: string | null = "3004") {
  await act(async () => {
    root.render(<Probe projectId={projectId} branch={branch} />);
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function resolveRead(index: number, runs: WorkflowRun[]) {
  await act(async () => {
    pending[index].resolve(runs);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  pending.length = 0;
  fetchActiveWorkflowRunsAt.mockReset();
  fetchActiveWorkflowRunsAt.mockImplementation(() => {
    let resolve!: (runs: WorkflowRun[]) => void;
    let reject!: (err: unknown) => void;
    const request = new Promise<WorkflowRun[]>((res, rej) => { resolve = res; reject = rej; });
    const entry: Deferred = { resolve, reject, request, issuedAt: Date.now() };
    pending.push(entry);
    return { request, issuedAt: entry.issuedAt };
  });
  capturedListener = null;
  probe.current = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

describe("usePreparingReviews", () => {
  it("shows a placeholder from the create response alone, with no SSE event", async () => {
    await mount();
    await resolveRead(0, []); // seed: nothing preparing yet
    await act(async () => { probe.current!.addRun(run(), "源标题"); });
    expect(probe.current!.entries.map((e) => e.runId)).toEqual(["run-1"]);
    expect(probe.current!.entries[0].titleHint).toBe("源标题");
  });

  it("keeps a placeholder that a seed read issued before Start reports missing", async () => {
    await mount(); // seed issued at T0, still pending
    vi.setSystemTime(T0 + 1_000);
    await act(async () => { probe.current!.addRun(run()); });
    vi.setSystemTime(T0 + 2_000);
    await resolveRead(0, []); // the pre-Start read lands empty
    expect(probe.current!.entries).toHaveLength(1);
  });

  it("removes the placeholder when a later listing of its branch lacks it", async () => {
    await mount();
    await resolveRead(0, []);
    await act(async () => { probe.current!.addRun(run()); });
    vi.setSystemTime(T0 + PREPARING_REVIEW_POLL_MS);
    await act(async () => { vi.advanceTimersByTime(PREPARING_REVIEW_POLL_MS); });
    expect(fetchActiveWorkflowRunsAt).toHaveBeenLastCalledWith("p1", "3004", { force: true });
    await resolveRead(1, []); // terminal runs are absent from the active listing
    expect(probe.current!.entries).toHaveLength(0);
    expect(probe.current!.pollTick).toBe(1);
  });

  it("does not treat a failed read as an empty listing", async () => {
    await mount();
    await resolveRead(0, []);
    await act(async () => { probe.current!.addRun(run()); });
    await act(async () => { vi.advanceTimersByTime(PREPARING_REVIEW_POLL_MS); });
    await act(async () => {
      pending[1].reject(new Error("tunnel down"));
      await Promise.resolve();
    });
    await settle();
    expect(probe.current!.entries).toHaveLength(1);
  });

  it("removes the placeholder on a terminal SSE event", async () => {
    await mount();
    await resolveRead(0, []);
    await act(async () => { probe.current!.addRun(run()); });
    await act(async () => {
      capturedListener!({
        type: "workflow:run-updated",
        projectId: "p1",
        branch: "3004",
        run: run({ status: "failed", error: "boom", updated_at: new Date(T0 + 500).toISOString() }),
      });
    });
    expect(probe.current!.entries).toHaveLength(0);
  });

  it("ignores events for other projects", async () => {
    await mount();
    await resolveRead(0, []);
    await act(async () => {
      capturedListener!({ type: "workflow:run-updated", projectId: "p2", branch: "x", run: run({ project_id: "p2" }) });
    });
    expect(probe.current!.entries).toHaveLength(0);
  });

  it("lists the reviewer as awaited once the run leaves preparing", async () => {
    await mount();
    await resolveRead(0, []);
    await act(async () => { probe.current!.addRun(run()); });
    expect(probe.current!.awaitedSessionIds).toEqual([]);
    await act(async () => {
      capturedListener!({
        type: "workflow:run-updated",
        projectId: "p1",
        branch: "3004",
        run: run({ status: "waiting_reviewer", updated_at: new Date(T0 + 40_000).toISOString() }),
      });
    });
    expect(probe.current!.entries[0].run.status).toBe("waiting_reviewer");
    expect(probe.current!.awaitedSessionIds).toEqual(["rev-1"]);
  });

  it("lets only the newest read of a branch land", async () => {
    await mount();
    await resolveRead(0, []);
    await act(async () => { probe.current!.addRun(run()); });
    await act(async () => { vi.advanceTimersByTime(PREPARING_REVIEW_POLL_MS); }); // read #1
    await act(async () => { vi.advanceTimersByTime(PREPARING_REVIEW_POLL_MS); }); // read #2
    expect(pending).toHaveLength(3);
    // The newer read still lists the run as advanced...
    await resolveRead(2, [run({ status: "waiting_reviewer", updated_at: new Date(T0 + 9_000).toISOString() })]);
    expect(probe.current!.entries[0].run.status).toBe("waiting_reviewer");
    // ...and the slower, older read that lacks it must not remove it.
    await resolveRead(1, []);
    expect(probe.current!.entries).toHaveLength(1);
  });

  it("still lands a poll response the next tick already overtook", async () => {
    await mount();
    await resolveRead(0, []);
    await act(async () => { probe.current!.addRun(run()); });
    await act(async () => { vi.advanceTimersByTime(PREPARING_REVIEW_POLL_MS); }); // read #1
    await act(async () => { vi.advanceTimersByTime(PREPARING_REVIEW_POLL_MS); }); // read #2, #1 still out
    // A remote read slower than the poll cadence is never the newest issued;
    // dropping it on that ground alone would freeze the branch forever.
    await resolveRead(1, [run({ status: "waiting_reviewer", updated_at: new Date(T0 + 6_000).toISOString() })]);
    expect(probe.current!.entries[0].run.status).toBe("waiting_reviewer");
    // And the cleanup signal still gets through on the same terms.
    await resolveRead(2, []);
    expect(probe.current!.entries).toHaveLength(0);
  });

  it("retires a placeholder for good once its reviewer is listed alive", async () => {
    await mount();
    await resolveRead(0, []);
    await act(async () => { probe.current!.addRun(run()); });
    await act(async () => {
      capturedListener!({
        type: "workflow:run-updated",
        projectId: "p1",
        branch: "3004",
        run: run({ status: "waiting_reviewer", updated_at: new Date(T0 + 40_000).toISOString() }),
      });
    });
    expect(probe.current!.awaitedSessionIds).toEqual(["rev-1"]);
    await act(async () => { probe.current!.markAppeared(new Set(["rev-1"])); });
    expect(probe.current!.entries[0].appearedAt).toBe(T0);
    expect(probe.current!.awaitedSessionIds).toEqual([]);
    // The reviewer's process later exits: the entry stays retired, and its
    // branch is no longer polled for a row that will never come back.
    await act(async () => { probe.current!.markAppeared(new Set()); });
    expect(probe.current!.entries[0].appearedAt).toBe(T0);
    const calls = fetchActiveWorkflowRunsAt.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(PREPARING_REVIEW_POLL_MS * 2); });
    expect(fetchActiveWorkflowRunsAt.mock.calls.length).toBe(calls);
  });

  it("retires an entry that arrives after its reviewer was already listed alive", async () => {
    // The caller reports /alive whenever it changes, so a reviewer listed
    // BEFORE its run is known here (a create response or a `preparing` frame
    // that lands late) would otherwise never be reconciled — and the grey row
    // would come back the moment that process exits.
    await mount();
    await resolveRead(0, []);
    await act(async () => { probe.current!.markAppeared(new Set(["rev-1"])); });
    await act(async () => { probe.current!.addRun(run()); });
    expect(probe.current!.entries[0].appearedAt).not.toBeNull();

    await act(async () => { probe.current!.markAppeared(new Set()); }); // process exits
    expect(probe.current!.entries[0].appearedAt).not.toBeNull();
    const calls = fetchActiveWorkflowRunsAt.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(PREPARING_REVIEW_POLL_MS * 2); });
    expect(fetchActiveWorkflowRunsAt.mock.calls.length).toBe(calls);
  });

  it("stops polling once nothing is preparing", async () => {
    await mount();
    await resolveRead(0, []);
    const calls = fetchActiveWorkflowRunsAt.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(PREPARING_REVIEW_POLL_MS * 3); });
    expect(fetchActiveWorkflowRunsAt.mock.calls.length).toBe(calls);
  });

  it("drops the previous project's placeholders on a project switch", async () => {
    await mount(); // p1's seed read stays in flight across the switch
    await act(async () => { probe.current!.addRun(run()); });
    await mount("p2", null);
    expect(probe.current!.entries).toHaveLength(0);
    // p1's own read lands after the switch: it must not repopulate p2.
    await resolveRead(0, [run()]);
    expect(probe.current!.entries).toHaveLength(0);
  });

  it("keeps a placeholder when a re-seed shares a request issued before Start", async () => {
    await mount(); // seed read #0 issued at T0, still in flight
    vi.setSystemTime(T0 + 1_000);
    await act(async () => { probe.current!.addRun(run()); });
    await mount("p1", "other"); // read #1, another branch
    // Back to the original branch while its pre-Start read is still out: the
    // merge layer hands the SAME request back, so "when was this asked" is
    // T0 — before the placeholder existed — not the moment of this call.
    vi.setSystemTime(T0 + 2_000);
    fetchActiveWorkflowRunsAt.mockImplementationOnce(
      () => ({ request: pending[0].request, issuedAt: pending[0].issuedAt }),
    );
    await mount("p1", "3004");
    await resolveRead(0, []);
    expect(probe.current!.entries).toHaveLength(1);
  });
});
