import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.userId }),
  clerkClient: {},
}));

import taskRoutes from "./task-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";

describe("project-scoped task read route", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;

  beforeEach(async () => {
    auth.userId = "user-1";
    dir = mkdtempSync(path.join(tmpdir(), "vdx-task-read-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "Mine", path: "/mine" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Theirs", path: "/theirs" }, "user-2");
    await storage.tasks.create({ id: "task-1", project_id: "project-1", title: "Mine" });
    await storage.tasks.create({ id: "task-2", project_id: "project-2", title: "Theirs" });
    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    await app.register(taskRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns exactly one authorized task scoped to the requested project", async () => {
    const response = await app.inject({ method: "GET", url: "/api/projects/project-1/tasks/task-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().task).toMatchObject({ id: "task-1", project_id: "project-1", title: "Mine" });
  });

  it.each([
    "/api/projects/project-1/tasks/task-2",
    "/api/projects/project-2/tasks/task-2",
    "/api/projects/project-1/tasks/missing",
  ])("does not reveal foreign, mismatched, or missing tasks at %s", async (url) => {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Task not found" });
  });
});
