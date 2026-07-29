import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// The remote branch of the model route proxies to the worker; stub the layer
// it forwards to so no test makes a network call. `proxyStatus` stays the
// passthrough the real one is.
const { proxyToRemoteAuto } = vi.hoisted(() => ({
  proxyToRemoteAuto: vi.fn(async () => ({
    ok: true,
    status: 200,
    data: { success: true, model: "gpt-5.6-sol" },
  })),
}));
vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, proxyToRemoteAuto, proxyStatus: (r: { status: number }) => r.status };
});

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
    expect(providers.find((p) => p.type === "claude-code")?.models).toEqual([
      "opus",
      "sonnet",
      "haiku",
      "fable",
    ]);
    expect(providers.find((p) => p.type === "codex")?.models).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
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

/**
 * POST /api/agent-sessions/:sessionId/model — what makes a branched (or
 * otherwise unspawned) session's model changeable. The manager owns the rule
 * about when a change is allowed; the route's own job is validating the body,
 * gating on ownership, proxying remotes, and reporting the verdict.
 */
function makeModelApp(overrides?: {
  outcome?: "ok" | "not_found" | "busy" | "error";
  sessionRow?: { project_id: string } | undefined;
  project?: { id: string } | undefined;
  storedModel?: string | null;
}) {
  const sessionRow = overrides && "sessionRow" in overrides ? overrides.sessionRow : { project_id: "p1" };
  const project = overrides && "project" in overrides ? overrides.project : { id: "p1" };
  const setModel = vi.fn(async () => overrides?.outcome ?? "ok");

  const app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    projects: { getById: async () => project },
    agentSessions: { getById: async () => sessionRow },
  });
  app.decorate("agentSessionManager", {
    setModel,
    getSession: () => ({ model: overrides?.storedModel ?? null }),
  });
  const remoteSessionMap = new Map();
  app.decorate("remoteSessionMap", remoteSessionMap);
  app.decorate("remotePatchCache", {});
  app.decorate("reverseConnectManager", null);

  return { app, setModel, remoteSessionMap };
}

describe("POST /api/agent-sessions/:sessionId/model", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); proxyToRemoteAuto.mockClear(); });

  const post = (payload: unknown, sessionId = "s1") =>
    app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/model`, payload });

  it("sets the model and answers with what was stored", async () => {
    // The manager normalizes (trim, blank → the CLI default), so the response
    // reads the session back instead of echoing the request.
    const h = makeModelApp({ storedModel: "sonnet" });
    app = h.app;
    await app.register(agentSessionRoutes);

    const res = await post({ model: "  sonnet  " });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, model: "sonnet" });
    expect(h.setModel).toHaveBeenCalledWith("s1", "  sonnet  ");
  });

  it("passes an explicit null through as the CLI default", async () => {
    const h = makeModelApp({ storedModel: null });
    app = h.app;
    await app.register(agentSessionRoutes);

    const res = await post({ model: null });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, model: null });
    expect(h.setModel).toHaveBeenCalledWith("s1", null);
  });

  it("rejects a body with no model field at all", async () => {
    // Not the same as null: a caller that forgot the field would otherwise
    // silently clear the session's model.
    const h = makeModelApp();
    app = h.app;
    await app.register(agentSessionRoutes);

    const res = await post({});

    expect(res.statusCode).toBe(400);
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it("rejects a model that isn't a string", async () => {
    const h = makeModelApp();
    app = h.app;
    await app.register(agentSessionRoutes);

    const res = await post({ model: 42 });

    expect(res.statusCode).toBe(400);
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it("reports 409 when the manager refuses a change mid-turn", async () => {
    const h = makeModelApp({ outcome: "busy" });
    app = h.app;
    await app.register(agentSessionRoutes);

    const res = await post({ model: "sonnet" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("running");
  });

  it("reports 500 and says the session kept its model when the write failed", async () => {
    // The manager rolls back, so the caller's chip is still correct — the
    // message has to say that rather than leave the UI guessing whether the
    // change half-landed.
    const h = makeModelApp({ outcome: "error" });
    app = h.app;
    await app.register(agentSessionRoutes);

    const res = await post({ model: "sonnet" });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("kept its current one");
  });

  it("404s a session id that names no session, without touching the manager", async () => {
    const h = makeModelApp({ sessionRow: undefined });
    app = h.app;
    await app.register(agentSessionRoutes);

    const res = await post({ model: "sonnet" });

    expect(res.statusCode).toBe(404);
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it("404s a session whose project the caller doesn't own", async () => {
    // Under --auth the project lookup is user-scoped. Without this gate a bare
    // session id would be enough to re-model someone else's agent.
    const h = makeModelApp({ project: undefined });
    app = h.app;
    await app.register(agentSessionRoutes);

    const res = await post({ model: "sonnet" });

    expect(res.statusCode).toBe(404);
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it("proxies a remote session to its worker and returns the worker's answer", async () => {
    const h = makeModelApp();
    app = h.app;
    // Wrapped id layout: remote-{serverId}-{projectId}-{remoteSessionId}
    h.remoteSessionMap.set("remote-srvA-p1-rs1", {
      remoteServerId: "srvA",
      remoteUrl: "http://a",
      remoteApiKey: "k",
      remoteSessionId: "rs1",
      branch: "feature",
    });
    await app.register(agentSessionRoutes);

    const res = await post({ model: "gpt-5.6-sol" }, "remote-srvA-p1-rs1");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, model: "gpt-5.6-sol" });
    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      "srvA",
      "http://a",
      "k",
      "POST",
      "/api/agent-sessions/rs1/model",
      { model: "gpt-5.6-sol" },
      expect.anything(),
    );
    // A remote session belongs to the worker's manager, not to this one.
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it("404s a remote id with no mapping rather than proxying blind", async () => {
    const h = makeModelApp();
    app = h.app;
    await app.register(agentSessionRoutes);

    const res = await post({ model: "gpt-5.6-sol" }, "remote-srvA-p1-rs1");

    expect(res.statusCode).toBe(404);
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });
});
