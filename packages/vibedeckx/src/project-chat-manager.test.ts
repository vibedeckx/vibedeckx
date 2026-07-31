import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import {
  ProjectChatManager,
  type ProjectChatModelRunner,
  type ProjectChatRunInput,
  type ProjectChatStreamEvent,
} from "./project-chat-manager.js";

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
    expect(snapshot).toMatchObject({ status: "idle", queueLength: 0 });
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
        const frame = JSON.parse(raw) as { message?: { sequence: number } };
        if (frame.message) {
          const persisted = storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
          frames.push(persisted.then((messages) => messages.some((message) => message.sequence === frame.message!.sequence)));
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
    await expect(Promise.all(frames)).resolves.not.toContain(false);
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

    await expect(manager.stopGeneration("thread-1", "user-1")).resolves.toBe(true);
    expect((await manager.openThread("thread-2", "user-1")).status).toBe("running");

    secondGate.resolve();
    await Promise.all([first, second]);
    await waitFor(async () => (await manager.openThread("thread-2", "user-1")).status === "idle");
    expect((await storage.projectChatMessages.listByThread("thread-2", "project-1", "user-1"))
      .some((message) => message.content === "thread two complete")).toBe(true);
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
    await expect(manager.stopGeneration("private", "user-1")).resolves.toBe(false);
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

  it("durably recovers an accepted queued message after shutdown and restart", async () => {
    await createThread("thread-1");
    const gate = deferred();
    const firstManager = new ProjectChatManager(storage, {
      async *run(input) {
        if (input.messages.at(-1)?.content === "first") await gate.promise;
        yield { type: "assistant", content: "reply" };
      },
    });
    await firstManager.sendMessage("thread-1", "user-1", "first");
    await waitFor(async () => (await firstManager.openThread("thread-1", "user-1")).status === "running");
    await firstManager.sendMessage("thread-1", "user-1", "second");

    const shutdown = firstManager.shutdown();
    gate.resolve();
    await shutdown;
    const restoredStarts: string[] = [];
    const secondManager = new ProjectChatManager(storage, {
      async *run(input) {
        restoredStarts.push(input.messages.at(-1)?.content ?? "");
        yield { type: "assistant", content: "restored reply" };
      },
    });
    await secondManager.openThread("thread-1", "user-1");
    await waitFor(() => restoredStarts.includes("second"));
    await waitFor(async () => (await secondManager.openThread("thread-1", "user-1")).status === "idle");

    expect((await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1"))
      .filter((message) => message.type === "user").map((message) => message.content))
      .toEqual(["first", "second"]);
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
    const markerStarted = deferred();
    const allowMarker = deferred();
    const originalAppend = storage.projectChatMessages.append.bind(storage.projectChatMessages);
    vi.spyOn(storage.projectChatMessages, "append").mockImplementation(async (opts) => {
      if (opts.type === "operation" && opts.content.includes("queued_user")) {
        markerStarted.resolve();
        await allowMarker.promise;
      }
      return originalAppend(opts);
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
    await markerStarted.promise;
    const deleting = manager.deleteThread("thread-1", "user-1");
    await waitFor(() => activeAborted);
    allowMarker.resolve();
    await expect(racingSend).rejects.toMatchObject({ code: "PROJECT_CHAT_NOT_FOUND" });
    await deleteStarted.promise;
    allowDelete.resolve();
    await deleting;
    activeGate.resolve();
  });
});
