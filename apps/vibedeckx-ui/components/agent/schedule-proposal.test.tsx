// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule } from "@/lib/api";

const conversation = vi.hoisted(() => ({
  value: {
    sessionId: "sess-1" as string | null,
    projectId: "proj-1" as string | null,
    branch: "feature-x" as string | null,
    target: "remote-7",
    targetLabel: "build-box",
    agentType: "codex",
    openSchedule: vi.fn(),
  },
}));
vi.mock("./agent-conversation", () => ({
  useAgentConversation: () => conversation.value,
}));

const apiMock = vi.hoisted(() => ({
  getSchedules: vi.fn(async () => [] as Schedule[]),
  createSchedule: vi.fn(async () => ({}) as Schedule),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { ScheduleProposalUI } from "./schedule-proposal";
import { __resetProposedScheduleCache } from "@/hooks/use-proposed-schedule";

const PROPOSAL = {
  name: "Watch flakiness",
  cron_expr: "0 9 * * *",
  prompt: "Re-run the flaky suite and report regressions.",
};

const scheduleRow = (over: Partial<Schedule> = {}): Schedule => ({
  id: "sched-1",
  project_id: "proj-1",
  name: "Watch flakiness",
  cron_expr: "0 9 * * *",
  timezone: "UTC",
  target: "remote-7",
  enabled: true,
  run_type: "prompt",
  prompt_provider: "codex",
  content: PROPOSAL.prompt,
  cwd_mode: "branch",
  branch: "feature-x",
  directory: null,
  timeout_seconds: 1800,
  source_session_id: "sess-1",
  source_tool_use_id: "toolu_1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("ScheduleProposalUI", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (props: { input: unknown; toolUseId?: string }) => {
    await act(async () => {
      root.render(<ScheduleProposalUI {...props} />);
    });
    // Let the schedules lookup resolve.
    await act(async () => { await Promise.resolve(); });
  };

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetProposedScheduleCache();
    apiMock.getSchedules.mockReset().mockResolvedValue([]);
    apiMock.createSchedule.mockReset().mockResolvedValue(scheduleRow());
    conversation.value.openSchedule.mockReset();
    conversation.value.sessionId = "sess-1";
    conversation.value.projectId = "proj-1";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("prefills the model's fields and the session's own bindings", async () => {
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });

    expect(container.querySelector<HTMLInputElement>("[aria-label='Schedule name']")!.value)
      .toBe("Watch flakiness");
    expect(container.querySelector<HTMLInputElement>("[aria-label='Cron expression']")!.value)
      .toBe("0 9 * * *");
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='Check prompt']")!.value)
      .toBe(PROPOSAL.prompt);
    // Branch and target come from the session, never from the tool arguments.
    expect(container.querySelector<HTMLInputElement>("[aria-label='Branch']")!.value).toBe("feature-x");
    expect(container.textContent).toContain("build-box");
  });

  it("accepts a JSON-encoded input payload", async () => {
    await render({ input: JSON.stringify(PROPOSAL), toolUseId: "toolu_1" });
    expect(container.querySelector<HTMLInputElement>("[aria-label='Schedule name']")!.value)
      .toBe("Watch flakiness");
  });

  it("creates the schedule from the session's bindings and carries the proposal's identity", async () => {
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    await act(async () => { button("Create schedule")!.click(); });

    expect(apiMock.createSchedule).toHaveBeenCalledWith("proj-1", expect.objectContaining({
      name: "Watch flakiness",
      cron_expr: "0 9 * * *",
      content: PROPOSAL.prompt,
      run_type: "prompt",
      // The session runs Codex, so its follow-up check must too.
      prompt_provider: "codex",
      cwd_mode: "branch",
      branch: "feature-x",
      target: "remote-7",
      source: { session_id: "sess-1", tool_use_id: "toolu_1" },
    }));
    expect(container.textContent).toContain("Watch flakiness");
    expect(button("Create schedule")).toBeUndefined();
  });

  it("sends a null branch when the field is cleared (main worktree)", async () => {
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    const branch = container.querySelector<HTMLInputElement>("[aria-label='Branch']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(branch, "  ");
      branch.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Create schedule")!.click(); });

    expect(apiMock.createSchedule).toHaveBeenCalledWith("proj-1", expect.objectContaining({ branch: null }));
  });

  it("recovers the created state on a fresh mount — a reload must not offer to create it again", async () => {
    apiMock.getSchedules.mockResolvedValue([scheduleRow()]);
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });

    expect(button("Create schedule")).toBeUndefined();
    expect(container.textContent).toContain("Watch flakiness");
    await act(async () => { button("View")!.click(); });
    expect(conversation.value.openSchedule).toHaveBeenCalledWith("sched-1");
  });

  it("ignores a schedule proposed by the same tool_use id in another session", async () => {
    // Branching a session copies its entries verbatim, tool_use ids included.
    apiMock.getSchedules.mockResolvedValue([scheduleRow({ source_session_id: "other-session" })]);
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });

    expect(button("Create schedule")).toBeDefined();
  });

  it("keeps the card creatable and shows why when creation fails", async () => {
    apiMock.createSchedule.mockRejectedValue(new Error("Unknown remote target"));
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    await act(async () => { button("Create schedule")!.click(); });

    expect(container.textContent).toContain("Unknown remote target");
    expect(button("Retry")).toBeDefined();

    apiMock.createSchedule.mockResolvedValue(scheduleRow());
    await act(async () => { button("Retry")!.click(); });
    expect(button("Retry")).toBeUndefined();
  });

  it("cannot create without a proposal identity", async () => {
    await render({ input: PROPOSAL });
    expect(button("Create schedule")!.hasAttribute("disabled")).toBe(true);
  });
});
