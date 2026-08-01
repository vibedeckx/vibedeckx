import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { EventBus } from "./event-bus.js";
import {
  adaptProjectChatFullStream,
  PROJECT_CHAT_SYSTEM_PROMPT,
  ProjectChatManager,
  ProjectChatWorkspaceSelectionConflictError,
  projectChatAiTools,
  type ProjectChatModelRunner,
  type ProjectChatRunInput,
  type ProjectChatStreamEvent,
} from "./project-chat-manager.js";
import { projectChatPublicOperationContent } from "./project-chat-tools.js";

async function* streamParts(parts: unknown[]): AsyncGenerator<unknown> {
  for (const part of parts) yield part;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

const reply = (content: string): ProjectChatModelRunner => ({
  async *run() {
    yield { type: "assistant", content };
  },
});

describe("ProjectChatManager", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;

  async function createThread(id: string, userId = "user-1", projectId = "project-1") {
    return storage.projectChatThreads.create({
      id, project_id: projectId, user_id: userId, title: `${id} title`,
    });
  }

  async function stopCurrent(
    manager: ProjectChatManager,
    threadId: string,
    userId = "user-1",
  ): Promise<boolean> {
    const { activeTurnId } = await manager.openThread(threadId, userId);
    if (!activeTurnId) throw new Error(`No active turn for ${threadId}`);
    return manager.stopGeneration(threadId, userId, activeTurnId);
  }

  async function correlate(
    threadId: string, operationId: string,
    kind: "agent_session_create" | "schedule_run",
    entityType: "agent_session" | "schedule_run", entityId: string,
    details: Record<string, unknown> = {},
  ) {
    return storage.projectChatOperations.create({
      id: operationId, thread_id: threadId, project_id: "project-1", user_id: "user-1",
      kind, status: "running", entity_type: entityType, entity_id: entityId,
      idempotency_key: operationId,
      payload: {
        version: 1, kind, operationId, status: "running",
        ...(kind === "agent_session_create" ? { initialInstructionDelivery: "confirmed" } : {}),
        ...(kind === "agent_session_create" ? {
          workspaceId: JSON.stringify(["local", "dev"]), target: "local", branch: "dev",
        } : {}),
        ...(kind === "schedule_run" ? { contextConfirmed: true } : {}),
        ...details,
      } as never,
      error: null,
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-chat-manager-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "project-1", name: "One", path: "/tmp/one" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Two", path: "/tmp/two" }, "user-1");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rehydrates persisted messages in sequence with project-only identity", async () => {
    await createThread("thread-1");
    await storage.projectChatMessages.append({
      id: "m2", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
      sequence: 2, type: "assistant", content: "second",
    });
    await storage.projectChatMessages.append({
      id: "m1", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
      sequence: 1, type: "user", content: "first",
    });
    const manager = new ProjectChatManager(storage, reply("unused"));

    const snapshot = await manager.openThread("thread-1", "user-1");

    expect(snapshot.thread).toMatchObject({ id: "thread-1", title: "thread-1 title" });
    expect(snapshot.messages.map((message) => [message.sequence, message.content]))
      .toEqual([[1, "first"], [2, "second"]]);
    expect(snapshot.identity).toEqual({ projectId: "project-1", threadId: "thread-1", userId: "user-1" });
    expect(snapshot.identity).not.toHaveProperty("branch");
    expect(snapshot.identity).not.toHaveProperty("workspace");
    expect(snapshot).toMatchObject({ status: "idle", queueLength: 0, activeTurnId: null });
  });

  it("replaces an existing live message when durable same-status operation content advances", async () => {
    await createThread("thread-operation-replace");
    const manager = new ProjectChatManager(storage, reply("unused"), { reconciliationIntervalMs: 60_000 });
    await manager.ready();
    const originalPayload = {
      version: 1 as const, kind: "schedule_run" as const, operationId: "operation-1",
      status: "running" as const, scheduleId: "schedule-1", runId: "run-1", contextConfirmed: false,
    };
    await storage.projectChatOperations.create({
      id: "operation-1", thread_id: "thread-operation-replace", project_id: "project-1", user_id: "user-1",
      kind: "schedule_run", status: "running", entity_type: "schedule_run", entity_id: "run-1",
      idempotency_key: "operation-1", payload: originalPayload, error: null,
    });
    const original = await storage.projectChatOperations.announce({
      id: "operation-1", thread_id: "thread-operation-replace", project_id: "project-1", user_id: "user-1",
      message: {
        id: "operation:operation-1:running",
        content: projectChatPublicOperationContent(originalPayload),
      },
    });
    expect(original).not.toBeNull();
    await manager.openThread("thread-operation-replace", "user-1");
    const frames: string[] = [];
    manager.subscribe("thread-operation-replace", {
      projectChatUserId: "user-1", readyState: 1, OPEN: 1,
      send: (frame: string) => frames.push(frame),
    } as never);
    frames.length = 0;

    const advancedPayload = { ...originalPayload, contextConfirmed: true };
    const advanced = await storage.projectChatOperations.transition({
      id: "operation-1", thread_id: "thread-operation-replace", project_id: "project-1", user_id: "user-1",
      status: "running", payload: advancedPayload, error: null,
      message: {
        id: "operation:operation-1:running",
        content: projectChatPublicOperationContent(advancedPayload),
      },
    });
    expect(advanced?.changed).toBe(true);
    const publisher = manager as unknown as {
      publishMessage: (live: unknown, message: NonNullable<typeof original>) => void;
      liveThreads: Map<string, unknown>;
    };
    publisher.publishMessage(publisher.liveThreads.get("thread-operation-replace"), advanced!.message);
    publisher.publishMessage(publisher.liveThreads.get("thread-operation-replace"), advanced!.message);

    const snapshot = await manager.openThread("thread-operation-replace", "user-1");
    expect(snapshot.messages).toHaveLength(1);
    expect(JSON.parse(snapshot.messages[0].content)).toMatchObject({
      kind: "schedule_run", status: "running", runAvailable: true,
    });
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0])).toMatchObject({
      JsonPatch: [{ op: "replace", path: "/messages/0" }],
    });
    await manager.shutdown();
  });

  it("starts an atomically accepted initial turn once and does not duplicate it on reopen", async () => {
    await storage.projectChatThreads.createWithInitialTurn({
      id: "initial-thread", project_id: "project-1", user_id: "user-1", title: null,
      initialTurn: { messageId: "initial-user", workItemId: "initial-work", content: "begin" },
    });
    const run = vi.fn(async function* () {
      yield { type: "assistant" as const, content: "started" };
    });
    const manager = new ProjectChatManager(storage, { run });

    await manager.startAcceptedThread("initial-thread", "user-1");
    await waitFor(async () => (await manager.openThread("initial-thread", "user-1")).status === "idle");
    await manager.startAcceptedThread("initial-thread", "user-1");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(run).toHaveBeenCalledOnce();
    expect((await storage.projectChatMessages.listByThread(
      "initial-thread", "project-1", "user-1",
    )).filter(({ type }) => type === "user")).toEqual([
      expect.objectContaining({ id: "initial-user", content: "begin" }),
    ]);
    expect(await storage.projectChatWorkItems.listNonterminal(
      "initial-thread", "project-1", "user-1",
    )).toEqual([]);
  });

  it("recovers a durably accepted initial turn from ready without a route start or stream open", async () => {
    await storage.projectChatThreads.createWithInitialTurn({
      id: "autonomous-thread", project_id: "project-1", user_id: "user-1", title: null,
      initialTurn: { messageId: "autonomous-user", workItemId: "autonomous-work", content: "begin" },
    });
    const run = vi.fn(async function* () {
      yield { type: "assistant" as const, content: "recovered" };
    });

    const manager = new ProjectChatManager(storage, { run });
    await manager.ready();
    await waitFor(async () => (await storage.projectChatWorkItems.listNonterminal(
      "autonomous-thread", "project-1", "user-1",
    )).length === 0);

    expect(run).toHaveBeenCalledOnce();
    expect((await storage.projectChatMessages.listByThread(
      "autonomous-thread", "project-1", "user-1",
    )).map(({ type }) => type)).toEqual(["user", "assistant", "turn_end"]);
    await manager.shutdown();
  });

  it("retries autonomous accepted-work recovery after transient startup storage failure", async () => {
    await storage.projectChatThreads.createWithInitialTurn({
      id: "retry-recovery", project_id: "project-1", user_id: "user-1", title: null,
      initialTurn: { messageId: "retry-user", workItemId: "retry-work", content: "begin" },
    });
    const original = storage.projectChatWorkItems.listRecoveryPage
      .bind(storage.projectChatWorkItems);
    vi.spyOn(storage.projectChatWorkItems, "listRecoveryPage")
      .mockRejectedValueOnce(new Error("startup storage unavailable"))
      .mockImplementation(original);
    const run = vi.fn(async function* () {
      yield { type: "assistant" as const, content: "recovered later" };
    });
    const manager = new ProjectChatManager(storage, { run }, { reconciliationIntervalMs: 5 });

    expect((await manager.ready()).infrastructureErrors).toContain("startup storage unavailable");
    await waitFor(async () => (await storage.projectChatWorkItems.listNonterminal(
      "retry-recovery", "project-1", "user-1",
    )).length === 0);

    expect(run).toHaveBeenCalledOnce();
    await manager.shutdown();
  });

  it("returns from ready at the startup deadline when the recovery read stalls", async () => {
    const pageRead = vi.spyOn(storage.projectChatWorkItems, "listRecoveryPage")
      .mockImplementation(() => new Promise(() => undefined));
    const manager = new ProjectChatManager(storage, reply("unused"), {
      startupReconciliationDeadlineMs: 15,
      reconciliationIntervalMs: 5,
      drainTimeoutMs: 20,
    });
    const startedAt = Date.now();

    await manager.ready();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(pageRead).toHaveBeenCalledOnce();
    await manager.shutdown();
  });

  it.each(["authorization", "hydration", "quarantine"] as const)(
    "bounds recovery when %s stalls and resumes the same candidate on a later tick",
    async (phase) => {
      await storage.projectChatThreads.createWithInitialTurn({
        id: "stalled-recovery", project_id: "project-1", user_id: "user-1", title: null,
        initialTurn: { messageId: "stalled-message", workItemId: "stalled-work", content: "resume me" },
      });
      if (phase === "quarantine") {
        const raw = new Database(dbPath);
        raw.prepare("UPDATE project_chat_threads SET user_id = 'foreign' WHERE id = 'stalled-recovery'").run();
        raw.close();
      }
      const started = deferred();
      const release = deferred();
      let stalledCalls = 0;
      if (phase === "authorization") {
        const original = storage.projectChatThreads.getOwnedById.bind(storage.projectChatThreads);
        vi.spyOn(storage.projectChatThreads, "getOwnedById").mockImplementation(async (...args) => {
          if (args[0] === "stalled-recovery" && stalledCalls++ === 0) {
            started.resolve();
            await release.promise;
          }
          return original(...args);
        });
      } else if (phase === "hydration") {
        const original = storage.projectChatMessages.listByThread.bind(storage.projectChatMessages);
        vi.spyOn(storage.projectChatMessages, "listByThread").mockImplementation(async (...args) => {
          if (args[0] === "stalled-recovery" && stalledCalls++ === 0) {
            started.resolve();
            await release.promise;
          }
          return original(...args);
        });
      } else {
        const original = storage.projectChatWorkItems.quarantineRecovery
          .bind(storage.projectChatWorkItems);
        vi.spyOn(storage.projectChatWorkItems, "quarantineRecovery").mockImplementation(async (...args) => {
          if (args[0] === "stalled-work" && stalledCalls++ === 0) {
            started.resolve();
            await release.promise;
          }
          return original(...args);
        });
      }
      const run = vi.fn(async function* () {
        yield { type: "assistant" as const, content: "recovered" };
      });
      const manager = new ProjectChatManager(storage, { run }, {
        startupReconciliationDeadlineMs: 12,
        reconciliationOperationTimeoutMs: 12,
        reconciliationIntervalMs: 5,
        drainTimeoutMs: 20,
      });
      await started.promise;
      const readyStartedAt = Date.now();

      await manager.ready();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(Date.now() - readyStartedAt).toBeLessThan(150);
      expect(stalledCalls).toBe(1);
      expect(run).not.toHaveBeenCalled();
      release.resolve();
      if (phase === "quarantine") {
        await waitFor(() => {
          const verify = new Database(dbPath, { readonly: true });
          try {
            return (verify.prepare("SELECT status FROM project_chat_work_items WHERE id = 'stalled-work'")
              .get() as { status: string }).status === "failed";
          } finally { verify.close(); }
        });
        expect(run).not.toHaveBeenCalled();
      } else {
        await waitFor(() => run.mock.calls.length === 1);
      }
      await manager.shutdown();
    },
  );

  it("quarantines corrupt recovery ownership without invoking the model", async () => {
    await storage.projectChatThreads.createWithInitialTurn({
      id: "corrupt-owner", project_id: "project-1", user_id: "user-1", title: null,
      initialTurn: { messageId: "corrupt-message", workItemId: "corrupt-work", content: "must not run" },
    });
    const raw = new Database(dbPath);
    raw.prepare("UPDATE project_chat_threads SET user_id = 'user-2' WHERE id = 'corrupt-owner'").run();
    raw.close();
    const run = vi.fn(async function* () {
      yield { type: "assistant" as const, content: "unsafe" };
    });

    const manager = new ProjectChatManager(storage, { run });
    await manager.ready();

    expect(run).not.toHaveBeenCalled();
    const verify = new Database(dbPath, { readonly: true });
    try {
      expect(verify.prepare("SELECT status, error FROM project_chat_work_items WHERE id = 'corrupt-work'").get())
        .toEqual({
          status: "failed",
          error: "Recovery quarantined: thread owner does not own the referenced project",
        });
    } finally {
      verify.close();
    }
    await manager.shutdown();
  });

  it("preserves local-sentinel project authorization during autonomous recovery", async () => {
    await storage.projectChatThreads.createWithInitialTurn({
      id: "local-owner", project_id: "project-1", user_id: "local", title: null,
      initialTurn: { messageId: "local-message", workItemId: "local-work", content: "run locally" },
    });
    const run = vi.fn(async function* () {
      yield { type: "assistant" as const, content: "safe" };
    });
    const manager = new ProjectChatManager(storage, { run });

    await manager.ready();
    await waitFor(() => run.mock.calls.length === 1);

    expect(run).toHaveBeenCalledOnce();
    await manager.shutdown();
  });

  it("bounds startup recovery and fairly drains a large backlog under the global turn cap", async () => {
    for (let index = 0; index < 12; index++) {
      const id = `backlog-${String(index).padStart(2, "0")}`;
      await storage.projectChatThreads.createWithInitialTurn({
        id, project_id: "project-1", user_id: "user-1", title: null,
        initialTurn: { messageId: `${id}-message`, workItemId: `${id}-work`, content: id },
      });
    }
    let active = 0;
    let maximumActive = 0;
    const starts: string[] = [];
    const run = vi.fn(async function* (input: ProjectChatRunInput) {
      active++;
      maximumActive = Math.max(maximumActive, active);
      starts.push(input.threadId);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active--;
      yield { type: "assistant" as const, content: "done" };
    });
    const recoveryPages = vi.spyOn(storage.projectChatWorkItems, "listRecoveryPage");
    const manager = new ProjectChatManager(storage, { run }, {
      maxConcurrentTurns: 2,
      recoveryPageSize: 3,
      reconciliationIntervalMs: 2,
      startupReconciliationDeadlineMs: 20,
    });

    await manager.ready();
    expect(recoveryPages).toHaveBeenCalledTimes(1);
    expect(starts.length).toBeLessThanOrEqual(2);
    await waitFor(() => starts.length === 12);
    await waitFor(() => active === 0);

    expect(maximumActive).toBe(2);
    expect(new Set(starts).size).toBe(12);
    expect(starts.slice(0, 6)).toEqual([
      "backlog-00", "backlog-01", "backlog-02", "backlog-03", "backlog-04", "backlog-05",
    ]);
    await manager.shutdown();
  });

  it("drops recovery backpressure on shutdown without starting queued turns", async () => {
    for (let index = 0; index < 5; index++) {
      const id = `shutdown-backlog-${index}`;
      await storage.projectChatThreads.createWithInitialTurn({
        id, project_id: "project-1", user_id: "user-1", title: null,
        initialTurn: { messageId: `${id}-message`, workItemId: `${id}-work`, content: id },
      });
    }
    const starts: string[] = [];
    const run = vi.fn(async function* (input: ProjectChatRunInput) {
      starts.push(input.threadId);
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const manager = new ProjectChatManager(storage, { run }, {
      maxConcurrentTurns: 1, recoveryPageSize: 5, drainTimeoutMs: 50,
    });
    await manager.ready();
    await waitFor(() => starts.length === 1);

    await manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(starts).toHaveLength(1);
  });

  it("opens and starts accepted work when the Context projection is temporarily unavailable", async () => {
    await storage.projectChatThreads.createWithInitialTurn({
      id: "context-start", project_id: "project-1", user_id: "user-1", title: null,
      initialTurn: { messageId: "context-user", workItemId: "context-work", content: "begin" },
    });
    const resolveExisting = vi.spyOn(storage.projectChatContextRefs, "resolveExisting")
      .mockRejectedValue(new Error("context infrastructure unavailable"));
    const manager = new ProjectChatManager(storage, reply("survived"));

    await expect(manager.openThread("context-start", "user-1"))
      .resolves.toMatchObject({ identity: { threadId: "context-start" }, contextRefs: [] });
    await manager.startAcceptedThread("context-start", "user-1");
    await waitFor(async () => (await storage.projectChatWorkItems.listNonterminal(
      "context-start", "project-1", "user-1",
    )).length === 0);

    expect(resolveExisting).toHaveBeenCalled();
    expect((await storage.projectChatMessages.listByThread(
      "context-start", "project-1", "user-1",
    )).map(({ type }) => type)).toEqual(["user", "assistant", "turn_end"]);
    await manager.shutdown();
  });

  it("resumes an accepted initial turn after manager restart without duplicating acceptance", async () => {
    await storage.projectChatThreads.createWithInitialTurn({
      id: "restart-thread", project_id: "project-1", user_id: "user-1", title: null,
      initialTurn: { messageId: "restart-user", workItemId: "restart-work", content: "resume" },
    });
    const run = vi.fn(async function* () {
      yield { type: "assistant" as const, content: "recovered" };
    });
    const restarted = new ProjectChatManager(storage, { run });

    await restarted.openThread("restart-thread", "user-1");
    await waitFor(async () => (await restarted.openThread("restart-thread", "user-1")).status === "idle");

    expect(run).toHaveBeenCalledOnce();
    expect((await storage.projectChatMessages.listByThread(
      "restart-thread", "project-1", "user-1",
    )).filter(({ type }) => type === "user")).toHaveLength(1);
  });

  it("loads authorized context refs into snapshots with deleted markers", async () => {
    await createThread("context-thread");
    await storage.tasks.create({ id: "task-live", project_id: "project-1", title: "Live" });
    await storage.tasks.create({ id: "task-foreign", project_id: "project-2", title: "Foreign" });
    await storage.projectChatContextRefs.touch("context-thread", "project-1", "user-1", "task", "task-live");
    await storage.projectChatContextRefs.touch("context-thread", "project-1", "user-1", "task", "task-deleted");
    await storage.projectChatContextRefs.touch("context-thread", "project-1", "user-1", "task", "task-foreign");
    const manager = new ProjectChatManager(storage, reply("unused"));

    const snapshot = await manager.openThread("context-thread", "user-1");

    expect(snapshot.contextRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_id: "task-live", deleted: false }),
      expect.objectContaining({ entity_id: "task-deleted", deleted: true }),
      expect.objectContaining({ entity_id: "task-foreign", deleted: true }),
    ]));
    expect(snapshot.contextRefs).toHaveLength(3);
  });

  it("describes Project Chat as project-scoped and independent of branches or workspaces", () => {
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toContain("project-scoped");
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toContain("multiple workspaces");
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toContain("does not belong to a branch or workspace");
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/create.*task/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/update.*task/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/agent session/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/instruction/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/run.*schedule/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).not.toMatch(/read-only|never claim to have changed/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/no delete/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/no .*worktree/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/no .*schedule configuration/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/no .*stop/i);
    expect(PROJECT_CHAT_SYSTEM_PROMPT).toMatch(/no Git/i);
  });

  it("persists a matching session event only to its correlated thread and ignores foreign or stale events", async () => {
    await createThread("thread-1");
    await createThread("thread-2");
    await correlate("thread-1", "op-1", "agent_session_create", "agent_session", "session-1", { sessionId: "session-1" });
    await correlate("thread-2", "op-2", "agent_session_create", "agent_session", "session-2", { sessionId: "session-2" });
    const eventBus = new EventBus();
    const manager = new ProjectChatManager(storage, reply("unused"), { eventBus });

    eventBus.emit({
      type: "session:taskCompleted", projectId: "project-1", branch: "dev",
      sessionId: "session-1", summaryText: "done",
    });
    await waitFor(async () => (await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    )).some(({ type }) => type === "operation"));
    eventBus.emit({ type: "session:status", projectId: "project-1", branch: "dev", sessionId: "session-1", status: "running" });
    eventBus.emit({
      type: "session:taskCompleted", projectId: "project-1", branch: "dev", sessionId: "session-1",
    });
    eventBus.emit({
      type: "session:taskCompleted", projectId: "project-2", branch: "dev", sessionId: "session-2",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const first = await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
    const second = await storage.projectChatMessages.listByThread("thread-2", "project-1", "user-1");
    expect(first.filter(({ type }) => type === "operation")).toHaveLength(1);
    expect(JSON.parse(first[0].content)).toMatchObject({
      version: 1, kind: "agent_session_create", operationId: "op-1", status: "completed",
      sessionId: "session-1",
    });
    expect(second).toEqual([]);
    expect((await storage.projectChatOperations.getById("op-1", "thread-1", "project-1", "user-1"))?.status)
      .toBe("completed");
    await manager.shutdown();
  });

  it("updates every legitimately correlated thread and survives absent subscribers and restart", async () => {
    await createThread("thread-1");
    await createThread("thread-2");
    await correlate("thread-1", "op-1", "schedule_run", "schedule_run", "run-1", {
      scheduleId: "schedule-1", runId: "run-1",
    });
    await correlate("thread-2", "op-2", "schedule_run", "schedule_run", "run-1", {
      scheduleId: "schedule-1", runId: "run-1",
    });
    const eventBus = new EventBus();
    const firstManager = new ProjectChatManager(storage, reply("unused"), { eventBus });

    eventBus.emit({
      type: "schedule:run-finished", projectId: "project-1", scheduleId: "schedule-1",
      runId: "run-1", status: "completed", exitCode: 0,
    });
    await waitFor(async () => (await storage.projectChatMessages.listByThread(
      "thread-2", "project-1", "user-1",
    )).some(({ type }) => type === "operation"));
    await firstManager.shutdown();

    const secondManager = new ProjectChatManager(storage, reply("unused"), { eventBus: new EventBus() });
    const first = await secondManager.openThread("thread-1", "user-1");
    const second = await secondManager.openThread("thread-2", "user-1");
    expect(first.messages.filter(({ type }) => type === "operation")).toHaveLength(1);
    expect(second.messages.filter(({ type }) => type === "operation")).toHaveLength(1);
    await secondManager.shutdown();
  });

  it("persists schedule timeouts as a structured timeout failure", async () => {
    await createThread("thread-timeout");
    await storage.scheduledTasks.create({
      id: "schedule-1", project_id: "project-1", name: "Timeout schedule",
      cron_expr: "0 9 * * *", timezone: "UTC", run_type: "command",
      content: "exit 1", cwd_mode: "branch",
    });
    await storage.scheduledTaskRuns.create({
      id: "run-timeout", schedule_id: "schedule-1", status: "running",
    });
    await correlate("thread-timeout", "timeout-op", "schedule_run", "schedule_run", "run-timeout", {
      scheduleId: "schedule-1", runId: "run-timeout",
    });
    const eventBus = new EventBus();
    const manager = new ProjectChatManager(storage, reply("unused"), { eventBus });
    await manager.openThread("thread-timeout", "user-1");
    const frames: string[] = [];
    manager.subscribe("thread-timeout", {
      projectChatUserId: "user-1", readyState: 1, OPEN: 1,
      send: (frame: string) => frames.push(frame),
    } as never);
    frames.length = 0;

    eventBus.emit({
      type: "schedule:run-finished", projectId: "project-1", scheduleId: "schedule-1",
      runId: "run-timeout", status: "timeout", exitCode: null,
    });
    await waitFor(async () => (await storage.projectChatMessages.listByThread(
      "thread-timeout", "project-1", "user-1",
    )).some(({ type }) => type === "operation"));

    const messages = await storage.projectChatMessages.listByThread(
      "thread-timeout", "project-1", "user-1",
    );
    expect(JSON.parse(messages.find(({ type }) => type === "operation")!.content)).toMatchObject({
      version: 1,
      kind: "schedule_run",
      operationId: "timeout-op",
      status: "failed",
      failure: {
        code: "timeout",
        message: "Operation timed out. Review the target and try again.",
      },
    });
    expect(frames.some((frame) => frame.includes("Operation timed out"))).toBe(true);
    await manager.shutdown();

    const restarted = new ProjectChatManager(storage, reply("unused"));
    const snapshot = await restarted.openThread("thread-timeout", "user-1");
    expect(snapshot.messages.some(({ content }) => content.includes("Operation timed out"))).toBe(true);
    await restarted.shutdown();
  });

  it("subscribes to global events once, persists before websocket delivery, and unsubscribes on shutdown", async () => {
    await createThread("thread-1");
    await correlate("thread-1", "op-1", "agent_session_create", "agent_session", "session-1", { sessionId: "session-1" });
    const eventBus = new EventBus();
    const subscribe = vi.spyOn(eventBus, "subscribe");
    const manager = new ProjectChatManager(storage, reply("unused"), { eventBus });
    await manager.openThread("thread-1", "user-1");
    const send = vi.fn(async () => undefined);
    manager.subscribe("thread-1", { projectChatUserId: "user-1", send, readyState: 1 } as never);
    send.mockClear();

    eventBus.emit({
      type: "session:status", projectId: "project-1", branch: "dev", sessionId: "session-1", status: "error",
    });
    await waitFor(() => send.mock.calls.length > 0);
    expect(await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1"))
      .toContainEqual(expect.objectContaining({ id: "operation:op-1:failed", type: "operation" }));
    expect(subscribe).toHaveBeenCalledTimes(1);
    await manager.shutdown();
    expect(eventBus.emit({
      type: "session:taskCompleted", projectId: "project-1", branch: "dev", sessionId: "session-1",
    })).toBeUndefined();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("reconciles missed terminal session and schedule events on startup without a subscriber", async () => {
    await createThread("thread-1");
    await storage.agentSessions.create({ id: "session-1", project_id: "project-1", branch: "dev" });
    await storage.agentSessions.updateStatus("session-1", "error");
    await storage.scheduledTasks.create({
      id: "schedule-1", project_id: "project-1", name: "Run", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
    });
    await storage.scheduledTaskRuns.create({ id: "run-1", schedule_id: "schedule-1", status: "running" });
    await storage.scheduledTaskRuns.finish("run-1", { status: "completed", exit_code: 0 });
    await correlate("thread-1", "session-op", "agent_session_create", "agent_session", "session-1", { sessionId: "session-1" });
    await storage.projectChatOperations.create({
      id: "run-op", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
      kind: "schedule_run", status: "pending", entity_type: "schedule_run", entity_id: "run-1",
      idempotency_key: "run-op", payload: { version: 1, kind: "schedule_run", operationId: "run-op",
        status: "pending", scheduleId: "schedule-1", runId: "run-1", contextConfirmed: false }, error: null,
    });

    const manager = new ProjectChatManager(storage, reply("unused"), { eventBus: new EventBus() });
    await manager.ready();
    expect((await storage.projectChatOperations.getById("session-op", "thread-1", "project-1", "user-1"))?.status)
      .toBe("failed");
    expect((await storage.projectChatOperations.getById("run-op", "thread-1", "project-1", "user-1"))?.status)
      .toBe("completed");
    expect((await storage.projectChatOperations.getById("run-op", "thread-1", "project-1", "user-1"))?.payload)
      .toMatchObject({ contextConfirmed: true });
    expect((await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1"))
      .filter(({ type }) => type === "operation")).toHaveLength(2);
    await manager.shutdown();
  });

  it("resumes pending creates, runs, and unconfirmed instruction delivery with stable identities", async () => {
    await createThread("thread-1");
    await storage.agentSessions.create({ id: "already-created", project_id: "project-1", branch: "dev" });
    await storage.scheduledTasks.create({
      id: "schedule-1", project_id: "project-1", name: "Run", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
    });
    const sessionPayload = (operationId: string, sessionId: string) => ({
      version: 1 as const, kind: "agent_session_create" as const, operationId, status: "pending" as const,
      sessionId, workspaceId: JSON.stringify(["local", "dev"]), target: "local", branch: "dev",
      instruction: "Implement", permissionMode: "edit", agentType: "claude-code", model: null,
      initialInstructionDelivery: "pending" as const,
    });
    for (const [id, sessionId] of [["before-effect", "new-session"], ["after-effect", "already-created"]] as const) {
      await storage.projectChatOperations.create({
        id, thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
        kind: "agent_session_create", status: "pending", entity_type: "agent_session", entity_id: sessionId,
        idempotency_key: `session:${sessionId}`, payload: sessionPayload(id, sessionId), error: null,
      });
    }
    await storage.projectChatOperations.create({
      id: "pending-run", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
      kind: "schedule_run", status: "pending", entity_type: "schedule_run", entity_id: "run-1",
      idempotency_key: "run-1", payload: { version: 1, kind: "schedule_run", operationId: "pending-run", status: "pending", scheduleId: "schedule-1", runId: "run-1" }, error: null,
    });
    await storage.projectChatOperations.create({
      id: "pending-send", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
      kind: "agent_instruction", status: "running", entity_type: "agent_session", entity_id: "already-created",
      idempotency_key: "send-key", payload: { version: 1, kind: "agent_instruction", operationId: "pending-send", status: "running", sessionId: "already-created", instruction: "Continue", target: "local", delivery: "pending" }, error: null,
    });
    const createAgentSession = vi.fn(async ({ sessionId }) => {
      if (!(await storage.agentSessions.getById(sessionId))) {
        await storage.agentSessions.create({ id: sessionId, project_id: "project-1", branch: "dev" });
      }
      return { sessionId };
    });
    const sendAgentInstruction = vi.fn(async () => true);
    const runScheduleNow = vi.fn(async (_scheduleId, runId) => {
      await storage.scheduledTaskRuns.create({ id: runId, schedule_id: "schedule-1", status: "running" });
      return { runId, skipped: false } as const;
    });
    const manager = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(),
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => false },
        mutationServices: { createAgentSession, sendAgentInstruction, runScheduleNow },
      },
    });
    await manager.ready();
    expect(createAgentSession).toHaveBeenCalledTimes(2);
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "new-session", idempotencyKey: "session:new-session" }));
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "already-created", idempotencyKey: "session:already-created" }));
    expect(sendAgentInstruction).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "send-key" }));
    expect(runScheduleNow).toHaveBeenCalledWith("schedule-1", "run-1");
    for (const id of ["before-effect", "after-effect", "pending-run"]) {
      expect((await storage.projectChatOperations.getById(id, "thread-1", "project-1", "user-1"))?.status).toBe("running");
    }
    expect((await storage.projectChatOperations.getById("pending-send", "thread-1", "project-1", "user-1"))?.status)
      .toBe("completed");
    for (const id of ["before-effect", "after-effect"] as const) {
      expect((await storage.projectChatOperations.getById(id, "thread-1", "project-1", "user-1"))?.payload)
        .toMatchObject({ initialInstructionDelivery: "confirmed" });
    }
    expect((await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1"))
      .map(({ entity_type, entity_id }) => `${entity_type}:${entity_id}`).sort()).toEqual([
        "agent_session:already-created",
        "agent_session:new-session",
        "schedule:schedule-1",
        "schedule_run:run-1",
        `workspace:${JSON.stringify(["local", "dev"])}`,
      ].sort());
    await manager.shutdown();
  });

  it("resolves an offered workspace through the durable tool protocol and publishes its live operation and Context", async () => {
    await createThread("selection-thread");
    const workspaceId = JSON.stringify(["local", "dev"]);
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }], sessions: [],
    });
    await storage.projectChatOperations.create({
      id: "selection-op", thread_id: "selection-thread", project_id: "project-1", user_id: "user-1",
      kind: "agent_session_create", status: "pending", entity_type: null, entity_id: null,
      idempotency_key: "session:seed-1", payload: {
        version: 1, kind: "agent_session_create", operationId: "selection-op", status: "pending",
        phase: "workspace_selection", requestId: "selection-op", sessionId: "seed-1", workerSessionId: "seed-1",
        instruction: "Implement cards", permissionMode: "edit", agentType: "claude-code", model: null,
        initialInstructionDelivery: "pending", candidates: [{ id: workspaceId, target: "local", branch: "dev" }],
      }, error: null,
    });
    await storage.projectChatOperations.announce({
      id: "selection-op", thread_id: "selection-thread", project_id: "project-1", user_id: "user-1",
      message: { id: "operation:selection-op:workspace_selection", content: JSON.stringify({
        version: 1, kind: "workspace_selection", operationId: "selection-op", status: "pending",
        requestId: "selection-op", candidates: [{ id: workspaceId, target: "local", branch: "dev" }],
      }) },
    });
    const creationGate = deferred<void>();
    const createAgentSession = vi.fn(async ({ sessionId }) => {
      await creationGate.promise;
      return { sessionId };
    });
    const manager = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(),
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => true },
        mutationServices: {
          createAgentSession, sendAgentInstruction: async () => true,
          runScheduleNow: async (_id, runId) => ({ runId, skipped: false }),
        },
      },
    });
    await manager.openThread("selection-thread", "user-1");
    const frames: string[] = [];
    const socket = {
      projectChatUserId: "user-1",
      readyState: 1,
      OPEN: 1,
      send: (frame: string) => frames.push(frame),
    };
    expect(manager.subscribe("selection-thread", socket as never)).not.toBeNull();
    frames.length = 0;

    const selection = manager.selectWorkspace(
      "selection-thread", "user-1", "selection-op", workspaceId,
    );

    await waitFor(async () => {
      const messages = await storage.projectChatMessages.listByThread(
        "selection-thread", "project-1", "user-1",
      );
      return messages.some(({ type, content }) => type === "operation"
        && JSON.parse(content).kind === "agent_session_create"
        && JSON.parse(content).status === "resolving");
    });
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const resolvingEntries = frames.flatMap((frame) => {
      const parsed = JSON.parse(frame) as { JsonPatch?: Array<{ value?: { type?: string; content?: unknown } }> };
      return (parsed.JsonPatch ?? []).flatMap((patch) => patch.value?.type === "ENTRY"
        ? [patch.value.content as { type?: string; content?: string }] : []);
    });
    expect(resolvingEntries.some((entry) => {
      if (entry.type !== "operation" || typeof entry.content !== "string") return false;
      const content = JSON.parse(entry.content) as { kind?: string; status?: string };
      return content.kind === "agent_session_create" && content.status === "resolving";
    })).toBe(true);
    const midFlight = await manager.openThread("selection-thread", "user-1");
    const resolvingMessage = midFlight.messages.find(({ type, content }) => type === "operation"
      && JSON.parse(content).status === "resolving");
    expect(resolvingMessage).toBeDefined();
    expect(resolvingMessage?.content).not.toContain("claimToken");
    expect(resolvingMessage?.content).not.toContain("initialInstructionDelivery");

    creationGate.resolve();
    const result = await selection;

    expect(result).toMatchObject({ status: "running", sessionId: expect.any(String) });
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      target: "local", branch: "dev", instruction: "Implement cards",
    }));
    const liveEntries = frames.flatMap((frame) => {
      const parsed = JSON.parse(frame) as { JsonPatch?: Array<{ value?: { type?: string; content?: unknown } }> };
      return (parsed.JsonPatch ?? []).flatMap((patch) => patch.value?.type === "ENTRY"
        ? [patch.value.content as { type?: string; content?: string }] : []);
    });
    expect(liveEntries.some((entry) => {
      if (entry.type !== "operation" || typeof entry.content !== "string") return false;
      return JSON.parse(entry.content).kind === "agent_session_create"
        && JSON.parse(entry.content).status === "running";
    })).toBe(true);
    expect(frames.some((frame) => frame.includes('"type":"CONTEXT"')
      && frame.includes('"entity_type":"agent_session"'))).toBe(true);
    const reloaded = await manager.openThread("selection-thread", "user-1");
    expect(reloaded.messages.filter(({ type }) => type === "operation")).toHaveLength(3);
    expect(JSON.parse(reloaded.messages.at(-1)!.content)).toMatchObject({
      kind: "agent_session_create", status: "running",
    });
    await expect(manager.selectWorkspace(
      "selection-thread", "user-1", "selection-op", JSON.stringify(["local", "other"]),
    )).rejects.toBeInstanceOf(ProjectChatWorkspaceSelectionConflictError);
    await manager.shutdown();
  });

  it("retries a temporary instruction dependency failure while the manager stays live", async () => {
    await createThread("thread-live-retry");
    await storage.agentSessions.create({ id: "retry-session", project_id: "project-1", branch: "dev" });
    await storage.projectChatOperations.create({
      id: "retry-send", thread_id: "thread-live-retry", project_id: "project-1", user_id: "user-1",
      kind: "agent_instruction", status: "running", entity_type: "agent_session", entity_id: "retry-session",
      idempotency_key: "retry-key", payload: {
        version: 1, kind: "agent_instruction", operationId: "retry-send", status: "running",
        sessionId: "retry-session", instruction: "Continue", target: "local", delivery: "pending",
      }, error: null,
    });
    const sendAgentInstruction = vi.fn()
      .mockRejectedValueOnce(new Error("worker temporarily offline"))
      .mockResolvedValue(true);
    const manager = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(), reconciliationIntervalMs: 5,
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => true },
        mutationServices: {
          createAgentSession: async ({ sessionId }) => ({ sessionId }), sendAgentInstruction,
          runScheduleNow: async (_id, runId) => ({ runId, skipped: false }),
        },
      },
    });

    await manager.ready();
    expect((await storage.projectChatOperations.getById(
      "retry-send", "thread-live-retry", "project-1", "user-1",
    ))?.status).toBe("running");
    await waitFor(() => sendAgentInstruction.mock.calls.length >= 2);
    await waitFor(async () => (await storage.projectChatOperations.getById(
      "retry-send", "thread-live-retry", "project-1", "user-1",
    ))?.status === "completed");
    expect(sendAgentInstruction).toHaveBeenCalledTimes(2);
    await manager.shutdown();
  });

  it("keeps a timed-out mutation single-flight and records retries only after it settles", async () => {
    await createThread("thread-slow-retry");
    await storage.agentSessions.create({ id: "slow-session", project_id: "project-1", branch: "dev" });
    await storage.projectChatOperations.create({
      id: "slow-send", thread_id: "thread-slow-retry", project_id: "project-1", user_id: "user-1",
      kind: "agent_instruction", status: "running", entity_type: "agent_session", entity_id: "slow-session",
      idempotency_key: "slow-key", payload: {
        version: 1, kind: "agent_instruction", operationId: "slow-send", status: "running",
        sessionId: "slow-session", instruction: "Continue", target: "local", delivery: "pending",
      }, error: null,
    });
    const first = deferred<boolean>();
    const sendAgentInstruction = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true);
    const manager = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(), reconciliationIntervalMs: 5,
      reconciliationOperationTimeoutMs: 10, startupReconciliationDeadlineMs: 20,
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => true },
        mutationServices: {
          createAgentSession: async ({ sessionId }) => ({ sessionId }), sendAgentInstruction,
          runScheduleNow: async (_id, runId) => ({ runId, skipped: false }),
        },
      },
    });

    await manager.ready();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sendAgentInstruction).toHaveBeenCalledTimes(1);
    expect(await storage.projectChatOperations.getById(
      "slow-send", "thread-slow-retry", "project-1", "user-1",
    )).toMatchObject({ status: "running", retry_count: 0 });

    first.reject(new Error("settled failure"));
    await waitFor(async () => (await storage.projectChatOperations.getById(
      "slow-send", "thread-slow-retry", "project-1", "user-1",
    ))?.retry_count === 1);
    await waitFor(() => sendAgentInstruction.mock.calls.length === 2);
    await waitFor(async () => (await storage.projectChatOperations.getById(
      "slow-send", "thread-slow-retry", "project-1", "user-1",
    ))?.status === "completed");
    expect(sendAgentInstruction).toHaveBeenCalledTimes(2);
    expect((await storage.projectChatOperations.getById(
      "slow-send", "thread-slow-retry", "project-1", "user-1",
    ))?.retry_count).toBe(0);
    await manager.shutdown();
  });

  it("reconciles task create and update crash windows without overwriting later edits", async () => {
    await createThread("thread-task-recovery");
    await storage.searchCache.applyCatalogSnapshot("project-1", "local", {
      workspaces: [{ branch: "dev" }], sessions: [],
    });
    await storage.tasks.create({
      id: "updated-task", project_id: "project-1", title: "After", description: null,
      status: "in_progress", priority: "high", assigned_branch: "dev",
    });
    await storage.tasks.create({
      id: "conflicted-task", project_id: "project-1", title: "Human edit", description: null,
      status: "todo", priority: "medium", assigned_branch: null,
    });
    await storage.projectChatOperations.create({
      id: "task-create-op", thread_id: "thread-task-recovery", project_id: "project-1", user_id: "user-1",
      kind: "task_create", status: "pending", entity_type: "task", entity_id: "created-task",
      idempotency_key: "task-create", payload: {
        version: 1, kind: "task_create", operationId: "task-create-op", status: "pending",
        taskId: "created-task", title: "Created", description: "Details", taskStatus: "todo",
        priority: "urgent", assignedBranch: "dev",
      }, error: null,
    });
    const updatePayload = (operationId: string, taskId: string) => ({
      version: 1 as const, kind: "task_update" as const, operationId, status: "running" as const,
      taskId, patch: { title: "After", status: "in_progress" as const, priority: "high" as const, assignedBranch: "dev" },
      before: { title: "Before", description: null, status: "todo" as const, priority: "medium" as const, assignedBranch: null },
    });
    for (const [id, taskId] of [["task-update-op", "updated-task"], ["task-conflict-op", "conflicted-task"]] as const) {
      await storage.projectChatOperations.create({
        id, thread_id: "thread-task-recovery", project_id: "project-1", user_id: "user-1",
        kind: "task_update", status: "running", entity_type: "task", entity_id: taskId,
        idempotency_key: id, payload: updatePayload(id, taskId), error: null,
      });
    }
    const update = vi.spyOn(storage.tasks, "update");
    const manager = new ProjectChatManager(storage, reply("unused"), { eventBus: new EventBus() });

    await manager.ready();
    expect(await storage.tasks.getById("created-task")).toMatchObject({
      title: "Created", description: "Details", priority: "urgent", assigned_branch: "dev",
    });
    expect(update).not.toHaveBeenCalled();
    expect((await storage.projectChatOperations.getById(
      "task-create-op", "thread-task-recovery", "project-1", "user-1",
    ))?.status).toBe("completed");
    expect((await storage.projectChatOperations.getById(
      "task-update-op", "thread-task-recovery", "project-1", "user-1",
    ))?.status).toBe("completed");
    expect((await storage.projectChatOperations.getById(
      "task-conflict-op", "thread-task-recovery", "project-1", "user-1",
    ))?.status).toBe("failed");
    expect((await storage.tasks.getById("conflicted-task"))?.title).toBe("Human edit");
    await manager.shutdown();
  });

  it("does not let a spawn event confirm initial instruction delivery and retries the same local session", async () => {
    await createThread("thread-delivery");
    const workspaceId = JSON.stringify(["local", "dev"]);
    await storage.projectChatOperations.create({
      id: "delivery-op", thread_id: "thread-delivery", project_id: "project-1", user_id: "user-1",
      kind: "agent_session_create", status: "pending", entity_type: "agent_session", entity_id: "delivery-session",
      idempotency_key: "delivery-key", payload: {
        version: 1, kind: "agent_session_create", operationId: "delivery-op", status: "pending",
        sessionId: "delivery-session", workspaceId, target: "local", branch: "dev",
        instruction: "Deliver exactly this", permissionMode: "edit", agentType: "claude-code", model: null,
        initialInstructionDelivery: "pending",
      }, error: null,
    });
    const gate = deferred();
    const eventBus = new EventBus();
    const createAgentSession = vi.fn(async ({ sessionId, idempotencyKey }) => {
      if (!(await storage.agentSessions.getById(sessionId))) {
        await storage.agentSessions.create({ id: sessionId, project_id: "project-1", branch: "dev" });
      }
      eventBus.emit({
        type: "session:status", projectId: "project-1", branch: "dev", sessionId, status: "running",
      });
      await gate.promise;
      expect(idempotencyKey).toBe("delivery-key");
      return { sessionId };
    });
    const manager = new ProjectChatManager(storage, reply("unused"), {
      eventBus,
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => true },
        mutationServices: { createAgentSession, sendAgentInstruction: async () => true, runScheduleNow: async (_id, runId) => ({ runId, skipped: false }) },
      },
    });
    await waitFor(() => createAgentSession.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await storage.projectChatOperations.getById("delivery-op", "thread-delivery", "project-1", "user-1"))?.status)
      .toBe("pending");
    gate.resolve();
    await manager.ready();
    expect(await storage.projectChatOperations.getById("delivery-op", "thread-delivery", "project-1", "user-1"))
      .toMatchObject({ status: "running", payload: { initialInstructionDelivery: "confirmed" } });
    await manager.shutdown();

    const afterRestart = vi.fn(async ({ sessionId }) => ({ sessionId }));
    const restarted = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(),
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => true },
        mutationServices: { createAgentSession: afterRestart, sendAgentInstruction: async () => true, runScheduleNow: async (_id, runId) => ({ runId, skipped: false }) },
      },
    });
    await restarted.ready();
    expect(afterRestart).not.toHaveBeenCalled();
    await restarted.shutdown();
  });

  it("does not let a remote spawn event confirm initial instruction delivery and reuses the durable key", async () => {
    await createThread("thread-remote-delivery");
    const server = await storage.remoteServers.create({ name: "worker" }, "user-1");
    await storage.projectRemotes.add({
      project_id: "project-1", remote_server_id: server.id, remote_path: "/repo",
    });
    const sessionId = `remote-${server.id}-delivery`;
    const workspaceId = JSON.stringify([server.id, "dev"]);
    const mapping = {
      id: sessionId, projectId: "project-1", remoteServerId: server.id,
      remoteSessionId: "worker-session", branch: "dev",
    };
    await storage.projectChatOperations.create({
      id: "remote-delivery-op", thread_id: "thread-remote-delivery", project_id: "project-1", user_id: "user-1",
      kind: "agent_session_create", status: "pending", entity_type: "agent_session", entity_id: sessionId,
      idempotency_key: "remote-delivery-key", payload: {
        version: 1, kind: "agent_session_create", operationId: "remote-delivery-op", status: "pending",
        sessionId, workspaceId, target: server.id, branch: "dev", instruction: "Deliver remotely",
        permissionMode: "edit", agentType: "claude-code", model: null, initialInstructionDelivery: "pending",
      }, error: null,
    });
    const gate = deferred();
    const eventBus = new EventBus();
    const createAgentSession = vi.fn(async ({ sessionId: requestedId, idempotencyKey }) => {
      eventBus.emit({
        type: "session:status", projectId: "project-1", branch: "dev", sessionId: requestedId, status: "running",
      });
      await gate.promise;
      expect(idempotencyKey).toBe("remote-delivery-key");
      return { sessionId: requestedId };
    });
    const remoteSessions = {
      listByProject: vi.fn(async () => []), getMapping: vi.fn(async () => mapping),
      getDetail: vi.fn(async () => ({ status: "running" })),
    };
    const manager = new ProjectChatManager(storage, reply("unused"), {
      eventBus,
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => false }, remoteSessions,
        mutationServices: { createAgentSession, sendAgentInstruction: async () => true, runScheduleNow: async (_id, runId) => ({ runId, skipped: false }) },
      },
    });
    await waitFor(() => createAgentSession.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await storage.projectChatOperations.getById(
      "remote-delivery-op", "thread-remote-delivery", "project-1", "user-1",
    ))?.status).toBe("pending");
    gate.resolve();
    await manager.ready();
    expect(await storage.projectChatOperations.getById(
      "remote-delivery-op", "thread-remote-delivery", "project-1", "user-1",
    )).toMatchObject({ status: "running", payload: { initialInstructionDelivery: "confirmed" } });
    await manager.shutdown();

    const afterRestart = vi.fn(async ({ sessionId: requestedId }) => ({ sessionId: requestedId }));
    const restarted = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(),
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => false }, remoteSessions,
        mutationServices: { createAgentSession: afterRestart, sendAgentInstruction: async () => true, runScheduleNow: async (_id, runId) => ({ runId, skipped: false }) },
      },
    });
    await restarted.ready();
    expect(afterRestart).not.toHaveBeenCalled();
    await restarted.shutdown();
  });

  it("leaves recovered effects retryable when atomic context restoration fails", async () => {
    await createThread("thread-context-failure");
    await storage.agentSessions.create({ id: "context-session", project_id: "project-1", branch: "dev" });
    await storage.scheduledTasks.create({
      id: "context-schedule", project_id: "project-1", name: "Run", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
    });
    const base = { thread_id: "thread-context-failure", project_id: "project-1", user_id: "user-1", error: null };
    await storage.projectChatOperations.create({
      ...base, id: "context-create", kind: "agent_session_create", status: "pending",
      entity_type: "agent_session", entity_id: "created-context-session", idempotency_key: "context-create-key",
      payload: { version: 1, kind: "agent_session_create", operationId: "context-create", status: "pending",
        sessionId: "created-context-session", workspaceId: JSON.stringify(["local", "dev"]), target: "local", branch: "dev",
        instruction: "Implement", permissionMode: "edit", agentType: "claude-code", model: null, initialInstructionDelivery: "pending" },
    });
    await storage.projectChatOperations.create({
      ...base, id: "context-send", kind: "agent_instruction", status: "running",
      entity_type: "agent_session", entity_id: "context-session", idempotency_key: "context-send-key",
      payload: { version: 1, kind: "agent_instruction", operationId: "context-send", status: "running",
        sessionId: "context-session", instruction: "Continue", target: "local", delivery: "pending" },
    });
    await storage.projectChatOperations.create({
      ...base, id: "context-run", kind: "schedule_run", status: "pending",
      entity_type: "schedule_run", entity_id: "context-run-id", idempotency_key: "context-run-key",
      payload: { version: 1, kind: "schedule_run", operationId: "context-run", status: "pending",
        scheduleId: "context-schedule", runId: "context-run-id" },
    });
    vi.spyOn(storage.projectChatContextRefs, "touchMany").mockResolvedValue(undefined);
    const manager = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(),
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => false },
        mutationServices: {
          createAgentSession: async ({ sessionId }) => {
            await storage.agentSessions.create({ id: sessionId, project_id: "project-1", branch: "dev" });
            return { sessionId };
          },
          sendAgentInstruction: async () => true,
          runScheduleNow: async (_id, runId) => {
            await storage.scheduledTaskRuns.create({ id: runId, schedule_id: "context-schedule", status: "running" });
            return { runId, skipped: false };
          },
        },
      },
    });
    await manager.ready();
    expect((await storage.projectChatOperations.getById("context-create", "thread-context-failure", "project-1", "user-1"))?.status).toBe("pending");
    expect((await storage.projectChatOperations.getById("context-send", "thread-context-failure", "project-1", "user-1"))?.status).toBe("running");
    expect((await storage.projectChatOperations.getById("context-run", "thread-context-failure", "project-1", "user-1"))?.status).toBe("pending");
    expect(await storage.projectChatMessages.listByThread("thread-context-failure", "project-1", "user-1")).toEqual([]);
    await manager.shutdown();
  });

  it("never restores context for foreign or revoked reconciliation targets", async () => {
    await createThread("thread-stale");
    await storage.scheduledTasks.create({
      id: "foreign-schedule", project_id: "project-2", name: "Foreign", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
    });
    await storage.projectChatOperations.create({
      id: "foreign-run", thread_id: "thread-stale", project_id: "project-1", user_id: "user-1",
      kind: "schedule_run", status: "pending", entity_type: "schedule_run", entity_id: "foreign-run-id",
      idempotency_key: "foreign-run-key", payload: { version: 1, kind: "schedule_run", operationId: "foreign-run",
        status: "pending", scheduleId: "foreign-schedule", runId: "foreign-run-id" }, error: null,
    });
    await storage.projectChatOperations.create({
      id: "revoked-create", thread_id: "thread-stale", project_id: "project-1", user_id: "user-1",
      kind: "agent_session_create", status: "pending", entity_type: "agent_session", entity_id: "revoked-session",
      idempotency_key: "revoked-key", payload: { version: 1, kind: "agent_session_create", operationId: "revoked-create",
        status: "pending", sessionId: "revoked-session", workspaceId: JSON.stringify(["revoked-server", "dev"]),
        target: "revoked-server", branch: "dev", instruction: "No", permissionMode: "edit", agentType: "claude-code",
        model: null, initialInstructionDelivery: "pending" }, error: null,
    });
    const touch = vi.spyOn(storage.projectChatContextRefs, "touchMany");
    const createAgentSession = vi.fn(async ({ sessionId }) => ({ sessionId }));
    const manager = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(), toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => false },
        mutationServices: { createAgentSession, sendAgentInstruction: async () => true, runScheduleNow: async (_id, runId) => ({ runId, skipped: false }) },
      },
    });
    await manager.ready();
    expect(touch).not.toHaveBeenCalled();
    expect(createAgentSession).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it("defers raced schedule events until context is confirmed, then applies current and later status", async () => {
    await createThread("thread-schedule-gate");
    await storage.scheduledTasks.create({
      id: "gated-schedule", project_id: "project-1", name: "Run", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
    });
    await storage.projectChatOperations.create({
      id: "gated-op", thread_id: "thread-schedule-gate", project_id: "project-1", user_id: "user-1",
      kind: "schedule_run", status: "pending", entity_type: "schedule_run", entity_id: "gated-run",
      idempotency_key: "gated-run", payload: { version: 1, kind: "schedule_run", operationId: "gated-op",
        status: "pending", scheduleId: "gated-schedule", runId: "gated-run", contextConfirmed: false }, error: null,
    });
    const eventBus = new EventBus();
    const runScheduleNow = vi.fn(async (scheduleId, runId) => {
      await storage.scheduledTaskRuns.create({ id: runId, schedule_id: scheduleId, status: "running" });
      eventBus.emit({ type: "schedule:run-started", projectId: "project-1", scheduleId, runId });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await storage.projectChatOperations.getById(
        "gated-op", "thread-schedule-gate", "project-1", "user-1",
      ))?.status).toBe("pending");
      return { runId, skipped: false } as const;
    });
    const manager = new ProjectChatManager(storage, reply("unused"), {
      eventBus, toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => false },
        mutationServices: { createAgentSession: async ({ sessionId }) => ({ sessionId }), sendAgentInstruction: async () => true, runScheduleNow },
      },
    });

    await manager.ready();
    expect(await storage.projectChatOperations.getById(
      "gated-op", "thread-schedule-gate", "project-1", "user-1",
    )).toMatchObject({ status: "running", payload: { contextConfirmed: true } });
    await storage.scheduledTaskRuns.finish("gated-run", { status: "completed", exit_code: 0 });
    eventBus.emit({
      type: "schedule:run-finished", projectId: "project-1", scheduleId: "gated-schedule",
      runId: "gated-run", status: "completed", exitCode: 0,
    });
    await waitFor(async () => (await storage.projectChatOperations.getById(
      "gated-op", "thread-schedule-gate", "project-1", "user-1",
    ))?.status === "completed");
    expect((await storage.projectChatMessages.listByThread(
      "thread-schedule-gate", "project-1", "user-1",
    )).filter(({ type }) => type === "operation")).toHaveLength(2);
    await manager.shutdown();
  });

  it("persists same-running session delivery confirmation and does not resend after restart", async () => {
    await createThread("thread-running-confirm");
    await storage.agentSessions.create({ id: "running-confirm-session", project_id: "project-1", branch: "dev" });
    const payload = {
      version: 1 as const, kind: "agent_session_create" as const, operationId: "running-confirm-op",
      status: "pending" as const, sessionId: "running-confirm-session",
      workspaceId: JSON.stringify(["local", "dev"]), target: "local", branch: "dev",
      instruction: "Deliver", permissionMode: "edit", agentType: "claude-code", model: null,
      initialInstructionDelivery: "pending" as const,
    };
    const operation = await storage.projectChatOperations.create({
      id: "running-confirm-op", thread_id: "thread-running-confirm", project_id: "project-1", user_id: "user-1",
      kind: "agent_session_create", status: "pending", entity_type: "agent_session",
      entity_id: "running-confirm-session", idempotency_key: "running-confirm-key", payload, error: null,
    });
    await storage.projectChatOperations.transition({
      id: operation!.id, thread_id: "thread-running-confirm", project_id: "project-1", user_id: "user-1",
      status: "running", payload: { ...payload, status: "running" }, error: null,
      message: { id: "operation:running-confirm-op:running", content: JSON.stringify({ status: "running" }) },
    });
    const createAgentSession = vi.fn(async ({ sessionId }) => ({ sessionId }));
    const dependencies = {
      agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => true },
      mutationServices: { createAgentSession, sendAgentInstruction: async () => true,
        runScheduleNow: async (_id: string, runId: string) => ({ runId, skipped: false } as const) },
    };
    const first = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(), toolDependencies: dependencies,
    });
    await first.ready();
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(await storage.projectChatOperations.getById(
      "running-confirm-op", "thread-running-confirm", "project-1", "user-1",
    )).toMatchObject({ status: "running", payload: { initialInstructionDelivery: "confirmed" } });
    await first.shutdown();

    createAgentSession.mockClear();
    const restarted = new ProjectChatManager(storage, reply("unused"), {
      eventBus: new EventBus(), toolDependencies: dependencies,
    });
    await restarted.ready();
    expect(createAgentSession).not.toHaveBeenCalled();
    expect((await storage.projectChatMessages.listByThread(
      "thread-running-confirm", "project-1", "user-1",
    )).filter(({ type }) => type === "operation")).toHaveLength(1);
    await restarted.shutdown();
  });

  it("confirms context on an already-running schedule operation before accepting its terminal event", async () => {
    await createThread("thread-running-schedule");
    await storage.scheduledTasks.create({
      id: "running-schedule", project_id: "project-1", name: "Run", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
    });
    await storage.scheduledTaskRuns.create({ id: "running-run", schedule_id: "running-schedule", status: "running" });
    const pendingPayload = { version: 1 as const, kind: "schedule_run" as const, operationId: "running-run-op",
      status: "pending" as const, scheduleId: "running-schedule", runId: "running-run", contextConfirmed: false };
    await storage.projectChatOperations.create({
      id: "running-run-op", thread_id: "thread-running-schedule", project_id: "project-1", user_id: "user-1",
      kind: "schedule_run", status: "pending", entity_type: "schedule_run", entity_id: "running-run",
      idempotency_key: "running-run", payload: pendingPayload, error: null,
    });
    await storage.projectChatOperations.transition({
      id: "running-run-op", thread_id: "thread-running-schedule", project_id: "project-1", user_id: "user-1",
      status: "running", payload: { ...pendingPayload, status: "running" }, error: null,
      message: { id: "operation:running-run-op:running", content: JSON.stringify({ status: "running" }) },
    });
    const eventBus = new EventBus();
    const manager = new ProjectChatManager(storage, reply("unused"), { eventBus });
    await manager.ready();
    expect(await storage.projectChatOperations.getById(
      "running-run-op", "thread-running-schedule", "project-1", "user-1",
    )).toMatchObject({ status: "running", payload: { contextConfirmed: true } });

    await storage.scheduledTaskRuns.finish("running-run", { status: "completed", exit_code: 0 });
    eventBus.emit({ type: "schedule:run-finished", projectId: "project-1", scheduleId: "running-schedule",
      runId: "running-run", status: "completed", exitCode: 0 });
    await waitFor(async () => (await storage.projectChatOperations.getById(
      "running-run-op", "thread-running-schedule", "project-1", "user-1",
    ))?.status === "completed");
    await manager.shutdown();
  });

  it("fails the turn when the production fullStream adapter receives an error part", async () => {
    await createThread("thread-stream-error");
    const runner: ProjectChatModelRunner = {
      run: (input) => adaptProjectChatFullStream(streamParts([
        { type: "text-delta", text: "partial" },
        { type: "error", error: new Error(`provider-${"x".repeat(2_000)}`) },
      ]), input.signal),
    };
    const manager = new ProjectChatManager(storage, runner);

    await manager.sendMessage("thread-stream-error", "user-1", "go");
    await waitFor(async () => (await manager.openThread("thread-stream-error", "user-1")).status === "idle");
    const messages = await storage.projectChatMessages.listByThread(
      "thread-stream-error", "project-1", "user-1",
    );

    expect(messages.map((message) => message.type)).toEqual(["user", "assistant", "error", "turn_end"]);
    expect(messages.find((message) => message.type === "error")!.content.length).toBeLessThanOrEqual(513);
    expect(JSON.parse(messages.at(-1)!.content)).toEqual(expect.objectContaining({ status: "error" }));
  });

  it("preserves provider order and handles explicit abort parts", async () => {
    const signal = new AbortController().signal;
    const ordered: ProjectChatStreamEvent[] = [];
    for await (const event of adaptProjectChatFullStream(streamParts([
      { type: "text-delta", text: "before" },
      { type: "tool-call", toolCallId: "call-1", toolName: "inspect", input: {} },
      { type: "tool-result", toolCallId: "call-1", toolName: "inspect", output: { ok: true } },
      { type: "text-delta", text: "after" },
    ]), signal)) ordered.push(event);
    expect(ordered.map((event) => [event.type, event.content.includes("before") ? "before" : event.content.includes("after") ? "after" : "tool"]))
      .toEqual([
        ["assistant", "before"], ["tool_use", "tool"], ["tool_result", "tool"], ["assistant", "after"],
      ]);

    const controller = new AbortController();
    controller.abort();
    const aborted: ProjectChatStreamEvent[] = [];
    for await (const event of adaptProjectChatFullStream(streamParts([{ type: "abort" }]), controller.signal)) {
      aborted.push(event);
    }
    expect(aborted).toEqual([]);
  });

  it("enforces one race-safe call budget across parallel adapted tools", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const domain = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`tool_${index}`, {
      description: "bounded",
      inputSchema: { parse: (value: unknown) => value },
      execute,
    }])) as never;
    const adapted = projectChatAiTools(domain);

    const settled = await Promise.allSettled(Object.values(adapted).map((entry, index) =>
      (entry as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> })
        .execute({}, { toolCallId: `call-${index}`, messages: [] })));

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(8);
  });

  it("rejects cumulative adapted tool results beyond the turn byte budget", async () => {
    const result = { payload: "x".repeat(40_000) };
    const domain = Object.fromEntries(["one", "two"].map((name) => [name, {
      description: "large",
      inputSchema: { parse: (value: unknown) => value },
      execute: async () => result,
    }])) as never;
    const adapted = projectChatAiTools(domain);
    const calls = Object.values(adapted).map((entry, index) =>
      (entry as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> })
        .execute({}, { toolCallId: `large-${index}`, messages: [] }));

    const settled = await Promise.allSettled(calls);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("result byte budget");
    expect(String(rejected.reason).length).toBeLessThan(200);
  });

  it("binds authorized read tools to the production runner input without changing the fake runner seam", async () => {
    await createThread("thread-1");
    await storage.tasks.create({ id: "task-1", project_id: "project-1", title: "Inspect me" });
    const runner: ProjectChatModelRunner = {
      async *run(input) {
        expect(Object.keys(input.tools ?? {}).sort()).toEqual([
          "create_agent_session", "create_task", "get_agent_session", "get_project_summary", "get_schedule_run", "get_task",
          "list_agent_sessions", "list_schedule_runs", "list_schedules", "list_tasks", "list_workspaces",
          "run_schedule_now", "select_workspace", "send_agent_instruction", "update_task",
        ]);
        const result = await input.tools!.get_task.execute({ taskId: "task-1" });
        yield { type: "tool_use", content: JSON.stringify({ toolName: "get_task", input: { taskId: "task-1" } }) };
        yield { type: "tool_result", content: JSON.stringify({ toolName: "get_task", output: result }) };
        yield { type: "assistant", content: "I inspected the task." };
      },
    };
    const manager = new ProjectChatManager(storage, runner, {
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => false },
        mutationServices: {
          createAgentSession: async ({ sessionId }) => ({ sessionId }),
          sendAgentInstruction: async () => true,
          runScheduleNow: async (_scheduleId, runId) => ({ runId, skipped: false }),
        },
      },
    });
    await manager.openThread("thread-1", "user-1");
    const frames: Array<{ JsonPatch?: Array<{ path: string; value?: { content?: unknown } }> }> = [];
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1,
      send(raw: string) { frames.push(JSON.parse(raw)); },
    } as never);
    frames.length = 0;

    await manager.sendMessage("thread-1", "user-1", "inspect task");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    const messages = await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
    expect(messages.map((message) => message.type)).toEqual(["user", "tool_use", "tool_result", "assistant", "turn_end"]);
    expect(await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1"))
      .toContainEqual(expect.objectContaining({ entity_type: "task", entity_id: "task-1" }));
    expect(frames.flatMap(({ JsonPatch }) => JsonPatch ?? [])).toContainEqual(expect.objectContaining({
      op: "replace", path: "/contextRefs",
      value: expect.objectContaining({ type: "CONTEXT" }),
    }));
  });

  it("does not fail an accepted turn when the live Context projection temporarily cannot refresh", async () => {
    await createThread("thread-context-failure");
    const manager = new ProjectChatManager(storage, reply("reply survived"));
    await manager.openThread("thread-context-failure", "user-1");
    vi.spyOn(storage.projectChatContextRefs, "listByThread")
      .mockRejectedValue(new Error("context read unavailable"));

    await manager.sendMessage("thread-context-failure", "user-1", "continue");
    await waitFor(async () => (await storage.projectChatWorkItems.listNonterminal(
      "thread-context-failure", "project-1", "user-1",
    )).length === 0);

    expect((await storage.projectChatMessages.listByThread(
      "thread-context-failure", "project-1", "user-1",
    )).map(({ type, content }) => ({ type, content }))).toEqual([
      { type: "user", content: "continue" },
      { type: "assistant", content: "reply survived" },
      { type: "turn_end", content: JSON.stringify({ status: "completed" }) },
    ]);
    await manager.shutdown();
  });

  it("does not refresh Context for ordinary transcript events", async () => {
    await createThread("thread-no-context-refresh");
    const resolveExisting = vi.spyOn(storage.projectChatContextRefs, "resolveExisting");
    const manager = new ProjectChatManager(storage, {
      async *run() {
        yield { type: "assistant", content: "one" } as const;
        yield { type: "assistant", content: "two" } as const;
      },
    });
    await manager.openThread("thread-no-context-refresh", "user-1");
    resolveExisting.mockClear();

    await manager.sendMessage("thread-no-context-refresh", "user-1", "continue");
    await waitFor(async () => (await storage.projectChatWorkItems.listNonterminal(
      "thread-no-context-refresh", "project-1", "user-1",
    )).length === 0);

    expect(resolveExisting).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it("coalesces Context refreshes and never lets an older projection replace a newer one", async () => {
    await createThread("thread-context-order");
    await storage.tasks.create({ id: "task-old", project_id: "project-1", title: "Old" });
    await storage.tasks.create({ id: "task-new", project_id: "project-1", title: "New" });
    await storage.projectChatContextRefs.touch(
      "thread-context-order", "project-1", "user-1", "task", "task-old",
    );
    const first = deferred<Array<{ entity_type: "task"; entity_id: string }>>();
    const original = storage.projectChatContextRefs.resolveExisting.bind(storage.projectChatContextRefs);
    let calls = 0;
    vi.spyOn(storage.projectChatContextRefs, "resolveExisting").mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) return first.promise;
      return original(...args);
    });
    const manager = new ProjectChatManager(storage, reply("unused"));
    // Hydration performs call 1; this open refresh is the delayed call 2.
    const opening = manager.openThread("thread-context-order", "user-1");
    await waitFor(() => calls === 2);
    await storage.projectChatContextRefs.touch(
      "thread-context-order", "project-1", "user-1", "task", "task-new",
    );
    const newerOpen = manager.openThread("thread-context-order", "user-1");
    first.resolve([{ entity_type: "task", entity_id: "task-old" }]);
    await Promise.all([opening, newerOpen]);

    expect((await manager.openThread("thread-context-order", "user-1")).contextRefs
      .map(({ entity_id }) => entity_id)).toEqual(["task-new", "task-old"]);
    expect(calls).toBeLessThanOrEqual(4);
    await manager.shutdown();
  });

  it("persists user, assistant, tool, and turn-end items monotonically before broadcasting", async () => {
    await createThread("thread-1");
    const runner: ProjectChatModelRunner = {
      async *run() {
        yield { type: "assistant", content: "working" };
        yield { type: "tool_use", content: JSON.stringify({ toolName: "inspect" }) };
        yield { type: "tool_result", content: JSON.stringify({ ok: true }) };
      },
    };
    const manager = new ProjectChatManager(storage, runner);
    await manager.openThread("thread-1", "user-1");
    const frames: unknown[] = [];
    const socket = {
      projectChatUserId: "user-1",
      readyState: 1,
      send(raw: string) {
        const frame = JSON.parse(raw) as {
          JsonPatch?: Array<{ path: string; value?: { content?: { sequence?: number } } }>;
        };
        const message = frame.JsonPatch
          ?.find((entry) => entry.path.startsWith("/messages/"))
          ?.value?.content;
        if (typeof message?.sequence === "number") {
          const persisted = storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
          frames.push(persisted.then((messages) => messages.some((item) => item.sequence === message.sequence)));
        }
      },
    };
    manager.subscribe("thread-1", socket as never);

    await manager.sendMessage("thread-1", "user-1", "go");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    const messages = await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
    expect(messages.map((message) => message.type)).toEqual([
      "user", "assistant", "tool_use", "tool_result", "turn_end",
    ]);
    expect(messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(frames).toHaveLength(5);
    await expect(Promise.all(frames)).resolves.not.toContain(false);
  });

  it("keeps journal rows private while public operation messages reach every chat surface", async () => {
    await createThread("thread-1");
    let secondInput: ProjectChatRunInput | undefined;
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        const current = input.messages.filter((message) => message.type === "user").at(-1)?.content;
        if (current === "first") {
          yield { type: "operation", content: JSON.stringify({ label: "Deploy", status: "running" }) };
        } else {
          secondInput = input;
          yield { type: "assistant", content: "done" };
        }
      },
    });
    await manager.openThread("thread-1", "user-1");
    const frames: string[] = [];
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1,
      send: (raw: string) => { frames.push(raw); },
    } as never);

    await manager.sendMessage("thread-1", "user-1", "first");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");
    await manager.sendMessage("thread-1", "user-1", "second");
    await waitFor(() => secondInput !== undefined);
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    const snapshot = await manager.openThread("thread-1", "user-1");
    const messages = await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    );
    const db = new Database(dbPath, { readonly: true });
    const workRows = db.prepare("SELECT id FROM project_chat_work_items ORDER BY created_at, id")
      .all() as Array<{ id: string }>;
    const workIds = workRows.map((row) => row.id);
    db.close();
    const publicSurfaces = JSON.stringify({ messages, snapshot, frames, model: secondInput!.messages });

    expect(messages).toContainEqual(expect.objectContaining({ type: "operation" }));
    expect(secondInput!.messages).toContainEqual(expect.objectContaining({ type: "operation" }));
    expect(frames.some((frame) => frame.includes('"operation"'))).toBe(true);
    for (const workId of workIds) expect(publicSurfaces).not.toContain(workId);
    expect(publicSurfaces).not.toContain("workId");
  });

  it("broadcasts mutation-tool operation and Context writes during the active turn", async () => {
    await createThread("live-tool-thread");
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        await input.tools!.create_task.execute({ title: "Live task" });
        yield { type: "assistant", content: "created" };
      },
    }, {
      eventBus: new EventBus(),
      toolDependencies: {
        agentSessionManager: { getMessages: () => [], getSessionProcessAlive: () => false },
        mutationServices: {
          createAgentSession: async ({ sessionId }) => ({ sessionId }),
          sendAgentInstruction: async () => true,
          runScheduleNow: async (_id, runId) => ({ runId, skipped: false }),
        },
      },
    });
    await manager.openThread("live-tool-thread", "user-1");
    const frames: string[] = [];
    manager.subscribe("live-tool-thread", {
      projectChatUserId: "user-1", readyState: 1,
      send: (raw: string) => { frames.push(raw); },
    } as never);

    await manager.sendMessage("live-tool-thread", "user-1", "create it");
    await waitFor(async () => (await manager.openThread("live-tool-thread", "user-1")).status === "idle");

    expect(frames.some((frame) => frame.includes('"type":"ENTRY"')
      && frame.includes('\\"kind\\":\\"task_create\\"'))).toBe(true);
    expect(frames.some((frame) => frame.includes('"type":"CONTEXT"')
      && frame.includes('"entity_type":"task"'))).toBe(true);
    const snapshot = await manager.openThread("live-tool-thread", "user-1");
    expect(snapshot.messages.some(({ type, content }) => type === "operation"
      && JSON.parse(content).kind === "task_create")).toBe(true);
    await manager.shutdown();
  });

  it("runs one turn at a time per thread and drains queued messages in order", async () => {
    await createThread("thread-1");
    const firstGate = deferred();
    const starts: string[] = [];
    const runner: ProjectChatModelRunner = {
      async *run(input) {
        const content = input.messages.at(-1)?.content ?? "";
        starts.push(content);
        if (content === "first") await firstGate.promise;
        yield { type: "assistant", content: `reply:${content}` };
      },
    };
    const manager = new ProjectChatManager(storage, runner);

    const first = manager.sendMessage("thread-1", "user-1", "first");
    await waitFor(() => starts.length === 1);
    const second = manager.sendMessage("thread-1", "user-1", "second");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).queueLength === 1);
    expect(starts).toEqual(["first"]);

    firstGate.resolve();
    await Promise.all([first, second]);
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    expect(starts).toEqual(["first", "second"]);
    const messages = await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
    expect(messages.filter((message) => message.type === "user").map((message) => message.content))
      .toEqual(["first", "second"]);
    expect(messages.map((message) => message.type)).not.toContain("operation");
    expect(JSON.stringify(messages)).not.toContain("workId");
  });

  it("stops only the requested thread while another thread continues", async () => {
    await createThread("thread-1");
    await createThread("thread-2");
    const secondGate = deferred();
    const runner: ProjectChatModelRunner = {
      async *run(input) {
        if (input.threadId === "thread-1") {
          await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("provider aborted");
        }
        await secondGate.promise;
        yield { type: "assistant", content: "thread two complete" };
      },
    };
    const manager = new ProjectChatManager(storage, runner);
    const first = manager.sendMessage("thread-1", "user-1", "one");
    const second = manager.sendMessage("thread-2", "user-1", "two");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");
    await waitFor(async () => (await manager.openThread("thread-2", "user-1")).status === "running");

    await expect(stopCurrent(manager, "thread-1")).resolves.toBe(true);
    expect((await manager.openThread("thread-2", "user-1")).status).toBe("running");

    secondGate.resolve();
    await Promise.all([first, second]);
    await waitFor(async () => (await manager.openThread("thread-2", "user-1")).status === "idle");
    expect((await storage.projectChatMessages.listByThread("thread-2", "project-1", "user-1"))
      .some((message) => message.content === "thread two complete")).toBe(true);
  });

  it("rejects a stale stop identity after queued work becomes the active turn", async () => {
    await createThread("thread-1");
    const starts: Array<{ content: string; signal: AbortSignal }> = [];
    const frames: Array<{ JsonPatch?: Array<{ path: string; value: { content: unknown } }> }> = [];
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        const content = input.messages.filter((message) => message.type === "user").at(-1)?.content ?? "";
        starts.push({ content, signal: input.signal });
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("provider aborted");
      },
    });
    await manager.openThread("thread-1", "user-1");
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1,
      send(raw: string) { frames.push(JSON.parse(raw)); },
    } as never);

    await manager.sendMessage("thread-1", "user-1", "first");
    await waitFor(() => starts.length === 1);
    const first = await manager.openThread("thread-1", "user-1");
    expect(first).toMatchObject({ status: "running" });
    expect(first.activeTurnId).toEqual(expect.any(String));
    expect(frames.flatMap((frame) => frame.JsonPatch ?? [])).toContainEqual(expect.objectContaining({
      path: "/activeTurnId", value: { type: "ACTIVE_TURN", content: first.activeTurnId },
    }));

    await manager.sendMessage("thread-1", "user-1", "second");
    await expect(manager.stopGeneration("thread-1", "user-1", first.activeTurnId!)).resolves.toBe(true);
    await waitFor(() => starts.length === 2);
    const second = await manager.openThread("thread-1", "user-1");
    expect(second).toMatchObject({ status: "running" });
    expect(second.activeTurnId).toEqual(expect.any(String));
    expect(second.activeTurnId).not.toBe(first.activeTurnId);
    expect(frames.flatMap((frame) => frame.JsonPatch ?? [])).toContainEqual(expect.objectContaining({
      path: "/activeTurnId", value: { type: "ACTIVE_TURN", content: second.activeTurnId },
    }));

    await expect(manager.stopGeneration("thread-1", "user-1", first.activeTurnId!))
      .rejects.toMatchObject({ code: "PROJECT_CHAT_ACTIVE_TURN_CONFLICT" });
    expect(starts[1].signal.aborted).toBe(false);

    await expect(manager.stopGeneration("thread-1", "user-1", second.activeTurnId!)).resolves.toBe(true);
    expect(starts[1].signal.aborted).toBe(true);
  });

  it("bounds stop for an abort-ignoring runner, terminalizes it, and starts queued work", async () => {
    await createThread("thread-1");
    const releaseFirst = deferred();
    const starts: string[] = [];
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        const current = input.messages.filter((message) => message.type === "user").at(-1)?.content ?? "";
        starts.push(current);
        if (current === "first") {
          await releaseFirst.promise;
          yield { type: "assistant", content: "stale first output" };
          return;
        }
        yield { type: "assistant", content: "second output" };
      },
    }, { drainTimeoutMs: 20 });
    await manager.sendMessage("thread-1", "user-1", "first");
    await waitFor(() => starts.length === 1);
    await manager.sendMessage("thread-1", "user-1", "second");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).queueLength === 1);

    const stopped = await Promise.race([
      stopCurrent(manager, "thread-1"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    expect(stopped).toBe(true);
    await waitFor(() => starts.length === 2);
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");
    releaseFirst.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const messages = await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    );
    expect(starts).toEqual(["first", "second"]);
    expect(messages.some((message) => message.content === "stale first output")).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({ type: "assistant", content: "second output" }));
    expect(messages.filter((message) => message.type === "turn_end").map((message) => message.content))
      .toContain(JSON.stringify({ status: "stopped" }));
    expect(await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    )).toEqual([]);
  });

  it.each(["stalled", "rejected"] as const)(
    "bounds stop when detached terminal persistence is %s",
    async (failure) => {
      await createThread("thread-1");
      const releaseRunner = deferred();
      const manager = new ProjectChatManager(storage, {
        async *run() {
          await releaseRunner.promise;
          yield { type: "assistant", content: "stale output" };
        },
      }, { drainTimeoutMs: 20 });
      await manager.sendMessage("thread-1", "user-1", "work");
      await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");
      vi.spyOn(storage.projectChatWorkItems, "finish").mockImplementation(async () => {
        if (failure === "rejected") throw new Error("terminal failed");
        await new Promise<void>(() => undefined);
        throw new Error("unreachable");
      });

      const result = await Promise.race([
        stopCurrent(manager, "thread-1").then(() => "settled" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      expect(result).toBe("settled");
      expect((await manager.openThread("thread-1", "user-1")).status).toBe("idle");
      expect(await storage.projectChatWorkItems.listNonterminal(
        "thread-1", "project-1", "user-1",
      )).toHaveLength(1);
      releaseRunner.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await storage.projectChatMessages.listByThread(
        "thread-1", "project-1", "user-1",
      )).some((message) => message.content === "stale output")).toBe(false);
    },
  );

  it("starts queued work on a fresh write lane when the stopped append never settles", async () => {
    await createThread("thread-1");
    const staleAppendStarted = deferred();
    const releaseStaleAppend = deferred();
    const starts: string[] = [];
    const originalAppend = storage.projectChatWorkItems.appendEvent.bind(storage.projectChatWorkItems);
    vi.spyOn(storage.projectChatWorkItems, "appendEvent").mockImplementation(async (opts) => {
      if (opts.content === "stale append") {
        staleAppendStarted.resolve();
        await releaseStaleAppend.promise;
      }
      return originalAppend(opts);
    });
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        const current = input.messages.filter((message) => message.type === "user").at(-1)?.content ?? "";
        starts.push(current);
        yield { type: "assistant", content: current === "first" ? "stale append" : "second output" };
      },
    }, { drainTimeoutMs: 20 });
    await manager.sendMessage("thread-1", "user-1", "first");
    await staleAppendStarted.promise;
    await manager.sendMessage("thread-1", "user-1", "second");

    await stopCurrent(manager, "thread-1");
    await waitFor(() => starts.length === 2);
    await waitFor(async () => (await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    )).some((message) => message.content === "second output"));

    releaseStaleAppend.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    )).some((message) => message.content === "stale append")).toBe(false);
  });

  it.each(["stop", "delete"] as const)(
    "releases a global turn slot exactly once when %s detaches an abort-ignoring runner",
    async (action) => {
      for (const id of ["slot-one", "slot-two", "slot-three"]) await createThread(id);
      const firstGate = deferred();
      const secondGate = deferred();
      const starts: string[] = [];
      const manager = new ProjectChatManager(storage, {
        async *run(input) {
          starts.push(input.threadId);
          if (input.threadId === "slot-one") await firstGate.promise;
          if (input.threadId === "slot-two") await secondGate.promise;
          yield { type: "assistant", content: input.threadId };
        },
      }, { maxConcurrentTurns: 1, drainTimeoutMs: 12 });
      await manager.sendMessage("slot-one", "user-1", "one");
      await waitFor(() => starts.length === 1);
      await manager.sendMessage("slot-two", "user-1", "two");

      if (action === "stop") {
        await stopCurrent(manager, "slot-one");
      } else {
        await manager.deleteThread("slot-one", "user-1");
      }
      await waitFor(() => starts.includes("slot-two"));
      await manager.sendMessage("slot-three", "user-1", "three");

      firstGate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(starts).toEqual(["slot-one", "slot-two"]);

      secondGate.resolve();
      await waitFor(() => starts.includes("slot-three"));
      expect(starts).toEqual(["slot-one", "slot-two", "slot-three"]);
      await manager.shutdown();
    },
  );

  it("does not exhaust the default four global slots after four turns are detached", async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `default-slot-${index}`);
    for (const id of ids) await createThread(id);
    const gates = new Map(ids.map((id) => [id, deferred()]));
    const starts: string[] = [];
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        starts.push(input.threadId);
        await gates.get(input.threadId)!.promise;
        yield { type: "assistant", content: input.threadId };
      },
    }, { drainTimeoutMs: 12 });
    for (const id of ids) await manager.sendMessage(id, "user-1", id);
    await waitFor(() => starts.length === 4);

    await Promise.all(ids.slice(0, 4).map((id) => stopCurrent(manager, id)));
    await waitFor(() => starts.length === 8);

    expect(new Set(starts)).toEqual(new Set(ids));
    for (const gate of gates.values()) gate.resolve();
    await manager.shutdown();
  });

  it("executes two threads in one project independently", async () => {
    await createThread("thread-1");
    await createThread("thread-2");
    const gates = new Map([["thread-1", deferred()], ["thread-2", deferred()]]);
    const running = new Set<string>();
    const runner: ProjectChatModelRunner = {
      async *run(input) {
        running.add(input.threadId);
        await gates.get(input.threadId)!.promise;
        yield { type: "assistant", content: input.threadId };
      },
    };
    const manager = new ProjectChatManager(storage, runner);
    const one = manager.sendMessage("thread-1", "user-1", "one");
    const two = manager.sendMessage("thread-2", "user-1", "two");
    await waitFor(() => running.size === 2);
    expect([...running].sort()).toEqual(["thread-1", "thread-2"]);
    gates.get("thread-1")!.resolve();
    gates.get("thread-2")!.resolve();
    await Promise.all([one, two]);
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");
    await waitFor(async () => (await manager.openThread("thread-2", "user-1")).status === "idle");
  });

  it("restores the complete transcript after a simulated process restart", async () => {
    await createThread("thread-1");
    const firstManager = new ProjectChatManager(storage, reply("persisted reply"));
    await firstManager.sendMessage("thread-1", "user-1", "persist me");
    await waitFor(async () => (await firstManager.openThread("thread-1", "user-1")).status === "idle");
    await firstManager.shutdown();

    const secondManager = new ProjectChatManager(storage, reply("unused"));
    const snapshot = await secondManager.openThread("thread-1", "user-1");

    expect(snapshot.messages.map((message) => message.content)).toEqual([
      "persist me", "persisted reply", expect.stringContaining("completed"),
    ]);
  });

  it("rejects every user-scoped operation for another user's thread", async () => {
    await storage.projects.create({ id: "private-project", name: "Private", path: "/tmp/private" }, "user-2");
    await createThread("private", "user-2", "private-project");
    const manager = new ProjectChatManager(storage, reply("must not run"));

    await manager.openThread("private", "user-2");

    await expect(manager.openThread("private", "user-1")).rejects.toMatchObject({ code: "PROJECT_CHAT_NOT_FOUND" });
    await expect(manager.sendMessage("private", "user-1", "steal")).rejects.toMatchObject({ code: "PROJECT_CHAT_NOT_FOUND" });
    await expect(manager.stopGeneration("private", "user-1", "unobserved-turn")).resolves.toBe(false);
    await expect(manager.resolveToolApproval("private", "user-1", "approval", true)).resolves.toBe(false);
    expect(manager.subscribe("private", { projectChatUserId: "user-1", send: vi.fn() } as never)).toBeNull();
  });

  it("aborts and settles active work during shutdown", async () => {
    await createThread("thread-1");
    let aborted = false;
    const runner: ProjectChatModelRunner = {
      async *run(input: ProjectChatRunInput): AsyncGenerator<ProjectChatStreamEvent> {
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true }));
      },
    };
    const manager = new ProjectChatManager(storage, runner);
    const turn = manager.sendMessage("thread-1", "user-1", "work");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");

    await manager.shutdown();
    await turn;

    expect(aborted).toBe(true);
    expect((await manager.openThread("thread-1", "user-1")).status).toBe("idle");
  });

  it("bounds shutdown when a runner ignores abort and fences its late output", async () => {
    await createThread("thread-1");
    const releaseRunner = deferred();
    const manager = new ProjectChatManager(storage, {
      async *run() {
        await releaseRunner.promise;
        yield { type: "assistant", content: "too late" };
      },
    }, { drainTimeoutMs: 20 });
    await manager.sendMessage("thread-1", "user-1", "work");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");

    const shutdown = manager.shutdown();
    const bounded = await Promise.race([
      shutdown.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (!bounded) {
      releaseRunner.resolve();
      await shutdown;
    }

    expect(bounded).toBe(true);
    releaseRunner.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const messages = await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    );
    expect(messages.map((message) => message.type)).toEqual(["user"]);
    expect(messages.some((message) => message.content === "too late")).toBe(false);
    expect(await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    )).toHaveLength(1);
  });

  it.each(["stalled", "rejected"] as const)(
    "bounds shutdown when detached-work reset is %s",
    async (failure) => {
      await createThread("thread-1");
      const releaseRunner = deferred();
      const manager = new ProjectChatManager(storage, {
        async *run() { await releaseRunner.promise; },
      }, { drainTimeoutMs: 20 });
      await manager.sendMessage("thread-1", "user-1", "work");
      await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");
      vi.spyOn(storage.projectChatWorkItems, "markAccepted").mockImplementation(async () => {
        if (failure === "rejected") throw new Error("reset failed");
        await new Promise<void>(() => undefined);
        return undefined;
      });

      const result = await Promise.race([
        manager.shutdown().then(() => "settled" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      expect(result).toBe("settled");
      expect(await storage.projectChatWorkItems.listNonterminal(
        "thread-1", "project-1", "user-1",
      )).toHaveLength(1);
      releaseRunner.resolve();
    },
  );

  it("fences an append paused before storage even when shutdown reset stalls", async () => {
    await createThread("thread-1");
    const appendStarted = deferred();
    const allowAppend = deferred();
    const originalAppend = storage.projectChatWorkItems.appendEvent.bind(storage.projectChatWorkItems);
    vi.spyOn(storage.projectChatWorkItems, "appendEvent").mockImplementation(async (opts) => {
      appendStarted.resolve();
      await allowAppend.promise;
      return originalAppend(opts);
    });
    vi.spyOn(storage.projectChatWorkItems, "markAccepted").mockImplementation(async () => {
      await new Promise<void>(() => undefined);
      return undefined;
    });
    const manager = new ProjectChatManager(storage, reply("must remain private"), { drainTimeoutMs: 20 });
    await manager.sendMessage("thread-1", "user-1", "work");
    await appendStarted.promise;

    await manager.shutdown();
    allowAppend.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    )).map((message) => message.type)).toEqual(["user"]);
  });

  it("fences an output append already awaiting storage when shutdown detaches", async () => {
    await createThread("thread-1");
    const appendStarted = deferred();
    const allowAppend = deferred();
    const originalAppendEvent = storage.projectChatWorkItems.appendEvent.bind(storage.projectChatWorkItems);
    vi.spyOn(storage.projectChatWorkItems, "appendEvent").mockImplementation(async (opts) => {
      if (opts.type === "assistant") {
        appendStarted.resolve();
        await allowAppend.promise;
      }
      return originalAppendEvent(opts);
    });
    const frames: string[] = [];
    const manager = new ProjectChatManager(storage, reply("late append"), { drainTimeoutMs: 20 });
    await manager.openThread("thread-1", "user-1");
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1,
      send: (raw: string) => { frames.push(raw); },
    } as never);
    await manager.sendMessage("thread-1", "user-1", "work");
    const usedWorkScopedAppend = await Promise.race([
      appendStarted.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(usedWorkScopedAppend).toBe(true);

    await manager.shutdown();
    const holdRecoveredRunner = deferred();
    const recoveredManager = new ProjectChatManager(storage, {
      async *run() {
        await holdRecoveredRunner.promise;
      },
    }, { drainTimeoutMs: 20 });
    await recoveredManager.openThread("thread-1", "user-1");
    await waitFor(async () => (await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    ))[0]?.attempt === 2);

    allowAppend.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    )).map((message) => message.type)).toEqual(["user"]);
    expect(frames.some((frame) => frame.includes("late append"))).toBe(false);
    expect((await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    ))[0]).toMatchObject({ status: "running", attempt: 2 });
    holdRecoveredRunner.resolve();
    await recoveredManager.shutdown();
  });

  it("preserves transcript order when partially-written work is detached and recovered", async () => {
    await createThread("thread-1");
    const holdFirstRunner = deferred();
    const firstManager = new ProjectChatManager(storage, {
      async *run() {
        yield { type: "assistant", content: "partial" };
        await holdFirstRunner.promise;
      },
    }, { drainTimeoutMs: 20 });
    await firstManager.sendMessage("thread-1", "user-1", "work");
    await waitFor(async () => (await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    )).some((message) => message.content === "partial"));
    await firstManager.shutdown();

    let recoveredInput: ProjectChatRunInput | undefined;
    const recoveredManager = new ProjectChatManager(storage, {
      async *run(input) {
        recoveredInput = input;
        return;
      },
    });
    await recoveredManager.openThread("thread-1", "user-1");
    await waitFor(() => recoveredInput !== undefined);

    expect(recoveredInput!.messages.map((message) => [message.type, message.content]))
      .toEqual([["user", "work"], ["assistant", "partial"]]);
    holdFirstRunner.resolve();
    await recoveredManager.shutdown();
  });

  it("contains stopped-terminal persistence failure and leaves work recoverable", async () => {
    await createThread("thread-1");
    const finish = vi.spyOn(storage.projectChatWorkItems, "finish")
      .mockRejectedValue(new Error("terminal write failed"));
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
      },
    });
    await manager.sendMessage("thread-1", "user-1", "recover later");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");

    await stopCurrent(manager, "thread-1");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    )).toHaveLength(1);
    finish.mockRestore();
    const recovered: string[] = [];
    const nextManager = new ProjectChatManager(storage, {
      async *run(input) {
        recovered.push(input.messages.at(-1)?.content ?? "");
        yield { type: "assistant", content: "recovered" };
      },
    });
    await nextManager.openThread("thread-1", "user-1");
    await waitFor(() => recovered.length === 1);
  });

  it("retries a transient terminal failure while subscribers still observe running", async () => {
    await createThread("thread-1");
    const originalFinish = storage.projectChatWorkItems.finish.bind(storage.projectChatWorkItems);
    const firstFailure = deferred();
    let finishCalls = 0;
    vi.spyOn(storage.projectChatWorkItems, "finish").mockImplementation(async (opts) => {
      finishCalls++;
      if (finishCalls === 1) {
        firstFailure.resolve();
        throw new Error("transient terminal failure");
      }
      return originalFinish(opts);
    });
    const run = vi.fn(reply("model result").run);
    const manager = new ProjectChatManager(storage, { run }, {
      terminalRetryDelayMs: 20,
      terminalRetryAttempts: 3,
    });
    await manager.openThread("thread-1", "user-1");
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1, send: vi.fn(),
    } as never);

    await manager.sendMessage("thread-1", "user-1", "retry terminal");
    await firstFailure.promise;
    expect((await manager.openThread("thread-1", "user-1")).status).toBe("running");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    expect(finishCalls).toBe(2);
    expect(run).toHaveBeenCalledOnce();
    expect(await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    )).toEqual([]);
    const messages = await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    );
    expect(messages.map((message) => message.type)).toEqual(["user", "assistant", "turn_end"]);
  });

  it("bounds persistent terminal retries without rerunning the model or spinning", async () => {
    await createThread("thread-1");
    const finish = vi.spyOn(storage.projectChatWorkItems, "finish")
      .mockRejectedValue(new Error("terminal unavailable"));
    const run = vi.fn(reply("model result").run);
    const manager = new ProjectChatManager(storage, { run }, {
      terminalRetryDelayMs: 1,
      terminalRetryAttempts: 3,
    });
    await manager.openThread("thread-1", "user-1");
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1, send: vi.fn(),
    } as never);

    await manager.sendMessage("thread-1", "user-1", "retry terminal");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(finish).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledOnce();
    expect(await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    )).toHaveLength(1);
    expect((await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    )).map((message) => message.type)).toEqual(["user", "assistant"]);
  });

  it("times out a stalled terminal attempt and retries without releasing the runner", async () => {
    await createThread("thread-1");
    const firstStarted = deferred();
    const originalFinish = storage.projectChatWorkItems.finish.bind(storage.projectChatWorkItems);
    let calls = 0;
    vi.spyOn(storage.projectChatWorkItems, "finish").mockImplementation(async (opts) => {
      calls++;
      if (calls === 1) {
        firstStarted.resolve();
        await new Promise<void>(() => undefined);
      }
      return originalFinish(opts);
    });
    const run = vi.fn(reply("model result").run);
    const manager = new ProjectChatManager(storage, { run }, {
      terminalRetryDelayMs: 1,
      terminalRetryAttempts: 3,
      terminalAttemptTimeoutMs: 20,
    });
    await manager.sendMessage("thread-1", "user-1", "retry stalled terminal");
    await firstStarted.promise;

    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    expect(calls).toBe(2);
    expect(run).toHaveBeenCalledOnce();
    expect((await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    )).map((message) => message.type)).toEqual(["user", "assistant", "turn_end"]);
  });

  it("fences terminal attempts released only after retry exhaustion", async () => {
    await createThread("thread-1");
    const releaseFinishes = deferred();
    const originalFinish = storage.projectChatWorkItems.finish.bind(storage.projectChatWorkItems);
    const finish = vi.spyOn(storage.projectChatWorkItems, "finish").mockImplementation(async (opts) => {
      await releaseFinishes.promise;
      return originalFinish(opts);
    });
    const manager = new ProjectChatManager(storage, reply("model result"), {
      terminalRetryDelayMs: 1,
      terminalRetryAttempts: 2,
      terminalAttemptTimeoutMs: 10,
    });
    await manager.sendMessage("thread-1", "user-1", "exhaust terminal");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    expect(finish).toHaveBeenCalledTimes(2);
    releaseFinishes.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await storage.projectChatMessages.listByThread(
      "thread-1", "project-1", "user-1",
    )).map((message) => message.type)).toEqual(["user", "assistant"]);
    expect((await manager.openThread("thread-1", "user-1")).messages.map((message) => message.type))
      .toEqual(["user", "assistant"]);
    expect(await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    )).toHaveLength(1);
  });

  it("reconciles a retry when the first terminal commit succeeded but its response failed", async () => {
    await createThread("thread-1");
    const originalFinish = storage.projectChatWorkItems.finish.bind(storage.projectChatWorkItems);
    let first = true;
    const finish = vi.spyOn(storage.projectChatWorkItems, "finish").mockImplementation(async (opts) => {
      const result = await originalFinish(opts);
      if (first) {
        first = false;
        throw new Error("response lost after commit");
      }
      return result;
    });
    const manager = new ProjectChatManager(storage, reply("model result"), {
      terminalRetryDelayMs: 1,
      terminalRetryAttempts: 3,
    });
    await manager.openThread("thread-1", "user-1");

    await manager.sendMessage("thread-1", "user-1", "retry committed terminal");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    expect(finish).toHaveBeenCalledTimes(2);
    expect((await manager.openThread("thread-1", "user-1")).messages.map((message) => message.type))
      .toEqual(["user", "assistant", "turn_end"]);
  });

  it("reconciles stop with a normal terminal write already stalled at detach", async () => {
    await createThread("thread-1");
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const originalFinish = storage.projectChatWorkItems.finish.bind(storage.projectChatWorkItems);
    let calls = 0;
    vi.spyOn(storage.projectChatWorkItems, "finish").mockImplementation(async (opts) => {
      calls++;
      if (calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        return originalFinish(opts);
      }
      if (calls === 2) {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
      return originalFinish(opts);
    });
    const manager = new ProjectChatManager(storage, reply("model result"), { drainTimeoutMs: 20 });
    await manager.sendMessage("thread-1", "user-1", "stop finishing");
    await firstStarted.promise;

    const stopping = stopCurrent(manager, "thread-1");
    await secondStarted.promise;
    releaseFirst.resolve();
    releaseSecond.resolve();
    await expect(stopping).resolves.toBe(true);

    expect((await manager.openThread("thread-1", "user-1")).messages
      .filter((message) => message.type === "turn_end")).toHaveLength(1);
  });

  it("recovers a first idle turn after acceptance and a crash before terminal persistence", async () => {
    await createThread("thread-1");
    const firstManager = new ProjectChatManager(storage, {
      async *run() {
        await new Promise<void>(() => undefined);
      },
    });
    await firstManager.sendMessage("thread-1", "user-1", "recover first");
    await waitFor(async () => (await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    )).some((work) => work.status === "running"));

    const restoredStarts: string[] = [];
    const secondManager = new ProjectChatManager(storage, {
      async *run(input) {
        restoredStarts.push(input.messages.at(-1)?.content ?? "");
        yield { type: "assistant", content: "restored reply" };
      },
    });
    await secondManager.openThread("thread-1", "user-1");
    await waitFor(() => restoredStarts.includes("recover first"));
    await waitFor(async () => (await secondManager.openThread("thread-1", "user-1")).status === "idle");

    expect((await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1"))
      .filter((message) => message.type === "user").map((message) => message.content))
      .toEqual(["recover first"]);
    expect(await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    )).toEqual([]);
  });

  it.each(["accepted", "running"] as const)(
    "resumes %s journal work without duplicating its user message",
    async (status) => {
    await createThread("thread-1");
    await storage.projectChatWorkItems.accept({
      id: "work-crash", user_message_id: "user-crash", thread_id: "thread-1",
      project_id: "project-1", user_id: "user-1", content: "recover me",
    });
    if (status === "running") {
      await storage.projectChatWorkItems.markRunning(
        "work-crash", "thread-1", "project-1", "user-1",
      );
    }
    const starts: string[] = [];
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        starts.push(input.messages.at(-1)?.content ?? "");
        yield { type: "assistant", content: "recovered reply" };
      },
    });

    await manager.openThread("thread-1", "user-1");
    await waitFor(() => starts.length === 1);
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    const messages = await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
    expect(starts).toEqual(["recover me"]);
    expect(messages.filter((message) => message.type === "user" && message.content === "recover me")).toHaveLength(1);
    expect(messages).toContainEqual(expect.objectContaining({ type: "assistant", content: "recovered reply" }));
    expect(messages).toContainEqual(expect.objectContaining({
      type: "turn_end",
      content: JSON.stringify({ status: "completed" }),
    }));
    expect(messages.map((message) => message.type)).not.toContain("operation");
  });

  it("preserves user-before-partial-output order when recovering running work", async () => {
    await createThread("thread-1");
    await storage.projectChatWorkItems.accept({
      id: "partial-work", user_message_id: "partial-user", thread_id: "thread-1",
      project_id: "project-1", user_id: "user-1", content: "start work",
    });
    await storage.projectChatWorkItems.markRunning(
      "partial-work", "thread-1", "project-1", "user-1",
    );
    await storage.projectChatMessages.append({
      id: "partial-assistant", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
      sequence: 2, type: "assistant", content: "partial output",
    });
    let recoveredInput: ProjectChatRunInput | undefined;
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        recoveredInput = input;
        yield { type: "assistant", content: "finished" };
      },
    });

    await manager.openThread("thread-1", "user-1");
    await waitFor(() => recoveredInput !== undefined);

    expect(recoveredInput!.messages.map(({ type, content }) => ({ type, content }))).toEqual([
      { type: "user", content: "start work" },
      { type: "assistant", content: "partial output" },
    ]);
  });

  it("does not rerun journal work after its atomic terminal transition", async () => {
    await createThread("thread-1");
    await storage.projectChatWorkItems.accept({
      id: "work-done", user_message_id: "user-done", thread_id: "thread-1",
      project_id: "project-1", user_id: "user-1", content: "done",
    });
    const running = await storage.projectChatWorkItems.markRunning(
      "work-done", "thread-1", "project-1", "user-1",
    );
    await storage.projectChatWorkItems.finish({
      id: "work-done", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
      attempt: running!.attempt,
      status: "completed", error: null, turn_end_id: "end-done",
      turn_end_content: JSON.stringify({ status: "completed", workId: "work-done" }),
    });
    const run = vi.fn(async function* () { yield { type: "assistant" as const, content: "duplicate" }; });
    const manager = new ProjectChatManager(storage, { run });

    const snapshot = await manager.openThread("thread-1", "user-1");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(run).not.toHaveBeenCalled();
    expect(snapshot.messages).toHaveLength(2);
  });

  it("delivers an approval decision back to the pending model turn", async () => {
    await createThread("thread-1");
    let decide!: (approved: boolean) => void;
    const manager = new ProjectChatManager(storage, {
      async *run() {
        const decision = new Promise<boolean>((resolve) => { decide = resolve; });
        yield {
          type: "tool_approval_request",
          content: JSON.stringify({ approvalId: "approval-1" }),
          approvalId: "approval-1",
          resolveApproval: decide,
        } as never;
        yield { type: "assistant", content: (await decision) ? "approved" : "denied" };
      },
    });
    await manager.sendMessage("thread-1", "user-1", "do it");
    await waitFor(async () => (await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1"))
      .some((message) => message.type === "tool_approval_request"));

    await expect(manager.resolveToolApproval("thread-1", "user-1", "approval-1", false)).resolves.toBe(true);
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    expect((await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1"))
      .some((message) => message.type === "assistant" && message.content === "denied")).toBe(true);
  });

  it("registers an explicit approval id before broadcasting arbitrary request content", async () => {
    await createThread("thread-1");
    let decide!: (approved: boolean) => void;
    const manager = new ProjectChatManager(storage, {
      async *run() {
        const decision = new Promise<boolean>((resolve) => { decide = resolve; });
        yield {
          type: "tool_approval_request",
          content: "Allow this action?",
          approvalId: "explicit-approval",
          resolveApproval: decide,
        };
        yield { type: "assistant", content: (await decision) ? "approved" : "denied" };
      },
    });
    await manager.openThread("thread-1", "user-1");
    let immediateResolution: Promise<boolean> | undefined;
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1",
      readyState: 1,
      send(raw: string) {
        if (raw.includes("Allow this action?")) {
          immediateResolution = manager.resolveToolApproval(
            "thread-1", "user-1", "explicit-approval", true,
          );
        }
      },
    } as never);

    await manager.sendMessage("thread-1", "user-1", "do it");
    await waitFor(() => immediateResolution !== undefined);
    await expect(immediateResolution).resolves.toBe(true);
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");
    expect((await manager.openThread("thread-1", "user-1")).messages)
      .toContainEqual(expect.objectContaining({ type: "assistant", content: "approved" }));
  });

  it("settles and invalidates a pending approval when generation is stopped", async () => {
    await createThread("thread-1");
    let decide!: (approved: boolean) => void;
    let observedDecision: boolean | undefined;
    const manager = new ProjectChatManager(storage, {
      async *run() {
        const decision = new Promise<boolean>((resolve) => { decide = resolve; });
        yield {
          type: "tool_approval_request", content: JSON.stringify({ approvalId: "stop-approval" }),
          approvalId: "stop-approval", resolveApproval: decide,
        };
        observedDecision = await decision;
      },
    }, { drainTimeoutMs: 20 });
    await manager.sendMessage("thread-1", "user-1", "do it");
    await waitFor(async () => (await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1"))
      .some((message) => message.type === "tool_approval_request"));

    await expect(stopCurrent(manager, "thread-1")).resolves.toBe(true);
    const firstResult = await Promise.race([
      waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle")
        .then(() => "settled" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    if (firstResult === "timeout") {
      await manager.resolveToolApproval("thread-1", "user-1", "stop-approval", false);
      await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");
    }

    expect(firstResult).toBe("settled");
    expect(observedDecision).toBe(false);
    await expect(manager.resolveToolApproval("thread-1", "user-1", "stop-approval", true)).resolves.toBe(false);
  });

  it("settles an approval stopped after persistence but before resolver registration", async () => {
    await createThread("thread-1");
    const approvalPersisted = deferred();
    const releaseAppend = deferred();
    const originalAppend = storage.projectChatWorkItems.appendEvent.bind(storage.projectChatWorkItems);
    vi.spyOn(storage.projectChatWorkItems, "appendEvent").mockImplementation(async (opts) => {
      const result = await originalAppend(opts);
      if (opts.type === "tool_approval_request") {
        approvalPersisted.resolve();
        await releaseAppend.promise;
      }
      return result;
    });
    let decide!: (approved: boolean) => void;
    let observedDecision: boolean | undefined;
    const manager = new ProjectChatManager(storage, {
      async *run() {
        const decision = new Promise<boolean>((resolve) => { decide = resolve; });
        yield {
          type: "tool_approval_request", content: "persisting",
          approvalId: "persisting-approval", resolveApproval: (decision_) => {
            observedDecision = decision_;
            decide(decision_);
          },
        };
        await decision;
      },
    }, { drainTimeoutMs: 20 });
    await manager.sendMessage("thread-1", "user-1", "do it");
    await approvalPersisted.promise;

    await expect(stopCurrent(manager, "thread-1")).resolves.toBe(true);
    releaseAppend.resolve();
    await waitFor(() => observedDecision !== undefined);

    expect((await manager.openThread("thread-1", "user-1")).status).toBe("idle");
    expect(observedDecision).toBe(false);
  });

  it("settles an approval that arrives after its turn was aborted", async () => {
    await createThread("thread-1");
    const releaseApproval = deferred();
    let observedDecision: boolean | undefined;
    const manager = new ProjectChatManager(storage, {
      async *run() {
        await releaseApproval.promise;
        yield {
          type: "tool_approval_request", content: "late approval",
          approvalId: "late-approval", resolveApproval: (decision) => { observedDecision = decision; },
        };
      },
    });
    await manager.sendMessage("thread-1", "user-1", "do it");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");

    await expect(stopCurrent(manager, "thread-1")).resolves.toBe(true);
    releaseApproval.resolve();
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    expect(observedDecision).toBe(false);
  });

  it.each(["append", "touch"] as const)(
    "settles an approval when %s persistence fails before resolver registration",
    async (failurePoint) => {
      await createThread("thread-1");
      const originalAppend = storage.projectChatWorkItems.appendEvent.bind(storage.projectChatWorkItems);
      vi.spyOn(storage.projectChatWorkItems, "appendEvent").mockImplementation(async (opts) => {
        if (opts.type === "tool_approval_request") {
          throw new Error(`approval ${failurePoint} failed`);
        }
        return originalAppend(opts);
      });
      let observedDecision: boolean | undefined;
      const manager = new ProjectChatManager(storage, {
        async *run() {
          yield {
            type: "tool_approval_request", content: "failing approval",
            approvalId: "failing-approval", resolveApproval: (decision) => { observedDecision = decision; },
          };
        },
      });

      await manager.sendMessage("thread-1", "user-1", "do it");
      await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

      expect(observedDecision).toBe(false);
    },
  );

  it("settles pending approvals so shutdown cannot hang", async () => {
    await createThread("thread-1");
    let decide!: (approved: boolean) => void;
    let observedDecision: boolean | undefined;
    const manager = new ProjectChatManager(storage, {
      async *run() {
        const decision = new Promise<boolean>((resolve) => { decide = resolve; });
        yield {
          type: "tool_approval_request", content: JSON.stringify({ approvalId: "shutdown-approval" }),
          approvalId: "shutdown-approval", resolveApproval: decide,
        };
        observedDecision = await decision;
      },
    });
    await manager.sendMessage("thread-1", "user-1", "do it");
    await waitFor(async () => (await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1"))
      .some((message) => message.type === "tool_approval_request"));

    const shutdown = manager.shutdown();
    const firstResult = await Promise.race([
      shutdown.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    if (firstResult === "timeout") {
      await manager.resolveToolApproval("thread-1", "user-1", "shutdown-approval", false);
      await shutdown;
    }

    expect(firstResult).toBe("settled");
    expect(observedDecision).toBe(false);
    await expect(manager.resolveToolApproval("thread-1", "user-1", "shutdown-approval", true)).resolves.toBe(false);
  });

  it.each(["completed", "error"] as const)(
    "clears stale approvals after a turn ends as %s",
    async (outcome) => {
      await createThread("thread-1");
      const observedDecisions: boolean[] = [];
      const manager = new ProjectChatManager(storage, {
        async *run() {
          yield {
            type: "tool_approval_request", content: "terminal",
            approvalId: "terminal-approval",
            resolveApproval: (decision) => { observedDecisions.push(decision); },
          };
          if (outcome === "error") throw new Error("model failed");
          yield { type: "assistant", content: "done" };
        },
      });
      await manager.sendMessage("thread-1", "user-1", "do it");
      await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

      await expect(manager.resolveToolApproval(
        "thread-1", "user-1", "terminal-approval", true,
      )).resolves.toBe(false);
      expect(observedDecisions).toEqual([false]);
    },
  );

  it("closes subscribers and aborts live work before a thread is deleted", async () => {
    await createThread("thread-1");
    let aborted = false;
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true }));
      },
    });
    await manager.openThread("thread-1", "user-1");
    const socket = { projectChatUserId: "user-1", readyState: 1, send: vi.fn(), close: vi.fn() };
    manager.subscribe("thread-1", socket as never);
    await manager.sendMessage("thread-1", "user-1", "work");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");

    await expect(manager.deleteThread("thread-1", "user-1")).resolves.toBe(true);

    expect(aborted).toBe(true);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(await storage.projectChatThreads.getOwnedById("thread-1", "user-1")).toBeUndefined();
  });

  it("bounds deletion when a runner ignores abort and fences its late output", async () => {
    await createThread("thread-1");
    const releaseRunner = deferred();
    const frames: string[] = [];
    const manager = new ProjectChatManager(storage, {
      async *run() {
        await releaseRunner.promise;
        yield { type: "assistant", content: "too late" };
      },
    }, { drainTimeoutMs: 20 });
    await manager.openThread("thread-1", "user-1");
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1,
      send: (raw: string) => { frames.push(raw); }, close: vi.fn(),
    } as never);
    await manager.sendMessage("thread-1", "user-1", "work");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");
    const markAccepted = vi.spyOn(storage.projectChatWorkItems, "markAccepted")
      .mockImplementation(async () => {
        await new Promise<void>(() => undefined);
        return undefined;
      });

    const deleting = manager.deleteThread("thread-1", "user-1");
    const bounded = await Promise.race([
      deleting.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (!bounded) {
      releaseRunner.resolve();
      await deleting;
    }

    expect(bounded).toBe(true);
    releaseRunner.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames.some((frame) => frame.includes("too late"))).toBe(false);
    expect(markAccepted).not.toHaveBeenCalled();
    expect(await storage.projectChatThreads.getOwnedById("thread-1", "user-1")).toBeUndefined();
  });

  it("does not publish an append that returns after deletion enters its drain window", async () => {
    await createThread("thread-1");
    const appendCommitted = deferred();
    const releaseAppend = deferred();
    const deletionFenced = deferred();
    const originalAppend = storage.projectChatWorkItems.appendEvent.bind(storage.projectChatWorkItems);
    vi.spyOn(storage.projectChatWorkItems, "appendEvent").mockImplementation(async (opts) => {
      const result = await originalAppend(opts);
      appendCommitted.resolve();
      await releaseAppend.promise;
      return result;
    });
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        input.signal.addEventListener("abort", () => deletionFenced.resolve(), { once: true });
        yield { type: "assistant", content: "ghost" };
      },
    }, { drainTimeoutMs: 50 });
    await manager.openThread("thread-1", "user-1");
    const frames: string[] = [];
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1,
      send: (raw: string) => { frames.push(raw); }, close: vi.fn(),
    } as never);
    await manager.sendMessage("thread-1", "user-1", "work");
    await appendCommitted.promise;

    const deleting = manager.deleteThread("thread-1", "user-1");
    await deletionFenced.promise;
    releaseAppend.resolve();
    await deleting;

    expect(frames.some((frame) => frame.includes("ghost"))).toBe(false);
  });

  it("allows a fresh open and delete retry after storage deletion fails", async () => {
    await createThread("thread-1");
    const originalDelete = storage.projectChatThreads.delete.bind(storage.projectChatThreads);
    let calls = 0;
    vi.spyOn(storage.projectChatThreads, "delete").mockImplementation(async (...args) => {
      calls++;
      if (calls === 1) throw new Error("delete unavailable");
      return originalDelete(...args);
    });
    const manager = new ProjectChatManager(storage, reply("unused"));
    await manager.openThread("thread-1", "user-1");

    await expect(manager.deleteThread("thread-1", "user-1")).rejects.toThrow(/delete unavailable/);
    await expect(manager.openThread("thread-1", "user-1"))
      .resolves.toMatchObject({ thread: { id: "thread-1" } });
    await expect(manager.deleteThread("thread-1", "user-1")).resolves.toBe(true);

    expect(calls).toBe(2);
    expect(await storage.projectChatThreads.getOwnedById("thread-1", "user-1")).toBeUndefined();
  });

  it("shares concurrent deletion and keeps one owner for its in-progress fence", async () => {
    await createThread("thread-1");
    const bothAuthorized = deferred();
    const releaseAuthorization = deferred();
    const originalGetById = storage.projectChatThreads.getById.bind(storage.projectChatThreads);
    let authorizations = 0;
    vi.spyOn(storage.projectChatThreads, "getById").mockImplementation(async (...args) => {
      if (args[0] === "thread-1" && authorizations < 2) {
        authorizations++;
        if (authorizations === 2) bothAuthorized.resolve();
        await releaseAuthorization.promise;
      }
      return originalGetById(...args);
    });
    const releaseDelete = deferred();
    let storageDeletes = 0;
    vi.spyOn(storage.projectChatThreads, "delete").mockImplementation(async () => {
      storageDeletes++;
      await releaseDelete.promise;
      throw new Error("shared delete failure");
    });
    const manager = new ProjectChatManager(storage, reply("unused"));

    const first = manager.deleteThread("thread-1", "user-1");
    const second = manager.deleteThread("thread-1", "user-1");
    await bothAuthorized.promise;
    releaseAuthorization.resolve();
    await waitFor(() => storageDeletes >= 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(storageDeletes).toBe(1);
    releaseDelete.resolve();
    await expect(first).rejects.toThrow(/shared delete failure/);
    await expect(second).rejects.toThrow(/shared delete failure/);
  });

  it("hydrates a live thread only once while messages are being appended", async () => {
    await createThread("thread-1");
    const listByThread = vi.spyOn(storage.projectChatMessages, "listByThread");
    const manager = new ProjectChatManager(storage, reply("reply"));
    await manager.openThread("thread-1", "user-1");
    await manager.sendMessage("thread-1", "user-1", "question");
    await Promise.all([
      manager.openThread("thread-1", "user-1"),
      manager.openThread("thread-1", "user-1"),
    ]);
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");

    expect(listByThread).toHaveBeenCalledTimes(1);
    expect((await manager.openThread("thread-1", "user-1")).messages.map((message) => message.sequence))
      .toEqual([1, 2, 3]);
  });

  it("evicts an idle unsubscribed thread and rehydrates it on the next open", async () => {
    await createThread("thread-1");
    const listMessages = vi.spyOn(storage.projectChatMessages, "listByThread");
    const manager = new ProjectChatManager(storage, reply("unused"), { idleEvictionMs: 5 });

    await manager.openThread("thread-1", "user-1");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await manager.openThread("thread-1", "user-1");

    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it("does not evict active or subscribed threads", async () => {
    await createThread("thread-1");
    const gate = deferred();
    const listMessages = vi.spyOn(storage.projectChatMessages, "listByThread");
    const manager = new ProjectChatManager(storage, {
      async *run() {
        await gate.promise;
        yield { type: "assistant", content: "done" };
      },
    }, { idleEvictionMs: 5 });
    await manager.openThread("thread-1", "user-1");
    const unsubscribe = manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1, send: vi.fn(),
    } as never)!;
    await manager.sendMessage("thread-1", "user-1", "work");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await manager.openThread("thread-1", "user-1");
    expect(listMessages).toHaveBeenCalledTimes(1);

    gate.resolve();
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await manager.openThread("thread-1", "user-1");
    expect(listMessages).toHaveBeenCalledTimes(1);

    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await manager.openThread("thread-1", "user-1");
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a thread deleted while hydration is in flight", async () => {
    await createThread("thread-1");
    const hydrationStarted = deferred();
    const allowHydration = deferred();
    const originalList = storage.projectChatMessages.listByThread.bind(storage.projectChatMessages);
    vi.spyOn(storage.projectChatMessages, "listByThread").mockImplementation(async (...args) => {
      hydrationStarted.resolve();
      await allowHydration.promise;
      return originalList(...args);
    });
    const manager = new ProjectChatManager(storage, reply("unused"));

    const opening = manager.openThread("thread-1", "user-1");
    await hydrationStarted.promise;
    await expect(manager.deleteThread("thread-1", "user-1")).resolves.toBe(true);
    allowHydration.resolve();

    await expect(opening).rejects.toMatchObject({ code: "PROJECT_CHAT_NOT_FOUND" });
    await expect(manager.openThread("thread-1", "user-1"))
      .rejects.toMatchObject({ code: "PROJECT_CHAT_NOT_FOUND" });
    expect(manager.subscribe(
      "thread-1", { projectChatUserId: "user-1", readyState: 1, send: vi.fn() } as never,
    )).toBeNull();
  });

  it.each(["authorization", "hydration"] as const)(
    "settles and rejects a send paused in %s before shutdown completes",
    async (phase) => {
      await createThread("thread-1");
      const phaseStarted = deferred();
      const allowPhase = deferred();
      if (phase === "authorization") {
        const originalGetOwned = storage.projectChatThreads.getOwnedById.bind(storage.projectChatThreads);
        vi.spyOn(storage.projectChatThreads, "getOwnedById").mockImplementation(async (...args) => {
          phaseStarted.resolve();
          await allowPhase.promise;
          return originalGetOwned(...args);
        });
      } else {
        const originalList = storage.projectChatMessages.listByThread.bind(storage.projectChatMessages);
        vi.spyOn(storage.projectChatMessages, "listByThread").mockImplementation(async (...args) => {
          phaseStarted.resolve();
          await allowPhase.promise;
          return originalList(...args);
        });
      }
      const manager = new ProjectChatManager(storage, reply("must not run"));

      const sending = manager.sendMessage("thread-1", "user-1", "race shutdown");
      await phaseStarted.promise;
      let shutdownSettled = false;
      const shutdown = manager.shutdown().then(() => { shutdownSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(shutdownSettled).toBe(false);
      allowPhase.resolve();

      await expect(sending).rejects.toThrow(/shutting down/);
      await shutdown;
      expect(await storage.projectChatMessages.listByThread(
        "thread-1", "project-1", "user-1",
      )).toEqual([]);
      expect(await storage.projectChatWorkItems.listNonterminal(
        "thread-1", "project-1", "user-1",
      )).toEqual([]);
    },
  );

  it("resolves a send whose acceptance commits during shutdown and leaves it recoverable", async () => {
    await createThread("thread-1");
    const manager = new ProjectChatManager(storage, reply("must not run"));
    await manager.openThread("thread-1", "user-1");
    const acceptanceStarted = deferred();
    const allowAcceptance = deferred();
    const originalAccept = storage.projectChatWorkItems.accept.bind(storage.projectChatWorkItems);
    vi.spyOn(storage.projectChatWorkItems, "accept").mockImplementation(async (opts) => {
      acceptanceStarted.resolve();
      await allowAcceptance.promise;
      return originalAccept(opts);
    });

    const sending = manager.sendMessage("thread-1", "user-1", "accepted at shutdown");
    await acceptanceStarted.promise;
    let shutdownSettled = false;
    const shutdown = manager.shutdown().then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shutdownSettled).toBe(false);
    allowAcceptance.resolve();

    await expect(sending).resolves.toBeUndefined();
    await shutdown;
    expect(await storage.projectChatWorkItems.listNonterminal(
      "thread-1", "project-1", "user-1",
    )).toHaveLength(1);

    vi.restoreAllMocks();
    const recovered: string[] = [];
    const nextManager = new ProjectChatManager(storage, {
      async *run(input) {
        recovered.push(input.messages.at(-1)?.content ?? "");
        yield { type: "assistant", content: "recovered" };
      },
    });
    await nextManager.openThread("thread-1", "user-1");
    await waitFor(() => recovered.length === 1);
    expect(recovered).toEqual(["accepted at shutdown"]);
  });

  it("rejects new opens and sends while a thread deletion is in progress", async () => {
    await createThread("thread-1");
    const deleteStarted = deferred();
    const allowDelete = deferred();
    const originalDelete = storage.projectChatThreads.delete.bind(storage.projectChatThreads);
    vi.spyOn(storage.projectChatThreads, "delete").mockImplementation(async (...args) => {
      deleteStarted.resolve();
      await allowDelete.promise;
      return originalDelete(...args);
    });
    const manager = new ProjectChatManager(storage, reply("unused"));
    await manager.openThread("thread-1", "user-1");

    const deleting = manager.deleteThread("thread-1", "user-1");
    await deleteStarted.promise;
    await expect(manager.openThread("thread-1", "user-1")).rejects.toMatchObject({ code: "PROJECT_CHAT_NOT_FOUND" });
    await expect(manager.sendMessage("thread-1", "user-1", "race")).rejects.toMatchObject({ code: "PROJECT_CHAT_NOT_FOUND" });
    expect(manager.subscribe("thread-1", { projectChatUserId: "user-1", send: vi.fn() } as never)).toBeNull();
    allowDelete.resolve();
    await expect(deleting).resolves.toBe(true);
  });

  it("does not enqueue a send that was awaiting durable acceptance when deletion began", async () => {
    await createThread("thread-1");
    const activeGate = deferred();
    let activeAborted = false;
    const manager = new ProjectChatManager(storage, {
      async *run(input) {
        await Promise.race([
          activeGate.promise,
          new Promise<void>((resolve) => input.signal.addEventListener("abort", () => {
            activeAborted = true;
            resolve();
          }, { once: true })),
        ]);
      },
    });
    await manager.sendMessage("thread-1", "user-1", "first");
    await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "running");
    const frames: string[] = [];
    manager.subscribe("thread-1", {
      projectChatUserId: "user-1", readyState: 1,
      send: (raw: string) => { frames.push(raw); },
    } as never);
    const acceptanceStarted = deferred();
    const allowAcceptance = deferred();
    const originalAccept = storage.projectChatWorkItems.accept.bind(storage.projectChatWorkItems);
    vi.spyOn(storage.projectChatWorkItems, "accept").mockImplementation(async (opts) => {
      if (opts.content === "second") {
        acceptanceStarted.resolve();
        await allowAcceptance.promise;
      }
      return originalAccept(opts);
    });
    const deleteStarted = deferred();
    const allowDelete = deferred();
    const originalDelete = storage.projectChatThreads.delete.bind(storage.projectChatThreads);
    vi.spyOn(storage.projectChatThreads, "delete").mockImplementation(async (...args) => {
      deleteStarted.resolve();
      await allowDelete.promise;
      return originalDelete(...args);
    });

    const racingSend = manager.sendMessage("thread-1", "user-1", "second");
    await acceptanceStarted.promise;
    const deleting = manager.deleteThread("thread-1", "user-1");
    await waitFor(() => activeAborted);
    allowAcceptance.resolve();
    await expect(racingSend).rejects.toMatchObject({ code: "PROJECT_CHAT_NOT_FOUND" });
    await deleteStarted.promise;
    allowDelete.resolve();
    await deleting;
    activeGate.resolve();
    expect(frames.some((frame) => frame.includes("second"))).toBe(false);
  });
});
