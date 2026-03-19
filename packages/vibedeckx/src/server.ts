import fastify from "fastify";
import type { FastifyRequest, FastifyReply } from "fastify";
import { fastifyStatic } from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import path from "path";
import { fileURLToPath } from "url";
import type { Storage } from "./storage/types.js";
import sharedServices from "./plugins/shared-services.js";
import projectRoutes from "./routes/project-routes.js";
import remoteRoutes from "./routes/remote-routes.js";
import remoteServerRoutes from "./routes/remote-server-routes.js";
import projectRemoteRoutes from "./routes/project-remote-routes.js";
import executorGroupRoutes from "./routes/executor-group-routes.js";
import executorRoutes from "./routes/executor-routes.js";
import processRoutes from "./routes/process-routes.js";
import worktreeRoutes from "./routes/worktree-routes.js";
import diffRoutes from "./routes/diff-routes.js";
import fileRoutes from "./routes/file-routes.js";
import agentSessionRoutes from "./routes/agent-session-routes.js";
import chatSessionRoutes from "./routes/chat-session-routes.js";
import taskRoutes from "./routes/task-routes.js";
import settingsRoutes from "./routes/settings-routes.js";
import websocketRoutes from "./routes/websocket-routes.js";
import reverseConnectRoutes from "./routes/reverse-connect-routes.js";
import eventRoutes from "./routes/event-routes.js";
import terminalRoutes from "./routes/terminal-routes.js";
import { getAuth, clerkClient } from "@clerk/fastify";
import "./server-types.js";

// API Key from environment variable for remote access authentication
const API_KEY = process.env.VIBEDECKX_API_KEY;

/**
 * Check auth and send 401 if unauthorized. Returns userId (or undefined in no-auth mode).
 * Returns null if reply was sent (caller should return early).
 */
export function requireAuth(req: FastifyRequest, reply: FastifyReply): string | undefined | null {
  const server = req.server;
  if (!server.authEnabled) return undefined;

  // Skip Clerk auth if API key header is present (remote proxy)
  const apiKeyHeader = req.headers["x-vibedeckx-api-key"];
  if (apiKeyHeader) return undefined;

  try {
    const { userId } = getAuth(req);
    if (!userId) {
      reply.code(401).send({ error: "Unauthorized" });
      return null;
    }
    return userId;
  } catch (error) {
    console.error("Auth error:", error);
    reply.code(401).send({ error: "Authentication failed" });
    return null;
  }
}

export const createServer = async (opts: { storage: Storage; authEnabled?: boolean }) => {
  const authEnabled = opts.authEnabled ?? false;

  // Validate Clerk env vars when auth is enabled
  if (authEnabled) {
    const secretKey = process.env.CLERK_SECRET_KEY;
    const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
    if (!secretKey || !publishableKey) {
      console.error("Error: --auth requires CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY environment variables");
      process.exit(1);
    }
  }

  const UI_ROOT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "./ui"
  );

  const server = fastify();

  // Decorate authEnabled so routes can access it
  server.decorate("authEnabled", authEnabled);

  // CORS - must be set before all routes
  server.addHook("onRequest", (req, reply, done) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    reply.header("access-control-allow-headers", "Content-Type, Upgrade, Connection, X-Vibedeckx-Api-Key, X-Request-Id, Authorization");
    done();
  });

  // Log WebSocket upgrade requests (catches rejections before route handler, e.g. by Clerk)
  server.addHook("onRequest", (req, reply, done) => {
    if (req.headers.upgrade?.toLowerCase() === "websocket") {
      console.log(`[WS] Upgrade request: ${req.method} ${req.url}`);
    }
    done();
  });

  // API Key authentication middleware
  server.addHook("onRequest", (req, reply, done) => {
    if (!API_KEY) return done();
    if (!req.url.startsWith("/api/")) return done();
    if (req.method === "OPTIONS") return done();

    // When both API_KEY and Clerk auth are enabled, API key takes precedence
    // (used by remote proxy). If no API key header present and Clerk is enabled,
    // let Clerk handle auth.
    const providedKey = req.headers["x-vibedeckx-api-key"] ||
      (req.query as { apiKey?: string })?.apiKey;

    if (!providedKey && authEnabled) {
      // No API key provided but Clerk is enabled — let Clerk handle auth
      return done();
    }

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

  // Public config endpoint — no auth required, must be before Clerk plugin
  server.get("/api/config", async () => ({
    authEnabled,
    clerkPublishableKey: authEnabled ? process.env.CLERK_PUBLISHABLE_KEY : undefined,
  }));

  // Register plugins and routes
  server.register(sharedServices, { storage: opts.storage });
  server.register(fastifyWebsocket);

  // Conditionally register Clerk auth for API routes when auth is enabled.
  // We use a manual preHandler instead of clerkPlugin because clerkPlugin uses fp()
  // (escapes encapsulation) and registers a global preHandler that calls
  // authenticateRequest() on ALL requests — including WebSocket upgrades.
  // For WS upgrades (no Authorization header), Clerk returns a 307 redirect or throws,
  // killing the connection before the route handler runs.
  if (authEnabled) {
    server.decorateRequest("auth", null);
    server.addHook("preHandler", async (req, reply) => {
      // Skip WebSocket upgrades — they handle auth via query param token
      if (req.headers.upgrade?.toLowerCase() === "websocket") return;

      // Convert Fastify request to standard Request (same as clerkPlugin does)
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(",") : String(value));
      }
      const url = new URL(req.url || "", `${req.protocol}://clerk-dummy`);
      const request = new Request(url, { method: req.method, headers });

      const requestState = await clerkClient.authenticateRequest(request, {
        acceptsToken: "any",
      });
      requestState.headers.forEach((value: string, key: string) => reply.header(key, value));
      if (requestState.headers.get("location")) {
        return reply.code(307).send();
      }
      (req as unknown as Record<string, unknown>).auth = requestState.toAuth();
    });
  }

  server.register(websocketRoutes);
  server.register(reverseConnectRoutes);
  server.register(projectRoutes);
  server.register(remoteRoutes);
  server.register(remoteServerRoutes);
  server.register(projectRemoteRoutes);
  server.register(executorGroupRoutes);
  server.register(executorRoutes);
  server.register(processRoutes);
  server.register(worktreeRoutes);
  server.register(diffRoutes);
  server.register(fileRoutes);
  server.register(agentSessionRoutes);
  server.register(chatSessionRoutes);
  server.register(taskRoutes);
  server.register(settingsRoutes);
  server.register(eventRoutes);
  server.register(terminalRoutes);

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
    startLocal: async (port: number) => {
      await server.listen({ port, host: "127.0.0.1" });
      const addr = server.server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      return { url: `http://127.0.0.1:${actualPort}`, port: actualPort, instance: server };
    },
    close: async () => {
      await server.close();
    },
  };
};
