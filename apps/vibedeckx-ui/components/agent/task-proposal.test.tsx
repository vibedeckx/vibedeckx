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
  createTask: vi.fn(async (_projectId: string, _opts: { source: { item_index: number } }) => ({}) as Task),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));

/** Every mounted card's task:* listener, so a test can deliver an event. */
const events = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>() }));
vi.mock("@/hooks/global-event-stream", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    useGlobalEventStream: (listener: (event: unknown) => void) => {
      const ref = useRef(listener);
      ref.current = listener;
      useEffect(() => {
        const forward = (event: unknown) => ref.current(event);
        events.listeners.add(forward);
        return () => { events.listeners.delete(forward); };
      }, []);
    },
  };
});
const fireTaskEvent = () => act(async () => {
  for (const listener of events.listeners) listener({ type: "task:updated", projectId: "proj-1" });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

import { TaskProposalUI } from "./task-proposal";
import { __resetProposedTaskCache } from "@/hooks/use-proposed-tasks";
import { requestProposalCardFocus } from "@/lib/proposal-card-focus";

const PROPOSAL = {
  tasks: [
    { title: "Cover remote path", description: "Add the remote retention test", priority: "high" },
    { title: "Drop legacy flag", description: "Remove --old once workers are past 0.3.45" },
  ],
};

const taskRow = (over: Partial<Task> = {}): Task => ({
  id: "task-1",
  project_id: "proj-1",
  title: "Cover remote path",
  description: "Add the remote retention test",
  status: "todo",
  priority: "high",
  assigned_branch: null,
  position: 0,
  archived_at: null,
  source_session_id: "sess-1",
  source_tool_use_id: "toolu_1",
  source_item_index: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("TaskProposalUI", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (props: { input: unknown; toolUseId?: string }) => {
    await act(async () => {
      root.render(<TaskProposalUI {...props} />);
    });
    await act(async () => { await Promise.resolve(); });
  };

  const buttons = (label: string) =>
    [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes(label));
  const titles = () =>
    [...container.querySelectorAll<HTMLInputElement>("[aria-label='Task title']")].map((i) => i.value);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetProposedTaskCache();
    apiMock.getTasks.mockReset().mockResolvedValue([]);
    apiMock.createTask.mockReset().mockResolvedValue(taskRow());
    conversation.value.openTask.mockReset();
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

  it("renders one editable row per proposed task", async () => {
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    expect(titles()).toEqual(["Cover remote path", "Drop legacy flag"]);
    expect(buttons("Create task")).toHaveLength(2);
    expect(buttons("Create all 2")).toHaveLength(1);
  });

  const descriptionEditor = () => container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Task description']");
  const typeInto = (el: HTMLTextAreaElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("shows the description rendered and edits it in place on click", async () => {
    await render({ input: { tasks: [{ title: "T", description: "Add **the** test" }] }, toolUseId: "toolu_1" });
    const rendered = container.querySelector<HTMLElement>("[data-markdown-field='Task description']")!;
    expect(rendered.textContent).toContain("Add the test");
    expect(descriptionEditor()).toBeNull();

    act(() => rendered.click());
    const editor = descriptionEditor()!;
    expect(document.activeElement).toBe(editor);
    typeInto(editor, "Add **the** test, then ship");
    act(() => editor.blur());
    expect(descriptionEditor()).toBeNull();

    await act(async () => { buttons("Create task")[0].click(); });
    expect(apiMock.createTask.mock.calls[0][1]).toMatchObject({ description: "Add **the** test, then ship" });
  });

  it("keeps an initially empty description in the editor while typing", async () => {
    await render({ input: { tasks: [{ title: "T", description: "" }] }, toolUseId: "toolu_1" });
    const editor = descriptionEditor()!;
    act(() => editor.focus());
    typeInto(editor, "Now it has text");
    expect(descriptionEditor()).toBe(editor);
    expect(document.activeElement).toBe(editor);
  });

  it("accepts a JSON-encoded input payload", async () => {
    await render({ input: JSON.stringify(PROPOSAL), toolUseId: "toolu_1" });
    expect(titles()).toEqual(["Cover remote path", "Drop legacy flag"]);
  });

  it("creates one item with its provenance and flips that row only", async () => {
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    await act(async () => { buttons("Create task")[0].click(); });

    expect(apiMock.createTask).toHaveBeenCalledWith("proj-1", {
      title: "Cover remote path",
      description: "Add the remote retention test",
      priority: "high",
      source: { session_id: "sess-1", tool_use_id: "toolu_1", item_index: 0 },
      parent_id: null,
    });
    // Nothing about a branch: proposed tasks are never pre-assigned.
    expect(JSON.stringify(apiMock.createTask.mock.calls[0])).not.toContain("assigned_branch");
    expect(titles()).toEqual(["Drop legacy flag"]);
    expect(container.textContent).toContain("Created");
  });

  it("files the tasks under the agent's parent_task_id when it names a task of the project", async () => {
    apiMock.getTasks.mockResolvedValue([
      taskRow({ id: "goal", title: "Ship sub-tasks", source_tool_use_id: "toolu_0", source_item_index: 0 }),
    ]);
    await render({ input: { ...PROPOSAL, parent_task_id: "goal" }, toolUseId: "toolu_1" });
    expect(container.textContent).toContain("File these under");
    expect(container.querySelector('[aria-label="Parent task"]')?.textContent).toContain("Ship sub-tasks");

    await act(async () => { buttons("Create task")[0].click(); });
    expect(apiMock.createTask.mock.calls[0][1]).toMatchObject({ parent_id: "goal" });
  });

  it("files the rest of a partly created proposal under the parent its created row has", async () => {
    apiMock.getTasks.mockResolvedValue([
      taskRow({ id: "goal", title: "Ship sub-tasks", source_tool_use_id: "toolu_0", source_item_index: 0 }),
      taskRow({ id: "other", title: "Other goal", source_tool_use_id: "toolu_0", source_item_index: 1 }),
      // Created earlier (before a reload) under "other", though the agent proposed "goal".
      taskRow({ id: "task-0", parent_id: "other", source_item_index: 0 }),
    ]);
    await render({ input: { ...PROPOSAL, parent_task_id: "goal" }, toolUseId: "toolu_1" });
    const picker = container.querySelector<HTMLButtonElement>('[aria-label="Parent task"]');
    expect(picker?.textContent).toContain("Other goal");
    expect(picker?.disabled).toBe(true);

    await act(async () => { buttons("Create task")[0].click(); });
    expect(apiMock.createTask.mock.calls[0][1]).toMatchObject({ parent_id: "other", source: { item_index: 1 } });
  });

  it("ignores a parent_task_id that names no task of the project", async () => {
    await render({ input: { ...PROPOSAL, parent_task_id: "made-up" }, toolUseId: "toolu_1" });
    await act(async () => { buttons("Create task")[0].click(); });
    expect(apiMock.createTask.mock.calls[0][1]).toMatchObject({ parent_id: null });
  });

  it("creates all pending items at once", async () => {
    apiMock.createTask.mockImplementation(async (_p: string, opts: { source: { item_index: number } }) =>
      taskRow({ id: `task-${opts.source.item_index}`, source_item_index: opts.source.item_index }));
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    await act(async () => { buttons("Create all")[0].click(); });

    expect(apiMock.createTask).toHaveBeenCalledTimes(2);
    expect(titles()).toEqual([]);
  });

  it("recovers created and completed state from the task list", async () => {
    apiMock.getTasks.mockResolvedValue([taskRow({ status: "done" })]);
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    expect(container.textContent).toContain("Done");
    expect(titles()).toEqual(["Drop legacy flag"]);
  });

  it("ignores a task created from the same tool_use id in another (branched) session", async () => {
    apiMock.getTasks.mockResolvedValue([taskRow({ source_session_id: "other-session" })]);
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    expect(titles()).toHaveLength(2);
  });

  it("keeps the row editable and offers a retry when create fails", async () => {
    apiMock.createTask.mockRejectedValue(new Error("Could not protect the source session from retention"));
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    await act(async () => { buttons("Create task")[0].click(); });

    expect(container.textContent).toContain("Could not protect the source session");
    expect(buttons("Retry")).toHaveLength(1);
    expect(titles()).toHaveLength(2);
  });

  it("refetches on remount, since events were missed while no card was mounted", async () => {
    apiMock.getTasks.mockResolvedValue([taskRow()]);
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    expect(container.textContent).toContain("Created");

    await act(async () => root.unmount());
    // Completed elsewhere while nobody was listening for task:updated.
    apiMock.getTasks.mockResolvedValue([taskRow({ status: "done" })]);
    root = createRoot(container);
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    await act(async () => { await Promise.resolve(); });

    expect(apiMock.getTasks).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Done");
  });

  it("shows a failed first load with a retry, and becomes creatable once it succeeds", async () => {
    apiMock.getTasks.mockRejectedValueOnce(new Error("network down"));
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    expect(container.textContent).toContain("network down");
    // Not stuck disabled: create is idempotent server-side, so confirming an
    // item that turns out to exist just returns that task.
    expect(buttons("Create task").every((b) => !b.disabled)).toBe(true);

    apiMock.getTasks.mockResolvedValue([]);
    await act(async () => { buttons("Retry")[0].click(); });
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).not.toContain("network down");
    expect(buttons("Create task").every((b) => !b.disabled)).toBe(true);
  });

  it("never lets an older list response overwrite a newer one, and coalesces bursts", async () => {
    apiMock.getTasks.mockResolvedValue([taskRow()]);
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    // A second card on the same project: one burst must not cost a request per card.
    const second = document.createElement("div");
    document.body.appendChild(second);
    const secondRoot = createRoot(second);
    await act(async () => { secondRoot.render(<TaskProposalUI input={PROPOSAL} toolUseId="toolu_2" />); });

    const stale = deferred<Task[]>();
    const fresh = deferred<Task[]>();
    apiMock.getTasks.mockReset()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    await fireTaskEvent(); // starts the refresh
    await fireTaskEvent(); // arrives while it is in flight
    expect(apiMock.getTasks).toHaveBeenCalledTimes(1);

    fresh.resolve([taskRow({ status: "done" })]);
    await act(async () => { stale.resolve([taskRow()]); });
    await act(async () => { await Promise.resolve(); });

    expect(apiMock.getTasks).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Done");
    await act(async () => secondRoot.unmount());
  });

  it("keeps a just-created task when a list fetched before the create lands after it", async () => {
    apiMock.getTasks.mockResolvedValue([]);
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });

    const before = deferred<Task[]>();
    apiMock.getTasks.mockReset().mockReturnValueOnce(before.promise).mockResolvedValue([taskRow()]);
    await fireTaskEvent();
    await act(async () => { buttons("Create task")[0].click(); });
    await act(async () => { before.resolve([]); });
    await act(async () => { await Promise.resolve(); });

    expect(titles()).toEqual(["Drop legacy flag"]);
    expect(container.textContent).toContain("Created");
  });

  it("opens the created task", async () => {
    const task = taskRow();
    apiMock.getTasks.mockResolvedValue([task]);
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    await act(async () => { buttons("View")[0].click(); });
    expect(conversation.value.openTask).toHaveBeenCalledWith(task);
  });

  it("scrolls itself into view when a source link asked for it", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    requestProposalCardFocus("toolu_1");
    await render({ input: PROPOSAL, toolUseId: "toolu_1" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
