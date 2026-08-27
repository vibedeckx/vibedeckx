// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRun } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    getActiveWorkflowRuns: vi.fn(),
  },
}));

import { useReviewerRun } from "./use-reviewer-run";
import { api } from "@/lib/api";
import { resetWorkflowRunsInflightForTests } from "@/lib/workflow-runs-fetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getActiveWorkflowRuns = api.getActiveWorkflowRuns as unknown as ReturnType<typeof vi.fn>;

function makeRun(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: "r1",
    project_id: "p1",
    branch: "dev",
    source_session_id: "s-src",
    source_turn_end_index: 4,
    reviewer_session_id: "s-rev",
    review_focus: null,
    review_target: null,
    feedback_snapshot: null,
    status: "discussing",
    error: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

const REVIEWER = { id: "s-rev", projectId: "p1", branch: "dev" };

function Probe({
  runUpdate,
  streamEpoch = 0,
  session = REVIEWER,
  projectId = "p1",
  branch = "dev",
}: {
  runUpdate: WorkflowRun | null;
  streamEpoch?: number;
  session?: { id: string; projectId: string; branch: string | null } | null;
  projectId?: string;
  branch?: string | null;
}) {
  const run = useReviewerRun(projectId, branch, session, runUpdate, streamEpoch);
  return <div data-status>{run?.status ?? "none"}</div>;
}

describe("useReviewerRun", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    resetWorkflowRunsInflightForTests();
  });

  it("frame-wins: a later WS frame is not overwritten by a slow, stale REST response", async () => {
    let resolveRest: (v: { runs: WorkflowRun[] }) => void;
    getActiveWorkflowRuns.mockReturnValue(
      new Promise<{ runs: WorkflowRun[] }>((r) => { resolveRest = r; }),
    );

    await act(async () => {
      root.render(<Probe runUpdate={null} />);
    });
    expect(container.textContent).toBe("none");

    // A workflowRunUpdated WS frame lands while the REST GET is still pending.
    const discussingFrame = makeRun({ status: "discussing" });
    await act(async () => {
      root.render(<Probe runUpdate={discussingFrame} />);
    });
    expect(container.textContent).toBe("discussing");

    // The slow REST GET now resolves with pre-transition (stale) data.
    await act(async () => {
      resolveRest({ runs: Array.of(makeRun({ status: "waiting_feedback" })) });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The newer frame state must win — not be clobbered by the stale seed.
    expect(container.textContent).toBe("discussing");
  });

  it("seed lands when no frame has arrived yet", async () => {
    let resolveRest: (v: { runs: WorkflowRun[] }) => void;
    getActiveWorkflowRuns.mockReturnValue(
      new Promise<{ runs: WorkflowRun[] }>((r) => { resolveRest = r; }),
    );

    await act(async () => {
      root.render(<Probe runUpdate={null} />);
    });
    expect(container.textContent).toBe("none");

    await act(async () => {
      resolveRest({ runs: Array.of(makeRun({ status: "waiting_feedback" })) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe("waiting_feedback");
  });

  it("re-seeds on a stream epoch bump, recovering a frame lost while disconnected", async () => {
    // The transition happens while the socket is down: broadcastRaw writes to
    // an empty subscriber set and subscribe() never replays that frame, so the
    // hook sees no runUpdate at all — exactly the bug where the finalize button
    // stayed missing until the user switched sessions. The reconnect's Ready
    // bumps streamEpoch, which must re-read the authoritative REST state.
    // Not mockResolvedValueOnce: an unconsumed once-value would survive
    // clearAllMocks and leak into the next test if the re-seed regressed away.
    getActiveWorkflowRuns.mockResolvedValue({ runs: Array.of(makeRun({ status: "waiting_feedback" })) });

    await act(async () => {
      root.render(<Probe runUpdate={null} streamEpoch={0} />);
    });
    expect(container.textContent).toBe("waiting_feedback");

    // Server moved the run to `discussing` while nobody was subscribed.
    getActiveWorkflowRuns.mockResolvedValue({ runs: Array.of(makeRun({ status: "discussing" })) });

    await act(async () => {
      root.render(<Probe runUpdate={null} streamEpoch={1} />);
    });

    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("discussing");
  });

  it("a terminal-status frame clears the run", async () => {
    // Never resolves — mount settles on the seed's initial "none" and stays
    // there, so only frame transitions (not the seed) drive this test. The
    // seed effect only re-runs on projectId/branch/sessionId/streamEpoch
    // changes, none of which happen across these rerenders, so it can't race
    // the frames.
    getActiveWorkflowRuns.mockReturnValue(new Promise<never>(() => {}));

    await act(async () => {
      root.render(<Probe runUpdate={null} />);
    });
    expect(container.textContent).toBe("none");

    await act(async () => {
      root.render(<Probe runUpdate={makeRun({ status: "discussing" })} />);
    });
    expect(container.textContent).toBe("discussing");

    await act(async () => {
      root.render(<Probe runUpdate={makeRun({ status: "completed" })} />);
    });
    expect(container.textContent).toBe("none");
  });

  it("does not seed with a session that belongs to another workspace", async () => {
    // Cross-project / cross-branch switch: AgentConversation stays mounted and
    // for one commit the hook still sees the OLD workspace's session while
    // projectId/branch already point at the new one. That read is pure waste
    // (its sessionId can never match a run in the new workspace).
    getActiveWorkflowRuns.mockResolvedValue({ runs: [] });

    await act(async () => {
      root.render(<Probe runUpdate={null} projectId="p2" branch="dev7"
        session={{ id: "s-old", projectId: "p1", branch: "dev" }} />);
    });
    expect(getActiveWorkflowRuns).not.toHaveBeenCalled();

    // Same project, different branch — still stale, still no read.
    await act(async () => {
      root.render(<Probe runUpdate={null} projectId="p2" branch="dev7"
        session={{ id: "s-old", projectId: "p2", branch: "dev" }} />);
    });
    expect(getActiveWorkflowRuns).not.toHaveBeenCalled();

    // The matching session lands next frame → exactly one seed.
    getActiveWorkflowRuns.mockResolvedValue({ runs: Array.of(makeRun({ project_id: "p2", branch: "dev7", reviewer_session_id: "s-new" })) });
    await act(async () => {
      root.render(<Probe runUpdate={null} projectId="p2" branch="dev7"
        session={{ id: "s-new", projectId: "p2", branch: "dev7" }} />);
    });
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(1);
    expect(getActiveWorkflowRuns).toHaveBeenCalledWith("p2", "dev7");
    expect(container.textContent).toBe("discussing");
  });

  it("an epoch bump forces a fresh read even while an older one is in flight", async () => {
    // The pre-Ready read may predate the transition; sharing it would defeat
    // the reconciliation the epoch exists for.
    let resolveFirst: (v: { runs: WorkflowRun[] }) => void;
    getActiveWorkflowRuns.mockReturnValueOnce(
      new Promise<{ runs: WorkflowRun[] }>((r) => { resolveFirst = r; }),
    );
    getActiveWorkflowRuns.mockResolvedValue({ runs: Array.of(makeRun({ status: "discussing" })) });

    await act(async () => {
      root.render(<Probe runUpdate={null} streamEpoch={0} />);
    });
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<Probe runUpdate={null} streamEpoch={1} />);
    });
    expect(getActiveWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("discussing");

    // The superseded first read resolving late is ignored (its effect was cleaned up).
    await act(async () => {
      resolveFirst!({ runs: Array.of(makeRun({ status: "waiting_feedback" })) });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toBe("discussing");
  });
});
