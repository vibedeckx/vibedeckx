// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProjectChatContextNavigation, type ProjectChatContextNavigationOptions } from "./use-project-chat-context-navigation";
import type { Project, ProjectChatContextRef, Task } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task: Task = {
  id: "task-1", project_id: "project-1", title: "Fix login", description: null,
  status: "todo", priority: "high", assigned_branch: null, position: 0, archived_at: null,
  created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
};

const ref = (navigation: NonNullable<ProjectChatContextRef["navigation"]>): ProjectChatContextRef => ({
  thread_id: "thread-1", entity_type: navigation.kind, entity_id: "entity-1",
  last_referenced_at: "2026-08-01T00:00:00Z", deleted: false, navigation,
});

let root: Root;
let container: HTMLDivElement;
let latest!: ReturnType<typeof useProjectChatContextNavigation>;

function Harness(props: ProjectChatContextNavigationOptions) {
  const value = useProjectChatContextNavigation(props);
  useEffect(() => { latest = value; }, [value]);
  return null;
}

function options(overrides: Partial<ProjectChatContextNavigationOptions> = {}): ProjectChatContextNavigationOptions {
  return {
    projectId: "project-1",
    schedules: [{ id: "schedule-1", project_id: "project-1" } as ProjectChatContextNavigationOptions["schedules"][number]],
    getTasks: vi.fn(async () => [task]),
    resolveProjectForTarget: vi.fn(async (projectId) => ({ id: projectId } as Project)),
    openTask: vi.fn(),
    selectAgentSession: vi.fn(),
    selectWorkspace: vi.fn(),
    selectSchedule: vi.fn(),
    openScheduleRun: vi.fn(async () => {}),
    onError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useProjectChatContextNavigation", () => {
  it("opens every resolved public Context kind through an authorized app seam", async () => {
    const opts = options();
    act(() => root.render(<Harness {...opts} />));

    await act(async () => latest.open(ref({ kind: "task", taskId: "task-1", label: "Fix login" })));
    expect(opts.getTasks).toHaveBeenCalledWith("project-1", { includeArchived: true });
    expect(opts.openTask).toHaveBeenCalledWith(task);

    await act(async () => latest.open(ref({ kind: "agent_session", sessionId: "session-1", target: "remote-1", branch: "dev", label: "Dev" })));
    expect(opts.resolveProjectForTarget).toHaveBeenCalledWith("project-1", "remote-1");
    expect(opts.selectAgentSession).toHaveBeenCalledWith("dev", "session-1", "project-1");

    await act(async () => latest.open(ref({ kind: "workspace", target: "local", branch: null, label: "main" })));
    expect(opts.selectWorkspace).toHaveBeenCalledWith(null, "project-1");

    await act(async () => latest.open(ref({ kind: "schedule", scheduleId: "schedule-1", label: "Nightly" })));
    expect(opts.selectSchedule).toHaveBeenCalledWith("schedule-1");

    await act(async () => latest.open(ref({ kind: "schedule_run", scheduleId: "schedule-1", runId: "run-1", label: "Nightly" })));
    expect(opts.openScheduleRun).toHaveBeenCalledWith("run-1", "schedule-1");
  });

  it("drops stale asynchronous navigation after the selected project changes", async () => {
    let resolveTasks!: (tasks: Task[]) => void;
    const getTasks = vi.fn(() => new Promise<Task[]>((resolve) => { resolveTasks = resolve; }));
    const first = options({ getTasks });
    act(() => root.render(<Harness {...first} />));

    let pending!: Promise<void>;
    act(() => { pending = latest.open(ref({ kind: "task", taskId: "task-1", label: "Fix login" })); });
    const second = options({ projectId: "project-2", getTasks: vi.fn(async () => []) });
    act(() => root.render(<Harness {...second} />));
    await act(async () => { resolveTasks([task]); await pending; });

    expect(first.openTask).not.toHaveBeenCalled();
    expect(first.onError).not.toHaveBeenCalled();
  });

  it("reports missing or mismatched selectors instead of performing a no-op", async () => {
    const opts = options({ getTasks: vi.fn(async () => []) });
    act(() => root.render(<Harness {...opts} />));

    await act(async () => latest.open(ref({ kind: "task", taskId: "missing", label: "Missing" })));

    expect(opts.openTask).not.toHaveBeenCalled();
    expect(opts.onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
