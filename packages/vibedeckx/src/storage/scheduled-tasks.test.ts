import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("scheduledTasks storage", () => {
  let dir: string;
  let storage: Storage;
  const projectId = "proj-1";

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-sched-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: projectId, name: "p", path: "/tmp/p" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const createTask = (id = "s1") =>
    storage.scheduledTasks.create({
      id,
      project_id: projectId,
      name: "daily scan",
      cron_expr: "0 9 * * *",
      timezone: "Asia/Shanghai",
      run_type: "command",
      content: "echo hi",
      cwd_mode: "branch",
    });

  it("creates and reads back a scheduled task with defaults", async () => {
    const t = await createTask();
    expect(t.enabled).toBe(true);
    expect(t.timeout_seconds).toBe(1800);
    expect(t.branch).toBeNull();
    expect(t.directory).toBeNull();
    expect(t.run_type).toBe("command");
    expect(t.prompt_provider).toBeNull();
    expect(await storage.scheduledTasks.getByProjectId(projectId)).toHaveLength(1);
    expect((await storage.scheduledTasks.getAllEnabled()).map((x) => x.id)).toContain("s1");
    expect((await storage.scheduledTasks.getById("s1"))?.name).toBe("daily scan");
  });

  it("round-trips prompt_provider for prompt schedules", async () => {
    const t = await storage.scheduledTasks.create({
      id: "s-prompt",
      project_id: projectId,
      name: "agent task",
      cron_expr: "0 9 * * *",
      timezone: "UTC",
      run_type: "prompt",
      prompt_provider: "codex",
      content: "inspect the repo",
      cwd_mode: "branch",
    });
    expect(t.prompt_provider).toBe("codex");

    const updated = await storage.scheduledTasks.update("s-prompt", { prompt_provider: "claude" });
    expect(updated?.prompt_provider).toBe("claude");
    expect((await storage.scheduledTasks.getById("s-prompt"))?.prompt_provider).toBe("claude");
  });

  it("update changes fields and getAllEnabled respects enabled=false", async () => {
    await createTask();
    const updated = await storage.scheduledTasks.update("s1", {
      enabled: false,
      name: "n2",
      cwd_mode: "directory",
      directory: "/tmp",
      timeout_seconds: 60,
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe("n2");
    expect(updated?.cwd_mode).toBe("directory");
    expect(updated?.directory).toBe("/tmp");
    expect(updated?.timeout_seconds).toBe(60);
    expect(await storage.scheduledTasks.getAllEnabled()).toHaveLength(0);
  });

  it("delete removes the schedule", async () => {
    await createTask();
    await storage.scheduledTasks.delete("s1");
    expect(await storage.scheduledTasks.getById("s1")).toBeUndefined();
  });

  it("runs: create → finish; list omits output, getById includes it", async () => {
    await createTask();
    const run = await storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1", process_id: "p1" });
    expect(run.status).toBe("running");
    expect(run.finished_at).toBeNull();

    await storage.scheduledTaskRuns.finish("r1", { status: "completed", exit_code: 0, output: "hello" });

    const listed = await storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("completed");
    expect(listed[0].exit_code).toBe(0);
    expect(listed[0].finished_at).not.toBeNull();
    expect(listed[0].output).toBeNull(); // list never ships output

    expect((await storage.scheduledTaskRuns.getById("r1"))?.output).toBe("hello");
  });

  it("runs created with a non-running status get finished_at immediately (skipped)", async () => {
    await createTask();
    const run = await storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1", status: "skipped" });
    expect(run.status).toBe("skipped");
    expect(run.finished_at).not.toBeNull();
  });

  it("getLastByScheduleIds returns the newest run per schedule", async () => {
    await createTask("s1");
    await createTask("s2");
    await storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1" });
    await storage.scheduledTaskRuns.create({ id: "r2", schedule_id: "s1" }); // newer (rowid tiebreak)
    const last = await storage.scheduledTaskRuns.getLastByScheduleIds(["s1", "s2"]);
    expect(last["s1"]?.id).toBe("r2");
    expect(last["s2"]).toBeUndefined();
  });

  it("prune keeps only the newest N runs", async () => {
    await createTask();
    // Non-running statuses: prune now never deletes 'running' rows (see next
    // test), so these need a terminal status to exercise the keep-newest-N path.
    for (let i = 0; i < 5; i++) {
      await storage.scheduledTaskRuns.create({ id: `r${i}`, schedule_id: "s1", status: "completed" });
    }
    await storage.scheduledTaskRuns.prune("s1", 2);
    const remaining = await storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(remaining.map((r) => r.id)).toEqual(["r4", "r3"]);
  });

  it("prune never deletes a 'running' row, even when it falls outside the keep-newest-N window", async () => {
    await createTask();
    // The running row is created first, so it is the OLDEST row overall
    // (rowid tiebreak) — simulating a long-running run that predates a burst
    // of newer 'skipped' rows from the scheduler's overlap-skip path.
    await storage.scheduledTaskRuns.create({ id: "running-1", schedule_id: "s1", status: "running" });
    for (let i = 0; i < 55; i++) {
      await storage.scheduledTaskRuns.create({ id: `r${i}`, schedule_id: "s1", status: "completed" });
    }

    await storage.scheduledTaskRuns.prune("s1", 50);

    // The keep-newest-N subquery has no status filter, so by recency alone the
    // running row (oldest) and the 5 oldest completed rows (r0..r4) fall
    // outside the top-50 window. The DELETE's `status != 'running'` guard
    // means only the 5 oldest completed rows actually get removed — the
    // running row survives regardless of its position in the recency window.
    const remaining = await storage.scheduledTaskRuns.getByScheduleId("s1", 100);
    expect(remaining).toHaveLength(51);
    const remainingIds = new Set(remaining.map((r) => r.id));
    expect(remainingIds.has("running-1")).toBe(true);
    for (let i = 0; i < 5; i++) expect(remainingIds.has(`r${i}`)).toBe(false);
    for (let i = 5; i < 55; i++) expect(remainingIds.has(`r${i}`)).toBe(true);
  });

  it("deleting a schedule cascades to its runs", async () => {
    await createTask();
    await storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1" });
    await storage.scheduledTasks.delete("s1");
    expect(await storage.scheduledTaskRuns.getById("r1")).toBeUndefined();
  });

  it("defaults target to 'local' and round-trips a remote target", async () => {
    const t = await createTask();
    expect(t.target).toBe("local");

    const remote = await storage.scheduledTasks.create({
      id: "s-remote",
      project_id: projectId,
      name: "remote scan",
      cron_expr: "0 9 * * *",
      timezone: "UTC",
      run_type: "command",
      content: "echo hi",
      cwd_mode: "branch",
      target: "remote-server-1",
    });
    expect(remote.target).toBe("remote-server-1");
    expect((await storage.scheduledTasks.getById("s-remote"))?.target).toBe("remote-server-1");
  });

  it("update can change target", async () => {
    await createTask();
    const updated = await storage.scheduledTasks.update("s1", { target: "remote-server-2" });
    expect(updated?.target).toBe("remote-server-2");
    expect((await storage.scheduledTasks.getById("s1"))?.target).toBe("remote-server-2");
  });
});
