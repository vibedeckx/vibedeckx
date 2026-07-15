import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Stub the remote-proxy layer so the remote branch doesn't make a real network
// call. `proxyToRemoteAuto` is what the route's `proxyAuto` helper forwards to;
// `proxyStatus` stays a simple status passthrough. `vi.hoisted` lets the mock
// fn exist before the hoisted `vi.mock` factory references it.
const { proxyToRemoteAuto } = vi.hoisted(() => ({
  proxyToRemoteAuto: vi.fn(async () => ({
    ok: true,
    status: 200,
    data: { success: true, title: "Remote Name" },
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

describe("PATCH /api/agent-sessions/:sessionId/title — live sidebar broadcast", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  const emitSessionTitle = vi.fn();
  const remoteSessionMap = new Map<string, RemoteSessionInfo>();

  beforeEach(async () => {
    emitSessionTitle.mockClear();
    proxyToRemoteAuto.mockClear();
    remoteSessionMap.clear();

    dir = mkdtempSync(path.join(tmpdir(), "vdx-session-title-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project 1", path: null });
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "main" });

    app = Fastify();
    app.decorate("storage", storage);
    // Only the pieces the title route touches; the fake manager records the
    // broadcast so we can assert on it.
    app.decorate("agentSessionManager", { emitSessionTitle } as never);
    app.decorate("remoteSessionMap", remoteSessionMap as never);
    app.decorate("reverseConnectManager", null as never);
    await app.register(agentSessionRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and broadcasts the normalized title for a local session", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agent-sessions/s1/title",
      payload: { title: "  Add dark mode toggle  " },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, title: "Add dark mode toggle" });
    expect((await storage.agentSessions.getById("s1"))?.title).toBe("Add dark mode toggle");
    expect(emitSessionTitle).toHaveBeenCalledWith("p1", "main", "s1", "Add dark mode toggle");
  });

  it("clears to null and broadcasts null when the title is blank", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agent-sessions/s1/title",
      payload: { title: "   " },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, title: null });
    expect((await storage.agentSessions.getById("s1"))?.title ?? null).toBeNull();
    expect(emitSessionTitle).toHaveBeenCalledWith("p1", "main", "s1", null);
  });

  it("broadcasts a remote rename with the LOCAL wrapped id, not the remote raw id", async () => {
    // Wrapped id layout: remote-{serverId}-{projectId}-{remoteSessionId}
    const wrappedId = "remote-srvA-p1-rs1";
    remoteSessionMap.set(wrappedId, {
      remoteServerId: "srvA",
      remoteUrl: "http://a",
      remoteApiKey: "k",
      remoteSessionId: "rs1",
      branch: "feature",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/agent-sessions/${wrappedId}/title`,
      payload: { title: "Remote Name" },
    });

    expect(res.statusCode).toBe(200);
    // The remote node is written via the proxy with the normalized title...
    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      "srvA",
      "http://a",
      "k",
      "PATCH",
      "/api/agent-sessions/rs1/title",
      { title: "Remote Name" },
      expect.anything(),
    );
    // ...and the local bus is told the LOCAL wrapped id (what the sidebar keys
    // on) with the derived local project id and the mapping's branch.
    expect(emitSessionTitle).toHaveBeenCalledWith("p1", "feature", wrappedId, "Remote Name");
  });
});
