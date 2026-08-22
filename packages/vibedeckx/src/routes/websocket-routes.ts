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
import { userOwnsProcess, userOwnsSession, verifyWsToken, authenticateWs, processOwnerScope } from "./ws-authz.js";
import { connectPersistentRemoteWs } from "../remote-agent-sessions.js";
import { coverageAdmitsReplay } from "../remote-patch-cache.js";
import { attachWsHeartbeat } from "../utils/ws-heartbeat.js";
import { ProjectChatNotFoundError } from "../project-chat-manager.js";
import "../server-types.js";

export function resolveRemoteReplayCursor(
  clientEpoch: number | undefined,
  cachedEpoch: number | null,
  afterEntryIndex: number | undefined,
): { epochMatches: boolean; replayAfter: number } {
  const epochMatches = clientEpoch === undefined
    || (cachedEpoch !== null && clientEpoch === cachedEpoch);
  return {
    epochMatches,
    replayAfter: epochMatches ? (afterEntryIndex ?? -1) : -1,
  };
}

const routes: FastifyPluginAsync = async (fastify) => {
  // When a reverse-connect tunnel comes back online, re-establish persistent
  // remote WS connections for any cached sessions that belong to that server.
  fastify.reverseConnectManager.setStatusChangeHandler((remoteServerId, status) => {
    if (status !== "online") return;

    const cache = fastify.remotePatchCache;

    for (const [sessionId, remoteInfo] of fastify.remoteSessionMap) {
      if (remoteInfo.remoteServerId !== remoteServerId) continue;

      const entry = cache.get(sessionId);
      if (!entry || entry.finished) continue;
      if (cache.getRemoteWs(sessionId) || cache.isReconnecting(sessionId)) continue;

      console.log(`[AgentWS] Reverse-connect restored for ${remoteServerId}, re-establishing WS for ${sessionId}`);
      cache.resetReconnectAttempt(sessionId);
      connectPersistentRemoteWs(
        sessionId, remoteInfo, cache, fastify.reverseConnectManager,
        fastify.eventBus, fastify.agentSessionManager, fastify.storage,
      );
    }
  });

  // WebSocket routes must be registered after the websocket plugin is ready
  fastify.after(() => {
    fastify.get<{
      Params: { threadId: string };
      Querystring: { token?: string };
    }>(
      "/api/project-chat/threads/:threadId/stream",
      { websocket: true },
      async (socket, req) => {
        const principal = await authenticateWs(fastify.authEnabled, req.query, socket);
        if (!principal) return;
        const userId = principal.userId ?? "local";

        try {
          await fastify.projectChatManager.openThread(req.params.threadId, userId);
        } catch (error) {
          const message = error instanceof ProjectChatNotFoundError
            ? "Thread not found"
            : "Project Chat temporarily unavailable";
          try { socket.send(JSON.stringify({ error: message })); } catch { /* closed */ }
          try { socket.close(); } catch { /* closed */ }
          return;
        }

        (socket as WebSocket & { projectChatUserId: string }).projectChatUserId = userId;
        const unsubscribe = fastify.projectChatManager.subscribe(req.params.threadId, socket);
        if (!unsubscribe) {
          try { socket.send(JSON.stringify({ error: "Thread not found" })); } catch { /* closed */ }
          try { socket.close(); } catch { /* closed */ }
          return;
        }

        const stopHeartbeat = attachWsHeartbeat(socket, {
          label: `ProjectChatWS thread=${req.params.threadId}`,
        });

        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          stopHeartbeat();
          unsubscribe();
        };
        socket.on("close", cleanup);
        socket.on("error", cleanup);
      },
    );

    // Executor process logs WebSocket
    fastify.get<{ Params: { processId: string }; Querystring: { token?: string } }>(
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
        const ownerUserId = processOwnerScope(principal);
        if (ownerUserId !== null && !(await userOwnsProcess(fastify, processId, ownerUserId))) {
          console.log(`[WebSocket] Ownership denied for process ${processId} (user=${ownerUserId})`);
          try { socket.send(JSON.stringify({ error: "Forbidden" })); } catch { /* socket closed */ }
          try { socket.close(); } catch { /* already closed */ }
          return;
        }
        console.log(`[WebSocket] Client connected for process ${processId}`);

        // Keeps idle terminals from being reaped by the browser/proxy (code
        // 1005) and reaps the socket if the peer stops answering.
        const stopHeartbeat = attachWsHeartbeat(socket, {
          label: `ExecutorWS process=${processId}`,
        });

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
              if (message.type === "resize") {
                // PTY resizes are replayed forever via the shell's prompt
                // redraw, so record who asked for what: this is the only
                // vantage point that sees every client attached to a process.
                console.log(
                  `[WebSocket] resize ${processId} → ${message.cols}x${message.rows} ip=${req.ip} ua=${req.headers["user-agent"] ?? "?"}`
                );
              }
              handle.handleInput(message);
            }
          } catch (error) {
            console.error("[WebSocket] Failed to parse input message:", error);
          }
        });

        socket.on("close", () => {
          console.log(`[WebSocket] Client disconnected from process ${processId}`);
          stopHeartbeat();
          handle.cleanup();
        });
      }
    );

    // 多路复用 executor 日志端点：一个 workspace 一条连接，按 processId 订阅
    fastify.get<{ Querystring: { projectId?: string; token?: string } }>(
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

        // Same liveness contract as the single-process endpoint above.
        const stopHeartbeat = attachWsHeartbeat(socket, { label: "ExecutorMux" });

        const subs = new Map<string, () => void>(); // processId → cleanup
        const handleInputMap = new Map<string, (msg: InputMessage) => void>();

        const subscribeProcess = async (processId: string): Promise<void> => {
          if (subs.has(processId)) return; // 幂等：已订阅则跳过

          // Per-process ownership, checked per subscription (one mux connection
          // can subscribe to many processIds).
          const ownerUserId = processOwnerScope(principal);
          if (ownerUserId !== null && !(await userOwnsProcess(fastify, processId, ownerUserId))) {
            console.log(`[ExecutorMux] Ownership denied for process ${processId} (user=${ownerUserId})`);
            try { socket.send(JSON.stringify({ processId, type: "error", message: "Forbidden" })); } catch { /* closed */ }
            return;
          }
          // Re-check for a race: two "subscribe" messages for the same processId
          // arriving before the first await above resolves would otherwise both
          // pass the subs.has() guard and register duplicate streams.
          if (subs.has(processId)) return;

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
              subscribeProcess(msg.processId).catch((err) => {
                console.error(`[ExecutorMux] Failed to subscribe to ${msg.processId}:`, err);
              });
            } else if (msg.type === "unsubscribe") {
              subs.get(msg.processId)?.();
              subs.delete(msg.processId);
              handleInputMap.delete(msg.processId);
            } else if (msg.type === "input") {
              handleInputMap.get(msg.processId)?.({ type: "input", data: msg.data });
            } else if (msg.type === "resize") {
              console.log(
                `[ExecutorMux] resize ${msg.processId} → ${msg.cols}x${msg.rows} ip=${req.ip} ua=${req.headers["user-agent"] ?? "?"}`
              );
              handleInputMap.get(msg.processId)?.({ type: "resize", cols: msg.cols, rows: msg.rows });
            }
          } catch (error) {
            console.error("[ExecutorMux] Failed to parse client message:", error);
          }
        });

        socket.on("close", () => {
          console.log(`[ExecutorMux] Client disconnected; cleaning ${subs.size} subscriptions`);
          stopHeartbeat();
          for (const cleanup of subs.values()) cleanup();
          subs.clear();
          handleInputMap.clear();
        });
      },
    );

    // Agent Session WebSocket
    fastify.get<{ Params: { sessionId: string }; Querystring: { token?: string; after?: string; epoch?: string } }>(
      "/api/agent-sessions/:sessionId/stream",
      { websocket: true },
      async (socket, req) => {
        const { sessionId } = req.params;
        const afterEntryIndex = Number.isInteger(Number(req.query.after)) ? Number(req.query.after) : undefined;
        const historyEpoch = Number.isInteger(Number(req.query.epoch)) ? Number(req.query.epoch) : undefined;

        // Log before auth check for visibility
        console.log(`[AgentWS] Connection attempt for session ${sessionId} (auth=${fastify.authEnabled})`);

        // Verify auth token for WebSocket when auth is enabled. `principalUserId`
        // stays null only in no-auth solo mode; under Clerk it is always a real
        // user (VIBEDECKX_API_KEY gates the door but confers no identity — see
        // requireAuth in server.ts).
        let principalUserId: string | null = fastify.authEnabled ? null : "local";
        if (fastify.authEnabled) {
          const token = req.query.token;

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

        // Per-session ownership: a Clerk user may only stream sessions they own.
        // Trusted principals (userId === null) skip this.
        if (principalUserId !== null && !(await userOwnsSession(fastify, sessionId, principalUserId))) {
          console.log(`[AgentWS] Ownership denied for session ${sessionId} (user=${principalUserId})`);
          try { socket.send(JSON.stringify({ error: "Forbidden" })); } catch { /* socket closed */ }
          try { socket.close(); } catch { /* already closed */ }
          return;
        }

        console.log(`[AgentWS] Client connected for session ${sessionId}`);

        // Liveness, not just anti-idle: a suspended tab leaves this socket OPEN
        // on our side, so without pong verification every patch broadcast while
        // it is dead is silently discarded and the client never learns it needs
        // to reconnect and replay.
        // The only endpoint with `keepalive`: its client (use-agent-session)
        // runs a silence watchdog and needs an observable frame to reset it.
        const stopHeartbeat = attachWsHeartbeat(socket, {
          label: `AgentWS session=${sessionId}`,
          keepalive: true,
        });

        if (sessionId.startsWith("remote-")) {
          const remoteInfo = fastify.remoteSessionMap.get(sessionId);
          if (!remoteInfo) {
            console.log(`[AgentWS] Remote session ${sessionId} not found in map`);
            stopHeartbeat();
            socket.send(JSON.stringify({ type: "error", message: "Remote session not found" }));
            socket.close();
            return;
          }

          const cache = fastify.remotePatchCache;
          const cacheEntry = cache.getOrCreate(sessionId);

          console.log(`[AgentWS] WS connect: cacheEntry for ${sessionId} has messages.length=${cacheEntry.messages.length} finished=${cacheEntry.finished} remoteWsOpen=${!!cache.getRemoteWs(sessionId)}`);

          // --- Phase 1: Replay cached data to this frontend ---
          if (cacheEntry.messages.length > 0) {
            const { epochMatches, replayAfter } = resolveRemoteReplayCursor(
              historyEpoch, cacheEntry.historyEpoch, afterEntryIndex,
            );
            console.log(`[AgentWS] Replaying cached msgs for ${sessionId} after=${replayAfter}`);
            // OBSERVE-ONLY (Phase A). The `Ready` sent at the end of this replay
            // tells the browser its history is complete; when coverage does not
            // reach the client's cursor that claim is unprovable and any gap is
            // silent — nothing refetches, because the client believes it synced.
            // Behaviour is deliberately unchanged: withholding `Ready` without a
            // backfill path would strand the browser in its replay state.
            if (!coverageAdmitsReplay(cacheEntry.coverage, historyEpoch, afterEntryIndex)) {
              console.warn(
                `[AgentWS] COVERAGE GAP ${sessionId}: client needs from ` +
                `${(afterEntryIndex ?? -1) + 1} (epoch=${historyEpoch ?? "-"}), cache covers from ` +
                `${cacheEntry.coverage?.start ?? "unknown"} (epoch=${cacheEntry.coverage?.epoch ?? "-"}), ` +
                `frames=${cacheEntry.messages.length}, entriesLatest=${cacheEntry.latestEntryIndex ?? "-"} ` +
                `— Ready will be sent anyway`,
              );
            }
            try {
              socket.send(JSON.stringify({
                HistorySync: {
                  historyEpoch: cacheEntry.historyEpoch ?? historyEpoch ?? 0,
                  reset: !epochMatches,
                },
              }));
            } catch { /* client gone */ }
            for (const raw of cacheEntry.messages) {
              if (replayAfter >= 0) {
                try {
                  const parsed = JSON.parse(raw) as { JsonPatch?: Array<{ path?: string }> };
                  if (Array.isArray(parsed.JsonPatch)) {
                    const indices = parsed.JsonPatch.flatMap((op) => {
                      const match = op.path?.match(/^\/entries\/(\d+)$/);
                      return match ? [Number(match[1])] : [];
                    });
                    if (indices.length > 0 && indices.every((index) => index <= replayAfter)) continue;
                  }
                } catch { /* non-patch cached frame */ }
              }
              try { socket.send(raw); } catch { /* client gone */ }
            }
            try { socket.send(JSON.stringify({ Ready: true, historyEpoch: cacheEntry.historyEpoch ?? undefined })); } catch { /* client gone */ }
            // Live background-task snapshot, held last-value rather than in
            // `messages` (see CacheEntry.backgroundTasks). Without this a
            // reload during a long-running background task shows an empty bar
            // while the task is still running — the case the bar exists for.
            if (cacheEntry.backgroundTasks !== null) {
              try { socket.send(cacheEntry.backgroundTasks); } catch { /* client gone */ }
            }

            if (cacheEntry.finished) {
              try { socket.send(JSON.stringify({ finished: true })); } catch { /* noop */ }
              cache.addSubscriber(sessionId, socket);
              socket.on("close", () => {
                stopHeartbeat();
                cache.removeSubscriber(sessionId, socket);
              });
              return;
            }
          }

          // --- Phase 2: Ensure persistent remote WS ---
          cache.addSubscriber(sessionId, socket);

          const existingRemoteWs = cache.getRemoteWs(sessionId);
          if (!existingRemoteWs && !cache.isReconnecting(sessionId)) {
            // Need to open a new persistent remote WS
            connectPersistentRemoteWs(
              sessionId, remoteInfo, cache, fastify.reverseConnectManager,
              fastify.eventBus, fastify.agentSessionManager, fastify.storage,
              { afterEntryIndex, historyEpoch },
            );
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
            stopHeartbeat();
            cache.removeSubscriber(sessionId, socket);
            // Do NOT close persistent remote WS
          });

          return;
        }

        // Local session handling
        const unsubscribe = fastify.agentSessionManager.subscribe(sessionId, socket, { afterEntryIndex, historyEpoch });

        if (!unsubscribe) {
          console.log(`[AgentWS] Session ${sessionId} not found`);
          stopHeartbeat();
          socket.send(JSON.stringify({ error: "Session not found" }));
          socket.close();
          return;
        }

        socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          try {
            const message = JSON.parse(data.toString()) as AgentWsInput;
            if (message.type === "user_message") {
              fastify.agentSessionManager.sendUserMessage(sessionId, message.content).catch((err) => {
                console.error(`[AgentWS] Failed to send user message for ${sessionId}:`, err);
              });
            }
          } catch (error) {
            console.error("[AgentWS] Failed to parse message:", error);
          }
        });

        socket.on("close", () => {
          console.log(`[AgentWS] Client disconnected from session ${sessionId}`);
          stopHeartbeat();
          unsubscribe?.();
        });
      }
    );
    // Chat Session WebSocket
    fastify.get<{ Params: { sessionId: string }; Querystring: { token?: string } }>(
      "/api/chat-sessions/:sessionId/stream",
      { websocket: true },
      async (socket, req) => {
        const { sessionId } = req.params;

        // Verify auth when enabled, mirroring the agent-session WS path. The chat
        // stream forwards `user_message` into sendMessage, which builds a system
        // prompt from the workspace's rules and streams the model reply back — an
        // unauthenticated connection would leak another tenant's rule content and
        // burn their LLM budget. `principalUserId` stays null only in no-auth
        // solo mode; under Clerk it is always a real user.
        let principalUserId: string | null = fastify.authEnabled ? null : "local";
        if (fastify.authEnabled) {
          const token = req.query.token;

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

        // `keepalive: true` for the same reason the agent stream sets it: the
        // protocol-level pong never reaches JS, and an idle Main Chat socket
        // otherwise receives nothing at all — so a dead one is indistinguishable
        // from a quiet one and the client's watchdog would have nothing to
        // observe. 2026-08-18: without it this socket sat dead for 641s while
        // the agent stream, which has both halves, recovered in 38s.
        const stopHeartbeat = attachWsHeartbeat(socket, { label: `ChatWS session=${sessionId}`, keepalive: true });

        const unsubscribe = fastify.chatSessionManager.subscribe(sessionId, socket);

        if (!unsubscribe) {
          console.log(`[ChatWS] Session ${sessionId} not found`);
          stopHeartbeat();
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
          stopHeartbeat();
          unsubscribe?.();
        });
      }
    );
  });
};

export default fp(routes, { name: "websocket-routes" });
