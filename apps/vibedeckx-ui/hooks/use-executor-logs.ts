"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getWebSocketUrl, type LogMessage, type InputMessage } from "@/lib/api";

export type ConnectionStatus = "connecting" | "connected" | "closed" | "error";

export interface UseExecutorLogsResult {
  logs: LogMessage[];
  status: ConnectionStatus;
  exitCode: number | null;
  isPty: boolean;
  clearLogs: () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

export function useExecutorLogs(processId: string | null): UseExecutorLogsResult {
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isPty, setIsPty] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);

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
      setStatus("closed");
      return;
    }

    // Reset state for new process
    setLogs([]);
    setExitCode(null);
    setIsPty(false);
    setStatus("connecting");

    const wsUrl = getWebSocketUrl(`/api/executor-processes/${processId}/logs`);
    console.log(`[useExecutorLogs] Connecting to WebSocket: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[useExecutorLogs] WebSocket connected`);
      setStatus("connected");

      // Send any resize that was queued before the connection opened
      if (pendingResizeRef.current) {
        const { cols, rows } = pendingResizeRef.current;
        const message: InputMessage = { type: "resize", cols, rows };
        ws.send(JSON.stringify(message));
        pendingResizeRef.current = null;
      }
    };

    ws.onmessage = (event) => {
      console.log(`[useExecutorLogs] Received message:`, event.data);
      try {
        const msg: LogMessage = JSON.parse(event.data);

        if (msg.type === "init") {
          setIsPty(msg.isPty);
        } else if (msg.type === "finished") {
          setExitCode(msg.exitCode);
          setStatus("closed");
        } else if (msg.type === "error") {
          setStatus("error");
        } else {
          setLogs((prev) => [...prev, msg]);
        }
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error(`[useExecutorLogs] WebSocket error:`, error);
      setStatus("error");
    };

    ws.onclose = (event) => {
      console.log(`[useExecutorLogs] WebSocket closed:`, event.code, event.reason);
      if (status !== "error") {
        setStatus("closed");
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [processId]);

  return { logs, status, exitCode, isPty, clearLogs, sendInput, sendResize };
}
