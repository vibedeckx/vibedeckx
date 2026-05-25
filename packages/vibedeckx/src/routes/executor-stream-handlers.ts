import type { FastifyInstance } from "fastify";
import type { LogMessage, InputMessage } from "../process-manager.js";

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
