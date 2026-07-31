import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.userId }),
  clerkClient: {},
}));

import agentSessionRoutes from "./agent-session-routes.js";

describe("path agent session preallocated identity", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  function makeApp(authEnabled = false) {
    let row: Record<string, unknown> | undefined;
    let running: Record<string, unknown> | undefined;
    const projects = new Map<string, Record<string, unknown>>();
    const deliveries = new Map<string, { hash: string; status: "pending" | "sent"; token: string | null }>();
    const sendUserMessage = vi.fn(async () => true);
    const createNewSession = vi.fn(async (
      projectId: string, branch: string | null, projectPath: string, _skipDb: boolean,
      permissionMode: string, agentType: string, _announce: boolean, _force: boolean,
      opts: { sessionId?: string; model?: string | null },
    ) => {
      const id = opts.sessionId!;
      row = { id, project_id: projectId, branch: branch ?? "", status: "running", permission_mode: permissionMode, agent_type: agentType, model: opts.model ?? null };
      running = { id, projectId, branch, permissionMode, agentType, model: opts.model ?? null, status: "running", projectPath };
      return id;
    });
    app = Fastify();
    app.decorate("authEnabled", authEnabled);
    app.decorate("storage", {
      projects: {
        getById: async (id: string, userId?: string) => {
          const project = projects.get(id);
          return project && (!userId || project.user_id === userId) ? project : undefined;
        },
        getByPath: async (path: string) => [...projects.values()].find((project) => project.path === path),
        create: async (project: Record<string, unknown>, userId?: string) => {
          const stored = { ...project, user_id: userId ?? "" };
          projects.set(project.id as string, stored);
          return stored;
        },
      },
      agentSessions: { getById: async (id: string) => row?.id === id ? row : undefined },
      agentInstructionDeliveries: {
        claim: async ({ sessionId, idempotencyKey, contentHash, claimToken }: {
          sessionId: string; idempotencyKey: string; contentHash: string; claimToken: string;
        }) => {
          const key = `${sessionId}:${idempotencyKey}`;
          const current = deliveries.get(key);
          if (!current) {
            deliveries.set(key, { hash: contentHash, status: "pending", token: claimToken });
            return "claimed";
          }
          if (current.hash !== contentHash) return "conflict";
          if (current.status === "sent") return "sent";
          if (current.token === claimToken) return "busy";
          current.token = claimToken;
          return "claimed";
        },
        markSent: async ({ sessionId, idempotencyKey, claimToken }: {
          sessionId: string; idempotencyKey: string; claimToken: string;
        }) => {
          const row = deliveries.get(`${sessionId}:${idempotencyKey}`);
          if (!row || row.token !== claimToken) return false;
          row.status = "sent";
          return true;
        },
        release: async ({ sessionId, idempotencyKey, claimToken }: {
          sessionId: string; idempotencyKey: string; claimToken: string;
        }) => {
          const row = deliveries.get(`${sessionId}:${idempotencyKey}`);
          if (row?.token === claimToken) row.token = null;
        },
      },
    });
    app.decorate("agentSessionManager", {
      createNewSession,
      getSession: (id: string) => running?.id === id ? running : null,
      getSessionProcessAlive: (id: string) => running?.id === id,
      getMessages: () => [],
      sendUserMessage,
      emitBranchActivityIfChanged: vi.fn(),
    });
    app.decorate("remoteSessionMap", new Map());
    app.decorate("remotePatchCache", {});
    app.decorate("reverseConnectManager", null);
    app.decorate("workflowEngine", { handleExternalUserMessage: vi.fn(async () => undefined) });
    app.decorate("remoteNotificationSync", { prepareForNewTurn: vi.fn(async () => true) });
    return {
      createNewSession,
      sendUserMessage,
      projects,
      setStored: (nextRow: Record<string, unknown>, nextRunning?: Record<string, unknown>) => {
        row = nextRow;
        running = nextRunning;
      },
    };
  }

  it("reuses an exact preallocated worker session after the frontend lost its mapping", async () => {
    const { createNewSession } = makeApp();
    await app.register(agentSessionRoutes);
    const payload = {
      path: "/repo", branch: "dev", permissionMode: "edit", agentType: "claude-code",
      sessionId: "preallocated", model: "opus",
    };

    const first = await app.inject({ method: "POST", url: "/api/path/agent-sessions/new", payload });
    const retry = await app.inject({ method: "POST", url: "/api/path/agent-sessions/new", payload });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ session: { id: "preallocated", projectId: "path:/repo", branch: "dev" }, messages: [] });
    expect(createNewSession).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a preallocated ID from another path or branch", async () => {
    const { createNewSession, setStored } = makeApp();
    setStored(
      { id: "preallocated", project_id: "path:/other", branch: "main", status: "running", permission_mode: "edit", agent_type: "claude-code", model: null },
      { id: "preallocated", projectId: "path:/other", branch: "main", permissionMode: "edit", agentType: "claude-code", model: null, status: "running", projectPath: "/other" },
    );
    await app.register(agentSessionRoutes);

    const response = await app.inject({
      method: "POST", url: "/api/path/agent-sessions/new",
      payload: { path: "/repo", branch: "dev", sessionId: "preallocated" },
    });

    expect(response.statusCode).toBe(409);
    expect(createNewSession).not.toHaveBeenCalled();
  });

  it("requires authentication before creating a path project or session", async () => {
    auth.userId = null;
    const { createNewSession, projects } = makeApp(true);
    await app.register(agentSessionRoutes);

    const response = await app.inject({
      method: "POST", url: "/api/path/agent-sessions/new",
      payload: { path: "/repo", sessionId: "worker-id" },
    });

    expect(response.statusCode).toBe(401);
    expect(projects.size).toBe(0);
    expect(createNewSession).not.toHaveBeenCalled();
  });

  it("creates path projects for the authenticated owner", async () => {
    auth.userId = "user-1";
    const { projects } = makeApp(true);
    await app.register(agentSessionRoutes);

    const response = await app.inject({
      method: "POST", url: "/api/path/agent-sessions/new",
      payload: { path: "/repo", sessionId: "worker-id" },
    });

    expect(response.statusCode).toBe(200);
    expect(projects.get("path:/repo")).toMatchObject({ user_id: "user-1" });
  });

  it("does not reuse another user's project found by path", async () => {
    auth.userId = "user-1";
    const { createNewSession, projects } = makeApp(true);
    projects.set("foreign", { id: "foreign", path: "/repo", user_id: "user-2" });
    await app.register(agentSessionRoutes);

    const response = await app.inject({
      method: "POST", url: "/api/path/agent-sessions/new",
      payload: { path: "/repo", sessionId: "worker-id" },
    });

    expect(response.statusCode).toBe(404);
    expect(createNewSession).not.toHaveBeenCalled();
  });

  it("does not deliver a local message to another user's stored session", async () => {
    auth.userId = "user-1";
    const { sendUserMessage, projects, setStored } = makeApp(true);
    projects.set("foreign", { id: "foreign", path: "/other", user_id: "user-2" });
    setStored(
      { id: "foreign-session", project_id: "foreign", branch: "main", status: "running" },
      { id: "foreign-session", projectId: "foreign", branch: "main", status: "running" },
    );
    await app.register(agentSessionRoutes);

    const response = await app.inject({
      method: "POST", url: "/api/agent-sessions/foreign-session/message",
      payload: { content: "do not deliver" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Session not found or not running" });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("rehydrates a matching stored-only preallocated session", async () => {
    auth.userId = "user-1";
    const { createNewSession, setStored } = makeApp(true);
    setStored({
      id: "worker-id", project_id: "path:/repo", branch: "dev", status: "running",
      permission_mode: "edit", agent_type: "claude-code", model: "opus",
    });
    await app.register(agentSessionRoutes);

    const response = await app.inject({
      method: "POST", url: "/api/path/agent-sessions/new",
      payload: { path: "/repo", branch: "dev", sessionId: "worker-id", model: "opus" },
    });

    expect(response.statusCode).toBe(200);
    expect(createNewSession).toHaveBeenCalledTimes(1);
    expect(createNewSession.mock.calls[0]?.[8]).toMatchObject({ sessionId: "worker-id" });
  });

  it("rehydrates a stopped zero-entry worker session with the same identity", async () => {
    auth.userId = "user-1";
    const { createNewSession, projects, setStored } = makeApp(true);
    projects.set("path:/repo", { id: "path:/repo", path: "/repo", user_id: "user-1" });
    setStored({
      id: "worker-id", project_id: "path:/repo", branch: "dev", status: "stopped",
      permission_mode: "edit", agent_type: "claude-code", model: null,
    });
    await app.register(agentSessionRoutes);
    const response = await app.inject({ method: "POST", url: "/api/path/agent-sessions/new",
      payload: { path: "/repo", branch: "dev", sessionId: "worker-id" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().session.id).toBe("worker-id");
    expect(createNewSession).toHaveBeenCalledTimes(1);
  });

  it("delivers concurrent requests with the same stable key exactly once", async () => {
    const { sendUserMessage } = makeApp();
    await app.register(agentSessionRoutes);
    await app.inject({
      method: "POST", url: "/api/path/agent-sessions/new",
      payload: { path: "/repo", sessionId: "worker-id" },
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    sendUserMessage.mockImplementation(async () => { await blocked; return true; });

    const first = app.inject({
      method: "POST", url: "/api/agent-sessions/worker-id/message",
      payload: { content: "Implement", idempotencyKey: "delivery-1" },
    });
    const second = app.inject({
      method: "POST", url: "/api/agent-sessions/worker-id/message",
      payload: { content: "Implement", idempotencyKey: "delivery-1" },
    });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1));
    release();

    const responses = await Promise.all([first, second]);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a stable delivery key with different content", async () => {
    const { sendUserMessage } = makeApp();
    await app.register(agentSessionRoutes);
    await app.inject({
      method: "POST", url: "/api/path/agent-sessions/new",
      payload: { path: "/repo", sessionId: "worker-id" },
    });
    const first = await app.inject({ method: "POST", url: "/api/agent-sessions/worker-id/message",
      payload: { content: "One", idempotencyKey: "delivery-1" } });
    const conflict = await app.inject({ method: "POST", url: "/api/agent-sessions/worker-id/message",
      payload: { content: "Two", idempotencyKey: "delivery-1" } });

    expect(first.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });
});
