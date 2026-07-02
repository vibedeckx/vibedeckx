import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage, Executor } from "./storage/types.js";
import type { ProcessManager, LogMessage } from "./process-manager.js";
import { SchedulerService, validateCron } from "./scheduler.js";

describe("validateCron", () => {
  it("accepts a standard 5-field expression", () => {
    expect(validateCron("0 9 * * *")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(validateCron("not a cron")).toBeTypeOf("string");
  });
  it("rejects an invalid timezone", () => {
    expect(validateCron("0 9 * * *", "Mars/Olympus")).toContain("Invalid timezone");
  });
  it("accepts a valid timezone", () => {
    expect(validateCron("0 9 * * *", "Asia/Shanghai")).toBeNull();
  });
});

function makeFakeProcessManager() {
  const subscribers = new Map<string, (msg: LogMessage) => void>();
  let counter = 0;
  const fake = {
    started: [] as { executor: Executor; cwd: string; skipDb: boolean }[],
    stopped: [] as string[],
    start(executor: Executor, cwd: string, skipDb = false): string {
      const id = `proc-${++counter}`;
      fake.started.push({ executor, cwd, skipDb });
      return id;
    },
    subscribe(processId: string, cb: (msg: LogMessage) => void) {
      subscribers.set(processId, cb);
      return () => subscribers.delete(processId);
    },
    stop(processId: string): boolean {
      fake.stopped.push(processId);
      return true;
    },
    emit(processId: string, msg: LogMessage) {
      subscribers.get(processId)?.(msg);
    },
  };
  return fake;
}

describe("SchedulerService.runNow", () => {
  let dir: string;
  let storage: Storage;
  let pm: ReturnType<typeof makeFakeProcessManager>;
  let scheduler: SchedulerService;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-schedsvc-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    storage.projects.create({ id: "proj-1", name: "p", path: dir });
    storage.scheduledTasks.create({
      id: "s1", project_id: "proj-1", name: "echo", cron_expr: "0 9 * * *",
      timezone: "UTC", run_type: "command", content: "echo hi",
      cwd_mode: "directory", directory: dir, timeout_seconds: 60,
    });
    pm = makeFakeProcessManager();
    scheduler = new SchedulerService(storage, pm as unknown as ProcessManager);
  });

  afterEach(() => {
    scheduler.shutdown();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns with skipDb in the task directory and records a completed run with output", () => {
    const result = scheduler.runNow("s1");
    expect(result).toMatchObject({ skipped: false });
    expect(pm.started[0].cwd).toBe(dir);
    expect(pm.started[0].skipDb).toBe(true);
    expect(pm.started[0].executor.executor_type).toBe("command");
    expect(pm.started[0].executor.command).toBe("echo hi");
    expect(scheduler.isRunning("s1")).toBe(true);

    pm.emit("proc-1", { type: "stdout", data: "hello " });
    pm.emit("proc-1", { type: "stdout", data: "world" });
    pm.emit("proc-1", { type: "finished", exitCode: 0 });

    const runId = (result as { runId: string }).runId;
    const run = storage.scheduledTaskRuns.getById(runId);
    expect(run?.status).toBe("completed");
    expect(run?.exit_code).toBe(0);
    expect(run?.output).toBe("hello world");
    expect(scheduler.isRunning("s1")).toBe(false);
  });

  it("records failed on non-zero exit", () => {
    const result = scheduler.runNow("s1") as { runId: string };
    pm.emit("proc-1", { type: "finished", exitCode: 3 });
    const run = storage.scheduledTaskRuns.getById(result.runId);
    expect(run?.status).toBe("failed");
    expect(run?.exit_code).toBe(3);
  });

  it("skips (and records the skip) when a run is already active", () => {
    scheduler.runNow("s1");
    const second = scheduler.runNow("s1");
    expect(second).toMatchObject({ skipped: true });
    const runs = storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(runs.some((r) => r.status === "skipped")).toBe(true);
  });

  it("kills and marks timeout when the run exceeds timeout_seconds", () => {
    vi.useFakeTimers();
    try {
      const result = scheduler.runNow("s1") as { runId: string };
      vi.advanceTimersByTime(61_000);
      expect(pm.stopped).toContain("proc-1");
      expect(storage.scheduledTaskRuns.getById(result.runId)?.status).toBe("timeout");
      // A late 'finished' after the kill must not overwrite the timeout status
      pm.emit("proc-1", { type: "finished", exitCode: 137 });
      expect(storage.scheduledTaskRuns.getById(result.runId)?.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prompt tasks are fabricated as claude prompt executors", () => {
    storage.scheduledTasks.create({
      id: "s2", project_id: "proj-1", name: "ai", cron_expr: "0 9 * * *",
      timezone: "UTC", run_type: "prompt", content: "analyze the logs",
      cwd_mode: "directory", directory: dir,
    });
    scheduler.runNow("s2");
    const started = pm.started[pm.started.length - 1];
    expect(started.executor.executor_type).toBe("prompt");
    expect(started.executor.prompt_provider).toBe("claude");
    expect(started.executor.command).toBe("analyze the logs");
  });

  it("fails without spawning when the directory does not exist", () => {
    storage.scheduledTasks.update("s1", { directory: path.join(dir, "missing") });
    const result = scheduler.runNow("s1");
    expect(result).toMatchObject({ error: expect.stringContaining("does not exist") });
    expect(pm.started).toHaveLength(0);
    const runs = storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(runs[0].status).toBe("failed");
  });
});
