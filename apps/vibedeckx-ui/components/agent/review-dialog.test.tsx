// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getReviewerCandidate, createWorkflowRun } = vi.hoisted(() => ({
  getReviewerCandidate: vi.fn(),
  createWorkflowRun: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, getReviewerCandidate, createWorkflowRun } };
});

import { ReviewDialog } from "./review-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  document.body.querySelectorAll("[data-radix-portal]").forEach((node) => node.remove());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function renderAndOpen(candidate: unknown) {
  getReviewerCandidate.mockResolvedValueOnce(candidate);
  createWorkflowRun.mockResolvedValue({});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ReviewDialog
        projectId="p1"
        branch="dev"
        sessionId="s-src"
        currentAgentType="claude-code"
        providers={[
          { type: "claude-code", displayName: "Claude Code", available: true },
          { type: "codex", displayName: "Codex", available: true },
        ]}
      />,
    );
  });
  const trigger = container.querySelector("button")!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button"))
    .find((node) => node.textContent?.includes(text));
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

describe("ReviewDialog reviewer reuse", () => {
  it("defaults to the previous reviewer and submits its session id", async () => {
    await renderAndOpen({
      available: true,
      sessionId: "s-rev",
      title: "Review - Fix login",
      agentType: "codex",
      reason: null,
    });

    expect(document.body.textContent).toContain("Review - Fix login");
    await act(async () => {
      button("开始 Review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
    }));
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("reviewerAgentType");
  });

  it("can switch to a new reviewer session and submit an agent type", async () => {
    await renderAndOpen({
      available: true,
      sessionId: "s-rev",
      title: "Review - Fix login",
      agentType: "codex",
      reason: null,
    });

    await act(async () => {
      button("创建新 Reviewer Session").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Reviewer agent");
    await act(async () => {
      button("开始 Review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "s-src",
      reviewerAgentType: "codex",
    }));
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("reviewerSessionId");
  });

  it("falls back to a new reviewer when the previous one is unavailable", async () => {
    await renderAndOpen({
      available: false,
      sessionId: null,
      title: null,
      agentType: null,
      reason: "deleted",
    });

    expect(document.body.textContent).toContain("上次 reviewer 已不可用");
    expect(document.body.textContent).toContain("Reviewer agent");
  });
});
