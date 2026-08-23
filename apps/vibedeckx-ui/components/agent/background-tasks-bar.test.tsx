// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  keepBackgroundTaskRunning: vi.fn(async () => undefined),
  stopBackgroundTask: vi.fn(async () => true),
}));

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
    render(<BackgroundTasksBar sessionId="s1" canStopTasks agentWorking={false} parkDeadlineAt={null} tasks={[]} turnParked={false} />);
    expect(container.textContent).toBe("");
  });

  // The whole point of the bar: the session sits at "running" with no divider
  // and no other on-screen explanation, so this line is the only thing that
  // tells the user the agent is done and what is holding the turn open.
  it("says the turn is already answered when a completion is parked", () => {
    render(<BackgroundTasksBar sessionId="s1" canStopTasks agentWorking={false} parkDeadlineAt={null} tasks={[task()]} turnParked />);
    expect(container.textContent).toContain("Response complete");
    expand();
    expect(container.textContent).toContain("keeping the session running");
  });

  // Both "agent still working" and "turn already closed" have
  // `turnParked === false`; only `agentWorking` tells them apart. Collapsing
  // them put "本轮已收尾" in the header while the body said the opposite.
  it("does not claim the turn is over while the agent is still working", () => {
    render(
      <BackgroundTasksBar
        sessionId="s1"
        canStopTasks
        agentWorking
        parkDeadlineAt={null}
        tasks={[task()]}
        turnParked={false}
      />,
    );
    expect(container.textContent).not.toContain("Response complete");
    expect(container.textContent).not.toContain("This turn has closed");
    expect(container.textContent).toContain("Running alongside the agent");
    expand();
    expect(container.textContent).toContain("The agent is still working");
    expect(container.textContent).not.toContain("This turn has closed");
  });

  it("says the turn is over once it closed and the tasks outlived it", () => {
    render(
      <BackgroundTasksBar
        sessionId="s1"
        canStopTasks
        agentWorking={false}
        parkDeadlineAt={null}
        tasks={[task()]}
        turnParked={false}
      />,
    );
    expect(container.textContent).toContain("This turn has closed");
    expand();
    expect(container.textContent).toContain("these tasks are still running");
    expect(container.textContent).not.toContain("The agent is still working");
  });

  // Codex has no stop primitive. Showing the button and only hiding it after
  // the first click returned 501 is a button that is dead on arrival.
  it("never offers a stop the agent cannot perform", () => {
    render(
      <BackgroundTasksBar
        sessionId="s1"
        canStopTasks={false}
        agentWorking={false}
        parkDeadlineAt={NOW + 60_000}
        tasks={[task()]}
        turnParked
      />,
    );
    expand();
    expect([...container.querySelectorAll("li button")].map((b) => b.textContent)).toEqual(["Keep running"]);
    expect(container.textContent).toContain("cannot stop individual background tasks");
  });

  // local_agent is a subagent inside the same CLI process, not an OS process.
  it("counts processes and subagents separately", () => {
    render(
      <BackgroundTasksBar
        sessionId="s1" canStopTasks agentWorking={false}
        parkDeadlineAt={null}
        tasks={[
          task({ taskId: "b1" }),
          task({ taskId: "b2" }),
          task({ taskId: "a1", taskType: "local_agent", description: "a subagent" }),
        ]}
        turnParked
      />,
    );
    expect(container.textContent).toContain("2 background processes");
    expect(container.textContent).toContain("1 background subagent");
  });

  // Each task kind has a distinct icon, with an accessible label so the type
  // information is not conveyed visually alone.
  it("shows an accessible type icon on every row", () => {
    render(
      <BackgroundTasksBar
        sessionId="s1" canStopTasks agentWorking={false}
        parkDeadlineAt={null}
        tasks={[
          task({ taskId: "b1" }),
          task({ taskId: "a1", taskType: "local_agent", description: "a subagent" }),
          task({ taskId: "c1", taskType: "codex_subagent", description: "a codex subagent" }),
          task({ taskId: "x1", taskType: undefined, description: "something new" }),
        ]}
        turnParked
      />,
    );
    expand();
    const indicators = [...container.querySelectorAll("li > span:first-child")];
    expect(indicators.map((el) => el.getAttribute("aria-label"))).toEqual(["Process", "Subagent", "Subagent", "Task"]);
    expect(indicators.map((el) => el.querySelector("svg")?.getAttribute("class"))).toEqual([
      expect.stringContaining("lucide-terminal"),
      expect.stringContaining("lucide-bot"),
      expect.stringContaining("lucide-bot"),
      expect.stringContaining("lucide-list-todo"),
    ]);
  });

  // Codex's subagents are threads inside the CLI process, same as Claude
  // Code's — counting them as untyped "tasks" while badging them as agents
  // would be the drift this shares one function to avoid.
  it("counts codex subagents as subagents, not as untyped tasks", () => {
    render(<BackgroundTasksBar sessionId="s1" canStopTasks agentWorking={false} parkDeadlineAt={null} tasks={[task({ taskType: "codex_subagent" })]} turnParked />);
    expect(container.textContent).toContain("1 background subagent");
  });

  // The countdown is the whole product promise: it turns "is this broken?"
  // into a number and a deadline the user can act on.
  it("counts down to the park deadline and warns while it runs", () => {
    render(
      <BackgroundTasksBar sessionId="s1" canStopTasks agentWorking={false} tasks={[task()]} turnParked parkDeadlineAt={NOW + 167_000} />,
    );
    expect(container.textContent).toContain("2:47 until this turn closes automatically");
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(container.textContent).toContain("2:45 until this turn closes automatically");
    expect(container.querySelector(".border-amber-500\\/40")).not.toBeNull();
  });

  // Past the deadline the turn is already closed: the bar must stop promising
  // a cleanup that has happened, and stop implying the agent is still working.
  it("switches to 'turn closed' once the deadline has passed", () => {
    render(
      <BackgroundTasksBar sessionId="s1" canStopTasks agentWorking={false} tasks={[task()]} turnParked={false} parkDeadlineAt={null} />,
    );
    expect(container.textContent).toContain("This turn has closed");
    expect(container.textContent).not.toContain("closes automatically");
  });

  // Vouching restores the original waiting behavior — and the bar has to say
  // so, otherwise the countdown just vanishes with no explanation.
  it("says a vouched-for task is being waited on deliberately", () => {
    render(
      <BackgroundTasksBar
        sessionId="s1" canStopTasks agentWorking={false}
        tasks={[task({ sanctioned: true })]}
        turnParked
        parkDeadlineAt={null}
      />,
    );
    expect(container.textContent).toContain("Set to keep running");
    expand();
    expect(container.textContent).toContain("will not close automatically");
    // Vouching removes only "keep running" — there is no deadline left to
    // defuse. "Stop" has to survive it: someone who vouched for a build and
    // later finds it was stuck would otherwise have no way out but stopping
    // the whole session.
    expect([...container.querySelectorAll("li button")].map((b) => b.textContent)).toEqual(["Stop"]);
  });

  // The decision is per task: one of three may be a stuck poller while the
  // others are a real build, so a bulk button would force the wrong call.
  it("offers both actions on an undecided row, and only stop on a vouched-for one", () => {
    render(
      <BackgroundTasksBar
        sessionId="s1" canStopTasks agentWorking={false}
        tasks={[
          task({ taskId: "b1", description: "stuck poller" }),
          task({ taskId: "b2", description: "a real build", sanctioned: true }),
        ]}
        turnParked
        parkDeadlineAt={NOW + 60_000}
      />,
    );
    expand();
    const rows = [...container.querySelectorAll("li")];
    const labels = (i: number) => [...rows[i].querySelectorAll("button")].map((b) => b.textContent);
    expect(labels(0)).toEqual(["Keep running", "Stop"]);
    expect(labels(1)).toEqual(["Stop"]);
  });

  // The bar outlives the turn: after a deadline commits, the task keeps
  // running and stopping it is still the only thing that clears it.
  it("keeps the stop action after the turn is already closed", () => {
    render(
      <BackgroundTasksBar sessionId="s1" canStopTasks agentWorking={false} tasks={[task()]} turnParked={false} parkDeadlineAt={null} />,
    );
    expand();
    expect([...container.querySelectorAll("li button")].map((b) => b.textContent)).toEqual(["Stop"]);
  });

  it("calls the per-task endpoints with that row's task id", async () => {
    const { keepBackgroundTaskRunning, stopBackgroundTask } = await import("@/lib/api");
    render(
      <BackgroundTasksBar
        sessionId="s1" canStopTasks agentWorking={false}
        tasks={[task({ taskId: "b1" }), task({ taskId: "b2" })]}
        turnParked
        parkDeadlineAt={NOW + 60_000}
      />,
    );
    expand();
    const buttons = [...container.querySelectorAll("li")[1].querySelectorAll("button")];
    // Awaited: a click disables its row's buttons until the request settles,
    // so a synchronous second click would land on a disabled button.
    await act(async () => { buttons[0].click(); });
    await act(async () => { buttons[1].click(); });
    expect(vi.mocked(keepBackgroundTaskRunning)).toHaveBeenCalledWith("s1", "b2");
    expect(vi.mocked(stopBackgroundTask)).toHaveBeenCalledWith("s1", "b2");
  });

  it("reports the longest-running task and keeps the clock moving", () => {
    render(<BackgroundTasksBar sessionId="s1" canStopTasks agentWorking={false} parkDeadlineAt={null} tasks={[task({ startedAt: NOW - 90_000 }), task({ taskId: "b2" })]} turnParked />);
    expect(container.textContent).toContain("1m 30s");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(container.textContent).toContain("1m 35s");
  });

  // `now` is seeded at mount but tasks usually appear later, so the frame
  // before the first tick can be older than the task itself.
  it("never renders a negative age from a stale clock", () => {
    render(<BackgroundTasksBar sessionId="s1" canStopTasks agentWorking={false} parkDeadlineAt={null} tasks={[task({ startedAt: NOW + 30_000 })]} turnParked />);
    expect(container.textContent).not.toContain("-");
    expect(container.textContent).toContain("0s");
  });

  it("falls back to the task id when the harness sent no description", () => {
    render(<BackgroundTasksBar sessionId="s1" canStopTasks agentWorking={false} parkDeadlineAt={null} tasks={[task({ description: undefined, taskId: "bia7w8yz2" })]} turnParked />);
    expand();
    expect(container.textContent).toContain("bia7w8yz2");
  });
});
