"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getWebSocketUrl, type LogMessage, type InputMessage } from "@/lib/api";

export type ConnectionStatus = "connecting" | "connected" | "closed" | "error";

const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

export interface UseExecutorLogsResult {
  logs: LogMessage[];
  status: ConnectionStatus;
  exitCode: number | null;
  isPty: boolean;
  replayingHistory: boolean;
  clearLogs: () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

export function useExecutorLogs(processId: string | null, resetKey?: string): UseExecutorLogsResult {
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isPty, setIsPty] = useState<boolean>(false);
  const [replayingHistory, setReplayingHistory] = useState<boolean>(true);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(false);

  const clearLogs = useCallback(() => {
    setLogs([]);
    setExitCode(null);
    setIsPty(false);
  }, []);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: InputMessage = { type: "input", data };
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: InputMessage = { type: "resize", cols, rows };
      wsRef.current.send(JSON.stringify(message));
    } else {
      // Queue resize for when WebSocket connects — FitAddon often
      // calculates dimensions before the connection is established
      pendingResizeRef.current = { cols, rows };
    }
  }, []);

  useEffect(() => {
    if (!processId) {
      // Don't clear logs — keep previous output visible until next run
      return;
    }

    // Reset state for new process
    setLogs([]);
    setExitCode(null);
    setIsPty(false);
    finishedRef.current = false;
    reconnectAttemptRef.current = 0;

    // Per-effect cancellation flag — avoids stale reconnections when processId changes
    let cancelled = false;

    function connect() {
      if (cancelled || finishedRef.current) return;

      setStatus("connecting");

      const wsUrl = getWebSocketUrl(`/api/executor-processes/${processId}/logs`);
      console.log(`[useExecutorLogs] Connecting to WebSocket: ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Per-connection liveness tracking. We only reset the reconnect attempt
      // counter once the server proves it has a live stream by sending data
      // beyond history replay. Resetting on `open` alone caused infinite
      // reconnects when the server kept closing immediately after history_end.
      let receivedLiveData = false;
      let historyEnded = false;

      ws.onopen = () => {
        if (cancelled) return;
        console.log(`[useExecutorLogs] WebSocket connected`);
        setStatus("connected");

        // Clear stale logs before historical replay to prevent duplicates
        setLogs([]);

        // Send any resize that was queued before the connection opened
        if (pendingResizeRef.current) {
          const { cols, rows } = pendingResizeRef.current;
          const message: InputMessage = { type: "resize", cols, rows };
          ws.send(JSON.stringify(message));
          pendingResizeRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg: LogMessage = JSON.parse(event.data);

          if (msg.type === "init") {
            setIsPty(msg.isPty);
            setReplayingHistory(true);
            console.log(`[useExecutorLogs] init received, setReplayingHistory(true)`);
          } else if (msg.type === "history_end") {
            historyEnded = true;
            setReplayingHistory(false);
            console.log(`[useExecutorLogs] history_end received, setReplayingHistory(false)`);
          } else if (msg.type === "finished") {
            finishedRef.current = true;
            setExitCode(msg.exitCode);
            setStatus("closed");
          } else if (msg.type === "error") {
            // Treat error as terminal — the server is telling us there's nothing
            // to stream (e.g. remote process purged). Without this, onclose
            // would trigger an endless reconnect loop.
            finishedRef.current = true;
            setStatus("error");
          } else {
            // Real log content — proves the server has a live stream worth
            // reconnecting to. Safe to reset the reconnect counter now.
            if (historyEnded) {
              receivedLiveData = true;
              reconnectAttemptRef.current = 0;
            }
            setLogs((prev) => [...prev, msg]);
          }
        } catch (error) {
          console.error("Failed to parse WebSocket message:", error);
        }
      };

      ws.onerror = (error) => {
        if (cancelled) return;
        console.error(`[useExecutorLogs] WebSocket error:`, error);
      };

      ws.onclose = (event) => {
        console.log(`[useExecutorLogs] WebSocket closed:`, event.code, event.reason);
        wsRef.current = null;

        // Don't reconnect if the process finished normally, component unmounted,
        // or this is a local process (reconnection only helps remote terminals
        // where the process survives independently)
        if (finishedRef.current || cancelled || !processId?.startsWith("remote-")) {
          setStatus("closed");
          return;
        }

        // Server replayed history then closed without ever streaming live data.
        // It has nothing more to give us — treat as terminal instead of looping.
        if (historyEnded && !receivedLiveData) {
          console.log(`[useExecutorLogs] Server closed after history with no live data — treating as terminal`);
          finishedRef.current = true;
          setStatus("closed");
          return;
        }

        // Attempt reconnection for remote terminals
        if (reconnectAttemptRef.current < RECONNECT_MAX_ATTEMPTS) {
          const attempt = reconnectAttemptRef.current;
          const delay = Math.min(
            RECONNECT_MAX_DELAY_MS,
            RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt)
          );
          const jitter = delay * Math.random() * 0.25;
          const totalDelay = delay + jitter;

          console.log(
            `[useExecutorLogs] Scheduling reconnect in ${Math.round(totalDelay)}ms (attempt ${attempt + 1}/${RECONNECT_MAX_ATTEMPTS})`
          );
          setStatus("connecting");
          reconnectAttemptRef.current = attempt + 1;

          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!cancelled) connect();
          }, totalDelay);
        } else {
          console.log(`[useExecutorLogs] Max reconnect attempts reached`);
          setStatus("error");
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [processId, resetKey]);

  return { logs, status, exitCode, isPty, replayingHistory, clearLogs, sendInput, sendResize };
}
