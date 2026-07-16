import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import agentSessionRoutes from "./agent-session-routes.js";
import type { CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";

/**
 * Route-level coverage for the Branch conversation paths:
 * - ownership gate (a source session whose project the caller doesn't own → 404)
 * - the remote-provider path route threads a center-minted crossRemoteMcp
 *   straight into branchSession (parity with New Conversation)
 * - the UI route branches and responds
 *
 * authEnabled is left false, so requireAuth returns undefined and
 * projects.getById runs unscoped (single-tenant). The cross-tenant denial in
 * auth mode rides on the same projects.getById(id, userId) call, exercised here
 * via the "project not found" branch without needing a Clerk mock.
 */

const BRANCH_ID = "branch-new-id";

function makeApp(overrides?: {
  sourceRow?: { project_id: string } | undefined;
  project?: { id: string } | undefined;
}): { app: FastifyInstance; branchSession: ReturnType<typeof vi.fn> } {
  const sourceRow = overrides?.sourceRow ?? { project_id: "p1" };
  const project = overrides && "project" in overrides ? overrides.project : { id: "p1" };

  const branchSession = vi.fn(async () => ({ ok: true, sessionId: BRANCH_ID }));

  const app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    agentSessions: {
      getById: async (id: string) => (id === BRANCH_ID ? { id: BRANCH_ID, title: "Branch - x" } : sourceRow),
    },
    projects: {
      getById: async () => project,
    },
  });
  app.decorate("agentSessionManager", {
    branchSession,
    getSession: () => ({ id: BRANCH_ID, projectId: "p1", branch: null, status: "stopped", permissionMode: "edit", agentType: "claude-code" }),
    getMessages: () => [],
  });
  app.decorate("remoteSessionMap", new Map());
  app.decorate("remotePatchCache", {});
  app.decorate("reverseConnectManager", null);

  return { app, branchSession };
}

describe("branch routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("UI route branches the source and returns the new session", async () => {
    const h = makeApp();
    app = h.app;
    await app.register(agentSessionRoutes);
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.id).toBe(BRANCH_ID);
    // A pre-generated id is always threaded (so the config, when minted, binds to it).
    expect(h.branchSession).toHaveBeenCalledOnce();
    expect(h.branchSession.mock.calls[0][2].sessionId).toEqual(expect.any(String));
  });

  it("denies branching a source whose project the caller doesn't own (404, no branch)", async () => {
    const h = makeApp({ project: undefined });
    app = h.app;
    await app.register(agentSessionRoutes);
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: {} });
    expect(res.statusCode).toBe(404);
    expect(h.branchSession).not.toHaveBeenCalled();
  });

  it("path route threads a center-minted crossRemoteMcp into branchSession", async () => {
    const h = makeApp();
    app = h.app;
    await app.register(agentSessionRoutes);
    await app.ready();

    const crossRemoteMcp: CrossRemoteMcpConfig = {
      url: "https://app.example.com/api/cross-remote/mcp",
      token: "signed.token",
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/path/agent-sessions/remote-src/branch",
      payload: { sessionId: "pre-branch-id", crossRemoteMcp },
    });
    expect(res.statusCode).toBe(200);
    expect(h.branchSession).toHaveBeenCalledOnce();
    const opts = h.branchSession.mock.calls[0][2];
    expect(opts.sessionId).toBe("pre-branch-id");
    expect(opts.crossRemoteMcp).toEqual(crossRemoteMcp);
  });

  it("threads upToEntryIndex to branchSession and maps invalid-cutoff to 400", async () => {
    const h = makeApp();
    app = h.app;
    await app.register(agentSessionRoutes);
    await app.ready();

    await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: { upToEntryIndex: 7 } });
    expect(h.branchSession.mock.calls[0][2].upToEntryIndex).toBe(7);

    h.branchSession.mockResolvedValueOnce({ ok: false, reason: "invalid-cutoff" });
    const bad = await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: { upToEntryIndex: 3 } });
    expect(bad.statusCode).toBe(400);

    h.branchSession.mockResolvedValueOnce({ ok: false, reason: "running-needs-cutoff" });
    const busy = await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: {} });
    expect(busy.statusCode).toBe(409);

    const nonInt = await app.inject({ method: "POST", url: "/api/agent-sessions/src-1/branch", payload: { upToEntryIndex: -1 } });
    expect(nonInt.statusCode).toBe(400);
  });
});
