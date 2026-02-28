import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import WebSocket from "ws";
import type { LogMessage, InputMessage } from "../process-manager.js";
import type { AgentWsInput } from "../agent-types.js";
import type { RemoteSessionInfo } from "../server-types.js";
import "../server-types.js";

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

          const cleanRemoteUrl = remoteInfo.remoteUrl.replace(/\/+$/, "");
          const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
          const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
          const remoteWsUrl = `${wsUrl}/api/executor-processes/${remoteInfo.remoteProcessId}/logs?apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;

          console.log(`[WebSocket] Proxying to remote: ${remoteWsUrl.replace(remoteInfo.remoteApiKey, "***")}`);

          const remoteWs = new WebSocket(remoteWsUrl, undefined, fastify.proxyManager.getWsOptions());

          remoteWs.on("open", () => {
            console.log(`[WebSocket] Connected to remote process ${remoteInfo.remoteProcessId}`);
          });

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
            socket.close();
          });

          remoteWs.on("error", (error) => {
            console.error(`[WebSocket] Remote connection error:`, error);
            socket.send(JSON.stringify({ type: "error", message: "Remote connection error" }));
            socket.close();
          });

          socket.on("close", () => {
            console.log(`[WebSocket] Client disconnected from remote process ${processId}`);
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
    fastify.get<{ Params: { sessionId: string }; Querystring: { apiKey?: string } }>(
      "/api/agent-sessions/:sessionId/stream",
      { websocket: true },
      (socket, req) => {
        const { sessionId } = req.params;

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
          const hasCachedData = cache.hasData(sessionId);

          // --------------------------------------------------
          // Path B: Cache HIT — instant replay then background sync
          // --------------------------------------------------
          if (hasCachedData) {
            const cacheEntry = cache.get(sessionId)!;
            const cachedPatchCount = cacheEntry.patchCount;
            console.log(`[AgentWS] Cache HIT for ${sessionId}: ${cacheEntry.messages.length} msgs, ${cachedPatchCount} patches, finished=${cacheEntry.finished}`);

            // 1. Instant replay from cache
            for (const raw of cacheEntry.messages) {
              try { socket.send(raw); } catch { /* client gone */ }
            }
            try { socket.send(JSON.stringify({ Ready: true })); } catch { /* client gone */ }

            // If the session already finished, no need to connect to remote
            if (cacheEntry.finished) {
              try { socket.send(JSON.stringify({ finished: true })); } catch { /* noop */ }
              // Keep socket open for ping/pong — frontend decides when to close
              socket.on("close", () => {
                clearInterval(pingInterval);
              });
              return;
            }

            // 2. Background sync with remote
            const remoteWsUrl = buildRemoteWsUrl(remoteInfo);
            console.log(`[AgentWS] Background sync for ${sessionId}`);
            const remoteWs = new WebSocket(remoteWsUrl, undefined, fastify.proxyManager.getWsOptions());

            let syncing = true;            // true while replaying remote history
            let remotePatchCount = 0;      // patches seen during remote replay
            const replayBuffer: string[] = []; // buffered remote replay messages
            const pendingUserMessages: string[] = []; // user messages queued during sync

            remoteWs.on("open", () => {
              console.log(`[AgentWS] Background sync connected for ${sessionId}`);
            });

            remoteWs.on("message", (data) => {
              const raw = data.toString();
              const parsed = tryParseWsMessage(raw);
              if (!parsed) return;

              if (syncing) {
                // Still in remote history replay phase (before remote Ready)
                if ("Ready" in parsed) {
                  // Remote finished replay — reconcile
                  syncing = false;

                  if (remotePatchCount > cachedPatchCount) {
                    // Remote has newer data — send delta to frontend + update cache
                    const delta = replayBuffer.slice(cachedPatchCount);
                    console.log(`[AgentWS] Sync delta: ${delta.length} new patches for ${sessionId}`);
                    for (const msg of delta) {
                      try { socket.send(msg); } catch { break; }
                      const p = tryParseWsMessage(msg);
                      cache.appendMessage(sessionId, msg, !!(p && "JsonPatch" in p));
                    }
                  } else if (remotePatchCount < cachedPatchCount) {
                    // Cache is stale (session was restarted remotely) — full replace
                    console.log(`[AgentWS] Sync stale cache for ${sessionId}: remote=${remotePatchCount}, cached=${cachedPatchCount}`);
                    // Build new cache from replay buffer
                    let newPatchCount = 0;
                    for (const msg of replayBuffer) {
                      const p = tryParseWsMessage(msg);
                      if (p && "JsonPatch" in p) newPatchCount++;
                    }
                    cache.replaceAll(sessionId, [...replayBuffer], newPatchCount);
                    // Tell frontend to clear and re-render
                    try {
                      // Import clearAll patch shape inline
                      const clearPatch = {
                        JsonPatch: [{
                          op: "replace",
                          path: "/entries",
                          value: { type: "ENTRY", content: { type: "system", content: "__CLEAR_ALL__", timestamp: Date.now() } },
                        }],
                      };
                      socket.send(JSON.stringify(clearPatch));
                      for (const msg of replayBuffer) {
                        try { socket.send(msg); } catch { break; }
                      }
                      socket.send(JSON.stringify({ Ready: true }));
                    } catch { /* client gone */ }
                  }
                  // else equal — cache is current, nothing to send

                  // Flush any user messages buffered during sync
                  for (const userMsg of pendingUserMessages) {
                    try {
                      if (remoteWs.readyState === WebSocket.OPEN) {
                        remoteWs.send(userMsg);
                      }
                    } catch { break; }
                  }
                  pendingUserMessages.length = 0;
                  return;
                }

                // Buffer history patches during sync
                if ("JsonPatch" in parsed) {
                  remotePatchCount++;
                  replayBuffer.push(raw);
                } else if ("taskCompleted" in parsed || "error" in parsed) {
                  replayBuffer.push(raw);
                } else if ("finished" in parsed) {
                  // Session finished during replay — treat as end of sync
                  replayBuffer.push(raw);
                }
                return;
              }

              // 3. Live mode — forward remote → frontend + cache
              try { socket.send(raw); } catch { /* client gone */ }
              if ("JsonPatch" in parsed) {
                cache.appendMessage(sessionId, raw, true);
              } else if ("finished" in parsed) {
                cache.setFinished(sessionId);
              } else if ("taskCompleted" in parsed || "error" in parsed) {
                cache.appendMessage(sessionId, raw, false);
              }
            });

            socket.on("message", (msgData: Buffer | ArrayBuffer | Buffer[]) => {
              const userMsg = msgData.toString();
              if (syncing) {
                // Buffer user messages until sync completes
                pendingUserMessages.push(userMsg);
                return;
              }
              try {
                if (remoteWs.readyState === WebSocket.OPEN) {
                  remoteWs.send(userMsg);
                }
              } catch (error) {
                console.error("[AgentWS] Failed to forward message to remote:", error);
              }
            });

            remoteWs.on("close", () => {
              console.log(`[AgentWS] Remote sync connection closed for ${sessionId}`);
              if (!syncing) {
                socket.close();
              }
            });

            remoteWs.on("error", (error) => {
              console.error(`[AgentWS] Remote sync error for ${sessionId}:`, error);
              // Frontend already has cached data — send error but don't close
              try {
                socket.send(JSON.stringify({ error: "Remote connection error during sync" }));
              } catch { /* noop */ }
              if (!syncing) {
                socket.close();
              }
            });

            socket.on("close", () => {
              console.log(`[AgentWS] Client disconnected from cached session ${sessionId}`);
              clearInterval(pingInterval);
              remoteWs.close();
            });

            return;
          }

          // --------------------------------------------------
          // Path A: Cache MISS — first connection, intercept + cache
          // --------------------------------------------------
          const remoteWsUrl = buildRemoteWsUrl(remoteInfo);
          console.log(`[AgentWS] Cache MISS for ${sessionId}, proxying to: ${remoteWsUrl.replace(remoteInfo.remoteApiKey, "***")}`);

          const remoteWs = new WebSocket(remoteWsUrl, undefined, fastify.proxyManager.getWsOptions());

          remoteWs.on("open", () => {
            console.log(`[AgentWS] Connected to remote session ${remoteInfo.remoteSessionId}`);
          });

          remoteWs.on("message", (data) => {
            const raw = data.toString();
            try { socket.send(raw); } catch { return; }

            // Cache the message
            const parsed = tryParseWsMessage(raw);
            if (!parsed) return;
            if ("JsonPatch" in parsed) {
              cache.appendMessage(sessionId, raw, true);
            } else if ("finished" in parsed) {
              cache.setFinished(sessionId);
            } else if ("taskCompleted" in parsed || "error" in parsed) {
              cache.appendMessage(sessionId, raw, false);
            }
            // { Ready } is not cached — it's a one-time signal
          });

          socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
            try {
              if (remoteWs.readyState === WebSocket.OPEN) {
                remoteWs.send(data.toString());
              }
            } catch (error) {
              console.error("[AgentWS] Failed to forward message to remote:", error);
            }
          });

          remoteWs.on("close", () => {
            console.log(`[AgentWS] Remote connection closed for session ${sessionId}`);
            socket.close();
          });

          remoteWs.on("error", (error) => {
            console.error(`[AgentWS] Remote connection error:`, error);
            socket.send(JSON.stringify({ error: "Remote connection error" }));
            socket.close();
          });

          socket.on("close", () => {
            console.log(`[AgentWS] Client disconnected from remote session ${sessionId}`);
            clearInterval(pingInterval);
            remoteWs.close();
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
  });
};

export default fp(routes, { name: "websocket-routes" });
