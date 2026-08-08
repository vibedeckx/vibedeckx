import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/fastify", () => ({ getAuth: () => ({ userId: null }), clerkClient: {} }));
const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("../utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyStatus: (result: { status: number }, fallback = 502) => result.status > 0 ? result.status : fallback,
}));

import { ProcessManager } from "../process-manager.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Executor, Storage } from "../storage/types.js";
import {
  conventionalWorktreePath,
  getWorktreeBaseForProject,
  invalidateWorktreeListCache,
} from "../utils/worktree-paths.js";
import worktreeRoutes from "./worktree-routes.js";

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("worktree routes persisted identity", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let projectPath: string;
  let worktreePath: string;
  let liveSessionIds: Array<{ projectId: string; branch: string | null; sessionId: string }>;
  let stopSession: ReturnType<typeof vi.fn>;
  // A real ProcessManager, so the delete path is exercised against actual
  // child processes rather than a double that can only prove a call happened.
  let processManager: ProcessManager;
  let stopProcess: ReturnType<typeof vi.spyOn>;

  const startProcessIn = async (cwd: string, command = "sleep 30"): Promise<number> => {
    const executor: Executor = {
      id: `e-${cwd}`, project_id: "p1", workspace_id: "", name: "run",
      command, executor_type: "command", prompt_provider: null,
      cwd: null, pty: true, position: 0, disabled_targets: [],
      created_at: new Date().toISOString(),
    };
    const processId = await processManager.start(executor, cwd, true);
    const tracked = (processManager as unknown as {
      processes: Map<string, { process: { pid: number } }>;
    }).processes.get(processId);
    return tracked!.process.pid;
  };

  const registerRemoteCheckout = async () => {
    await storage.projects.create({ id: "remote-project", name: "remote", path: null });
    const remote = await storage.remoteServers.create({ name: "worker" });
    await storage.projectRemotes.add({
      project_id: "remote-project",
      remote_server_id: remote.id,
      remote_path: "/remote/repo",
    });
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "remote-project",
      branch: "dev",
      targetId: remote.id,
      worktreePath: conventionalWorktreePath("/remote/repo", "dev"),
      expectedBranch: "dev",
    });
    return { remote, registered };
  };

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-worktree-routes-"));
    projectPath = path.join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", projectPath]);
    execFileSync("git", ["-C", projectPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", projectPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", projectPath, "commit", "--allow-empty", "-m", "initial"]);
    worktreePath = conventionalWorktreePath(projectPath, "dev");

    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project", path: projectPath });

    liveSessionIds = [];
    stopSession = vi.fn(async () => true);
    processManager = new ProcessManager(null as never);
    stopProcess = vi.spyOn(processManager, "stopAndWait");

    app = Fastify({ logger: false });
    app.decorate("authEnabled", false);
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    // Sessions stay a double: a real one would have to spawn an agent CLI,
    // which these offline tests cannot do.
    app.decorate("agentSessionManager", {
      getLiveSessionIdsForBranch: (projectId: string, branch: string | null) =>
        liveSessionIds
          .filter((row) => row.projectId === projectId && row.branch === branch)
          .map((row) => row.sessionId),
      stopSessionAndWait: stopSession,
    } as never);
    app.decorate("processManager", processManager as never);
    await app.register(worktreeRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    processManager.shutdown();
    if (existsSync(worktreePath)) {
      execFileSync("git", ["-C", projectPath, "worktree", "remove", "--force", worktreePath]);
    }
    rmSync(getWorktreeBaseForProject(projectPath), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the original branch and reports a later checkout as drift", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });

    expect(created.statusCode).toBe(201);
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({
        worktree_path: worktreePath,
        expected_branch: "dev",
        status: "ready",
      });

    execFileSync("git", ["-C", worktreePath, "switch", "-c", "agent/experiment"]);
    invalidateWorktreeListCache(projectPath);

    const listed = await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().worktrees).toEqual([
      { branch: null, expectedBranch: "main" },
      { branch: "dev", currentBranch: "agent/experiment" },
    ]);
  });

  it("clears root drift once the user adopts the branch they switched to", async () => {
    // The first listing is what captures the anchor, here "main".
    await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });
    execFileSync("git", ["-C", projectPath, "switch", "-c", "hotfix"]);
    invalidateWorktreeListCache(projectPath);
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" })).json().worktrees)
      .toEqual([{ branch: null, expectedBranch: "main", currentBranch: "hotfix" }]);

    const anchored = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees/anchor",
      payload: { branch: "hotfix" },
    });

    expect(anchored.statusCode).toBe(200);
    expect(anchored.json()).toEqual({ expectedBranch: "hotfix" });
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" })).json().worktrees)
      .toEqual([{ branch: null, expectedBranch: "hotfix" }]);
  });

  it("refuses to anchor a branch the main workspace has already left", async () => {
    await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });
    execFileSync("git", ["-C", projectPath, "switch", "-c", "hotfix"]);
    invalidateWorktreeListCache(projectPath);

    // The client was looking at a listing taken before the switch.
    const anchored = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees/anchor",
      payload: { branch: "main" },
    });

    expect(anchored.statusCode).toBe(409);
    expect(anchored.json()).toMatchObject({ currentBranch: "hotfix" });
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "", "local"))?.checkout)
      .toMatchObject({ expected_branch: "main" });
  });

  it("names the stale worker when anchoring a remote workspace it cannot serve", async () => {
    await registerRemoteCheckout();
    // Additive route: a worker released before it has no such handler.
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 404, data: { error: "Not Found" } });

    const anchored = await app.inject({
      method: "POST",
      url: "/api/projects/remote-project/worktrees/anchor",
      payload: { branch: "hotfix" },
    });

    expect(anchored.statusCode).toBe(501);
    expect(anchored.json().error).toMatch(/too old/);
  });

  it("restores a checkout to ready when dirty files prevent deletion", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    expect(created.statusCode).toBe(201);
    writeFileSync(path.join(worktreePath, "dirty.txt"), "keep me");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });

    expect(deleted.statusCode).toBe(409);
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ status: "ready", error: null });
  });

  it("removes the worktree only after the real process in it has exited", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    expect(created.statusCode).toBe(201);

    liveSessionIds = [{ projectId: "p1", branch: "dev", sessionId: "s1" }];
    const pid = await startProcessIn(worktreePath);
    expect(pidIsAlive(pid)).toBe(true);

    // The guarantee is about ordering against the filesystem, so sample the
    // tree at the moment of each stop rather than only asserting a call.
    const worktreeAliveAtStop: boolean[] = [];
    stopSession.mockImplementation(async () => {
      worktreeAliveAtStop.push(existsSync(worktreePath));
      return true;
    });
    stopProcess.mockImplementation(async (processId: string) => {
      worktreeAliveAtStop.push(existsSync(worktreePath));
      // Still the real stop — the spy only adds the sample point.
      return ProcessManager.prototype.stopAndWait.call(processManager, processId);
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });

    expect(deleted.statusCode).toBe(200);
    expect(stopSession).toHaveBeenCalledWith("s1", { note: expect.stringContaining("worktree") });
    expect(stopProcess).toHaveBeenCalledTimes(1);
    expect(worktreeAliveAtStop).toEqual([true, true]);
    // The process is gone at the OS level, not merely signalled, and it went
    // before git touched the directory.
    expect(pidIsAlive(pid)).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("refuses the delete and keeps the worktree when a process cannot be confirmed dead", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    expect(created.statusCode).toBe(201);
    await startProcessIn(worktreePath);
    // Stands in for a process that survives even SIGKILL (uninterruptible I/O),
    // which cannot be produced reliably in a test.
    stopProcess.mockResolvedValue(false);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });

    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error).toMatch(/could not be stopped/);
    expect(existsSync(worktreePath)).toBe(true);
    // The checkout is healthy — the operation was refused, not the checkout.
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ status: "ready", error: null });
  });

  it("leaves sessions and processes running when dirty files refuse the delete", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    expect(created.statusCode).toBe(201);
    writeFileSync(path.join(worktreePath, "dirty.txt"), "keep me");
    liveSessionIds = [{ projectId: "p1", branch: "dev", sessionId: "s1" }];
    const pid = await startProcessIn(worktreePath);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });

    // A refused delete must not cost the user a running agent.
    expect(deleted.statusCode).toBe(409);
    expect(stopSession).not.toHaveBeenCalled();
    expect(stopProcess).not.toHaveBeenCalled();
    expect(pidIsAlive(pid)).toBe(true);
  });

  it("stops a path-route session registered under the path pseudo project", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    expect(created.statusCode).toBe(201);
    // projects.path carries no UNIQUE constraint, so getByPath resolving to p1
    // does not mean the worker registered the session under p1.
    liveSessionIds = [{ projectId: `path:${projectPath}`, branch: "dev", sessionId: "s-path" }];

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/path/worktrees",
      payload: { path: projectPath, branch: "dev" },
    });

    expect(deleted.statusCode).toBe(200);
    expect(stopSession).toHaveBeenCalledWith("s-path", { note: expect.stringContaining("worktree") });
  });

  it("retains a tombstone and creates a new incarnation after a clean delete and recreate", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    expect(created.statusCode).toBe(201);
    const first = await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local")).toBeUndefined();

    const recreated = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    expect(recreated.statusCode).toBe(201);
    const second = await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local");
    expect(second?.checkout.id).not.toBe(first?.checkout.id);

    const history = await storage.workspaceRegistry.listByProject("p1", "local", { includeDeleted: true });
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.checkout.id === first?.checkout.id)?.checkout.deleted_at).not.toBeNull();
  });

  it("keeps an existing remote checkout ready when duplicate creation is rejected", async () => {
    await storage.projects.create({ id: "remote-project", name: "remote", path: null });
    const remote = await storage.remoteServers.create({ name: "worker" });
    await storage.projectRemotes.add({
      project_id: "remote-project",
      remote_server_id: remote.id,
      remote_path: "/remote/repo",
    });
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "remote-project",
      branch: "dev",
      targetId: remote.id,
      worktreePath: conventionalWorktreePath("/remote/repo", "dev"),
      expectedBranch: "dev",
    });
    proxyToRemoteAuto.mockResolvedValue({
      ok: false,
      status: 409,
      data: { error: "Branch 'dev' already exists" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/remote-project/worktrees",
      payload: { branchName: "dev", targets: ["remote"] },
    });

    expect(response.statusCode).toBe(409);
    expect((await storage.workspaceRegistry.getByProjectBranch("remote-project", "dev", remote.id))?.checkout)
      .toMatchObject({ status: "ready", error: null });
  });

  it("restores a remote checkout to ready when dirty files prevent deletion", async () => {
    await storage.projects.create({ id: "remote-project", name: "remote", path: null });
    const remote = await storage.remoteServers.create({ name: "worker" });
    await storage.projectRemotes.add({
      project_id: "remote-project",
      remote_server_id: remote.id,
      remote_path: "/remote/repo",
    });
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "remote-project",
      branch: "dev",
      targetId: remote.id,
      worktreePath: conventionalWorktreePath("/remote/repo", "dev"),
      expectedBranch: "dev",
    });
    proxyToRemoteAuto.mockResolvedValue({
      ok: false,
      status: 409,
      data: { error: "Worktree has uncommitted changes" },
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/remote-project/worktrees",
      payload: { branch: "dev" },
    });

    expect(response.statusCode).toBe(409);
    expect((await storage.workspaceRegistry.getByProjectBranch("remote-project", "dev", remote.id))?.checkout)
      .toMatchObject({ status: "ready", error: null });
  });

  it("preserves a remote checkout when deletion cannot reach the worker", async () => {
    const { remote } = await registerRemoteCheckout();
    proxyToRemoteAuto.mockResolvedValue({
      ok: false,
      status: 0,
      data: { error: "Remote server is not connected" },
      errorCode: "network_error",
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/remote-project/worktrees",
      payload: { branch: "dev" },
    });

    expect(response.statusCode).toBe(502);
    expect((await storage.workspaceRegistry.getByProjectBranch("remote-project", "dev", remote.id))?.checkout)
      .toMatchObject({ status: "ready", error: null });
  });

  it("restores the exact prior checkout state when remote deletion returns 5xx", async () => {
    const { remote, registered } = await registerRemoteCheckout();
    await storage.workspaceRegistry.setCheckoutStatus(
      registered.checkout.id,
      "error",
      "pre-existing health failure",
    );
    proxyToRemoteAuto.mockResolvedValue({
      ok: false,
      status: 500,
      data: { error: "Worker delete failed" },
      errorCode: "server_error",
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/remote-project/worktrees",
      payload: { branch: "dev" },
    });

    expect(response.statusCode).toBe(500);
    expect((await storage.workspaceRegistry.getByProjectBranch("remote-project", "dev", remote.id))?.checkout)
      .toMatchObject({ status: "error", error: "pre-existing health failure" });
  });

  it("preserves a remote checkout when the deletion proxy throws", async () => {
    const { remote } = await registerRemoteCheckout();
    proxyToRemoteAuto.mockRejectedValue(new Error("reverse-connect channel closed"));

    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/remote-project/worktrees",
      payload: { branch: "dev" },
    });

    expect(response.statusCode).toBe(500);
    expect((await storage.workspaceRegistry.getByProjectBranch("remote-project", "dev", remote.id))?.checkout)
      .toMatchObject({ status: "ready", error: null });
  });

  it("does not overwrite a concurrent checkout status change after remote deletion fails", async () => {
    const { remote, registered } = await registerRemoteCheckout();
    proxyToRemoteAuto.mockImplementation(async () => {
      await storage.workspaceRegistry.setCheckoutStatus(
        registered.checkout.id,
        "error",
        "concurrent health check",
      );
      return {
        ok: false,
        status: 0,
        data: { error: "Remote server is not connected" },
        errorCode: "network_error",
      };
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/remote-project/worktrees",
      payload: { branch: "dev" },
    });

    expect(response.statusCode).toBe(502);
    expect((await storage.workspaceRegistry.getByProjectBranch("remote-project", "dev", remote.id))?.checkout)
      .toMatchObject({ status: "error", error: "concurrent health check" });
  });

  it("uses the canonical pseudo project for path-based registry rows", async () => {
    const pseudoProjectId = `path:${projectPath}`;
    await storage.projects.create({ id: pseudoProjectId, name: "provider repo", path: projectPath });

    const response = await app.inject({
      method: "GET",
      url: `/api/path/worktrees?path=${encodeURIComponent(projectPath)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(await storage.workspaceRegistry.listByProject(pseudoProjectId, "local"))
      .toHaveLength(1);
    expect(await storage.workspaceRegistry.listByProject("p1", "local"))
      .toEqual([]);
  });
});
