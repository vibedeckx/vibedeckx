import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { mkdir } from "fs/promises";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { resolveWorktreePath, getWorktreeBaseForProject, getWorktreeBranches, parseGitWorktreeList, pruneWorktrees, invalidateWorktreeListCache } from "../utils/worktree-paths.js";
import { requireAuth } from "../server.js";
import "../server-types.js";
import type { Project } from "../storage/types.js";

interface RemoteConfig {
  serverId: string;
  url: string;
  apiKey: string;
  remotePath: string;
}

function getAllRemoteConfigs(fastify: FastifyInstance, project: Project): RemoteConfig[] {
  // Check project_remotes table first (new approach)
  const remotes = fastify.storage.projectRemotes.getByProject(project.id);
  if (remotes.length > 0) {
    return remotes.map((r) => ({
      serverId: r.remote_server_id,
      url: r.server_url ?? "",
      apiKey: r.server_api_key ?? "",
      remotePath: r.remote_path,
    }));
  }
  // Fallback to legacy project fields
  if (project.remote_url && project.remote_api_key && project.remote_path) {
    return [{
      serverId: "",
      url: project.remote_url,
      apiKey: project.remote_api_key,
      remotePath: project.remote_path,
    }];
  }
  return [];
}

/** Returns the primary (first) remote config, or null. Used by endpoints that operate on a single remote. */
function getRemoteConfig(fastify: FastifyInstance, project: Project): RemoteConfig | null {
  const all = getAllRemoteConfigs(fastify, project);
  return all.length > 0 ? all[0] : null;
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
      const worktrees = getWorktreeBranches(projectPath);
      return reply.code(200).send({ worktrees });
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

      await mkdir(getWorktreeBaseForProject(projectPath), { recursive: true });

      execFileSync("git", ["worktree", "add", "-b", trimmedBranch, worktreeAbsolutePath, startPoint], {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      invalidateWorktreeListCache(projectPath);

      console.log(`[worktree] ${requestId} Created: branch=${trimmedBranch}`);

      return reply.code(201).send({
        worktree: { branch: trimmedBranch },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
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
          return reply.code(409).send({
            error: "Worktree has uncommitted changes",
          });
        }
      } catch {
        // Continue with deletion
      }

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

      return reply.code(200).send({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to delete worktree: ${errorMessage}` });
    }
  });

  // ==================== Project-based worktree API ====================

  // 获取项目的 worktrees
  fastify.get<{ Params: { id: string } }>("/api/projects/:id/worktrees", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    // Proxy to remote if this is a remote-only project
    const remoteConfig = getRemoteConfig(fastify, project);
    if (!project.path && remoteConfig) {
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "GET",
        `/api/path/worktrees?path=${encodeURIComponent(remoteConfig.remotePath)}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      pruneWorktrees(project.path);
      const worktrees = getWorktreeBranches(project.path);
      return reply.code(200).send({ worktrees });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to list worktrees: ${errorMessage}` });
    }
  });

  // Get branches for a project
  fastify.get<{
    Params: { id: string };
    Querystring: { target?: "local" | "remote" };
  }>("/api/projects/:id/branches", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const target = req.query.target || "local";
    const hasLocal = !!project.path;
    const remoteConfig = getRemoteConfig(fastify, project);
    const hasRemote = !!remoteConfig;

    const proxyBranchesToRemote = async () => {
      const result = await proxyToRemoteAuto(
        remoteConfig!.serverId,
        remoteConfig!.url,
        remoteConfig!.apiKey,
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

    const project = fastify.storage.projects.getById(req.params.id, userId);
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
    const remoteConfigs = getAllRemoteConfigs(fastify, project);
    const hasRemote = remoteConfigs.length > 0;

    // Helper to delete worktree on a single remote
    const deleteOnRemote = async (rc: RemoteConfig) => {
      return proxyToRemoteAuto(
        rc.serverId,
        rc.url,
        rc.apiKey,
        "DELETE",
        `/api/path/worktrees`,
        { path: rc.remotePath, branch },
        { reverseConnectManager: fastify.reverseConnectManager }
      );
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
          const key = rc.serverId || rc.url;
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
    };

    // Local-only project
    if (!hasRemote) {
      try {
        await deleteLocal();
        return reply.code(200).send({ success: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        if (errorMessage.includes("uncommitted changes")) {
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
        const key = remoteConfigs.length === 1 ? "remote" : (rc.serverId || rc.url);
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

    const project = fastify.storage.projects.getById(req.params.id, userId);
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
    const remoteConfigs = getAllRemoteConfigs(fastify, project);
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
      return proxyToRemoteAuto(
        rc.serverId,
        rc.url,
        rc.apiKey,
        "POST",
        `/api/path/worktrees`,
        { path: rc.remotePath, branchName: trimmedBranch, baseBranch: remoteStartPoint },
        { reverseConnectManager: fastify.reverseConnectManager }
      );
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
          const key = rc.serverId || rc.url;
          console.log(`[worktree] Creating remote worktree: project=${req.params.id}, branch=${trimmedBranch}, serverId=${rc.serverId}, url=${rc.url}`);
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

      await mkdir(getWorktreeBaseForProject(project.path!), { recursive: true });

      execFileSync("git", ["worktree", "add", "-b", trimmedBranch, worktreeAbsolutePath, localStartPoint], {
        cwd: project.path!,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      invalidateWorktreeListCache(project.path!);

      return { branch: trimmedBranch };
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
        const key = remoteConfigs.length === 1 ? "remote" : (rc.serverId || rc.url);
        console.log(`[worktree] Creating remote worktree: project=${req.params.id}, branch=${trimmedBranch}, serverId=${rc.serverId}, url=${rc.url}`);
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
