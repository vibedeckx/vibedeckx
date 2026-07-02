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
    storage.projects.create({ id: projectId, name: "p", path: "/tmp/p" });
  });

  afterEach(() => {
    storage.close();
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

  it("creates and reads back a scheduled task with defaults", () => {
    const t = createTask();
    expect(t.enabled).toBe(true);
    expect(t.timeout_seconds).toBe(1800);
    expect(t.branch).toBeNull();
    expect(t.directory).toBeNull();
    expect(t.run_type).toBe("command");
    expect(storage.scheduledTasks.getByProjectId(projectId)).toHaveLength(1);
    expect(storage.scheduledTasks.getAllEnabled().map((x) => x.id)).toContain("s1");
    expect(storage.scheduledTasks.getById("s1")?.name).toBe("daily scan");
  });

  it("update changes fields and getAllEnabled respects enabled=false", () => {
    createTask();
    const updated = storage.scheduledTasks.update("s1", {
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
    expect(storage.scheduledTasks.getAllEnabled()).toHaveLength(0);
  });

  it("delete removes the schedule", () => {
    createTask();
    storage.scheduledTasks.delete("s1");
    expect(storage.scheduledTasks.getById("s1")).toBeUndefined();
  });

  it("runs: create → finish; list omits output, getById includes it", () => {
    createTask();
    const run = storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1", process_id: "p1" });
    expect(run.status).toBe("running");
    expect(run.finished_at).toBeNull();

    storage.scheduledTaskRuns.finish("r1", { status: "completed", exit_code: 0, output: "hello" });

    const listed = storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("completed");
    expect(listed[0].exit_code).toBe(0);
    expect(listed[0].finished_at).not.toBeNull();
    expect(listed[0].output).toBeNull(); // list never ships output

    expect(storage.scheduledTaskRuns.getById("r1")?.output).toBe("hello");
  });

  it("runs created with a non-running status get finished_at immediately (skipped)", () => {
    createTask();
    const run = storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1", status: "skipped" });
    expect(run.status).toBe("skipped");
    expect(run.finished_at).not.toBeNull();
  });

  it("getLastByScheduleIds returns the newest run per schedule", () => {
    createTask("s1");
    createTask("s2");
    storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1" });
    storage.scheduledTaskRuns.create({ id: "r2", schedule_id: "s1" }); // newer (rowid tiebreak)
    const last = storage.scheduledTaskRuns.getLastByScheduleIds(["s1", "s2"]);
    expect(last["s1"]?.id).toBe("r2");
    expect(last["s2"]).toBeUndefined();
  });

  it("prune keeps only the newest N runs", () => {
    createTask();
    for (let i = 0; i < 5; i++) {
      storage.scheduledTaskRuns.create({ id: `r${i}`, schedule_id: "s1" });
    }
    storage.scheduledTaskRuns.prune("s1", 2);
    const remaining = storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(remaining.map((r) => r.id)).toEqual(["r4", "r3"]);
  });

  it("deleting a schedule cascades to its runs", () => {
    createTask();
    storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1" });
    storage.scheduledTasks.delete("s1");
    expect(storage.scheduledTaskRuns.getById("r1")).toBeUndefined();
  });
});
