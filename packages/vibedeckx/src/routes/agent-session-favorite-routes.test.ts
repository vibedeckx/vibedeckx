import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Same stub shape as agent-session-title-routes.test.ts: the remote branch must
// not make a real network call, and `proxyStatus` stays a passthrough.
const { proxyToRemoteAuto } = vi.hoisted(() => ({
  proxyToRemoteAuto: vi.fn(async () => ({
    ok: true,
    status: 200,
    data: { success: true, favorited: true },
  })),
}));
vi.mock("../utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyToRemote: vi.fn(),
  proxyStatus: (result: { status: number }) => result.status,
}));

import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import type { RemoteSessionInfo } from "../server-types.js";
import agentSessionRoutes from "./agent-session-routes.js";
import projectActivityRoutes from "./project-activity-routes.js";

/**
 * The star lives on the worker; the Starred Sessions card reads the local
 * search cache. These cover the gap between the two — notably the state where
 * the session is known only through its mapping because the target's first
 * catalog snapshot has not landed yet.
 */
describe("PATCH /api/agent-sessions/:sessionId/favorite — Starred card write-through", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  const remoteSessionMap = new Map<string, RemoteSessionInfo>();
  // Wrapped id layout: remote-{serverId}-{projectId}-{remoteSessionId}
  let wrappedId: string;
  let serverId: string;

  const starredIds = async (): Promise<string[]> => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/activity" });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().starredSessions.map((s: { id: string }) => s.id);
  };

  beforeEach(async () => {
    proxyToRemoteAuto.mockClear();
    proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { success: true, favorited: true } });
    remoteSessionMap.clear();

    dir = mkdtempSync(path.join(tmpdir(), "vdx-session-favorite-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project 1", path: null });
    const remote = await storage.remoteServers.create({ name: "W1", url: "http://w1" });
    serverId = remote.id;
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverId, remote_path: "/repo" });

    // Exactly what the session-list discovery path leaves behind: a durable
    // mapping and an in-memory route entry, and NO search-cache row.
    wrappedId = `remote-${serverId}-p1-rs1`;
    remoteSessionMap.set(wrappedId, { remoteServerId: serverId, remoteSessionId: "rs1", branch: "feature" });
    await storage.remoteSessionMappings.upsert(wrappedId, "p1", serverId, "rs1", "feature", "from_now");

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("agentSessionManager", { emitSessionTitle: vi.fn() } as never);
    app.decorate("remoteSessionMap", remoteSessionMap as never);
    app.decorate("reverseConnectManager", null as never);
    await app.register(agentSessionRoutes);
    await app.register(projectActivityRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const toggle = (favorited: boolean) => app.inject({
    method: "PATCH",
    url: `/api/agent-sessions/${wrappedId}/favorite`,
    payload: { favorited },
  });

  it("surfaces a remote star immediately even when no catalog snapshot has landed yet", async () => {
    expect(await starredIds()).toEqual([]);

    const res = await toggle(true);

    expect(res.statusCode, res.body).toBe(200);
    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      serverId,
      "PATCH",
      "/api/agent-sessions/rs1/favorite",
      { favorited: true },
      expect.anything(),
    );
    expect(await starredIds()).toEqual([wrappedId]);
  });

  it("does not fabricate activity: a starred session created this way sorts last, not first", async () => {
    await storage.remoteSessionMappings.upsert(`remote-${serverId}-p1-rs2`, "p1", serverId, "rs2", "feature", "from_now");
    await storage.searchCache.noteSessionCreated({
      localSessionId: `remote-${serverId}-p1-rs2`, projectId: "p1", targetId: serverId,
      branch: "feature", title: "Actually active",
    });

    await toggle(true);

    const res = await app.inject({ method: "GET", url: "/api/projects/p1/activity" });
    const recent = res.json().recentAgentSessions as Array<{ id: string; lastActiveAt: number | null }>;
    // Starring is passive — it must never promote the session up the list.
    expect(recent[0].id).toBe(`remote-${serverId}-p1-rs2`);
    expect(recent.find((s) => s.id === wrappedId)?.lastActiveAt).toBeNull();
  });

  it("unstars in place, and an unstar with no cached row creates nothing", async () => {
    await toggle(true);
    expect(await starredIds()).toEqual([wrappedId]);

    proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { success: true, favorited: false } });
    const res = await toggle(false);

    expect(res.statusCode, res.body).toBe(200);
    expect(await starredIds()).toEqual([]);

    // A second, never-cached session: unstarring it must not conjure a row.
    const otherId = `remote-${serverId}-p1-rs3`;
    remoteSessionMap.set(otherId, { remoteServerId: serverId, remoteSessionId: "rs3", branch: "feature" });
    await storage.remoteSessionMappings.upsert(otherId, "p1", serverId, "rs3", "feature", "from_now");
    const unstar = await app.inject({
      method: "PATCH",
      url: `/api/agent-sessions/${otherId}/favorite`,
      payload: { favorited: false },
    });

    expect(unstar.statusCode, unstar.body).toBe(200);
    const activity = await app.inject({ method: "GET", url: "/api/projects/p1/activity" });
    expect(activity.json().recentAgentSessions.map((s: { id: string }) => s.id)).not.toContain(otherId);
  });

  it("keeps a successful remote star a 200 when the cache write-through fails", async () => {
    const failure = vi.spyOn(storage.searchCache, "updateCachedSessionFavorited")
      .mockRejectedValue(new Error("cache is on fire"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await toggle(true);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ success: true, favorited: true });
    expect(failure).toHaveBeenCalled();
    consoleError.mockRestore();
    failure.mockRestore();
  });

  it("leaves the cache alone when the remote star itself failed", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 502, data: { error: "worker offline" } });

    const res = await toggle(true);

    expect(res.statusCode).toBe(502);
    expect(await starredIds()).toEqual([]);
  });
});
