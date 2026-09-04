// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activityHook = vi.hoisted(() => ({
  value: {
    activity: null as import("@/lib/api").ProjectActivity | null,
    loading: false,
    error: null as string | null,
    refetch: vi.fn(async () => {}),
  },
}));

vi.mock("@/hooks/use-project-activity", () => ({
  useProjectActivity: () => activityHook.value,
}));

const remotesHook = vi.hoisted(() => ({
  value: [] as import("@/lib/api").ProjectRemote[],
}));

vi.mock("@/hooks/use-project-remotes", () => ({
  useProjectRemotes: () => ({ remotes: remotesHook.value, loading: false, refresh: vi.fn() }),
}));

const listThreadPage = vi.hoisted(() => vi.fn(async () => ({ threads: [], nextCursor: null })));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, listProjectChatThreadPage: listThreadPage } };
});

import { ProjectActivityView } from "./project-activity-view";
import type {
  ProjectActivity,
  ProjectAgentSessionActivity,
  ProjectChatThread,
  ProjectRemote,
  ProjectScheduleRunActivity,
  Task,
} from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = (day: number) => `2026-07-${String(day).padStart(2, "0")}T12:00:00.000Z`;

const thread = (index: number): ProjectChatThread => ({
  id: `thread-${index}`,
  project_id: "project-1",
  user_id: "user-1",
  title: `Thread ${index}`,
  created_at: timestamp(index),
  updated_at: timestamp(index),
  archived_at: null,
});

const session = (index: number): ProjectAgentSessionActivity => ({
  id: `session-${index}`,
  projectId: "project-1",
  branch: index === 1 ? null : `feature-${index}`,
  status: index === 2 ? "error" : index === 1 ? "running" : "stopped",
  title: `Session ${index}`,
  target: index === 3 ? "remote-server-3" : "local",
  workspace: {
    target: index === 3 ? "remote-server-3" : "local",
    branch: index === 1 ? null : `feature-${index}`,
  },
  agentType: "codex",
  model: `model-${index}`,
  lastActiveAt: Date.parse(timestamp(index)),
  lastUserMessageAt: null,
  lastCompletedAt: null,
  favoritedAt: null,
});

const run = (index: number): ProjectScheduleRunActivity => ({
  id: `run-${index}`,
  schedule_id: `schedule-${index}`,
  status: index === 2 ? "failed" : "completed",
  exit_code: index === 2 ? 1 : 0,
  process_id: null,
  started_at: timestamp(index),
  finished_at: new Date(Date.parse(timestamp(index)) + 65_000).toISOString(),
  scheduleName: `Schedule ${index}`,
  branch: index === 1 ? null : `feature-${index}`,
  target: index === 4 ? "remote-server-4" : "local",
  reportPreview: `Report preview ${index}`,
});

const remote = (serverId: string, name: string): ProjectRemote => ({
  id: `association-${serverId}`,
  project_id: "project-1",
  remote_server_id: serverId,
  remote_path: "/srv/project-1",
  sort_order: 0,
  server_name: name,
});

const task = (
  id: string,
  status: Task["status"],
  priority: Task["priority"],
  day: number,
): Task => ({
  id,
  project_id: "project-1",
  title: `Task ${id}`,
  description: null,
  status,
  priority,
  assigned_branch: null,
  position: 0,
  archived_at: null,
  created_at: timestamp(day),
  updated_at: timestamp(day),
});

const populatedActivity = (): ProjectActivity => ({
  recentThreads: [thread(4), thread(3), thread(2), thread(1)],
  recentAgentSessions: Array.from({ length: 9 }, (_, index) => session(index + 1)),
  starredSessions: [
    { ...session(3), favoritedAt: Date.parse(timestamp(9)) },
    { ...session(1), favoritedAt: Date.parse(timestamp(8)) },
  ],
  recentScheduleRuns: Array.from({ length: 6 }, (_, index) => run(index + 1)),
  priorityTasks: [
    task("high-new", "todo", "high", 7),
    task("urgent-old", "todo", "urgent", 2),
    task("progress-low", "in_progress", "low", 1),
    task("urgent-new", "todo", "urgent", 6),
    task("high-old", "todo", "high", 3),
    task("medium", "todo", "medium", 9),
    task("done", "done", "urgent", 10),
  ],
  attention: [
    {
      type: "agent_session",
      entityId: "session-2",
      status: "error",
      title: "Broken agent",
      occurredAt: timestamp(9),
      target: "local",
      workspace: { target: "local", branch: "feature-2" },
    },
    {
      type: "schedule_run",
      entityId: "run-2",
      status: "failed",
      title: "Broken schedule",
      occurredAt: timestamp(8),
    },
  ],
  summary: { running: 2, nextScheduleAt: timestamp(10) },
});

let root: Root;
let container: HTMLDivElement;

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

function setInput(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function render(overrides: Partial<React.ComponentProps<typeof ProjectActivityView>> = {}) {
  const props: React.ComponentProps<typeof ProjectActivityView> = {
    projectId: "project-1",
    waitingCount: 0,
    onCreateThread: vi.fn(async () => thread(9)),
    onOpenThread: vi.fn(),
    onOpenAgentSession: vi.fn(),
    onOpenScheduleRun: vi.fn(),
    onRunScheduleAgain: vi.fn(async () => {}),
    onOpenTask: vi.fn(),
    onViewAllTasks: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<ProjectActivityView {...props} />));
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  remotesHook.value = [remote("remote-server-3", "gpu-01"), remote("remote-server-4", "builder-02")];
  activityHook.value = {
    activity: populatedActivity(),
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ProjectActivityView", () => {
  it("renders bounded activity cards without a standalone Workspaces card or raw output", () => {
    render();

    expect(container.textContent).toContain("Project Chat");
    expect(container.textContent).toContain("Recent Agent Sessions");
    expect(container.textContent).toContain("Schedule Results");
    expect(container.textContent).toContain("Priority Tasks");
    expect(container.textContent).toContain("Attention Required");
    expect(container.textContent).toContain("Starred Sessions");
    expect(container.textContent).not.toContain("Workspaces");

    // Every thread the server sent, not a client-side slice — the server owns
    // the recent-thread limit and the card's footer opens the rest.
    expect(container.querySelectorAll('[data-testid="recent-thread"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-testid="recent-session"]')).toHaveLength(8);
    expect(container.querySelectorAll('[data-testid="schedule-run"]')).toHaveLength(5);
    expect(container.querySelectorAll('[data-testid="priority-task"]')).toHaveLength(5);
    expect(container.textContent).toContain("Report preview 1");
    expect(container.textContent).not.toContain("Raw output");
    expect(container.textContent).toContain("feature-3 · gpu-01");
    expect(container.textContent).toContain("main");

    const taskRows = [...container.querySelectorAll('[data-testid="priority-task"]')];
    expect(taskRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Task progress-low"),
      expect.stringContaining("Task urgent-new"),
      expect.stringContaining("Task urgent-old"),
      expect.stringContaining("Task high-new"),
      expect.stringContaining("Task high-old"),
    ]);
  });

  it("labels remote workspaces with the remote's name, never its server id", () => {
    render();

    const rows = [...container.querySelectorAll('[data-testid="recent-session"]')];
    const remoteRow = rows.find((row) => row.getAttribute("aria-label") === "Open agent session: Session 3");
    expect(remoteRow?.textContent).toContain("feature-3 · gpu-01");
    expect(container.textContent).not.toContain("remote-server-3");
    expect(container.textContent).toContain("feature-4 · builder-02");
    expect(container.textContent).not.toContain("remote-server-4");
  });

  it("says where a remote session is running in the Running tile", () => {
    activityHook.value = {
      ...activityHook.value,
      activity: {
        ...populatedActivity(),
        recentAgentSessions: [{ ...session(3), status: "running" }],
        // Starred rows name the same workspace; keep the count below about the
        // tile and the session row only.
        starredSessions: [],
      },
    };
    render();

    // The tile's detail line and the session row both name the remote.
    expect(container.textContent?.split("feature-3 · gpu-01")).toHaveLength(3);
  });

  it("falls back to the target id once a remote is detached from the project", () => {
    remotesHook.value = [];
    render();

    expect(container.textContent).toContain("feature-3 · remote-server-3");
  });

  it("routes each row and attention action through app-owned callbacks", async () => {
    const props = render();

    act(() => button("Open Project Chat thread: Thread 4").click());
    expect(props.onOpenThread).toHaveBeenCalledWith("thread-4");

    act(() => button("Open agent session: Session 3").click());
    expect(props.onOpenAgentSession).toHaveBeenCalledWith("session-3", "remote-server-3", "feature-3");

    act(() => button("Open schedule run: Schedule 1").click());
    expect(props.onOpenScheduleRun).toHaveBeenCalledWith("run-1", "schedule-1");

    act(() => button("Open task: Task progress-low").click());
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "progress-low" }));

    act(() => button("View all tasks").click());
    expect(props.onViewAllTasks).toHaveBeenCalledOnce();

    act(() => button("Open agent session: Broken agent").click());
    expect(props.onOpenAgentSession).toHaveBeenCalledWith("session-2", "local", "feature-2");

    act(() => button("View output: Broken schedule").click());
    expect(props.onOpenScheduleRun).toHaveBeenCalledWith("run-2", undefined);

    await act(async () => button("Run again: Broken schedule").click());
    expect(props.onRunScheduleAgain).toHaveBeenCalledWith("run-2");
  });

  it("lists starred sessions above Attention Required and opens them in place", () => {
    const props = render();

    const starred = [...container.querySelectorAll('[data-testid="starred-session"]')];
    // Server order (newest star first) is preserved verbatim.
    expect(starred.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Open starred session: Session 3",
      "Open starred session: Session 1",
    ]);
    // A remote starred session names its remote, never the raw server id.
    expect(starred[0].textContent).toContain("feature-3 · gpu-01");

    const cards = [...container.querySelectorAll("section")].map((node) => node.textContent ?? "");
    const starredIndex = cards.findIndex((text) => text.startsWith("Starred Sessions"));
    const attentionIndex = cards.findIndex((text) => text.startsWith("Attention Required"));
    expect(starredIndex).toBeGreaterThanOrEqual(0);
    expect(starredIndex).toBeLessThan(attentionIndex);

    act(() => (starred[0] as HTMLButtonElement).click());
    expect(props.onOpenAgentSession).toHaveBeenCalledWith("session-3", "remote-server-3", "feature-3");
  });

  it("disables the composer and recent threads when no Project Chat workbench is wired", () => {
    render({ onCreateThread: undefined, onOpenThread: undefined });

    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect(button("Start conversation").disabled).toBe(true);
    expect(button("Open Project Chat thread: Thread 4").disabled).toBe(true);
    expect(button("Show archived").disabled).toBe(true);
    expect(button("All threads").disabled).toBe(true);
  });

  it("opens thread history from the chat footer, archived-first when asked", async () => {
    render();
    expect(listThreadPage).not.toHaveBeenCalled();

    await act(async () => button("All threads").click());
    expect(listThreadPage).toHaveBeenLastCalledWith("project-1", expect.objectContaining({ includeArchived: false }));

    // Reopening with the other intent must not inherit the first dialog's state.
    await act(async () => button("Show archived").click());
    expect(listThreadPage).toHaveBeenLastCalledWith("project-1", expect.objectContaining({ includeArchived: true }));
  });

  it("prevents duplicate schedule reruns from Attention Required", async () => {
    let resolve!: () => void;
    const onRunScheduleAgain = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    render({ onRunScheduleAgain });

    const rerun = button("Run again: Broken schedule");
    act(() => {
      rerun.click();
      rerun.click();
    });
    expect(onRunScheduleAgain).toHaveBeenCalledTimes(1);
    expect(rerun.disabled).toBe(true);

    await act(async () => resolve());
    expect(rerun.disabled).toBe(false);
  });

  it("trims a new-thread message, prevents duplicate submit, and opens the created thread", async () => {
    let resolve!: (value: ProjectChatThread) => void;
    const onCreateThread = vi.fn(() => new Promise<ProjectChatThread>((done) => { resolve = done; }));
    const onOpenThread = vi.fn();
    render({ onCreateThread, onOpenThread });

    const composer = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setInput(composer, "  Review the release  "));
    const send = button("Start conversation");
    act(() => {
      send.click();
      send.click();
    });

    expect(onCreateThread).toHaveBeenCalledTimes(1);
    expect(onCreateThread).toHaveBeenCalledWith("Review the release");
    expect(send.disabled).toBe(true);
    expect(composer.value).toBe("  Review the release  ");

    await act(async () => resolve(thread(9)));
    expect(onOpenThread).toHaveBeenCalledWith("thread-9");
    expect(activityHook.value.refetch).toHaveBeenCalledOnce();
    expect(composer.value).toBe("");
  });

  it("preserves composer input and exposes a recoverable error after create failure", async () => {
    const onCreateThread = vi.fn(async () => { throw new Error("Network unavailable"); });
    render({ onCreateThread });

    const composer = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setInput(composer, "Keep this message"));
    await act(async () => button("Start conversation").click());

    expect(composer.value).toBe("Keep this message");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable");
    expect(button("Start conversation").disabled).toBe(false);
  });

  it("does not open a stale created thread after the dashboard unmounts", async () => {
    let resolve!: (value: ProjectChatThread) => void;
    const onCreateThread = vi.fn(() => new Promise<ProjectChatThread>((done) => { resolve = done; }));
    const onOpenThread = vi.fn();
    render({ onCreateThread, onOpenThread });

    const composer = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setInput(composer, "Create then leave"));
    act(() => button("Start conversation").click());
    act(() => root.render(<div>Another project</div>));
    await act(async () => resolve(thread(9)));

    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("does not open a stale created thread after switching projects", async () => {
    let resolve!: (value: ProjectChatThread) => void;
    const onCreateThread = vi.fn(() => new Promise<ProjectChatThread>((done) => { resolve = done; }));
    const onOpenThread = vi.fn();
    const props = render({ onCreateThread, onOpenThread });

    const composer = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setInput(composer, "Old project request"));
    act(() => button("Start conversation").click());
    act(() => root.render(<ProjectActivityView {...props} projectId="project-2" />));
    await act(async () => resolve(thread(9)));

    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("does not let an old project completion unlock a newer in-flight submission", async () => {
    const first = {} as { resolve: (value: ProjectChatThread) => void };
    const second = {} as { resolve: (value: ProjectChatThread) => void };
    const onCreateThread = vi.fn()
      .mockImplementationOnce(() => new Promise<ProjectChatThread>((done) => { first.resolve = done; }))
      .mockImplementationOnce(() => new Promise<ProjectChatThread>((done) => { second.resolve = done; }));
    const props = render({ onCreateThread });

    let composer = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setInput(composer, "Old project request"));
    act(() => button("Start conversation").click());
    act(() => root.render(<ProjectActivityView {...props} projectId="project-2" />));
    composer = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setInput(composer, "New project request"));
    act(() => button("Start conversation").click());

    await act(async () => first.resolve(thread(8)));
    act(() => composer.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onCreateThread).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve(thread(9)));
  });

  it("shows accessible loading and retryable error states", () => {
    activityHook.value = { ...activityHook.value, activity: null, loading: true };
    render();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.textContent).toContain("Loading project activity");

    activityHook.value = { ...activityHook.value, loading: false, error: "Activity unavailable" };
    render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Activity unavailable");
    act(() => button("Retry").click());
    expect(activityHook.value.refetch).toHaveBeenCalledOnce();
  });

  it("renders useful empty cards and collapses empty attention to All clear", () => {
    activityHook.value = {
      ...activityHook.value,
      activity: {
        recentThreads: [],
        recentAgentSessions: [],
        starredSessions: [],
        recentScheduleRuns: [],
        priorityTasks: [],
        attention: [],
        summary: { running: 0, nextScheduleAt: null },
      },
    };
    render();

    expect(container.textContent).toContain("No conversations yet");
    expect(container.textContent).toContain("No agent sessions yet");
    expect(container.textContent).toContain("No schedule runs yet");
    expect(container.textContent).toContain("No priority tasks");
    expect(container.textContent).toContain("No starred sessions");
    const allClear = container.querySelector('[data-testid="attention-all-clear"]');
    expect(allClear?.textContent).toContain("All clear");
    expect(allClear?.closest("div")?.className).toContain("py-3");
  });

  it("shows unread milestones as Waiting, not the activity aggregate's failures", () => {
    render({ waitingCount: 3 });

    const waiting = container.querySelector('[data-testid="waiting-count"]') as HTMLElement;
    expect(waiting.textContent).toBe("3");
    expect(waiting.getAttribute("aria-label")).toBe("3 unread updates waiting for you");
    // Attention Required below still lists 2 failed/interrupted items; the tile
    // deliberately answers a different question and may disagree with it.
    expect(container.textContent).toContain("Waiting");
    expect(container.textContent).not.toContain("Failed");
  });

  it("keeps a zero Waiting count out of alarm colours", () => {
    render({ waitingCount: 0 });
    const waiting = container.querySelector('[data-testid="waiting-count"]') as HTMLElement;
    expect(waiting.textContent).toBe("0");
    expect(waiting.className).not.toContain("amber");
    expect(waiting.className).not.toContain("destructive");

    render({ waitingCount: 1 });
    const raised = container.querySelector('[data-testid="waiting-count"]') as HTMLElement;
    expect(raised.className).toContain("text-amber-600");
    expect(raised.className).not.toContain("destructive");
  });

  it("does not promote an ordinary todo with medium priority", () => {
    activityHook.value = {
      ...activityHook.value,
      activity: {
        ...populatedActivity(),
        priorityTasks: [task("ordinary", "todo", "medium", 9)],
      },
    };
    render();

    expect(container.querySelectorAll('[data-testid="priority-task"]')).toHaveLength(0);
    expect(container.textContent).toContain("No priority tasks");
  });
});
