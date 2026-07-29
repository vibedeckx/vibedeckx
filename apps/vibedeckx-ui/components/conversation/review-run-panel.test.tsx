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
    getActiveWorkflowRuns: vi.fn(async () => [runFixture]),
    workflowRunGate: vi.fn(async () => runFixture),
    cancelWorkflowRun: vi.fn(async () => runFixture),
  },
}));
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

import { ReviewRunPanel } from "./review-run-panel";
import { api } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReviewRunPanel discussing state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} />);
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
