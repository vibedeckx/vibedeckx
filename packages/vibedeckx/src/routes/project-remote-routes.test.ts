import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.userId }),
  clerkClient: {},
}));
const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("../utils/remote-proxy.js", () => ({ proxyToRemoteAuto }));
import { createSqliteStorage } from "../storage/sqlite.js";
import type { ProjectRemote, Storage } from "../storage/types.js";
import projectRemoteRoutes from "./project-remote-routes.js";

describe("POST /api/projects/:id/remotes/:rid/primary", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let p1Remote1: ProjectRemote;
  let p1Remote2: ProjectRemote;
  let p2Remote: ProjectRemote;
  let authenticatedForeignRemote: ProjectRemote;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-remote-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project 1", path: null });
    await storage.projects.create({ id: "p2", name: "project 2", path: null });
    await storage.projects.create({ id: "auth-p1", name: "auth project 1", path: null }, "user-1");
    await storage.projects.create({ id: "auth-p2", name: "auth project 2", path: null }, "user-2");

    const server1 = await storage.remoteServers.create({ name: "Remote A", url: "http://a" });
    const server2 = await storage.remoteServers.create({ name: "Remote B", url: "http://b" });
    const server3 = await storage.remoteServers.create({ name: "Remote C", url: "http://c" });
    const server4 = await storage.remoteServers.create({ name: "Remote D" }, "user-2");
    p1Remote1 = await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: server1.id,
      remote_path: "/repo-a",
    });
    p1Remote2 = await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: server2.id,
      remote_path: "/repo-b",
    });
    p2Remote = await storage.projectRemotes.add({
      project_id: "p2",
      remote_server_id: server3.id,
      remote_path: "/repo-c",
    });
    authenticatedForeignRemote = await storage.projectRemotes.add({
      project_id: "auth-p2",
      remote_server_id: server4.id,
      remote_path: "/repo-d",
    });

    app = Fastify();
    app.decorate("storage", storage);
    await app.register(projectRemoteRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets an associated remote as primary", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/p1/remotes/${p1Remote2.id}/primary`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect((await storage.projectRemotes.getByProject("p1"))[0].id).toBe(p1Remote2.id);
    expect((await storage.projectRemotes.getByProject("p1"))[1].id).toBe(p1Remote1.id);
  });

  it("returns 404 when the association belongs to another project", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/p1/remotes/${p2Remote.id}/primary`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Project remote not found" });
    expect((await storage.projectRemotes.getByProject("p1"))[0].id).toBe(p1Remote1.id);
  });

  it("does not update an association that belongs to another project", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/projects/p1/remotes/${p2Remote.id}`,
      payload: { remotePath: "/stolen" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Project remote not found" });
    expect((await storage.projectRemotes.getByProject("p2"))[0].remote_path).toBe("/repo-c");
  });

  it("does not delete an association that belongs to another project", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/projects/p1/remotes/${p2Remote.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Project remote not found" });
    expect((await storage.projectRemotes.getByProject("p2")).map(({ id }) => id))
      .toContain(p2Remote.id);
  });

  it("does not mutate another user's association through an owned project", async () => {
    await app.close();
    app = Fastify();
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    await app.register(projectRemoteRoutes);
    await app.ready();

    const update = await app.inject({
      method: "PUT",
      url: `/api/projects/auth-p1/remotes/${authenticatedForeignRemote.id}`,
      payload: { remotePath: "/stolen" },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/projects/auth-p1/remotes/${authenticatedForeignRemote.id}`,
    });

    expect(update.statusCode).toBe(404);
    expect(remove.statusCode).toBe(404);
    expect((await storage.projectRemotes.getByProject("auth-p2"))[0].remote_path).toBe("/repo-d");
  });
});

describe("POST /api/projects/:id/remotes", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let serverId: string;

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-remote-link-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project 1", path: null });
    serverId = (await storage.remoteServers.create({ name: "worker3" })).id;

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => true } as never);
    await app.register(projectRemoteRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const link = () => app.inject({
    method: "POST",
    url: "/api/projects/p1/remotes",
    payload: { remoteServerId: serverId, remotePath: "/srv/repo" },
  });

  it("registers the new remote's worktrees at once, so nothing on it starts out unknown", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { worktrees: [{ branch: null, worktreePath: "/srv/repo" }, { branch: "dev", worktreePath: "/srv/repo/../dev" }] },
    });

    const response = await link();

    expect(response.statusCode).toBe(201);
    expect(response.json().worktrees_synced_at).not.toBeNull();
    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      serverId, "GET", `/api/path/worktrees?path=${encodeURIComponent("/srv/repo")}`, undefined, expect.anything(),
    );
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", serverId))?.checkout.status).toBe("ready");
    expect((await storage.projectRemotes.getByProjectAndServer("p1", serverId))?.worktrees_synced_at).not.toBeNull();
  });

  it("still links an offline remote, leaving it unconfirmed", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 0, data: { error: "not connected" }, errorCode: "network_error" });

    const response = await link();

    expect(response.statusCode).toBe(201);
    expect(response.json().worktrees_synced_at).toBeNull();
    expect((await storage.projectRemotes.getByProjectAndServer("p1", serverId))?.worktrees_synced_at).toBeNull();
  });

  it("does not let a sync that throws undo the link", async () => {
    proxyToRemoteAuto.mockRejectedValue(new Error("tunnel closed"));

    const response = await link();

    expect(response.statusCode).toBe(201);
    expect(await storage.projectRemotes.getByProjectAndServer("p1", serverId)).toBeTruthy();
  });
});
