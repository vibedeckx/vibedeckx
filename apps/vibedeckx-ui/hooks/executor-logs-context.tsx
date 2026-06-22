"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { getWebSocketUrl, getFreshToken, type LogMessage, type MuxClientMessage, type MuxServerMessage } from "@/lib/api";
import type { ConnectionStatus } from "./use-executor-logs";
import type { UseExecutorLogsResult } from "./use-executor-logs";

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
    // [diag:mux] 临时诊断：打印每条收到的 mux 帧（init/输出/history_end/finished/error）
    const detail =
      m.type === "error" ? m.message
      : m.type === "finished" ? `exitCode=${m.exitCode}`
      : m.type === "init" ? `isPty=${m.isPty}`
      : m.type === "history_end" ? ""
      : `${m.data.length}b`;
    console.log("[diag:mux] recv", m.type, processId, detail);
    if (m.type === "init") {
      update(processId, { isPty: m.isPty, replayingHistory: true, logs: [], status: "connected" });
    } else if (m.type === "history_end") {
      update(processId, { replayingHistory: false });
    } else if (m.type === "finished") {
      console.log(`[diag:remote-stop] ${new Date().toISOString()} mux received FINISHED processId=${processId} exitCode=${m.exitCode} — will trigger markProcessFinished → button flips to Start`);
      update(processId, { exitCode: m.exitCode, status: "closed" });
    } else if (m.type === "error") {
      console.log(`[diag:remote-stop] ${new Date().toISOString()} mux received ERROR processId=${processId} — status=error, does NOT flip isRunning`);
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

    const openSocket = () => {
      if (cancelled) return;
      const wsUrl = getWebSocketUrl(`/api/executor-logs/stream?projectId=${encodeURIComponent(projectId)}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        reconnectAttemptRef.current = 0;
        // [diag:mux] WS 新连接/重连建立 —— 若“空”发生在这之后，是 WS 重连；若没有这条，则是旧连接上的重订阅
        console.log("[diag:mux] WS open, resubscribing", [...desiredRef.current]);
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
        console.log("[diag:mux] WS close, reconnectAttempt=", reconnectAttemptRef.current, "cancelled=", cancelled);
        if (cancelled) return;
        // 已终止的进程（closed/error）不因连接断开而被改写状态
        const isTerminal = (pid: string) => {
          const s = statesRef.current.get(pid);
          return s?.status === "closed" || s?.status === "error";
        };
        if (reconnectAttemptRef.current < RECONNECT_MAX_ATTEMPTS) {
          const attempt = reconnectAttemptRef.current++;
          const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
          const totalDelay = delay + delay * Math.random() * 0.25;
          for (const pid of desiredRef.current) {
            if (!isTerminal(pid)) update(pid, { status: "connecting" });
          }
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!cancelled) connect();
          }, totalDelay);
        } else {
          for (const pid of desiredRef.current) {
            if (!isTerminal(pid)) update(pid, { status: "error" });
          }
        }
      };
    };

    // Token-refreshing entry point: every (re)connect first fetches a
    // guaranteed-valid token (cache-hit = no network) so the WS upgrade never
    // carries an expired JWT in its query string.
    const connect = () => {
      if (cancelled) return;
      void getFreshToken().then(() => {
        if (!cancelled) openSocket();
      });
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
      console.log("[diag:mux] send subscribe", processId, "(state reset to EMPTY)");
      sendRaw({ type: "subscribe", processId });
    },
    unsubscribeProcess: (processId) => {
      if (!desiredRef.current.has(processId)) return;
      desiredRef.current.delete(processId);
      console.log("[diag:mux] send unsubscribe", processId);
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

/**
 * Selector hook: reads a single process's log state from the multiplexed store.
 * Signature/return value matches the old useExecutorLogs, for drop-in use in ExecutorItem.
 * Must be used inside <ExecutorLogsProvider>.
 */
export function useExecutorProcessLogs(
  processId: string | null,
  resetKey?: string,
): UseExecutorLogsResult {
  const store = useExecutorLogsStore();

  const subscribe = useCallback(
    (cb: () => void) => {
      if (!processId) return () => {};
      store.subscribeProcess(processId);
      const off = store.onProcessChange(processId, cb);
      return () => {
        off();
        store.unsubscribeProcess(processId);
      };
    },
    // resetKey (executorMode) change triggers re-subscription
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [processId, resetKey, store],
  );

  const getSnapshot = useCallback(
    () => (processId ? store.getProcessState(processId) : null),
    [processId, store],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const clearLogs = useCallback(() => {}, []); // store resets logs on re-subscription

  const sendInput = useCallback(
    (data: string) => { if (processId) store.sendInput(processId, data); },
    [processId, store],
  );
  const sendResize = useCallback(
    (cols: number, rows: number) => { if (processId) store.sendResize(processId, cols, rows); },
    [processId, store],
  );

  return {
    logs: state?.logs ?? [],
    status: state?.status ?? "closed",
    exitCode: state?.exitCode ?? null,
    isPty: state?.isPty ?? false,
    replayingHistory: state?.replayingHistory ?? true,
    clearLogs,
    sendInput,
    sendResize,
  };
}
