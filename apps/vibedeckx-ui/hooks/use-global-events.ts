"use client";

import { useEffect, useRef } from "react";
import { getAuthToken } from "@/lib/api";

function getApiBase(): string {
  if (typeof window === "undefined") return "";
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:5173";
  }
  return "";
}

type SessionStatusEvent = {
  type: "session:status";
  projectId: string;
  branch: string | null;
  sessionId: string;
  status: "running" | "stopped" | "error";
};

type SessionFinishedEvent = {
  type: "session:finished";
  projectId: string;
  branch: string | null;
  sessionId: string;
};

type TaskChangedEvent = {
  type: "task:created" | "task:updated" | "task:deleted";
  projectId: string;
};

type GlobalEvent = SessionStatusEvent | SessionFinishedEvent | TaskChangedEvent;

interface UseGlobalEventsOptions {
  onSessionStatus?: (branch: string | null, status: "running" | "stopped" | "error") => void;
  onSessionFinished?: (branch: string | null) => void;
  onTaskChanged?: () => void;
}

export function useGlobalEvents(
  projectId: string | null,
  options: UseGlobalEventsOptions
) {
  const onSessionStatusRef = useRef(options.onSessionStatus);
  const onSessionFinishedRef = useRef(options.onSessionFinished);
  const onTaskChangedRef = useRef(options.onTaskChanged);

  // Keep refs in sync
  useEffect(() => {
    onSessionStatusRef.current = options.onSessionStatus;
    onSessionFinishedRef.current = options.onSessionFinished;
    onTaskChangedRef.current = options.onTaskChanged;
  });

  useEffect(() => {
    if (!projectId) return;

    const token = getAuthToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `${getApiBase()}/api/events${tokenParam}`;
    const es = new EventSource(url);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as GlobalEvent;

        // Filter to current project
        if (data.projectId !== projectId) return;

        if (data.type === "session:status") {
          onSessionStatusRef.current?.(data.branch, data.status);
        } else if (data.type === "session:finished") {
          onSessionFinishedRef.current?.(data.branch);
        } else if (
          data.type === "task:created" ||
          data.type === "task:updated" ||
          data.type === "task:deleted"
        ) {
          onTaskChangedRef.current?.();
        }
      } catch {
        // Ignore parse errors (e.g. keepalive comments)
      }
    };

    return () => {
      es.close();
    };
  }, [projectId]);
}
