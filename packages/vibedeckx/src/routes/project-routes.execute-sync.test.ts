import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";

vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/remote-proxy.js")>();
  return {
    ...actual,
    proxyToRemoteAuto: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { stdout: "ok", stderr: "", exitCode: 0 } }),
  };
});

import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import projectRoutes from "./project-routes.js";

const proxyMock = vi.mocked(proxyToRemoteAuto);

describe("POST /api/projects/:id/execute-sync — execution target resolution", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let serverAId: string;
  let serverBId: string;
  let prAId: string;
  let prBId: string;

  beforeEach(async () => {
    proxyMock.mockClear();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-exec-sync-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));

    serverAId = (await storage.remoteServers.create({ name: "A" })).id;
    serverBId = (await storage.remoteServers.create({ name: "B" })).id;

    await storage.projects.create({ id: "p1", name: "p1", path: null });
    prAId = (await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverAId, remote_path: "/repo-a" })).id;
    prBId = (await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverBId, remote_path: "/repo-b" })).id;

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => true } as never);
    await app.register(projectRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (payload: object) =>
    app.inject({ method: "POST", url: "/api/projects/p1/execute-sync", payload });

  it("a per-remote config whose executionMode is a concrete server id proxies to that server", async () => {
    await storage.projectRemotes.update(prAId, {
      sync_up_config: { actionType: "command", executionMode: serverAId, content: "git pull" },
    });

    const res = await run({ syncType: "up", remoteServerId: serverAId });
    expect(res.statusCode).toBe(200);
    expect(proxyMock).toHaveBeenCalledTimes(1);
    const [targetId, method, apiPath, body] = proxyMock.mock.calls[0];
    expect(targetId).toBe(serverAId);
    expect(method).toBe("POST");
    expect(apiPath).toBe("/api/execute-one-shot");
    expect((body as { cwd: string }).cwd).toBe("/repo-a");
  });

  it("the legacy 'remote' literal targets the config-source remote", async () => {
    await storage.projectRemotes.update(prBId, {
      sync_up_config: { actionType: "command", executionMode: "remote", content: "git pull" },
    });

    const res = await run({ syncType: "up", remoteServerId: serverBId });
    expect(res.statusCode).toBe(200);
    const [targetId, , , body] = proxyMock.mock.calls[0];
    expect(targetId).toBe(serverBId);
    expect((body as { cwd: string }).cwd).toBe("/repo-b");
  });

  it("a config can target a sibling remote — cwd comes from the TARGET's remote_path", async () => {
    await storage.projectRemotes.update(prAId, {
      sync_down_config: { actionType: "command", executionMode: serverBId, content: "rsync" },
    });

    const res = await run({ syncType: "down", remoteServerId: serverAId });
    expect(res.statusCode).toBe(200);
    const [targetId, , , body] = proxyMock.mock.calls[0];
    expect(targetId).toBe(serverBId);
    expect((body as { cwd: string }).cwd).toBe("/repo-b");
  });

  it("rejects a target server id that is not linked to the project", async () => {
    await storage.projectRemotes.update(prAId, {
      sync_up_config: { actionType: "command", executionMode: "srv-unlinked", content: "git pull" },
    });

    const res = await run({ syncType: "up", remoteServerId: serverAId });
    expect(res.statusCode).toBe(404);
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("a local config on a path-less project fails with 'no local path', not a silent remote fallback", async () => {
    await storage.projectRemotes.update(prAId, {
      sync_up_config: { actionType: "command", executionMode: "local", content: "git pull" },
    });

    const res = await run({ syncType: "up", remoteServerId: serverAId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no local path");
    expect(proxyMock).not.toHaveBeenCalled();
  });
});
