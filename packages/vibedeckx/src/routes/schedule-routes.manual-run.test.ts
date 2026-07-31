import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";

const auth = vi.hoisted(() => ({ currentUserId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.currentUserId }),
  clerkClient: {},
}));

import scheduleRoutes from "./schedule-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import type { SchedulerService } from "../scheduler.js";

describe("manual schedule run route", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let dbPath: string;
  const runNow = vi.fn(async (_scheduleId: string, runId?: string) => ({ runId: runId!, skipped: false }));

  const startApp = async () => {
    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    app.decorate("scheduler", { runNow } as unknown as SchedulerService);
    await app.register(scheduleRoutes);
    await app.ready();
  };

  beforeEach(async () => {
    auth.currentUserId = "user-1";
    runNow.mockClear();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-schedule-route-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "project-1", name: "Mine", path: "/tmp/mine" }, "user-1");
    await storage.projects.create({ id: "foreign", name: "Theirs", path: "/tmp/theirs" }, "user-2");
    for (const [id, projectId] of [["schedule-1", "project-1"], ["schedule-2", "project-1"], ["foreign-schedule", "foreign"]]) {
      await storage.scheduledTasks.create({
        id, project_id: projectId, name: id, cron_expr: "0 * * * *", timezone: "UTC",
        run_type: "command", content: "echo ok", cwd_mode: "branch",
      });
    }
    await storage.scheduledTaskRuns.create({ id: "source-1", schedule_id: "schedule-1", status: "failed" });

    await startApp();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses the client identity and rejects a changed immutable payload", async () => {
    const payload = { requestId: "request-1", runId: "run-1", sourceRunId: "source-1" };
    const first = await app.inject({ method: "POST", url: "/api/schedules/schedule-1/run", payload });
    const raw = new Database(dbPath);
    raw.prepare("DELETE FROM scheduled_task_runs WHERE id = ?").run("source-1");
    raw.close();
    const retry = await app.inject({ method: "POST", url: "/api/schedules/schedule-1/run", payload });
    const mismatch = await app.inject({
      method: "POST", url: "/api/schedules/schedule-2/run", payload,
    });

    expect(first.statusCode, first.body).toBe(200);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(first.json()).toEqual({ runId: "run-1" });
    expect(retry.json()).toEqual({ runId: "run-1" });
    expect(runNow).toHaveBeenNthCalledWith(1, "schedule-1", "run-1");
    expect(runNow).toHaveBeenNthCalledWith(2, "schedule-1", "run-1");
    expect(mismatch.statusCode).toBe(409);
    expect(runNow).toHaveBeenCalledTimes(2);
  });

  it("replays a pruned completed result from the compact request outcome without scheduling", async () => {
    const payload = { requestId: "request-complete", runId: "run-complete", sourceRunId: "source-1" };
    await storage.scheduledTaskRuns.claimManualRequest({
      ...payload, projectId: "project-1", scheduleId: "schedule-1",
    });
    await storage.scheduledTaskRuns.create({ id: payload.runId, schedule_id: "schedule-1", status: "completed" });
    for (let index = 0; index < 55; index += 1) {
      await storage.scheduledTaskRuns.create({ id: `later-${index}`, schedule_id: "schedule-1", status: "completed" });
    }
    await storage.scheduledTaskRuns.prune("schedule-1", 50);
    expect(await storage.scheduledTaskRuns.getById(payload.runId)).toBeUndefined();
    await app.close();
    await storage.close();
    storage = await createSqliteStorage(dbPath);
    await startApp();

    const replay = await app.inject({ method: "POST", url: "/api/schedules/schedule-1/run", payload });

    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({
      runId: payload.runId, durable: true, replay: true, status: "completed",
    });
    expect(runNow).not.toHaveBeenCalled();
  });

  it("durably replays a pruned pre-spawn failure with the original HTTP semantics", async () => {
    const payload = { requestId: "request-failure", runId: "run-failure", sourceRunId: "source-1" };
    runNow.mockImplementationOnce(async (_scheduleId, runId) => {
      await storage.scheduledTaskRuns.failBeforeStart({
        id: runId!, scheduleId: "schedule-1", output: "Project has no local path",
      });
      return { error: "Project has no local path" };
    });
    const first = await app.inject({ method: "POST", url: "/api/schedules/schedule-1/run", payload });
    for (let index = 0; index < 55; index += 1) {
      await storage.scheduledTaskRuns.create({ id: `failure-later-${index}`, schedule_id: "schedule-1", status: "completed" });
    }
    await storage.scheduledTaskRuns.prune("schedule-1", 50);
    expect(await storage.scheduledTaskRuns.getById(payload.runId)).toBeUndefined();
    await app.close();
    await storage.close();
    storage = await createSqliteStorage(dbPath);
    await startApp();
    const retry = await app.inject({ method: "POST", url: "/api/schedules/schedule-1/run", payload });

    expect(first.statusCode, first.body).toBe(400);
    expect(first.json()).toMatchObject({ error: "Project has no local path", durable: true, status: "failed" });
    expect(retry.statusCode, retry.body).toBe(400);
    expect(retry.json()).toMatchObject({
      error: "Project has no local path", durable: true, replay: true, status: "failed",
    });
    expect(runNow).toHaveBeenCalledOnce();
  });

  it("replays an asynchronously failed run as the accepted 200 outcome rather than a start error", async () => {
    const payload = { requestId: "request-async-failure", runId: "run-async-failure", sourceRunId: "source-1" };
    await storage.scheduledTaskRuns.claimManualRequest({
      ...payload, projectId: "project-1", scheduleId: "schedule-1",
    });
    await storage.scheduledTaskRuns.create({
      id: payload.runId, schedule_id: "schedule-1", process_id: "process-1",
    });
    await storage.scheduledTaskRuns.finish(payload.runId, {
      status: "failed", exit_code: 2, output: "large failure output",
    });

    const replay = await app.inject({ method: "POST", url: "/api/schedules/schedule-1/run", payload });

    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({
      runId: payload.runId, durable: true, replay: true, status: "failed",
    });
    expect(runNow).not.toHaveBeenCalled();
  });

  it("validates source scope, request shape, and schedule ownership before claiming", async () => {
    const wrongSource = await app.inject({
      method: "POST", url: "/api/schedules/schedule-2/run",
      payload: { requestId: "request-wrong", runId: "run-wrong", sourceRunId: "source-1" },
    });
    expect(wrongSource.statusCode).toBe(409);

    const invalid = await app.inject({
      method: "POST", url: "/api/schedules/schedule-1/run", payload: { requestId: "", runId: "run" },
    });
    expect(invalid.statusCode).toBe(400);

    const reusedResultIdentity = await app.inject({
      method: "POST", url: "/api/schedules/schedule-1/run",
      payload: { requestId: "new-request", runId: "source-1" },
    });
    expect(reusedResultIdentity.statusCode).toBe(409);

    auth.currentUserId = "user-1";
    const foreign = await app.inject({
      method: "POST", url: "/api/schedules/foreign-schedule/run",
      payload: { requestId: "foreign-request", runId: "foreign-run" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(runNow).not.toHaveBeenCalled();
  });
});
