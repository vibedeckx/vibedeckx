import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import WebSocket from "ws";
import type { LogMessage, InputMessage } from "../process-manager.js";
import type { AgentWsInput } from "../agent-types.js";
import "../server-types.js";

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

          const cleanRemoteUrl = remoteInfo.remoteUrl.replace(/\/+$/, "");
          const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
          const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
          const remoteWsUrl = `${wsUrl}/api/agent-sessions/${remoteInfo.remoteSessionId}/stream?apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;

          console.log(`[AgentWS] Proxying to remote: ${remoteWsUrl.replace(remoteInfo.remoteApiKey, "***")}`);

          const remoteWs = new WebSocket(remoteWsUrl, undefined, fastify.proxyManager.getWsOptions());

          remoteWs.on("open", () => {
            console.log(`[AgentWS] Connected to remote session ${remoteInfo.remoteSessionId}`);
          });

          remoteWs.on("message", (data) => {
            try {
              socket.send(data.toString());
            } catch (error) {
              console.error("[AgentWS] Failed to forward message to client:", error);
            }
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
            socket.send(JSON.stringify({ type: "error", message: "Remote connection error" }));
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
