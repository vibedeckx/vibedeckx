import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
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

    await expect(manager.stopGeneration("thread-1", "user-1")).resolves.toBe(true);
    expect((await manager.openThread("thread-2", "user-1")).status).toBe("running");

    secondGate.resolve();
    await Promise.all([first, second]);
    await waitFor(async () => (await manager.openThread("thread-2", "user-1")).status === "idle");
    expect((await storage.projectChatMessages.listByThread("thread-2", "project-1", "user-1"))
      .some((message) => message.content === "thread two complete")).toBe(true);
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
      manager.stopGeneration("thread-1", "user-1"),
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
        manager.stopGeneration("thread-1", "user-1").then(() => "settled" as const),
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

    await manager.stopGeneration("thread-1", "user-1");
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

    await manager.stopGeneration("thread-1", "user-1");
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

    const stopping = manager.stopGeneration("thread-1", "user-1");
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

    await expect(manager.stopGeneration("thread-1", "user-1")).resolves.toBe(true);
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

    await expect(manager.stopGeneration("thread-1", "user-1")).resolves.toBe(true);
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

    await expect(manager.stopGeneration("thread-1", "user-1")).resolves.toBe(true);
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
