// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectActivityActions, type ProjectActivityActionsOptions } from "./use-project-activity-actions";
import type { Project, Schedule, ScheduleRun } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = (id: string): Project => ({
  id, name: id, path: `/tmp/${id}`, is_remote: false, agent_mode: "local", executor_mode: "local",
  created_at: "2026-07-31T00:00:00.000Z",
});
const run = (projectId = "project-1"): ScheduleRun => ({
  id: "source-run", schedule_id: "schedule-1", project_id: projectId, status: "failed",
  exit_code: 1, process_id: null, started_at: "2026-07-31T00:00:00.000Z", finished_at: null,
});
const schedule = (projectId = "project-1"): Schedule => ({
  id: "schedule-1", project_id: projectId, name: "Nightly", cron_expr: "0 0 * * *", timezone: "UTC",
  target: "local", enabled: true, run_type: "command", prompt_provider: null, content: "test",
  cwd_mode: "branch", branch: null, directory: null, timeout_seconds: 60,
  created_at: "2026-07-31T00:00:00.000Z", updated_at: "2026-07-31T00:00:00.000Z",
});

let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof useProjectActivityActions>;

function Harness(props: ProjectActivityActionsOptions) {
  const current = useProjectActivityActions(props);
  useEffect(() => { actions = current; }, [current]);
  return null;
}

function setup(projectId = "project-1", overrides: Partial<ProjectActivityActionsOptions> = {}) {
  const options: ProjectActivityActionsOptions = {
    resolveProjectForTarget: vi.fn(async (id) => project(id)),
    getScheduleRun: vi.fn(async () => run(projectId)),
    getSchedules: vi.fn(async () => [schedule(projectId)]),
    runScheduleNow: vi.fn(async (_id, request) => ({ runId: request.runId })),
    selectAgentSession: vi.fn(),
    openScheduleRun: vi.fn(),
    onRerunStarted: vi.fn(),
    onError: vi.fn(),
    ...overrides,
    projectId,
  };
  act(() => root.render(<Harness {...options} />));
  return options;
}

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.sessionStorage.clear();
});

describe("useProjectActivityActions", () => {
  it("drops deferred session and run navigation after a synchronous project switch", async () => {
    let resolveProject!: (value: Project) => void;
    const resolveProjectForTarget = vi.fn(() => new Promise<Project>((resolve) => { resolveProject = resolve; }));
    let resolveRun!: (value: ScheduleRun) => void;
    const getScheduleRun = vi.fn(() => new Promise<ScheduleRun>((resolve) => { resolveRun = resolve; }));
    const first = setup("project-1", { resolveProjectForTarget, getScheduleRun });

    let sessionPromise!: Promise<void>;
    let runPromise!: Promise<void>;
    act(() => {
      sessionPromise = actions.openAgentSession("session-1", "local", null);
      runPromise = actions.openScheduleRun("source-run", "schedule-1");
    });
    setup("project-2", first);
    await act(async () => {
      resolveProject(project("project-1"));
      resolveRun(run("project-1"));
      await Promise.all([sessionPromise, runPromise]);
    });

    expect(first.selectAgentSession).not.toHaveBeenCalled();
    expect(first.openScheduleRun).not.toHaveBeenCalled();
    expect(first.getSchedules).not.toHaveBeenCalled();
  });

  it("revalidates run and schedule scope before mutation and rejects a stale project", async () => {
    let resolveSchedules!: (value: Schedule[]) => void;
    const getSchedules = vi.fn(() => new Promise<Schedule[]>((resolve) => { resolveSchedules = resolve; }));
    const first = setup("project-1", { getSchedules });
    let promise!: Promise<void>;
    act(() => { promise = actions.runScheduleAgain("source-run"); });
    await act(async () => {});
    setup("project-2", first);
    await act(async () => {
      resolveSchedules([schedule("project-1")]);
      await promise;
    });
    expect(first.runScheduleNow).not.toHaveBeenCalled();
    expect(first.onRerunStarted).not.toHaveBeenCalled();
  });

  it("retains one rerun identity after a recoverable failure, clears it on conflict, and rethrows", async () => {
    const conflict = Object.assign(new Error("payload mismatch"), { status: 409 });
    const runScheduleNow = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ runId: "eventual" });
    const options = setup("project-1", { runScheduleNow });

    await expect(actions.runScheduleAgain("source-run")).rejects.toThrow("response lost");
    await expect(actions.runScheduleAgain("source-run")).rejects.toThrow("payload mismatch");
    await expect(actions.runScheduleAgain("source-run")).resolves.toBeUndefined();

    const first = runScheduleNow.mock.calls[0][1];
    const retry = runScheduleNow.mock.calls[1][1];
    const afterConflict = runScheduleNow.mock.calls[2][1];
    expect(retry).toEqual(first);
    expect(afterConflict.requestId).not.toBe(first.requestId);
    expect(first).toMatchObject({ sourceRunId: "source-run", requestId: expect.any(String), runId: expect.any(String) });
    expect(options.onError).toHaveBeenCalledTimes(2);
    expect(options.onRerunStarted).toHaveBeenCalledOnce();
  });

  it("coalesces duplicate rerun calls while one mutation is in flight", async () => {
    let resolve!: (value: { runId: string }) => void;
    const runScheduleNow = vi.fn(() => new Promise<{ runId: string }>((done) => { resolve = done; }));
    setup("project-1", { runScheduleNow });
    const first = actions.runScheduleAgain("source-run");
    const duplicate = actions.runScheduleAgain("source-run");
    await act(async () => {});
    expect(runScheduleNow).toHaveBeenCalledOnce();
    await act(async () => resolve({ runId: "run-1" }));
    await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined]);
  });
});
