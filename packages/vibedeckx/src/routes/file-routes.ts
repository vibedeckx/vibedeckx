import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { Readable } from "stream";
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

function isPathSafe(basePath: string, relativePath: string): boolean {
  const normalizedBase = path.resolve(basePath);
  const resolved = path.resolve(normalizedBase, relativePath);
  return resolved.startsWith(normalizedBase + path.sep) || resolved === normalizedBase;
}

const MAX_REMOTE_UPLOAD_BYTES = 12 * 1024 * 1024; // base64 of these fits under the 16MB JSON bodyLimit

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

  const written: string[] = [];
  for (const file of files) {
    const name = path.basename(file.name);
    if (!name || name === "." || name === "..") {
      throw Object.assign(new Error(`Invalid filename: ${file.name}`), { statusCode: 400 });
    }
    if (!isPathSafe(targetDir, name)) {
      throw Object.assign(new Error("Path traversal not allowed"), { statusCode: 403 });
    }
    await fs.writeFile(path.join(targetDir, name), file.data); // overwrites
    written.push(name);
  }
  return written;
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

async function browseDirectory(dirPath: string): Promise<{ path: string; items: BrowseEntry[] }> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const items: BrowseEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
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

const routes: FastifyPluginAsync = async (fastify) => {
  // Browse directory (path-based, for remote execution)
  fastify.get<{
    Querystring: { path: string; branch?: string; relativePath?: string };
  }>("/api/path/browse", async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    const branch = req.query.branch;
    const relativePath = req.query.relativePath || "";
    const basePath = resolveWorktreePath(projectPath, branch ?? null);

    if (!isPathSafe(basePath, relativePath || ".")) {
      return reply.code(403).send({ error: "Path traversal not allowed" });
    }

    const cwd = relativePath ? path.resolve(basePath, relativePath) : basePath;

    try {
      const result = await browseDirectory(cwd);
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
    const { path: projectPath, branch, relativePath, files } = req.body;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return reply.code(400).send({ error: "No files provided" });
    }

    const basePath = resolveWorktreePath(projectPath, branch ?? null);
    const decoded = files.map((f) => ({ name: f.name, data: Buffer.from(f.contentBase64, "base64") }));

    try {
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

  // Browse project directory (project-scoped)
  fastify.get<{
    Params: { id: string };
    Querystring: { path?: string; branch?: string; target?: "local" | "remote" };
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

    try {
      const result = await browseDirectory(dirPath);
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
};

export default fp(routes, { name: "file-routes" });
