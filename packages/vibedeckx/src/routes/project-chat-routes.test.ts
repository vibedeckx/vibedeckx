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

import projectChatRoutes from "./project-chat-routes.js";
import { ProjectChatManager } from "../project-chat-manager.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { ProjectChatThread, Storage } from "../storage/types.js";

describe("project chat thread routes", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let projectChatManager: {
    startAcceptedThread: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    stopGeneration: ReturnType<typeof vi.fn>;
    resolveToolApproval: ReturnType<typeof vi.fn>;
    deleteThread: ReturnType<typeof vi.fn>;
  };

  async function build(authEnabled = true) {
    const instance = Fastify({ logger: false });
    instance.decorate("authEnabled", authEnabled);
    instance.decorate("storage", storage);
    instance.decorate("projectChatManager", projectChatManager as never);
    await instance.register(projectChatRoutes);
    await instance.ready();
    return instance;
  }

  async function createThread(overrides: Partial<ProjectChatThread> = {}) {
    return storage.projectChatThreads.create({
      id: overrides.id ?? "thread-1",
      project_id: overrides.project_id ?? "project-1",
      user_id: overrides.user_id ?? "user-1",
      title: overrides.title ?? null,
    });
  }

  beforeEach(async () => {
    auth.currentUserId = "user-1";
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-chat-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    projectChatManager = {
      startAcceptedThread: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      stopGeneration: vi.fn().mockResolvedValue(true),
      resolveToolApproval: vi.fn().mockResolvedValue(true),
      deleteThread: vi.fn(async (threadId: string, userId: string) => {
        const thread = await storage.projectChatThreads.getOwnedById(threadId, userId);
        if (!thread) return false;
        await storage.projectChatThreads.delete(threadId, thread.project_id, userId);
        return true;
      }),
    };
    await storage.projects.create({ id: "project-1", name: "Mine", path: "/tmp/mine" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Also mine", path: "/tmp/also-mine" }, "user-1");
    await storage.projects.create({ id: "foreign-project", name: "Theirs", path: "/tmp/theirs" }, "user-2");
    app = await build();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("GET /api/projects/:projectId/project-chat/threads", () => {
    it("lists only the caller's active threads for the requested project", async () => {
      await createThread({ id: "mine" });
      await createThread({ id: "other-project", project_id: "project-2" });
      await createThread({ id: "other-user", user_id: "user-2" });
      await createThread({ id: "archived" });
      await storage.projectChatThreads.archive("archived", "project-1", "user-1");

      const response = await app.inject({ method: "GET", url: "/api/projects/project-1/project-chat/threads" });

      expect(response.statusCode).toBe(200);
      expect(response.json().threads.map((thread: ProjectChatThread) => thread.id)).toEqual(["mine"]);
    });

    it("includes archived threads only when requested", async () => {
      await createThread({ id: "active" });
      await createThread({ id: "archived" });
      await storage.projectChatThreads.archive("archived", "project-1", "user-1");

      const response = await app.inject({
        method: "GET",
        url: "/api/projects/project-1/project-chat/threads?includeArchived=true",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().threads.map((thread: ProjectChatThread) => thread.id).sort()).toEqual(["active", "archived"]);
    });

    it("returns 404 for nonexistent and foreign projects", async () => {
      for (const projectId of ["missing", "foreign-project"]) {
        const response = await app.inject({ method: "GET", url: `/api/projects/${projectId}/project-chat/threads` });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "Project not found" });
      }
    });
  });

  describe("POST /api/projects/:projectId/project-chat/threads", () => {
    it("atomically accepts and starts a trimmed first turn exactly once", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project-1/project-chat/threads",
        payload: { message: "  What changed?  ", createRequestId: "create-1" },
      });

      expect(response.statusCode).toBe(201);
      const { thread } = response.json() as { thread: ProjectChatThread };
      expect(thread).toMatchObject({ project_id: "project-1", user_id: "user-1", title: null });
      expect(thread.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(thread).not.toHaveProperty("branch");
      expect(thread).not.toHaveProperty("workspace");
      expect(await storage.projectChatMessages.listByThread(thread.id, "project-1", "user-1"))
        .toEqual([expect.objectContaining({ sequence: 1, type: "user", content: "What changed?" })]);
      expect(await storage.projectChatWorkItems.listNonterminal(thread.id, "project-1", "user-1"))
        .toEqual([expect.objectContaining({ status: "accepted", content: "What changed?" })]);
      expect(projectChatManager.startAcceptedThread).toHaveBeenCalledOnce();
      expect(projectChatManager.startAcceptedThread).toHaveBeenCalledWith(thread.id, "user-1");
    });

    it("returns the same accepted thread for a lost-201 retry without restarting work", async () => {
      const request = {
        method: "POST" as const,
        url: "/api/projects/project-1/project-chat/threads",
        payload: { message: "recover this response", createRequestId: "lost-201" },
      };

      const first = await app.inject(request);
      const retry = await app.inject(request);

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.json().thread.id).toBe(first.json().thread.id);
      expect(projectChatManager.startAcceptedThread).toHaveBeenCalledOnce();
      expect(await storage.projectChatMessages.listByThread(
        first.json().thread.id, "project-1", "user-1",
      )).toHaveLength(1);
    });

    it("scopes create idempotency by project and user and rejects payload collisions", async () => {
      const first = await app.inject({ method: "POST", url: "/api/projects/project-1/project-chat/threads",
        payload: { message: "one", createRequestId: "shared-key" } });
      const otherProject = await app.inject({ method: "POST", url: "/api/projects/project-2/project-chat/threads",
        payload: { message: "two", createRequestId: "shared-key" } });
      const mismatch = await app.inject({ method: "POST", url: "/api/projects/project-1/project-chat/threads",
        payload: { message: "different", createRequestId: "shared-key" } });

      expect(first.statusCode).toBe(201);
      expect(otherProject.statusCode).toBe(201);
      expect(otherProject.json().thread.id).not.toBe(first.json().thread.id);
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toEqual({ error: "createRequestId was already used with a different payload" });
    });

    it("creates an empty thread when message is omitted", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project-1/project-chat/threads",
      });

      expect(response.statusCode).toBe(201);
      const { thread } = response.json() as { thread: ProjectChatThread };
      expect(await storage.projectChatMessages.listByThread(thread.id, "project-1", "user-1")).toEqual([]);
      expect(await storage.projectChatWorkItems.listNonterminal(thread.id, "project-1", "user-1")).toEqual([]);
      expect(projectChatManager.startAcceptedThread).not.toHaveBeenCalled();
    });

    it("rejects malformed create payloads", async () => {
      const invalidPayloads = [
        { message: "" },
        { message: "   " },
        { message: 3 },
        { message: "x".repeat(100_001) },
        { unexpected: true },
        { createRequestId: "" },
        { createRequestId: "x".repeat(513) },
      ];
      for (const payload of invalidPayloads) {
        const response = await app.inject({
          method: "POST",
          url: "/api/projects/project-1/project-chat/threads",
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(await storage.projectChatThreads.listByProject("project-1", "user-1", 100)).toEqual([]);
    });

    it("delegates initial-turn persistence to the atomic thread create operation", async () => {
      const createIdempotent = vi.fn().mockRejectedValue(new Error("write failed"));
      (storage.projectChatThreads as typeof storage.projectChatThreads & {
        createIdempotent: typeof createIdempotent;
      }).createIdempotent = createIdempotent;

      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project-1/project-chat/threads",
        payload: { message: "hello" },
      });

      expect(response.statusCode).toBe(500);
      expect(createIdempotent).toHaveBeenCalledOnce();
      expect(await storage.projectChatThreads.listByProject("project-1", "user-1", 100)).toEqual([]);
      expect(projectChatManager.startAcceptedThread).not.toHaveBeenCalled();
    });

    it("returns the durably accepted thread when immediate runtime startup fails", async () => {
      projectChatManager.startAcceptedThread.mockRejectedValueOnce(new Error("runtime unavailable"));

      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project-1/project-chat/threads",
        payload: { message: "recover after restart" },
      });

      expect(response.statusCode).toBe(201);
      const { thread } = response.json() as { thread: ProjectChatThread };
      expect(await storage.projectChatMessages.listByThread(thread.id, "project-1", "user-1"))
        .toHaveLength(1);
      expect(await storage.projectChatWorkItems.listNonterminal(thread.id, "project-1", "user-1"))
        .toHaveLength(1);
    });

    it("returns 404 for nonexistent and foreign projects", async () => {
      for (const projectId of ["missing", "foreign-project"]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/project-chat/threads`,
          payload: {},
        });
        expect(response.statusCode).toBe(404);
      }
    });
  });

  describe("thread routes by id", () => {
    it("gets an owned thread with bounded deterministic context references", async () => {
      await createThread({ title: "Status" });
      await storage.tasks.create({ id: "a-task", project_id: "project-1", title: "One" });
      await storage.projectChatContextRefs.touch("thread-1", "project-1", "user-1", "task", "z-deleted-task");
      await storage.projectChatContextRefs.touch("thread-1", "project-1", "user-1", "task", "a-task");

      const response = await app.inject({ method: "GET", url: "/api/project-chat/threads/thread-1" });

      expect(response.statusCode).toBe(200);
      expect(response.json().thread).toMatchObject({ id: "thread-1", title: "Status" });
      expect(response.json().contextRefs).toEqual([
        expect.objectContaining({
          entity_type: "task", entity_id: "a-task", deleted: false,
          navigation: { kind: "task", taskId: "a-task", label: "One" },
        }),
        expect.objectContaining({
          entity_type: "task", entity_id: "z-deleted-task", deleted: true, navigation: null,
        }),
      ]);
      expect(response.json().contextRefs[0]).not.toHaveProperty("user_id");
      expect(response.json().contextRefs[0]).not.toHaveProperty("project_id");
    });

    it("returns the same 404 for missing, another user's, and another project's threads", async () => {
      await createThread({ id: "theirs", user_id: "user-2" });
      await createThread({ id: "other-project", project_id: "project-2" });
      auth.currentUserId = "user-2";
      await storage.projectChatThreads.create({
        id: "foreign-project-thread",
        project_id: "foreign-project",
        user_id: "user-2",
        title: null,
      });
      auth.currentUserId = "user-1";

      for (const id of ["missing", "theirs", "foreign-project-thread"]) {
        const response = await app.inject({ method: "GET", url: `/api/project-chat/threads/${id}` });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "Thread not found" });
      }

      const ownedOtherProject = await app.inject({ method: "GET", url: "/api/project-chat/threads/other-project" });
      expect(ownedOtherProject.statusCode).toBe(200);
    });

    it("trims or clears a title and archives/unarchives predictably", async () => {
      await createThread();

      const combined = await app.inject({
        method: "PATCH",
        url: "/api/project-chat/threads/thread-1",
        payload: { title: "  Project status  ", archived: true },
      });
      expect(combined.statusCode).toBe(200);
      expect(combined.json().thread).toMatchObject({ title: "Project status" });
      expect(combined.json().thread.archived_at).not.toBeNull();

      const cleared = await app.inject({
        method: "PATCH",
        url: "/api/project-chat/threads/thread-1",
        payload: { title: null, archived: false },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().thread).toMatchObject({ title: null, archived_at: null });
    });

    it("returns a non-disclosing 404 when the thread disappears before its atomic update", async () => {
      await createThread();
      const update = vi.fn().mockResolvedValue(undefined);
      (storage.projectChatThreads as typeof storage.projectChatThreads & {
        update: typeof update;
      }).update = update;

      const response = await app.inject({
        method: "PATCH",
        url: "/api/project-chat/threads/thread-1",
        payload: { title: "Project status", archived: true },
      });

      expect(update).toHaveBeenCalledWith("thread-1", "project-1", "user-1", {
        title: "Project status",
        archived: true,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Thread not found" });
    });

    it("accepts each exact patch field independently", async () => {
      await createThread();

      expect((await app.inject({
        method: "PATCH", url: "/api/project-chat/threads/thread-1", payload: { title: "Renamed" },
      })).statusCode).toBe(200);
      expect((await app.inject({
        method: "PATCH", url: "/api/project-chat/threads/thread-1", payload: { archived: true },
      })).statusCode).toBe(200);
      expect((await storage.projectChatThreads.getById("thread-1", "project-1", "user-1")))
        .toMatchObject({ title: "Renamed" });
    });

    it("rejects unknown keys, wrong types, empty patches, and invalid titles", async () => {
      await createThread({ title: "Original" });
      const invalidPayloads = [
        {},
        { unknown: true },
        { title: 3 },
        { archived: "true" },
        { title: "" },
        { title: "   " },
        { title: "x".repeat(201) },
      ];

      for (const payload of invalidPayloads) {
        const response = await app.inject({
          method: "PATCH",
          url: "/api/project-chat/threads/thread-1",
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
      expect((await storage.projectChatThreads.getById("thread-1", "project-1", "user-1"))?.title).toBe("Original");
    });

    it("does not patch a foreign thread", async () => {
      await createThread({ id: "theirs", user_id: "user-2", title: "Private" });

      const response = await app.inject({
        method: "PATCH",
        url: "/api/project-chat/threads/theirs",
        payload: { title: "Leaked" },
      });

      expect(response.statusCode).toBe(404);
      expect((await storage.projectChatThreads.getById("theirs", "project-1", "user-2"))?.title).toBe("Private");
    });

    it("hard-deletes an owned thread and its children", async () => {
      await createThread();
      await storage.projectChatMessages.append({
        id: "message-1", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
        sequence: 1, type: "user", content: "hello",
      });
      await storage.projectChatContextRefs.touch("thread-1", "project-1", "user-1", "task", "task-1");

      const response = await app.inject({ method: "DELETE", url: "/api/project-chat/threads/thread-1" });

      expect(response.statusCode).toBe(204);
      expect(projectChatManager.deleteThread).toHaveBeenCalledWith("thread-1", "user-1");
      expect(await storage.projectChatThreads.getById("thread-1", "project-1", "user-1")).toBeUndefined();
      expect(await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1")).toEqual([]);
      expect(await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1")).toEqual([]);
    });

    it("returns 404 when a concurrent manager delete reports no deletion", async () => {
      await createThread();
      projectChatManager.deleteThread.mockResolvedValueOnce(false);

      const response = await app.inject({ method: "DELETE", url: "/api/project-chat/threads/thread-1" });

      expect(response.statusCode).toBe(404);
      expect(await storage.projectChatThreads.getById(
        "thread-1", "project-1", "user-1",
      )).toBeDefined();
    });

    it("returns 500 for a failed storage delete and succeeds on a fresh retry", async () => {
      await createThread();
      const actualManager = new ProjectChatManager(storage, {
        async *run() { return; },
      });
      projectChatManager.deleteThread.mockImplementation(
        actualManager.deleteThread.bind(actualManager),
      );
      const originalDelete = storage.projectChatThreads.delete.bind(storage.projectChatThreads);
      let deletes = 0;
      vi.spyOn(storage.projectChatThreads, "delete").mockImplementation(async (...args) => {
        deletes++;
        if (deletes === 1) throw new Error("delete unavailable");
        return originalDelete(...args);
      });

      const first = await app.inject({ method: "DELETE", url: "/api/project-chat/threads/thread-1" });
      const second = await app.inject({ method: "DELETE", url: "/api/project-chat/threads/thread-1" });

      expect(first.statusCode).toBe(500);
      expect(second.statusCode).toBe(204);
      expect(deletes).toBe(2);
      expect(await storage.projectChatThreads.getById(
        "thread-1", "project-1", "user-1",
      )).toBeUndefined();
    });

    it("does not delete a foreign thread", async () => {
      await createThread({ id: "theirs", user_id: "user-2" });

      const response = await app.inject({ method: "DELETE", url: "/api/project-chat/threads/theirs" });

      expect(response.statusCode).toBe(404);
      expect(await storage.projectChatThreads.getById("theirs", "project-1", "user-2")).toBeDefined();
    });
  });

  describe("thread runtime routes", () => {
    it("sends a trimmed message through the authorized thread runtime", async () => {
      await createThread();

      const response = await app.inject({
        method: "POST",
        url: "/api/project-chat/threads/thread-1/messages",
        payload: { content: "  What changed?  " },
      });

      expect(response.statusCode).toBe(202);
      expect(projectChatManager.sendMessage).toHaveBeenCalledWith("thread-1", "user-1", "What changed?");
    });

    it("does not acknowledge a message when durable acceptance fails", async () => {
      await createThread();
      projectChatManager.sendMessage.mockRejectedValue(new Error("write failed"));

      const response = await app.inject({
        method: "POST",
        url: "/api/project-chat/threads/thread-1/messages",
        payload: { content: "persist this" },
      });

      expect(response.statusCode).toBe(500);
    });

    it("rejects malformed messages before invoking the runtime", async () => {
      await createThread();
      for (const payload of [
        {}, { content: "" }, { content: "   " }, { content: 1 },
        { content: "x".repeat(100_001) }, { content: "ok", extra: true },
      ]) {
        const response = await app.inject({
          method: "POST", url: "/api/project-chat/threads/thread-1/messages", payload,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(projectChatManager.sendMessage).not.toHaveBeenCalled();
    });

    it("requires an active turn identity and stops only that owned turn", async () => {
      await createThread();
      projectChatManager.stopGeneration.mockResolvedValue(false);

      const response = await app.inject({
        method: "POST", url: "/api/project-chat/threads/thread-1/stop",
        payload: { expectedActiveTurnId: "turn-1" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ stopped: false });
      expect(projectChatManager.stopGeneration).toHaveBeenCalledWith("thread-1", "user-1", "turn-1");
    });

    it("rejects missing or malformed stop identities before invoking the manager", async () => {
      await createThread();
      for (const payload of [undefined, {}, { expectedActiveTurnId: "" }, { expectedActiveTurnId: 1 }, {
        expectedActiveTurnId: "turn-1", extra: true,
      }]) {
        const response = await app.inject({
          method: "POST", url: "/api/project-chat/threads/thread-1/stop", payload,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(projectChatManager.stopGeneration).not.toHaveBeenCalled();
    });

    it("returns conflict when the observed turn is no longer active", async () => {
      await createThread();
      projectChatManager.stopGeneration.mockRejectedValue(Object.assign(
        new Error("Active Project Chat turn changed"),
        { code: "PROJECT_CHAT_ACTIVE_TURN_CONFLICT" },
      ));

      const response = await app.inject({
        method: "POST", url: "/api/project-chat/threads/thread-1/stop",
        payload: { expectedActiveTurnId: "stale-turn" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "Active Project Chat turn changed" });
    });

    it("resolves a validated tool approval and reports stale approvals as 404", async () => {
      await createThread();
      const approved = await app.inject({
        method: "POST",
        url: "/api/project-chat/threads/thread-1/tool-approval",
        payload: { approvalId: "approval-1", approved: true },
      });
      expect(approved.statusCode).toBe(200);
      expect(projectChatManager.resolveToolApproval)
        .toHaveBeenCalledWith("thread-1", "user-1", "approval-1", true);

      projectChatManager.resolveToolApproval.mockResolvedValue(false);
      const stale = await app.inject({
        method: "POST",
        url: "/api/project-chat/threads/thread-1/tool-approval",
        payload: { approvalId: "stale", approved: false },
      });
      expect(stale.statusCode).toBe(404);
      expect(stale.json()).toEqual({ error: "Tool approval not found" });
    });

    it("validates tool approval bodies", async () => {
      await createThread();
      for (const payload of [
        {}, { approvalId: "", approved: true }, { approvalId: 1, approved: true },
        { approvalId: "a", approved: "yes" }, { approvalId: "a", approved: true, extra: true },
      ]) {
        const response = await app.inject({
          method: "POST", url: "/api/project-chat/threads/thread-1/tool-approval", payload,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(projectChatManager.resolveToolApproval).not.toHaveBeenCalled();
    });

    it("returns the same 404 for foreign runtime operations without invoking the manager", async () => {
      await createThread({ id: "theirs", user_id: "user-2" });
      for (const request of [
        { url: "/api/project-chat/threads/theirs/messages", payload: { content: "steal" } },
        { url: "/api/project-chat/threads/theirs/stop", payload: undefined },
        { url: "/api/project-chat/threads/theirs/tool-approval", payload: { approvalId: "a", approved: true } },
      ]) {
        const response = await app.inject({ method: "POST", ...request });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "Thread not found" });
      }
      expect(projectChatManager.sendMessage).not.toHaveBeenCalled();
      expect(projectChatManager.stopGeneration).not.toHaveBeenCalled();
      expect(projectChatManager.resolveToolApproval).not.toHaveBeenCalled();
    });
  });

  it("returns 401 for every route without an authenticated identity", async () => {
    auth.currentUserId = null;
    const requests = [
      { method: "GET", url: "/api/projects/project-1/project-chat/threads" },
      { method: "POST", url: "/api/projects/project-1/project-chat/threads", payload: {} },
      { method: "GET", url: "/api/project-chat/threads/thread-1" },
      { method: "PATCH", url: "/api/project-chat/threads/thread-1", payload: { title: "Nope" } },
      { method: "DELETE", url: "/api/project-chat/threads/thread-1" },
      { method: "POST", url: "/api/project-chat/threads/thread-1/messages", payload: { content: "Nope" } },
      { method: "POST", url: "/api/project-chat/threads/thread-1/stop" },
      { method: "POST", url: "/api/project-chat/threads/thread-1/tool-approval", payload: { approvalId: "a", approved: true } },
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Unauthorized" });
    }
  });

  it("uses the local user sentinel in solo mode", async () => {
    const solo = await build(false);
    try {
      await storage.projects.create({ id: "local-project", name: "Local", path: "/tmp/local" });
      const response = await solo.inject({
        method: "POST",
        url: "/api/projects/local-project/project-chat/threads",
        payload: {},
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().thread.user_id).toBe("local");
    } finally {
      await solo.close();
    }
  });
});
