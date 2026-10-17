// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/api";
import { TaskDetailDialog } from "./task-detail-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
  id: "t1", project_id: "p1", title: "Cover remote path", description: "Body", status: "in_progress",
  priority: "high", assigned_branch: null, position: 0, archived_at: null, parent_id: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
} as Task;

const openInTasksButton = () =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Open in Tasks")) ?? null;

describe("TaskDetailDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("closes itself and hands the task to Open in Tasks", async () => {
    const onOpenChange = vi.fn();
    const onOpenInTasks = vi.fn();
    await act(async () => {
      root.render(<TaskDetailDialog task={task} open onOpenChange={onOpenChange} onOpenInTasks={onOpenInTasks} />);
    });

    await act(async () => openInTasksButton()!.click());

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenInTasks).toHaveBeenCalledWith(task);
  });

  it("offers no link where the host can't open the Tasks page", async () => {
    await act(async () => {
      root.render(<TaskDetailDialog task={task} open onOpenChange={vi.fn()} />);
    });
    expect(document.body.textContent).toContain("Cover remote path");
    expect(openInTasksButton()).toBeNull();
  });
});
