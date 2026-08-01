import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const auth = vi.hoisted(() => ({ currentUserId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.currentUserId }),
  clerkClient: {},
}));

import { EventBus } from "./event-bus.js";
import {
  ProjectChatManager,
  type ProjectChatModelRunner,
} from "./project-chat-manager.js";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { ProjectChatMessage, Storage } from "./storage/types.js";
import projectChatRoutes from "./routes/project-chat-routes.js";

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Project Chat tracer state");
}

function operationMessages(messages: ProjectChatMessage[]) {
  return messages.flatMap((message) => {
    if (message.type !== "operation") return [];
    try { return [JSON.parse(message.content) as Record<string, unknown>]; }
    catch { return []; }
  });
}

describe("Project Chat coordination tracer", () => {
  let storage: Storage | undefined;
  let directory: string | undefined;
  let manager: ProjectChatManager | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    await manager?.shutdown();
    await storage?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("persists one workspace-selected Agent Session lifecycle without cross-thread or tenant leakage", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "vdx-project-chat-tracer-"));
    const databasePath = path.join(directory, "test.sqlite");
    storage = await createSqliteStorage(databasePath);
    await storage.projects.create({ id: "project-1", name: "Primary", path: "/tmp/primary" }, "user-1");
    await storage.projects.create({ id: "project-foreign", name: "Foreign", path: "/tmp/foreign" }, "user-2");
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: null }, { branch: "feature/login" }],
      sessions: [],
    });
    await storage.searchCache.applyCatalogSnapshot("project-foreign", "local", {
      workspaces: [{ branch: "foreign-branch" }],
      sessions: [],
    });

    await storage.projectChatThreads.create({
      id: "thread-second", project_id: "project-1", user_id: "user-1", title: "Unrelated",
    });
    await storage.projectChatThreads.create({
      id: "thread-foreign", project_id: "project-foreign", user_id: "user-2", title: "Foreign",
    });

    const runnerCalls: string[] = [];
    const runner: ProjectChatModelRunner = {
      async *run(input) {
        runnerCalls.push(input.threadId);
        expect(input.projectId).toBe("project-1");
        expect(input.userId).toBe("user-1");
        expect(input.messages.at(-1)?.content).toBe("Implement the login rate limiter and its tests.");
        if (!input.tools) throw new Error("Project Chat tools were not configured");
        yield {
          type: "tool_use",
          content: JSON.stringify({ toolName: "create_agent_session", input: { instruction: "Implement the login rate limiter and its tests." } }),
        };
        const result = await input.tools.create_agent_session.execute({
          instruction: "Implement the login rate limiter and its tests.",
          permissionMode: "edit",
          agentType: "codex",
        });
        yield { type: "tool_result", content: JSON.stringify({ toolName: "create_agent_session", output: result }) };
        yield { type: "assistant", content: "Choose the workspace where I should implement this change." };
      },
    };

    const eventBus = new EventBus();
    const createdSessions: string[] = [];
    const createAgentSession = vi.fn(async (input: {
      sessionId: string; projectId: string; branch: string | null;
    }) => {
      createdSessions.push(input.sessionId);
      expect(input.projectId).toBe("project-1");
      expect(input.branch).toBe("feature/login");
      await storage!.agentSessions.create({
        id: input.sessionId,
        project_id: input.projectId,
        branch: input.branch ?? "",
        permission_mode: "edit",
        agent_type: "codex",
      });
      return { sessionId: input.sessionId };
    });
    const sendAgentInstruction = vi.fn(async () => true);
    const runScheduleNow = vi.fn(async () => ({ runId: "unused", skipped: false } as const));
    const createToolDependencies = () => ({
      agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => true },
      mutationServices: { createAgentSession, sendAgentInstruction, runScheduleNow },
    });
    manager = new ProjectChatManager(storage, runner, {
      eventBus,
      toolDependencies: createToolDependencies(),
      reconciliationIntervalMs: 60_000,
    });
    await manager.ready();

    // Drive acceptance through the authenticated production route. This
    // covers validation, project ownership, request idempotency, the atomic
    // Thread/work-journal write, and the route-to-manager startup wiring.
    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    app.decorate("projectChatManager", manager);
    await app.register(projectChatRoutes);
    await app.ready();
    auth.currentUserId = "user-2";
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/project-chat/threads",
      payload: { message: "must not run", createRequestId: "foreign-create-attempt" },
    });
    expect(unauthorized.statusCode).toBe(404);
    auth.currentUserId = "user-1";
    const invalid = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/project-chat/threads",
      payload: { message: "   ", createRequestId: "invalid-create-attempt" },
    });
    expect(invalid.statusCode).toBe(400);
    const createRequest = {
      method: "POST" as const,
      url: "/api/projects/project-1/project-chat/threads",
      payload: {
        message: "Implement the login rate limiter and its tests.",
        createRequestId: "tracer-create-primary",
      },
    };
    const created = await app.inject(createRequest);
    const retried = await app.inject(createRequest);
    expect(created.statusCode).toBe(201);
    expect(retried.statusCode).toBe(201);
    const threadPrimary = created.json().thread.id as string;
    expect(retried.json().thread.id).toBe(threadPrimary);

    const selection = await waitFor(async () => {
      const snapshot = await manager!.openThread(threadPrimary, "user-1");
      return operationMessages(snapshot.messages).find(({ kind }) => kind === "workspace_selection");
    });
    expect(selection).toMatchObject({ status: "pending", candidates: expect.arrayContaining([
      { id: JSON.stringify(["local", "feature/login"]), target: "local", branch: "feature/login" },
    ]) });
    const operationId = selection.operationId as string;
    const workspaceId = JSON.stringify(["local", "feature/login"]);

    const chosen = await manager.selectWorkspace(
      threadPrimary, "user-1", operationId, workspaceId,
    );
    expect(chosen).toMatchObject({ status: "running", sessionId: expect.any(String) });
    const sessionId = chosen!.sessionId!;
    expect(createdSessions).toEqual([sessionId]);
    await expect(storage.agentSessions.getById(sessionId)).resolves.toMatchObject({
      id: sessionId, project_id: "project-1", branch: "feature/login", status: "running",
    });
    await expect(storage.projectChatOperations.getById(
      operationId, threadPrimary, "project-1", "user-1",
    )).resolves.toMatchObject({
      status: "running", entity_id: sessionId,
      payload: { workspaceId, initialInstructionDelivery: "confirmed" },
    });

    const foreignOperationId = "foreign-same-session-operation";
    await storage.projectChatOperations.create({
      id: foreignOperationId,
      thread_id: "thread-foreign",
      project_id: "project-foreign",
      user_id: "user-2",
      kind: "agent_session_create",
      status: "running",
      entity_type: "agent_session",
      entity_id: sessionId,
      idempotency_key: "foreign-same-session",
      payload: {
        version: 1,
        kind: "agent_session_create",
        operationId: foreignOperationId,
        status: "running",
        sessionId,
        initialInstructionDelivery: "confirmed",
      },
      error: null,
    });

    // The opaque session id deliberately collides across project scopes.
    // Completing the foreign scope must not transition the primary operation.
    eventBus.emit({
      type: "session:taskCompleted",
      projectId: "project-foreign",
      branch: "foreign-branch",
      sessionId,
      summaryText: "Foreign work completed",
    });
    await waitFor(async () => {
      const operation = await storage!.projectChatOperations.getById(
        foreignOperationId, "thread-foreign", "project-foreign", "user-2",
      );
      return operation?.status === "completed" ? operation : undefined;
    });
    await expect(storage.projectChatOperations.getById(
      operationId, threadPrimary, "project-1", "user-1",
    )).resolves.toMatchObject({ status: "running", entity_id: sessionId });
    expect(operationMessages((await manager.openThread(threadPrimary, "user-1")).messages)
      .some((item) => item.operationId === operationId && item.status === "completed")).toBe(false);
    expect(operationMessages((await manager.openThread("thread-foreign", "user-2")).messages))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ operationId: foreignOperationId, status: "completed", sessionId }),
      ]));

    eventBus.emit({
      type: "session:taskCompleted",
      projectId: "project-1",
      branch: "feature/login",
      sessionId,
      summaryText: "Rate limiter implemented and tested",
    });
    const completed = await waitFor(async () => {
      const operation = await storage!.projectChatOperations.getById(
        operationId, threadPrimary, "project-1", "user-1",
      );
      return operation?.status === "completed" ? operation : undefined;
    });
    expect(completed.payload).toMatchObject({ sessionId, status: "completed" });

    const beforeRestart = await manager.openThread(threadPrimary, "user-1");
    const primaryOperations = operationMessages(beforeRestart.messages);
    expect(primaryOperations.filter((item) => item.operationId === operationId && item.status === "completed"))
      .toHaveLength(1);
    expect(beforeRestart.contextRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_type: "workspace", entity_id: workspaceId, deleted: false }),
      expect.objectContaining({ entity_type: "agent_session", entity_id: sessionId, deleted: false }),
    ]));
    expect(await manager.openThread("thread-second", "user-1")).toMatchObject({
      messages: [], contextRefs: [],
    });
    expect(await manager.openThread("thread-foreign", "user-2")).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ type: "operation" })]),
    });

    await app.close();
    app = undefined;
    await manager.shutdown();
    manager = undefined;
    await storage.close();
    storage = undefined;

    // Reopen the database and reconstruct every dependency so restored state
    // cannot accidentally come from the old manager or SQLite connection.
    storage = await createSqliteStorage(databasePath);
    const restartedBus = new EventBus();
    manager = new ProjectChatManager(storage, runner, {
      eventBus: restartedBus,
      toolDependencies: createToolDependencies(),
      reconciliationIntervalMs: 60_000,
    });
    await manager.ready();
    const restored = await manager.openThread(threadPrimary, "user-1");

    expect(restored.messages.map(({ type, content }) => [type, content])).toEqual(
      beforeRestart.messages.map(({ type, content }) => [type, content]),
    );
    expect(restored.contextRefs).toEqual(beforeRestart.contextRefs);
    expect(restored.status).toBe("idle");
    await expect(storage.projectChatOperations.getById(
      operationId, threadPrimary, "project-1", "user-1",
    )).resolves.toMatchObject({ status: "completed", entity_id: sessionId });
    expect(runnerCalls).toEqual([threadPrimary]);
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(await manager.openThread("thread-second", "user-1")).toMatchObject({ messages: [], contextRefs: [] });
    expect(await manager.openThread("thread-foreign", "user-2")).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ type: "operation" })]),
    });
  });
});
