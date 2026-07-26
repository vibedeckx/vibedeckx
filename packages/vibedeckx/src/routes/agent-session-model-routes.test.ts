import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import agentSessionRoutes from "./agent-session-routes.js";

const SESSION_ID = "created-session";

function makeApp() {
  // Records the createNewSession opts so the model's journey into the manager
  // can be asserted without spawning anything.
  const createNewSession = vi.fn(async () => SESSION_ID);
  let created: { model?: string | null } = {};

  const app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    // agent_mode: "local" is required so the route takes the local create path
    // (asserted via the directly-mocked agentSessionManager.createNewSession)
    // instead of the remote-proxy branch, which needs storage.projectRemotes —
    // not decorated here since these tests target local creation.
    projects: { getById: async () => ({ id: "p1", path: "/tmp/p1", agent_mode: "local" }) },
    agentSessions: { getById: async () => ({ id: SESSION_ID, project_id: "p1" }) },
  });
  app.decorate("agentSessionManager", {
    createNewSession: vi.fn(async (...args: unknown[]) => {
      created = (args[8] ?? {}) as { model?: string | null };
      return SESSION_ID;
    }),
    getSession: () => ({
      id: SESSION_ID,
      projectId: "p1",
      branch: null,
      status: "running",
      permissionMode: "edit",
      agentType: "claude-code",
      model: created.model ?? null,
    }),
    getMessages: () => [],
    getSessionProcessAlive: () => true,
  });
  app.decorate("remoteSessionMap", new Map());
  app.decorate("remotePatchCache", {});
  app.decorate("reverseConnectManager", null);

  return { app, createNewSession, opts: () => created };
}

describe("agent session model routes", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  it("GET /api/agent-providers returns a suggestion list per provider", async () => {
    ({ app } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({ method: "GET", url: "/api/agent-providers" });

    expect(res.statusCode).toBe(200);
    const providers = res.json().providers as Array<{ type: string; models: string[] }>;
    expect(providers.find((p) => p.type === "claude-code")?.models).toEqual(["opus", "sonnet", "haiku"]);
    expect(providers.find((p) => p.type === "codex")?.models.length).toBeGreaterThan(0);
  });

  it("passes the model into createNewSession and echoes it back", async () => {
    let opts: () => { model?: string | null };
    ({ app, opts } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/agent-sessions/new",
      payload: { branch: null, permissionMode: "edit", agentType: "claude-code", model: "opus" },
    });

    expect(res.statusCode).toBe(200);
    expect(opts().model).toBe("opus");
    expect(res.json().session.model).toBe("opus");
  });

  it("accepts a model the CLI will reject (no server-side validation)", async () => {
    let opts: () => { model?: string | null };
    ({ app, opts } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/agent-sessions/new",
      payload: { branch: null, model: "not-a-real-model" },
    });

    expect(res.statusCode).toBe(200);
    expect(opts().model).toBe("not-a-real-model");
  });

  it("omitting the model yields a null model", async () => {
    ({ app } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/agent-sessions/new",
      payload: { branch: null },
    });

    expect(res.json().session.model ?? null).toBeNull();
  });
});
