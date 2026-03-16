import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { readdir } from "fs/promises";
import type { Project, SyncButtonConfig } from "../storage/types.js";
import { selectFolder } from "../dialog.js";
import { proxyToRemote } from "../utils/remote-proxy.js";
import { resolveWorktreePath } from "../utils/worktree-paths.js";
import { requireAuth } from "../server.js";
import "../server-types.js";

function sanitizeProject(project: Project) {
  const { remote_api_key: _, ...safe } = project;
  return safe;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // 获取所有项目
  fastify.get("/api/projects", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const projects = fastify.storage.projects.getAll(userId).map(sanitizeProject);
    return reply.code(200).send({ projects });
  });

  // 获取单个项目
  fastify.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    return reply.code(200).send({ project: sanitizeProject(project) });
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

  // 创建项目 (unified: local, remote, or both)
  fastify.post<{
    Body: {
      name: string;
      path?: string;
      remotePath?: string;
      remoteUrl?: string;
      remoteApiKey?: string;
      agentMode?: 'local' | 'remote';
      executorMode?: 'local' | 'remote';
    };
  }>("/api/projects", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { name, path: projectPath, remotePath, remoteUrl, remoteApiKey, agentMode, executorMode } = req.body;

    if (!name) {
      return reply.code(400).send({ error: "Project name is required" });
    }


    if (remotePath && (!remoteUrl || !remoteApiKey)) {
      return reply.code(400).send({ error: "Remote URL and API key are required when remote path is provided" });
    }

    if (projectPath) {
      const existing = fastify.storage.projects.getByPath(projectPath);
      if (existing) {
        return reply.code(409).send({ error: "Project with this path already exists" });
      }
    }

    const id = randomUUID();
    const project = fastify.storage.projects.create({
      id,
      name,
      path: projectPath || null,
      remote_path: remotePath,
      remote_url: remoteUrl,
      remote_api_key: remoteApiKey,
      agent_mode: agentMode,
      executor_mode: executorMode,
    }, userId);

    return reply.code(201).send({ project: sanitizeProject(project) });
  });

  // 更新项目
  fastify.put<{
    Params: { id: string };
    Body: {
      name?: string;
      path?: string | null;
      remotePath?: string | null;
      remoteUrl?: string | null;
      remoteApiKey?: string | null;
      agentMode?: 'local' | 'remote';
      executorMode?: 'local' | 'remote';
      syncUpConfig?: SyncButtonConfig | null;
      syncDownConfig?: SyncButtonConfig | null;
    };
  }>("/api/projects/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { name, path: newPath, remotePath, remoteUrl, remoteApiKey, agentMode, executorMode, syncUpConfig, syncDownConfig } = req.body;

    const effectivePath = newPath !== undefined ? newPath : project.path;
    const effectiveRemotePath = remotePath !== undefined ? remotePath : (project.remote_path ?? null);
    const effectiveRemoteUrl = remoteUrl !== undefined ? remoteUrl : (project.remote_url ?? null);
    const effectiveRemoteApiKey = remoteApiKey !== undefined ? remoteApiKey : (project.remote_api_key ?? null);

    if (!effectivePath && !effectiveRemotePath) {
      // Also check project_remotes table — multi-remote projects use it instead of legacy remote_path
      const remotes = fastify.storage.projectRemotes.getByProject(req.params.id);
      if (remotes.length === 0) {
        return reply.code(400).send({ error: "Project must have at least one of local path or remote path" });
      }
    }

    if (effectiveRemotePath && (!effectiveRemoteUrl || !effectiveRemoteApiKey)) {
      return reply.code(400).send({ error: "Remote URL and API key are required when remote path is provided" });
    }

    if (newPath && newPath !== project.path) {
      const existing = fastify.storage.projects.getByPath(newPath);
      if (existing && existing.id !== req.params.id) {
        return reply.code(409).send({ error: "Another project already uses this path" });
      }
    }

    const updateOpts: {
      name?: string;
      path?: string | null;
      remote_path?: string | null;
      remote_url?: string | null;
      remote_api_key?: string | null;
      agent_mode?: 'local' | 'remote';
      executor_mode?: 'local' | 'remote';
      sync_up_config?: SyncButtonConfig | null;
      sync_down_config?: SyncButtonConfig | null;
    } = {};

    if (name !== undefined) updateOpts.name = name;
    if (newPath !== undefined) updateOpts.path = newPath;
    if (remotePath !== undefined) updateOpts.remote_path = remotePath;
    if (remoteUrl !== undefined) updateOpts.remote_url = remoteUrl;
    if (remoteApiKey !== undefined) updateOpts.remote_api_key = remoteApiKey;
    if (agentMode !== undefined) updateOpts.agent_mode = agentMode;
    if (executorMode !== undefined) updateOpts.executor_mode = executorMode;
    if (syncUpConfig !== undefined) updateOpts.sync_up_config = syncUpConfig;
    if (syncDownConfig !== undefined) updateOpts.sync_down_config = syncDownConfig;

    const updated = fastify.storage.projects.update(req.params.id, updateOpts, userId);
    if (!updated) {
      return reply.code(404).send({ error: "Project not found" });
    }

    return reply.code(200).send({ project: sanitizeProject(updated) });
  });

  // 删除项目
  fastify.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    fastify.storage.projects.delete(req.params.id, userId);
    return reply.code(200).send({ success: true });
  });

  // Execute sync command for a project
  fastify.post<{
    Params: { id: string };
    Body: { syncType: 'up' | 'down'; branch?: string | null; remoteServerId?: string };
  }>("/api/projects/:id/execute-sync", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { syncType, branch, remoteServerId } = req.body;

    let syncConfig: import("../storage/types.js").SyncButtonConfig | undefined;
    let remoteUrl: string | undefined;
    let remoteApiKey: string | undefined;
    let remotePath: string | undefined;

    if (remoteServerId) {
      const pr = fastify.storage.projectRemotes.getByProjectAndServer(project.id, remoteServerId);
      if (!pr) {
        return reply.code(404).send({ error: "Remote not linked to project" });
      }
      syncConfig = syncType === 'up' ? pr.sync_up_config : pr.sync_down_config;
      remoteUrl = pr.server_url ?? undefined;
      remoteApiKey = pr.server_api_key;
      remotePath = pr.remote_path;
    } else {
      // Fallback to legacy project fields
      syncConfig = syncType === 'up' ? project.sync_up_config : project.sync_down_config;
      remoteUrl = project.remote_url;
      remoteApiKey = project.remote_api_key;
      remotePath = project.remote_path;
    }

    if (!syncConfig || syncConfig.actionType !== 'command') {
      return reply.code(400).send({ error: "Sync command not configured or not a command type" });
    }

    const executionMode = syncConfig.executionMode;

    if (executionMode === 'remote') {
      if (!remoteUrl || !remoteApiKey) {
        return reply.code(400).send({ error: "Remote not configured for this project" });
      }
      const remoteCwd = resolveWorktreePath(remotePath ?? '', branch ?? null);
      const result = await proxyToRemote(remoteUrl, remoteApiKey, 'POST', '/api/execute-one-shot', {
        command: syncConfig.content,
        cwd: remoteCwd,
      });
      if (!result.ok) {
        return reply.code(result.status || 500).send(result.data);
      }
      return reply.code(200).send(result.data);
    }

    // Local execution
    const basePath = project.path;
    if (!basePath) {
      return reply.code(400).send({ error: "Project has no local path" });
    }
    const cwd = resolveWorktreePath(basePath, branch ?? null);

    try {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        exec(syncConfig.content, { cwd, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
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

  // Execute one-shot command (for remote instances)
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
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.id, userId);
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
