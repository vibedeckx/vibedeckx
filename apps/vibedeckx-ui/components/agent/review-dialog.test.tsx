// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getReviewerCandidate, createWorkflowRun, generateReviewIntentBrief } = vi.hoisted(() => ({
  getReviewerCandidate: vi.fn(),
  createWorkflowRun: vi.fn(),
  generateReviewIntentBrief: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, getReviewerCandidate, createWorkflowRun, generateReviewIntentBrief },
  };
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

describe("ReviewDialog intent brief", () => {
  it("pre-generates on open without waiting for the reviewer candidate", async () => {
    // Distillation is the long pole (model calls, tens of seconds); anything
    // serial ahead of it lands on the user as submit-time latency.
    let resolveCandidate: (value: unknown) => void = () => {};
    getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { resolveCandidate = resolve; }));
    createWorkflowRun.mockResolvedValue({});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ReviewDialog projectId="p1" branch="dev" sessionId="s-src" />);
    });
    await act(async () => {
      container!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(generateReviewIntentBrief).toHaveBeenCalledWith("p1", "s-src");
    await act(async () => {
      resolveCandidate(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  // Omitting the field would read server-side as "the client never tried" and
  // trigger a second full distillation inside the create request.
  it("reports a failed pre-generation as an attempt rather than omitting it", async () => {
    generateReviewIntentBrief.mockResolvedValueOnce(null);
    await renderAndOpen({ available: false, sessionId: null, title: null, agentType: null, reason: "deleted" });
    await act(async () => {
      button("开始 Review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ intentBrief: "" }));
  });

  // A rejection means the request never got an answer (auth, 404, network) —
  // the route returns 200 + {brief: null} when distillation itself yields
  // nothing. Nothing was distilled, so the server's own pass is still worth
  // having: omit the field rather than suppressing it with "".
  it("omits the field when the pre-generation request never reached the server", async () => {
    generateReviewIntentBrief.mockRejectedValueOnce(new Error("Failed to generate intent brief: 503"));
    await renderAndOpen({ available: false, sessionId: null, title: null, agentType: null, reason: "deleted" });
    await act(async () => {
      button("开始 Review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("intentBrief");
  });

  it("sends the pre-generated brief when there is one", async () => {
    generateReviewIntentBrief.mockResolvedValueOnce("the brief");
    await renderAndOpen({ available: false, sessionId: null, title: null, agentType: null, reason: "deleted" });
    await act(async () => {
      button("开始 Review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ intentBrief: "the brief" }));
  });

  // Props can change under an open dialog (a commander surfacing a freshly
  // spawned session). Submitting the previous session's brief would hand the
  // reviewer another conversation's intent as this one's.
  it("re-generates when the session changes under an open dialog", async () => {
    getReviewerCandidate.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    createWorkflowRun.mockResolvedValue({});
    generateReviewIntentBrief
      .mockResolvedValueOnce("brief for s-a")
      .mockResolvedValueOnce("brief for s-b");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (sessionId: string) => act(async () => {
      root!.render(<ReviewDialog projectId="p1" branch="dev" sessionId={sessionId} />);
    });

    await render("s-a");
    await act(async () => {
      container!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await render("s-b");

    expect(generateReviewIntentBrief).toHaveBeenCalledTimes(2);
    await act(async () => {
      button("开始 Review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "s-b",
      intentBrief: "brief for s-b",
    }));
  });

  // Reuse continues the reviewer's own context, so no brief rides along.
  it("omits the brief entirely when reusing a reviewer", async () => {
    generateReviewIntentBrief.mockResolvedValueOnce("the brief");
    await renderAndOpen({ available: true, sessionId: "s-rev", title: "Prev", agentType: "codex", reason: null });
    await act(async () => {
      button("开始 Review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("intentBrief");
  });
});

describe("ReviewDialog review span", () => {
  it("sends reviewSpan this_turn by default on a fresh review", async () => {
    await renderAndOpen({
      available: false,
      sessionId: null,
      title: null,
      agentType: null,
      reason: "deleted",
    });
    await act(async () => {
      button("开始 Review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ reviewSpan: "this_turn" }),
    );
  });

  it("hides the span selector in reuse mode", async () => {
    await renderAndOpen({
      available: true,
      sessionId: "s-rev",
      title: "Prev",
      agentType: "claude-code",
      reason: null,
    });
    // reuse mode is auto-selected when a reusable candidate exists
    expect(
      Array.from(document.body.querySelectorAll("*")).some((el) => el.textContent === "审查范围"),
    ).toBe(false);
  });
});
