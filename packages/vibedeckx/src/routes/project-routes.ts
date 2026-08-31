import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { exec } from "child_process";
import { randomUUID } from "crypto";
import { readdir, mkdir } from "fs/promises";
import type { Project } from "../storage/types.js";
import { selectFolder } from "../dialog.js";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";

// A `Project` carries no secrets to strip: the per-project `remote_api_key` it
// used to expose (as a `has_remote_api_key` boolean) belonged to the removed
// direct-URL transport and is no longer read or written. Re-introduce a
// sanitizer here if a future field ever needs withholding from the wire.

const routes: FastifyPluginAsync = async (fastify) => {
  // 获取所有项目
  fastify.get("/api/projects", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
    const projects = await fastify.storage.projects.getAll(userId);
    return reply.code(200).send({ projects });
  });

  // 获取单个项目
  fastify.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    return reply.code(200).send({ project });
  });

  // 打开目录选择对话框
  fastify.post("/api/dialog/select-folder", async (req, reply) => {
    const folderPath = await selectFolder();
    if (!folderPath) {
      return reply.code(200).send({ path: null, cancelled: true });
    }
    return reply.code(200).send({ path: folderPath, cancelled: false });
  });

  // Browse directory - for remote access to list directories
  fastify.get<{
    Querystring: { path?: string };
  }>("/api/browse", async (req, reply) => {
    const browsePath = req.query.path || "/";

    try {
      const entries = await readdir(browsePath, { withFileTypes: true });
      const items = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: path.join(browsePath, entry.name),
          type: "directory" as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return reply.code(200).send({ path: browsePath, items });
    } catch {
      return reply.code(400).send({ error: "Failed to read directory" });
    }
  });

  // Create a directory (used by the remote directory browser's "new folder")
  fastify.post<{
    Body: { parentPath?: string; name?: string };
  }>("/api/mkdir", async (req, reply) => {
    const parentPath = req.body?.parentPath;
    const rawName = req.body?.name;

    if (!parentPath || !rawName) {
      return reply.code(400).send({ error: "parentPath and name are required" });
    }

    // Reduce to a single path segment and reject traversal / separators.
    const name = path.basename(rawName.trim());
    if (!name || name === "." || name === ".." || name !== rawName.trim()) {
      return reply.code(400).send({ error: "Invalid folder name" });
    }

    const fullPath = path.join(parentPath, name);

    try {
      await mkdir(fullPath); // non-recursive: duplicate name throws EEXIST
      return reply.code(201).send({ path: fullPath, name, type: "directory" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") {
        return reply.code(409).send({ error: "A folder with that name already exists" });
      }
      return reply.code(400).send({ error: "Failed to create directory" });
    }
  });

  // 创建项目 (unified: local, remote, or both)
  fastify.post<{
    Body: {
      name: string;
      path?: string;
      remotePath?: string;
      agentMode?: 'local' | 'remote';
      executorMode?: 'local' | 'remote';
    };
  }>("/api/projects", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
    const { name, path: projectPath, remotePath, agentMode, executorMode } = req.body;

    if (!name) {
      return reply.code(400).send({ error: "Project name is required" });
    }

    if (fastify.noLocalProjects && projectPath && projectPath.trim().length > 0) {
      return reply.code(400).send({ error: "Local projects are disabled on this server" });
    }

    if (projectPath) {
      const existing = await fastify.storage.projects.getByPath(projectPath);
      if (existing) {
        return reply.code(409).send({ error: "Project with this path already exists" });
      }
    }

    const id = randomUUID();
    const project = await fastify.storage.projects.create({
      id,
      name,
      path: projectPath || null,
      remote_path: remotePath,
      agent_mode: agentMode,
      executor_mode: executorMode,
    }, userId);

    return reply.code(201).send({ project });
  });

  // 更新项目
  fastify.put<{
    Params: { id: string };
    Body: {
      name?: string;
      path?: string | null;
      remotePath?: string | null;
      agentMode?: 'local' | 'remote';
      executorMode?: 'local' | 'remote';
    };
  }>("/api/projects/:id", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { name, path: newPath, remotePath, agentMode, executorMode } = req.body;

    // Block setting/adding a local path when local projects are disabled.
    // Existing local paths are untouched: only guard when the caller sends a new non-empty path.
    if (fastify.noLocalProjects && newPath !== undefined && newPath !== null && newPath.trim().length > 0) {
      return reply.code(400).send({ error: "Local projects are disabled on this server" });
    }

    const effectivePath = newPath !== undefined ? newPath : project.path;
    const effectiveRemotePath = remotePath !== undefined ? remotePath : (project.remote_path ?? null);

    if (!effectivePath && !effectiveRemotePath) {
      // Also check project_remotes table — multi-remote projects use it instead of legacy remote_path
      const remotes = await fastify.storage.projectRemotes.getByProject(req.params.id);
      if (remotes.length === 0) {
        return reply.code(400).send({ error: "Project must have at least one of local path or remote path" });
      }
    }

    if (newPath && newPath !== project.path) {
      const existing = await fastify.storage.projects.getByPath(newPath);
      if (existing && existing.id !== req.params.id) {
        return reply.code(409).send({ error: "Another project already uses this path" });
      }
    }

    const updateOpts: {
      name?: string;
      path?: string | null;
      remote_path?: string | null;
      agent_mode?: 'local' | 'remote';
      executor_mode?: 'local' | 'remote';
    } = {};

    if (name !== undefined) updateOpts.name = name;
    if (newPath !== undefined) updateOpts.path = newPath;
    if (remotePath !== undefined) updateOpts.remote_path = remotePath;
    if (agentMode !== undefined) updateOpts.agent_mode = agentMode;
    if (executorMode !== undefined) updateOpts.executor_mode = executorMode;

    const updated = await fastify.storage.projects.update(req.params.id, updateOpts, userId);
    if (!updated) {
      return reply.code(404).send({ error: "Project not found" });
    }

    return reply.code(200).send({ project: updated });
  });

  // 删除项目
  fastify.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    await fastify.storage.projects.delete(req.params.id, userId);
    return reply.code(200).send({ success: true });
  });

  // Execute one-shot command (worker-side only; nothing on this server calls it).
  //
  // Sync Up/Down was removed, and with it this route's only hub-side caller.
  // The route itself stays: hubs generate `npx vibedeckx@latest connect`
  // (remote-server-routes.ts), so a hub predating the sync removal routinely
  // talks to a newer worker — deleting it here would 404 their Sync buttons.
  // Deliberately absent from reverse-connect-capabilities.ts: that registry
  // tracks routes *this* hub calls, and its test rejects entries without a
  // live call site. Drop this once MIN_WORKER_VERSION passes the sync removal.
  fastify.post<{
    Body: { command: string; cwd: string };
  }>("/api/execute-one-shot", async (req, reply) => {
    const { command, cwd } = req.body;
    if (!command || !cwd) {
      return reply.code(400).send({ error: "command and cwd are required" });
    }

    try {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        exec(command, { cwd, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
          resolve({
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: error ? (error.code ?? 1) : 0,
          });
        });
      });
      return reply.code(200).send({ success: result.exitCode === 0, ...result });
    } catch {
      return reply.code(500).send({ error: "Command execution failed" });
    }
  });

  // 获取项目目录文件列表
  fastify.get<{ Params: { id: string } }>("/api/projects/:id/files", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const entries = await readdir(project.path, { withFileTypes: true });
      const files = entries
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file" as const,
        }))
        .sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === "directory" ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

      return reply.code(200).send({ files });
    } catch {
      return reply.code(500).send({ error: "Failed to read directory" });
    }
  });
};

export default fp(routes, { name: "project-routes" });
