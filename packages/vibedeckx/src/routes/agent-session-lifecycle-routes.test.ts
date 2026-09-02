import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.userId }),
  clerkClient: {},
}));
vi.mock("../cross-remote-mcp-config.js", () => ({
  mintCrossRemoteMcpConfig: async () => ({ url: "https://hub/mcp", token: "t" }),
}));

import lifecycleRoutes from "./agent-session-lifecycle-routes.js";
import type { SessionLifecycleView } from "../agent-session-lifecycle.js";

/**
 * Route contract (design §9.1): status codes from result kinds, purpose
 * never client-controlled beyond the interactive pair, by-id routes dispatch
 * on the `remote-` prefix, and authorization resolves pending rows through
 * the same project scope as everything else.
 */
describe("agent session lifecycle routes", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  const view = (over: Partial<SessionLifecycleView> = {}): SessionLifecycleView => ({
    sessionId: "s1", projectId: "p1", branch: null, state: "pending_first_turn", purpose: "interactive",
    leaseHeld: false, activationKey: null, activationAttempt: 0, activatedAt: null, activationErrorCode: null,
    userEntryIndex: null, expiredReason: null, expiredAt: null, pendingExpiresAt: null, ...over,
  });

  function makeApp(opts: { agentMode?: string } = {}) {
    const lifecycle = {
      prepare: vi.fn(async () => ({ kind: "prepared", view: view() })),
      start: vi.fn(async () => ({ kind: "activated", view: view({ state: "active" }) })),
      activate: vi.fn(async () => ({ kind: "replayed", view: view({ state: "active" }) })),
      cancel: vi.fn(async () => ({ kind: "cancelled", view: view({ state: "expired" }) })),
    };
    const remoteLifecycle = {
      prepare: vi.fn(async () => ({ kind: "prepared", view: view({ sessionId: "remote-srv-p1-r1" }) })),
      start: vi.fn(async () => ({ kind: "in_progress", view: view({ sessionId: "remote-srv-p1-r1" }) })),
      activate: vi.fn(async () => ({ kind: "uncertain", view: view({ sessionId: "remote-srv-p1-r1", state: "activation_uncertain" }) })),
      cancel: vi.fn(async () => ({ kind: "already_expired", view: view({ sessionId: "remote-srv-p1-r1", state: "expired" }) })),
    };
    const projects = new Map<string, Record<string, unknown>>([
      ["p1", { id: "p1", path: "/w", agent_mode: opts.agentMode ?? "local", user_id: "user-1" }],
    ]);
    app = Fastify();
    app.decorate("authEnabled", true);
    app.decorate("storage", {
      projects: {
        getById: async (id: string, userId?: string) => {
          const project = projects.get(id);
          return project && (!userId || project.user_id === userId) ? project : undefined;
        },
        getByPath: async () => undefined,
        create: async () => { throw new Error("unexpected create"); },
      },
      projectRemotes: { getByProjectAndServer: async () => ({ remote_path: "/remote/w" }) },
      agentSessions: {
        getActivityById: async (id: string) => (id === "s1" ? { projectId: "p1" } : undefined),
      },
      remoteSessionCreationIntents: {
        getByLocal: async (id: string) => (id === "remote-srv-p1-r1" ? { project_id: "p1" } : undefined),
      },
      remoteSessionMappings: { getByLocal: async () => undefined },
    });
    app.decorate("agentSessionLifecycle", lifecycle);
    app.decorate("remoteSessionMap", new Map());
    app.decorate("remotePatchCache", {});
    // The UI summary on activated/replayed/uncertain reads the local runtime;
    // a session not in the manager (remote, or already hibernated) falls back
    // to the request's own fields.
    app.decorate("agentSessionManager", {
      getSession: () => undefined,
      getSessionProcessAlive: () => false,
    });
    app.decorate("reverseConnectManager", null);
    app.decorate("eventBus", null);
    app.register(lifecycleRoutes, { remoteLifecycle: remoteLifecycle as never });
    return { lifecycle, remoteLifecycle };
  }

  it("project prepare/start dispatch locally with server-assigned purpose and map kinds to status", async () => {
    const { lifecycle } = makeApp();
    const prepared = await app.inject({ method: "POST", url: "/api/projects/p1/agent-sessions/prepare",
      payload: { operationId: "op-1", branch: "dev", agentType: "codex", purpose: "interactive_upload" } });
    expect(prepared.statusCode).toBe(201);
    expect(prepared.json()).toMatchObject({ kind: "prepared", lifecycle: { sessionId: "s1" } });
    expect(lifecycle.prepare).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "op-1", projectId: "p1", branch: "dev", agentType: "codex", purpose: "interactive_upload", permissionMode: "edit",
    }));

    const forbidden = await app.inject({ method: "POST", url: "/api/projects/p1/agent-sessions/prepare",
      payload: { operationId: "op-2", purpose: "workflow_review" } });
    expect(forbidden.statusCode).toBe(400);

    const started = await app.inject({ method: "POST", url: "/api/projects/p1/agent-sessions/start",
      payload: { operationId: "op-3", instruction: "hi", sessionId: "pre" } });
    expect(started.statusCode).toBe(201);
    // A real session carries the UI summary; the placeholder prepare above did not.
    expect(started.json().session).toMatchObject({ id: "s1", projectId: "p1", status: "running", processAlive: true });
    expect(prepared.json().session).toBeUndefined();
    expect(lifecycle.start).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "op-3", instruction: "hi", sessionId: "pre", purpose: "interactive", userId: "user-1",
      crossRemoteMcp: { url: "https://hub/mcp", token: "t" },
    }));

    expect((await app.inject({ method: "POST", url: "/api/projects/p1/agent-sessions/start", payload: { operationId: "op-4" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/projects/p1/agent-sessions/start", payload: { instruction: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/projects/nope/agent-sessions/prepare", payload: { operationId: "op-5" } })).statusCode).toBe(404);
  });

  it("remote projects go to the adapter with the association's path", async () => {
    const { remoteLifecycle, lifecycle } = makeApp({ agentMode: "srv" });
    const prepared = await app.inject({ method: "POST", url: "/api/projects/p1/agent-sessions/prepare", payload: { operationId: "op-1" } });
    expect(prepared.statusCode).toBe(201);
    expect(remoteLifecycle.prepare).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1", remoteServerId: "srv", remotePath: "/remote/w", operationId: "op-1", userId: "user-1",
    }));
    const started = await app.inject({ method: "POST", url: "/api/projects/p1/agent-sessions/start", payload: { operationId: "op-2", instruction: "go" } });
    expect(started.statusCode).toBe(202);
    expect(started.json().kind).toBe("in_progress");
    expect(lifecycle.prepare).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
  });

  it("by-id activate / preparation dispatch on the remote- prefix and authorize through the project", async () => {
    const { lifecycle, remoteLifecycle } = makeApp();
    const local = await app.inject({ method: "POST", url: "/api/agent-sessions/s1/activate", payload: { activationKey: "k", instruction: "x" } });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ kind: "replayed", lifecycle: { state: "active" } });
    expect(lifecycle.activate).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s1", activationKey: "k", instruction: "x", userId: "user-1", crossRemoteMcp: { url: "https://hub/mcp", token: "t" },
    }));

    const remote = await app.inject({ method: "POST", url: "/api/agent-sessions/remote-srv-p1-r1/activate", payload: { activationKey: "k", instruction: "x" } });
    expect(remote.statusCode).toBe(200);
    expect(remote.json()).toMatchObject({ kind: "uncertain", lifecycle: { state: "activation_uncertain" } });
    expect(remoteLifecycle.activate).toHaveBeenCalledWith(expect.objectContaining({ localSessionId: "remote-srv-p1-r1", activationKey: "k" }));

    expect((await app.inject({ method: "POST", url: "/api/agent-sessions/unknown/activate", payload: { activationKey: "k", instruction: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/agent-sessions/remote-srv-p1-other/activate", payload: { activationKey: "k", instruction: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/agent-sessions/s1/activate", payload: { instruction: "x" } })).statusCode).toBe(400);

    const cancelled = await app.inject({ method: "DELETE", url: "/api/agent-sessions/s1/preparation" });
    expect(cancelled.statusCode).toBe(200);
    expect(lifecycle.cancel).toHaveBeenCalledWith({ sessionId: "s1", reason: "cancelled" });
    const gone = await app.inject({ method: "DELETE", url: "/api/agent-sessions/remote-srv-p1-r1/preparation", payload: { reason: "owner_failed" } });
    expect(gone.statusCode).toBe(410);
    expect(gone.json().kind).toBe("already_expired");
    expect(remoteLifecycle.cancel).toHaveBeenCalledWith({ localSessionId: "remote-srv-p1-r1", reason: "owner_failed" });
  });

  it("a different user cannot reach a pending row by id", async () => {
    makeApp();
    auth.userId = "user-2";
    try {
      expect((await app.inject({ method: "POST", url: "/api/agent-sessions/s1/activate", payload: { activationKey: "k", instruction: "x" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: "/api/agent-sessions/remote-srv-p1-r1/preparation" })).statusCode).toBe(404);
    } finally {
      auth.userId = "user-1";
    }
  });

  it("status mapping covers every failure kind", async () => {
    const { lifecycle } = makeApp();
    const cases: Array<[string, number]> = [
      ["idempotency_conflict", 409], ["activation_conflict", 409], ["expired", 410], ["not_found", 404],
      ["retryable_failure", 503], ["permanent_failure", 422], ["in_progress", 202], ["activated", 201],
    ];
    for (const [kind, status] of cases) {
      lifecycle.activate.mockResolvedValueOnce(kind === "not_found" ? { kind } : { kind, view: view() } as never);
      const res = await app.inject({ method: "POST", url: "/api/agent-sessions/s1/activate", payload: { activationKey: "k", instruction: "x" } });
      expect(res.statusCode, kind).toBe(status);
      expect(res.json().kind).toBe(kind);
    }
  });
});
