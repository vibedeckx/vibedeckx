// Every "turn ended" signal the front server has for a remote session — the
// `/status stopped` patch, `taskCompleted`, `branchActivity`, `processAlive` —
// is bridged from the worker stream and from nowhere else. Before this, the
// stream was only ever attached by a browser subscribing to the session, so a
// turn started from a page that never held that subscription completed
// invisibly: the durable notification rang while the sidebar dot stayed
// "running" until someone opened the session.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { proxyMock, ensureStreamMock } = vi.hoisted(() => ({
  proxyMock: vi.fn(),
  ensureStreamMock: vi.fn(),
}));
vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, proxyToRemoteAuto: proxyMock };
});
vi.mock("../remote-agent-sessions.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ensureRemoteAgentStream: ensureStreamMock,
    // Fire-and-forget title generation; irrelevant here and would reach out.
    generateAndPushRemoteSessionTitle: vi.fn(async () => undefined),
  };
});
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: "user-1" }),
  clerkClient: {},
}));

import agentSessionRoutes from "./agent-session-routes.js";

const SESSION_ID = "remote-srv1-p1-worker-session";

function makeApp(activityResult: true | "stale" | false = true) {
  const remoteSessionMap = new Map<string, unknown>();
  remoteSessionMap.set(SESSION_ID, {
    remoteServerId: "srv1",
    remoteSessionId: "worker-session",
    branch: "dev8",
  });

  const app = Fastify();
  app.decorate("authEnabled", true);
  app.decorate("storage", {
    projects: { getById: async () => ({ id: "p1" }) },
    remoteSessionMappings: { getByLocal: async () => undefined },
    searchCache: { updateRemoteSessionActivity: async () => activityResult },
  });
  app.decorate("agentSessionManager", { emitBranchActivityIfChanged: vi.fn() });
  app.decorate("remoteSessionMap", remoteSessionMap);
  app.decorate("remotePatchCache", {});
  app.decorate("reverseConnectManager", null);
  app.decorate("eventBus", { emit: vi.fn() });
  app.decorate("remoteNotificationSync", { prepareForNewTurn: vi.fn(async () => true) });
  return app;
}

describe("remote /message attaches the worker stream", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    proxyMock.mockReset();
    ensureStreamMock.mockReset();
  });

  afterEach(async () => {
    await app?.close();
  });

  const send = () =>
    app.inject({
      method: "POST",
      url: `/api/agent-sessions/${SESSION_ID}/message`,
      payload: { content: "go" },
    });

  it("ensures the stream for the turn it just started", async () => {
    app = makeApp();
    await app.register(agentSessionRoutes);
    proxyMock.mockResolvedValue({ ok: true, status: 200, data: {} });

    const res = await send();

    expect(res.statusCode).toBe(200);
    expect(ensureStreamMock).toHaveBeenCalledOnce();
    expect(ensureStreamMock.mock.calls[0][0]).toBe(SESSION_ID);
  });

  it("still attaches when the activity write-through is stale", async () => {
    // A "stale" write only means a concurrent frame already advanced the search
    // cache — the turn is running either way, so the completion still needs a
    // listener. Gating the attach on it would reintroduce the silent-hang case.
    app = makeApp("stale");
    await app.register(agentSessionRoutes);
    proxyMock.mockResolvedValue({ ok: true, status: 200, data: {} });

    await send();

    expect(ensureStreamMock).toHaveBeenCalledOnce();
  });

  it("does not attach when the remote refused the message", async () => {
    app = makeApp();
    await app.register(agentSessionRoutes);
    proxyMock.mockResolvedValue({ ok: false, status: 502, data: { error: "down" }, errorCode: "network_error" });

    const res = await send();

    expect(res.statusCode).toBe(502);
    expect(ensureStreamMock).not.toHaveBeenCalled();
  });
});
