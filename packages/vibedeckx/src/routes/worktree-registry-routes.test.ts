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
      {
        branch: "dev",
        currentBranch: "agent/experiment",
        machines: [{ serverId: "local", name: "local", state: "present" }],
      },
    ]);
  });

  it("refuses to adopt a worktree another workspace still owns", async () => {
    // Workspace identity survives an agent switching the tree's branch, so the
    // directory is still `dev`'s. Adopting by live branch would give one tree
    // two identities, and deleting either would take the other's checkout.
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    execFileSync("git", ["-C", worktreePath, "switch", "-c", "topic"]);
    invalidateWorktreeListCache(projectPath);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "topic", baseBranch: "main", targets: ["local"] },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatch(/already belongs to workspace 'dev'/);
    expect(await storage.workspaceRegistry.getByProjectBranch("p1", "topic", "local")).toBeUndefined();
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ worktree_path: worktreePath, status: "ready" });
  });

  it("adopts its own worktree again when a create is retried", async () => {
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    const first = await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local");
    invalidateWorktreeListCache(projectPath);

    const retried = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });

    expect(retried.statusCode).toBe(201);
    expect(retried.json().worktree).toEqual({ branch: "dev", adopted: true });
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ id: first?.checkout.id, worktree_path: worktreePath, status: "ready" });
  });

  it("reports the branch a delete could not remove", async () => {
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    // Work that exists nowhere else: `git branch -d` refuses, and the name
    // stays taken on this machine.
    execFileSync("git", ["-C", worktreePath, "commit", "--allow-empty", "-m", "unlanded"]);
    invalidateWorktreeListCache(projectPath);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().branchRetained).toEqual({ branch: "dev", unmerged: true });
    expect(execFileSync("git", ["-C", projectPath, "branch", "--list", "dev"], { encoding: "utf-8" }))
      .toContain("dev");
  });

  it("reports nothing retained when the branch goes with its workspace", async () => {
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().branchRetained).toBeNull();
    expect(execFileSync("git", ["-C", projectPath, "branch", "--list", "dev"], { encoding: "utf-8" }))
      .toBe("");
  });

  it("succeeds when the worktree is already gone, so a retry converges", async () => {
    // What a partial multi-target delete leaves behind: the user clicks Delete
    // again, and the target that already succeeded must not fail the retry.
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    const first = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });
    expect(first.statusCode).toBe(200);

    const retried = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ success: true, branchRetained: null });
  });

  it("deletes a workspace whose target never got a worktree, branch and all", async () => {
    // The remote that failed mid-create: the branch is there, the tree is not.
    execFileSync("git", ["-C", projectPath, "branch", "ghost", "main"]);
    invalidateWorktreeListCache(projectPath);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "ghost" },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ success: true, branchRetained: null });
    expect(execFileSync("git", ["-C", projectPath, "branch", "--list", "ghost"], { encoding: "utf-8" }))
      .toBe("");
  });

  it("is idempotent on the worker's own path route too", async () => {
    // The half that runs on a remote: the hub proxies here, so a retry after a
    // partial failure has to converge on this side as well.
    await app.inject({
      method: "POST",
      url: "/api/path/worktrees",
      payload: { path: projectPath, branchName: "dev", baseBranch: "main" },
    });
    const first = await app.inject({
      method: "DELETE",
      url: "/api/path/worktrees",
      payload: { path: projectPath, branch: "dev" },
    });
    expect(first.statusCode).toBe(200);

    const retried = await app.inject({
      method: "DELETE",
      url: "/api/path/worktrees",
      payload: { path: projectPath, branch: "dev" },
    });

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ success: true, branchRetained: null });
  });

  it("keeps the real error when a failed removal left the worktree in place", async () => {
    // "Already deleted" is only a verdict Git can give. A locked worktree fails
    // the same call but is still there, so the failure has to reach the user.
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    execFileSync("git", ["-C", projectPath, "worktree", "lock", worktreePath]);

    const refused = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });

    expect(refused.statusCode).toBe(500);
    expect(refused.json().error).toMatch(/locked/i);
    expect(existsSync(worktreePath)).toBe(true);
    // Still usable — recording it as broken would lock sessions out of the very
    // workspace the user has to go and unblock. The reason is kept anyway, so
    // it outlives the dialog that showed it.
    const checkout = (await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout;
    expect(checkout?.status).toBe("ready");
    expect(checkout?.error).toMatch(/locked/i);

    execFileSync("git", ["-C", projectPath, "worktree", "unlock", worktreePath]);
  });

  it("keeps a workspace the other machine still has, and names both machines", async () => {
    // A delete that failed on a non-primary machine used to make the workspace
    // vanish from the UI while it was still on disk over there.
    const remote = await storage.remoteServers.create({ name: "Mac" });
    await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: remote.id,
      remote_path: "/remote/repo",
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1",
      branch: "dev",
      targetId: remote.id,
      worktreePath: conventionalWorktreePath("/remote/repo", "dev"),
      expectedBranch: "dev",
    });

    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 500, data: { error: "not a working tree" } });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });
    expect(deleted.statusCode).toBe(207);

    invalidateWorktreeListCache(projectPath);
    const listed = await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });
    const dev = listed.json().worktrees.find((worktree: { branch: string | null }) => worktree.branch === "dev");

    expect(dev).toBeTruthy();
    expect(dev.machines).toEqual([
      { serverId: "local", name: "local", state: "absent", deleted: true },
      // The failed delete restored the checkout to ready, and the reason it
      // refused rides along: a warning that cannot say why is no help.
      { serverId: remote.id, name: "Mac", state: "present", error: "not a working tree" },
    ]);
  });

  it("forgets a machine the project no longer has, instead of listing a workspace nobody can delete", async () => {
    // Unlinking a remote leaves its checkout rows behind. Counting them would
    // mark the workspace half-deleted forever: a delete only visits the
    // machines currently linked, so no retry could ever clear it.
    const remote = await storage.remoteServers.create({ name: "Mac" });
    const link = await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: remote.id,
      remote_path: "/remote/repo",
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1",
      branch: "dev",
      targetId: remote.id,
      worktreePath: conventionalWorktreePath("/remote/repo", "dev"),
      expectedBranch: "dev",
    });

    await storage.projectRemotes.remove(link.id, "p1");
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/worktrees",
      payload: { branch: "dev" },
    });
    expect(deleted.statusCode).toBe(200);

    invalidateWorktreeListCache(projectPath);
    const listed = await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });
    expect(listed.json().worktrees.some((worktree: { branch: string | null }) => worktree.branch === "dev")).toBe(false);
  });

  it("creates on the linked remote too when the caller names no targets", async () => {
    // The UI's local/remote choice keys off the legacy `projects.remote_path`,
    // which adding a remote never sets — so a project with a local path and a
    // linked remote sends no targets at all. Defaulting to local alone would
    // report success while the remote never got the workspace.
    const remote = await storage.remoteServers.create({ name: "Mac" });
    await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: remote.id,
      remote_path: "/remote/repo",
    });
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 201,
      data: { worktree: { branch: "dev", worktreePath: "/remote/repo/../dev" } },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main" },
    });

    expect(created.statusCode).toBe(201);
    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      remote.id, "POST", "/api/path/worktrees", expect.objectContaining({ branchName: "dev" }), expect.anything(),
    );
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", remote.id))?.checkout)
      .toMatchObject({ status: "ready" });
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ status: "ready" });
  });

  it("leaves a workspace that every machine agrees on unannotated", async () => {
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    invalidateWorktreeListCache(projectPath);

    const listed = await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });
    const dev = listed.json().worktrees.find((worktree: { branch: string | null }) => worktree.branch === "dev");

    expect(dev).toBeTruthy();
    expect(dev.machines).toEqual([{ serverId: "local", name: "local", state: "present" }]);
  });

  it("drops the workspace once the retry finishes the delete everywhere", async () => {
    const remote = await storage.remoteServers.create({ name: "Mac" });
    await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: remote.id,
      remote_path: "/remote/repo",
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1",
      branch: "dev",
      targetId: remote.id,
      worktreePath: conventionalWorktreePath("/remote/repo", "dev"),
      expectedBranch: "dev",
    });
    proxyToRemoteAuto.mockResolvedValueOnce({ ok: false, status: 500, data: { error: "not a working tree" } });
    await app.inject({ method: "DELETE", url: "/api/projects/p1/worktrees", payload: { branch: "dev" } });

    proxyToRemoteAuto.mockResolvedValueOnce({ ok: true, status: 200, data: { success: true, branchRetained: null } });
    const retried = await app.inject({ method: "DELETE", url: "/api/projects/p1/worktrees", payload: { branch: "dev" } });
    expect(retried.statusCode).toBe(200);

    invalidateWorktreeListCache(projectPath);
    const listed = await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });
    expect(listed.json().worktrees.some((worktree: { branch: string | null }) => worktree.branch === "dev")).toBe(false);
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

  it("anchors the main workspace to a branch it is not checked out on", async () => {
    await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });
    execFileSync("git", ["-C", projectPath, "switch", "-c", "feat/passage-finder"]);
    invalidateWorktreeListCache(projectPath);
    // The anchor was captured as "main"; the user now wants the workspace named
    // after the feature branch without switching the checkout back.
    const anchored = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees/anchor-branch",
      payload: { branch: "main" },
    });
    expect(anchored.statusCode).toBe(200);

    execFileSync("git", ["-C", projectPath, "switch", "main"]);
    execFileSync("git", ["-C", projectPath, "switch", "feat/passage-finder"]);
    invalidateWorktreeListCache(projectPath);
    const renamed = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees/anchor-branch",
      payload: { branch: "feat/passage-finder" },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ expectedBranch: "feat/passage-finder" });
    // Re-anchoring to a branch that is not checked out is deliberate, so the
    // listing reports it as drift rather than refusing the change.
    execFileSync("git", ["-C", projectPath, "switch", "main"]);
    invalidateWorktreeListCache(projectPath);
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" })).json().worktrees)
      .toEqual([{ branch: null, expectedBranch: "feat/passage-finder", currentBranch: "main" }]);
  });

  it("rejects an anchor branch that does not exist", async () => {
    await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });

    const anchored = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees/anchor-branch",
      payload: { branch: "no-such-branch" },
    });

    expect(anchored.statusCode).toBe(400);
    expect(anchored.json().error).toMatch(/does not exist/);
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "", "local"))?.checkout)
      .toMatchObject({ expected_branch: "main" });
  });

  it("rejects a revision expression that resolves but names no branch", async () => {
    await app.inject({ method: "GET", url: "/api/projects/p1/worktrees" });

    // `git rev-parse --verify refs/heads/main^{commit}` succeeds; anchoring to
    // it would record an expected branch no checkout can ever match.
    for (const branch of ["main^{commit}", "main@{0}", "main~0"]) {
      const anchored = await app.inject({
        method: "POST",
        url: "/api/projects/p1/worktrees/anchor-branch",
        payload: { branch },
      });
      expect(anchored.statusCode, branch).toBe(400);
      expect(anchored.json().error).toMatch(/does not exist/);
    }
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "", "local"))?.checkout)
      .toMatchObject({ expected_branch: "main" });
  });

  it("refuses an anchor branch that is already its own workspace", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local"] },
    });
    expect(created.statusCode).toBe(201);
    invalidateWorktreeListCache(projectPath);

    // Two rows named "dev" — the root and the real worktree — would make the
    // sessions bound to each indistinguishable in the sidebar.
    const anchored = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees/anchor-branch",
      payload: { branch: "dev" },
    });

    expect(anchored.statusCode).toBe(409);
    expect(anchored.json().error).toMatch(/already has its own workspace/);
  });

  it("names the stale worker when changing a remote workspace's anchor branch", async () => {
    await registerRemoteCheckout();
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 404, data: { error: "Not Found" } });

    const anchored = await app.inject({
      method: "POST",
      url: "/api/projects/remote-project/worktrees/anchor-branch",
      payload: { branch: "main" },
    });

    expect(anchored.statusCode).toBe(501);
    expect(anchored.json().error).toMatch(/too old/);
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
    // Usable, and the reason it would not go is kept for the next look.
    expect((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local"))?.checkout)
      .toMatchObject({ status: "ready", error: expect.stringMatching(/uncommitted changes/) });
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
      .toMatchObject({ status: "ready", error: expect.stringMatching(/could not be stopped/) });
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
      .toMatchObject({ status: "ready", error: "Worktree has uncommitted changes" });
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
    // Unreachable is a delete that did not happen, not a broken checkout — but
    // the workspace is still over there, so say why nothing was removed.
    expect((await storage.workspaceRegistry.getByProjectBranch("remote-project", "dev", remote.id))?.checkout)
      .toMatchObject({ status: "ready", error: "Remote server is not connected" });
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
      .toMatchObject({ status: "ready", error: "reverse-connect channel closed" });
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

  it("creates only on the remotes the caller named", async () => {
    const first = await storage.remoteServers.create({ name: "gpu-01" });
    const second = await storage.remoteServers.create({ name: "gpu-02" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: first.id, remote_path: "/srv/one",
    });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: second.id, remote_path: "/srv/two",
    });
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 201,
      data: { worktree: { branch: "dev", worktreePath: "/srv/two/../dev" } },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      // A machine is named by its remote server id: with several remotes, one
      // "remote" checkbox could not say which of them the user picked.
      payload: { branchName: "dev", baseBranch: "main", targets: ["local", second.id] },
    });

    expect(created.statusCode).toBe(201);
    expect(Object.keys(created.json().results).sort()).toEqual(["local", second.id].sort());
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(1);
    expect(proxyToRemoteAuto.mock.calls[0][0]).toBe(second.id);
    // The remote left out is left alone — no half-made checkout row for it.
    expect(await storage.workspaceRegistry.getByProjectBranch("p1", "dev", first.id)).toBeUndefined();
  });

  it("lists branches from the named remote, not just the first one", async () => {
    const first = await storage.remoteServers.create({ name: "gpu-01" });
    const second = await storage.remoteServers.create({ name: "gpu-02" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: first.id, remote_path: "/srv/one",
    });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: second.id, remote_path: "/srv/two",
    });
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: ["main", "only-on-two"] },
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/p1/branches?target=${second.id}`,
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().branches).toEqual(["main", "only-on-two"]);
    expect(proxyToRemoteAuto.mock.calls[0][0]).toBe(second.id);
    expect(proxyToRemoteAuto.mock.calls[0][2]).toContain(encodeURIComponent("/srv/two"));
  });

  it("refuses branches from a machine the project does not have", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/projects/p1/branches?target=srv-gone",
    });

    expect(listed.statusCode).toBe(400);
    expect(listed.json().error).toContain("srv-gone");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("refuses a target that is not one of the project's machines", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local", "srv-gone"] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("srv-gone");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("still takes the legacy 'remote' target as every linked remote", async () => {
    const first = await storage.remoteServers.create({ name: "gpu-01" });
    const second = await storage.remoteServers.create({ name: "gpu-02" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: first.id, remote_path: "/srv/one",
    });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: second.id, remote_path: "/srv/two",
    });
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 201,
      data: { worktree: { branch: "dev", worktreePath: "/srv/one/../dev" } },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { branchName: "dev", baseBranch: "main", targets: ["local", "remote"] },
    });

    expect(created.statusCode).toBe(201);
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(2);
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
  describe("workspace coverage across remotes", () => {
    // A SaaS project: no local path, three linked remotes, sessions on `a`.
    let a: string;
    let b: string;
    let c: string;
    const worktreesOf = (branches: Array<string | null>) => ({
      ok: true,
      status: 200,
      data: {
        worktrees: branches.map((branch) => ({
          branch,
          worktreePath: branch ? conventionalWorktreePath("/srv/repo", branch) : "/srv/repo",
        })),
      },
    });
    const offline = { ok: false, status: 0, data: { error: "Remote server is not connected" }, errorCode: "network_error" };
    const machinesOf = (worktree: { machines?: Array<{ serverId: string; state: string }> }) =>
      Object.fromEntries((worktree.machines ?? []).map((machine) => [machine.serverId, machine.state]));

    beforeEach(async () => {
      await storage.projects.create({ id: "saas", name: "saas", path: null });
      a = (await storage.remoteServers.create({ name: "alpha" })).id;
      b = (await storage.remoteServers.create({ name: "bravo" })).id;
      c = (await storage.remoteServers.create({ name: "charlie" })).id;
      for (const id of [a, b, c]) {
        await storage.projectRemotes.add({ project_id: "saas", remote_server_id: id, remote_path: "/srv/repo" });
      }
      await storage.projects.update("saas", { agent_mode: a });
    });

    const listOn = (serverId: string, branch = "dev") =>
      storage.workspaceRegistry.registerReadyCheckout({
        projectId: "saas",
        branch,
        targetId: serverId,
        worktreePath: conventionalWorktreePath("/srv/repo", branch),
        expectedBranch: branch,
      });
    const confirmAll = async () => {
      for (const id of [a, b, c]) await storage.projectRemotes.markWorktreesSynced("saas", id);
    };

    it("lists a workspace created on one remote only, with every machine's state", async () => {
      // Created with only bravo ticked. The listing remote's Git has never
      // heard of it, so before this the workspace was simply invisible.
      await confirmAll();
      await listOn(b);
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null]));

      const listed = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });

      expect(listed.statusCode).toBe(200);
      const dev = listed.json().worktrees.find((worktree: { branch: string | null }) => worktree.branch === "dev");
      expect(dev).toBeTruthy();
      expect(dev.machines).toEqual([
        { serverId: a, name: "alpha", state: "absent" },
        { serverId: b, name: "bravo", state: "present" },
        { serverId: c, name: "charlie", state: "absent" },
      ]);
      // Not a contradiction: no machine failed, nothing is half-deleted.
      expect(dev.targets).toBeUndefined();
      expect(dev.unfinishedDelete).toBeUndefined();
      // The main workspace is everywhere by definition and carries no breakdown.
      expect(listed.json().worktrees[0].branch).toBeNull();
      expect(listed.json().worktrees[0].machines).toBeUndefined();
    });

    it("lists the remote sessions run on, not the first one linked", async () => {
      await storage.projects.update("saas", { agent_mode: b });
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null]));

      await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });

      expect(proxyToRemoteAuto).toHaveBeenCalledTimes(1);
      expect(proxyToRemoteAuto.mock.calls[0][0]).toBe(b);
    });

    it("falls back to the first-linked remote when agent_mode names nothing linked", async () => {
      await storage.projects.update("saas", { agent_mode: "gone" });
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null]));

      await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });

      expect(proxyToRemoteAuto.mock.calls[0][0]).toBe(a);
    });

    it("calls a never-listed remote unknown rather than absent, until it is listed", async () => {
      await listOn(b);
      await storage.projectRemotes.markWorktreesSynced("saas", a);
      await storage.projectRemotes.markWorktreesSynced("saas", b);
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null]));

      const before = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });
      const devBefore = before.json().worktrees.find((worktree: { branch: string | null }) => worktree.branch === "dev");
      expect(machinesOf(devBefore)).toEqual({ [a]: "absent", [b]: "present", [c]: "unknown" });

      // Listing charlie is the evidence: its full list came back without dev.
      await app.inject({ method: "GET", url: `/api/projects/saas/worktrees?target=${c}` });
      const after = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });
      const devAfter = after.json().worktrees.find((worktree: { branch: string | null }) => worktree.branch === "dev");
      expect(machinesOf(devAfter)).toEqual({ [a]: "absent", [b]: "present", [c]: "absent" });
    });

    it("does not take a row written on its own as proof the remote was listed", async () => {
      // A create or a session binding writes one row and says nothing about
      // the workspaces it did not touch.
      await storage.projectRemotes.markWorktreesSynced("saas", a);
      await storage.projectRemotes.markWorktreesSynced("saas", b);
      await listOn(b);
      await listOn(c, "other");
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null]));

      const listed = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });
      const dev = listed.json().worktrees.find((worktree: { branch: string | null }) => worktree.branch === "dev");
      expect(machinesOf(dev)).toEqual({ [a]: "absent", [b]: "present", [c]: "unknown" });
    });

    it("keeps a failed machine's reason in the breakdown", async () => {
      // Present on two, failed on a third, never made on the fourth.
      const d = (await storage.remoteServers.create({ name: "delta" })).id;
      await storage.projectRemotes.add({ project_id: "saas", remote_server_id: d, remote_path: "/srv/repo" });
      await confirmAll();
      await storage.projectRemotes.markWorktreesSynced("saas", d);
      await listOn(a);
      await listOn(b);
      const failed = await storage.workspaceRegistry.beginCheckout({
        projectId: "saas", branch: "dev", targetId: c,
        worktreePath: conventionalWorktreePath("/srv/repo", "dev"), expectedBranch: "dev",
      });
      await storage.workspaceRegistry.setCheckoutStatus(failed.checkout.id, "error", "disk full");
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null, "dev"]));

      const listed = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });
      const dev = listed.json().worktrees.find((worktree: { branch: string | null }) => worktree.branch === "dev");
      expect(dev.machines).toEqual([
        { serverId: a, name: "alpha", state: "present" },
        { serverId: b, name: "bravo", state: "present" },
        { serverId: c, name: "charlie", state: "error", error: "disk full" },
        { serverId: d, name: "delta", state: "absent" },
      ]);
    });

    it("lists from the registry, in the current remote's order, with its Git facts", async () => {
      await confirmAll();
      await listOn(b, "zeta");
      await listOn(a, "beta");
      await listOn(a, "alpha-only");
      proxyToRemoteAuto.mockResolvedValue({
        ok: true,
        status: 200,
        data: {
          worktrees: [
            { branch: null, expectedBranch: "main", currentBranch: "hotfix", worktreePath: "/srv/repo" },
            { branch: "beta", currentBranch: "beta-wip", worktreePath: conventionalWorktreePath("/srv/repo", "beta") },
            { branch: "alpha-only", worktreePath: conventionalWorktreePath("/srv/repo", "alpha-only") },
          ],
        },
      });

      const listed = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });

      expect(listed.statusCode).toBe(200);
      expect(listed.json().stale).toBeUndefined();
      expect(listed.json().activeRemoteInvalid).toBeUndefined();
      // Worker order first, with what only its Git knows; then the rest by name.
      // The worker's own paths do not leak into the list.
      expect(listed.json().worktrees.map((worktree: { branch: string | null; currentBranch?: string; worktreePath?: string }) =>
        [worktree.branch, worktree.currentBranch, worktree.worktreePath],
      )).toEqual([
        [null, "hotfix", undefined],
        ["beta", "beta-wip", undefined],
        ["alpha-only", undefined, undefined],
        ["zeta", undefined, undefined],
      ]);
      expect(machinesOf(listed.json().worktrees[3])).toEqual({ [a]: "absent", [b]: "present", [c]: "absent" });
    });

    it("answers from the registry when the current remote is offline, and says so", async () => {
      // Today this is a 5xx and an empty sidebar.
      await confirmAll();
      await listOn(a);
      await listOn(b, "other");
      proxyToRemoteAuto.mockResolvedValue(offline);

      const listed = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });

      expect(listed.statusCode).toBe(200);
      expect(listed.json().stale).toEqual({ serverId: a, name: "alpha" });
      expect(listed.json().worktrees.map((worktree: { branch: string | null }) => worktree.branch)).toEqual([null, "dev", "other"]);
      // Nothing was reconciled against an answer that never came.
      expect((await storage.workspaceRegistry.getByProjectBranch("saas", "dev", a))?.checkout.status).toBe("ready");
    });

    it("flags an agent_mode that names nothing linked, and lists from the first remote", async () => {
      await storage.projects.update("saas", { agent_mode: "gone" });
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null]));

      const listed = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });

      expect(listed.statusCode).toBe(200);
      expect(listed.json().activeRemoteInvalid).toBe(true);
      expect(proxyToRemoteAuto.mock.calls[0][0]).toBe(a);
    });

    it("reconciles the current remote's rows to its list: tombstones the hand-deleted, restores the failed", async () => {
      await confirmAll();
      await listOn(a, "gone");
      await listOn(b, "gone");
      const failed = await storage.workspaceRegistry.beginCheckout({
        projectId: "saas", branch: "dev", targetId: a,
        worktreePath: conventionalWorktreePath("/srv/repo", "dev"), expectedBranch: "dev",
      });
      await storage.workspaceRegistry.setCheckoutStatus(failed.checkout.id, "error", "lost a race");
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null, "dev"]));

      const listed = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });

      const byBranch = Object.fromEntries(listed.json().worktrees.map((worktree: { branch: string | null }) => [worktree.branch ?? "", worktree]));
      // `gone` was removed by hand on alpha: alpha's row is closed, bravo's stands.
      expect(machinesOf(byBranch.gone)).toEqual({ [a]: "absent", [b]: "present", [c]: "absent" });
      expect(byBranch.gone.machines[0].deleted).toBe(true);
      // alpha has `dev` after all: the failure no longer describes it.
      expect(machinesOf(byBranch.dev)).toEqual({ [a]: "present", [b]: "absent", [c]: "absent" });
      expect((await storage.workspaceRegistry.getByProjectBranch("saas", "dev", a))?.checkout).toMatchObject({ status: "ready", error: null });
    });

    it("reconciles a named machine too when listing it explicitly", async () => {
      await confirmAll();
      await listOn(c, "gone");
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null]));

      await app.inject({ method: "GET", url: `/api/projects/saas/worktrees?target=${c}` });

      expect(await storage.workspaceRegistry.getByProjectBranch("saas", "gone", c)).toBeUndefined();
    });

    it("does not let the machine check move a row the way a listing does", async () => {
      // The check's answer is for the dialog; the registry is add-only there.
      await confirmAll();
      await listOn(a, "gone");
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null]));

      await app.inject({ method: "GET", url: "/api/projects/saas/worktrees/machines?branch=gone" });

      expect((await storage.workspaceRegistry.getByProjectBranch("saas", "gone", a))?.checkout.status).toBe("ready");
    });

    it("sends the full breakdown even when every machine has the workspace", async () => {
      await confirmAll();
      for (const id of [a, b, c]) await listOn(id);
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null, "dev"]));

      const listed = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });
      const dev = listed.json().worktrees.find((worktree: { branch: string | null }) => worktree.branch === "dev");
      expect(machinesOf(dev)).toEqual({ [a]: "present", [b]: "present", [c]: "present" });
      expect(dev.targets).toBeUndefined();
    });

    it("shows a create still under way as creating, and a delete as deleted here", async () => {
      await confirmAll();
      await listOn(a);
      await storage.workspaceRegistry.beginCheckout({
        projectId: "saas", branch: "dev", targetId: b,
        worktreePath: conventionalWorktreePath("/srv/repo", "dev"), expectedBranch: "dev",
      });
      const gone = await listOn(c);
      await storage.workspaceRegistry.markCheckoutDeleted(gone.checkout.id);
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null, "dev"]));

      const listed = await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });
      const dev = listed.json().worktrees.find((worktree: { branch: string | null }) => worktree.branch === "dev");
      expect(dev.machines).toEqual([
        { serverId: a, name: "alpha", state: "present" },
        { serverId: b, name: "bravo", state: "creating" },
        { serverId: c, name: "charlie", state: "absent", deleted: true },
      ]);
    });

    it("confirms the remote it listed, so its later silences count", async () => {
      proxyToRemoteAuto.mockResolvedValue(worktreesOf([null]));
      expect((await storage.projectRemotes.getByProjectAndServer("saas", a))?.worktrees_synced_at).toBeNull();

      await app.inject({ method: "GET", url: "/api/projects/saas/worktrees" });

      expect((await storage.projectRemotes.getByProjectAndServer("saas", a))?.worktrees_synced_at).not.toBeNull();
      expect((await storage.projectRemotes.getByProjectAndServer("saas", b))?.worktrees_synced_at).toBeNull();
    });

    describe("GET /api/projects/:id/worktrees/machines", () => {
      const check = (branch = "dev") =>
        app.inject({ method: "GET", url: `/api/projects/saas/worktrees/machines?branch=${encodeURIComponent(branch)}` });
      const answers = (byServer: Record<string, unknown>) =>
        proxyToRemoteAuto.mockImplementation(async (serverId: string) => byServer[serverId] ?? offline);

      it("asks every remote and falls back to the registry for the one it cannot reach", async () => {
        await storage.projectRemotes.markWorktreesSynced("saas", a);
        await listOn(a);
        await listOn(b);
        answers({ [a]: worktreesOf([null, "dev"]), [c]: worktreesOf([null]) });

        const response = await check();

        expect(response.statusCode).toBe(200);
        expect(response.json().branch).toBe("dev");
        expect(response.json().machines).toEqual([
          { serverId: a, name: "alpha", state: "present", checked: true },
          // Bravo is offline: its last-known state, marked as such.
          { serverId: b, name: "bravo", state: "present", checked: false, checkError: "Remote server is not connected" },
          { serverId: c, name: "charlie", state: "absent", checked: true },
        ]);
        expect(proxyToRemoteAuto).toHaveBeenCalledTimes(3);
        // A machine that answered is confirmed from here on; one that did not is not.
        expect((await storage.projectRemotes.getByProjectAndServer("saas", c))?.worktrees_synced_at).not.toBeNull();
        expect((await storage.projectRemotes.getByProjectAndServer("saas", b))?.worktrees_synced_at).toBeNull();
      });

      it("leaves an unreachable, never-listed remote unknown rather than calling it absent", async () => {
        await listOn(a);
        answers({ [a]: worktreesOf([null, "dev"]), [c]: worktreesOf([null]) });

        const response = await check();

        const bravo = response.json().machines.find((machine: { serverId: string }) => machine.serverId === b);
        expect(bravo).toMatchObject({ state: "unknown", checked: false });
      });

      it("keeps a failed create as failed even when the worker now lists the branch", async () => {
        // Retrying is what clears an error — it adopts, then goes ready. A
        // listing is not a retry.
        const failed = await storage.workspaceRegistry.beginCheckout({
          projectId: "saas", branch: "dev", targetId: a,
          worktreePath: conventionalWorktreePath("/srv/repo", "dev"), expectedBranch: "dev",
        });
        await storage.workspaceRegistry.setCheckoutStatus(failed.checkout.id, "error", "lost a race");
        answers({ [a]: worktreesOf([null, "dev"]), [b]: worktreesOf([null]), [c]: worktreesOf([null]) });

        const response = await check();

        const alpha = response.json().machines.find((machine: { serverId: string }) => machine.serverId === a);
        expect(alpha).toEqual({ serverId: a, name: "alpha", state: "error", error: "lost a race", checked: true });
      });

      it("reports a ready row the worker no longer lists as absent, without tombstoning it", async () => {
        await listOn(a);
        answers({ [a]: worktreesOf([null]), [b]: worktreesOf([null]), [c]: worktreesOf([null]) });

        const response = await check();

        const alpha = response.json().machines.find((machine: { serverId: string }) => machine.serverId === a);
        expect(alpha).toEqual({ serverId: a, name: "alpha", state: "absent", checked: true });
        // The live answer goes to the dialog only; the registry is add-only here.
        expect((await storage.workspaceRegistry.getByProjectBranch("saas", "dev", a))?.checkout.status).toBe("ready");
      });

      it("registers a worktree the worker has that the hub did not know about", async () => {
        answers({ [a]: worktreesOf([null, "dev"]), [b]: worktreesOf([null]), [c]: worktreesOf([null]) });

        const response = await check();

        const alpha = response.json().machines.find((machine: { serverId: string }) => machine.serverId === a);
        expect(alpha).toMatchObject({ state: "present", checked: true });
        expect((await storage.workspaceRegistry.getByProjectBranch("saas", "dev", a))?.checkout.status).toBe("ready");
      });

      it("does not mistake a workspace held only elsewhere for one this machine has", async () => {
        // The `?target=` list would append dev (bravo has it); the machine
        // check reads the worker's own list, so alpha stays absent.
        await confirmAll();
        await listOn(b);
        answers({ [a]: worktreesOf([null]), [b]: worktreesOf([null, "dev"]), [c]: worktreesOf([null]) });

        const response = await check();

        expect(machinesOf(response.json())).toEqual({ [a]: "absent", [b]: "present", [c]: "absent" });
      });

      it("answers 200 with nothing checked when every worker is offline", async () => {
        await storage.projectRemotes.markWorktreesSynced("saas", a);
        await listOn(b);
        proxyToRemoteAuto.mockResolvedValue(offline);

        const response = await check();

        expect(response.statusCode).toBe(200);
        expect(response.json().machines.map((machine: { state: string; checked: boolean }) => [machine.state, machine.checked]))
          .toEqual([["absent", false], ["present", false], ["unknown", false]]);
      });

      it("requires a branch: the main workspace is on every machine and cannot be managed", async () => {
        expect((await check("")).statusCode).toBe(400);
      });
    });
  });
});
