import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// The remote branch tunnels to the worker; stub the proxy layer so nothing
// reaches the network, and keep `proxyStatus` the passthrough it really is.
const { proxyMock, bindRemoteSessionMapping } = vi.hoisted(() => ({
  proxyMock: vi.fn(),
  bindRemoteSessionMapping: vi.fn(async () => undefined),
}));
vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, proxyToRemoteAuto: proxyMock, proxyStatus: (r: { status: number }) => r.status };
});
vi.mock("../remote-agent-sessions.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, bindRemoteSessionMapping };
});

import agentSessionRoutes from "./agent-session-routes.js";

type AliveRow = { id: string; projectId: string; branch: string | null; status: string; lastActiveAt: number };

const ROWS: Record<string, { project_id: string; branch: string; title: string | null; updated_at: string; workspace_checkout_id: string | null }> = {
  "s-root": { project_id: "p1", branch: "", title: "Root work", updated_at: "2026-08-16 01:00:00.000", workspace_checkout_id: null },
  "s-dev": { project_id: "p1", branch: "dev", title: null, updated_at: "2026-08-16 02:00:00.000", workspace_checkout_id: null },
};

function makeApp(options: {
  agentMode?: string;
  alive?: AliveRow[];
  projectPath?: string | null;
} = {}) {
  const listByBranch = vi.fn(async () => []);
  const countEntries = vi.fn(async () => []);
  const listAliveSessions = vi.fn((projectIds: string[]): AliveRow[] =>
    options.alive ?? [
      { id: "s-root", projectId: "p1", branch: null, status: "stopped", lastActiveAt: 1 },
      { id: "s-dev", projectId: "p1", branch: "dev", status: "running", lastActiveAt: 2 },
    ],
  );

  const app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    projects: {
      getById: async () => ({
        id: "p1",
        path: options.projectPath === undefined ? "/tmp/p1" : options.projectPath,
        agent_mode: options.agentMode ?? "local",
      }),
      getByPath: async (path: string) => (path === "/worker/p1" ? { id: "p1" } : undefined),
    },
    agentSessions: { getById: async (id: string) => ROWS[id], listByBranch, countEntries },
    projectRemotes: { getByProjectAndServer: async () => ({ remote_path: "/worker/p1" }) },
    remoteSessionMappings: { getAuthorizedByLocal: async () => undefined },
    workspaceRegistry: { getCheckoutById: async () => undefined },
  });
  app.decorate("agentSessionManager", { listAliveSessions, getSession: () => undefined, getSessionProcessAlive: () => false });
  app.decorate("remoteSessionMap", new Map());
  app.decorate("remotePatchCache", {});
  app.decorate("reverseConnectManager", null);

  return { app, listAliveSessions, listByBranch, countEntries };
}

describe("alive agent-session routes", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
    proxyMock.mockReset();
    bindRemoteSessionMapping.mockClear();
  });

  it("answers the whole project from the manager without reading any branch history", async () => {
    let listByBranch: ReturnType<typeof vi.fn>;
    let countEntries: ReturnType<typeof vi.fn>;
    ({ app, listByBranch, countEntries } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({ method: "GET", url: "/api/projects/p1/agent-sessions/alive" });

    expect(res.statusCode).toBe(200);
    // Exactly the four display fields — the project-scoped contract stays
    // narrower than the internal worker→hub row, and carries no timestamp:
    // the manager hands rows over most-recently-active first.
    expect(res.json()).toEqual({
      complete: true,
      sessions: [
        { id: "s-root", branch: null, title: "Root work", status: "stopped" },
        { id: "s-dev", branch: "dev", title: null, status: "running" },
      ],
    });
    // The point of the route: the per-branch listing scans every session of
    // every branch (plus a full entry-count pass) to find the same rows.
    expect(listByBranch).not.toHaveBeenCalled();
    expect(countEntries).not.toHaveBeenCalled();
  });

  it("maps worker rows to local ids and binds only the live sessions", async () => {
    ({ app } = makeApp({ agentMode: "srv1" }));
    await app.register(agentSessionRoutes);
    proxyMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        complete: true,
        sessions: [{ id: "w-1", branch: "dev", title: "Remote work", status: "running", updated_at: "2026-08-16 03:00:00.000", worktreePath: "/worker/p1-dev" }],
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/projects/p1/agent-sessions/alive" });

    expect(res.statusCode).toBe(200);
    expect(proxyMock).toHaveBeenCalledTimes(1);
    expect(proxyMock.mock.calls[0][2]).toBe("/api/path/agent-sessions/alive?path=%2Fworker%2Fp1");
    expect(res.json()).toEqual({
      complete: true,
      sessions: [{
        id: "remote-srv1-p1-w-1", branch: "dev", title: "Remote work", status: "running",
      }],
    });
    expect(bindRemoteSessionMapping).toHaveBeenCalledTimes(1);
    expect(app.remoteSessionMap.get("remote-srv1-p1-w-1")).toEqual({
      remoteServerId: "srv1", remoteSessionId: "w-1", branch: "dev",
    });
  });

  it("reports the answer as incomplete when the worker is too old to serve it", async () => {
    ({ app } = makeApp({ agentMode: "srv1" }));
    await app.register(agentSessionRoutes);
    proxyMock.mockResolvedValue({ ok: false, status: 404, data: { error: "Not Found" } });

    const res = await app.inject({ method: "GET", url: "/api/projects/p1/agent-sessions/alive" });

    // Not an error: the caller falls back to the per-branch fan-out, which is
    // exactly what such a worker can still answer.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: [], complete: false });
  });

  it("propagates a failing worker instead of claiming the project has no live sessions", async () => {
    ({ app } = makeApp({ agentMode: "srv1" }));
    await app.register(agentSessionRoutes);
    proxyMock.mockResolvedValue({ ok: false, status: 502, data: { error: "network_error" } });

    const res = await app.inject({ method: "GET", url: "/api/projects/p1/agent-sessions/alive" });

    // An error keeps the sidebar on the rows it already has; `complete: false`
    // would send it fanning out N more doomed requests down the same tunnel.
    expect(res.statusCode).toBe(502);
  });

  it("still binds the remaining rows when one session's mapping conflicts", async () => {
    ({ app } = makeApp({ agentMode: "srv1" }));
    await app.register(agentSessionRoutes);
    bindRemoteSessionMapping.mockRejectedValueOnce(new Error("conflicting workspace identity"));
    proxyMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        complete: true,
        sessions: [
          { id: "w-bad", branch: "dev", title: "Conflicted", status: "running" },
          { id: "w-ok", branch: null, title: "Fine", status: "stopped" },
        ],
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/projects/p1/agent-sessions/alive" });

    expect(res.statusCode).toBe(200);
    expect(res.json().sessions.map((s: { id: string }) => s.id)).toEqual([
      "remote-srv1-p1-w-bad",
      "remote-srv1-p1-w-ok",
    ]);
  });

  it("worker route accepts both the registered and the path: pseudo project id", async () => {
    let listAliveSessions: ReturnType<typeof vi.fn>;
    ({ app, listAliveSessions } = makeApp({
      alive: [{ id: "s-dev", projectId: "p1", branch: "dev", status: "running", lastActiveAt: 2 }],
    }));
    await app.register(agentSessionRoutes);

    const res = await app.inject({
      method: "GET",
      url: "/api/path/agent-sessions/alive?path=%2Fworker%2Fp1",
    });

    expect(res.statusCode).toBe(200);
    // The worker→hub hop keeps the identity fields the hub binds a remote
    // mapping from; only the project-scoped route narrows them away.
    expect(res.json()).toEqual({
      complete: true,
      sessions: [{
        id: "s-dev", projectId: "p1", branch: "dev", title: null, status: "running",
        processAlive: true, updated_at: "2026-08-16 02:00:00.000", worktreePath: null,
      }],
    });
    // A session spawned before the path was registered carries the pseudo id.
    expect(listAliveSessions).toHaveBeenCalledWith(["path:/worker/p1", "p1"]);
  });

  it("worker route requires a path", async () => {
    ({ app } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({ method: "GET", url: "/api/path/agent-sessions/alive" });

    expect(res.statusCode).toBe(400);
  });
});
