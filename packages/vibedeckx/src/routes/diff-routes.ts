import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { readFile } from "fs/promises";
import { parseDiffOutput, type DiffFile, type DiffLine } from "../utils/diff-parser.js";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { resolveWorktreePath } from "../utils/worktree-paths.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import "../server-types.js";
import type { Project } from "../storage/types.js";
import { validateBranchExists } from "../merge-status.js";
import { GIT_TIMEOUT_MS, GitTimeoutError, runGit } from "../utils/git-exec.js";

async function getRemoteConfig(fastify: FastifyInstance, project: Project) {
  const remotes = await fastify.storage.projectRemotes.getByProject(project.id);
  if (remotes.length === 0) return null;
  const primary = remotes[0]; // sorted by sort_order
  return {
    serverId: primary.remote_server_id,
    remotePath: primary.remote_path,
  };
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

function diffArgs(commit?: string): string[] {
  if (!commit) {
    // Uncommitted changes: working tree vs HEAD
    return ["diff", "HEAD", "--no-color"];
  }
  // Changes made by a specific commit (compare with its parent)
  return ["diff", `${commit}^`, commit, "--no-color"];
}

function diffFallbackArgs(commit?: string): string[] {
  // Root commit (no parent) / repo without HEAD yet
  return commit ? ["show", commit, "--format=", "--no-color"] : ["diff", "--no-color"];
}

/** Three-dot diff: everything `HEAD` would bring to `compareTo` since their merge-base. */
export function runCompareToDiff(cwd: string, compareTo: string, timeoutMs?: number): Promise<string> {
  return runGit(cwd, ["diff", `${compareTo}...HEAD`, "--no-color"], timeoutMs);
}

async function getUntrackedFiles(cwd: string, timeoutMs: number): Promise<DiffFile[]> {
  let untrackedOutput: string;
  try {
    // `-z` is load-bearing, not a nicety: without it `core.quotePath` (on by
    // default) hands back `"docs/\345\212\237.md"` for any non-ASCII name, the
    // read below then ENOENTs on that literal string, and the catch drops the
    // file — it simply vanishes from the Diff tab. NUL separation also covers
    // names holding spaces or newlines.
    untrackedOutput = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], timeoutMs);
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err;
    return [];
  }

  const untrackedPaths = untrackedOutput.split("\0").filter(Boolean);
  if (untrackedPaths.length === 0) return [];
  const files: DiffFile[] = [];

  for (const filePath of untrackedPaths) {
    try {
      const fullPath = path.join(cwd, filePath);
      const buffer = await readFile(fullPath);

      // Skip binary files (contain null bytes). Flagged the same way git's own
      // "Binary files ... differ" output is, so an added .xlsx reads as a
      // binary file rather than an added file that mysteriously has no content.
      if (buffer.includes(0)) {
        files.push({ path: filePath, status: "added", hunks: [], binary: true });
        continue;
      }

      const content = buffer.toString("utf-8");
      const lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }

      const diffLines: DiffLine[] = lines.map((line, i) => ({
        type: "add" as const,
        content: line,
        newLineNo: i + 1,
      }));

      files.push({
        path: filePath,
        status: "added",
        hunks:
          diffLines.length > 0
            ? [
                {
                  oldStart: 0,
                  oldLines: 0,
                  newStart: 1,
                  newLines: diffLines.length,
                  lines: diffLines,
                },
              ]
            : [],
      });
    } catch {
      // Skip files that can't be read (permission issues, etc.)
    }
  }

  return files;
}

type DiffResult = { code: number; body: { files: DiffFile[] } | { error: string } };

function timeoutResult(err: GitTimeoutError): DiffResult {
  return { code: err.statusCode, body: { error: err.message } };
}

/**
 * The diff for one worktree. Git failures keep their old meaning (an empty or
 * partial file list); only a timeout becomes an error, so a repo too slow to
 * diff doesn't read as "no changes".
 */
export async function loadDiff(
  cwd: string,
  commit?: string,
  compareTo?: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<DiffResult> {
  if (compareTo) {
    try {
      if (!(await validateBranchExists(cwd, compareTo))) {
        return { code: 400, body: { error: `Branch not found: ${compareTo}` } };
      }
      // Committed content only — no untracked-file injection in compare mode.
      return { code: 200, body: { files: parseDiffOutput(await runCompareToDiff(cwd, compareTo, timeoutMs)) } };
    } catch (err) {
      return err instanceof GitTimeoutError ? timeoutResult(err) : { code: 200, body: { files: [] } };
    }
  }

  let untrackedFiles: DiffFile[];
  try {
    untrackedFiles = !commit ? await getUntrackedFiles(cwd, timeoutMs) : [];
  } catch (err) {
    if (err instanceof GitTimeoutError) return timeoutResult(err);
    throw err;
  }

  for (const args of [diffArgs(commit), diffFallbackArgs(commit)]) {
    try {
      const files = parseDiffOutput(await runGit(cwd, args, timeoutMs));
      return { code: 200, body: { files: [...files, ...untrackedFiles] } };
    } catch (err) {
      if (err instanceof GitTimeoutError) return timeoutResult(err);
    }
  }
  return { code: 200, body: { files: untrackedFiles } };
}

async function loadCommits(cwd: string, limit: number): Promise<CommitEntry[]> {
  try {
    const output = await runGit(cwd, ["log", "--format=%H%n%h%n%s%n%an%n%aI", "-n", String(limit)]);
    return parseGitLogOutput(output);
  } catch {
    return [];
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Get diff for a path (path-based, for remote execution)
  fastify.get<{
    Querystring: { path: string; branch?: string; commit?: string; compareTo?: string };
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

    const compareTo = req.query.compareTo;
    if (commit && compareTo) {
      return reply.code(400).send({ error: "commit and compareTo are mutually exclusive" });
    }

    const cwd = resolveWorktreePath(projectPath, branch ?? null);
    const { code, body } = await loadDiff(cwd, commit, compareTo);
    return reply.code(code).send(body);
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

    return reply.code(200).send({ commits: await loadCommits(cwd, limit) });
  });

  // Get git diff for a project (uncommitted changes or single commit)
  fastify.get<{
    Params: { id: string };
    Querystring: { branch?: string; commit?: string; compareTo?: string; target?: 'local' | 'remote' };
  }>("/api/projects/:id/diff", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.query.branch;
    const commit = req.query.commit;
    const compareTo = req.query.compareTo;
    const target = req.query.target;

    if (commit && !/^[0-9a-f]+$/i.test(commit)) {
      return reply.code(400).send({ error: "Invalid commit hash" });
    }

    if (commit && compareTo) {
      return reply.code(400).send({ error: "commit and compareTo are mutually exclusive" });
    }

    const useRemote = target === 'remote'
      || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = await getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [`path=${encodeURIComponent(remoteConfig.remotePath)}`];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      if (commit) params.push(`commit=${encodeURIComponent(commit)}`);
      if (compareTo) params.push(`compareTo=${encodeURIComponent(compareTo)}`);
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        "GET",
        `/api/path/diff?${params.join("&")}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const cwd = resolveWorktreePath(project.path, branch ?? null);
    const { code, body } = await loadDiff(cwd, commit, compareTo);
    return reply.code(code).send(body);
  });

  // Get commits for a project (project-based)
  fastify.get<{
    Params: { id: string };
    Querystring: { branch?: string; limit?: string; target?: 'local' | 'remote' };
  }>("/api/projects/:id/commits", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.query.branch;
    const limit = parseInt(req.query.limit || "20", 10);
    const target = req.query.target;

    const useRemote = target === 'remote'
      || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = await getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [`path=${encodeURIComponent(remoteConfig.remotePath)}`];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      params.push(`limit=${limit}`);
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        "GET",
        `/api/path/commits?${params.join("&")}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const cwd = resolveWorktreePath(project.path, branch ?? null);

    return reply.code(200).send({ commits: await loadCommits(cwd, limit) });
  });
};

export default fp(routes, { name: "diff-routes" });
