// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRun } from "@/lib/api";
import { applyRunUpdate, emptyPreparingReviews } from "@/hooks/preparing-reviews";

// The whole point of this view is that it never touches a session: the api
// mock exposes the one run read it may use and nothing else, so any session
// call would throw at render time.
const getWorkflowRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { getWorkflowRun } }));

import { PreparingReviewView } from "./preparing-review-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const entryFor = (r: WorkflowRun) => applyRunUpdate(emptyPreparingReviews("p1"), r, T0).entries.get(r.id);

let root: Root;
let container: HTMLDivElement;
const onOpenSource = vi.fn();

beforeEach(() => {
  getWorkflowRun.mockReset();
  onOpenSource.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function render(entry: ReturnType<typeof entryFor>) {
  await act(async () => {
    root.render(
      <PreparingReviewView runId="run-1" entry={entry} title="Review - 源" onOpenSource={onOpenSource} />,
    );
  });
}

describe("PreparingReviewView", () => {
  it("shows the preparing placeholder from the store entry without any request", async () => {
    await render(entryFor(run()));
    expect(container.textContent).toContain("Preparing review…");
    expect(container.textContent).toContain("Summarizing the source conversation");
    expect(getWorkflowRun).not.toHaveBeenCalled();
  });

  it("switches copy once the run advanced but the reviewer is not live yet", async () => {
    const advanced = applyRunUpdate(
      emptyPreparingReviews("p1"),
      run({ status: "waiting_reviewer", updated_at: new Date(T0 + 1).toISOString() }),
      T0,
    );
    // A store never inserts a run first seen past preparing; build it the real way.
    let state = applyRunUpdate(emptyPreparingReviews("p1"), run(), T0);
    state = applyRunUpdate(state, run({ status: "waiting_reviewer", updated_at: new Date(T0 + 1).toISOString() }), T0 + 1);
    expect(advanced.entries.size).toBe(0);
    await render(state.entries.get("run-1"));
    expect(container.textContent).toContain("The reviewer is starting");
  });

  it("navigates back to the source conversation", async () => {
    await render(entryFor(run()));
    const button = container.querySelector("button")!;
    await act(async () => { button.click(); });
    expect(onOpenSource).toHaveBeenCalledWith("src-1", "3004");
  });

  it("reads the run by id once the entry is gone and shows a failure", async () => {
    getWorkflowRun.mockResolvedValue(run({ status: "failed", error: "distillation timed out" }));
    await render(undefined);
    await act(async () => { await Promise.resolve(); });
    expect(getWorkflowRun).toHaveBeenCalledWith("run-1");
    expect(container.textContent).toContain("Review setup failed");
    expect(container.textContent).toContain("distillation timed out");
  });

  it("shows cancelled and completed outcomes", async () => {
    getWorkflowRun.mockResolvedValue(run({ status: "cancelled" }));
    await render(undefined);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("Review cancelled");
  });

  it("offers a retry when the status read itself fails, and recovers", async () => {
    // The by-id read is the only thing that can move this view forward once
    // the entry is gone; a tunnel blip must not leave a spinner with no way
    // out, since nothing else re-renders the view afterwards.
    getWorkflowRun.mockRejectedValueOnce(new Error("tunnel down"));
    await render(undefined);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("Could not read the review status");
    expect(container.textContent).toContain("tunnel down");

    getWorkflowRun.mockResolvedValueOnce(run({ status: "cancelled" }));
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Retry"))!;
    await act(async () => { retry.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(getWorkflowRun).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Review cancelled");
  });

  it("reports a run the server no longer has", async () => {
    getWorkflowRun.mockResolvedValue(null);
    await render(undefined);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("Review no longer available");
  });
});
