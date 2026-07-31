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
  const createAgentSession = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ sessionId }));
  const sendAgentInstruction = vi.fn(async () => true);
  const runScheduleNow = vi.fn(async () => ({ runId: "run-1", skipped: false } as const));

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
    createAgentSession.mockClear();
    sendAgentInstruction.mockClear();
    runScheduleNow.mockClear();
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
      mutationServices: { createAgentSession, sendAgentInstruction, runScheduleNow },
    });
  }

  async function linkedRemoteServer(): Promise<string> {
    const server = await storage.remoteServers.create({ name: `worker-${randomSuffix()}` }, "user-1");
    await storage.projectRemotes.add({
      project_id: "project-1", remote_server_id: server.id, remote_path: "/repo",
    });
    return server.id;
  }

  function randomSuffix(): string {
    return Math.random().toString(36).slice(2);
  }

  it("authorizes the bound project, user, and thread before exposing tools", async () => {
    await expect(tools({ projectId: "project-2" })).rejects.toThrow("Project Chat thread not found");
    await expect(tools({ userId: "user-2" })).rejects.toThrow("Project not found");
  });

  it("exposes only the five V1 mutations and workspace resolution alongside read tools", async () => {
    const surface = await tools();
    expect(Object.keys(surface).sort()).toEqual([
      "create_agent_session", "create_task", "get_agent_session", "get_project_summary", "get_schedule_run", "get_task",
      "list_agent_sessions", "list_schedule_runs", "list_schedules", "list_tasks", "list_workspaces",
      "run_schedule_now", "select_workspace", "send_agent_instruction", "update_task",
    ]);
    expect(Object.keys(surface).join(" ")).not.toMatch(/delete|stop|git|worktree|schedule_(create|update)|modify_schedule/i);
    for (const entry of Object.values(surface)) {
      expect(entry).toEqual(expect.objectContaining({ description: expect.any(String), execute: expect.any(Function) }));
    }
  });

  it("strictly validates bounded mutation inputs without accepting projectId", async () => {
    const surface = await tools();
    const mutationNames = [
      "create_task", "update_task", "create_agent_session", "send_agent_instruction",
      "run_schedule_now", "select_workspace",
    ] as const;
    for (const name of mutationNames) {
      expect(() => surface[name].inputSchema.parse({ projectId: "project-2" })).toThrow();
    }
    expect(surface.create_task.inputSchema.parse({ title: "Ship it" })).toEqual({ title: "Ship it" });
    expect(() => surface.create_task.inputSchema.parse({ title: "x".repeat(513) })).toThrow();
    expect(() => surface.send_agent_instruction.inputSchema.parse({
      sessionId: "s1", instruction: "x".repeat(8_001),
    })).toThrow();
    expect(() => surface.update_task.inputSchema.parse({ taskId: "t1" })).toThrow();
  });

  it("rejects foreign mutation targets before service, operation, or context side effects", async () => {
    await storage.tasks.create({ id: "foreign-task", project_id: "project-2", title: "Foreign" });
    await storage.agentSessions.create({ id: "foreign-session", project_id: "project-2", branch: "secret" });
    await storage.scheduledTasks.create({
      id: "foreign-schedule", project_id: "project-2", name: "Foreign", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project", target: "local",
    });
    const createOperation = vi.spyOn(storage.projectChatOperations, "create");
    const touch = vi.spyOn(storage.projectChatContextRefs, "touchMany");
    const surface = await tools();

    await expect(surface.update_task.execute({ taskId: "foreign-task", title: "No" }))
      .rejects.toThrow("Object is not part of this project");
    await expect(surface.send_agent_instruction.execute({ sessionId: "foreign-session", instruction: "No" }))
      .rejects.toThrow("Object is not part of this project");
    await expect(surface.run_schedule_now.execute({ scheduleId: "foreign-schedule" }))
      .rejects.toThrow("Object is not part of this project");
    await expect(surface.create_agent_session.execute({
      workspaceId: JSON.stringify(["local", "secret"]), instruction: "No",
    })).rejects.toThrow("Workspace is no longer available");

    expect(createOperation).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(sendAgentInstruction).not.toHaveBeenCalled();
    expect(runScheduleNow).not.toHaveBeenCalled();
  });

  it("creates and updates tasks with context and public operation audit records", async () => {
    const surface = await tools();
    const created = await surface.create_task.execute({ title: "New task", priority: "urgent" });
    expect(created).toMatchObject({ ok: true, status: "completed", taskId: expect.any(String) });
    const taskId = created.taskId as string;
    await expect(surface.update_task.execute({ taskId, status: "in_progress" }))
      .resolves.toMatchObject({ ok: true, status: "completed", taskId });
    await expect(storage.tasks.getById(taskId)).resolves.toMatchObject({
      project_id: "project-1", title: "New task", priority: "urgent", status: "in_progress",
    });
    expect(await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1"))
      .toContainEqual(expect.objectContaining({ entity_type: "task", entity_id: taskId }));
    const messages = await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
    expect(messages.filter(({ type }) => type === "operation")).toHaveLength(2);
    for (const message of messages.filter(({ type }) => type === "operation")) {
      expect(JSON.parse(message.content)).toMatchObject({ version: 1, status: "completed" });
    }
  });

  it("revalidates assigned task branches against current authorized workspaces and allows null clears", async () => {
    const serverId = await linkedRemoteServer();
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }], sessions: [],
    });
    await storage.searchCache.applyCatalogSnapshot("project-1", serverId, {
      workspaces: [{ branch: "dev" }], sessions: [],
    });
    const surface = await tools();
    const valid = await surface.create_task.execute({ title: "Assigned", assignedBranch: "dev" });
    expect(valid).toMatchObject({ ok: true });
    const taskId = valid.taskId as string;
    expect((await storage.tasks.getById(taskId))?.assigned_branch).toBe("dev");

    await storage.searchCache.applyCatalogSnapshot("project-1", "local", { workspaces: [], sessions: [] }, 2);
    await storage.searchCache.applyCatalogSnapshot("project-1", serverId, { workspaces: [], sessions: [] }, 2);
    const createOperation = vi.spyOn(storage.projectChatOperations, "create");
    await expect(surface.create_task.execute({ title: "Stale", assignedBranch: "dev" }))
      .rejects.toThrow(/workspace|branch/i);
    expect(createOperation).not.toHaveBeenCalled();
    await expect(surface.update_task.execute({ taskId, assignedBranch: "dev" }))
      .rejects.toThrow(/workspace|branch/i);
    expect(createOperation).not.toHaveBeenCalled();
    await expect(surface.update_task.execute({ taskId, assignedBranch: null }))
      .resolves.toMatchObject({ ok: true });
    expect((await storage.tasks.getById(taskId))?.assigned_branch).toBeNull();
  });

  it("requires explicit workspace selection even with one candidate and persists the request", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }], sessions: [],
    });
    const result = await (await tools()).create_agent_session.execute({ instruction: "Implement it" });

    expect(result).toMatchObject({
      ok: false, status: "workspace_selection_required", requestId: expect.any(String),
      candidates: [{ id: JSON.stringify(["local", "dev"]), target: "local", branch: "dev" }],
    });
    expect(createAgentSession).not.toHaveBeenCalled();
    const messages = await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
    expect(messages.filter(({ type }) => type === "operation")).toEqual([
      expect.objectContaining({ content: expect.stringContaining("workspace_selection") }),
    ]);
  });

  it("resumes persisted workspace selection after a factory restart exactly once", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: null }, { branch: "dev" }], sessions: [],
    });
    const requested = await (await tools()).create_agent_session.execute({ instruction: "Implement it" });
    const requestId = requested.requestId as string;

    const restartedSurface = await tools();
    const first = await restartedSurface.select_workspace.execute({
      requestId, workspaceId: JSON.stringify(["local", "dev"]),
    });
    const replay = await (await tools()).select_workspace.execute({
      requestId, workspaceId: JSON.stringify(["local", "dev"]),
    });

    expect(first).toMatchObject({ ok: true, status: "running", sessionId: expect.any(String) });
    expect(replay).toEqual(first);
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: first.sessionId, idempotencyKey: expect.any(String), branch: "dev",
    }));
    expect((await storage.projectChatOperations.listByCorrelation(
      "project-1", "agent_session", first.sessionId as string, 10,
    )).map(({ id }) => id)).toEqual([requestId]);
  });

  it("allows one side effect for simultaneous same-workspace selection and rejects a conflicting loser", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }, { branch: "other" }], sessions: [],
    });
    createAgentSession.mockImplementationOnce(async ({ sessionId }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { sessionId };
    });
    const requested = await (await tools()).create_agent_session.execute({ instruction: "Implement it" });
    const requestId = requested.requestId as string;
    const firstSurface = await tools();
    const secondSurface = await tools();
    const same = await Promise.all([
      firstSurface.select_workspace.execute({ requestId, workspaceId: JSON.stringify(["local", "dev"]) }),
      secondSurface.select_workspace.execute({ requestId, workspaceId: JSON.stringify(["local", "dev"]) }),
    ]);
    expect(same[0]).toEqual(same[1]);
    expect(createAgentSession).toHaveBeenCalledTimes(1);

    const another = await (await tools()).create_agent_session.execute({ instruction: "Again" });
    const results = await Promise.allSettled([
      (await tools()).select_workspace.execute({ requestId: another.requestId as string, workspaceId: JSON.stringify(["local", "dev"]) }),
      (await tools()).select_workspace.execute({ requestId: another.requestId as string, workspaceId: JSON.stringify(["local", "other"]) }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(String((results.find(({ status }) => status === "rejected") as PromiseRejectedResult).reason))
      .toMatch(/already resolved/);
    expect(createAgentSession).toHaveBeenCalledTimes(2);
  });

  it("returns an explicit retryable response while workspace selection is still resolving", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }], sessions: [],
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    createAgentSession.mockImplementationOnce(async ({ sessionId }) => {
      await blocked;
      return { sessionId };
    });
    const requested = await (await tools()).create_agent_session.execute({ instruction: "Implement it" });
    const input = {
      requestId: requested.requestId as string, workspaceId: JSON.stringify(["local", "dev"]),
    };
    const first = (await tools()).select_workspace.execute(input);
    await vi.waitFor(() => expect(createAgentSession).toHaveBeenCalledTimes(1));

    const retry = await (await tools()).select_workspace.execute(input);
    expect(retry).toMatchObject({
      ok: false, status: "resolving", retryable: true,
      error: "Workspace selection resolution is still in progress",
    });
    release();
    await expect(first).resolves.toMatchObject({ ok: true, status: "running" });
  });

  it("rejects stale and foreign workspace selections before creating a session", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }], sessions: [],
    }, 1);
    const requested = await (await tools()).create_agent_session.execute({ instruction: "Implement it" });
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", { workspaces: [], sessions: [] }, 2);

    await expect((await tools()).select_workspace.execute({
      requestId: requested.requestId as string, workspaceId: JSON.stringify(["local", "dev"]),
    })).rejects.toThrow("Workspace is no longer available");
    await storage.projectChatThreads.create({
      id: "thread-2", project_id: "project-2", user_id: "user-1", title: null,
    });
    await expect((await tools({ projectId: "project-2", threadId: "thread-2" })).select_workspace.execute({
      requestId: requested.requestId as string, workspaceId: JSON.stringify(["local", "dev"]),
    })).rejects.toThrow("Workspace selection request not found");
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("does not treat a preallocated session as proof that initial instruction delivery succeeded", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }], sessions: [],
    });
    createAgentSession.mockImplementationOnce(async ({ sessionId }) => {
      await storage.agentSessions.create({ id: sessionId, project_id: "project-1", branch: "dev" });
      throw new Error("crash after spawn");
    });
    const requested = await (await tools()).create_agent_session.execute({ instruction: "Implement it" });

    const resolved = await (await tools()).select_workspace.execute({
      requestId: requested.requestId as string, workspaceId: JSON.stringify(["local", "dev"]),
    });
    expect(resolved).toMatchObject({ ok: false, status: "pending", sessionId: expect.any(String) });
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(await storage.agentSessions.getById(resolved.sessionId as string))
      .toMatchObject({ project_id: "project-1", branch: "dev" });
  });

  it("keeps direct explicit creation pending when spawn succeeded but delivery confirmation failed", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }], sessions: [],
    });
    createAgentSession.mockImplementationOnce(async ({ sessionId }) => {
      await storage.agentSessions.create({ id: sessionId, project_id: "project-1", branch: "dev" });
      throw new Error("crash after spawn");
    });

    const result = await (await tools()).create_agent_session.execute({
      workspaceId: JSON.stringify(["local", "dev"]), instruction: "Implement it",
    });
    expect(result).toMatchObject({ ok: false, status: "pending", sessionId: expect.any(String) });
    expect(createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("preallocates canonical remote handles without decoding synthetic ids", async () => {
    const serverId = await linkedRemoteServer();
    await storage.searchCache.applyCatalogSnapshot("project-1", serverId, {
      workspaces: [{ branch: "dev" }], sessions: [],
    });

    const result = await (await tools()).create_agent_session.execute({
      workspaceId: JSON.stringify([serverId, "dev"]), instruction: "Implement remotely",
    });

    expect(result).toMatchObject({ ok: true, status: "running", sessionId: expect.stringMatching(/^remote-/) });
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: result.sessionId,
      workerSessionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      target: serverId, branch: "dev",
    }));
    expect(createAgentSession.mock.calls.at(-1)?.[0].workerSessionId).not.toBe(result.sessionId);
  });

  it("uses explicit session and schedule identities and returns bounded structured failures", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }], sessions: [],
    });
    await storage.agentSessions.create({ id: "local-session", project_id: "project-1", branch: "dev" });
    await storage.scheduledTasks.create({
      id: "schedule-1", project_id: "project-1", name: "Run", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project", target: "local",
    });
    const surface = await tools();
    await expect(surface.create_agent_session.execute({
      workspaceId: JSON.stringify(["local", "dev"]), instruction: "Implement it", model: "bounded-model",
    })).resolves.toMatchObject({ ok: true, sessionId: expect.any(String) });
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: expect.any(String), idempotencyKey: expect.any(String), target: "local", branch: "dev",
      instruction: "Implement it", model: "bounded-model",
    }));
    await expect(surface.send_agent_instruction.execute({ sessionId: "local-session", instruction: "Continue" }))
      .resolves.toMatchObject({ ok: true, sessionId: "local-session" });

    runScheduleNow.mockImplementationOnce(async () => ({ error: `failed-${"x".repeat(2_000)}` }));
    const failed = await surface.run_schedule_now.execute({ scheduleId: "schedule-1" });
    expect(failed).toMatchObject({ ok: false, status: "failed", error: expect.any(String) });
    expect((failed.error as string).length).toBeLessThanOrEqual(513);
    expect(JSON.stringify(failed)).not.toContain("x".repeat(600));
  });

  it("keeps a started schedule run pending when atomic context confirmation fails", async () => {
    await storage.scheduledTasks.create({
      id: "schedule-context", project_id: "project-1", name: "Run", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
    });
    runScheduleNow.mockImplementationOnce(async (scheduleId: string, runId: string) => {
      await storage.scheduledTaskRuns.create({ id: runId, schedule_id: scheduleId, status: "running" });
      return { runId, skipped: false } as const;
    });
    vi.spyOn(storage.projectChatContextRefs, "touchMany").mockResolvedValue(undefined);

    const result = await (await tools()).run_schedule_now.execute({ scheduleId: "schedule-context" });

    expect(result).toMatchObject({ ok: false, status: "pending", runId: expect.any(String) });
    expect(await storage.projectChatOperations.getById(
      result.operationId as string, "thread-1", "project-1", "user-1",
    )).toMatchObject({ status: "pending", payload: { contextConfirmed: false } });
  });

  it.each(["foreign", "wrong-schedule", "missing", "valid"] as const)(
    "validates a %s persisted schedule run before adding context",
    async (scenario) => {
      await storage.scheduledTasks.create({
        id: "schedule-validate", project_id: "project-1", name: "Run", cron_expr: "0 * * * *",
        timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
      });
      await storage.scheduledTasks.create({
        id: "other-schedule", project_id: scenario === "foreign" ? "project-2" : "project-1",
        name: "Other", cron_expr: "0 * * * *", timezone: "UTC", run_type: "command",
        content: "true", cwd_mode: "project",
      });
      runScheduleNow.mockImplementationOnce(async (_scheduleId: string, runId: string) => {
        if (scenario !== "missing") {
          await storage.scheduledTaskRuns.create({
            id: runId, schedule_id: scenario === "valid" ? "schedule-validate" : "other-schedule", status: "running",
          });
        }
        return { runId, skipped: false } as const;
      });

      const result = await (await tools()).run_schedule_now.execute({ scheduleId: "schedule-validate" });
      const refs = await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1");

      if (scenario === "valid") {
        expect(result).toMatchObject({ ok: true, status: "running" });
        expect(refs.map(({ entity_type }) => entity_type).sort()).toEqual(["schedule", "schedule_run"]);
      } else {
        expect(result).toMatchObject({ ok: false });
        expect(refs).toEqual([]);
      }
    },
  );

  it("revalidates a session target immediately before sending the instruction", async () => {
    const local = await storage.agentSessions.create({
      id: "local-session", project_id: "project-1", branch: "dev",
    });
    const lookup = vi.spyOn(storage.agentSessions, "getById")
      .mockResolvedValueOnce(local)
      .mockResolvedValueOnce({ ...local, project_id: "project-2" });

    const result = await (await tools()).send_agent_instruction.execute({
      sessionId: "local-session", instruction: "Continue",
    });

    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(sendAgentInstruction).not.toHaveBeenCalled();
  });

  it("keeps an unconfirmed instruction durable and marks only confirmed sends completed", async () => {
    await storage.agentSessions.create({ id: "local-session", project_id: "project-1", branch: "dev" });
    sendAgentInstruction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const first = await (await tools()).send_agent_instruction.execute({
      sessionId: "local-session", instruction: "Continue safely",
    });
    expect(first).toMatchObject({ ok: false, status: "pending" });
    const pending = (await storage.projectChatOperations.listByCorrelation(
      "project-1", "agent_session", "local-session", 10,
    )).find(({ kind }) => kind === "agent_instruction");
    expect(pending).toMatchObject({ status: "running", payload: { delivery: "pending", instruction: "Continue safely" } });
    expect(sendAgentInstruction).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: pending?.idempotency_key,
    }));

    const second = await (await tools()).send_agent_instruction.execute({
      sessionId: "local-session", instruction: "A distinct command",
    });
    expect(second).toMatchObject({ ok: true, status: "completed" });
    const confirmed = await storage.projectChatOperations.getById(
      second.operationId as string, "thread-1", "project-1", "user-1",
    );
    expect(confirmed).toMatchObject({ status: "completed", payload: { delivery: "confirmed" } });
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
    const touch = vi.spyOn(storage.projectChatContextRefs, "touchMany");
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
      { id: JSON.stringify(["local", null]), target: "local", branch: null },
      { id: JSON.stringify(["local", "dev"]), target: "local", branch: "dev" },
    ]);
    expect(JSON.stringify(result)).not.toContain("foreign");
    expect((await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1"))
      .filter((ref) => ref.entity_type === "workspace")).toHaveLength(2);
  });

  it("reports workspace truncation only when another authorized workspace exists", async () => {
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: Array.from({ length: 20 }, (_, index) => ({ branch: `branch-${index}` })),
      sessions: [],
    });
    const surface = await tools();
    await expect(surface.list_workspaces.execute({})).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ branch: "branch-19" })]),
      truncated: false,
    });

    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: Array.from({ length: 21 }, (_, index) => ({ branch: `branch-${index}` })),
      sessions: [],
    }, 2);
    const bounded = await surface.list_workspaces.execute({});
    expect(bounded.items).toHaveLength(20);
    expect(bounded.truncated).toBe(true);
  });

  it("filters a retained remote workspace cache entry after project access is revoked", async () => {
    const serverId = await linkedRemoteServer();
    await storage.searchCache.applyCatalogSnapshot("project-1", serverId, {
      workspaces: [{ branch: "revoked" }], sessions: [],
    });
    const link = await storage.projectRemotes.getByProjectAndServer("project-1", serverId);
    expect(link).toBeDefined();
    await storage.projectRemotes.remove(link!.id);
    const createOperation = vi.spyOn(storage.projectChatOperations, "create");
    const touch = vi.spyOn(storage.projectChatContextRefs, "touchMany");
    const surface = await tools();

    await expect(surface.list_workspaces.execute({})).resolves.toEqual({ items: [], truncated: false });
    await expect(surface.create_task.execute({ title: "No", assignedBranch: "revoked" }))
      .rejects.toThrow("Assigned branch is not an available workspace");

    expect(createOperation).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
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
    const touch = vi.spyOn(storage.projectChatContextRefs, "touchMany");
    const surface = await tools();

    await expect(surface.get_agent_session.execute({ sessionId: "foreign-local" })).rejects.toThrow("Object is not part of this project");
    await expect(surface.get_agent_session.execute({ sessionId: "foreign-remote" })).rejects.toThrow("Object is not part of this project");
    await expect(surface.get_agent_session.execute({ sessionId: "missing-session" })).rejects.toThrow("Agent session not found");
    expect(remote.getDetail).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it("retrieves remote session detail through the injected mapping reader without parsing its opaque ID", async () => {
    const huge = "r".repeat(20_000);
    const mapping = { id: "opaque-remote", projectId: "project-1", remoteServerId: "server-a", remoteSessionId: "worker-id", branch: "dev" };
    vi.mocked(remote.getMapping).mockResolvedValue(mapping);
    vi.mocked(remote.getDetail).mockResolvedValue({
      id: mapping.id, projectId: "project-1", branch: huge, title: huge, status: huge, target: huge,
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
    const serverId = await linkedRemoteServer();
    await storage.remoteSessionMappings.upsert("opaque-local-id", "project-1", serverId, "worker/session", "dev");
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
      expect.objectContaining({ id: "opaque-local-id", projectId: "project-1", target: serverId }),
    ]);
    const mapping = await reader.getMapping("opaque-local-id");
    const detail = await reader.getDetail(mapping!, { maxEntries: 20, maxChars: 6_000 });
    expect(proxy).toHaveBeenCalledWith(serverId, "GET", "/api/agent-sessions/worker%2Fsession");
    expect(detail).toEqual(expect.objectContaining({ id: "opaque-local-id", projectId: "project-1", transcript: expect.any(Array) }));
  });

  it("revokes retained remote mappings when the project association is removed", async () => {
    const server = await storage.remoteServers.create({ name: "worker" }, "user-1");
    const association = await storage.projectRemotes.add({
      project_id: "project-1", remote_server_id: server.id, remote_path: "/repo",
    });
    await storage.remoteSessionMappings.upsert("retained-id", "project-1", server.id, "worker-id", "dev");
    const proxy = vi.fn(async () => ({
      ok: true, status: 200, data: { session: { status: "running" }, messages: [] },
    }));
    const reader = createRemoteProjectSessionReader({ storage, proxy });
    await storage.projectRemotes.remove(association.id);
    const surface = await createProjectChatTools({
      projectId: "project-1", threadId: "thread-1", userId: "user-1", storage,
      agentSessionManager: { getMessages: localMessages, getSessionProcessAlive: localAlive },
      remoteSessions: reader,
    });

    await expect(reader.listByProject("project-1", 10)).resolves.toEqual([]);
    await expect(surface.list_agent_sessions.execute({})).resolves.toEqual({ items: [], truncated: false });
    await expect(surface.get_agent_session.execute({ sessionId: "retained-id" }))
      .rejects.toThrow("Agent session not found");
    expect(proxy).not.toHaveBeenCalled();
    expect(await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1")).toEqual([]);
  });

  it("rejects malformed remote payload records without invoking hostile session getters", async () => {
    const serverId = await linkedRemoteServer();
    const mapping = {
      id: "opaque-local-id", projectId: "project-1", remoteServerId: serverId,
      remoteSessionId: "worker/session", branch: "dev",
    };
    let payload: unknown = null;
    const proxy = vi.fn(async () => ({ ok: true, status: 200, data: payload }));
    const reader = createRemoteProjectSessionReader({ storage, proxy });

    for (const malformed of [null, 42, "remote secret", true, [], {}]) {
      payload = malformed;
      await expect(reader.getDetail(mapping, { maxEntries: 20, maxChars: 6_000 })).resolves.toBeUndefined();
    }

    payload = Object.defineProperty({}, "session", {
      get() { throw new Error("session getter secret"); },
    });
    await expect(reader.getDetail(mapping, { maxEntries: 20, maxChars: 6_000 })).resolves.toBeUndefined();
  });

  it("safely projects hostile remote session fields and transcript containers", async () => {
    const serverId = await linkedRemoteServer();
    const mapping = {
      id: "opaque-local-id", projectId: "project-1", remoteServerId: serverId,
      remoteSessionId: "worker/session", branch: "dev",
    };
    const session: Record<string, unknown> = {};
    for (const key of ["branch", "title", "status", "processAlive", "agentType", "agent_type", "model"]) {
      Object.defineProperty(session, key, {
        get() { throw new Error(`${key} getter secret`); },
      });
    }
    let messages: unknown = "not an array";
    const data = { session } as { session: Record<string, unknown>; messages?: unknown };
    Object.defineProperty(data, "messages", { configurable: true, get: () => messages });
    const proxy = vi.fn(async () => ({ ok: true, status: 200, data }));
    const reader = createRemoteProjectSessionReader({ storage, proxy });

    const revoked = Proxy.revocable([], {});
    const hostileContainers: unknown[] = [
      "not an array",
      { 0: { type: "assistant", content: "object secret" }, length: 1 },
      revoked.proxy,
      new Proxy([], { get(_target, key) { if (key === "length") throw new Error("length secret"); return undefined; } }),
      new Proxy([], { get(_target, key) { return key === "length" ? 1n : undefined; } }),
      new Proxy([], { get(_target, key) { return key === "length" ? "1" : undefined; } }),
    ];
    revoked.revoke();

    for (const container of hostileContainers) {
      messages = container;
      const detail = await reader.getDetail(mapping, { maxEntries: 20, maxChars: 6_000 });
      expect(detail).toEqual(expect.objectContaining({
        branch: "dev", title: null, status: "unknown", processAlive: false, transcript: [],
      }));
      expect(JSON.stringify(detail)).not.toContain("secret");
    }

    Object.defineProperty(data, "messages", {
      configurable: true,
      get() { throw new Error("messages getter secret"); },
    });
    await expect(reader.getDetail(mapping, { maxEntries: 20, maxChars: 6_000 }))
      .resolves.toEqual(expect.objectContaining({ transcript: [] }));
  });

  it("defensively projects malformed injected remote details and hostile transcript getters", async () => {
    const mapping = {
      id: "opaque-local-id", projectId: "project-1", remoteServerId: "server-a",
      remoteSessionId: "worker/session", branch: "dev",
    };
    vi.mocked(remote.getMapping).mockResolvedValue(mapping);
    const hostile = {
      id: mapping.id,
      projectId: mapping.projectId,
      branch: "dev",
      title: "Remote",
      status: "running",
      target: "server-a",
      processAlive: { credential: "PROCESS SECRET" },
    };
    Object.defineProperty(hostile, "transcript", {
      get() { throw new Error("transcript getter secret"); },
    });
    vi.mocked(remote.getDetail).mockResolvedValue(hostile as never);

    const surface = await tools();
    const detail = await surface.get_agent_session.execute({ sessionId: mapping.id });
    expect(detail.processAlive).toBe(false);
    expect(detail.transcript).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain("SECRET");

    hostile.processAlive = "running" as never;
    await expect(surface.get_agent_session.execute({ sessionId: mapping.id }))
      .resolves.toEqual(expect.objectContaining({ processAlive: false, transcript: [] }));

    for (const malformed of [null, 7, "remote secret", [], {}]) {
      vi.mocked(remote.getDetail).mockResolvedValue(malformed as never);
      await expect(surface.get_agent_session.execute({ sessionId: mapping.id }))
        .rejects.toThrow("Agent session not found");
    }
  });

  it("skips malformed and hostile remote list results without tracking synthetic ids", async () => {
    const hostileRow = Object.defineProperty({}, "projectId", {
      get() { throw new Error("project getter secret"); },
    });
    vi.mocked(remote.listByProject).mockResolvedValue([
      null,
      7,
      { projectId: "project-1" },
      hostileRow,
    ] as never);
    const surface = await tools();

    await expect(surface.list_agent_sessions.execute({})).resolves.toEqual({ items: [], truncated: false });
    expect(await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1")).toEqual([]);
  });

  it("skips remote summaries that violate required and optional field contracts", async () => {
    const base = {
      projectId: "project-1", branch: null, title: null, status: "running", target: "server-a",
    };
    const throwingOptional = { ...base, id: "throwing-agent" };
    Object.defineProperty(throwingOptional, "agentType", {
      get() { throw new Error("OPTIONAL GETTER SECRET"); },
    });
    vi.mocked(remote.listByProject).mockResolvedValue([
      { ...base, id: "missing-status", status: undefined },
      { ...base, id: "numeric-status", status: 7 },
      { ...base, id: "missing-target", target: undefined },
      { ...base, id: "object-target", target: { credential: "TARGET SECRET" } },
      { ...base, id: "invalid-branch", branch: 3 },
      { ...base, id: "invalid-title", title: { credential: "TITLE SECRET" } },
      { ...base, id: "invalid-agent", agentType: { credential: "AGENT SECRET" } },
      { ...base, id: "invalid-model", model: 9 },
      { ...base, id: "x".repeat(70_000) },
      throwingOptional,
    ] as never);

    const result = await (await tools()).list_agent_sessions.execute({});

    expect(result).toEqual({ items: [], truncated: true });
    expect(await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1")).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("uses injective round-trippable workspace selectors", async () => {
    const firstRemote = await linkedRemoteServer();
    const secondRemote = await linkedRemoteServer();
    const pairs = [
      { target: "local", branch: null },
      { target: "local", branch: "main" },
      { target: firstRemote, branch: "c" },
      { target: secondRemote, branch: "b:c" },
    ];
    for (const target of new Set(pairs.map((pair) => pair.target))) {
      await storage.searchCache.applyCatalogSnapshot("project-1", target, {
        workspaces: pairs.filter((pair) => pair.target === target).map((pair) => ({ branch: pair.branch })),
        sessions: [],
      });
    }

    const result = await (await tools()).list_workspaces.execute({});
    const refs = await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1");
    const expected = pairs.map((pair) => JSON.stringify([pair.target, pair.branch])).sort();

    expect(result.items.map((item) => item.id).sort()).toEqual(expected);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(4);
    expect(refs.filter((ref) => ref.entity_type === "workspace").map((ref) => ref.entity_id).sort())
      .toEqual(expected);
  });

  it("emits only selectors that round-trip through detail schemas", async () => {
    const selectable = "i".repeat(300);
    const overlong = "o".repeat(513);
    await storage.tasks.create({ id: selectable, project_id: "project-1", title: "selectable" });
    await storage.tasks.create({ id: overlong, project_id: "project-1", title: "skip" });
    await storage.agentSessions.create({ id: selectable, project_id: "project-1", branch: "dev" });
    await storage.agentSessions.create({ id: overlong, project_id: "project-1", branch: "dev" });
    await storage.scheduledTasks.create({
      id: selectable, project_id: "project-1", name: "schedule", cron_expr: "0 0 * * *", timezone: "UTC",
      run_type: "command", content: "true", cwd_mode: "branch",
    });
    await storage.scheduledTasks.create({
      id: overlong, project_id: "project-1", name: "skip", cron_expr: "0 0 * * *", timezone: "UTC",
      run_type: "command", content: "true", cwd_mode: "branch",
    });
    await storage.scheduledTaskRuns.create({ id: selectable, schedule_id: selectable, status: "completed" });
    await storage.scheduledTaskRuns.create({ id: overlong, schedule_id: overlong, status: "completed" });
    await storage.searchCache.applyCatalogSnapshot("project-1", overlong, {
      workspaces: [{ branch: null }], sessions: [],
    });
    const surface = await tools();

    const tasks = await surface.list_tasks.execute({});
    const sessions = await surface.list_agent_sessions.execute({});
    const schedules = await surface.list_schedules.execute({});
    const runs = await surface.list_schedule_runs.execute({});
    const workspaces = await surface.list_workspaces.execute({});

    expect(tasks.items.map((item) => item.id)).toEqual([selectable]);
    expect(sessions.items.map((item) => item.id)).toEqual([selectable]);
    expect(schedules.items.map((item) => item.id)).toEqual([selectable]);
    expect(runs.items.map((item) => item.id)).toEqual([selectable]);
    expect(workspaces.items).toEqual([]);
    expect(surface.get_task.inputSchema.parse({ taskId: selectable })).toEqual({ taskId: selectable });
    expect(surface.get_agent_session.inputSchema.parse({ sessionId: selectable })).toEqual({ sessionId: selectable });
    expect(surface.get_schedule_run.inputSchema.parse({ runId: selectable })).toEqual({ runId: selectable });
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
    const touch = vi.spyOn(storage.projectChatContextRefs, "touchMany");
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
    vi.spyOn(storage.projectChatContextRefs, "touchMany").mockResolvedValue(undefined);

    await expect((await tools()).get_task.execute({ taskId: "task-1" })).rejects.toThrow("Failed to track Project Chat context");
  });

  it("tracks list context in one atomic batch and leaves no phantom refs on failure", async () => {
    await storage.tasks.create({ id: "batch-task-1", project_id: "project-1", title: "One" });
    await storage.tasks.create({ id: "batch-task-2", project_id: "project-1", title: "Two" });
    const touchMany = vi.spyOn(storage.projectChatContextRefs, "touchMany")
      .mockRejectedValue(new Error("batch rejected"));

    await expect((await tools()).list_tasks.execute({})).rejects.toThrow("batch rejected");
    expect(touchMany).toHaveBeenCalledTimes(1);
    expect(touchMany.mock.calls[0]?.[3]).toEqual(expect.arrayContaining([
      { entityType: "task", entityId: "batch-task-1" },
      { entityType: "task", entityId: "batch-task-2" },
    ]));
    expect(await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1")).toEqual([]);
  });

  it("caps every project, task, workspace, and session string field with field-appropriate budgets", async () => {
    const huge = "x".repeat(20_000);
    await storage.projects.update("project-1", { agent_mode: huge as never }, "user-1");
    await storage.tasks.create({
      id: "task-id", project_id: "project-1", title: huge, description: huge,
      status: huge as never, priority: huge as never, assigned_branch: huge,
    });
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "branch" }], sessions: [],
    });
    await storage.agentSessions.create({
      id: "session-id", project_id: "project-1", branch: huge,
      agent_type: huge, model: huge,
    });
    await storage.agentSessions.updateTitle("session-id", huge);
    await storage.agentSessions.updateStatus("session-id", huge as never);
    localMessages.mockReturnValue([]);
    vi.mocked(remote.listByProject).mockResolvedValue([{
      id: "remote-id", projectId: "project-1", branch: huge, title: huge,
      status: huge, target: huge, agentType: huge, model: huge,
    }]);
    const surface = await tools();

    const summary = await surface.get_project_summary.execute({});
    const task = (await surface.list_tasks.execute({})).items[0] as Record<string, string>;
    const taskDetail = await surface.get_task.execute({ taskId: "task-id" }) as Record<string, string>;
    const workspace = (await surface.list_workspaces.execute({})).items[0];
    const sessions = (await surface.list_agent_sessions.execute({})).items;
    const localDetail = await surface.get_agent_session.execute({ sessionId: "session-id" });

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
    expect(workspace.id.length).toBeLessThanOrEqual(512);
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

  it("keeps a maximum task list below the per-turn tool result budget", async () => {
    const huge = "z".repeat(10_000);
    for (let index = 0; index < 50; index++) {
      await storage.tasks.create({
        id: `task-${String(index).padStart(3, "0")}`,
        project_id: "project-1",
        title: huge,
        description: huge,
        assigned_branch: huge,
      });
    }

    const result = await (await tools()).list_tasks.execute({});
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  it("caps every schedule and run string while preserving nulls, booleans, and numbers", async () => {
    const huge = "s".repeat(20_000);
    await storage.scheduledTasks.create({
      id: "schedule-id", project_id: "project-1", name: huge, cron_expr: huge, timezone: huge,
      run_type: huge as never, prompt_provider: null, content: huge, cwd_mode: "branch",
      branch: huge, timeout_seconds: 10, enabled: true, target: huge,
    });
    await storage.scheduledTaskRuns.create({ id: "run-id", schedule_id: "schedule-id", status: huge as never });
    await storage.scheduledTaskRuns.finish("run-id", {
      status: huge as never, exit_code: 7, output: huge, report: huge,
    });
    const surface = await tools();

    const schedule = (await surface.list_schedules.execute({})).items[0] as Record<string, unknown>;
    const run = (await surface.list_schedule_runs.execute({})).items[0] as Record<string, unknown>;
    const detail = await surface.get_schedule_run.execute({ runId: "run-id" });

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
