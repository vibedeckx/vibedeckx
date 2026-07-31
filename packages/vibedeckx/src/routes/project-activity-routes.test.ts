import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const auth = vi.hoisted(() => ({ currentUserId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.currentUserId }),
  clerkClient: {},
}));

import projectActivityRoutes from "./project-activity-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";

describe("project activity route", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;

  async function createSchedule(id: string, projectId = "project-1", overrides: { enabled?: boolean; cron?: string } = {}) {
    return storage.scheduledTasks.create({
      id,
      project_id: projectId,
      name: `Schedule ${id}`,
      cron_expr: overrides.cron ?? "0 * * * *",
      timezone: "UTC",
      run_type: "prompt",
      content: "Check the project",
      cwd_mode: "branch",
      branch: id.includes("other") ? "other" : "main",
      enabled: overrides.enabled ?? true,
    });
  }

  async function createRun(
    id: string,
    scheduleId: string,
    status: "completed" | "failed" | "timeout" | "running",
    report: string | null = null,
  ) {
    await storage.scheduledTaskRuns.create({ id, schedule_id: scheduleId, status });
    if (status !== "running") {
      await storage.scheduledTaskRuns.finish(id, {
        status,
        exit_code: status === "completed" ? 0 : 1,
        output: `raw output for ${id}`,
        report,
      });
    }
  }

  beforeEach(async () => {
    auth.currentUserId = "user-1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T10:15:00.000Z"));
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-activity-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "Mine", path: "/tmp/mine" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Also mine", path: "/tmp/mine-2" }, "user-1");
    await storage.projects.create({ id: "foreign-project", name: "Theirs", path: "/tmp/theirs" }, "user-2");

    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    await app.register(projectActivityRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("returns bounded, globally ordered project activity without foreign or archived rows", async () => {
    await storage.projectChatThreads.create({ id: "thread-a-old", project_id: "project-1", user_id: "user-1", title: "Old" });
    await storage.projectChatThreads.create({ id: "thread-z-new", project_id: "project-1", user_id: "user-1", title: "New" });
    await storage.projectChatThreads.create({ id: "thread-archived", project_id: "project-1", user_id: "user-1", title: "Archived" });
    await storage.projectChatThreads.archive("thread-archived", "project-1", "user-1");
    await storage.projectChatThreads.create({ id: "thread-other-user", project_id: "project-1", user_id: "user-2", title: "Private" });
    await storage.projectChatThreads.create({ id: "thread-other-project", project_id: "project-2", user_id: "user-1", title: "Other" });

    await storage.agentSessions.create({ id: "older", project_id: "project-1", branch: "older" });
    await storage.agentSessions.updateStatus("older", "stopped");
    await storage.agentSessions.create({ id: "newest", project_id: "project-1", branch: "newest" });
    await storage.agentSessions.create({ id: "foreign-session", project_id: "project-2", branch: "foreign" });

    await createSchedule("schedule-old");
    await createSchedule("schedule-new");
    await createSchedule("schedule-other", "project-2");
    await createRun("run-old", "schedule-old", "completed", "Older report");
    await createRun("run-new", "schedule-new", "failed", "Failure summary " + "x".repeat(700));
    await createRun("run-other", "schedule-other", "failed", "Must not leak");

    const priorities = [
      ["task-in-progress", "in_progress", "medium"],
      ["task-urgent-a", "todo", "urgent"],
      ["task-urgent-b", "todo", "urgent"],
      ["task-high-a", "todo", "high"],
      ["task-high-b", "todo", "high"],
      ["task-high-over-limit", "todo", "high"],
      ["task-medium", "todo", "medium"],
    ] as const;
    for (const [id, status, priority] of priorities) {
      await storage.tasks.create({ id, project_id: "project-1", title: id, status, priority });
    }
    await storage.tasks.create({ id: "task-archived", project_id: "project-1", title: "Archived", status: "in_progress", priority: "urgent" });
    await storage.tasks.archive("task-archived");
    await storage.tasks.create({ id: "task-other", project_id: "project-2", title: "Other", status: "in_progress", priority: "urgent" });

    const response = await app.inject({ method: "GET", url: "/api/projects/project-1/activity" });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.recentThreads.map((item: { id: string }) => item.id)).toEqual(["thread-z-new", "thread-a-old"]);
    expect(body.recentAgentSessions.map((item: { id: string }) => item.id)).toEqual(["newest", "older"]);
    expect(body.recentScheduleRuns.map((item: { id: string }) => item.id)).toEqual(["run-new", "run-old"]);
    expect(body.priorityTasks.map((item: { id: string }) => item.id)).toEqual([
      "task-in-progress", "task-urgent-a", "task-urgent-b", "task-high-a", "task-high-b",
    ]);
    expect(JSON.stringify(body)).not.toContain("foreign-session");
    expect(JSON.stringify(body)).not.toContain("run-other");
    expect(JSON.stringify(body)).not.toContain("task-archived");
    expect(JSON.stringify(body)).not.toContain("thread-archived");
    expect(body).not.toHaveProperty("workspaces");
  });

  it("returns schedule report previews without raw output and aggregates attention and summary", async () => {
    await storage.agentSessions.create({ id: "session-running", project_id: "project-1", branch: "feature" });
    await storage.agentSessions.create({ id: "session-error", project_id: "project-1", branch: "broken" });
    await storage.agentSessions.updateStatus("session-error", "error");
    await storage.agentSessions.create({ id: "session-completed", project_id: "project-1", branch: "finished" });
    await storage.agentSessions.markUserMessage("session-completed", 100);
    await storage.agentSessions.markCompleted("session-completed", 200);
    await storage.agentSessions.updateStatus("session-completed", "stopped");
    await createSchedule("schedule-hourly");
    await createSchedule("schedule-disabled", "project-1", { enabled: false, cron: "*/5 * * * *" });
    await createRun("run-running", "schedule-hourly", "running");
    await createRun("run-timeout", "schedule-hourly", "timeout", "T".repeat(700));

    const response = await app.inject({ method: "GET", url: "/api/projects/project-1/activity" });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    const timeoutRun = body.recentScheduleRuns.find((run: { id: string }) => run.id === "run-timeout");
    expect(timeoutRun).toMatchObject({
      scheduleName: "Schedule schedule-hourly",
      branch: "main",
      reportPreview: expect.any(String),
    });
    expect(timeoutRun.reportPreview.length).toBeLessThanOrEqual(501);
    expect(timeoutRun).not.toHaveProperty("output");
    expect(timeoutRun).not.toHaveProperty("report");
    expect(body.attention).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "schedule_run", entityId: "run-timeout", status: "timeout" }),
      expect.objectContaining({ type: "agent_session", entityId: "session-error", status: "error" }),
    ]));
    expect(body.attention).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: "session-completed" }),
    ]));
    expect(body.summary).toMatchObject({ running: 2, failed: 2 });
    expect(body.summary.nextScheduleAt).toBe("2026-07-31T11:00:00.000Z");
  });

  it("uses server-owned limits for each dashboard section", async () => {
    for (let index = 0; index < 12; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await storage.projectChatThreads.create({ id: `thread-${suffix}`, project_id: "project-1", user_id: "user-1", title: suffix });
      await storage.agentSessions.create({ id: `session-${suffix}`, project_id: "project-1", branch: suffix });
    }
    await createSchedule("schedule-many");
    for (let index = 0; index < 9; index += 1) {
      await createRun(`run-${String(index).padStart(2, "0")}`, "schedule-many", "completed", "ok");
    }

    const response = await app.inject({ method: "GET", url: "/api/projects/project-1/activity?limit=9999" });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();

    expect(body.recentThreads).toHaveLength(3);
    expect(body.recentAgentSessions).toHaveLength(8);
    expect(body.recentScheduleRuns).toHaveLength(5);
  });

  it("counts all current statuses and finds failures independently of recent-card limits", async () => {
    for (let index = 0; index < 10; index += 1) {
      await storage.agentSessions.create({
        id: `running-${String(index).padStart(2, "0")}`,
        project_id: "project-1",
        branch: `branch-${index}`,
      });
    }
    await createSchedule("schedule-history");
    await createRun("run-a-old-failure", "schedule-history", "timeout", "Needs attention");
    for (let index = 0; index < 6; index += 1) {
      await createRun(`run-z-new-${index}`, "schedule-history", "completed", "ok");
    }

    const response = await app.inject({ method: "GET", url: "/api/projects/project-1/activity" });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();

    expect(body.recentAgentSessions).toHaveLength(8);
    expect(body.recentScheduleRuns).toHaveLength(5);
    expect(body.recentScheduleRuns).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "run-a-old-failure" }),
    ]));
    expect(body.attention).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: "run-a-old-failure", status: "timeout" }),
    ]));
    expect(body.summary).toMatchObject({ running: 10, failed: 1 });
  });

  it("returns the same 404 for missing and foreign projects", async () => {
    for (const projectId of ["missing", "foreign-project"]) {
      const response = await app.inject({ method: "GET", url: `/api/projects/${projectId}/activity` });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Project not found" });
    }
  });

  it("requires authentication", async () => {
    auth.currentUserId = null;
    const response = await app.inject({ method: "GET", url: "/api/projects/project-1/activity" });
    expect(response.statusCode).toBe(401);
  });
});
