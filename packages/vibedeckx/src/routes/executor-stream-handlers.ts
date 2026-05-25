import { randomUUID } from "crypto";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { LogMessage, InputMessage } from "../process-manager.js";
import { VirtualWsAdapter } from "../virtual-ws-adapter.js";

// Re-export so callers can import from this module if preferred.
export type { LogMessage, InputMessage };

// Wider message type that includes synthetic protocol messages sent by the
// stream handler in addition to the raw LogMessages from processManager.
export type StreamMessage =
  | LogMessage
  | { type: "init"; isPty: boolean }
  | { type: "history_end" }
  | { type: "error"; message: string };

export interface ProcessStreamHandle {
  /** 停止该进程的流（取消订阅 / 关闭上游）。可安全多次调用。 */
  cleanup: () => void;
  /** 把 input/resize 路由到该进程。 */
  handleInput: (msg: InputMessage) => void;
}

/**
 * 把单个本地进程的 init → 历史回放 → history_end → 实时流接到 send 回调。
 * - send：投递一条 StreamMessage（调用方决定是否包 processId / 是否在 finished 时关 socket）。
 * - onTerminal：该进程流终止时恰好调用一次（无更多数据可来）。
 */
export function attachLocalProcessStream(
  fastify: FastifyInstance,
  processId: string,
  send: (msg: StreamMessage) => void,
  onTerminal: () => void,
): ProcessStreamHandle {
  const noop: ProcessStreamHandle = { cleanup: () => {}, handleInput: () => {} };

  const isPty = fastify.processManager.isPtyProcess(processId);
  send({ type: "init", isPty });

  const logs = fastify.processManager.getLogs(processId);
  for (const log of logs) send(log);
  send({ type: "history_end" });

  const isRunning = fastify.processManager.isRunning(processId);

  if (logs.length === 0 && !isRunning) {
    send({ type: "error", message: "Process not found" });
    send({ type: "finished", exitCode: null });
    onTerminal();
    return noop;
  }

  const lastLog = logs[logs.length - 1];
  if (lastLog?.type === "finished") {
    onTerminal();
    return noop;
  }

  const unsubscribe = fastify.processManager.subscribe(processId, (msg: LogMessage) => {
    send(msg);
    if (msg.type === "finished") onTerminal();
  });

  return {
    cleanup: () => unsubscribe?.(),
    handleInput: (msg) => fastify.processManager.handleInput(processId, msg),
  };
}

/**
 * 把单个远程进程（remote- 前缀）的流通过后端代理接到 send 回调。
 * 复用现有代理逻辑：reverse-connect 虚拟通道 / 直连上游 WS、ping 保活、
 * finished 时清理 remoteExecutorMap + markFinished + emit executor:stopped、
 * 上游关闭无终止信号时补发 finished。
 */
export function attachRemoteProcessStream(
  fastify: FastifyInstance,
  processId: string,
  send: (msg: StreamMessage) => void,
  onTerminal: () => void,
): ProcessStreamHandle {
  const noop: ProcessStreamHandle = { cleanup: () => {}, handleInput: () => {} };

  let remoteInfo = fastify.remoteExecutorMap.get(processId);
  if (!remoteInfo) {
    const row = fastify.storage.remoteExecutorProcesses.getById(processId);
    if (row) {
      remoteInfo = {
        remoteServerId: row.remote_server_id,
        remoteUrl: row.remote_url,
        remoteApiKey: row.remote_api_key,
        remoteProcessId: row.remote_process_id,
        executorId: row.executor_id,
        projectId: row.project_id ?? undefined,
        branch: row.branch,
        stoppedEmitted: row.status !== "running",
      };
    }
  }
  if (!remoteInfo) {
    send({ type: "error", message: "Remote process not found" });
    onTerminal();
    return noop;
  }
  const info = remoteInfo;

  const useVirtualExec = fastify.reverseConnectManager.isConnected(info.remoteServerId);
  let remoteWs: WebSocket | VirtualWsAdapter;

  if (useVirtualExec) {
    const channelId = randomUUID();
    const wsPath = `/api/executor-processes/${info.remoteProcessId}/logs`;
    const wsQuery = `apiKey=${encodeURIComponent(info.remoteApiKey)}`;
    const adapter = new VirtualWsAdapter(
      (data) => fastify.reverseConnectManager.sendChannelData(info.remoteServerId, channelId, data),
      () => fastify.reverseConnectManager.closeChannel(info.remoteServerId, channelId),
    );
    fastify.reverseConnectManager.setChannelAdapter(info.remoteServerId, channelId, adapter);
    fastify.reverseConnectManager.openVirtualChannel(info.remoteServerId, channelId, wsPath, wsQuery);
    remoteWs = adapter;
    setTimeout(() => adapter.emit("open"), 0);
  } else {
    if (!info.remoteUrl) {
      send({ type: "error", message: "Remote server not reachable (reverse-connect offline)" });
      onTerminal();
      return noop;
    }
    const cleanRemoteUrl = info.remoteUrl.replace(/\/+$/, "");
    const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
    const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
    const remoteWsUrl = `${wsUrl}/api/executor-processes/${info.remoteProcessId}/logs?apiKey=${encodeURIComponent(info.remoteApiKey)}`;
    remoteWs = new WebSocket(remoteWsUrl, undefined, fastify.proxyManager.getWsOptions());
  }

  const pingInterval = setInterval(() => {
    if (remoteWs.readyState === WebSocket.OPEN) remoteWs.ping();
  }, 30000);

  let terminalSignalSent = false;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(pingInterval);
    try { remoteWs.close(); } catch { /* ignore */ }
  };

  remoteWs.on("message", (data: Buffer | string) => {
    try {
      const raw = data.toString();
      let parsed: StreamMessage | null = null;
      try { parsed = JSON.parse(raw) as StreamMessage; } catch { /* non-JSON, ignore */ }
      if (!parsed) return;
      send(parsed);

      if (parsed.type === "finished" || parsed.type === "error") terminalSignalSent = true;
      if (parsed.type === "finished") {
        const live = fastify.remoteExecutorMap.get(processId);
        if (live && !live.stoppedEmitted) {
          live.stoppedEmitted = true;
          fastify.eventBus.emit({
            type: "executor:stopped",
            projectId: live.projectId ?? "",
            executorId: live.executorId,
            processId,
            exitCode: parsed.exitCode ?? 0,
            target: live.remoteServerId,
          });
        }
        if (live) {
          fastify.remoteExecutorMap.delete(processId);
          fastify.storage.remoteExecutorProcesses.markFinished(
            processId,
            typeof parsed.exitCode === "number" ? parsed.exitCode : 0,
          );
        }
        onTerminal();
      }
      if (parsed.type === "error") onTerminal();
    } catch (error) {
      console.error("[ExecutorStream] Failed to forward remote message:", error);
    }
  });

  remoteWs.on("error", (error: unknown) => {
    clearInterval(pingInterval);
    console.error(`[ExecutorStream] Remote connection error:`, error);
    if (!terminalSignalSent) {
      send({ type: "error", message: "Remote connection error" });
      terminalSignalSent = true;
    }
    onTerminal();
  });

  remoteWs.on("close", () => {
    clearInterval(pingInterval);
    if (!terminalSignalSent) {
      const row = fastify.storage.remoteExecutorProcesses.getById(processId);
      send({ type: "finished", exitCode: row?.exit_code ?? 0 });
      terminalSignalSent = true;
    }
    onTerminal();
  });

  return {
    cleanup,
    handleInput: (msg) => {
      try {
        if (remoteWs.readyState === WebSocket.OPEN) remoteWs.send(JSON.stringify(msg));
      } catch (error) {
        console.error("[ExecutorStream] Failed to forward input to remote:", error);
      }
    },
  };
}
