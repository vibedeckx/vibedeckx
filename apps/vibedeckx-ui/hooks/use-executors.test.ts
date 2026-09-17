import { describe, expect, it, vi } from "vitest";
import type { ExecutorProcess } from "@/lib/api";
import {
  alreadyRunningProcessId,
  buildExecutorEventsUrl,
  buildRunningProcessMaps,
  pruneLastStartedProcess,
  stopFailureMeansStopped,
} from "./use-executors";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getAuthToken: vi.fn(),
  };
});

import { ExecutorProcessRequestError, getAuthToken } from "@/lib/api";

function makeProcess(
  id: string,
  executorId: string,
  target = "local",
): ExecutorProcess {
  return {
    id,
    executor_id: executorId,
    status: "running",
    exit_code: null,
    started_at: "2026-04-15T00:00:00Z",
    finished_at: null,
    target,
  };
}

describe("buildRunningProcessMaps", () => {
  it("builds running and last-started maps from the server snapshot", () => {
    const { runningProcesses, lastStartedProcess } = buildRunningProcessMaps([
      makeProcess("proc-1", "exec-1"),
      makeProcess("proc-2", "exec-2", "remote-a"),
    ]);

    expect(runningProcesses.get("exec-1")).toEqual([
      { processId: "proc-1", target: "local" },
    ]);
    expect(runningProcesses.get("exec-2")).toEqual([
      { processId: "proc-2", target: "remote-a" },
    ]);
    expect(lastStartedProcess.get("exec-1")).toEqual({
      processId: "proc-1",
      target: "local",
    });
    expect(lastStartedProcess.get("exec-2")).toEqual({
      processId: "proc-2",
      target: "remote-a",
    });
  });
});

describe("pruneLastStartedProcess", () => {
  it("drops stale fallback entries when the authoritative running snapshot is empty", () => {
    const previous = new Map([
      ["exec-1", { processId: "proc-1", target: "local" }],
    ]);

    const next = pruneLastStartedProcess(previous, new Map());

    expect(next.size).toBe(0);
  });

  it("keeps fallback entries only when the same process is still running", () => {
    const previous = new Map([
      ["exec-1", { processId: "proc-1", target: "local" }],
      ["exec-2", { processId: "proc-2", target: "remote-a" }],
    ]);
    const running = new Map([
      ["exec-1", [{ processId: "proc-1", target: "local" }]],
      ["exec-2", [{ processId: "proc-9", target: "remote-a" }]],
    ]);

    const next = pruneLastStartedProcess(previous, running);

    expect(next.get("exec-1")).toEqual({
      processId: "proc-1",
      target: "local",
    });
    expect(next.has("exec-2")).toBe(false);
  });
});

describe("buildExecutorEventsUrl", () => {
  it("includes the auth token for authenticated SSE connections", () => {
    vi.mocked(getAuthToken).mockReturnValue("secret token");
    const originalWindow = global.window;
    Object.defineProperty(global, "window", {
      value: {
        location: { hostname: "localhost", port: "3000" },
      },
      configurable: true,
    });

    try {
      expect(buildExecutorEventsUrl()).toBe(
        "http://localhost:5173/api/events?token=secret%20token",
      );
    } finally {
      Object.defineProperty(global, "window", {
        value: originalWindow,
        configurable: true,
      });
    }
  });
});

describe("stopFailureMeansStopped", () => {
  it("clears the process only when the server says it is gone", () => {
    expect(stopFailureMeansStopped(new ExecutorProcessRequestError(404, { error: "Process not found" }))).toBe(true);
  });

  it.each([
    ["an unreachable remote", new ExecutorProcessRequestError(502, { error: "Remote server is not connected" })],
    ["an unverified remote stop", new ExecutorProcessRequestError(502, { error: "Remote process could not be stopped" })],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("keeps the process running after %s", (_label, error) => {
    expect(stopFailureMeansStopped(error)).toBe(false);
  });
});

describe("alreadyRunningProcessId", () => {
  it("returns the confirmed process of an already-running conflict", () => {
    const error = new ExecutorProcessRequestError(409, { code: "already_running", processId: "remote-e1-p1" });
    expect(alreadyRunningProcessId(error)).toBe("remote-e1-p1");
  });

  it.each([
    ["a start still in flight", new ExecutorProcessRequestError(409, { code: "starting" })],
    ["a disabled target", new ExecutorProcessRequestError(409, { error: "Executor is disabled for this target" })],
    ["an unknown start result", new ExecutorProcessRequestError(503, { code: "start_unknown" })],
    ["a conflict without a process", new ExecutorProcessRequestError(409, { code: "already_running" })],
  ])("ignores %s", (_label, error) => {
    expect(alreadyRunningProcessId(error)).toBeNull();
  });
});
