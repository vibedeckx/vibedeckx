import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";
import { ProcessManager, type LogMessage } from "./process-manager.js";
import type { Executor } from "./storage/types.js";
import type { EventBus, GlobalEvent } from "./event-bus.js";

/**
 * A process is finalized exactly once, and only when it is really gone.
 *
 * Node emits 'error' on a ChildProcess for more than a failed spawn — a failed
 * kill or IPC send raises it too, on a child that is still running. Treating
 * that as an exit fabricates a `finished`, tells the UI the executor stopped,
 * and (since the exit path also schedules retention cleanup) drops a live
 * process out of the tracking map.
 */

const executor = (id: string, command: string): Executor => ({
  id, project_id: "p1", workspace_id: "", name: id,
  command, executor_type: "command", prompt_provider: null,
  cwd: null, pty: false, position: 0, disabled_targets: [],
  created_at: new Date().toISOString(),
});

function recordingBus() {
  const events: GlobalEvent[] = [];
  return { bus: { emit: (e: GlobalEvent) => { events.push(e); } } as unknown as EventBus, events };
}

const stoppedEvents = (events: GlobalEvent[]) => events.filter((e) => e.type === "executor:stopped");
const finishedLogs = (logs: LogMessage[]) => logs.filter((l) => l.type === "finished");

/**
 * Drive the non-PTY starter directly: `start()` always tries PTY first and
 * only falls back to this path when node-pty cannot spawn, so going through it
 * would exercise an IPty (which has no 'error' event at all).
 */
function startRegular(pm: ProcessManager, processId: string, exec: Executor) {
  (pm as unknown as {
    startRegularProcess: (id: string, e: Executor, cwd: string, skipDb: boolean) => void;
  }).startRegularProcess(processId, exec, "/tmp", true);
}

/** The live ChildProcess behind a started process id. */
function childOf(pm: ProcessManager, processId: string): ChildProcess {
  const processes = (pm as unknown as { processes: Map<string, { process: ChildProcess }> }).processes;
  return processes.get(processId)!.process;
}
const logsOf = (pm: ProcessManager, processId: string) => pm.getLogs(processId);

describe("ProcessManager terminal path", () => {
  it("does not finalize a still-running process that emits 'error'", async () => {
    const pm = new ProcessManager(null as never);
    const { bus, events } = recordingBus();
    pm.setEventBus(bus);

    startRegular(pm, "run-alive", executor("e-alive", "sleep 5"));
    const child = childOf(pm, "run-alive");
    expect(child.pid).toBeDefined();

    // What a failed kill looks like to this handler.
    child.emit("error", new Error("kill EPERM"));

    // Recorded as output, but the process is alive: no exit, no stopped event.
    expect(logsOf(pm, "run-alive")).toContainEqual(
      expect.objectContaining({ type: "stderr", data: expect.stringContaining("kill EPERM") }),
    );
    expect(finishedLogs(logsOf(pm, "run-alive"))).toHaveLength(0);
    expect(stoppedEvents(events)).toHaveLength(0);
    expect(pm.isRunning("run-alive")).toBe(true);

    // The real exit still finalizes it, exactly once.
    await pm.stop("run-alive");
    await vi.waitFor(() => expect(finishedLogs(logsOf(pm, "run-alive"))).toHaveLength(1));
    expect(stoppedEvents(events)).toHaveLength(1);
  });

  it("finalizes once when a process both errors and closes", async () => {
    const pm = new ProcessManager(null as never);
    const { bus, events } = recordingBus();
    pm.setEventBus(bus);

    startRegular(pm, "run-exit", executor("e-exit", "true"));
    await vi.waitFor(() => expect(finishedLogs(logsOf(pm, "run-exit"))).toHaveLength(1));

    // A late error after the close must not append a second exit.
    childOf(pm, "run-exit").emit("error", new Error("late failure"));

    expect(finishedLogs(logsOf(pm, "run-exit"))).toHaveLength(1);
    expect(stoppedEvents(events)).toHaveLength(1);
  });
});
