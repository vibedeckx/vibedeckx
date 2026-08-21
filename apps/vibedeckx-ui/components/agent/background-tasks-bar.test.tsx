// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundTasksBar } from "./background-tasks-bar";
import type { BackgroundTask } from "@/lib/api";

const NOW = 1_787_285_507_000;

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId: "b1",
  taskType: "local_bash",
  description: "Wait for build to finish",
  startedAt: NOW - 60_000,
  ...over,
});

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => { root.render(node); });
}

function expand() {
  act(() => { container.querySelector("button")!.click(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

describe("BackgroundTasksBar", () => {
  it("renders nothing when no task is running", () => {
    render(<BackgroundTasksBar tasks={[]} turnParked={false} />);
    expect(container.textContent).toBe("");
  });

  // The whole point of the bar: the session sits at "running" with no divider
  // and no other on-screen explanation, so this line is the only thing that
  // tells the user the agent is done and what is holding the turn open.
  it("says the turn is already answered when a completion is parked", () => {
    render(<BackgroundTasksBar tasks={[task()]} turnParked />);
    expect(container.textContent).toContain("本轮已答完");
    expand();
    expect(container.textContent).toContain("保持「运行中」");
  });

  it("does not claim the turn is over while the agent is still working", () => {
    render(<BackgroundTasksBar tasks={[task()]} turnParked={false} />);
    expect(container.textContent).not.toContain("本轮已答完");
    expand();
    expect(container.textContent).toContain("agent 仍在工作");
  });

  // local_agent is a subagent inside the same CLI process, not an OS process.
  it("counts processes and subagents separately", () => {
    render(
      <BackgroundTasksBar
        tasks={[
          task({ taskId: "b1" }),
          task({ taskId: "b2" }),
          task({ taskId: "a1", taskType: "local_agent", description: "a subagent" }),
        ]}
        turnParked
      />,
    );
    expect(container.textContent).toContain("2 个后台进程");
    expect(container.textContent).toContain("1 个后台子 agent");
  });

  it("reports the longest-running task and keeps the clock moving", () => {
    render(<BackgroundTasksBar tasks={[task({ startedAt: NOW - 90_000 }), task({ taskId: "b2" })]} turnParked />);
    expect(container.textContent).toContain("1m 30s");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(container.textContent).toContain("1m 35s");
  });

  // `now` is seeded at mount but tasks usually appear later, so the frame
  // before the first tick can be older than the task itself.
  it("never renders a negative age from a stale clock", () => {
    render(<BackgroundTasksBar tasks={[task({ startedAt: NOW + 30_000 })]} turnParked />);
    expect(container.textContent).not.toContain("-");
    expect(container.textContent).toContain("0s");
  });

  it("falls back to the task id when the harness sent no description", () => {
    render(<BackgroundTasksBar tasks={[task({ description: undefined, taskId: "bia7w8yz2" })]} turnParked />);
    expand();
    expect(container.textContent).toContain("bia7w8yz2");
  });
});
