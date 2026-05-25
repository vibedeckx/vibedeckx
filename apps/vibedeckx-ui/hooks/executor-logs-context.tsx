"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { getWebSocketUrl, type LogMessage, type MuxClientMessage, type MuxServerMessage } from "@/lib/api";
import type { ConnectionStatus } from "./use-executor-logs";

const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

export interface ProcessLogState {
  logs: LogMessage[];
  status: ConnectionStatus;
  exitCode: number | null;
  isPty: boolean;
  replayingHistory: boolean;
}

// 模块级常量：未订阅进程的稳定快照（useSyncExternalStore 要求引用稳定）
const EMPTY_STATE: ProcessLogState = {
  logs: [],
  status: "connecting",
  exitCode: null,
  isPty: false,
  replayingHistory: true,
};

export interface ExecutorLogsStore {
  subscribeProcess: (processId: string) => void;
  unsubscribeProcess: (processId: string) => void;
  sendInput: (processId: string, data: string) => void;
  sendResize: (processId: string, cols: number, rows: number) => void;
  /** useSyncExternalStore：订阅某进程状态变化，返回注销函数 */
  onProcessChange: (processId: string, cb: () => void) => () => void;
  /** useSyncExternalStore：读取某进程当前状态（引用稳定，仅在变更时换新对象） */
  getProcessState: (processId: string) => ProcessLogState;
}

const ExecutorLogsContext = createContext<ExecutorLogsStore | null>(null);

export function useExecutorLogsStore(): ExecutorLogsStore {
  const ctx = useContext(ExecutorLogsContext);
  if (!ctx) throw new Error("useExecutorLogsStore must be used within ExecutorLogsProvider");
  return ctx;
}

export function ExecutorLogsProvider({
  projectId,
  children,
}: {
  projectId: string | null;
  children: ReactNode;
}) {
  const statesRef = useRef(new Map<string, ProcessLogState>());
  const listenersRef = useRef(new Map<string, Set<() => void>>());
  // 当前期望订阅的进程集合（重连后据此重新 subscribe）
  const desiredRef = useRef(new Set<string>());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((processId: string) => {
    listenersRef.current.get(processId)?.forEach((cb) => cb());
  }, []);

  // 不可变更新：换新对象，保证 useSyncExternalStore 引用稳定
  const update = useCallback((processId: string, patch: Partial<ProcessLogState>) => {
    const prev = statesRef.current.get(processId) ?? EMPTY_STATE;
    statesRef.current.set(processId, { ...prev, ...patch });
    notify(processId);
  }, [notify]);

  const sendRaw = useCallback((msg: MuxClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const applyServerMessage = useCallback((m: MuxServerMessage) => {
    const { processId } = m;
    if (m.type === "init") {
      update(processId, { isPty: m.isPty, replayingHistory: true, logs: [], status: "connected" });
    } else if (m.type === "history_end") {
      update(processId, { replayingHistory: false });
    } else if (m.type === "finished") {
      update(processId, { exitCode: m.exitCode, status: "closed" });
    } else if (m.type === "error") {
      update(processId, { status: "error" });
    } else {
      const prev = statesRef.current.get(processId) ?? EMPTY_STATE;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { processId: _omit, ...logMsg } = m;
      update(processId, { logs: [...prev.logs, logMsg as LogMessage] });
    }
  }, [update]);

  // 连接：projectId 变化时重建（整段连接 + 重连逻辑都在 effect 内）
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    reconnectAttemptRef.current = 0;

    const connect = () => {
      if (cancelled) return;
      const wsUrl = getWebSocketUrl(`/api/executor-logs/stream?projectId=${encodeURIComponent(projectId)}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        reconnectAttemptRef.current = 0;
        // 重连后重新订阅所有期望进程
        for (const pid of desiredRef.current) {
          ws.send(JSON.stringify({ type: "subscribe", processId: pid } satisfies MuxClientMessage));
        }
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          applyServerMessage(JSON.parse(event.data) as MuxServerMessage);
        } catch (error) {
          console.error("[ExecutorLogs] parse error:", error);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (cancelled) return;
        if (reconnectAttemptRef.current < RECONNECT_MAX_ATTEMPTS) {
          const attempt = reconnectAttemptRef.current++;
          const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
          const totalDelay = delay + delay * Math.random() * 0.25;
          for (const pid of desiredRef.current) update(pid, { status: "connecting" });
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!cancelled) connect();
          }, totalDelay);
        } else {
          for (const pid of desiredRef.current) update(pid, { status: "error" });
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [projectId, applyServerMessage, update]);

  // 稳定的 store（依赖均引用稳定 → store 身份稳定，避免消费者重订阅抖动）
  const store = useMemo<ExecutorLogsStore>(() => ({
    subscribeProcess: (processId) => {
      if (desiredRef.current.has(processId)) return; // 幂等
      desiredRef.current.add(processId);
      // 新订阅前重置该进程状态
      statesRef.current.set(processId, { ...EMPTY_STATE });
      notify(processId);
      sendRaw({ type: "subscribe", processId });
    },
    unsubscribeProcess: (processId) => {
      if (!desiredRef.current.has(processId)) return;
      desiredRef.current.delete(processId);
      sendRaw({ type: "unsubscribe", processId });
      // 保留 state（收起/展开不丢历史），只停止接收
    },
    sendInput: (processId, data) => sendRaw({ type: "input", processId, data }),
    sendResize: (processId, cols, rows) => sendRaw({ type: "resize", processId, cols, rows }),
    onProcessChange: (processId, cb) => {
      let set = listenersRef.current.get(processId);
      if (!set) { set = new Set(); listenersRef.current.set(processId, set); }
      set.add(cb);
      return () => { set?.delete(cb); };
    },
    getProcessState: (processId) => statesRef.current.get(processId) ?? EMPTY_STATE,
  }), [notify, sendRaw]);

  return <ExecutorLogsContext.Provider value={store}>{children}</ExecutorLogsContext.Provider>;
}
