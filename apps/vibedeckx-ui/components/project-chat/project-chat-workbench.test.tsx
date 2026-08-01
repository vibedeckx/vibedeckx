// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  value: {} as import("@/hooks/use-project-chat").UseProjectChatResult,
}));

vi.mock("@/hooks/use-project-chat", () => ({
  useProjectChat: () => hook.value,
}));

import { ProjectChatWorkbench } from "./project-chat-workbench";
import type { ProjectChatMessage, ProjectChatThread } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const thread = (index: number): ProjectChatThread => ({
  id: `thread-${index}`,
  project_id: "project-1",
  user_id: "user-1",
  title: `Thread ${index}`,
  created_at: `2026-07-${String(index).padStart(2, "0")}T12:00:00.000Z`,
  updated_at: `2026-07-${String(index).padStart(2, "0")}T12:00:00.000Z`,
  archived_at: null,
});

const message = (sequence: number, type: ProjectChatMessage["type"], content: string): ProjectChatMessage => ({
  id: `message-${sequence}`,
  thread_id: "thread-7",
  sequence,
  type,
  content,
  created_at: `2026-07-20T12:00:0${sequence}.000Z`,
});

let root: Root;
let container: HTMLDivElement;

function getButton(name: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  if (!result) throw new Error(`Button not found: ${name}`);
  return result as HTMLButtonElement;
}

function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setupHook() {
  hook.value = {
    thread: thread(7),
    threads: Array.from({ length: 7 }, (_, index) => thread(7 - index)),
    messages: [
      message(1, "user", "What changed?"),
      message(2, "assistant", "Two schedules completed."),
      message(3, "tool_use", JSON.stringify({ toolName: "list_schedules", input: {} })),
      message(4, "tool_result", JSON.stringify({ toolName: "list_schedules", output: "2 schedules" })),
      message(5, "error", "Remote server unavailable"),
      message(6, "turn_end", JSON.stringify({ status: "completed" })),
      message(7, "tool_approval_request", JSON.stringify({ approvalId: "approval-1", tool: "run_schedule_now", input: { scheduleId: "s1" } })),
      message(8, "operation", JSON.stringify({ version: 1, operationId: "op-1", kind: "schedule_run", status: "running", scheduleId: "s1", runId: "r1" })),
    ],
    status: "running",
    queueLength: 1,
    contextRefs: [
      { thread_id: "thread-7", entity_type: "task", entity_id: "task-1", last_referenced_at: "2026-07-20T12:00:00Z", deleted: false, navigation: { kind: "task", taskId: "task-1", label: "Task one" } },
      { thread_id: "thread-7", entity_type: "schedule_run", entity_id: "run-gone", last_referenced_at: "2026-07-20T12:00:00Z", deleted: true, navigation: null },
      { thread_id: "thread-7", entity_type: "workspace", entity_id: "legacy", last_referenced_at: "2026-07-20T12:00:00Z", deleted: false, navigation: null },
    ],
    loading: false,
    threadsLoading: false,
    threadLoading: false,
    isConnected: true,
    error: null,
    terminalError: null,
    refetchThreads: vi.fn(async () => {}),
    createThread: vi.fn(async () => thread(8)),
    renameThread: vi.fn(async (_id, title) => ({ ...thread(7), title })),
    archiveThread: vi.fn(async () => ({ ...thread(7), archived_at: Date.now() })),
    deleteThread: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    stopTurn: vi.fn(async () => true),
    resolveToolApproval: vi.fn(async () => {}),
  };
}

function render(overrides: Partial<React.ComponentProps<typeof ProjectChatWorkbench>> = {}) {
  const props: React.ComponentProps<typeof ProjectChatWorkbench> = {
    projectId: "project-1",
    threadId: "thread-7",
    projectName: "VibeDeckX",
    onBack: vi.fn(),
    onSelectThread: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<ProjectChatWorkbench {...props} />));
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupHook();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("ProjectChatWorkbench", () => {
  it("uses one conversation column and one rail with Threads above Context", () => {
    render();

    expect(container.querySelectorAll('[data-testid="project-chat-main"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="project-chat-rail"]')).toHaveLength(1);
    expect(container.querySelectorAll("[data-project-chat-column]")).toHaveLength(2);
    const rail = container.querySelector('[data-testid="project-chat-rail"]')!;
    const headings = [...rail.querySelectorAll("h2")].map((item) => item.textContent);
    expect(headings).toEqual(["Chat Threads", "Context"]);
    expect(rail.querySelectorAll('[data-testid="thread-row"]')).toHaveLength(5);
    expect(rail.textContent).toContain("View all");
    expect(container.textContent).toContain("What changed?");
    expect(container.textContent).toContain("Two schedules completed.");
    expect(container.textContent).toContain("Remote server unavailable");
    expect(container.textContent).toContain("Running list schedules");
    expect(container.textContent).toContain("2 schedules");
    expect(container.querySelector('[data-testid="turn-boundary"]')).not.toBeNull();
    expect(container.textContent).toContain("Schedule run");
  });

  it("switches and creates threads through app-owned navigation", async () => {
    const props = render();

    act(() => getButton("Open thread: Thread 6").click());
    expect(props.onSelectThread).toHaveBeenCalledWith("thread-6");

    await act(async () => getButton("New thread").click());
    expect(hook.value.createThread).toHaveBeenCalledWith();
    expect(props.onSelectThread).toHaveBeenCalledWith("thread-8");
  });

  it("renames, archives, and deletes only after confirmation", async () => {
    const props = render();

    act(() => getButton("Thread actions: Thread 7").click());
    act(() => getButton("Rename thread").click());
    const renameInput = document.querySelector('input[aria-label="Thread title"]') as HTMLInputElement;
    act(() => setInput(renameInput, "Release review"));
    await act(async () => getButton("Save title").click());
    expect(hook.value.renameThread).toHaveBeenCalledWith("thread-7", "Release review");

    act(() => getButton("Thread actions: Thread 7").click());
    act(() => getButton("Archive thread").click());
    expect(hook.value.archiveThread).not.toHaveBeenCalled();
    act(() => getButton("Cancel").click());
    expect(hook.value.archiveThread).not.toHaveBeenCalled();

    act(() => getButton("Thread actions: Thread 7").click());
    act(() => getButton("Archive thread").click());
    await act(async () => getButton("Confirm archive").click());
    expect(hook.value.archiveThread).toHaveBeenCalledWith("thread-7", true);
    expect(props.onSelectThread).toHaveBeenCalledWith("thread-6");

    act(() => getButton("Thread actions: Thread 7").click());
    act(() => getButton("Delete thread").click());
    expect(hook.value.deleteThread).not.toHaveBeenCalled();
    await act(async () => getButton("Confirm delete").click());
    expect(hook.value.deleteThread).toHaveBeenCalledWith("thread-7");
  });

  it("keeps archived threads out of recent and header selectors after View All loads them", async () => {
    hook.value.threads = [
      { ...thread(9), archived_at: Date.now() },
      thread(7), thread(6), thread(5), thread(4), thread(3), thread(2),
    ];
    render();

    expect(container.querySelectorAll('[data-testid="thread-row"]')).toHaveLength(5);
    expect(container.textContent).not.toContain("Thread 9");
    act(() => getButton("Current thread: Thread 7").click());
    expect(document.querySelector('button[aria-label="Switch to thread: Thread 9"]')).toBeNull();

    act(() => getButton("View all threads").click());
    expect(document.querySelector('button[aria-label="Open history thread: Thread 9"]')).not.toBeNull();
  });

  it("keeps thread switching in the header when the shared rail is collapsed", () => {
    const props = render();
    act(() => getButton("Hide threads and context").click());

    expect(container.querySelector('[data-testid="project-chat-rail"]')).toBeNull();
    expect(getButton("Current thread: Thread 7")).toBeTruthy();
    act(() => getButton("Current thread: Thread 7").click());
    act(() => getButton("Switch to thread: Thread 6").click());
    expect(props.onSelectThread).toHaveBeenCalledWith("thread-6");
  });

  it("shows final Context refs and disables deleted targets", () => {
    render({ onOpenContext: vi.fn() });

    expect(container.textContent).toContain("Task · Task one");
    const deleted = getButton("Deleted schedule run");
    expect(deleted.disabled).toBe(true);
    expect(deleted.textContent).toContain("Deleted");
    const unavailable = getButton("Unavailable workspace");
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.textContent).toContain("Navigation details are unavailable");
  });

  it("routes every resolved Context kind through the app-owned navigation seam", () => {
    hook.value.contextRefs = [
      { thread_id: "thread-7", entity_type: "task", entity_id: "task-1", last_referenced_at: "", deleted: false, navigation: { kind: "task", taskId: "task-1", label: "Fix login" } },
      { thread_id: "thread-7", entity_type: "workspace", entity_id: "workspace-1", last_referenced_at: "", deleted: false, navigation: { kind: "workspace", target: "local", branch: "dev", label: "dev" } },
      { thread_id: "thread-7", entity_type: "agent_session", entity_id: "session-1", last_referenced_at: "", deleted: false, navigation: { kind: "agent_session", sessionId: "session-1", target: "remote-1", branch: "dev", label: "Agent dev" } },
      { thread_id: "thread-7", entity_type: "schedule", entity_id: "schedule-1", last_referenced_at: "", deleted: false, navigation: { kind: "schedule", scheduleId: "schedule-1", label: "Nightly" } },
      { thread_id: "thread-7", entity_type: "schedule_run", entity_id: "run-1", last_referenced_at: "", deleted: false, navigation: { kind: "schedule_run", scheduleId: "schedule-1", runId: "run-1", label: "Nightly run" } },
    ];
    const onOpenContext = vi.fn();
    render({ onOpenContext });

    for (const label of [
      "Open Task: Fix login", "Open Workspace: dev", "Open Agent session: Agent dev",
      "Open Schedule: Nightly", "Open Schedule run: Nightly run",
    ]) act(() => getButton(label).click());

    expect(onOpenContext).toHaveBeenCalledTimes(5);
    expect(onOpenContext.mock.calls.map(([value]) => value.navigation.kind))
      .toEqual(["task", "workspace", "agent_session", "schedule", "schedule_run"]);
  });

  it("sends, stops, and resolves approvals through the project hook", async () => {
    render();
    const composer = container.querySelector('textarea[aria-label="Message Project Chat"]') as HTMLTextAreaElement;
    act(() => setInput(composer, "Compare both workspaces"));
    await act(async () => getButton("Send message").click());
    expect(hook.value.sendMessage).toHaveBeenCalledWith("Compare both workspaces");

    await act(async () => getButton("Stop generating").click());
    expect(hook.value.stopTurn).toHaveBeenCalledOnce();
    await act(async () => getButton("Approve run_schedule_now").click());
    expect(hook.value.resolveToolApproval).toHaveBeenCalledWith("approval-1", true);
  });

  it("returns to Overview without stopping a background turn", () => {
    const props = render();
    act(() => getButton("Back to Overview").click());

    expect(props.onBack).toHaveBeenCalledOnce();
    expect(hook.value.stopTurn).not.toHaveBeenCalled();
  });

  it("opens a searchable View All dialog and switches from its results", async () => {
    const props = render();
    act(() => getButton("View all threads").click());
    expect(document.body.textContent).toContain("All Project Chat threads");
    const search = document.querySelector('input[aria-label="Search threads"]') as HTMLInputElement;
    act(() => setInput(search, "Thread 1"));
    expect(document.querySelectorAll('[data-testid="history-thread-row"]')).toHaveLength(1);

    await act(async () => getButton("Show archived threads").click());
    expect(hook.value.refetchThreads).toHaveBeenCalledWith(true);
    act(() => getButton("Open history thread: Thread 1").click());
    expect(props.onSelectThread).toHaveBeenCalledWith("thread-1");
  });
});
