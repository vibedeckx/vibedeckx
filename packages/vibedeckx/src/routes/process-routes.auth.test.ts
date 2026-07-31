import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const auth = vi.hoisted(() => ({ userId: "owner" as string | null }));
vi.mock("@clerk/fastify", () => ({ getAuth: () => ({ userId: auth.userId }), clerkClient: {} }));

import processRoutes from "./process-routes.js";

describe("POST /api/path/execute authorization", () => {
  let app: FastifyInstance;
  const start = vi.fn(async () => "pid");

  async function makeApp(project?: { id: string; path: string; user_id: string }) {
    app = Fastify();
    app.decorate("authEnabled", true);
    app.decorate("storage", {
      projects: {
        getByPath: async (value: string) => project?.path === value ? project : undefined,
        getById: async (id: string, userId?: string) => project?.id === id && project.user_id === userId ? project : undefined,
      },
    });
    app.decorate("processManager", { start, get: vi.fn(), stop: vi.fn() });
    app.decorate("reverseConnectManager", { isConnected: () => false });
    app.decorate("remoteExecutorMap", new Map());
    app.decorate("remoteExecutorMonitor", { watch: vi.fn() });
    app.decorate("eventBus", { emit: vi.fn() });
    await app.register(processRoutes);
  }

  afterEach(async () => { start.mockClear(); await app?.close(); auth.userId = "owner"; });

  it("authenticates before looking up or starting a process", async () => {
    auth.userId = null;
    await makeApp({ id: "p", path: "/repo", user_id: "owner" });
    const response = await app.inject({ method: "POST", url: "/api/path/execute", payload: { path: "/repo", command: "echo ok" } });
    expect(response.statusCode).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it("does not disclose or execute another user's path", async () => {
    await makeApp({ id: "p", path: "/repo", user_id: "other" });
    const response = await app.inject({ method: "POST", url: "/api/path/execute", payload: { path: "/repo", command: "echo ok" } });
    expect(response.statusCode).toBe(404);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts within an existing owned path project", async () => {
    await makeApp({ id: "p", path: "/repo", user_id: "owner" });
    const response = await app.inject({ method: "POST", url: "/api/path/execute", payload: { path: "/repo", command: "echo ok", processId: "schedule-run-1" } });
    expect(response.statusCode).toBe(200);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ project_id: "p", command: "echo ok" }), "/repo", true, "schedule-run-1", undefined);
  });
});
