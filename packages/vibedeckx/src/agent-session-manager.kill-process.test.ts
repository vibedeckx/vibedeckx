import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";

// Exercise the signal boundary without starting a session or a real process.
const manager = Object.create(AgentSessionManager.prototype) as {
  killProcess(proc: ChildProcess | null, signal?: NodeJS.Signals): void;
};

beforeEach(() => {
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function child(pid: number | undefined) {
  return { pid, kill: vi.fn(() => true) } as unknown as ChildProcess;
}

describe("safe child process termination", () => {
  it.each([undefined, 0, 1, -1, -42, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not signal an invalid child PID %s",
    (pid) => {
      const proc = child(pid);
      manager.killProcess(proc);
      expect(process.kill).not.toHaveBeenCalled();
      expect(proc.kill).not.toHaveBeenCalled();
    },
  );

  it("ignores an absent child", () => {
    manager.killProcess(null);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it.each(["SIGTERM", "SIGKILL"] as const)("signals only the child group with %s", (signal) => {
    const proc = child(12345);
    manager.killProcess(proc, signal);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-12345, signal);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("defaults to SIGTERM and falls back to the individual child", () => {
    vi.mocked(process.kill).mockImplementation(() => { throw new Error("no process group"); });
    const proc = child(12345);
    manager.killProcess(proc);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-12345, "SIGTERM");
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  it("tolerates an already exited child", () => {
    vi.mocked(process.kill).mockImplementation(() => { throw new Error("no process group"); });
    const proc = child(12345);
    vi.mocked(proc.kill).mockImplementation(() => { throw new Error("already exited"); });
    expect(() => manager.killProcess(proc)).not.toThrow();
  });
});
