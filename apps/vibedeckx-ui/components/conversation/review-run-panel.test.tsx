// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runFixture = {
  id: "r1", project_id: "p1", branch: "dev",
  source_session_id: "s-src", source_turn_end_index: 4,
  reviewer_session_id: "s-rev", review_focus: null, review_target: null,
  review_span: "this_turn", feedback_snapshot: "old feedback",
  status: "discussing", error: null, created_at: "", updated_at: "",
};

vi.mock("@/lib/api", () => ({
  api: {
    getActiveWorkflowRuns: vi.fn(async () => ({ runs: [runFixture] })),
    workflowRunGate: vi.fn(async () => runFixture),
    cancelWorkflowRun: vi.fn(async () => runFixture),
  },
}));
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

import { ReviewRunPanel } from "./review-run-panel";
import { api } from "@/lib/api";
import { resetWorkflowRunsInflightForTests } from "@/lib/workflow-runs-fetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReviewRunPanel discussing state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the discussing hint and an icon-only finalize button", async () => {
    expect(container.textContent).toContain("讨论中");
    const btn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="生成 review 终稿"]',
    );
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe("");
    // 讨论态不显示发送/编辑(那是 waiting_feedback 的控件)。
    expect(container.textContent).not.toContain("发送反馈给原 session");
  });

  it("clicking finalize calls the gate with the finalize action", async () => {
    const btn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="生成 review 终稿"]',
    )!;
    await act(async () => { btn.click(); });
    expect(api.workflowRunGate).toHaveBeenCalledWith("r1", "finalize");
  });
});

describe("ReviewRunPanel WS reconnect reconciliation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetWorkflowRunsInflightForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // 掉线期间发出的 WorkflowRunUpdated 是丢帧且不重放的,面板手里 0 条 run 时
  // 又不会轮询 —— 没有这次对账,重连后面板会一直空着(2026-08-18 事故)。
  it("re-reads on a streamEpoch bump and surfaces a run pushed while the socket was down", async () => {
    const waiting = { ...runFixture, status: "waiting_feedback" as const, feedback_snapshot: "verdict" };
    vi.mocked(api.getActiveWorkflowRuns)
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValueOnce({ runs: [waiting] });

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    expect(container.textContent).toBe("");

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={1} />);
    });
    expect(api.getActiveWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("等你确认反馈");
  });

  it("does not re-read when nothing but an unrelated re-render happens", async () => {
    vi.mocked(api.getActiveWorkflowRuns).mockResolvedValue({ runs: [] });

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    expect(api.getActiveWorkflowRuns).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewRunPanel out-of-order reads", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetWorkflowRunsInflightForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // mount 的那次读发出得早、返回得晚(远程代理往返会互相超车)。它带的是 run 出现
  // 之前的空快照,若允许落地就会把重连对账刚拉到的 run 再抹掉。
  it("keeps the newest read when an earlier one resolves last", async () => {
    const waiting = { ...runFixture, status: "waiting_feedback" as const };
    let resolveMount: (payload: { runs: typeof waiting[] }) => void = () => {};
    vi.mocked(api.getActiveWorkflowRuns)
      .mockReturnValueOnce(new Promise((resolve) => { resolveMount = resolve; }))
      .mockResolvedValueOnce({ runs: [waiting] });

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    // 重连对账:第二次读先返回,面板显示 run。
    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={1} />);
    });
    expect(container.textContent).toContain("等你确认反馈");

    // mount 那次姗姗来迟的空快照必须被丢弃。
    await act(async () => { resolveMount({ runs: [] }); });
    expect(container.textContent).toContain("等你确认反馈");
  });
});
