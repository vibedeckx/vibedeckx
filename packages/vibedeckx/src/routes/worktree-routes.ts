import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { mkdir } from "fs/promises";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { resolveWorktreePath, conventionalWorktreePath, getWorktreeBaseForProject, getRegisteredWorktreeBranches, anchorRootWorkspaceBranch, setRootWorkspaceAnchor, parseGitWorktreeList, pruneWorktrees, invalidateWorktreeListCache, type SetAnchorResult } from "../utils/worktree-paths.js";
import { ensurePathProjectId } from "../utils/path-project.js";
import { registerReportedWorktrees, type ReportedWorktree } from "../workspace-binding-backfill.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import "../server-types.js";
import type { Project } from "../storage/types.js";

interface RemoteConfig {
  serverId: string;
  remotePath: string;
}

async function getAllRemoteConfigs(fastify: FastifyInstance, project: Project): Promise<RemoteConfig[]> {
  const remotes = await fastify.storage.projectRemotes.getByProject(project.id);
  return remotes.map((r) => ({
    serverId: r.remote_server_id,
    remotePath: r.remote_path,
  }));
}

/** Returns the primary (first) remote config, or null. Used by endpoints that operate on a single remote. */
async function getRemoteConfig(fastify: FastifyInstance, project: Project): Promise<RemoteConfig | null> {
  const all = await getAllRemoteConfigs(fastify, project);
  return all.length > 0 ? all[0] : null;
}

/** HTTP shape of an explicit anchor that Git or the workspace list refused. */
function anchorFailure(
  reason: Extract<SetAnchorResult, { anchored: false }>["reason"],
  branch: string,
): { code: number; error: string } {
  switch (reason) {
    case "unknown-branch":
      return { code: 400, error: `Branch '${branch}' does not exist in this repository` };
    case "branch-is-another-workspace":
      return { code: 409, error: `'${branch}' already has its own workspace` };
    case "not-a-repository":
      return { code: 400, error: "The main workspace is not a Git repository" };
  }
}

async function ensurePathProject(fastify: FastifyInstance, projectPath: string): Promise<Project> {
  const projectId = await ensurePathProjectId(fastify, projectPath);
  const project = await fastify.storage.projects.getById(projectId);
  if (!project) throw new Error(`Path project '${projectId}' was not persisted`);
  return project;
}

async function syncRemoteWorktreeList(
  fastify: FastifyInstance,
  projectId: string,
  remote: RemoteConfig,
  data: unknown,
): Promise<void> {
  const worktrees = (data as { worktrees?: ReportedWorktree[] })?.worktrees;
  if (!Array.isArray(worktrees)) return;
  await registerReportedWorktrees(fastify.storage, {
    projectId,
    targetId: remote.serverId,
    remotePath: remote.remotePath,
    worktrees,
  });
}

/**
 * The worktree still holds something we could not confirm dead, so the delete
 * was refused. The checkout itself is healthy — this describes the operation,
 * not the checkout — so callers restore its previous status rather than
 * marking it in error.
 */
class WorktreeBusyError extends Error {}

/**
 * Kill everything still executing inside a worktree that is about to be
 * removed, and confirm it is actually gone. Without this, `git worktree
 * remove` deletes the directory out from under a live agent child process and
 * any running executor/terminal PTYs, which keep running with a cwd that no
 * longer exists.
 *
 * Called after the uncommitted-changes check, so a refused delete never costs
 * the user a running agent, and before `git worktree remove`.
 *
 * Both stops wait for the process to exit and escalate to SIGKILL rather than
 * just firing SIGTERM, because a signal that has merely been delivered says
 * nothing about whether the tree is free yet. Anything still alive after the
 * escalation raises `WorktreeBusyError`: removing the directory anyway is the
 * exact orphaning this function exists to prevent, and a retry will normally
 * succeed since the survivor has by then been SIGKILLed.
 *
 * Sessions are matched by (projectId, branch). `projectIds` is a candidate set
 * rather than one id because `projects.path` carries no UNIQUE constraint: on a
 * reverse-connect worker a session may be registered under either a real
 * project row sharing the path or the `path:<path>` pseudo-project, and
 * `ensurePathProjectId` and `getByPath` can pick different ones. Processes are
 * matched by cwd — see `getRunningProcessIdsUnderPath` for why branch is not
 * usable there. Interactive terminals in the worktree are stopped along with
 * executor runs: their cwd is about to disappear too.
 */
async function stopWorkspaceActivity(
  fastify: FastifyInstance,
  opts: { projectIds: Array<string | undefined>; branch: string; worktreePath: string },
): Promise<void> {
  const sessionIds = [...new Set(
    opts.projectIds
      .filter((id): id is string => Boolean(id))
      .flatMap((id) => fastify.agentSessionManager.getLiveSessionIdsForBranch(id, opts.branch)),
  )];
  const processIds = fastify.processManager.getRunningProcessIdsUnderPath(opts.worktreePath);
  if (sessionIds.length === 0 && processIds.length === 0) return;

  // A stop that throws counts as unconfirmed, same as one that times out —
  // both leave a process that may still be alive in the tree.
  const survivors: string[] = [];
  const confirm = async (label: string, stop: () => Promise<boolean>) => {
    try {
      if (!await stop()) survivors.push(label);
    } catch (error) {
      console.error(`[worktree] Failed to stop ${label} before delete:`, error);
      survivors.push(label);
    }
  };

  // Sessions first, then processes; within each group concurrently, so the
  // grace windows overlap instead of summing.
  await Promise.all(sessionIds.map((sessionId) => confirm(`session ${sessionId}`, () =>
    fastify.agentSessionManager.stopSessionAndWait(sessionId, {
      note: "Session stopped: its worktree is being deleted.",
    }))));
  await Promise.all(processIds.map((processId) => confirm(`process ${processId}`, () =>
    fastify.processManager.stopAndWait(processId))));

  if (survivors.length > 0) {
    throw new WorktreeBusyError(
      `Worktree still has running work that could not be stopped (${survivors.join(", ")}). `
      + "Nothing was deleted; retry in a moment.",
    );
  }
  console.log(
    `[worktree] Stopped ${sessionIds.length} session(s) and ${processIds.length} process(es) in ${opts.worktreePath}`,
  );
}

const routes: FastifyPluginAsync = async (fastify) => {
  // ==================== Path-based worktree API ====================

  // Get branches for a path
  fastify.get<{
    Querystring: { path: string };
  }>("/api/path/branches", async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    try {
      const { execSync } = await import("child_process");
      const output = execSync("git branch --format='%(refname:short)'", {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const branches = output
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
      return reply.code(200).send({ branches });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to list branches: ${errorMessage}` });
    }
  });

  // Get worktrees for a path
  fastify.get<{
    Querystring: { path: string };
  }>("/api/path/worktrees", async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    try {
      pruneWorktrees(projectPath);
      const project = await ensurePathProject(fastify, projectPath);
      const worktrees = await getRegisteredWorktreeBranches(fastify.storage, project.id, projectPath);
      const registered = await fastify.storage.workspaceRegistry.listByProject(project.id, "local");
      const pathByBranch = new Map(registered.map((row) => [row.workspace.branch, row.checkout.worktree_path]));
      return reply.code(200).send({
        worktrees: worktrees.map((worktree) => ({
          ...worktree,
          worktreePath: pathByBranch.get(worktree.branch ?? ""),
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to list worktrees: ${errorMessage}` });
    }
  });

  // Create worktree at a path
  fastify.post<{
    Body: { path: string; branchName: string; baseBranch?: string };
  }>("/api/path/worktrees", async (req, reply) => {
    const { path: projectPath, branchName, baseBranch } = req.body;
    const requestId = req.headers["x-request-id"] || "local";

    if (!projectPath || !branchName) {
      return reply.code(400).send({ error: "Path and branchName are required" });
    }

    const trimmedBranch = branchName.trim();
    if (!/^[a-zA-Z0-9]/.test(trimmedBranch) || /[^a-zA-Z0-9/_-]/.test(trimmedBranch)) {
      return reply.code(400).send({ error: "Invalid branch name format" });
    }

    const startPoint = baseBranch?.trim() || "main";
    if (/[^a-zA-Z0-9/_.\-]/.test(startPoint)) {
      return reply.code(400).send({ error: "Invalid base branch name format" });
    }

    console.log(`[worktree] ${requestId} Creating: branch=${trimmedBranch}, base=${startPoint}, path=${projectPath}`);

    let pendingCheckoutId: string | null = null;
    try {
      const { execFileSync } = await import("child_process");

      try {
        execFileSync("git", ["rev-parse", "--verify", `refs/heads/${trimmedBranch}`], {
          cwd: projectPath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return reply.code(409).send({ error: `Branch '${trimmedBranch}' already exists` });
      } catch {
        // Branch doesn't exist, continue
      }

      const worktreeAbsolutePath = resolveWorktreePath(projectPath, trimmedBranch);
      const project = await ensurePathProject(fastify, projectPath);
      const pending = await fastify.storage.workspaceRegistry.beginCheckout({
        projectId: project.id,
        branch: trimmedBranch,
        targetId: "local",
        worktreePath: worktreeAbsolutePath,
        expectedBranch: trimmedBranch,
      });
      pendingCheckoutId = pending.checkout.id;

      await mkdir(getWorktreeBaseForProject(projectPath), { recursive: true });

      execFileSync("git", ["worktree", "add", "-b", trimmedBranch, worktreeAbsolutePath, startPoint], {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      invalidateWorktreeListCache(projectPath);
      await fastify.storage.workspaceRegistry.setCheckoutStatus(pending.checkout.id, "ready");

      console.log(`[worktree] ${requestId} Created: branch=${trimmedBranch}`);

      return reply.code(201).send({
        worktree: { branch: trimmedBranch, worktreePath: worktreeAbsolutePath },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (pendingCheckoutId) {
        await fastify.storage.workspaceRegistry
          .setCheckoutStatus(pendingCheckoutId, "error", errorMessage)
          .catch((registryError) => console.error("[worktree] Failed to record checkout error:", registryError));
      }
      const stderr = (error as { stderr?: string })?.stderr || "";
      console.error(`[worktree] ${requestId} Failed: ${errorMessage}${stderr ? `, stderr: ${stderr}` : ""}`);
      return reply.code(500).send({ error: `Failed to create worktree: ${errorMessage}` });
    }
  });

  // Delete worktree at a path
  fastify.delete<{
    Body: { path: string; branch: string };
  }>("/api/path/worktrees", async (req, reply) => {
    const { path: projectPath, branch } = req.body;
    if (!projectPath || !branch) {
      return reply.code(400).send({ error: "Path and branch are required" });
    }

    if (!/^[a-zA-Z0-9]/.test(branch) || /[^a-zA-Z0-9/_-]/.test(branch)) {
      return reply.code(400).send({ error: "Invalid branch name format" });
    }

    const pathProject = await fastify.storage.projects.getByPath(projectPath);
    const registered = pathProject
      ? await fastify.storage.workspaceRegistry.getByProjectBranch(pathProject.id, branch, "local")
      : undefined;
    if (registered) {
      await fastify.storage.workspaceRegistry.setCheckoutStatus(registered.checkout.id, "deleting");
    }
    let worktreeRemoved = false;
    try {
      const { execSync, execFileSync } = await import("child_process");
      const worktreeAbsPath = resolveWorktreePath(projectPath, branch);

      try {
        const statusOutput = execSync("git status --porcelain", {
          cwd: worktreeAbsPath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (statusOutput.trim() !== "") {
          if (registered) {
            await fastify.storage.workspaceRegistry.setCheckoutStatus(registered.checkout.id, "ready");
          }
          return reply.code(409).send({
            error: "Worktree has uncommitted changes",
          });
        }
      } catch {
        // Continue with deletion
      }

      await stopWorkspaceActivity(fastify, {
        projectIds: [pathProject?.id, `path:${projectPath}`],
        branch,
        worktreePath: worktreeAbsPath,
      });

      let branchToDelete: string | null = null;
      try {
        const entries = parseGitWorktreeList(projectPath);
        const match = entries.find((e) => e.path === worktreeAbsPath);
        if (match) branchToDelete = match.branch;
      } catch {
        // Continue without branch deletion
      }

      execFileSync("git", ["worktree", "remove", worktreeAbsPath], {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      worktreeRemoved = true;
      invalidateWorktreeListCache(projectPath);

      if (branchToDelete) {
        try {
          execFileSync("git", ["branch", "-d", branchToDelete], {
            cwd: projectPath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // Branch deletion failed, not critical
        }
      }

      if (registered) {
        await fastify.storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // A busy worktree is a refusal, not a broken checkout: restore the prior
      // status like the uncommitted-changes path does, and report it as a
      // conflict so the UI does not present it as a server fault.
      const busy = error instanceof WorktreeBusyError;
      if (registered && !worktreeRemoved) {
        await fastify.storage.workspaceRegistry
          .setCheckoutStatus(registered.checkout.id, busy ? "ready" : "error", busy ? null : errorMessage)
          .catch((registryError) => console.error("[worktree] Failed to record delete error:", registryError));
      }
      if (busy) return reply.code(409).send({ error: errorMessage });
      return reply.code(500).send({ error: `Failed to delete worktree: ${errorMessage}` });
    }
  });

  // Adopt the main worktree's live branch as its anchor, clearing the drift
  // warning for a switch the user made on purpose.
  fastify.post<{
    Body: { path: string; branch: string };
  }>("/api/path/worktrees/anchor", async (req, reply) => {
    const { path: projectPath, branch } = req.body ?? {};
    if (!projectPath || !branch) {
      return reply.code(400).send({ error: "Path and branch are required" });
    }

    try {
      const project = await ensurePathProject(fastify, projectPath);
      const result = await anchorRootWorkspaceBranch(fastify.storage, project.id, projectPath, branch);
      if (!result.anchored) {
        return reply.code(409).send({
          error: `The main workspace is on '${result.currentBranch ?? "detached HEAD"}', not '${branch}'`,
          currentBranch: result.currentBranch,
        });
      }
      return reply.code(200).send({ expectedBranch: result.expectedBranch });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to anchor workspace: ${errorMessage}` });
    }
  });

  // Set the main workspace's anchor to a branch the user picked, which need not
  // be the one checked out — the resulting drift is the point (see
  // setRootWorkspaceAnchor). Separate from /anchor so an old worker 404s it
  // instead of applying that route's live-branch guard to a different intent.
  fastify.post<{
    Body: { path: string; branch: string };
  }>("/api/path/worktrees/anchor-branch", async (req, reply) => {
    const { path: projectPath, branch } = req.body ?? {};
    if (!projectPath || !branch) {
      return reply.code(400).send({ error: "Path and branch are required" });
    }

    try {
      const project = await ensurePathProject(fastify, projectPath);
      const result = await setRootWorkspaceAnchor(fastify.storage, project.id, projectPath, branch);
      if (!result.anchored) {
        const failure = anchorFailure(result.reason, branch);
        return reply.code(failure.code).send({ error: failure.error });
      }
      return reply.code(200).send({ expectedBranch: result.expectedBranch });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to anchor workspace: ${errorMessage}` });
    }
  });

  // ==================== Project-based worktree API ====================

  // 获取项目的 worktrees
  fastify.get<{ Params: { id: string }; Querystring: { target?: string } }>("/api/projects/:id/worktrees", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const requestedTarget = req.query.target ?? "local";
    if (requestedTarget !== "local") {
      const targetRemote = await fastify.storage.projectRemotes.getByProjectAndServer(project.id, requestedTarget);
      if (!targetRemote) return reply.code(400).send({ error: "Unknown remote target" });
      const result = await proxyToRemoteAuto(
        targetRemote.remote_server_id,
        "GET",
        `/api/path/worktrees?path=${encodeURIComponent(targetRemote.remote_path)}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      if (result.ok) {
        await syncRemoteWorktreeList(fastify, project.id, {
          serverId: targetRemote.remote_server_id,
          remotePath: targetRemote.remote_path,
        }, result.data);
      }
      return reply.code(proxyStatus(result)).send(result.data);
    }

    // Proxy to remote if this is a remote-only project
    const remoteConfig = await getRemoteConfig(fastify, project);
    if (!project.path && remoteConfig) {
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        "GET",
        `/api/path/worktrees?path=${encodeURIComponent(remoteConfig.remotePath)}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      if (result.ok) await syncRemoteWorktreeList(fastify, project.id, remoteConfig, result.data);
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      pruneWorktrees(project.path);
      const worktrees = await getRegisteredWorktreeBranches(fastify.storage, project.id, project.path);
      return reply.code(200).send({ worktrees });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to list worktrees: ${errorMessage}` });
    }
  });

  // Anchor the main workspace to the branch it is checked out on now
  fastify.post<{
    Params: { id: string };
    Body: { branch: string; target?: string };
  }>("/api/projects/:id/worktrees/anchor", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.body?.branch;
    if (!branch) return reply.code(400).send({ error: "Branch is required" });

    const requestedTarget = req.body.target ?? "local";
    let remoteConfig: RemoteConfig | null;
    if (requestedTarget === "local") {
      // A project with no local path is remote-only: "local" means its remote.
      remoteConfig = project.path ? null : await getRemoteConfig(fastify, project);
    } else {
      const targetRemote = await fastify.storage.projectRemotes.getByProjectAndServer(project.id, requestedTarget);
      if (!targetRemote) return reply.code(400).send({ error: "Unknown remote target" });
      remoteConfig = { serverId: targetRemote.remote_server_id, remotePath: targetRemote.remote_path };
    }

    if (remoteConfig) {
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        "POST",
        "/api/path/worktrees/anchor",
        { path: remoteConfig.remotePath, branch },
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      // Additive route: a worker that predates it 404s. Say so, rather than
      // letting the UI report the workspace as missing.
      if (result.status === 404) {
        return reply.code(501).send({
          error: "This remote worker is too old to anchor a workspace. Update it and try again.",
        });
      }
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const result = await anchorRootWorkspaceBranch(fastify.storage, project.id, project.path, branch);
      if (!result.anchored) {
        return reply.code(409).send({
          error: `The main workspace is on '${result.currentBranch ?? "detached HEAD"}', not '${branch}'`,
          currentBranch: result.currentBranch,
        });
      }
      return reply.code(200).send({ expectedBranch: result.expectedBranch });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to anchor workspace: ${errorMessage}` });
    }
  });

  // Rename the main workspace to a branch the user picked from its branch list,
  // independent of what is checked out there.
  fastify.post<{
    Params: { id: string };
    Body: { branch: string; target?: string };
  }>("/api/projects/:id/worktrees/anchor-branch", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.body?.branch;
    if (!branch) return reply.code(400).send({ error: "Branch is required" });

    const requestedTarget = req.body.target ?? "local";
    let remoteConfig: RemoteConfig | null;
    if (requestedTarget === "local") {
      // A project with no local path is remote-only: "local" means its remote.
      remoteConfig = project.path ? null : await getRemoteConfig(fastify, project);
    } else {
      const targetRemote = await fastify.storage.projectRemotes.getByProjectAndServer(project.id, requestedTarget);
      if (!targetRemote) return reply.code(400).send({ error: "Unknown remote target" });
      remoteConfig = { serverId: targetRemote.remote_server_id, remotePath: targetRemote.remote_path };
    }

    if (remoteConfig) {
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        "POST",
        "/api/path/worktrees/anchor-branch",
        { path: remoteConfig.remotePath, branch },
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      // Additive route: a worker that predates it 404s. Say so, rather than
      // letting the UI report the workspace as missing.
      if (result.status === 404) {
        return reply.code(501).send({
          error: "This remote worker is too old to change a workspace branch. Update it and try again.",
        });
      }
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const result = await setRootWorkspaceAnchor(fastify.storage, project.id, project.path, branch);
      if (!result.anchored) {
        const failure = anchorFailure(result.reason, branch);
        return reply.code(failure.code).send({ error: failure.error });
      }
      return reply.code(200).send({ expectedBranch: result.expectedBranch });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to anchor workspace: ${errorMessage}` });
    }
  });

  // Get branches for a project
  fastify.get<{
    Params: { id: string };
    Querystring: { target?: "local" | "remote" };
  }>("/api/projects/:id/branches", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const target = req.query.target || "local";
    const hasLocal = !!project.path;
    const remoteConfig = await getRemoteConfig(fastify, project);
    const hasRemote = !!remoteConfig;

    const proxyBranchesToRemote = async () => {
      const result = await proxyToRemoteAuto(
        remoteConfig!.serverId,
        "GET",
        `/api/path/branches?path=${encodeURIComponent(remoteConfig!.remotePath)}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(proxyStatus(result)).send(result.data);
    };

    if (target === "remote") {
      if (!hasRemote) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      return proxyBranchesToRemote();
    }

    // target === "local"
    if (!hasLocal && hasRemote) {
      // Remote-only project: proxy to remote
      return proxyBranchesToRemote();
    }

    if (!hasLocal) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const { execSync } = await import("child_process");
      const output = execSync("git branch --format='%(refname:short)'", {
        cwd: project.path!,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const branches = output
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
      return reply.code(200).send({ branches });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to list branches: ${errorMessage}` });
    }
  });

  // 删除 git worktree
  fastify.delete<{
    Params: { id: string };
    Body: { branch: string };
  }>("/api/projects/:id/worktrees", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branch } = req.body;

    if (!branch || typeof branch !== "string" || branch.trim() === "") {
      return reply.code(400).send({ error: "Branch is required" });
    }

    if (!/^[a-zA-Z0-9]/.test(branch) || /[^a-zA-Z0-9/_-]/.test(branch)) {
      return reply.code(400).send({ error: "Invalid branch name format" });
    }

    const hasLocal = !!project.path;
    const remoteConfigs = await getAllRemoteConfigs(fastify, project);
    const hasRemote = remoteConfigs.length > 0;

    // Helper to delete worktree on a single remote
    const deleteOnRemote = async (rc: RemoteConfig) => {
      const registered = await fastify.storage.workspaceRegistry
        .getByProjectBranch(project.id, branch, rc.serverId);
      const restorePreviousStatus = async () => {
        if (!registered) return;
        const current = await fastify.storage.workspaceRegistry
          .getByProjectBranch(project.id, branch, rc.serverId);
        if (!current || current.checkout.status !== "deleting") return;
        await fastify.storage.workspaceRegistry.setCheckoutStatusIfCurrent(
          registered.checkout.id,
          { status: "deleting", updatedAt: current.checkout.updated_at },
          registered.checkout.status,
          registered.checkout.error,
        );
      };
      if (registered) {
        await fastify.storage.workspaceRegistry.setCheckoutStatus(registered.checkout.id, "deleting");
      }
      try {
        const result = await proxyToRemoteAuto(
          rc.serverId,
          "DELETE",
          `/api/path/worktrees`,
          { path: rc.remotePath, branch },
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        if (registered) {
          if (result.ok) {
            await fastify.storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);
          } else {
            // A failed delete describes the operation, not checkout health.
            // This includes explicit refusal, worker 5xx, and transport
            // failures where the remote outcome is unknown.
            await restorePreviousStatus();
          }
        }
        return result;
      } catch (error) {
        if (registered) {
          await restorePreviousStatus()
            .catch((registryError) => console.error("[worktree] Failed to restore remote checkout status:", registryError));
        }
        throw error;
      }
    };

    // Remote-only project: delete from all remotes
    if (!hasLocal && hasRemote) {
      if (remoteConfigs.length === 1) {
        // Single remote: backward-compatible flat response
        const result = await deleteOnRemote(remoteConfigs[0]);
        return reply.code(proxyStatus(result)).send(result.data);
      }

      // Multiple remotes: delete from all in parallel
      const results: Record<string, { success: boolean; error?: string }> = {};
      await Promise.allSettled(
        remoteConfigs.map(async (rc) => {
          const key = rc.serverId;
          try {
            const result = await deleteOnRemote(rc);
            if (result.ok) {
              results[key] = { success: true };
            } else {
              const data = result.data as { error?: string };
              results[key] = { success: false, error: data.error || "Remote deletion failed" };
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            results[key] = { success: false, error: errorMessage };
          }
        })
      );

      const anyFailed = Object.values(results).some((r) => !r.success);
      if (anyFailed) {
        return reply.code(207).send({ success: true, results });
      }
      return reply.code(200).send({ success: true, results });
    }

    if (!hasLocal) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    // Local deletion helper
    const deleteLocal = async () => {
      const { execSync, execFileSync } = await import("child_process");
      const worktreeAbsPath = resolveWorktreePath(project.path!, branch);
      const registered = await fastify.storage.workspaceRegistry
        .getByProjectBranch(project.id, branch, "local");
      if (registered) {
        await fastify.storage.workspaceRegistry.setCheckoutStatus(registered.checkout.id, "deleting");
      }
      let worktreeRemoved = false;

      try {
        try {
          const statusOutput = execSync("git status --porcelain", {
            cwd: worktreeAbsPath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });

          if (statusOutput.trim() !== "") {
            throw new Error("Worktree has uncommitted changes. Please commit or discard changes before deleting.");
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes("uncommitted changes")) throw err;
          // If git status fails for other reasons, continue with deletion attempt
        }

        await stopWorkspaceActivity(fastify, {
          projectIds: [project.id],
          branch,
          worktreePath: worktreeAbsPath,
        });

        let branchToDelete: string | null = null;
        try {
          const entries = parseGitWorktreeList(project.path!);
          const match = entries.find((e) => e.path === worktreeAbsPath);
          if (match) branchToDelete = match.branch;
        } catch {
          // Failed to get branch info, continue without deleting branch
        }

        execFileSync("git", ["worktree", "remove", worktreeAbsPath], {
          cwd: project.path!,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        worktreeRemoved = true;
        invalidateWorktreeListCache(project.path!);

        if (branchToDelete) {
          try {
            execFileSync("git", ["branch", "-d", branchToDelete], {
              cwd: project.path!,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch {
            // Branch deletion failed, not critical
          }
        }
        if (registered) {
          await fastify.storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);
        }
      } catch (error) {
        if (registered && !worktreeRemoved) {
          const message = error instanceof Error ? error.message : "Local deletion failed";
          // A busy worktree joins uncommitted changes as a refusal that leaves
          // the checkout itself perfectly healthy.
          const status = message.includes("uncommitted changes") || error instanceof WorktreeBusyError
            ? "ready"
            : "error";
          await fastify.storage.workspaceRegistry
            .setCheckoutStatus(registered.checkout.id, status, status === "error" ? message : null)
            .catch((registryError) => console.error("[worktree] Failed to record local delete error:", registryError));
        }
        throw error;
      }
    };

    // Local-only project
    if (!hasRemote) {
      try {
        await deleteLocal();
        return reply.code(200).send({ success: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        if (errorMessage.includes("uncommitted changes") || error instanceof WorktreeBusyError) {
          return reply.code(409).send({ error: errorMessage });
        }
        return reply.code(500).send({ error: `Failed to delete worktree: ${errorMessage}` });
      }
    }

    // Hybrid project: delete from local + all remotes
    const results: Record<string, { success: boolean; error?: string }> = {};

    // Delete local first
    try {
      await deleteLocal();
      results.local = { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // Local failure: return error immediately, don't attempt remotes
      return reply.code(500).send({ error: `Failed to delete local worktree: ${errorMessage}` });
    }

    // Delete from all remotes in parallel
    await Promise.allSettled(
      remoteConfigs.map(async (rc) => {
        const key = remoteConfigs.length === 1 ? "remote" : rc.serverId;
        try {
          const remoteResult = await deleteOnRemote(rc);
          if (remoteResult.ok) {
            results[key] = { success: true };
          } else {
            const remoteData = remoteResult.data as { error?: string };
            results[key] = { success: false, error: remoteData.error || "Remote deletion failed" };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          results[key] = { success: false, error: errorMessage };
        }
      })
    );

    const anyRemoteFailed = Object.entries(results).some(([k, v]) => k !== "local" && !v.success);
    if (anyRemoteFailed) {
      return reply.code(207).send({ success: true, results });
    }

    return reply.code(200).send({ success: true, results });
  });

  // 创建新的 git worktree
  fastify.post<{
    Params: { id: string };
    Body: { branchName: string; targets?: ("local" | "remote")[]; baseBranch?: string; remoteBaseBranch?: string };
  }>("/api/projects/:id/worktrees", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branchName, baseBranch, remoteBaseBranch } = req.body;

    if (!branchName || typeof branchName !== "string" || branchName.trim() === "") {
      return reply.code(400).send({ error: "Branch name is required" });
    }

    const trimmedBranch = branchName.trim();
    if (!/^[a-zA-Z0-9]/.test(trimmedBranch) || /[^a-zA-Z0-9/_-]/.test(trimmedBranch)) {
      return reply.code(400).send({ error: "Invalid branch name format" });
    }

    const localStartPoint = baseBranch?.trim() || "main";
    if (/[^a-zA-Z0-9/_.\-]/.test(localStartPoint)) {
      return reply.code(400).send({ error: "Invalid base branch name format" });
    }
    const remoteStartPoint = remoteBaseBranch?.trim() || localStartPoint;
    if (/[^a-zA-Z0-9/_.\-]/.test(remoteStartPoint)) {
      return reply.code(400).send({ error: "Invalid remote base branch name format" });
    }

    // Determine targets
    const hasLocal = !!project.path;
    const remoteConfigs = await getAllRemoteConfigs(fastify, project);
    const hasRemote = remoteConfigs.length > 0;
    let targets: ("local" | "remote")[];

    if (req.body.targets && req.body.targets.length > 0) {
      targets = req.body.targets;
    } else if (!hasLocal && hasRemote) {
      targets = ["remote"];
    } else {
      targets = ["local"];
    }

    // Validate targets against project capabilities
    if (targets.includes("local") && !hasLocal) {
      return reply.code(400).send({ error: "Project has no local path" });
    }
    if (targets.includes("remote") && !hasRemote) {
      return reply.code(400).send({ error: "Project has no remote configuration" });
    }

    // Helper to create worktree on a single remote
    const createOnRemote = async (rc: RemoteConfig) => {
      const previous = await fastify.storage.workspaceRegistry
        .getByProjectBranch(project.id, trimmedBranch, rc.serverId);
      const preserveReady = previous?.checkout.status === "ready";
      const pending = preserveReady && previous
        ? previous
        : await fastify.storage.workspaceRegistry.beginCheckout({
            projectId: project.id,
            branch: trimmedBranch,
            targetId: rc.serverId,
            worktreePath: conventionalWorktreePath(rc.remotePath, trimmedBranch),
            expectedBranch: trimmedBranch,
            pathSource: "conventional",
          });
      try {
        const result = await proxyToRemoteAuto(
          rc.serverId,
          "POST",
          `/api/path/worktrees`,
          { path: rc.remotePath, branchName: trimmedBranch, baseBranch: remoteStartPoint },
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        if (result.ok) {
          const data = result.data as { worktree?: { worktreePath?: unknown } };
          const reportedPath = typeof data.worktree?.worktreePath === "string"
            ? data.worktree.worktreePath
            : null;
          if (reportedPath && !preserveReady) {
            await fastify.storage.workspaceRegistry.registerReadyCheckout({
              projectId: project.id,
              branch: trimmedBranch,
              targetId: rc.serverId,
              worktreePath: reportedPath,
              expectedBranch: trimmedBranch,
              pathSource: "reported",
            });
          } else {
            await fastify.storage.workspaceRegistry.setCheckoutStatus(pending.checkout.id, "ready");
          }
        } else if (preserveReady) {
          // A duplicate/retried create must not turn an already healthy
          // checkout into a sticky error merely because the worker rejected
          // the redundant operation.
          await fastify.storage.workspaceRegistry.setCheckoutStatus(pending.checkout.id, "ready");
        } else {
          const detail = result.data as { error?: string };
          await fastify.storage.workspaceRegistry.setCheckoutStatus(
            pending.checkout.id, "error", detail.error ?? result.errorCode ?? "Remote creation failed",
          );
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Remote creation failed";
        await fastify.storage.workspaceRegistry
          .setCheckoutStatus(
            pending.checkout.id,
            preserveReady ? "ready" : "error",
            preserveReady ? null : message,
          )
          .catch((registryError) => console.error("[worktree] Failed to record remote checkout error:", registryError));
        throw error;
      }
    };

    // Single-target: remote only
    if (targets.length === 1 && targets[0] === "remote") {
      if (remoteConfigs.length === 1) {
        // Single remote: backward-compatible flat response
        const result = await createOnRemote(remoteConfigs[0]);
        return reply.code(proxyStatus(result, 201)).send(result.data);
      }

      // Multiple remotes: create on all in parallel
      const results: Record<string, { success: boolean; worktree?: { branch: string }; error?: string; errorCode?: string; requestId?: string }> = {};
      const settled = await Promise.allSettled(
        remoteConfigs.map(async (rc) => {
          const key = rc.serverId;
          console.log(`[worktree] Creating remote worktree: project=${req.params.id}, branch=${trimmedBranch}, serverId=${rc.serverId}`);
          try {
            const result = await createOnRemote(rc);
            if (result.ok) {
              const data = result.data as { worktree?: { branch: string } };
              results[key] = { success: true, worktree: data.worktree };
            } else {
              const data = result.data as { error?: string };
              console.error(`[worktree] Remote failed: serverId=${rc.serverId}, requestId=${result.requestId}, error=${JSON.stringify(result.data)}`);
              results[key] = { success: false, error: data.error || "Remote creation failed", errorCode: result.errorCode, requestId: result.requestId };
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            results[key] = { success: false, error: errorMessage };
          }
        })
      );

      const anyFailed = Object.values(results).some((r) => !r.success);
      const allFailed = Object.values(results).every((r) => !r.success);
      if (allFailed) {
        return reply.code(500).send({ error: "Failed to create worktree on all remotes", results });
      }
      if (anyFailed) {
        return reply.code(207).send({ worktree: { branch: trimmedBranch }, results });
      }
      return reply.code(201).send({ worktree: { branch: trimmedBranch }, results });
    }

    // Local creation helper
    const createLocal = async () => {
      const { execFileSync } = await import("child_process");

      try {
        execFileSync("git", ["rev-parse", "--verify", `refs/heads/${trimmedBranch}`], {
          cwd: project.path!,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        throw new Error(`Branch '${trimmedBranch}' already exists`);
      } catch (err) {
        // If it's our own "already exists" error, rethrow
        if (err instanceof Error && err.message.includes("already exists")) throw err;
        // Otherwise branch doesn't exist, which is what we want
      }

      const worktreeAbsolutePath = resolveWorktreePath(project.path!, trimmedBranch);
      const pending = await fastify.storage.workspaceRegistry.beginCheckout({
        projectId: project.id,
        branch: trimmedBranch,
        targetId: "local",
        worktreePath: worktreeAbsolutePath,
        expectedBranch: trimmedBranch,
      });

      try {
        await mkdir(getWorktreeBaseForProject(project.path!), { recursive: true });

        execFileSync("git", ["worktree", "add", "-b", trimmedBranch, worktreeAbsolutePath, localStartPoint], {
          cwd: project.path!,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        invalidateWorktreeListCache(project.path!);
        await fastify.storage.workspaceRegistry.setCheckoutStatus(pending.checkout.id, "ready");
        return { branch: trimmedBranch };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Local creation failed";
        await fastify.storage.workspaceRegistry
          .setCheckoutStatus(pending.checkout.id, "error", message)
          .catch((registryError) => console.error("[worktree] Failed to record local checkout error:", registryError));
        throw error;
      }
    };

    // Single-target: local only (backward-compatible path)
    if (targets.length === 1 && targets[0] === "local") {
      try {
        const worktree = await createLocal();
        return reply.code(201).send({ worktree });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        if (errorMessage.includes("already exists")) {
          return reply.code(409).send({ error: errorMessage });
        }
        return reply.code(500).send({ error: `Failed to create worktree: ${errorMessage}` });
      }
    }

    // Multi-target: local + remote(s)
    const results: Record<string, { success: boolean; worktree?: { branch: string }; error?: string; errorCode?: string; requestId?: string }> = {};

    // Local first
    let localWorktree: { branch: string } | undefined;
    try {
      localWorktree = await createLocal();
      results.local = { success: true, worktree: localWorktree };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // Local failure: return error immediately, don't attempt remotes
      return reply.code(500).send({ error: `Failed to create local worktree: ${errorMessage}` });
    }

    // All remotes in parallel
    await Promise.allSettled(
      remoteConfigs.map(async (rc) => {
        const key = remoteConfigs.length === 1 ? "remote" : rc.serverId;
        console.log(`[worktree] Creating remote worktree: project=${req.params.id}, branch=${trimmedBranch}, serverId=${rc.serverId}`);
        try {
          const remoteResult = await createOnRemote(rc);
          if (remoteResult.ok) {
            const remoteData = remoteResult.data as { worktree?: { branch: string } };
            results[key] = { success: true, worktree: remoteData.worktree };
          } else {
            const remoteData = remoteResult.data as { error?: string };
            console.error(`[worktree] Remote failed: serverId=${rc.serverId}, requestId=${remoteResult.requestId}, errorCode=${remoteResult.errorCode}, status=${remoteResult.status}, duration=${remoteResult.durationMs}ms, error=${JSON.stringify(remoteResult.data)}`);
            results[key] = {
              success: false,
              error: remoteData.error || "Remote creation failed",
              errorCode: remoteResult.errorCode,
              requestId: remoteResult.requestId,
            };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          results[key] = { success: false, error: errorMessage };
        }
      })
    );

    // If any remote failed, return 207 partial success
    const anyRemoteFailed = Object.entries(results).some(([k, v]) => k !== "local" && !v.success);
    if (anyRemoteFailed) {
      return reply.code(207).send({
        worktree: localWorktree,
        results,
      });
    }

    return reply.code(201).send({
      worktree: localWorktree,
      results,
    });
  });
};

export default fp(routes, { name: "worktree-routes" });
