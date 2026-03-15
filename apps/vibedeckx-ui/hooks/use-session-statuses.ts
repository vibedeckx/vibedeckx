"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getAuthToken } from "@/lib/api";
import type { AgentSessionStatus } from "./use-agent-session";

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
 * Polls agent session statuses for a project every 5 seconds.
 * Returns a Map<branch, AgentSessionStatus> for all sessions with status "running".
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

    intervalRef.current = setInterval(fetchStatuses, 5000);

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
