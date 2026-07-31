import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectChatTools,
  createRemoteProjectSessionReader,
  type RemoteProjectSessionReader,
} from "./project-chat-tools.js";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";

describe("createProjectChatTools", () => {
  let dir: string;
  let storage: Storage;
  let remote: RemoteProjectSessionReader;
  const localMessages = vi.fn<(sessionId: string) => unknown[]>();
  const localAlive = vi.fn<(sessionId: string) => boolean>();

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-chat-tools-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "One", path: "/secret/project-one" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Two", path: "/secret/project-two" }, "user-1");
    await storage.projectChatThreads.create({
      id: "thread-1", project_id: "project-1", user_id: "user-1", title: "Commander",
    });
    remote = {
      listByProject: vi.fn(async () => []),
      getMapping: vi.fn(async () => undefined),
      getDetail: vi.fn(async () => undefined),
    };
    localMessages.mockReset();
    localAlive.mockReset();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function tools(overrides: { projectId?: string; threadId?: string; userId?: string } = {}) {
    return createProjectChatTools({
      projectId: overrides.projectId ?? "project-1",
      threadId: overrides.threadId ?? "thread-1",
      userId: overrides.userId ?? "user-1",
      storage,
      agentSessionManager: { getMessages: localMessages, getSessionProcessAlive: localAlive },
      remoteSessions: remote,
    });
  }

  it("authorizes the bound project, user, and thread before exposing tools", async () => {
    await expect(tools({ projectId: "project-2" })).rejects.toThrow("Project Chat thread not found");
    await expect(tools({ userId: "user-2" })).rejects.toThrow("Project not found");
  });

  it("exposes only bounded read-only Project Commander tools", async () => {
    const surface = await tools();
    expect(Object.keys(surface).sort()).toEqual([
      "get_agent_session", "get_project_summary", "get_schedule_run", "get_task",
      "list_agent_sessions", "list_schedule_runs", "list_schedules", "list_tasks", "list_workspaces",
    ]);
    expect(Object.keys(surface).join(" ")).not.toMatch(/create|update|delete|send|stop|trigger|run_now|git|worktree/i);
    for (const entry of Object.values(surface)) {
      expect(entry).toEqual(expect.objectContaining({ description: expect.any(String), execute: expect.any(Function) }));
    }
  });

  it("returns a sanitized project summary and project-scoped bounded task results", async () => {
    await storage.tasks.create({ id: "task-1", project_id: "project-1", title: "Fix auth", description: `safe-${"d".repeat(20_000)}` });
    await storage.tasks.create({ id: "task-2", project_id: "project-2", title: "Foreign", description: "no" });
    const surface = await tools();

    await expect(surface.get_project_summary.execute({})).resolves.toEqual({
      id: "project-1", name: "One", executionTarget: "local",
    });
    const result = await surface.list_tasks.execute({ query: "AUTH" });
    expect(result.items).toEqual([expect.objectContaining({ id: "task-1", title: "Fix auth" })]);
    expect(JSON.stringify(result).length).toBeLessThan(5_000);
    expect(JSON.stringify(result)).not.toContain("Foreign");
    expect(JSON.stringify(await surface.get_project_summary.execute({}))).not.toContain("/secret/");
    await expect(storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1"))
      .resolves.toEqual([expect.objectContaining({ entity_type: "task", entity_id: "task-1" })]);
  });

  it("rejects missing and foreign task IDs before touching context", async () => {
    await storage.tasks.create({ id: "foreign-task", project_id: "project-2", title: "Foreign" });
    const touch = vi.spyOn(storage.projectChatContextRefs, "touch");
    const surface = await tools();

    await expect(surface.get_task.execute({ taskId: "foreign-task" })).rejects.toThrow("Object is not part of this project");
    await expect(surface.get_task.execute({ taskId: "missing-task" })).rejects.toThrow("Task not found");
    expect(touch).not.toHaveBeenCalled();
  });

  it("lists cached local and remote workspaces within the project and tracks returned branches", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", { workspaces: [{ branch: null }, { branch: "dev" }], sessions: [] });
    await storage.searchCache.applyCatalogSnapshot("project-2", "local", { workspaces: [{ branch: "foreign" }], sessions: [] });
    const result = await (await tools()).list_workspaces.execute({});

    expect(result.items).toEqual([
      { id: "local:main", target: "local", branch: null },
      { id: "local:dev", target: "local", branch: "dev" },
    ]);
    expect(JSON.stringify(result)).not.toContain("foreign");
    expect((await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1"))
      .filter((ref) => ref.entity_type === "workspace")).toHaveLength(2);
  });

  it("lists local and mapped remote sessions and bounds detailed transcript previews", async () => {
    await storage.agentSessions.create({ id: "local-session", project_id: "project-1", branch: "dev" });
    await storage.agentSessions.create({ id: "foreign-session", project_id: "project-2", branch: "secret" });
    vi.mocked(remote.listByProject).mockResolvedValue([
      { id: "opaque-remote", projectId: "project-1", branch: "remote-dev", title: "Remote", status: "stopped", target: "server-a" },
      { id: "foreign-remote", projectId: "project-2", branch: "secret", title: "Foreign", status: "stopped", target: "server-a" },
    ]);
    localMessages.mockReturnValue([
      { type: "user", content: "old" },
      { type: "assistant", content: `recent-${"x".repeat(20_000)}` },
    ]);
    localAlive.mockReturnValue(false);
    const surface = await tools();

    const listed = await surface.list_agent_sessions.execute({});
    expect(listed.items.map((item) => item.id)).toEqual(["local-session", "opaque-remote"]);
    expect(JSON.stringify(listed)).not.toContain("foreign-session");
    expect(JSON.stringify(listed)).not.toContain("foreign-remote");
    const detail = await surface.get_agent_session.execute({ sessionId: "local-session" });
    expect(detail.transcript).toHaveLength(2);
    expect(JSON.stringify(detail).length).toBeLessThan(10_000);
    expect(detail).not.toHaveProperty("permission_mode");
  });

  it("authorizes local and remote session IDs before reads and context tracking", async () => {
    await storage.agentSessions.create({ id: "foreign-local", project_id: "project-2", branch: "secret" });
    vi.mocked(remote.getMapping).mockImplementation(async (id) => id === "foreign-remote"
      ? { id, projectId: "project-2", remoteServerId: "server-a", remoteSessionId: "worker-id", branch: null }
      : undefined);
    const touch = vi.spyOn(storage.projectChatContextRefs, "touch");
    const surface = await tools();

    await expect(surface.get_agent_session.execute({ sessionId: "foreign-local" })).rejects.toThrow("Object is not part of this project");
    await expect(surface.get_agent_session.execute({ sessionId: "foreign-remote" })).rejects.toThrow("Object is not part of this project");
    await expect(surface.get_agent_session.execute({ sessionId: "missing-session" })).rejects.toThrow("Agent session not found");
    expect(remote.getDetail).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it("retrieves remote session detail through the injected mapping reader without parsing its opaque ID", async () => {
    const huge = "r".repeat(20_000);
    const mapping = { id: huge, projectId: "project-1", remoteServerId: "server-a", remoteSessionId: "worker-id", branch: "dev" };
    vi.mocked(remote.getMapping).mockResolvedValue(mapping);
    vi.mocked(remote.getDetail).mockResolvedValue({
      id: huge, projectId: "project-1", branch: huge, title: huge, status: huge, target: huge,
      agentType: huge, model: huge,
      transcript: [{ type: "assistant", content: `remote-${"y".repeat(20_000)}` }],
      credential: "SECRET-REMOTE-CREDENTIAL",
    } as never);

    const detail = await (await tools()).get_agent_session.execute({ sessionId: mapping.id });

    expect(remote.getDetail).toHaveBeenCalledWith(mapping, expect.objectContaining({ maxEntries: expect.any(Number), maxChars: expect.any(Number) }));
    expect(JSON.stringify(detail).length).toBeLessThan(12_000);
    expect(JSON.stringify(detail)).not.toContain("SECRET-REMOTE-CREDENTIAL");
    for (const value of [detail.id, detail.projectId, detail.branch!, detail.title!, detail.target]) {
      expect(value.length).toBeLessThanOrEqual(513);
    }
    expect(detail.status.length).toBeLessThanOrEqual(65);
    expect(detail.agentType!.length).toBeLessThanOrEqual(65);
    expect(detail.model!.length).toBeLessThanOrEqual(257);
    expect(await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1"))
      .toContainEqual(expect.objectContaining({ entity_type: "agent_session", entity_id: mapping.id }));
  });

  it("builds the production remote reader from persisted mappings and the shared proxy abstraction", async () => {
    await storage.remoteSessionMappings.upsert("opaque-local-id", "project-1", "server-a", "worker/session", "dev");
    await storage.remoteSessionMappings.upsert("foreign-local-id", "project-2", "server-b", "other", null);
    const proxy = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: {
        session: { id: "worker/session", branch: "dev", title: "Remote", status: "running", processAlive: true },
        messages: [{ type: "assistant", content: "done" }],
      },
    }));
    const reader = createRemoteProjectSessionReader({ storage, proxy });

    await expect(reader.listByProject("project-1", 10)).resolves.toEqual([
      expect.objectContaining({ id: "opaque-local-id", projectId: "project-1", target: "server-a" }),
    ]);
    const mapping = await reader.getMapping("opaque-local-id");
    const detail = await reader.getDetail(mapping!, { maxEntries: 20, maxChars: 6_000 });
    expect(proxy).toHaveBeenCalledWith("server-a", "GET", "/api/agent-sessions/worker%2Fsession");
    expect(detail).toEqual(expect.objectContaining({ id: "opaque-local-id", projectId: "project-1", transcript: expect.any(Array) }));
  });

  it("lists schedules and recent runs without content/output, tracking each returned entity once", async () => {
    await storage.scheduledTasks.create({
      id: "schedule-1", project_id: "project-1", name: "Nightly", cron_expr: "0 0 * * *", timezone: "UTC",
      run_type: "command", content: "echo SECRET", cwd_mode: "branch",
    });
    await storage.scheduledTasks.create({
      id: "foreign-schedule", project_id: "project-2", name: "Foreign", cron_expr: "0 0 * * *", timezone: "UTC",
      run_type: "command", content: "no", cwd_mode: "branch",
    });
    await storage.scheduledTaskRuns.create({ id: "run-1", schedule_id: "schedule-1", status: "completed" });
    await storage.scheduledTaskRuns.finish("run-1", { status: "completed", output: "SECRET OUTPUT", report: "SECRET REPORT" });
    const surface = await tools();

    const schedules = await surface.list_schedules.execute({});
    const runs = await surface.list_schedule_runs.execute({});
    expect(schedules.items).toEqual([expect.objectContaining({ id: "schedule-1", name: "Nightly" })]);
    expect(JSON.stringify(schedules)).not.toContain("echo SECRET");
    expect(runs.items).toEqual([expect.objectContaining({ id: "run-1", scheduleId: "schedule-1" })]);
    expect(JSON.stringify(runs)).not.toContain("SECRET");
    await surface.list_schedule_runs.execute({});
    const refs = await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1");
    expect(refs.filter((ref) => ref.entity_type === "schedule" && ref.entity_id === "schedule-1")).toHaveLength(1);
    expect(refs.filter((ref) => ref.entity_type === "schedule_run" && ref.entity_id === "run-1")).toHaveLength(1);
  });

  it("authorizes schedule run ownership before returning bounded report and output previews", async () => {
    for (const [scheduleId, projectId] of [["schedule-1", "project-1"], ["foreign-schedule", "project-2"]] as const) {
      await storage.scheduledTasks.create({
        id: scheduleId, project_id: projectId, name: scheduleId, cron_expr: "0 0 * * *", timezone: "UTC",
        run_type: "command", content: "private command", cwd_mode: "branch",
      });
    }
    await storage.scheduledTaskRuns.create({ id: "run-1", schedule_id: "schedule-1", status: "completed" });
    await storage.scheduledTaskRuns.finish("run-1", {
      status: "completed", output: `output-${"o".repeat(30_000)}`, report: `report-${"r".repeat(30_000)}`,
    });
    await storage.scheduledTaskRuns.create({ id: "foreign-run", schedule_id: "foreign-schedule", status: "completed" });
    const touch = vi.spyOn(storage.projectChatContextRefs, "touch");
    const surface = await tools();

    const detail = await surface.get_schedule_run.execute({ runId: "run-1" });
    expect(detail.outputPreview.length).toBeLessThanOrEqual(4_001);
    expect(detail.reportPreview.length).toBeLessThanOrEqual(4_001);
    touch.mockClear();
    await expect(surface.get_schedule_run.execute({ runId: "foreign-run" })).rejects.toThrow("Object is not part of this project");
    await expect(surface.get_schedule_run.execute({ runId: "missing-run" })).rejects.toThrow("Schedule run not found");
    expect(touch).not.toHaveBeenCalled();
  });

  it("surfaces context tracking failure instead of claiming the read was tracked", async () => {
    await storage.tasks.create({ id: "task-1", project_id: "project-1", title: "Task" });
    vi.spyOn(storage.projectChatContextRefs, "touch").mockResolvedValue(undefined);

    await expect((await tools()).get_task.execute({ taskId: "task-1" })).rejects.toThrow("Failed to track Project Chat context");
  });

  it("caps every project, task, workspace, and session string field with field-appropriate budgets", async () => {
    const huge = "x".repeat(20_000);
    await storage.projects.update("project-1", { agent_mode: huge as never }, "user-1");
    await storage.tasks.create({
      id: huge, project_id: "project-1", title: huge, description: huge,
      status: huge as never, priority: huge as never, assigned_branch: huge,
    });
    await storage.searchCache.applyCatalogSnapshot("project-1", huge, {
      workspaces: [{ branch: huge }], sessions: [],
    });
    await storage.agentSessions.create({
      id: `session-${huge}`, project_id: "project-1", branch: huge,
      agent_type: huge, model: huge,
    });
    await storage.agentSessions.updateTitle(`session-${huge}`, huge);
    await storage.agentSessions.updateStatus(`session-${huge}`, huge as never);
    localMessages.mockReturnValue([]);
    vi.mocked(remote.listByProject).mockResolvedValue([{
      id: `remote-${huge}`, projectId: "project-1", branch: huge, title: huge,
      status: huge, target: huge, agentType: huge, model: huge,
    }]);
    const surface = await tools();

    const summary = await surface.get_project_summary.execute({});
    const task = (await surface.list_tasks.execute({})).items[0] as Record<string, string>;
    const taskDetail = await surface.get_task.execute({ taskId: huge }) as Record<string, string>;
    const workspace = (await surface.list_workspaces.execute({})).items[0];
    const sessions = (await surface.list_agent_sessions.execute({})).items;
    const localDetail = await surface.get_agent_session.execute({ sessionId: `session-${huge}` });

    expect(summary.name.length).toBeLessThanOrEqual(513);
    expect(summary.executionTarget.length).toBeLessThanOrEqual(65);
    expect(task.id.length).toBeLessThanOrEqual(513);
    expect(task.title.length).toBeLessThanOrEqual(513);
    expect(task.description.length).toBeLessThanOrEqual(2_001);
    expect(task.status.length).toBeLessThanOrEqual(65);
    expect(task.priority.length).toBeLessThanOrEqual(65);
    expect(task.assignedBranch.length).toBeLessThanOrEqual(513);
    for (const field of ["id", "title", "description", "status", "priority", "assignedBranch"] as const) {
      expect(taskDetail[field].length).toBeLessThanOrEqual(field === "description" ? 2_001 : 513);
    }
    expect(workspace.id.length).toBeLessThanOrEqual(1_025);
    expect(workspace.target.length).toBeLessThanOrEqual(513);
    expect(workspace.branch!.length).toBeLessThanOrEqual(513);
    for (const session of sessions) {
      expect(session.id.length).toBeLessThanOrEqual(513);
      expect(session.branch!.length).toBeLessThanOrEqual(513);
      expect(session.title!.length).toBeLessThanOrEqual(513);
      expect(session.status.length).toBeLessThanOrEqual(65);
      expect(session.target.length).toBeLessThanOrEqual(513);
      expect(session.agentType!.length).toBeLessThanOrEqual(65);
      expect(session.model!.length).toBeLessThanOrEqual(257);
    }
    expect(localDetail.id.length).toBeLessThanOrEqual(513);
    expect(localDetail.projectId.length).toBeLessThanOrEqual(513);
    expect(localDetail.branch!.length).toBeLessThanOrEqual(513);
    expect(localDetail.title!.length).toBeLessThanOrEqual(513);
    expect(localDetail.status.length).toBeLessThanOrEqual(65);
    expect(localDetail.target.length).toBeLessThanOrEqual(513);
    expect(localDetail.agentType!.length).toBeLessThanOrEqual(65);
    expect(localDetail.model!.length).toBeLessThanOrEqual(257);
  });

  it("caps every schedule and run string while preserving nulls, booleans, and numbers", async () => {
    const huge = "s".repeat(20_000);
    await storage.scheduledTasks.create({
      id: huge, project_id: "project-1", name: huge, cron_expr: huge, timezone: huge,
      run_type: huge as never, prompt_provider: null, content: huge, cwd_mode: "branch",
      branch: huge, timeout_seconds: 10, enabled: true, target: huge,
    });
    await storage.scheduledTaskRuns.create({ id: `run-${huge}`, schedule_id: huge, status: huge as never });
    await storage.scheduledTaskRuns.finish(`run-${huge}`, {
      status: huge as never, exit_code: 7, output: huge, report: huge,
    });
    const surface = await tools();

    const schedule = (await surface.list_schedules.execute({})).items[0] as Record<string, unknown>;
    const run = (await surface.list_schedule_runs.execute({})).items[0] as Record<string, unknown>;
    const detail = await surface.get_schedule_run.execute({ runId: `run-${huge}` });

    expect((schedule.id as string).length).toBeLessThanOrEqual(513);
    expect((schedule.name as string).length).toBeLessThanOrEqual(513);
    expect((schedule.cron as string).length).toBeLessThanOrEqual(513);
    expect((schedule.timezone as string).length).toBeLessThanOrEqual(129);
    expect((schedule.runType as string).length).toBeLessThanOrEqual(65);
    expect((schedule.target as string).length).toBeLessThanOrEqual(513);
    expect((schedule.branch as string).length).toBeLessThanOrEqual(513);
    expect(schedule.enabled).toBe(true);
    expect((run.id as string).length).toBeLessThanOrEqual(513);
    expect((run.scheduleId as string).length).toBeLessThanOrEqual(513);
    expect((run.status as string).length).toBeLessThanOrEqual(65);
    expect((run.startedAt as string).length).toBeLessThanOrEqual(129);
    expect(run.finishedAt === null || (run.finishedAt as string).length <= 129).toBe(true);
    expect(run.exitCode).toBe(7);
    expect((detail.id as string).length).toBeLessThanOrEqual(513);
    expect((detail.scheduleId as string).length).toBeLessThanOrEqual(513);
    expect((detail.status as string).length).toBeLessThanOrEqual(65);
    expect(detail.outputPreview.length).toBeLessThanOrEqual(4_001);
    expect(detail.reportPreview.length).toBeLessThanOrEqual(4_001);
  });

  it("renders cyclic, deeply nested, getter-throwing transcript content with structural budgets", async () => {
    await storage.agentSessions.create({ id: "hostile-session", project_id: "project-1", branch: "dev" });
    const hostile: Record<string, unknown> = {
      ["k".repeat(20_000)]: "v".repeat(20_000),
      deep: { one: { two: { three: { four: { five: "too deep" } } } } },
      array: Array.from({ length: 5_000 }, (_, index) => ({ index, value: "a".repeat(2_000) })),
      bigint: 1n,
    };
    hostile.self = hostile;
    Object.defineProperty(hostile, "throws", {
      enumerable: true,
      get() { throw new Error("getter secret"); },
    });
    localMessages.mockReturnValue([{
      type: "t".repeat(20_000),
      content: hostile,
    }, {
      type: "proxy",
      content: new Proxy([], {
        get() { throw new Error("proxy trap secret"); },
      }),
    }]);

    const detail = await (await tools()).get_agent_session.execute({ sessionId: "hostile-session" });
    const serialized = JSON.stringify(detail);

    expect(detail.transcript).toHaveLength(2);
    expect((detail.transcript[0] as { type: string }).type.length).toBeLessThanOrEqual(65);
    expect((detail.transcript[0] as { content: string }).content.length).toBeLessThanOrEqual(6_001);
    expect(serialized.length).toBeLessThan(8_000);
    expect(serialized).not.toContain("getter secret");
    expect(serialized).not.toContain("proxy trap secret");
  });
});
