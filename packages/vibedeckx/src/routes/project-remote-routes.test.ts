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

describe("DELETE /api/projects/:id/remotes/:rid (unlink guard)", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let serverId: string;
  let link: ProjectRemote;
  const tunnel = { connected: true };

  const worktreeList = (...branches: Array<string | null>) => ({
    ok: true,
    status: 200,
    data: {
      worktrees: branches.map((branch) => ({
        branch,
        worktreePath: branch ? `/srv/${branch}` : "/srv/repo",
      })),
    },
  });

  const registerCheckout = (branch: string, projectId = "p1", targetId = serverId) =>
    storage.workspaceRegistry.registerReadyCheckout({
      projectId,
      branch,
      targetId,
      worktreePath: branch ? `/srv/${branch}` : "/srv/repo",
      expectedBranch: branch,
      pathSource: "reported",
    });

  const unlink = (query = "") => app.inject({
    method: "DELETE",
    url: `/api/projects/p1/remotes/${link.id}${query}`,
  });

  const stillLinked = async () =>
    (await storage.projectRemotes.getByProject("p1")).some((remote) => remote.id === link.id);

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    tunnel.connected = true;
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-remote-unlink-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project 1", path: null });
    await storage.projects.create({ id: "p2", name: "project 2", path: null });
    serverId = (await storage.remoteServers.create({ name: "worker3" })).id;
    link = await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverId, remote_path: "/srv/repo" });

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => tunnel.connected } as never);
    await app.register(projectRemoteRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- reachable ----

  it("unlinks an online remote the project has nothing on", async () => {
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null));

    const response = await unlink();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(await stillLinked()).toBe(false);
    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      serverId, "GET", `/api/path/worktrees?path=${encodeURIComponent("/srv/repo")}`, undefined,
      expect.objectContaining({ reverseConnectManager: expect.anything(), timeoutMs: 10_000 }),
    );
  });

  it("does not count the main workspace as usage", async () => {
    await registerCheckout("");
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null));

    const response = await unlink();

    expect(response.statusCode).toBe(200);
    expect(await stillLinked()).toBe(false);
  });

  it("refuses while a non-main workspace lives on the remote", async () => {
    await registerCheckout("");
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null, "dev3", "feat-x"));

    const response = await unlink();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      errorCode: "remote-in-use",
      serverId,
      name: "worker3",
      error: "worker3 still has 2 workspaces in this project.",
      usage: { workspaces: ["dev3", "feat-x"], schedules: [] },
    });
    expect(await stillLinked()).toBe(true);
  });

  it("counts checkouts still being created or in error, not only ready ones", async () => {
    const creating = await registerCheckout("wip");
    await storage.workspaceRegistry.setCheckoutStatus(creating.checkout.id, "creating");
    const failed = await registerCheckout("broken");
    await storage.workspaceRegistry.setCheckoutStatus(failed.checkout.id, "error", "clone failed");
    // Neither is reported by the worker; reconcile leaves both alone (only
    // ready rows are tombstoned), so both still count.
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null));

    const response = await unlink();

    expect(response.statusCode).toBe(409);
    expect(response.json().usage.workspaces).toEqual(["broken", "wip"]);
  });

  it("does not count sessions or executor processes: they live in worktrees, which already count", async () => {
    await storage.remoteSessionMappings.upsert("remote-local-2", "p1", serverId, "remote-2", "dev3");
    await storage.remoteSessionCreationIntents.begin({
      localSessionId: "remote-local-1",
      remoteSessionId: "remote-1",
      projectId: "p1",
      remoteServerId: serverId,
      branch: null,
      remotePath: "/srv/repo",
      permissionMode: "edit",
      prepareOperationId: "op-1",
    });
    await storage.remoteExecutorProcesses.insert("remote-proc-1", {
      remoteServerId: serverId, remoteProcessId: "rp-1", executorId: "ex-1", projectId: "p1",
    });
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null));

    const response = await unlink();

    expect(response.statusCode).toBe(200);
    expect(await stillLinked()).toBe(false);
    // Left in place on purpose: re-linking the same machine picks them up.
    expect(await storage.remoteSessionMappings.getByLocal("remote-local-2")).toBeTruthy();
    expect(await storage.remoteSessionCreationIntents.getByLocal("remote-local-1")).toBeTruthy();
    expect((await storage.remoteExecutorProcesses.getById("remote-proc-1"))?.status).toBe("running");
  });

  it("counts a schedule targeting the remote, by name", async () => {
    await storage.scheduledTasks.create({
      id: "sched-1", project_id: "p1", name: "nightly-build", cron_expr: "0 3 * * *", timezone: "UTC",
      run_type: "command", content: "make", cwd_mode: "branch", target: serverId,
    });
    await storage.scheduledTasks.create({
      id: "sched-2", project_id: "p1", name: "local-only", cron_expr: "0 3 * * *", timezone: "UTC",
      run_type: "command", content: "make", cwd_mode: "branch", target: "local",
    });
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null));

    const response = await unlink();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "worker3 still has 1 schedule in this project.",
      usage: { schedules: ["nightly-build"] },
    });
  });

  it("ignores usage that belongs to another project on the same server", async () => {
    await storage.projectRemotes.add({ project_id: "p2", remote_server_id: serverId, remote_path: "/srv/other" });
    await registerCheckout("dev9", "p2");
    await storage.remoteSessionMappings.upsert("remote-local-3", "p2", serverId, "remote-3", "dev9");
    await storage.scheduledTasks.create({
      id: "sched-3", project_id: "p2", name: "other", cron_expr: "0 3 * * *", timezone: "UTC",
      run_type: "command", content: "make", cwd_mode: "branch", target: serverId,
    });
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null));

    const response = await unlink();

    expect(response.statusCode).toBe(200);
    expect(await stillLinked()).toBe(false);
    expect(await storage.projectRemotes.getByProjectAndServer("p2", serverId)).toBeTruthy();
  });

  it("tombstones a workspace the remote no longer reports, so removing it there frees the unlink", async () => {
    const stale = await registerCheckout("feat-x");
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null));

    const response = await unlink();

    expect(response.statusCode).toBe(200);
    expect(await stillLinked()).toBe(false);
    expect((await storage.workspaceRegistry.getCheckoutById(stale.checkout.id))?.checkout.deleted_at).not.toBeNull();
  });

  it("lists everything at once in the refusal message", async () => {
    await registerCheckout("dev3");
    await storage.scheduledTasks.create({
      id: "sched-4", project_id: "p1", name: "nightly-build", cron_expr: "0 3 * * *", timezone: "UTC",
      run_type: "command", content: "make", cwd_mode: "branch", target: serverId,
    });
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null, "dev3"));

    const response = await unlink();

    expect(response.json().error).toBe("worker3 still has 1 workspace and 1 schedule in this project.");
  });

  it("does not honor force while the remote is online and in use", async () => {
    await registerCheckout("dev3");
    proxyToRemoteAuto.mockResolvedValue(worktreeList(null, "dev3"));

    const response = await unlink("?force=1");

    expect(response.statusCode).toBe(409);
    expect(response.json().errorCode).toBe("remote-in-use");
    expect(await stillLinked()).toBe(true);
  });

  // ---- unreachable: offline ----

  it("answers unreachable with the last known usage when the remote is offline", async () => {
    tunnel.connected = false;
    await storage.remoteServers.updateStatus(serverId, "online");
    await storage.remoteServers.updateStatus(serverId, "offline");
    await storage.remoteServers.generateToken(serverId);
    await registerCheckout("dev3");
    await storage.projectRemotes.markWorktreesSynced("p1", serverId);
    const syncedAt = (await storage.projectRemotes.getByProjectAndServer("p1", serverId))!.worktrees_synced_at;
    expect(syncedAt).not.toBeNull();

    const response = await unlink();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "worker3 is offline; its workspaces cannot be confirmed.",
      errorCode: "remote-unreachable",
      serverId,
      name: "worker3",
      reason: "offline",
      lastConnectedAt: expect.any(String),
      lastSyncedAt: syncedAt,
      tokenRevoked: false,
      lastKnownUsage: { workspaces: ["dev3"], schedules: [] },
    });
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
    expect(await stillLinked()).toBe(true);
  });

  it("has no last known usage for an offline remote that never synced", async () => {
    tunnel.connected = false;
    await storage.remoteServers.generateToken(serverId);
    await registerCheckout("dev3");

    const response = await unlink();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      errorCode: "remote-unreachable",
      reason: "offline",
      lastConnectedAt: null,
      lastSyncedAt: null,
      lastKnownUsage: null,
    });
  });

  it("unlinks an offline remote with force", async () => {
    tunnel.connected = false;
    await registerCheckout("dev3");
    await storage.remoteSessionMappings.upsert("remote-local-5", "p1", serverId, "remote-5", "dev3");

    const response = await unlink("?force=1");

    expect(response.statusCode).toBe(200);
    expect(await stillLinked()).toBe(false);
    // Nothing else is cleaned up: re-linking the same machine brings it back.
    expect(await storage.remoteSessionMappings.getByLocal("remote-local-5")).toBeTruthy();
    expect((await storage.workspaceRegistry.listByProject("p1", serverId)).map((row) => row.workspace.branch)).toEqual(["dev3"]);
  });

  it("reports a revoked connect token, since that machine cannot come back", async () => {
    tunnel.connected = false;
    await storage.remoteServers.generateToken(serverId);
    await storage.remoteServers.revokeToken(serverId);

    const response = await unlink();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ errorCode: "remote-unreachable", tokenRevoked: true });
  });

  // ---- unreachable: online but not answering ----

  for (const [label, answer] of [
    ["times out", () => proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 0, data: { error: "timeout" }, errorCode: "network_error" })],
    ["returns no list", () => proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { error: "old worker" } })],
    // The shape a worker produces when Git cannot read the repository (see
    // "reports a Git failure" in worktree-registry-routes.test.ts): a root-only
    // list that must not be taken as "nothing is there".
    ["cannot read its Git repository", () => proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { worktrees: [{ branch: null, worktreePath: "/srv/repo" }], gitError: "fatal: not a git repository" },
    })],
    ["throws", () => proxyToRemoteAuto.mockRejectedValue(new Error("tunnel closed"))],
  ] as const) {
    it(`answers sync-failed, leaving the registry untouched, when the online worker ${label}`, async () => {
      await registerCheckout("");
      await registerCheckout("dev3");
      await storage.projectRemotes.markWorktreesSynced("p1", serverId);
      const before = await storage.workspaceRegistry.listByProject("p1", serverId, { includeDeleted: true });
      const syncedBefore = (await storage.projectRemotes.getByProjectAndServer("p1", serverId))!.worktrees_synced_at;
      answer();

      const response = await unlink();

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "worker3 is online but did not report its workspaces; they cannot be confirmed.",
        errorCode: "remote-unreachable",
        reason: "sync-failed",
        lastSyncedAt: syncedBefore,
        lastKnownUsage: { workspaces: ["dev3"] },
      });
      expect(await stillLinked()).toBe(true);
      expect(await storage.workspaceRegistry.listByProject("p1", serverId, { includeDeleted: true })).toEqual(before);
      expect((await storage.projectRemotes.getByProjectAndServer("p1", serverId))!.worktrees_synced_at).toBe(syncedBefore);
    });
  }

  it("unlinks with force when the online worker does not answer", async () => {
    await registerCheckout("dev3");
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 0, data: { error: "timeout" }, errorCode: "network_error" });

    const response = await unlink("?force=1");

    expect(response.statusCode).toBe(200);
    expect(await stillLinked()).toBe(false);
  });
});
