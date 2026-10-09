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

describe("task hierarchy (parent_id)", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;

  beforeEach(async () => {
    auth.userId = "user-1";
    dir = mkdtempSync(path.join(tmpdir(), "vdx-task-tree-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "Mine", path: "/mine" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Theirs", path: "/theirs" }, "user-2");
    await storage.tasks.create({ id: "goal", project_id: "project-1", title: "Goal" });
    await storage.tasks.create({ id: "step", project_id: "project-1", title: "Step", parent_id: "goal" });
    await storage.tasks.create({ id: "foreign", project_id: "project-2", title: "Theirs" });
    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    app.decorate("eventBus", { emit: () => {} } as never);
    app.decorate("retentionHolds", {} as never);
    await app.register(taskRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const create = (parent_id: unknown) => app.inject({
    method: "POST",
    url: "/api/projects/project-1/tasks",
    payload: { title: "New", description: "d", parent_id },
  });
  const move = (id: string, parent_id: unknown) => app.inject({
    method: "PUT",
    url: `/api/tasks/${id}`,
    payload: { parent_id },
  });

  it("creates a task under a parent in the same project", async () => {
    const response = await create("step");
    expect(response.statusCode).toBe(201);
    expect(response.json().task.parent_id).toBe("step");
  });

  it.each([["foreign"], ["missing"], [42]])("refuses parent %s", async (parent) => {
    const response = await create(parent);
    expect(response.statusCode).toBe(400);
  });

  it("moves a task to another parent and back to the top level", async () => {
    await storage.tasks.create({ id: "other", project_id: "project-1", title: "Other" });
    expect((await move("step", "other")).json().task.parent_id).toBe("other");
    expect((await move("step", null)).json().task.parent_id).toBeNull();
  });

  it("refuses to nest a task under itself or its own descendant", async () => {
    expect((await move("goal", "goal")).statusCode).toBe(400);
    expect((await move("goal", "step")).statusCode).toBe(400);
    expect((await storage.tasks.getById("goal"))?.parent_id).toBeNull();
  });

  it("leaves an edit without parent_id alone", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/tasks/step", payload: { title: "Renamed" } });
    expect(response.json().task).toMatchObject({ title: "Renamed", parent_id: "goal" });
  });

  it("lifts the sub-tasks of a deleted task to the top level", async () => {
    expect((await app.inject({ method: "DELETE", url: "/api/tasks/goal" })).statusCode).toBe(200);
    expect((await storage.tasks.getById("step"))?.parent_id).toBeNull();
  });
});
