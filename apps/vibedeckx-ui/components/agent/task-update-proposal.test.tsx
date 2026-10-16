// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/api";

const conversation = vi.hoisted(() => ({
  value: {
    sessionId: "sess-1" as string | null,
    projectId: "proj-1" as string | null,
    openTask: vi.fn(),
  },
}));
vi.mock("./agent-conversation", () => ({
  useAgentConversation: () => conversation.value,
}));

const apiMock = vi.hoisted(() => ({
  getTasks: vi.fn(async () => [] as Task[]),
  updateTask: vi.fn<(id: string, patch: Record<string, unknown>) => Promise<Task>>(),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/hooks/global-event-stream", () => ({ useGlobalEventStream: () => {} }));

import { pendingFields, TaskUpdateProposalUI, updateProposalRejection } from "./task-update-proposal";
import { __resetProposedTaskCache } from "@/hooks/use-proposed-tasks";

const taskRow = (over: Partial<Task> = {}): Task => ({
  id: "task-1",
  project_id: "proj-1",
  title: "Cover remote path",
  description: "Line one\nLine two",
  status: "todo",
  priority: "medium",
  assigned_branch: null,
  position: 0,
  archived_at: null,
  source_session_id: null,
  source_tool_use_id: null,
  source_item_index: null,
  parent_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
} as Task);

describe("updateProposalRejection", () => {
  it("accepts a well-formed proposal, as a string too", () => {
    const input = { updates: [{ task_id: "task-1", status: "done" }] };
    expect(updateProposalRejection(input)).toBeNull();
    expect(updateProposalRejection(JSON.stringify(input))).toBeNull();
  });

  it.each([
    [{}],
    [{ updates: [] }],
    [{ updates: [{ status: "done" }] }],
    [{ updates: [{ task_id: "a" }] }],
    [{ updates: [{ task_id: "a", status: "closed" }] }],
    [{ updates: [{ task_id: "a", priority: "p0" }] }],
    [{ updates: [{ task_id: "a", title: " " }] }],
    [{ updates: [{ task_id: "a", status: "done" }, { task_id: "a", title: "x" }] }],
    [{ updates: Array.from({ length: 11 }, (_, i) => ({ task_id: `t${i}`, status: "done" })) }],
  ])("rejects %j", (input) => {
    expect(updateProposalRejection(input)).not.toBeNull();
  });
});

describe("pendingFields", () => {
  it("keeps only proposed fields that differ from the task", () => {
    const task = taskRow({ status: "done" });
    expect(pendingFields({ taskId: "task-1", status: "done", priority: "high" }, task)).toEqual(["priority"]);
    expect(pendingFields({ taskId: "task-1", status: "done" }, task)).toEqual([]);
  });
});

describe("TaskUpdateProposalUI", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (input: unknown) => {
    await act(async () => { root.render(<TaskUpdateProposalUI input={input} />); });
    await act(async () => { await Promise.resolve(); });
  };
  const buttons = (label: string) =>
    [...container.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes(label) || b.getAttribute("aria-label") === label);
  const rowStates = () => [...container.querySelectorAll("[data-update-row]")].map((el) => el.getAttribute("data-update-row"));

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetProposedTaskCache();
    apiMock.getTasks.mockReset().mockResolvedValue([taskRow(), taskRow({ id: "task-2", title: "Second" })]);
    apiMock.updateTask.mockReset();
    conversation.value.openTask.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("shows each change against the current value and applies only what differs", async () => {
    apiMock.updateTask.mockResolvedValue(taskRow({ status: "done" }));
    await render({ updates: [{ task_id: "task-1", status: "done", priority: "medium" }] });
    expect(rowStates()).toEqual(["pending"]);
    expect(container.textContent).toContain("Todo");
    expect(container.textContent).toContain("Done");
    // Priority already matches, so it is neither shown nor sent.
    expect(container.textContent).not.toContain("Priority");

    await act(async () => { buttons("Apply update")[0].click(); });
    expect(apiMock.updateTask).toHaveBeenCalledWith("task-1", { status: "done" });
    expect(rowStates()).toEqual(["applied"]);
    expect(container.textContent).toContain("Nothing left to apply");
  });

  it("renders a description change as a line diff", async () => {
    await render({ updates: [{ task_id: "task-1", description: "Line one\nLine 2" }] });
    const diff = container.querySelector("[data-description-diff]")!;
    expect(diff.textContent).toContain("−Line two");
    expect(diff.textContent).toContain("+Line 2");
  });

  it("marks a task that no longer exists and applies the rest in order", async () => {
    apiMock.updateTask
      .mockResolvedValueOnce(taskRow({ title: "Renamed" }))
      .mockResolvedValueOnce(taskRow({ id: "task-2", title: "Second", status: "cancelled" }));
    await render({
      updates: [
        { task_id: "task-1", title: "Renamed" },
        { task_id: "gone", status: "done" },
        { task_id: "task-2", status: "cancelled" },
      ],
    });
    expect(rowStates()).toEqual(["pending", "missing", "pending"]);
    await act(async () => { buttons("Apply all 2")[0].click(); });
    expect(apiMock.updateTask.mock.calls.map((c) => c[0])).toEqual(["task-1", "task-2"]);
    expect(rowStates()).toEqual(["applied", "missing", "applied"]);
  });

  it("offers only the actionable rows of a mixed batch", async () => {
    apiMock.getTasks.mockResolvedValue([taskRow(), taskRow({ id: "task-2", title: "Second", status: "done" })]);
    await render({
      updates: [
        { task_id: "task-1", status: "done" },
        { task_id: "gone", status: "done" },
        { task_id: "task-2", status: "done" },
      ],
    });
    expect(rowStates()).toEqual(["pending", "missing", "applied"]);
    expect(buttons("Apply update")).toHaveLength(1);
    expect(buttons("Apply all")).toHaveLength(0);
  });

  it("keeps the row and shows the error when applying fails", async () => {
    apiMock.updateTask.mockRejectedValue(new Error("Task not found"));
    await render({ updates: [{ task_id: "task-1", status: "done" }] });
    await act(async () => { buttons("Apply update")[0].click(); });
    expect(rowStates()).toEqual(["pending"]);
    expect(container.textContent).toContain("Task not found");
    expect(buttons("Retry")).toHaveLength(1);
  });

  it("shows a rejected proposal instead of offering changes", async () => {
    await render({ updates: [{ task_id: "task-1" }] });
    expect(container.textContent).toContain("Not proposed");
    expect(buttons("Apply")).toHaveLength(0);
  });
});
