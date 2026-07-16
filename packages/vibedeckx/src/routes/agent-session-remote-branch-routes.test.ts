import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// Stub the outbound proxy so we can inspect what the center sends to the remote,
// and force a real Clerk userId so mintCrossRemoteMcpConfig actually produces a
// token (it fails closed on an empty userId).
const { proxyMock } = vi.hoisted(() => ({ proxyMock: vi.fn() }));
vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, proxyToRemoteAuto: proxyMock };
});
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: "user-1" }),
  clerkClient: {},
}));

import agentSessionRoutes from "./agent-session-routes.js";
import { verifyCrossRemoteToken } from "../utils/cross-remote-token.js";

const SECRET = "a".repeat(64);
const SRC_SESSION_ID = "remote-srv1-p1-srcsess";

type ProxyResult = { ok: boolean; status: number; data: unknown };

function makeApp() {
  const upsert = vi.fn(async () => undefined);
  const projectsGetById = vi.fn(async () => ({ id: "p1" }));
  const branchSession = vi.fn(async () => ({ ok: true, sessionId: "new-local-id" }));
  const remoteSessionMap = new Map<string, unknown>();
  remoteSessionMap.set(SRC_SESSION_ID, {
    remoteServerId: "srv1",
    remoteUrl: "https://remote.example",
    remoteApiKey: "k",
    remoteSessionId: "srcsess",
    branch: null,
  });

  const app = Fastify();
  app.decorate("authEnabled", true);
  app.decorate("storage", {
    agentSessions: { getById: async (id: string) => ({ id, project_id: "p1", title: "t" }) },
    projects: { getById: projectsGetById },
    remoteServers: { getAll: async () => [{ id: "other", cross_remote_access: "read" }] },
    settings: { getOrCreate: async () => SECRET },
    remoteSessionMappings: { upsert, markTitleResolved: vi.fn(async () => undefined) },
  });
  app.decorate("agentSessionManager", {
    branchSession,
    getSession: () => ({ id: "new-local-id", projectId: "p1", branch: null, status: "stopped", permissionMode: "edit", agentType: "claude-code" }),
    getMessages: () => [],
    markTitleResolved: vi.fn(),
  });
  app.decorate("remoteSessionMap", remoteSessionMap);
  app.decorate("remotePatchCache", { getOrCreate: () => ({ messages: [] }), appendMessage: vi.fn() });
  app.decorate("reverseConnectManager", null);

  return { app, upsert, projectsGetById, branchSession, remoteSessionMap };
}

/** Echo the center-supplied branch id back, as an upgraded remote would. */
function echoOk(): (...args: unknown[]) => Promise<ProxyResult> {
  return async (..._args: unknown[]) => {
    const body = _args[5] as { sessionId: string };
    return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [] } };
  };
}

describe("center-side remote branch protocol", () => {
  let ctx: ReturnType<typeof makeApp>;
  let app: FastifyInstance;
  const prevPublicUrl = process.env.VIBEDECKX_PUBLIC_URL;

  beforeEach(async () => {
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com";
    proxyMock.mockReset();
    ctx = makeApp();
    app = ctx.app;
    await app.register(agentSessionRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (prevPublicUrl === undefined) delete process.env.VIBEDECKX_PUBLIC_URL;
    else process.env.VIBEDECKX_PUBLIC_URL = prevPublicUrl;
  });

  const branch = () =>
    app.inject({ method: "POST", url: `/api/agent-sessions/${SRC_SESSION_ID}/branch`, payload: {} });

  it("proxies to the path-branch route with a center-minted token bound to the new local id", async () => {
    proxyMock.mockImplementation(echoOk());
    const res = await branch();
    expect(res.statusCode).toBe(200);

    const [, , , , apiPath, body] = proxyMock.mock.calls[0] as [unknown, unknown, unknown, unknown, string, { sessionId: string; crossRemoteMcp: { token: string } }];
    // Proxied to the remote-provider path route (not the shared UI route), keyed
    // by the SOURCE remote session id.
    expect(apiPath).toBe("/api/path/agent-sessions/srcsess/branch");
    // A fresh id was pre-generated for the branch.
    expect(typeof body.sessionId).toBe("string");
    const localSessionId = `remote-srv1-p1-${body.sessionId}`;

    // Token payload names the composite local id and the source remote server.
    const payload = verifyCrossRemoteToken(SECRET, body.crossRemoteMcp.token, Date.now());
    expect(payload).not.toBeNull();
    expect(payload!.sessionId).toBe(localSessionId);
    expect(payload!.sourceRemoteServerId).toBe("srv1");

    // Registered under the composite id; response echoes it.
    expect(ctx.remoteSessionMap.has(localSessionId)).toBe(true);
    expect(ctx.upsert).toHaveBeenCalledOnce();
    expect(res.json().session.id).toBe(localSessionId);
  });

  it("fails closed with 409 and no registration when the remote returns a different id", async () => {
    proxyMock.mockImplementation(async () => ({ ok: true, status: 200, data: { session: { id: "WRONG" }, messages: [] } }));
    const res = await branch();
    expect(res.statusCode).toBe(409);
    // Only the pre-seeded source entry remains — no branch handle leaked.
    expect([...ctx.remoteSessionMap.keys()]).toEqual([SRC_SESSION_ID]);
    expect(ctx.upsert).not.toHaveBeenCalled();
  });

  it("rolls back the in-memory map entry when the mapping DB write fails", async () => {
    proxyMock.mockImplementation(echoOk());
    ctx.upsert.mockRejectedValueOnce(new Error("db down"));
    const res = await branch();
    expect(res.statusCode).toBe(500);
    // The map.set was rolled back — no orphaned handle that a retry would double.
    expect([...ctx.remoteSessionMap.keys()]).toEqual([SRC_SESSION_ID]);
  });

  it("threads the authenticated userId into the owner-scoped ownership check (local branch)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/agent-sessions/local-src/branch", payload: {} });
    expect(res.statusCode).toBe(200);
    // Not resolveUserId("...")→"local": the raw Clerk id must reach the query.
    expect(ctx.projectsGetById).toHaveBeenCalledWith("p1", "user-1");
    expect(ctx.branchSession).toHaveBeenCalledOnce();
  });

  it("threads upToEntryIndex to the remote and accepts a compliant reply", async () => {
    proxyMock.mockImplementation(async (...args: unknown[]) => {
      const body = args[5] as { sessionId: string; upToEntryIndex?: number };
      expect(body.upToEntryIndex).toBe(2);
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [{}, {}, {}] } }; // 3 ≤ 2+1
    });
    const res = await app.inject({ method: "POST", url: `/api/agent-sessions/${SRC_SESSION_ID}/branch`, payload: { upToEntryIndex: 2 } });
    expect(res.statusCode).toBe(200);
  });

  it("fails closed with 409 and no registration when the remote ignored the cutoff", async () => {
    proxyMock.mockImplementation(async (...args: unknown[]) => {
      const body = args[5] as { sessionId: string };
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [{}, {}, {}, {}, {}] } }; // 5 > 2+1
    });
    const res = await app.inject({ method: "POST", url: `/api/agent-sessions/${SRC_SESSION_ID}/branch`, payload: { upToEntryIndex: 2 } });
    expect(res.statusCode).toBe(409);
    expect([...ctx.remoteSessionMap.keys()]).toEqual([SRC_SESSION_ID]);
    expect(ctx.upsert).not.toHaveBeenCalled();
  });
});
