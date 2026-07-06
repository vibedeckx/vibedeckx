import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage, Executor } from "./storage/types.js";
import type { ProcessManager, LogMessage } from "./process-manager.js";
import { EventBus, type GlobalEvent } from "./event-bus.js";
import type { RemoteExecutorInfo } from "./server-types.js";
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
    await storage.projects.create({ id: "proj-1", name: "p", path: dir });
    await storage.scheduledTasks.create({
      id: "s1", project_id: "proj-1", name: "echo", cron_expr: "0 9 * * *",
      timezone: "UTC", run_type: "command", content: "echo hi",
      cwd_mode: "directory", directory: dir, timeout_seconds: 60,
    });
    pm = makeFakeProcessManager();
    scheduler = new SchedulerService(storage, pm as unknown as ProcessManager);
  });

  afterEach(async () => {
    scheduler.shutdown();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns with skipDb in the task directory and records a completed run with output", async () => {
    const result = await scheduler.runNow("s1");
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
    const run = await storage.scheduledTaskRuns.getById(runId);
    expect(run?.status).toBe("completed");
    expect(run?.exit_code).toBe(0);
    expect(run?.output).toBe("hello world");
    expect(scheduler.isRunning("s1")).toBe(false);
  });

  it("records failed on non-zero exit", async () => {
    const result = await scheduler.runNow("s1") as { runId: string };
    pm.emit("proc-1", { type: "finished", exitCode: 3 });
    const run = await storage.scheduledTaskRuns.getById(result.runId);
    expect(run?.status).toBe("failed");
    expect(run?.exit_code).toBe(3);
  });

  it("skips (and records the skip) when a run is already active, and emits schedule:run-finished", async () => {
    const events: GlobalEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((e) => events.push(e));
    scheduler.setEventBus(eventBus);

    await scheduler.runNow("s1");
    const second = await scheduler.runNow("s1");
    expect(second).toMatchObject({ skipped: true });
    const runs = await storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(runs.some((r) => r.status === "skipped")).toBe(true);

    const skipRunId = (second as { runId: string }).runId;
    expect(events).toContainEqual({
      type: "schedule:run-finished",
      projectId: "proj-1",
      scheduleId: "s1",
      runId: skipRunId,
      status: "skipped",
      exitCode: null,
    });
  });

  it("kills and marks timeout when the run exceeds timeout_seconds", async () => {
    vi.useFakeTimers();
    try {
      const result = await scheduler.runNow("s1") as { runId: string };
      await vi.advanceTimersByTimeAsync(61_000);
      expect(pm.stopped).toContain("proc-1");
      expect((await storage.scheduledTaskRuns.getById(result.runId))?.status).toBe("timeout");
      // A late 'finished' after the kill must not overwrite the timeout status
      pm.emit("proc-1", { type: "finished", exitCode: 137 });
      expect((await storage.scheduledTaskRuns.getById(result.runId))?.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prompt tasks use their configured prompt provider", async () => {
    await storage.scheduledTasks.create({
      id: "s2", project_id: "proj-1", name: "ai", cron_expr: "0 9 * * *",
      timezone: "UTC", run_type: "prompt", prompt_provider: "codex", content: "analyze the logs",
      cwd_mode: "directory", directory: dir,
    });
    await scheduler.runNow("s2");
    const started = pm.started[pm.started.length - 1];
    expect(started.executor.executor_type).toBe("prompt");
    expect(started.executor.prompt_provider).toBe("codex");
    expect(started.executor.command).toBe("analyze the logs");
  });

  it("fails without spawning when the directory does not exist", async () => {
    await storage.scheduledTasks.update("s1", { directory: path.join(dir, "missing") });
    const result = await scheduler.runNow("s1");
    expect(result).toMatchObject({ error: expect.stringContaining("does not exist") });
    expect(pm.started).toHaveLength(0);
    const runs = await storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(runs[0].status).toBe("failed");
  });

  it("caps persisted output at 200_000 characters, keeping the tail", async () => {
    const result = await scheduler.runNow("s1") as { runId: string };
    pm.emit("proc-1", { type: "stdout", data: "A".repeat(150_000) });
    pm.emit("proc-1", { type: "stdout", data: "B".repeat(150_000) });
    pm.emit("proc-1", { type: "finished", exitCode: 0 });

    const run = await storage.scheduledTaskRuns.getById(result.runId);
    expect(run?.output).toHaveLength(200_000);
    // Total emitted was 300_000 chars ("A"*150_000 + "B"*150_000); the tail
    // 200_000 chars drop the first 100_000 "A"s and keep the rest.
    expect(run?.output?.slice(0, 50_000)).toBe("A".repeat(50_000));
    expect(run?.output?.slice(50_000)).toBe("B".repeat(150_000));
  });

  it("prunes run history to the most recent 50 rows per schedule", async () => {
    // Seed 55 old run rows directly (bypassing the scheduler) so we don't
    // have to execute 51 real runs.
    const oldIds: string[] = [];
    for (let i = 0; i < 55; i++) {
      const id = `old-${i}`;
      await storage.scheduledTaskRuns.create({ id, schedule_id: "s1", status: "completed" });
      oldIds.push(id);
    }
    expect(await storage.scheduledTaskRuns.getByScheduleId("s1", 1000)).toHaveLength(55);

    // Trigger one real run so the scheduler's own prune() call fires.
    const result = await scheduler.runNow("s1") as { runId: string };
    pm.emit("proc-1", { type: "finished", exitCode: 0 });
    // finalize() (finish() then prune()) runs fire-and-forget off the
    // subscribe callback, so give its two chained awaits a chance to settle
    // before asserting on prune()'s effect.
    await new Promise((resolve) => setImmediate(resolve));

    const runs = await storage.scheduledTaskRuns.getByScheduleId("s1", 1000);
    expect(runs.length).toBeLessThanOrEqual(50);
    // The oldest rows (inserted first) must be the ones pruned away.
    expect(await storage.scheduledTaskRuns.getById(oldIds[0])).toBeUndefined();
    expect(await storage.scheduledTaskRuns.getById(result.runId)).toBeDefined();
  });

  it("shutdown cancels the in-flight run's timeout timer instead of writing a late 'timeout' status", async () => {
    vi.useFakeTimers();
    try {
      const result = await scheduler.runNow("s1") as { runId: string };
      expect(scheduler.isRunning("s1")).toBe(true);

      scheduler.shutdown();
      // A timer tick past the original timeout must not fire after shutdown:
      // no processManager.stop() call, and the run row must not be
      // (re)written with a 'timeout' status — it stays 'running' for the
      // startup fixup to mark 'killed' on next boot.
      await vi.advanceTimersByTimeAsync(61_000);

      expect(pm.stopped).not.toContain("proc-1");
      const run = await storage.scheduledTaskRuns.getById(result.runId);
      expect(run?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects runNow after shutdown instead of re-registering cleanup state", async () => {
    scheduler.shutdown();
    const result = await scheduler.runNow("s1");
    expect(result).toMatchObject({ error: "Scheduler stopped" });
    expect(pm.started).toHaveLength(0);
  });
});

describe("SchedulerService remote runs", () => {
  let dir: string;
  let storage: Storage;
  let pm: ReturnType<typeof makeFakeProcessManager>;
  let eventBus: EventBus;
  let proxyCalls: { path: string; body: unknown; serverId: string }[];
  let scheduler: SchedulerService;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-sched-remote-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "proj-1", name: "p", path: dir });
    const server = await storage.remoteServers.create({ name: "r", url: "http://remote.test", api_key: "K" });
    await storage.projectRemotes.add({ project_id: "proj-1", remote_server_id: server.id, remote_path: "/srv/app" });
    await storage.scheduledTasks.create({
      id: "s1", project_id: "proj-1", name: "remote scan", cron_expr: "0 9 * * *",
      timezone: "UTC", run_type: "command", content: "echo hi",
      cwd_mode: "branch", branch: "main", target: server.id,
    });

    pm = makeFakeProcessManager();
    eventBus = new EventBus();
    proxyCalls = [];
    const fakeProxy = async (serverId: string, _url: string, _key: string, _method: string, apiPath: string, body?: unknown) => {
      proxyCalls.push({ path: apiPath, body, serverId });
      if (apiPath === "/api/path/execute") return { ok: true, status: 200, data: { processId: "rp-1" } };
      return { ok: true, status: 200, data: {} };
    };
    scheduler = new SchedulerService(storage, pm as unknown as ProcessManager, {
      reverseConnectManager: {} as never,
      remoteExecutorMap: new Map<string, RemoteExecutorInfo>(),
      remoteExecutorMonitor: { watch() {}, unwatch() {} } as never,
      proxy: fakeProxy as never,
    });
    scheduler.setEventBus(eventBus);
  });

  afterEach(async () => {
    scheduler.shutdown();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("proxies /api/path/execute with branch payload and records a running run", async () => {
    const result = await scheduler.runNow("s1");
    expect(result).toMatchObject({ skipped: false });
    const exec = proxyCalls.find((c) => c.path === "/api/path/execute");
    expect(exec).toBeDefined();
    expect(exec!.body).toMatchObject({ path: "/srv/app", branch: "main", command: "echo hi" });
    const runs = await storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(runs[0].status).toBe("running");
    expect(runs[0].process_id).toBe("remote-schedule-s1-rp-1");
    expect(pm.started).toHaveLength(0); // never touches the local ProcessManager
  });

  it("finalizes completed from an executor:stopped event, storing tailOutput", async () => {
    const result = await scheduler.runNow("s1") as { runId: string };
    eventBus.emit({
      type: "executor:stopped", projectId: "proj-1", executorId: "schedule-s1",
      processId: "remote-schedule-s1-rp-1", exitCode: 0, target: "remote", tailOutput: "remote-done",
    } as GlobalEvent);
    const run = await storage.scheduledTaskRuns.getById(result.runId);
    expect(run?.status).toBe("completed");
    expect(run?.output).toBe("remote-done");
  });

  it("directory mode proxies path=<directory>, branch undefined", async () => {
    await storage.scheduledTasks.update("s1", { cwd_mode: "directory", directory: "/var/log" });
    await scheduler.runNow("s1");
    const exec = proxyCalls.find((c) => c.path === "/api/path/execute")!;
    expect(exec.body).toMatchObject({ path: "/var/log" });
    expect((exec.body as { branch?: unknown }).branch).toBeUndefined();
  });

  it("remote prompt runs proxy their configured prompt provider", async () => {
    await storage.scheduledTasks.update("s1", {
      run_type: "prompt",
      prompt_provider: "codex",
      content: "inspect remote state",
    });
    await scheduler.runNow("s1");
    const exec = proxyCalls.find((c) => c.path === "/api/path/execute")!;
    expect(exec.body).toMatchObject({
      executor_type: "prompt",
      prompt_provider: "codex",
      command: "inspect remote state",
    });
  });

  it("records failed without a proxy call when the remote target is unknown", async () => {
    await storage.scheduledTasks.update("s1", { target: "nonexistent-server" });
    const result = await scheduler.runNow("s1");
    expect(result).toMatchObject({ error: expect.stringContaining("Remote server config not found") });
    expect(proxyCalls).toHaveLength(0);
    expect((await storage.scheduledTaskRuns.getByScheduleId("s1"))[0].status).toBe("failed");
  });

  it("overlap guard holds across the async remote start (concurrent triggers → one runs, one skips)", async () => {
    const [r1, r2] = await Promise.all([scheduler.runNow("s1"), scheduler.runNow("s1")]);
    const results = [r1, r2];
    expect(results.filter((r) => "skipped" in r && r.skipped === true)).toHaveLength(1);
    expect(results.filter((r) => "skipped" in r && r.skipped === false)).toHaveLength(1);
    // Only ONE remote process was actually started.
    expect(proxyCalls.filter((c) => c.path === "/api/path/execute")).toHaveLength(1);
  });

  it("on timeout, proxies the remote stop endpoint and records timeout", async () => {
    vi.useFakeTimers();
    try {
      await storage.scheduledTasks.update("s1", { timeout_seconds: 1 });
      const result = await scheduler.runNow("s1") as { runId: string };
      await vi.advanceTimersByTimeAsync(1100);
      expect(proxyCalls.some((c) => c.path === "/api/executor-processes/rp-1/stop")).toBe(true);
      expect((await storage.scheduledTaskRuns.getById(result.runId))?.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});
