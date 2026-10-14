// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TaskPlanCard, readPlanResult, type TaskPlan } from "./task-plan-card";
import { ToolApprovalCard } from "./tool-approval-card";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { chatToolApproval: vi.fn(async () => {}) } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const plan: TaskPlan = {
  planId: "plan-1", goal: "Verify login", completionCriteria: ["Login works"],
  steps: [{ id: "test", title: "Run tests", status: "completed", result: "Tests passed" }],
};

describe("task plan cards", () => {
  it("shows the goal, criteria and execution result", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<TaskPlanCard plan={plan} />));
      expect(host.textContent).toContain("Verify login");
      expect(host.textContent).toContain("Login works");
      expect(host.textContent).toContain("Tests passed");
      expect(host.textContent).toContain("1/1");
      expect(readPlanResult("invalid")).toBeNull();
      expect(readPlanResult(JSON.stringify({ success: true, plan: { goal: "bad", steps: [null] } }))).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });

  it("confirms a plan through the existing approval endpoint", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<ToolApprovalCard sessionId="chat" approvalId="approval" tool="setPlan" input={plan} />));
      expect(host.textContent).toContain("Plan draft");
      const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("Confirm and execute"));
      expect(button).toBeDefined();
      await act(async () => button?.click());
      expect(api.chatToolApproval).toHaveBeenCalledWith("chat", "approval", true);
    } finally { await act(async () => root.unmount()); }
  });
});
