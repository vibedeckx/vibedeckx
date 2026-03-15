import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { mkdir } from "fs/promises";
import { proxyToRemote } from "../utils/remote-proxy.js";
import { resolveWorktreePath, getWorktreeBaseForProject, getWorktreeBranches, parseGitWorktreeList } from "../utils/worktree-paths.js";
import { requireAuth } from "../server.js";
import "../server-types.js";

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
      const { execSync } = await import("child_process");

      try {
        execSync(`git rev-parse --verify refs/heads/${trimmedBranch}`, {
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

      execSync(`git worktree add -b "${trimmedBranch}" "${worktreeAbsolutePath}" "${startPoint}"`, {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

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

    try {
      const { execSync } = await import("child_process");
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

      execSync(`git worktree remove "${worktreeAbsPath}"`, {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (branchToDelete) {
        try {
          execSync(`git branch -d "${branchToDelete}"`, {
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
    if (!project.path && project.remote_url && project.remote_api_key && project.remote_path) {
      const result = await proxyToRemote(
        project.remote_url,
        project.remote_api_key,
        "GET",
        `/api/path/worktrees?path=${encodeURIComponent(project.remote_path)}`
      );
      return reply.code(result.status || 200).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
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
    const hasRemote = !!(project.remote_url && project.remote_api_key && project.remote_path);

    if (target === "remote") {
      if (!hasRemote) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const result = await proxyToRemote(
        project.remote_url!,
        project.remote_api_key!,
        "GET",
        `/api/path/branches?path=${encodeURIComponent(project.remote_path!)}`
      );
      return reply.code(result.status || 200).send(result.data);
    }

    // target === "local"
    if (!hasLocal && hasRemote) {
      // Remote-only project: proxy to remote
      const result = await proxyToRemote(
        project.remote_url!,
        project.remote_api_key!,
        "GET",
        `/api/path/branches?path=${encodeURIComponent(project.remote_path!)}`
      );
      return reply.code(result.status || 200).send(result.data);
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

    const hasLocal = !!project.path;
    const hasRemote = !!(project.remote_url && project.remote_api_key && project.remote_path);

    // Remote-only project: proxy to remote
    if (!hasLocal && hasRemote) {
      const result = await proxyToRemote(
        project.remote_url!,
        project.remote_api_key!,
        "DELETE",
        `/api/path/worktrees`,
        { path: project.remote_path, branch }
      );
      return reply.code(result.status || 200).send(result.data);
    }

    if (!hasLocal) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    // Local deletion helper
    const deleteLocal = async () => {
      const { execSync } = await import("child_process");
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

      execSync(`git worktree remove "${worktreeAbsPath}"`, {
        cwd: project.path!,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (branchToDelete) {
        try {
          execSync(`git branch -d "${branchToDelete}"`, {
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

    // Hybrid project: delete from both local and remote
    const results: Record<string, { success: boolean; error?: string }> = {};

    // Delete local first
    try {
      await deleteLocal();
      results.local = { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // Local failure: return error immediately, don't attempt remote
      return reply.code(500).send({ error: `Failed to delete local worktree: ${errorMessage}` });
    }

    // Delete remote
    try {
      const remoteResult = await proxyToRemote(
        project.remote_url!,
        project.remote_api_key!,
        "DELETE",
        `/api/path/worktrees`,
        { path: project.remote_path, branch }
      );
      if (remoteResult.ok) {
        results.remote = { success: true };
      } else {
        const remoteData = remoteResult.data as { error?: string };
        results.remote = { success: false, error: remoteData.error || "Remote deletion failed" };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      results.remote = { success: false, error: errorMessage };
    }

    if (!results.remote?.success) {
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
    const hasRemote = !!(project.remote_url && project.remote_api_key && project.remote_path);
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

    // Single-target: remote only (backward-compatible path)
    if (targets.length === 1 && targets[0] === "remote") {
      const result = await proxyToRemote(
        project.remote_url!,
        project.remote_api_key!,
        "POST",
        `/api/path/worktrees`,
        { path: project.remote_path, branchName: trimmedBranch, baseBranch: remoteStartPoint }
      );
      return reply.code(result.status || 201).send(result.data);
    }

    // Local creation helper
    const createLocal = async () => {
      const { execSync } = await import("child_process");

      try {
        execSync(`git rev-parse --verify refs/heads/${trimmedBranch}`, {
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

      execSync(`git worktree add -b "${trimmedBranch}" "${worktreeAbsolutePath}" "${localStartPoint}"`, {
        cwd: project.path!,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

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

    // Multi-target: local + remote
    const results: Record<string, { success: boolean; worktree?: { branch: string }; error?: string; errorCode?: string; requestId?: string }> = {};

    // Local first
    let localWorktree: { branch: string } | undefined;
    try {
      localWorktree = await createLocal();
      results.local = { success: true, worktree: localWorktree };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // Local failure: return error immediately, don't attempt remote
      return reply.code(500).send({ error: `Failed to create local worktree: ${errorMessage}` });
    }

    // Remote second
    console.log(`[worktree] Creating remote worktree: project=${req.params.id}, branch=${trimmedBranch}, url=${project.remote_url}`);
    try {
      const remoteResult = await proxyToRemote(
        project.remote_url!,
        project.remote_api_key!,
        "POST",
        `/api/path/worktrees`,
        { path: project.remote_path, branchName: trimmedBranch, baseBranch: remoteStartPoint }
      );
      if (remoteResult.ok) {
        const remoteData = remoteResult.data as { worktree?: { branch: string } };
        results.remote = { success: true, worktree: remoteData.worktree };
      } else {
        const remoteData = remoteResult.data as { error?: string };
        console.error(`[worktree] Remote failed: requestId=${remoteResult.requestId}, errorCode=${remoteResult.errorCode}, status=${remoteResult.status}, duration=${remoteResult.durationMs}ms, error=${JSON.stringify(remoteResult.data)}`);
        results.remote = {
          success: false,
          error: remoteData.error || "Remote creation failed",
          errorCode: remoteResult.errorCode,
          requestId: remoteResult.requestId,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      results.remote = { success: false, error: errorMessage };
    }

    // If remote failed, return 207 partial success
    if (!results.remote?.success) {
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
