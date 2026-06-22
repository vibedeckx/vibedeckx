import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import WebSocket from "ws";
import {
  attachLocalProcessStream,
  attachRemoteProcessStream,
  type StreamMessage,
  type InputMessage,
} from "./executor-stream-handlers.js";
import type { AgentWsInput } from "../agent-types.js";
import { userOwnsProcess, userOwnsSession, verifyWsToken, authenticateWs } from "./ws-authz.js";
import { connectPersistentRemoteWs } from "../remote-agent-sessions.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // When a reverse-connect tunnel comes back online, re-establish persistent
  // remote WS connections for any cached sessions that belong to that server.
  fastify.reverseConnectManager.setStatusChangeHandler((remoteServerId, status) => {
    if (status !== "online") return;

    const cache = fastify.remotePatchCache;
    const wsOptions = fastify.proxyManager.getWsOptions() as Record<string, unknown>;

    for (const [sessionId, remoteInfo] of fastify.remoteSessionMap) {
      if (remoteInfo.remoteServerId !== remoteServerId) continue;

      const entry = cache.get(sessionId);
      if (!entry || entry.finished) continue;
      if (cache.getRemoteWs(sessionId) || cache.isReconnecting(sessionId)) continue;

      console.log(`[AgentWS] Reverse-connect restored for ${remoteServerId}, re-establishing WS for ${sessionId}`);
      cache.resetReconnectAttempt(sessionId);
      connectPersistentRemoteWs(sessionId, remoteInfo, cache, wsOptions, fastify.reverseConnectManager, fastify.eventBus, fastify.agentSessionManager);
    }
  });

  // WebSocket routes must be registered after the websocket plugin is ready
  fastify.after(() => {
    // Executor process logs WebSocket
    fastify.get<{ Params: { processId: string }; Querystring: { apiKey?: string; token?: string } }>(
      "/api/executor-processes/:processId/logs",
      { websocket: true },
      async (socket, req) => {
        const { processId } = req.params;
        console.log(`[WebSocket] Connection attempt for process ${processId} (auth=${fastify.authEnabled})`);

        const principal = await authenticateWs(fastify.authEnabled, req.query, socket);
        if (!principal) {
          console.log(`[WebSocket] Auth rejected for process ${processId}`);
          return;
        }
        // Per-process ownership: a Clerk user may only stream/control processes
        // belonging to a project (or remote server) they own. Trusted principals
        // (no-auth / apiKey proxy) carry userId === null and skip this. Gating the
        // whole connection (not just input) also prevents reading another tenant's
        // terminal output.
        if (principal.userId !== null && !userOwnsProcess(fastify, processId, principal.userId)) {
          console.log(`[WebSocket] Ownership denied for process ${processId} (user=${principal.userId})`);
          try { socket.send(JSON.stringify({ error: "Forbidden" })); } catch { /* socket closed */ }
          try { socket.close(); } catch { /* already closed */ }
          return;
        }
        console.log(`[WebSocket] Client connected for process ${processId}`);

        // Ping/pong keepalive to prevent idle disconnections (code 1005).
        // Terminals sit quiet on hidden tabs; without this the idle socket is
        // dropped by the browser/proxy and input silently stops working.
        const pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.ping();
          }
        }, 30000); // Ping every 30 seconds

        // 旧端点：send 不包 processId；onTerminal 关闭 socket（保持单进程单连接语义）
        const send = (msg: StreamMessage) => {
          try { socket.send(JSON.stringify(msg)); } catch { /* socket closed */ }
        };
        const onTerminal = () => { try { socket.close(); } catch { /* already closed */ } };

        const handle = processId.startsWith("remote-")
          ? attachRemoteProcessStream(fastify, processId, send, onTerminal)
          : attachLocalProcessStream(fastify, processId, send, onTerminal);

        socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          try {
            const message = JSON.parse(data.toString()) as InputMessage;
            if (message.type === "input" || message.type === "resize") {
              handle.handleInput(message);
            }
          } catch (error) {
            console.error("[WebSocket] Failed to parse input message:", error);
          }
        });

        socket.on("close", () => {
          console.log(`[WebSocket] Client disconnected from process ${processId}`);
          clearInterval(pingInterval);
          handle.cleanup();
        });
      }
    );

    // 多路复用 executor 日志端点：一个 workspace 一条连接，按 processId 订阅
    fastify.get<{ Querystring: { projectId?: string; apiKey?: string; token?: string } }>(
      "/api/executor-logs/stream",
      { websocket: true },
      async (socket, req) => {
        console.log(`[ExecutorMux] Connection attempt (auth=${fastify.authEnabled})`);

        const principal = await authenticateWs(fastify.authEnabled, req.query, socket);
        if (!principal) {
          console.log(`[ExecutorMux] Auth rejected`);
          return;
        }
        console.log(`[ExecutorMux] Client connected`);

        // Ping/pong keepalive to prevent idle disconnections (code 1005),
        // same as the single-process endpoint above.
        const pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.ping();
          }
        }, 30000); // Ping every 30 seconds

        const subs = new Map<string, () => void>(); // processId → cleanup
        const handleInputMap = new Map<string, (msg: InputMessage) => void>();

        const subscribeProcess = (processId: string) => {
          if (subs.has(processId)) return; // 幂等：已订阅则跳过

          // Per-process ownership, checked per subscription (one mux connection
          // can subscribe to many processIds). Trusted principals (userId === null)
          // skip this; a Clerk user is refused processes they don't own.
          if (principal.userId !== null && !userOwnsProcess(fastify, processId, principal.userId)) {
            console.log(`[ExecutorMux] Ownership denied for process ${processId} (user=${principal.userId})`);
            try { socket.send(JSON.stringify({ processId, type: "error", message: "Forbidden" })); } catch { /* closed */ }
            return;
          }

          const send = (msg: StreamMessage) => {
            try { socket.send(JSON.stringify({ processId, ...msg })); } catch { /* closed */ }
          };
          let terminated = false;
          const onTerminal = () => {
            terminated = true;
            const c = subs.get(processId);
            if (c) { c(); subs.delete(processId); }
            handleInputMap.delete(processId);
          };

          const handle = processId.startsWith("remote-")
            ? attachRemoteProcessStream(fastify, processId, send, onTerminal)
            : attachLocalProcessStream(fastify, processId, send, onTerminal);

          // 仅当流尚未同步终止时登记 cleanup（避免给已终止进程留下陈旧条目）
          if (!terminated) {
            subs.set(processId, handle.cleanup);
            handleInputMap.set(processId, handle.handleInput);
          }
        };

        socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          try {
            const msg = JSON.parse(data.toString()) as
              | { type: "subscribe" | "unsubscribe"; processId: string }
              | { type: "input"; processId: string; data: string }
              | { type: "resize"; processId: string; cols: number; rows: number };

            if (msg.type === "subscribe") {
              subscribeProcess(msg.processId);
            } else if (msg.type === "unsubscribe") {
              subs.get(msg.processId)?.();
              subs.delete(msg.processId);
              handleInputMap.delete(msg.processId);
            } else if (msg.type === "input") {
              handleInputMap.get(msg.processId)?.({ type: "input", data: msg.data });
            } else if (msg.type === "resize") {
              handleInputMap.get(msg.processId)?.({ type: "resize", cols: msg.cols, rows: msg.rows });
            }
          } catch (error) {
            console.error("[ExecutorMux] Failed to parse client message:", error);
          }
        });

        socket.on("close", () => {
          console.log(`[ExecutorMux] Client disconnected; cleaning ${subs.size} subscriptions`);
          clearInterval(pingInterval);
          for (const cleanup of subs.values()) cleanup();
          subs.clear();
          handleInputMap.clear();
        });
      },
    );

    // Agent Session WebSocket
    fastify.get<{ Params: { sessionId: string }; Querystring: { apiKey?: string; token?: string } }>(
      "/api/agent-sessions/:sessionId/stream",
      { websocket: true },
      async (socket, req) => {
        const { sessionId } = req.params;

        // Log before auth check for visibility
        console.log(`[AgentWS] Connection attempt for session ${sessionId} (auth=${fastify.authEnabled})`);

        // Verify auth token for WebSocket when auth is enabled. `principalUserId`
        // stays null for trusted connections (no-auth, or apiKey server-to-server
        // proxy) and is set to the Clerk user otherwise.
        let principalUserId: string | null = null;
        if (fastify.authEnabled) {
          const apiKey = req.query.apiKey;
          const token = req.query.token;

          // API key takes precedence (remote proxy connections), but only when the
          // server has VIBEDECKX_API_KEY set — the global API-key onRequest hook has
          // validated its value by this point. An unvalidated ?apiKey= (key unset)
          // must NOT bypass Clerk, so fall through to token verification.
          const apiKeyTrusted = !!process.env.VIBEDECKX_API_KEY && !!apiKey;
          if (!apiKeyTrusted) {
            if (!token) {
              console.log(`[AgentWS] Auth rejected: no token (session=${sessionId})`);
              socket.send(JSON.stringify({ error: "Authentication required" }));
              socket.close();
              return;
            }
            const userId = await verifyWsToken(token);
            if (!userId) {
              console.log(`[AgentWS] Auth rejected: invalid token (session=${sessionId})`);
              socket.send(JSON.stringify({ error: "Invalid authentication token" }));
              socket.close();
              return;
            }
            principalUserId = userId;
          }
        }

        // Per-session ownership: a Clerk user may only stream sessions they own.
        // Trusted principals (userId === null) skip this.
        if (principalUserId !== null && !userOwnsSession(fastify, sessionId, principalUserId)) {
          console.log(`[AgentWS] Ownership denied for session ${sessionId} (user=${principalUserId})`);
          try { socket.send(JSON.stringify({ error: "Forbidden" })); } catch { /* socket closed */ }
          try { socket.close(); } catch { /* already closed */ }
          return;
        }

        console.log(`[AgentWS] Client connected for session ${sessionId}`);

        // Ping/pong keepalive to prevent idle disconnections (code 1005)
        const pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.ping();
          }
        }, 30000); // Ping every 30 seconds

        if (sessionId.startsWith("remote-")) {
          const remoteInfo = fastify.remoteSessionMap.get(sessionId);
          if (!remoteInfo) {
            console.log(`[AgentWS] Remote session ${sessionId} not found in map`);
            socket.send(JSON.stringify({ type: "error", message: "Remote session not found" }));
            socket.close();
            return;
          }

          const cache = fastify.remotePatchCache;
          const cacheEntry = cache.getOrCreate(sessionId);

          console.log(`[AgentWS] WS connect: cacheEntry for ${sessionId} has messages.length=${cacheEntry.messages.length} finished=${cacheEntry.finished} remoteWsOpen=${!!cache.getRemoteWs(sessionId)}`);

          // --- Phase 1: Replay cached data to this frontend ---
          if (cacheEntry.messages.length > 0) {
            console.log(`[AgentWS] Replaying ${cacheEntry.messages.length} cached msgs for ${sessionId}`);
            for (const raw of cacheEntry.messages) {
              try { socket.send(raw); } catch { /* client gone */ }
            }
            try { socket.send(JSON.stringify({ Ready: true })); } catch { /* client gone */ }

            if (cacheEntry.finished) {
              try { socket.send(JSON.stringify({ finished: true })); } catch { /* noop */ }
              cache.addSubscriber(sessionId, socket);
              socket.on("close", () => {
                clearInterval(pingInterval);
                cache.removeSubscriber(sessionId, socket);
              });
              return;
            }
          }

          // --- Phase 2: Ensure persistent remote WS ---
          cache.addSubscriber(sessionId, socket);
          const wsOptions = fastify.proxyManager.getWsOptions() as Record<string, unknown>;

          const existingRemoteWs = cache.getRemoteWs(sessionId);
          if (!existingRemoteWs && !cache.isReconnecting(sessionId)) {
            // Need to open a new persistent remote WS
            connectPersistentRemoteWs(sessionId, remoteInfo, cache, wsOptions, fastify.reverseConnectManager, fastify.eventBus, fastify.agentSessionManager);
          }

          // Send current remote connection status to the newly connected frontend
          if (cache.getRemoteWs(sessionId)) {
            try { socket.send(JSON.stringify({ remoteStatus: "connected" })); } catch { /* noop */ }
          } else if (cache.isReconnecting(sessionId)) {
            const attempt = cache.getReconnectAttempt(sessionId);
            try { socket.send(JSON.stringify({ remoteStatus: "reconnecting", attempt })); } catch { /* noop */ }
          }

          // --- Phase 3: Set up frontend socket handlers ---
          socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
            try {
              const rws = cache.getRemoteWs(sessionId);
              if (rws) rws.send(data.toString());
            } catch (error) {
              console.error("[AgentWS] Failed to forward message to remote:", error);
            }
          });

          socket.on("close", () => {
            console.log(`[AgentWS] Client disconnected from remote session ${sessionId}`);
            clearInterval(pingInterval);
            cache.removeSubscriber(sessionId, socket);
            // Do NOT close persistent remote WS
          });

          return;
        }

        // Local session handling
        const unsubscribe = fastify.agentSessionManager.subscribe(sessionId, socket);

        if (!unsubscribe) {
          console.log(`[AgentWS] Session ${sessionId} not found`);
          clearInterval(pingInterval);
          socket.send(JSON.stringify({ error: "Session not found" }));
          socket.close();
          return;
        }

        socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          try {
            const message = JSON.parse(data.toString()) as AgentWsInput;
            if (message.type === "user_message") {
              fastify.agentSessionManager.sendUserMessage(sessionId, message.content);
            }
          } catch (error) {
            console.error("[AgentWS] Failed to parse message:", error);
          }
        });

        socket.on("close", () => {
          console.log(`[AgentWS] Client disconnected from session ${sessionId}`);
          clearInterval(pingInterval);
          unsubscribe?.();
        });
      }
    );
    // Chat Session WebSocket
    fastify.get<{ Params: { sessionId: string }; Querystring: { apiKey?: string; token?: string } }>(
      "/api/chat-sessions/:sessionId/stream",
      { websocket: true },
      async (socket, req) => {
        const { sessionId } = req.params;

        // Verify auth when enabled, mirroring the agent-session WS path. The chat
        // stream forwards `user_message` into sendMessage, which builds a system
        // prompt from the workspace's rules and streams the model reply back — an
        // unauthenticated connection would leak another tenant's rule content and
        // burn their LLM budget. `principalUserId` stays null for trusted
        // connections (no-auth, or apiKey server-to-server proxy).
        let principalUserId: string | null = null;
        if (fastify.authEnabled) {
          const apiKey = req.query.apiKey;
          const token = req.query.token;

          const apiKeyTrusted = !!process.env.VIBEDECKX_API_KEY && !!apiKey;
          if (!apiKeyTrusted) {
            if (!token) {
              console.log(`[ChatWS] Auth rejected: no token (session=${sessionId})`);
              try { socket.send(JSON.stringify({ error: "Authentication required" })); } catch { /* socket closed */ }
              try { socket.close(); } catch { /* already closed */ }
              return;
            }
            const userId = await verifyWsToken(token);
            if (!userId) {
              console.log(`[ChatWS] Auth rejected: invalid token (session=${sessionId})`);
              try { socket.send(JSON.stringify({ error: "Invalid authentication token" })); } catch { /* socket closed */ }
              try { socket.close(); } catch { /* already closed */ }
              return;
            }
            principalUserId = userId;
          }
        }

        // Per-session ownership: a Clerk user may only stream chat sessions they
        // own. Chat sessions are in-memory, so check the manager directly. Trusted
        // principals (userId === null) skip this.
        if (principalUserId !== null) {
          const owned = fastify.chatSessionManager.getSession(sessionId);
          if (!owned || owned.userId !== principalUserId) {
            console.log(`[ChatWS] Ownership denied for session ${sessionId} (user=${principalUserId})`);
            try { socket.send(JSON.stringify({ error: "Forbidden" })); } catch { /* socket closed */ }
            try { socket.close(); } catch { /* already closed */ }
            return;
          }
        }

        console.log(`[ChatWS] Client connected for session ${sessionId}`);

        // Ping/pong keepalive
        const pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.ping();
          }
        }, 30000);

        const unsubscribe = fastify.chatSessionManager.subscribe(sessionId, socket);

        if (!unsubscribe) {
          console.log(`[ChatWS] Session ${sessionId} not found`);
          clearInterval(pingInterval);
          socket.send(JSON.stringify({ error: "Session not found" }));
          socket.close();
          return;
        }

        socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === "user_message") {
              // Chat sessions only accept string content
              const chatContent = typeof message.content === "string" ? message.content : message.content.filter((p: { type: string; text: string }) => p.type === "text").map((p: { text: string }) => p.text).join("\n");
              fastify.chatSessionManager.sendMessage(sessionId, chatContent);
            } else if (message.type === "browser_result") {
              fastify.chatSessionManager.handleBrowserResult(message.result);
            }
          } catch (error) {
            console.error("[ChatWS] Failed to parse message:", error);
          }
        });

        socket.on("close", () => {
          console.log(`[ChatWS] Client disconnected from session ${sessionId}`);
          clearInterval(pingInterval);
          unsubscribe?.();
        });
      }
    );
  });
};

export default fp(routes, { name: "websocket-routes" });
