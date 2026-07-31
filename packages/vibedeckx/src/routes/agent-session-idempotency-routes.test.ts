import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import agentSessionRoutes from "./agent-session-routes.js";

describe("path agent session preallocated identity", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  function makeApp() {
    let row: Record<string, unknown> | undefined;
    let running: Record<string, unknown> | undefined;
    const projects = new Map<string, Record<string, unknown>>();
    const createNewSession = vi.fn(async (
      projectId: string, branch: string | null, projectPath: string, _skipDb: boolean,
      permissionMode: string, agentType: string, _announce: boolean, _force: boolean,
      opts: { sessionId?: string; model?: string | null },
    ) => {
      const id = opts.sessionId!;
      row = { id, project_id: projectId, branch: branch ?? "", permission_mode: permissionMode, agent_type: agentType, model: opts.model ?? null };
      running = { id, projectId, branch, permissionMode, agentType, model: opts.model ?? null, status: "running", projectPath };
      return id;
    });
    app = Fastify();
    app.decorate("authEnabled", false);
    app.decorate("storage", {
      projects: {
        getById: async (id: string) => projects.get(id),
        getByPath: async (path: string) => [...projects.values()].find((project) => project.path === path),
        create: async (project: Record<string, unknown>) => { projects.set(project.id as string, project); return project; },
      },
      agentSessions: { getById: async (id: string) => row?.id === id ? row : undefined },
    });
    app.decorate("agentSessionManager", {
      createNewSession,
      getSession: (id: string) => running?.id === id ? running : null,
      getSessionProcessAlive: (id: string) => running?.id === id,
      getMessages: () => [],
    });
    app.decorate("remoteSessionMap", new Map());
    app.decorate("remotePatchCache", {});
    app.decorate("reverseConnectManager", null);
    return { createNewSession, setStored: (nextRow: Record<string, unknown>, nextRunning: Record<string, unknown>) => { row = nextRow; running = nextRunning; } };
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
      { id: "preallocated", project_id: "path:/other", branch: "main", permission_mode: "edit", agent_type: "claude-code", model: null },
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
});
