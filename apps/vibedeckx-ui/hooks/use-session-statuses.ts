"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getAuthToken } from "@/lib/api";
import type { AgentSessionStatus } from "./use-agent-session";

/**
 * Drift-correction safety net for sidebar workspace status indicators.
 *
 * The primary status source is the SSE stream `/api/events` (see
 * `useGlobalEvents`). This poll exists only to repair drift if SSE missed an
 * event during a reconnect window or backend restart. Event-driven handlers in
 * `app/page.tsx` also call `refetch()` on every status event, so the interval
 * itself can be coarse.
 */
const POLL_INTERVAL_MS = 30_000;

function getApiBase(): string {
  if (typeof window === "undefined") return "";
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:5173";
  }
  return "";
}

interface SessionRecord {
  id: string;
  branch: string;
  status: AgentSessionStatus;
}

/**
 * Polls agent session statuses for a project at a coarse interval (see
 * `POLL_INTERVAL_MS`). Returns a Map<branch, AgentSessionStatus> for all
 * sessions on the project; when multiple sessions share a branch, "running"
 * takes precedence over other statuses.
 */
export function useSessionStatuses(projectId: string | null) {
  const [statuses, setStatuses] = useState<Map<string, AgentSessionStatus>>(new Map());
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchStatuses = useCallback(async () => {
    if (!projectId) {
      setStatuses(new Map());
      return;
    }

    try {
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions`, { headers });
      if (!res.ok) return;
      const data = await res.json() as { sessions: SessionRecord[] };
      const map = new Map<string, AgentSessionStatus>();
      for (const s of data.sessions) {
        if (!map.has(s.branch) || s.status === "running") {
          map.set(s.branch, s.status);
        }
      }
      setStatuses(map);
    } catch {
      // Silently ignore polling errors
    }
  }, [projectId]);

  useEffect(() => {
    fetchStatuses();

    intervalRef.current = setInterval(fetchStatuses, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchStatuses]);

  const updateStatus = useCallback((branch: string, newStatus: AgentSessionStatus) => {
    setStatuses(prev => {
      const next = new Map(prev);
      next.set(branch, newStatus);
      return next;
    });
  }, []);

  return { statuses, refetch: fetchStatuses, updateStatus };
}
