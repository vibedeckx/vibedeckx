import fastify from "fastify";
import { fastifyStatic } from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import path from "path";
import { fileURLToPath } from "url";
import type { Storage } from "./storage/types.js";
import sharedServices from "./plugins/shared-services.js";
import projectRoutes from "./routes/project-routes.js";
import remoteRoutes from "./routes/remote-routes.js";
import executorGroupRoutes from "./routes/executor-group-routes.js";
import executorRoutes from "./routes/executor-routes.js";
import processRoutes from "./routes/process-routes.js";
import worktreeRoutes from "./routes/worktree-routes.js";
import diffRoutes from "./routes/diff-routes.js";
import fileRoutes from "./routes/file-routes.js";
import agentSessionRoutes from "./routes/agent-session-routes.js";
import taskRoutes from "./routes/task-routes.js";
import websocketRoutes from "./routes/websocket-routes.js";

// API Key from environment variable for remote access authentication
const API_KEY = process.env.VIBEDECKX_API_KEY;

export const createServer = (opts: { storage: Storage }) => {
  const UI_ROOT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "./ui"
  );

  const server = fastify();

  // CORS - 必须在所有路由之前设置
  server.addHook("onRequest", (req, reply, done) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    reply.header("access-control-allow-headers", "Content-Type, Upgrade, Connection, X-Vibedeckx-Api-Key, X-Request-Id");
    done();
  });

  // API Key authentication middleware
  server.addHook("onRequest", (req, reply, done) => {
    if (!API_KEY) return done();
    if (!req.url.startsWith("/api/")) return done();
    if (req.method === "OPTIONS") return done();

    const providedKey = req.headers["x-vibedeckx-api-key"] ||
      (req.query as { apiKey?: string })?.apiKey;

    if (providedKey !== API_KEY) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    done();
  });

  // Request/response logging for proxied requests (those with X-Request-Id)
  server.addHook("onRequest", (req, _reply, done) => {
    const requestId = req.headers["x-request-id"];
    if (requestId) {
      (req as unknown as Record<string, unknown>).startTime = Date.now();
      console.log(`[remote] ${requestId} ${req.method} ${req.url}`);
    }
    done();
  });

  server.addHook("onResponse", (req, reply, done) => {
    const requestId = req.headers["x-request-id"];
    if (requestId) {
      const startTime = (req as unknown as Record<string, unknown>).startTime as number | undefined;
      const ms = startTime ? Date.now() - startTime : 0;
      console.log(`[remote] ${requestId} ${req.method} ${req.url} -> ${reply.statusCode} (${ms}ms)`);
    }
    done();
  });

  // Handle CORS preflight requests
  server.options("/*", async (req, reply) => {
    return reply.code(204).send();
  });

  // Register plugins and routes
  server.register(sharedServices, { storage: opts.storage });
  server.register(fastifyWebsocket);
  server.register(websocketRoutes);
  server.register(projectRoutes);
  server.register(remoteRoutes);
  server.register(executorGroupRoutes);
  server.register(executorRoutes);
  server.register(processRoutes);
  server.register(worktreeRoutes);
  server.register(diffRoutes);
  server.register(fileRoutes);
  server.register(agentSessionRoutes);
  server.register(taskRoutes);

  // 提供静态 UI 文件
  server.register(fastifyStatic, {
    root: UI_ROOT,
    wildcard: false,
  });

  // SPA 路由支持 - 只对非 API 路径返回 index.html
  server.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.status(200).sendFile("index.html");
  });

  return {
    start: async (port: number) => {
      await server.listen({ port, host: "0.0.0.0" });
      return `http://localhost:${port}`;
    },
    close: async () => {
      await server.close();
    },
  };
};
