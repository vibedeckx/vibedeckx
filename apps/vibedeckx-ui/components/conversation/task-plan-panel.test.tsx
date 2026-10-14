// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectTaskPlans, TaskPlanPanel, type PinnedTaskPlan } from "./task-plan-panel";
import type { TaskPlan } from "./task-plan-card";
import type { AgentMessage } from "@/hooks/use-chat-session";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { chatToolApproval: vi.fn(async () => {}) } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const plan = (): TaskPlan => ({
  planId: "plan-1", goal: "Verify and preview", completionCriteria: ["Tests pass", "Preview accessible"],
  steps: [{ id: "test", title: "Run tests", status: "in_progress" }, { id: "preview", title: "Start preview", status: "pending" }],
});
const result = (value: TaskPlan): AgentMessage => ({ type: "tool_result", tool: "setPlan", output: JSON.stringify({ success: true, plan: value }), timestamp: 0 });
const task = (value = plan()): PinnedTaskPlan => ({ key: `plan:${value.planId}`, plan: value });

describe("pinned task plan", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); });
  const render = async (value: PinnedTaskPlan) => {
    await act(async () => root.render(<TaskPlanPanel key={value.key} task={value} sessionId="chat" />));
  };
  const toggle = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

  it("opens a new plan and preserves collapse while progress keeps updating", async () => {
    await render(task());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("ol")).not.toBeNull();
    await act(async () => toggle().click());
    const updated = plan();
    updated.steps[0] = { ...updated.steps[0], status: "completed", result: "Tests passed" };
    updated.steps[1].status = "in_progress";
    await render(task(updated));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("ol")).toBeNull();
    expect(host.textContent).toContain("1/2");
    expect(host.textContent).toContain("Start preview");
  });

  it("collapses on completion, allows reopening and opens the next task", async () => {
    await render(task());
    const completed = plan();
    completed.steps = completed.steps.map((step) => ({ ...step, status: "completed", result: "Passed" }));
    await render(task(completed));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).toContain("Completed");
    await act(async () => toggle().click());
    expect(host.querySelector("ol")).not.toBeNull();
    await render(task({ ...plan(), planId: "plan-2", goal: "Next task" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Next task");
  });

  it("opens a confirmation request even after collapsing the existing plan", async () => {
    await render(task());
    await act(async () => toggle().click());
    const approval: Extract<AgentMessage, { type: "tool_approval_request" }> = {
      type: "tool_approval_request", tool: "setPlan", input: plan(), approvalId: "approval", timestamp: 1,
    };
    await render({ key: "approval:approval", plan: plan(), approval });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Needs confirmation");
    const approve = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Confirm and execute"))!;
    await act(async () => approve.click());
    expect(api.chatToolApproval).toHaveBeenCalledWith("chat", "approval", true);
    await render({ key: "approval:approval", plan: plan(), approval: { ...approval, resolved: "denied" } });
    expect(host.textContent).toContain("Plan declined");
    expect(host.textContent).not.toContain("Needs confirmation");
  });

  it("retains history snapshots and pins only the latest plan or approval", () => {
    const first = plan();
    const next = { ...plan(), planId: "plan-2", goal: "Second task" };
    const update = { ...next, steps: next.steps.map((step) => ({ ...step, status: "completed" as const, result: "Done" })) };
    const messages: AgentMessage[] = [result(first), result(next), result(update),
      { type: "tool_result", tool: "setPlan", output: '{"success":false}', timestamp: 1 },
    ];
    const state = collectTaskPlans(messages);
    expect(state.history.size).toBe(2);
    expect(state.history.get("plan-2")).toEqual({ firstIndex: 1, plan: update });
    expect(state.current?.plan).toEqual(update);
    const approval: Extract<AgentMessage, { type: "tool_approval_request" }> = {
      type: "tool_approval_request", tool: "setPlan", input: { ...next, goal: "Revised task" }, approvalId: "new", timestamp: 2,
    };
    expect(collectTaskPlans([...messages, approval]).current?.key).toBe("approval:new");
    expect(collectTaskPlans([]).current).toBeNull();
  });
});
