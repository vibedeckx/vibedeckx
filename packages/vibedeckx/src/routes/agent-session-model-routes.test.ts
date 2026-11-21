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

import { getProvider } from "../providers/index.js";
import agentSessionRoutes from "./agent-session-routes.js";
import { clearMachineModelCache } from "../machine-models.js";

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
    stopSession: vi.fn(async () => true),
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

  it("the user Stop route stops the session", async () => {
    ({ app } = makeApp());
    await app.register(agentSessionRoutes);
    const res = await app.inject({ method: "POST", url: `/api/agent-sessions/${SESSION_ID}/stop` });
    expect(res.statusCode).toBe(200);
    expect(app.agentSessionManager.stopSession).toHaveBeenCalledWith(SESSION_ID);
  });

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
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  });

  it("lists fx without probing installation or sending installation hints", async () => {
    const detection = vi.spyOn(getProvider("fx"), "detectBinary").mockReturnValue(null);
    try {
      ({ app } = makeApp());
      await app.register(agentSessionRoutes);
      const res = await app.inject({ method: "GET", url: "/api/agent-providers" });
      expect(res.json().providers.find((p: { type: string }) => p.type === "fx")).toMatchObject({
        displayName: "fx",
        models: ["spacexai/grok-4.7", "openai/gpt-5.4-mini"],
      });
      expect(detection).not.toHaveBeenCalled();
      expect(res.json().providers.find((p: { type: string }) => p.type === "fx")).not.toHaveProperty("installHint");
      for (const provider of res.json().providers) {
        expect(provider).not.toHaveProperty("available");
      }
    } finally { detection.mockRestore(); }
  });

  describe("machine model listing", () => {
    afterEach(() => { clearMachineModelCache(); vi.restoreAllMocks(); proxyToRemoteAuto.mockClear(); });

    it("the machine route answers this machine's fx catalog", async () => {
      vi.spyOn(getProvider("fx"), "listModels").mockResolvedValue(["anthropic/claude-opus-5.5", "openai/gpt-5.4-mini"]);
      ({ app } = makeApp());
      await app.register(agentSessionRoutes);
      const res = await app.inject({ method: "GET", url: "/api/agent-providers/fx/models" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ models: ["anthropic/claude-opus-5.5", "openai/gpt-5.4-mini"], source: "machine" });
    });

    it("?refresh=1 skips the cache on the machine route", async () => {
      const list = vi.spyOn(getProvider("fx"), "listModels").mockResolvedValueOnce(["old/model"]).mockResolvedValueOnce(["new/model"]);
      ({ app } = makeApp());
      await app.register(agentSessionRoutes);
      await app.inject({ method: "GET", url: "/api/agent-providers/fx/models" });
      const cached = await app.inject({ method: "GET", url: "/api/agent-providers/fx/models" });
      expect(cached.json().models).toEqual(["old/model"]);
      const refreshed = await app.inject({ method: "GET", url: "/api/agent-providers/fx/models?refresh=1" });
      expect(refreshed.json().models).toEqual(["new/model"]);
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("rejects an unknown agent type", async () => {
      ({ app } = makeApp());
      await app.register(agentSessionRoutes);
      const res = await app.inject({ method: "GET", url: "/api/agent-providers/nope/models" });
      expect(res.statusCode).toBe(400);
    });

    it("a local project lists on the hub machine, for every agent type", async () => {
      vi.spyOn(getProvider("fx"), "listModels").mockResolvedValue(["x/local"]);
      vi.spyOn(getProvider("claude-code"), "listModels").mockResolvedValue(["opus", "claude-opus-5"]);
      vi.spyOn(getProvider("codex"), "listModels").mockResolvedValue(["gpt-6.2-sol"]);
      ({ app } = makeApp());
      await app.register(agentSessionRoutes);
      const fx = await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/fx/models" });
      expect(fx.json()).toMatchObject({ models: ["x/local"], source: "machine" });
      const claude = await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/claude-code/models" });
      expect(claude.json()).toMatchObject({ models: ["opus", "claude-opus-5"], source: "machine" });
      const codex = await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/codex/models" });
      expect(codex.json()).toMatchObject({ models: ["gpt-6.2-sol"], source: "machine" });
      expect(proxyToRemoteAuto).not.toHaveBeenCalled();
    });

    it("a CLI that cannot list falls back to that agent's suggestions", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(getProvider("claude-code"), "listModels").mockRejectedValue(new Error("claude is not installed"));
      ({ app } = makeApp());
      await app.register(agentSessionRoutes);
      const claude = await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/claude-code/models" });
      expect(claude.json()).toMatchObject({ models: ["opus", "sonnet", "haiku", "fable"], source: "suggestions" });
    });

    function remoteApp() {
      const made = makeApp();
      (made.app.storage.projects as { getById: unknown }).getById = async () => ({ id: "p1", path: null, agent_mode: "srv-1" });
      return made;
    }

    it("a remote project asks the worker that would spawn the session", async () => {
      proxyToRemoteAuto.mockResolvedValueOnce({ ok: true, status: 200, data: { models: ["y/remote"], source: "machine" } } as never);
      ({ app } = remoteApp());
      await app.register(agentSessionRoutes);
      const res = await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/fx/models" });
      expect(res.json()).toMatchObject({ models: ["y/remote"], source: "machine" });
      expect(proxyToRemoteAuto).toHaveBeenCalledWith("srv-1", "GET", "/api/agent-providers/fx/models", undefined, expect.anything());
    });

    it("an existing remote session lists on ITS worker, not the project's current target", async () => {
      // Project target is srv-1, but the session was created on srvA — the
      // model route sends the pick to srvA, so the list must come from srvA.
      proxyToRemoteAuto.mockResolvedValueOnce({ ok: true, status: 200, data: { models: ["a/only-on-srvA"], source: "machine" } } as never);
      ({ app } = remoteApp());
      app.remoteSessionMap.set("remote-srvA-p1-rs1", { remoteServerId: "srvA", remoteSessionId: "rs1", branch: null });
      await app.register(agentSessionRoutes);
      const res = await app.inject({ method: "GET", url: "/api/agent-sessions/remote-srvA-p1-rs1/agent-providers/fx/models" });
      expect(res.json()).toMatchObject({ models: ["a/only-on-srvA"], source: "machine" });
      expect(proxyToRemoteAuto).toHaveBeenCalledWith("srvA", "GET", "/api/agent-providers/fx/models", undefined, expect.anything());
    });

    it("forwards ?refresh=1 to the worker, and omits it otherwise", async () => {
      proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { models: ["y/remote"], source: "machine" } } as never);
      ({ app } = remoteApp());
      app.remoteSessionMap.set("remote-srvA-p1-rs1", { remoteServerId: "srvA", remoteSessionId: "rs1", branch: null });
      await app.register(agentSessionRoutes);
      await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/fx/models?refresh=1" });
      await app.inject({ method: "GET", url: "/api/agent-sessions/remote-srvA-p1-rs1/agent-providers/fx/models?refresh=1" });
      await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/fx/models" });
      expect(proxyToRemoteAuto.mock.calls.map((c) => [c[0], c[2]])).toEqual([
        ["srv-1", "/api/agent-providers/fx/models?refresh=1"],
        ["srvA", "/api/agent-providers/fx/models?refresh=1"],
        ["srv-1", "/api/agent-providers/fx/models"],
      ]);
      proxyToRemoteAuto.mockReset();
      proxyToRemoteAuto.mockImplementation(async () => ({ ok: true, status: 200, data: { success: true, model: "gpt-5.6-sol" } }));
    });

    it("an existing local session lists on the hub even when the project now targets a worker", async () => {
      vi.spyOn(getProvider("fx"), "listModels").mockResolvedValue(["x/hub"]);
      ({ app } = remoteApp());
      await app.register(agentSessionRoutes);
      const res = await app.inject({ method: "GET", url: `/api/agent-sessions/${SESSION_ID}/agent-providers/fx/models` });
      expect(res.json()).toMatchObject({ models: ["x/hub"], source: "machine" });
      expect(proxyToRemoteAuto).not.toHaveBeenCalled();
    });

    it("404s a session the caller cannot reach", async () => {
      ({ app } = makeApp());
      await app.register(agentSessionRoutes);
      const remote = await app.inject({ method: "GET", url: "/api/agent-sessions/remote-srvX-p1-nope/agent-providers/fx/models" });
      expect(remote.statusCode).toBe(404);
      (app.storage.agentSessions as { getById: unknown }).getById = async () => undefined;
      const local = await app.inject({ method: "GET", url: "/api/agent-sessions/missing/agent-providers/fx/models" });
      expect(local.statusCode).toBe(404);
      expect(proxyToRemoteAuto).not.toHaveBeenCalled();
    });

    it("passes the worker's expiresInMs through, and fills one in when it is missing", async () => {
      proxyToRemoteAuto
        .mockResolvedValueOnce({ ok: true, status: 200, data: { models: ["y/remote"], source: "machine", expiresInMs: 1234 } } as never)
        .mockResolvedValueOnce({ ok: true, status: 200, data: { models: ["y/remote"], source: "machine" } } as never);
      ({ app } = remoteApp());
      await app.register(agentSessionRoutes);
      const withExpiry = await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/fx/models" });
      expect(withExpiry.json()).toEqual({ models: ["y/remote"], source: "machine", expiresInMs: 1234 });
      const without = await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/fx/models" });
      expect(without.json().expiresInMs).toBe(60 * 60 * 1000);
    });

    it.each([
      { ok: false, status: 404, data: { error: "Not Found" } },
      { ok: false, status: 503, data: { error: "offline" } },
      { ok: true, status: 200, data: { models: "junk" } },
    ])("degrades to the suggestions when the worker cannot answer (%o)", async (reply) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      proxyToRemoteAuto.mockResolvedValueOnce(reply as never);
      ({ app } = remoteApp());
      await app.register(agentSessionRoutes);
      const res = await app.inject({ method: "GET", url: "/api/projects/p1/agent-providers/fx/models" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ models: ["spacexai/grok-4.7", "openai/gpt-5.4-mini"], source: "suggestions" });
    });
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
      remoteSessionId: "rs1",
      branch: "feature",
    });
    await app.register(agentSessionRoutes);

    const res = await post({ model: "gpt-5.6-sol" }, "remote-srvA-p1-rs1");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, model: "gpt-5.6-sol" });
    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      "srvA",
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
