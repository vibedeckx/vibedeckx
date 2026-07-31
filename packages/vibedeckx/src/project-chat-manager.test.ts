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

  it("does not rerun journal work after its atomic terminal transition", async () => {
    await createThread("thread-1");
    await storage.projectChatWorkItems.accept({
      id: "work-done", user_message_id: "user-done", thread_id: "thread-1",
      project_id: "project-1", user_id: "user-1", content: "done",
    });
    await storage.projectChatWorkItems.finish({
      id: "work-done", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
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
    });
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
    const originalAppend = storage.projectChatMessages.append.bind(storage.projectChatMessages);
    vi.spyOn(storage.projectChatMessages, "append").mockImplementation(async (opts) => {
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
          approvalId: "persisting-approval", resolveApproval: decide,
        };
        observedDecision = await decision;
      },
    });
    await manager.sendMessage("thread-1", "user-1", "do it");
    await approvalPersisted.promise;

    await expect(manager.stopGeneration("thread-1", "user-1")).resolves.toBe(true);
    releaseAppend.resolve();
    const settled = await Promise.race([
      waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle")
        .then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    if (!settled) {
      await manager.resolveToolApproval("thread-1", "user-1", "persisting-approval", false);
      await waitFor(async () => (await manager.openThread("thread-1", "user-1")).status === "idle");
    }

    expect(settled).toBe(true);
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
      let approvalAppended = false;
      if (failurePoint === "append") {
        const originalAppend = storage.projectChatMessages.append.bind(storage.projectChatMessages);
        vi.spyOn(storage.projectChatMessages, "append").mockImplementation(async (opts) => {
          if (opts.type === "tool_approval_request") throw new Error("approval append failed");
          return originalAppend(opts);
        });
      } else {
        const originalAppend = storage.projectChatMessages.append.bind(storage.projectChatMessages);
        vi.spyOn(storage.projectChatMessages, "append").mockImplementation(async (opts) => {
          const result = await originalAppend(opts);
          approvalAppended = opts.type === "tool_approval_request";
          return result;
        });
        const originalTouch = storage.projectChatThreads.touchUpdatedAt.bind(storage.projectChatThreads);
        vi.spyOn(storage.projectChatThreads, "touchUpdatedAt").mockImplementation(async (...args) => {
          if (approvalAppended) {
            approvalAppended = false;
            throw new Error("approval touch failed");
          }
          return originalTouch(...args);
        });
      }
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
  });
});
