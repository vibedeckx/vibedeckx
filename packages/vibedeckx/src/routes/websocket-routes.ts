import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import type { LogMessage, InputMessage } from "../process-manager.js";
import type { AgentWsInput } from "../agent-types.js";
import type { RemoteSessionInfo } from "../server-types.js";
import type { RemotePatchCache } from "../remote-patch-cache.js";
import { VirtualWsAdapter } from "../virtual-ws-adapter.js";
import "../server-types.js";

/**
 * Verify a Clerk session token for WebSocket connections.
 * Returns the userId if valid, null otherwise.
 */
async function verifyWsToken(token: string): Promise<string | null> {
  try {
    const { verifyToken } = await import("@clerk/backend");
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

// ---- Remote reconnection constants ----
const REMOTE_RECONNECT_MAX_ATTEMPTS = 10;
const REMOTE_RECONNECT_BASE_DELAY_MS = 1000;
const REMOTE_RECONNECT_MAX_DELAY_MS = 30000;
/** How long a connection must stay open before we consider it "stable" and reset the attempt counter. */
const REMOTE_RECONNECT_STABILITY_MS = 10000;

/** Build a WebSocket URL for a remote agent session. */
function buildRemoteWsUrl(remoteInfo: RemoteSessionInfo): string {
  const cleanRemoteUrl = remoteInfo.remoteUrl.replace(/\/+$/, "");
  const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
  const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
  return `${wsUrl}/api/agent-sessions/${remoteInfo.remoteSessionId}/stream?apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
}

/** Try to parse a raw WS message string, returning undefined on failure. */
function tryParseWsMessage(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Create a persistent WebSocket to the remote server and wire up message
 * handling (sync or live mode), reconnection on close, and status broadcasts.
 *
 * Called both on first frontend connection and on automatic reconnection.
 */
function connectPersistentRemoteWs(
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
  cache: RemotePatchCache,
  wsOptions: Record<string, unknown>,
  reverseConnectManager?: import("../reverse-connect-manager.js").ReverseConnectManager,
): void {
  const hasCachedData = cache.hasData(sessionId);
  const useVirtual = reverseConnectManager && reverseConnectManager.isConnected(remoteInfo.remoteServerId);
  console.log(`[AgentWS] Opening persistent remote WS for ${sessionId} (cached=${hasCachedData}, virtual=${!!useVirtual})`);

  let remoteWs: WebSocket | VirtualWsAdapter;

  if (useVirtual) {
    const channelId = randomUUID();
    const wsPath = `/api/agent-sessions/${remoteInfo.remoteSessionId}/stream`;
    const wsQuery = `apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;

    const adapter = new VirtualWsAdapter(
      (data) => reverseConnectManager.sendChannelData(remoteInfo.remoteServerId, channelId, data),
      () => reverseConnectManager.closeChannel(remoteInfo.remoteServerId, channelId),
    );

    reverseConnectManager.setChannelAdapter(remoteInfo.remoteServerId, channelId, adapter);
    reverseConnectManager.openVirtualChannel(remoteInfo.remoteServerId, channelId, wsPath, wsQuery);

    remoteWs = adapter;
    // Simulate open event on next tick
    setTimeout(() => adapter.emit("open"), 0);
  } else {
    const remoteWsUrl = buildRemoteWsUrl(remoteInfo);
    remoteWs = new WebSocket(remoteWsUrl, undefined, wsOptions);
  }

  cache.setRemoteWs(sessionId, remoteWs as WebSocket);
  cache.setReconnecting(sessionId, false);
  cache.clearReconnectTimer(sessionId);

  /** Live-mode message handler — shared by both first-connect and post-sync paths. */
  const handleLiveMessage = (data: import("ws").RawData) => {
    const raw = data.toString();
    const parsed = tryParseWsMessage(raw);
    if (!parsed) return;

    if ("JsonPatch" in parsed) {
      cache.appendMessage(sessionId, raw, true);
      cache.broadcast(sessionId, raw);
    } else if ("finished" in parsed) {
      cache.setFinished(sessionId);
      cache.broadcast(sessionId, raw);
    } else if ("taskCompleted" in parsed) {
      cache.appendMessage(sessionId, raw, false);
      cache.broadcast(sessionId, raw);
    } else if ("error" in parsed) {
      cache.appendMessage(sessionId, raw, false);
      cache.broadcast(sessionId, raw);
      // If session not found on remote, stop reconnecting
      if (parsed.error === "Session not found") {
        cache.setFinished(sessionId);
      }
    } else if ("Ready" in parsed) {
      cache.broadcast(sessionId, raw);
    }
  };

  remoteWs.on("open", () => {
    console.log(`[AgentWS] Persistent remote WS connected for ${sessionId} (sync=${hasCachedData})`);
    cache.broadcast(sessionId, JSON.stringify({ remoteStatus: "connected" }));
    // Only reset the reconnect attempt counter after the connection has been
    // stable for a minimum duration. This prevents an infinite ~1s reconnect
    // loop when connections succeed but immediately close (e.g. remote closes
    // after sync, idle timeout, etc.).
    const stabilityTimer = setTimeout(() => {
      cache.resetReconnectAttempt(sessionId);
    }, REMOTE_RECONNECT_STABILITY_MS);
    remoteWs.once("close", () => clearTimeout(stabilityTimer));
  });

  // Ping/pong keepalive to prevent idle disconnections (e.g. Cloudflare 100s timeout)
  const pingInterval = setInterval(() => {
    if (remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.ping();
    }
  }, 30000);

  if (!hasCachedData) {
    // First connection ever — stream directly in live mode
    remoteWs.on("message", handleLiveMessage);
  } else {
    // Has cached data but persistent WS died — need sync first
    const replayBuffer: string[] = [];
    let syncing = true;

    remoteWs.on("message", (data) => {
      const raw = data.toString();
      const parsed = tryParseWsMessage(raw);
      if (!parsed) return;

      if (!syncing) {
        handleLiveMessage(data);
        return;
      }

      if ("Ready" in parsed) {
        // Remote finished replay — reconcile
        syncing = false;
        const currentEntry = cache.get(sessionId)!;
        const cachedMsgCount = currentEntry.messages.length;

        if (replayBuffer.length > cachedMsgCount) {
          // Remote has newer data — send delta + update cache
          const delta = replayBuffer.slice(cachedMsgCount);
          console.log(`[AgentWS] Sync delta: ${delta.length} new msgs for ${sessionId}`);
          for (const msg of delta) {
            const p = tryParseWsMessage(msg);
            cache.appendMessage(sessionId, msg, !!(p && "JsonPatch" in p));
            cache.broadcast(sessionId, msg);
          }
        } else if (replayBuffer.length < cachedMsgCount) {
          // Cache is stale (session was restarted remotely) — full replace
          console.log(`[AgentWS] Sync stale cache for ${sessionId}: remote=${replayBuffer.length}, cached=${cachedMsgCount}`);
          let newPatchCount = 0;
          for (const msg of replayBuffer) {
            const p = tryParseWsMessage(msg);
            if (p && "JsonPatch" in p) newPatchCount++;
          }
          cache.replaceAll(sessionId, [...replayBuffer], newPatchCount);
          // Tell frontends to clear and re-render
          const clearPatch = {
            JsonPatch: [{
              op: "replace",
              path: "/entries",
              value: { type: "ENTRY", content: { type: "system", content: "__CLEAR_ALL__", timestamp: Date.now() } },
            }],
          };
          cache.broadcast(sessionId, JSON.stringify(clearPatch));
          for (const msg of replayBuffer) {
            cache.broadcast(sessionId, msg);
          }
          cache.broadcast(sessionId, JSON.stringify({ Ready: true }));
        }
        // else equal — cache is current, nothing to send

        // Switch to live-mode handler
        remoteWs.removeAllListeners("message");
        remoteWs.on("message", handleLiveMessage);
        return;
      }

      // Buffer history messages during sync
      if ("JsonPatch" in parsed || "taskCompleted" in parsed || "error" in parsed) {
        replayBuffer.push(raw);
      }
      if ("finished" in parsed) {
        cache.setFinished(sessionId);
      }
    });
  }

  // ---- Lifecycle handlers ----

  remoteWs.on("error", (error) => {
    console.error(`[AgentWS] Persistent remote WS error for ${sessionId}:`, error);
    clearInterval(pingInterval);
    // "close" event fires next and handles reconnection
  });

  remoteWs.on("close", () => {
    console.log(`[AgentWS] Persistent remote WS closed for ${sessionId}`);
    clearInterval(pingInterval);
    cache.setRemoteWs(sessionId, null);

    // Don't reconnect if session is finished or cache entry was deleted
    const entry = cache.get(sessionId);
    if (!entry || entry.finished) return;

    scheduleRemoteReconnect(sessionId, remoteInfo, cache, wsOptions, reverseConnectManager);
  });
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 * Broadcasts `remoteStatus` updates to all subscribed frontends.
 */
function scheduleRemoteReconnect(
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
  cache: RemotePatchCache,
  wsOptions: Record<string, unknown>,
  reverseConnectManager?: import("../reverse-connect-manager.js").ReverseConnectManager,
): void {
  const entry = cache.get(sessionId);
  if (!entry || entry.finished) return;

  const attempt = cache.getReconnectAttempt(sessionId);
  if (attempt >= REMOTE_RECONNECT_MAX_ATTEMPTS) {
    console.log(`[AgentWS] Max reconnect attempts (${REMOTE_RECONNECT_MAX_ATTEMPTS}) reached for ${sessionId}`);
    cache.setReconnecting(sessionId, false);
    cache.broadcast(sessionId, JSON.stringify({ remoteStatus: "disconnected" }));
    return;
  }

  cache.setReconnecting(sessionId, true);

  const delay = Math.min(REMOTE_RECONNECT_MAX_DELAY_MS, REMOTE_RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt));
  const jitter = delay * Math.random() * 0.25;
  const totalDelay = delay + jitter;

  console.log(`[AgentWS] Scheduling remote reconnect for ${sessionId} in ${Math.round(totalDelay)}ms (attempt ${attempt + 1}/${REMOTE_RECONNECT_MAX_ATTEMPTS})`);
  cache.broadcast(sessionId, JSON.stringify({ remoteStatus: "reconnecting", attempt: attempt + 1 }));

  cache.incrementReconnectAttempt(sessionId);
  const timer = setTimeout(() => {
    // Guard: entry might have been deleted while waiting
    if (!cache.get(sessionId) || cache.get(sessionId)!.finished) {
      cache.setReconnecting(sessionId, false);
      return;
    }
    connectPersistentRemoteWs(sessionId, remoteInfo, cache, wsOptions, reverseConnectManager);
  }, totalDelay);

  cache.setReconnectTimer(sessionId, timer);
}

const routes: FastifyPluginAsync = async (fastify) => {
  // WebSocket routes must be registered after the websocket plugin is ready
  fastify.after(() => {
    // Executor process logs WebSocket
    fastify.get<{ Params: { processId: string } }>(
      "/api/executor-processes/:processId/logs",
      { websocket: true },
      (socket, req) => {
        const { processId } = req.params;

        console.log(`[WebSocket] Client connected for process ${processId}`);

        // Remote executor process proxy
        if (processId.startsWith("remote-")) {
          const remoteInfo = fastify.remoteExecutorMap.get(processId);
          if (!remoteInfo) {
            console.log(`[WebSocket] Remote process ${processId} not found in map`);
            socket.send(JSON.stringify({ type: "error", message: "Remote process not found" }));
            socket.close();
            return;
          }

          const useVirtualExec = fastify.reverseConnectManager.isConnected(remoteInfo.remoteServerId);
          let remoteWs: WebSocket | VirtualWsAdapter;

          if (useVirtualExec) {
            const channelId = randomUUID();
            const wsPath = `/api/executor-processes/${remoteInfo.remoteProcessId}/logs`;
            const wsQuery = `apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
            const adapter = new VirtualWsAdapter(
              (data) => fastify.reverseConnectManager.sendChannelData(remoteInfo.remoteServerId, channelId, data),
              () => fastify.reverseConnectManager.closeChannel(remoteInfo.remoteServerId, channelId),
            );
            fastify.reverseConnectManager.setChannelAdapter(remoteInfo.remoteServerId, channelId, adapter);
            fastify.reverseConnectManager.openVirtualChannel(remoteInfo.remoteServerId, channelId, wsPath, wsQuery);
            remoteWs = adapter;
            console.log(`[WebSocket] Virtual channel opened for remote process ${remoteInfo.remoteProcessId}`);
            setTimeout(() => adapter.emit("open"), 0);
          } else {
            const cleanRemoteUrl = remoteInfo.remoteUrl.replace(/\/+$/, "");
            const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
            const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
            const remoteWsUrl = `${wsUrl}/api/executor-processes/${remoteInfo.remoteProcessId}/logs?apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
            console.log(`[WebSocket] Proxying to remote: ${remoteWsUrl.replace(remoteInfo.remoteApiKey, "***")}`);
            remoteWs = new WebSocket(remoteWsUrl, undefined, fastify.proxyManager.getWsOptions());
          }

          remoteWs.on("open", () => {
            console.log(`[WebSocket] Connected to remote process ${remoteInfo.remoteProcessId}`);
          });

          // Ping/pong keepalive to prevent idle disconnections when browser tab is backgrounded
          const pingInterval = setInterval(() => {
            if (remoteWs.readyState === WebSocket.OPEN) {
              remoteWs.ping();
            }
          }, 30000);

          remoteWs.on("message", (data) => {
            try {
              socket.send(data.toString());
            } catch (error) {
              console.error("[WebSocket] Failed to forward message to client:", error);
            }
          });

          socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
            try {
              if (remoteWs.readyState === WebSocket.OPEN) {
                remoteWs.send(data.toString());
              }
            } catch (error) {
              console.error("[WebSocket] Failed to forward message to remote:", error);
            }
          });

          remoteWs.on("close", () => {
            console.log(`[WebSocket] Remote connection closed for process ${processId}`);
            clearInterval(pingInterval);
            socket.close();
          });

          remoteWs.on("error", (error) => {
            console.error(`[WebSocket] Remote connection error:`, error);
            clearInterval(pingInterval);
            socket.send(JSON.stringify({ type: "error", message: "Remote connection error" }));
            socket.close();
          });

          socket.on("close", () => {
            console.log(`[WebSocket] Client disconnected from remote process ${processId}`);
            clearInterval(pingInterval);
            remoteWs.close();
          });

          return;
        }

        // Local process handling
        const isPty = fastify.processManager.isPtyProcess(processId);
        socket.send(JSON.stringify({ type: "init", isPty }));

        const logs = fastify.processManager.getLogs(processId);
        console.log(`[WebSocket] Sending ${logs.length} historical logs`);
        for (const log of logs) {
          socket.send(JSON.stringify(log));
        }

        const isRunning = fastify.processManager.isRunning(processId);
        console.log(`[WebSocket] Process running: ${isRunning}`);

        if (logs.length === 0 && !isRunning) {
          console.log(`[WebSocket] Process not found or no logs, closing connection`);
          socket.send(JSON.stringify({ type: "error", message: "Process not found" }));
          socket.close();
          return;
        }

        const lastLog = logs[logs.length - 1];
        if (lastLog?.type === "finished") {
          socket.close();
          return;
        }

        const unsubscribe = fastify.processManager.subscribe(processId, (msg: LogMessage) => {
          try {
            socket.send(JSON.stringify(msg));
            if (msg.type === "finished") {
              socket.close();
            }
          } catch (error) {
            unsubscribe?.();
          }
        });

        socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          try {
            const message = JSON.parse(data.toString()) as InputMessage;
            if (message.type === "input" || message.type === "resize") {
              fastify.processManager.handleInput(processId, message);
            }
          } catch (error) {
            console.error("[WebSocket] Failed to parse input message:", error);
          }
        });

        socket.on("close", () => {
          unsubscribe?.();
        });
      }
    );

    // Agent Session WebSocket
    fastify.get<{ Params: { sessionId: string }; Querystring: { apiKey?: string; token?: string } }>(
      "/api/agent-sessions/:sessionId/stream",
      { websocket: true },
      async (socket, req) => {
        const { sessionId } = req.params;

        // Verify auth token for WebSocket when auth is enabled
        if (fastify.authEnabled) {
          const apiKey = req.query.apiKey;
          const token = req.query.token;

          // API key takes precedence (remote proxy connections)
          if (!apiKey) {
            if (!token) {
              socket.send(JSON.stringify({ error: "Authentication required" }));
              socket.close();
              return;
            }
            const userId = await verifyWsToken(token);
            if (!userId) {
              socket.send(JSON.stringify({ error: "Invalid authentication token" }));
              socket.close();
              return;
            }
          }
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
            connectPersistentRemoteWs(sessionId, remoteInfo, cache, wsOptions, fastify.reverseConnectManager);
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
    fastify.get<{ Params: { sessionId: string } }>(
      "/api/chat-sessions/:sessionId/stream",
      { websocket: true },
      (socket, req) => {
        const { sessionId } = req.params;

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
            const message = JSON.parse(data.toString()) as AgentWsInput;
            if (message.type === "user_message") {
              // Chat sessions only accept string content
              const chatContent = typeof message.content === "string" ? message.content : message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
              fastify.chatSessionManager.sendMessage(sessionId, chatContent);
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
