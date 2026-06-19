import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import fs from "fs/promises";
import { createReadStream, constants as fsConstants } from "fs";
import { Readable } from "stream";
import { execFile } from "child_process";
import { promisify } from "util";
import { proxyStatus, proxyToRemoteAuto, proxyToRemoteRaw } from "../utils/remote-proxy.js";
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

interface BrowseEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
}

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB

// Upper bound on the flat file list returned for the GitHub-style file finder.
// Past this we truncate and flag it so the UI can surface that results are
// partial rather than silently dropping files.
const MAX_LIST_FILES = 50_000;

const execFileAsync = promisify(execFile);

function isPathSafe(basePath: string, relativePath: string): boolean {
  const normalizedBase = path.resolve(basePath);
  const resolved = path.resolve(normalizedBase, relativePath);
  return resolved.startsWith(normalizedBase + path.sep) || resolved === normalizedBase;
}

// Canonical (symlink-resolved) containment check. isPathSafe above is lexical
// only and does not account for symlinks: a symlink inside a project can point
// outside it, and fs.stat/readFile/createReadStream/readdir all follow symlinks.
// This resolves both ends with fs.realpath so an in-project symlink that
// escapes the root is rejected. Returns false (rather than throwing) when
// either path is missing/unreadable, so callers map it to 404/not-allowed.
async function isWithinBaseReal(basePath: string, candidatePath: string): Promise<boolean> {
  try {
    const [realBase, realCandidate] = await Promise.all([
      fs.realpath(basePath),
      fs.realpath(candidatePath),
    ]);
    return realCandidate === realBase || realCandidate.startsWith(realBase + path.sep);
  } catch {
    return false;
  }
}

// base64 inflates ~33%, so 11MB → ~14.7MB encoded, leaving headroom under the
// remote server's 16MB JSON bodyLimit for the surrounding JSON envelope.
const MAX_REMOTE_UPLOAD_BYTES = 11 * 1024 * 1024;

/**
 * Writes uploaded files into `relativeDir` under `basePath`, overwriting any
 * existing file of the same name. Each filename is reduced to its basename and
 * re-checked against path traversal. Returns the list of filenames written.
 * Throws on traversal, a non-directory target, or a missing target dir.
 */
async function writeUploadedFiles(
  basePath: string,
  relativeDir: string,
  files: { name: string; data: Buffer }[],
): Promise<string[]> {
  if (!isPathSafe(basePath, relativeDir || ".")) {
    throw Object.assign(new Error("Path traversal not allowed"), { statusCode: 403 });
  }
  const targetDir = relativeDir ? path.resolve(basePath, relativeDir) : basePath;

  const stat = await fs.stat(targetDir); // throws ENOENT/ENOTDIR — mapped by caller
  if (!stat.isDirectory()) {
    throw Object.assign(new Error("Target is not a directory"), { statusCode: 400 });
  }

  // A symlinked target directory could redirect the write outside the project
  // despite the lexical check above. Reject if the canonical dir escapes.
  if (!(await isWithinBaseReal(basePath, targetDir))) {
    throw Object.assign(new Error("Path traversal not allowed"), { statusCode: 403 });
  }

  const written: string[] = [];
  for (const file of files) {
    const name = path.basename(file.name);
    if (!name || name === "." || name === "..") {
      throw Object.assign(new Error(`Invalid filename: ${file.name}`), { statusCode: 400 });
    }
    if (!isPathSafe(targetDir, name)) {
      throw Object.assign(new Error("Path traversal not allowed"), { statusCode: 403 });
    }
    // O_NOFOLLOW refuses to write *through* a pre-existing symlink whose target
    // lies outside the project (e.g. name -> /etc/cron.d/x); it fails with ELOOP
    // instead of following. O_NOFOLLOW is absent on Windows — fall back to 0
    // (no extra guard) there, where symlink creation already needs privilege.
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const fh = await fs.open(
      path.join(targetDir, name),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow,
      0o644,
    );
    try {
      await fh.writeFile(file.data); // overwrites
    } finally {
      await fh.close();
    }
    written.push(name);
  }
  return written;
}

/**
 * Deletes the file or directory at `relativePath` under `basePath`. Directories
 * are removed recursively. Returns the deleted relative path. Throws on
 * traversal, an attempt to delete the root, or a missing entry (ENOENT).
 */
async function deletePath(basePath: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath === ".") {
    throw Object.assign(new Error("Cannot delete the workspace root"), { statusCode: 400 });
  }
  if (!isPathSafe(basePath, relativePath)) {
    throw Object.assign(new Error("Path traversal not allowed"), { statusCode: 403 });
  }
  const fullPath = path.resolve(basePath, relativePath);
  if (fullPath === path.resolve(basePath)) {
    throw Object.assign(new Error("Cannot delete the workspace root"), { statusCode: 400 });
  }
  await fs.rm(fullPath, { recursive: true, force: false }); // throws ENOENT if missing
  return relativePath;
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  const fd = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buf, 0, 8192, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await fd.close();
  }
}

async function browseDirectory(
  dirPath: string,
  showHidden = false,
): Promise<{ path: string; items: BrowseEntry[] }> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const items: BrowseEntry[] = [];

  for (const entry of entries) {
    if (!showHidden && entry.name.startsWith(".")) continue;
    // Always skip node_modules — it's not "hidden", just noise that would
    // explode the tree even when hidden files are shown.
    if (entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      try {
        const stat = await fs.stat(path.join(dirPath, entry.name));
        items.push({ name: entry.name, type: "directory", mtime: stat.mtime.toISOString() });
      } catch {
        items.push({ name: entry.name, type: "directory" });
      }
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(path.join(dirPath, entry.name));
        items.push({ name: entry.name, type: "file", size: stat.size, mtime: stat.mtime.toISOString() });
      } catch {
        items.push({ name: entry.name, type: "file" });
      }
    }
  }

  // Sort: directories first, then alphabetical
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: dirPath, items };
}

// Recursive fallback for listProjectFiles when `basePath` is not a git repo (or
// git is unavailable). Walks the tree skipping node_modules and dot-directories,
// mirroring the skip rules in browseDirectory. Returns POSIX-relative paths.
async function walkFilesFallback(basePath: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  async function walk(dir: string, rel: string): Promise<void> {
    if (truncated) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        files.push(rel ? `${rel}/${entry.name}` : entry.name);
        if (files.length >= MAX_LIST_FILES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(basePath, "");
  return { files, truncated };
}

// Returns the flat list of files under `basePath` for the file finder. Prefers
// `git ls-files` (tracked + untracked-but-not-ignored, .gitignore-aware) so
// node_modules / build output are excluded for free; falls back to a recursive
// walk when not a git repo. Files only, as POSIX-relative paths.
async function listProjectFiles(basePath: string): Promise<{ files: string[]; truncated: boolean }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: basePath, maxBuffer: 64 * 1024 * 1024 },
    );
    // -z gives NUL-separated paths (safe for odd filenames); drop the trailing
    // empty segment after the final NUL.
    let files = stdout.split("\0").filter(Boolean);
    let truncated = false;
    if (files.length > MAX_LIST_FILES) {
      files = files.slice(0, MAX_LIST_FILES);
      truncated = true;
    }
    return { files, truncated };
  } catch {
    return walkFilesFallback(basePath);
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Browse directory (path-based, for remote execution)
  fastify.get<{
    Querystring: { path: string; branch?: string; relativePath?: string; hidden?: string };
  }>("/api/path/browse", async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    const branch = req.query.branch;
    const relativePath = req.query.relativePath || "";
    const showHidden = req.query.hidden === "1" || req.query.hidden === "true";
    const basePath = resolveWorktreePath(projectPath, branch ?? null);

    if (!isPathSafe(basePath, relativePath || ".")) {
      return reply.code(403).send({ error: "Path traversal not allowed" });
    }

    const cwd = relativePath ? path.resolve(basePath, relativePath) : basePath;

    if (!(await isWithinBaseReal(basePath, cwd))) {
      return reply.code(404).send({ error: "Directory not found" });
    }

    try {
      const result = await browseDirectory(cwd, showHidden);
      return reply.code(200).send(result);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      fastify.log.warn({ err, dirPath: cwd, code }, "browseDirectory failed");
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "Directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      return reply.code(500).send({ error: "Failed to browse directory", code });
    }
  });

  // List all files (path-based, for remote execution)
  fastify.get<{
    Querystring: { path: string; branch?: string };
  }>("/api/path/list-files", async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    const branch = req.query.branch;
    const basePath = resolveWorktreePath(projectPath, branch ?? null);

    try {
      const result = await listProjectFiles(basePath);
      return reply.code(200).send(result);
    } catch (err) {
      fastify.log.warn({ err, basePath }, "listProjectFiles failed");
      return reply.code(500).send({ error: "Failed to list files" });
    }
  });

  // Get file content (path-based, for remote execution)
  fastify.get<{
    Querystring: { path: string; filePath: string; branch?: string };
  }>("/api/path/file-content", async (req, reply) => {
    const projectPath = req.query.path;
    const filePath = req.query.filePath;
    if (!projectPath || !filePath) {
      return reply.code(400).send({ error: "Path and filePath are required" });
    }

    const branch = req.query.branch;
    const basePath = resolveWorktreePath(projectPath, branch ?? null);

    if (!isPathSafe(basePath, filePath)) {
      return reply.code(403).send({ error: "Path traversal not allowed" });
    }

    const fullPath = path.resolve(basePath, filePath);

    try {
      if (!(await isWithinBaseReal(basePath, fullPath))) {
        return reply.code(404).send({ error: "File not found" });
      }

      const stat = await fs.stat(fullPath);

      if (stat.size > MAX_FILE_SIZE) {
        return reply.code(200).send({ binary: false, tooLarge: true, content: null, size: stat.size });
      }

      const binary = await isBinaryFile(fullPath);
      if (binary) {
        return reply.code(200).send({ binary: true, content: null, size: stat.size });
      }

      const content = await fs.readFile(fullPath, "utf-8");
      return reply.code(200).send({ binary: false, content, size: stat.size });
    } catch {
      return reply.code(404).send({ error: "File not found" });
    }
  });

  // Download file (path-based, for remote execution)
  fastify.get<{
    Querystring: { path: string; filePath: string; branch?: string };
  }>("/api/path/file-download", async (req, reply) => {
    const projectPath = req.query.path;
    const filePath = req.query.filePath;
    if (!projectPath || !filePath) {
      return reply.code(400).send({ error: "Path and filePath are required" });
    }

    const branch = req.query.branch;
    const basePath = resolveWorktreePath(projectPath, branch ?? null);

    if (!isPathSafe(basePath, filePath)) {
      return reply.code(403).send({ error: "Path traversal not allowed" });
    }

    const fullPath = path.resolve(basePath, filePath);
    const fileName = path.basename(fullPath);

    try {
      if (!(await isWithinBaseReal(basePath, fullPath))) {
        return reply.code(404).send({ error: "File not found" });
      }

      await fs.access(fullPath);
      const stream = createReadStream(fullPath);
      return reply
        .header("Content-Disposition", `attachment; filename="${fileName}"`)
        .type("application/octet-stream")
        .send(stream);
    } catch {
      return reply.code(404).send({ error: "File not found" });
    }
  });

  // Upload files (path-based, for remote execution). Receives files as base64
  // JSON because the remote proxy only forwards JSON bodies.
  fastify.post<{
    Body: {
      path: string;
      branch?: string;
      relativePath?: string;
      files: { name: string; contentBase64: string }[];
    };
  }>("/api/path/upload", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const { path: projectPath, branch, relativePath, files } = req.body;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return reply.code(400).send({ error: "No files provided" });
    }

    const project = fastify.storage.projects.getByPath(projectPath);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const decoded = files.map((f) => ({ name: f.name, data: Buffer.from(f.contentBase64, "base64") }));

    try {
      const basePath = resolveWorktreePath(project.path ?? projectPath, branch ?? null);
      const uploaded = await writeUploadedFiles(basePath, relativePath || "", decoded);
      return reply.code(200).send({ uploaded });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (status) return reply.code(status).send({ error: (err as Error).message });
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "Target directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      fastify.log.warn({ err }, "path upload failed");
      return reply.code(500).send({ error: "Failed to write files", code });
    }
  });

  // Delete a file or directory (path-based, for remote execution).
  fastify.delete<{
    Querystring: { path: string; filePath: string; branch?: string };
  }>("/api/path/delete", async (req, reply) => {
    const projectPath = req.query.path;
    const filePath = req.query.filePath;
    if (!projectPath || !filePath) {
      return reply.code(400).send({ error: "Path and filePath are required" });
    }

    const branch = req.query.branch;

    try {
      const basePath = resolveWorktreePath(projectPath, branch ?? null);
      const deleted = await deletePath(basePath, filePath);
      return reply.code(200).send({ deleted });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (status) return reply.code(status).send({ error: (err as Error).message });
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "File or directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      fastify.log.warn({ err }, "path delete failed");
      return reply.code(500).send({ error: "Failed to delete", code });
    }
  });

  // Browse project directory (project-scoped)
  fastify.get<{
    Params: { id: string };
    Querystring: { path?: string; branch?: string; target?: "local" | "remote"; hidden?: string };
  }>("/api/projects/:id/browse", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const relativePath = req.query.path || "";
    const branch = req.query.branch;
    const target = req.query.target;
    const showHidden = req.query.hidden === "1" || req.query.hidden === "true";

    const useRemote = target === "remote"
      || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [`path=${encodeURIComponent(remoteConfig.remotePath)}`];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      if (relativePath) params.push(`relativePath=${encodeURIComponent(relativePath)}`);
      if (showHidden) params.push("hidden=1");
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "GET",
        `/api/path/browse?${params.join("&")}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);
    const dirPath = relativePath ? path.resolve(basePath, relativePath) : basePath;

    if (!isPathSafe(basePath, relativePath || ".")) {
      return reply.code(403).send({ error: "Path traversal not allowed" });
    }

    if (!(await isWithinBaseReal(basePath, dirPath))) {
      return reply.code(404).send({ error: "Directory not found" });
    }

    try {
      const result = await browseDirectory(dirPath, showHidden);
      return reply.code(200).send(result);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      fastify.log.warn({ err, dirPath, code }, "browseDirectory failed");
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "Directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      return reply.code(500).send({ error: "Failed to browse directory", code });
    }
  });

  // List all files (project-scoped)
  fastify.get<{
    Params: { id: string };
    Querystring: { branch?: string; target?: "local" | "remote" };
  }>("/api/projects/:id/list-files", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.query.branch;
    const target = req.query.target;

    const useRemote = target === "remote"
      || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [`path=${encodeURIComponent(remoteConfig.remotePath)}`];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "GET",
        `/api/path/list-files?${params.join("&")}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);

    try {
      const result = await listProjectFiles(basePath);
      return reply.code(200).send(result);
    } catch (err) {
      fastify.log.warn({ err, basePath }, "listProjectFiles failed");
      return reply.code(500).send({ error: "Failed to list files" });
    }
  });

  // Get file content (project-scoped)
  fastify.get<{
    Params: { id: string };
    Querystring: { path: string; branch?: string; target?: "local" | "remote" };
  }>("/api/projects/:id/file-content", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const filePath = req.query.path;
    if (!filePath) {
      return reply.code(400).send({ error: "File path is required" });
    }

    const branch = req.query.branch;
    const target = req.query.target;

    const useRemote = target === "remote"
      || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [
        `path=${encodeURIComponent(remoteConfig.remotePath)}`,
        `filePath=${encodeURIComponent(filePath)}`,
      ];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "GET",
        `/api/path/file-content?${params.join("&")}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);

    if (!isPathSafe(basePath, filePath)) {
      return reply.code(403).send({ error: "Path traversal not allowed" });
    }

    const fullPath = path.resolve(basePath, filePath);

    try {
      if (!(await isWithinBaseReal(basePath, fullPath))) {
        return reply.code(404).send({ error: "File not found" });
      }

      const stat = await fs.stat(fullPath);

      if (stat.size > MAX_FILE_SIZE) {
        return reply.code(200).send({ binary: false, tooLarge: true, content: null, size: stat.size });
      }

      const binary = await isBinaryFile(fullPath);
      if (binary) {
        return reply.code(200).send({ binary: true, content: null, size: stat.size });
      }

      const content = await fs.readFile(fullPath, "utf-8");
      return reply.code(200).send({ binary: false, content, size: stat.size });
    } catch {
      return reply.code(404).send({ error: "File not found" });
    }
  });

  // Download file (project-scoped)
  fastify.get<{
    Params: { id: string };
    Querystring: { path: string; branch?: string; target?: "local" | "remote" };
  }>("/api/projects/:id/file-download", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const filePath = req.query.path;
    if (!filePath) {
      return reply.code(400).send({ error: "File path is required" });
    }

    const branch = req.query.branch;
    const target = req.query.target;

    const useRemote = target === "remote"
      || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [
        `path=${encodeURIComponent(remoteConfig.remotePath)}`,
        `filePath=${encodeURIComponent(filePath)}`,
      ];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      const rcm = fastify.reverseConnectManager;
      if (rcm && rcm.isConnected(remoteConfig.serverId)) {
        // Reverse-connect: proxy through WebSocket tunnel (returns JSON)
        const result = await proxyToRemoteAuto(
          remoteConfig.serverId,
          remoteConfig.url,
          remoteConfig.apiKey,
          "GET",
          `/api/path/file-download?${params.join("&")}`,
          undefined,
          { reverseConnectManager: rcm }
        );
        return reply.code(proxyStatus(result)).send(result.data);
      }

      // Outbound: direct HTTP fetch for raw streaming response
      const result = await proxyToRemoteRaw(
        remoteConfig.url,
        remoteConfig.apiKey,
        `/api/path/file-download?${params.join("&")}`
      );

      if (!result.ok) {
        return reply.code(proxyStatus(result, 500)).send({ error: "Failed to download file from remote" });
      }

      const fileName = path.basename(filePath);
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      reply.type("application/octet-stream");

      if (result.body) {
        // Convert web ReadableStream to Node.js Readable for Fastify
        const nodeStream = Readable.fromWeb(result.body as import("stream/web").ReadableStream);
        return reply.send(nodeStream);
      }
      return reply.code(500).send({ error: "No response body from remote" });
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);

    if (!isPathSafe(basePath, filePath)) {
      return reply.code(403).send({ error: "Path traversal not allowed" });
    }

    const fullPath = path.resolve(basePath, filePath);
    const fileName = path.basename(fullPath);

    try {
      if (!(await isWithinBaseReal(basePath, fullPath))) {
        return reply.code(404).send({ error: "File not found" });
      }

      await fs.access(fullPath);
      const stream = createReadStream(fullPath);
      return reply
        .header("Content-Disposition", `attachment; filename="${fileName}"`)
        .type("application/octet-stream")
        .send(stream);
    } catch {
      return reply.code(404).send({ error: "File not found" });
    }
  });

  // Upload files into a project directory (project-scoped). Local: multipart
  // write. Remote: read files into memory and forward as base64 JSON.
  fastify.post<{
    Params: { id: string };
    Querystring: { path?: string; branch?: string; target?: "local" | "remote" };
  }>("/api/projects/:id/upload", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const relativePath = req.query.path || "";
    const branch = req.query.branch;
    const target = req.query.target;
    const useRemote = target === "remote" || (!target && !project.path);

    // Collect uploaded file parts into buffers.
    const collected: { name: string; data: Buffer }[] = [];
    try {
      for await (const part of req.files()) {
        const data = await part.toBuffer();
        collected.push({ name: part.filename, data });
      }
    } catch (err) {
      // @fastify/multipart throws when fileSize limit is exceeded.
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "File too large" });
      }
      return reply.code(400).send({ error: "Failed to read upload" });
    }
    if (collected.length === 0) {
      return reply.code(400).send({ error: "No files provided" });
    }

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const totalBytes = collected.reduce((sum, f) => sum + f.data.length, 0);
      if (totalBytes > MAX_REMOTE_UPLOAD_BYTES) {
        return reply.code(413).send({
          error: `Upload too large for remote (max ${Math.floor(MAX_REMOTE_UPLOAD_BYTES / (1024 * 1024))}MB total)`,
        });
      }
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "POST",
        "/api/path/upload",
        {
          path: remoteConfig.remotePath,
          branch,
          relativePath,
          files: collected.map((f) => ({ name: f.name, contentBase64: f.data.toString("base64") })),
        },
        { reverseConnectManager: fastify.reverseConnectManager },
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);
    try {
      const uploaded = await writeUploadedFiles(basePath, relativePath, collected);
      return reply.code(200).send({ uploaded });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (status) return reply.code(status).send({ error: (err as Error).message });
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "Target directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      fastify.log.warn({ err }, "project upload failed");
      return reply.code(500).send({ error: "Failed to write files", code });
    }
  });

  // Delete a file or directory in a project (project-scoped). Local: fs.rm.
  // Remote: proxy to the path-based delete route.
  fastify.delete<{
    Params: { id: string };
    Querystring: { path: string; branch?: string; target?: "local" | "remote" };
  }>("/api/projects/:id/file", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const filePath = req.query.path;
    if (!filePath) {
      return reply.code(400).send({ error: "File path is required" });
    }

    const branch = req.query.branch;
    const target = req.query.target;
    const useRemote = target === "remote" || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [
        `path=${encodeURIComponent(remoteConfig.remotePath)}`,
        `filePath=${encodeURIComponent(filePath)}`,
      ];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "DELETE",
        `/api/path/delete?${params.join("&")}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager },
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const basePath = resolveWorktreePath(project.path, branch ?? null);
      const deleted = await deletePath(basePath, filePath);
      return reply.code(200).send({ deleted });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (status) return reply.code(status).send({ error: (err as Error).message });
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "File or directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      fastify.log.warn({ err }, "project delete failed");
      return reply.code(500).send({ error: "Failed to delete", code });
    }
  });
};

export default fp(routes, { name: "file-routes" });
