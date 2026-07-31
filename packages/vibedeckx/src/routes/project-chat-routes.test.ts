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
import { createSqliteStorage } from "../storage/sqlite.js";
import type { ProjectChatThread, Storage } from "../storage/types.js";

describe("project chat thread routes", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;

  async function build(authEnabled = true) {
    const instance = Fastify({ logger: false });
    instance.decorate("authEnabled", authEnabled);
    instance.decorate("storage", storage);
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
    it("creates a UUID thread and a trimmed first user message at sequence 1", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project-1/project-chat/threads",
        payload: { message: "  What changed?  " },
      });

      expect(response.statusCode).toBe(201);
      const { thread } = response.json() as { thread: ProjectChatThread };
      expect(thread).toMatchObject({ project_id: "project-1", user_id: "user-1", title: null });
      expect(thread.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(thread).not.toHaveProperty("branch");
      expect(thread).not.toHaveProperty("workspace");
      expect(await storage.projectChatMessages.listByThread(thread.id, "project-1", "user-1"))
        .toEqual([expect.objectContaining({ sequence: 1, type: "user", content: "What changed?" })]);
    });

    it("creates an empty thread when message is omitted", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project-1/project-chat/threads",
      });

      expect(response.statusCode).toBe(201);
      const { thread } = response.json() as { thread: ProjectChatThread };
      expect(await storage.projectChatMessages.listByThread(thread.id, "project-1", "user-1")).toEqual([]);
    });

    it("rejects malformed create payloads", async () => {
      const invalidPayloads = [
        { message: "" },
        { message: "   " },
        { message: 3 },
        { message: "x".repeat(100_001) },
        { unexpected: true },
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

    it("does not leave an empty thread behind when first-message persistence fails", async () => {
      storage.projectChatMessages.append = vi.fn().mockRejectedValue(new Error("write failed"));

      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project-1/project-chat/threads",
        payload: { message: "hello" },
      });

      expect(response.statusCode).toBe(500);
      expect(await storage.projectChatThreads.listByProject("project-1", "user-1", 100)).toEqual([]);
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
    it("gets an owned thread", async () => {
      await createThread({ title: "Status" });

      const response = await app.inject({ method: "GET", url: "/api/project-chat/threads/thread-1" });

      expect(response.statusCode).toBe(200);
      expect(response.json().thread).toMatchObject({ id: "thread-1", title: "Status" });
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
      expect(await storage.projectChatThreads.getById("thread-1", "project-1", "user-1")).toBeUndefined();
      expect(await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1")).toEqual([]);
      expect(await storage.projectChatContextRefs.listByThread("thread-1", "project-1", "user-1")).toEqual([]);
    });

    it("does not delete a foreign thread", async () => {
      await createThread({ id: "theirs", user_id: "user-2" });

      const response = await app.inject({ method: "DELETE", url: "/api/project-chat/threads/theirs" });

      expect(response.statusCode).toBe(404);
      expect(await storage.projectChatThreads.getById("theirs", "project-1", "user-2")).toBeDefined();
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
