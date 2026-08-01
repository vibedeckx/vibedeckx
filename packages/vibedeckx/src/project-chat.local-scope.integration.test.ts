import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";

import { ProjectChatManager, type ProjectChatModelRunner } from "./project-chat-manager.js";
import projectActivityRoutes from "./routes/project-activity-routes.js";
import projectChatRoutes from "./routes/project-chat-routes.js";
import projectRoutes from "./routes/project-routes.js";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";

async function waitForTurnEnd(
  manager: ProjectChatManager,
  threadId: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await manager.openThread(threadId, "local");
    if (snapshot.messages.some(({ type }) => type === "turn_end")) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the local Project Chat turn");
}

describe("Project Chat local user scope", () => {
  let directory: string | undefined;
  let storage: Storage | undefined;
  let manager: ProjectChatManager | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    await manager?.shutdown();
    await storage?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("runs tools for a project created through the no-auth production route", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "vdx-project-chat-local-scope-"));
    storage = await createSqliteStorage(path.join(directory, "test.sqlite"));

    const runner = {
      run: vi.fn(async function* (input) {
        if (!input.tools) throw new Error("Project Chat tools were not configured");
        const result = await input.tools.list_tasks.execute({});
        yield { type: "assistant" as const, content: `Found ${result.items.length} tasks.` };
      }),
    } satisfies ProjectChatModelRunner;
    manager = new ProjectChatManager(storage, runner, {
      toolDependencies: {
        agentSessionManager: {
          getMessages: () => [],
          getSessionProcessAlive: () => false,
        },
      },
      reconciliationIntervalMs: 60_000,
    });
    await manager.ready();

    app = Fastify({ logger: false });
    app.decorate("authEnabled", false);
    app.decorate("storage", storage);
    app.decorate("projectChatManager", manager);
    await app.register(projectRoutes);
    await app.register(projectActivityRoutes);
    await app.register(projectChatRoutes);
    await app.ready();

    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Local project", path: "/tmp/local-project" },
    });
    expect(projectResponse.statusCode).toBe(201);
    const projectId = projectResponse.json().project.id as string;
    await storage.projects.create({
      id: "authenticated-project",
      name: "Must stay private",
      path: "/tmp/authenticated-project",
    }, "authenticated-user");

    const listResponse = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().projects.map(({ id }: { id: string }) => id)).toEqual([projectId]);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/projects/authenticated-project" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/activity` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/projects/authenticated-project/activity" })).statusCode).toBe(404);

    const threadResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/project-chat/threads`,
      payload: { message: "Summarize the tasks", createRequestId: "local-scope-turn" },
    });
    expect(threadResponse.statusCode).toBe(201);
    expect(threadResponse.json().thread.user_id).toBe("local");

    const snapshot = await waitForTurnEnd(manager, threadResponse.json().thread.id as string);
    expect(runner.run).toHaveBeenCalledOnce();
    expect(snapshot.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "assistant", content: "Found 0 tasks." }),
    ]));
    expect(snapshot.messages.some(({ type, content }) =>
      type === "error" && content.includes("Project not found"))).toBe(false);
    await expect(storage.projects.getById(projectId, "local")).resolves.toBeDefined();
  });

  it("backfills legacy blank-owner projects so local Project Chat can still use them", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "vdx-project-chat-legacy-local-scope-"));
    const databasePath = path.join(directory, "test.sqlite");
    storage = await createSqliteStorage(databasePath);
    await storage.projects.create({
      id: "legacy-local-project",
      name: "Legacy local project",
      path: "/tmp/legacy-local-project",
    });
    await storage.close();
    storage = undefined;

    const legacyDb = new Database(databasePath);
    legacyDb.prepare("UPDATE projects SET user_id = '' WHERE id = ?").run("legacy-local-project");
    legacyDb.close();

    storage = await createSqliteStorage(databasePath);
    await expect(storage.projects.getById("legacy-local-project", "local")).resolves.toBeDefined();

    const runner = {
      run: vi.fn(async function* (input) {
        if (!input.tools) throw new Error("Project Chat tools were not configured");
        const result = await input.tools.list_tasks.execute({});
        yield { type: "assistant" as const, content: `Legacy project has ${result.items.length} tasks.` };
      }),
    } satisfies ProjectChatModelRunner;
    manager = new ProjectChatManager(storage, runner, {
      toolDependencies: {
        agentSessionManager: {
          getMessages: () => [],
          getSessionProcessAlive: () => false,
        },
      },
      reconciliationIntervalMs: 60_000,
    });
    await manager.ready();

    app = Fastify({ logger: false });
    app.decorate("authEnabled", false);
    app.decorate("storage", storage);
    app.decorate("projectChatManager", manager);
    await app.register(projectChatRoutes);
    await app.ready();

    const threadResponse = await app.inject({
      method: "POST",
      url: "/api/projects/legacy-local-project/project-chat/threads",
      payload: { message: "Summarize the tasks", createRequestId: "legacy-local-scope-turn" },
    });
    expect(threadResponse.statusCode).toBe(201);
    const snapshot = await waitForTurnEnd(manager, threadResponse.json().thread.id as string);
    expect(snapshot.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "assistant", content: "Legacy project has 0 tasks." }),
    ]));
  });
});
