import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import taskRoutes from "./task-routes.js";
import scheduleRoutes from "./schedule-routes.js";
import fileRoutes from "./file-routes.js";
import browserRoutes from "./browser-routes.js";
import projectRemoteRoutes from "./project-remote-routes.js";
import agentSessionRoutes from "./agent-session-routes.js";
import browserProxyRoutes from "./browser-proxy-routes.js";

describe("no-auth user-facing project child routes", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let localPath: string;
  const getBrowserSession = vi.fn((projectId: string) => (
    projectId === "local-project" ? { projectId, status: "running" } : undefined
  ));
  const getAgentSession = vi.fn(() => undefined);
  const getSessionProcessAlive = vi.fn(() => false);

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-user-project-scope-"));
    localPath = path.join(dir, "local-project");
    const authenticatedPath = path.join(dir, "authenticated-project");
    await import("fs/promises").then(({ mkdir }) => Promise.all([
      mkdir(localPath), mkdir(authenticatedPath),
    ]));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({
      id: "local-project", name: "Local", path: localPath,
    });
    await storage.projects.create({
      id: "authenticated-project", name: "Private", path: authenticatedPath,
    }, "authenticated-user");
    await storage.tasks.create({ id: "local-task", project_id: "local-project", title: "Local" });
    await storage.tasks.create({ id: "private-task", project_id: "authenticated-project", title: "Private" });
    await storage.agentSessions.create({ id: "local-session", project_id: "local-project", branch: "" });
    await storage.agentSessions.create({ id: "private-session", project_id: "authenticated-project", branch: "" });
    await storage.scheduledTasks.create({
      id: "local-schedule", project_id: "local-project", name: "Local", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
    });
    await storage.scheduledTasks.create({
      id: "private-schedule", project_id: "authenticated-project", name: "Private", cron_expr: "0 * * * *",
      timezone: "UTC", run_type: "command", content: "true", cwd_mode: "project",
    });

    getBrowserSession.mockClear();
    getAgentSession.mockClear();
    getSessionProcessAlive.mockClear();
    app = Fastify({ logger: false });
    app.decorate("authEnabled", false);
    app.decorate("storage", storage);
    app.decorate("scheduler", {
      nextRunAt: vi.fn(() => null), isRunning: vi.fn(() => false),
    });
    app.decorate("browserManager", { getSession: getBrowserSession });
    app.decorate("agentSessionManager", {
      getSession: getAgentSession, getSessionProcessAlive,
    });
    app.decorate("remoteSessionMap", new Map());
    app.decorate("remotePatchCache", {});
    app.decorate("reverseConnectManager", null);
    await app.register(fastifyWebsocket);
    await app.register(taskRoutes);
    await app.register(scheduleRoutes);
    await app.register(fileRoutes);
    await app.register(browserRoutes);
    await app.register(projectRemoteRoutes);
    await app.register(agentSessionRoutes);
    await app.register(browserProxyRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["task", "/api/projects/authenticated-project/tasks"],
    ["agent session", "/api/projects/authenticated-project/agent-sessions?branch="],
    ["schedule", "/api/projects/authenticated-project/schedules"],
    ["file", "/api/projects/authenticated-project/browse"],
    ["browser", "/api/projects/authenticated-project/browser"],
    ["remote", "/api/projects/authenticated-project/remotes"],
    ["browser proxy", "/api/projects/authenticated-project/browser/proxy/http%3A%2F%2F127.0.0.1%3A1%2F"],
  ])("returns 404 without side effects for an authenticated project's %s route", async (_kind, url) => {
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode, response.body).toBe(404);
    expect(getBrowserSession).not.toHaveBeenCalled();
    expect(getAgentSession).not.toHaveBeenCalled();
    expect(getSessionProcessAlive).not.toHaveBeenCalled();
  });

  it("keeps the same representative routes available for a legitimate local project", async () => {
    const urls = [
      "/api/projects/local-project/tasks",
      "/api/projects/local-project/agent-sessions?branch=",
      "/api/projects/local-project/schedules",
      "/api/projects/local-project/browse",
      "/api/projects/local-project/browser",
      "/api/projects/local-project/remotes",
    ];

    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    }
    expect(getBrowserSession).toHaveBeenCalledWith("local-project");
  });
});
