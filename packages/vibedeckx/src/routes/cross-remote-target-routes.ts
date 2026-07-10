import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { promises as fs } from "fs";
import { runOneShot, MAX_OUTPUT_BYTES } from "../utils/one-shot-exec.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 300;
const PROCESS_LIST_COMMAND = "ps -eo pid,ppid,user,pcpu,pmem,etime,args";

type EntryType = "file" | "dir" | "other";

const entryType = (isFile: boolean, isDir: boolean): EntryType =>
  isDir ? "dir" : isFile ? "file" : "other";

const clampTimeoutMs = (timeoutSec: unknown): number => {
  const requested = typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0
    ? timeoutSec
    : DEFAULT_TIMEOUT_SEC;
  return Math.min(requested, MAX_TIMEOUT_SEC) * 1000;
};

/**
 * Routes invoked on a *target* machine by the SaaS server's cross-remote MCP gateway.
 * The /api/path/ prefix puts them behind the --accept-remote gate and the global
 * x-vibedeckx-api-key hook, exactly like the other server-invoked remote routes.
 */
const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { command?: string; cwd?: string; timeoutSec?: number } }>(
    "/api/path/cross-remote/exec",
    async (request, reply) => {
      const { command, cwd, timeoutSec } = request.body ?? {};
      if (!command || typeof command !== "string") {
        return reply.code(400).send({ error: "command is required" });
      }
      if (cwd !== undefined && !path.isAbsolute(cwd)) {
        return reply.code(400).send({ error: "cwd must be an absolute path" });
      }
      const result = await runOneShot(command, { cwd, timeoutMs: clampTimeoutMs(timeoutSec) });
      return reply.send(result);
    },
  );

  fastify.post<{ Body: { path?: string; offset?: number; limit?: number } }>(
    "/api/path/cross-remote/read-file",
    async (request, reply) => {
      const { path: filePath, offset = 0, limit = MAX_OUTPUT_BYTES } = request.body ?? {};
      if (!filePath || !path.isAbsolute(filePath)) {
        return reply.code(400).send({ error: "path must be an absolute path" });
      }
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return reply.code(400).send({ error: "path is not a file" });

        const cap = Math.min(limit, MAX_OUTPUT_BYTES);
        const buffer = await fs.readFile(filePath);
        const slice = buffer.subarray(offset, offset + cap);
        return reply.send({
          content: slice.toString("utf8"),
          truncated: offset + slice.length < buffer.length,
          size: stat.size,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reply.code(404).send({ error: "file not found" });
        if (code === "EACCES") return reply.code(403).send({ error: "permission denied" });
        return reply.code(500).send({ error: "failed to read file" });
      }
    },
  );

  fastify.post<{ Body: { path?: string } }>(
    "/api/path/cross-remote/list-dir",
    async (request, reply) => {
      const dirPath = request.body?.path;
      if (!dirPath || !path.isAbsolute(dirPath)) {
        return reply.code(400).send({ error: "path must be an absolute path" });
      }
      try {
        const dirents = await fs.readdir(dirPath, { withFileTypes: true });
        return reply.send({
          entries: dirents.map((d) => ({ name: d.name, type: entryType(d.isFile(), d.isDirectory()) })),
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reply.code(404).send({ error: "directory not found" });
        if (code === "EACCES") return reply.code(403).send({ error: "permission denied" });
        if (code === "ENOTDIR") return reply.code(400).send({ error: "path is not a directory" });
        return reply.code(500).send({ error: "failed to list directory" });
      }
    },
  );

  fastify.post<{ Body: { path?: string } }>(
    "/api/path/cross-remote/stat",
    async (request, reply) => {
      const targetPath = request.body?.path;
      if (!targetPath || !path.isAbsolute(targetPath)) {
        return reply.code(400).send({ error: "path must be an absolute path" });
      }
      try {
        const stat = await fs.stat(targetPath);
        return reply.send({
          type: entryType(stat.isFile(), stat.isDirectory()),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          mode: (stat.mode & 0o777).toString(8).padStart(3, "0"),
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reply.code(404).send({ error: "path not found" });
        if (code === "EACCES") return reply.code(403).send({ error: "permission denied" });
        return reply.code(500).send({ error: "failed to stat path" });
      }
    },
  );

  fastify.post("/api/path/cross-remote/process-list", async (_request, reply) => {
    const result = await runOneShot(PROCESS_LIST_COMMAND, { timeoutMs: 15_000 });
    return reply.send(result);
  });
};

export default fp(routes, { name: "cross-remote-target-routes" });
