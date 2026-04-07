import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { parseDiffOutput } from "../utils/diff-parser.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { resolveWorktreePath } from "../utils/worktree-paths.js";
import { requireAuth } from "../server.js";
import "../server-types.js";
import type { Project } from "../storage/types.js";

function getRemoteConfig(fastify: FastifyInstance, project: Project) {
  // Check project_remotes table first (new approach)
  const remotes = fastify.storage.projectRemotes.getByProject(project.id);
  if (remotes.length > 0) {
    const primary = remotes[0]; // sorted by sort_order
    return {
      serverId: primary.remote_server_id,
      url: primary.server_url ?? "",
      apiKey: primary.server_api_key ?? "",
      remotePath: primary.remote_path,
    };
  }
  // Fallback to legacy project fields
  if (project.remote_url && project.remote_api_key && project.remote_path) {
    return {
      serverId: "",
      url: project.remote_url,
      apiKey: project.remote_api_key,
      remotePath: project.remote_path,
    };
  }
  return null;
}

interface CommitEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

function parseGitLogOutput(output: string): CommitEntry[] {
  const lines = output.trim().split("\n");
  const commits: CommitEntry[] = [];
  // 5 lines per commit: hash, shortHash, message, author, date
  for (let i = 0; i + 4 < lines.length; i += 5) {
    commits.push({
      hash: lines[i],
      shortHash: lines[i + 1],
      message: lines[i + 2],
      author: lines[i + 3],
      date: lines[i + 4],
    });
  }
  return commits;
}

function buildDiffCommand(commit?: string): string {
  if (!commit) {
    // Uncommitted changes: working tree vs HEAD
    return `git diff HEAD --no-color`;
  }
  // Changes made by a specific commit (compare with its parent)
  return `git diff ${commit}^ ${commit} --no-color`;
}

function buildDiffFallbackCommand(commit: string): string {
  // Fallback for root commits that have no parent
  return `git show ${commit} --format="" --no-color`;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Get diff for a path (path-based, for remote execution)
  fastify.get<{
    Querystring: { path: string; branch?: string; commit?: string };
  }>("/api/path/diff", async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    const branch = req.query.branch;
    const commit = req.query.commit;

    if (commit && !/^[0-9a-f]+$/i.test(commit)) {
      return reply.code(400).send({ error: "Invalid commit hash" });
    }

    const cwd = resolveWorktreePath(projectPath, branch ?? null);

    try {
      const { execSync } = await import("child_process");
      const diffOutput = execSync(buildDiffCommand(commit), {
        cwd,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const files = parseDiffOutput(diffOutput);
      return reply.code(200).send({ files });
    } catch {
      try {
        const { execSync } = await import("child_process");
        const diffOutput = execSync(
          commit ? buildDiffFallbackCommand(commit) : "git diff --no-color",
          { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
        );
        const files = parseDiffOutput(diffOutput);
        return reply.code(200).send({ files });
      } catch {
        return reply.code(200).send({ files: [] });
      }
    }
  });

  // Get commits for a path (path-based, for remote execution)
  fastify.get<{
    Querystring: { path: string; branch?: string; limit?: string };
  }>("/api/path/commits", async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    const branch = req.query.branch;
    const limit = parseInt(req.query.limit || "20", 10);
    const cwd = resolveWorktreePath(projectPath, branch ?? null);

    try {
      const { execSync } = await import("child_process");
      const output = execSync(
        `git log --format=%H%n%h%n%s%n%an%n%aI -n ${limit}`,
        { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
      );
      const commits = parseGitLogOutput(output);
      return reply.code(200).send({ commits });
    } catch {
      return reply.code(200).send({ commits: [] });
    }
  });

  // Get git diff for a project (uncommitted changes or single commit)
  fastify.get<{
    Params: { id: string };
    Querystring: { branch?: string; commit?: string; target?: 'local' | 'remote' };
  }>("/api/projects/:id/diff", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.query.branch;
    const commit = req.query.commit;
    const target = req.query.target;

    if (commit && !/^[0-9a-f]+$/i.test(commit)) {
      return reply.code(400).send({ error: "Invalid commit hash" });
    }

    const useRemote = target === 'remote'
      || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [`path=${encodeURIComponent(remoteConfig.remotePath)}`];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      if (commit) params.push(`commit=${encodeURIComponent(commit)}`);
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "GET",
        `/api/path/diff?${params.join("&")}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(result.status || 200).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const cwd = resolveWorktreePath(project.path, branch ?? null);

    try {
      const { execSync } = await import("child_process");
      const diffOutput = execSync(buildDiffCommand(commit), {
        cwd,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const files = parseDiffOutput(diffOutput);
      return reply.code(200).send({ files });
    } catch {
      try {
        const { execSync } = await import("child_process");
        const diffOutput = execSync(
          commit ? buildDiffFallbackCommand(commit) : "git diff --no-color",
          { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
        );
        const files = parseDiffOutput(diffOutput);
        return reply.code(200).send({ files });
      } catch {
        return reply.code(200).send({ files: [] });
      }
    }
  });

  // Get commits for a project (project-based)
  fastify.get<{
    Params: { id: string };
    Querystring: { branch?: string; limit?: string; target?: 'local' | 'remote' };
  }>("/api/projects/:id/commits", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.query.branch;
    const limit = parseInt(req.query.limit || "20", 10);
    const target = req.query.target;

    const useRemote = target === 'remote'
      || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [`path=${encodeURIComponent(remoteConfig.remotePath)}`];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      params.push(`limit=${limit}`);
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "GET",
        `/api/path/commits?${params.join("&")}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(result.status || 200).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const cwd = resolveWorktreePath(project.path, branch ?? null);

    try {
      const { execSync } = await import("child_process");
      const output = execSync(
        `git log --format=%H%n%h%n%s%n%an%n%aI -n ${limit}`,
        { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
      );
      const commits = parseGitLogOutput(output);
      return reply.code(200).send({ commits });
    } catch {
      return reply.code(200).send({ commits: [] });
    }
  });
};

export default fp(routes, { name: "diff-routes" });
