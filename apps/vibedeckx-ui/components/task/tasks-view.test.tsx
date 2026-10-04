// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/api";

vi.mock("@/components/ui/resizable", () => {
  type Kids = { children?: React.ReactNode };
  return {
    ResizablePanelGroup: ({ children }: Kids) => <div>{children}</div>,
    ResizablePanel: ({ children, id }: Kids & { id?: string }) => <section data-panel={id}>{children}</section>,
    ResizableHandle: () => <div />,
  };
});

import { TasksView } from "./tasks-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = (id: string, title: string, description: string | null = null): Task => ({
  id,
  project_id: "project-1",
  title,
  description,
  status: "todo",
  priority: "medium",
  assigned_branch: null,
  position: 0,
  archived_at: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
});

const tasks = [task("t1", "First", "Long first description"), task("t2", "Second")];

let container: HTMLDivElement;
let root: Root;
let onUpdateTask: ReturnType<typeof vi.fn<(id: string, opts: object) => Promise<Task | null>>>;
let onCreateTask: ReturnType<typeof vi.fn<(opts: object) => Promise<Task | null>>>;
let currentTasks: Task[];
let active: boolean;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onUpdateTask = vi.fn(async () => null);
  onCreateTask = vi.fn(async () => null);
  currentTasks = tasks;
  window.localStorage.clear();
  render(true);
});

function render(nextActive = active) {
  active = nextActive;
  act(() => {
    root.render(
      <TasksView
        active={active}
        projectId="project-1"
        tasks={currentTasks}
        loading={false}
        worktrees={[]}
        onCreateTask={onCreateTask}
        onUpdateTask={onUpdateTask}
        onDeleteTask={vi.fn(async () => {})}
        onArchiveTask={vi.fn(async () => {})}
        onUnarchiveTask={vi.fn(async () => {})}
      />,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const panel = () => container.querySelector('[data-panel="task-detail"]');
const row = (id: string) => container.querySelector<HTMLElement>(`[data-task-id="${id}"]`)!;
const panelTitle = () => panel()?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Title"]')?.value;
const press = (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
};
const setTextareaValue = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("TasksView detail panel", () => {
  it("opens on row click and toggles closed on a second click", () => {
    expect(panel()).toBeNull();
    act(() => row("t1").click());
    expect(panelTitle()).toBe("First");
    expect(row("t1").dataset.state).toBe("selected");
    act(() => row("t1").click());
    expect(panel()).toBeNull();
  });

  it("steps through rows with arrow keys and closes on Escape", () => {
    act(() => row("t1").click());
    press("ArrowDown");
    expect(panelTitle()).toBe("Second");
    press("ArrowDown");
    expect(panelTitle()).toBe("Second");
    press("ArrowUp");
    expect(panelTitle()).toBe("First");
    press("Escape");
    expect(panel()).toBeNull();
  });

  it("saves an edited description on blur, clearing to null when emptied", () => {
    act(() => row("t1").click());
    const description = panel()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!;
    expect(description.value).toBe("Long first description");
    act(() => description.focus());
    setTextareaValue(description, "   ");
    act(() => description.blur());
    expect(onUpdateTask).toHaveBeenCalledWith("t1", { description: null });
  });

  it("drops the description preview from rows while the panel is open", () => {
    expect(row("t1").textContent).toContain("Long first description");
    act(() => row("t2").click());
    expect(row("t1").textContent).not.toContain("Long first description");
  });

  it("leaves keys alone while the view is hidden", () => {
    act(() => row("t1").click());
    render(false);
    expect(press("ArrowDown").defaultPrevented).toBe(false);
    expect(panelTitle()).toBe("First");
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(panel()).not.toBeNull();
    render(true);
    press("ArrowDown");
    expect(panelTitle()).toBe("Second");
  });

  it("does not commit the title on an IME composition Enter", () => {
    act(() => row("t1").click());
    const title = panel()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Title"]')!;
    act(() => title.focus());
    setTextareaValue(title, "第一");
    const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    act(() => {
      title.dispatchEvent(composing);
    });
    expect(composing.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(title);
    expect(onUpdateTask).not.toHaveBeenCalled();
    act(() => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onUpdateTask).toHaveBeenCalledWith("t1", { title: "第一" });
  });
});

describe("TasksView new-task draft", () => {
  const draftPanel = () => container.querySelector('[data-panel="task-detail"]');
  const field = (label: string) =>
    draftPanel()!.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  const button = (text: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim().startsWith(text))!;
  const openDraft = () => act(() => button("New Task").click());
  const pendingRows = () => container.querySelectorAll("[data-pending-task]");

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it("opens an empty draft with Create disabled until there is a description", () => {
    openDraft();
    expect(container.textContent).toContain("New task");
    expect(document.activeElement).toBe(field("Title"));
    expect(button("Create").disabled).toBe(true);
    setTextareaValue(field("Description"), "Write it");
    expect(button("Create").disabled).toBe(false);
  });

  it("creates, closes the panel, shows a pending row, then flashes the real task", async () => {
    const created = task("t9", "Generated", "Write it");
    const result = deferred<Task | null>();
    onCreateTask.mockReturnValue(result.promise);
    openDraft();
    setTextareaValue(field("Description"), "  Write it  ");
    act(() => button("Create").click());

    expect(onCreateTask).toHaveBeenCalledWith({
      title: undefined,
      description: "Write it",
      status: "todo",
      priority: "medium",
      assigned_branch: null,
    });
    expect(draftPanel()).toBeNull();
    expect(pendingRows()).toHaveLength(1);
    expect(pendingRows()[0].textContent).toContain("Generating title…");

    currentTasks = [...tasks, created];
    render();
    await act(async () => result.resolve(created));
    expect(pendingRows()).toHaveLength(0);
    expect(row("t9").className).toContain("animate-task-row-flash");
  });

  it("restores the draft with an error when create fails", async () => {
    openDraft();
    setTextareaValue(field("Title"), "Mine");
    setTextareaValue(field("Description"), "Body");
    await act(async () => button("Create").click());
    expect(pendingRows()).toHaveLength(0);
    expect(field("Title").value).toBe("Mine");
    expect(field("Description").value).toBe("Body");
    expect(container.textContent).toContain("Couldn't create the task");
  });

  it("submits on Cmd/Ctrl+Enter and stays on a fresh draft with Create more", async () => {
    onCreateTask.mockResolvedValue(task("t9", "First task", "First"));
    openDraft();
    const checkbox = draftPanel()!.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    act(() => checkbox.click());
    setTextareaValue(field("Description"), "First");
    await act(async () => {
      field("Description").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({ description: "First" }));
    expect(draftPanel()).not.toBeNull();
    expect(field("Description").value).toBe("");
    expect(window.localStorage.getItem("vibedeckx:tasks:create-more")).toBe("1");
  });

  it("keeps the draft across Esc but clears it on Discard", () => {
    openDraft();
    setTextareaValue(field("Description"), "Half written");
    act(() => field("Description").blur());
    press("Escape");
    expect(draftPanel()).toBeNull();
    openDraft();
    expect(field("Description").value).toBe("Half written");
    act(() => button("Discard").click());
    expect(draftPanel()).toBeNull();
    openDraft();
    expect(field("Description").value).toBe("");
  });

  it("New Task while the draft is open refocuses the title instead of resetting", () => {
    openDraft();
    setTextareaValue(field("Description"), "Keep me");
    act(() => field("Description").focus());
    openDraft();
    expect(document.activeElement).toBe(field("Title"));
    expect(field("Description").value).toBe("Keep me");
  });
});
