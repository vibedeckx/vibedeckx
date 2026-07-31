"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ProjectActivity } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

export const PROJECT_ACTIVITY_REFRESH_DELAY_MS = 100;

export interface UseProjectActivityResult {
  activity: ProjectActivity | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useProjectActivity(projectId: string | null): UseProjectActivityResult {
  const [activity, setActivity] = useState<ProjectActivity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectIdRef = useRef(projectId);
  const generationRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (
    targetProjectId: string,
    generation: number,
    showLoading: boolean,
  ) => {
    if (showLoading) setLoading(true);
    try {
      const next = await api.getProjectActivity(targetProjectId);
      if (generationRef.current !== generation || projectIdRef.current !== targetProjectId) return;
      setActivity(next);
      setError(null);
    } catch (reason) {
      if (generationRef.current !== generation || projectIdRef.current !== targetProjectId) return;
      setError(reason instanceof Error ? reason.message : "Failed to fetch project activity");
    } finally {
      if (showLoading && generationRef.current === generation && projectIdRef.current === targetProjectId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    projectIdRef.current = projectId;
    generationRef.current += 1;
    const generation = generationRef.current;
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    if (!projectId) {
      setActivity(null);
      setLoading(false);
      setError(null);
      return;
    }

    setActivity(null);
    setError(null);
    void load(projectId, generation, true);

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [load, projectId]);

  const refetch = useCallback(async () => {
    const targetProjectId = projectIdRef.current;
    if (!targetProjectId) return;
    await load(targetProjectId, generationRef.current, false);
  }, [load]);

  const refetchRef = useRef(refetch);
  useEffect(() => { refetchRef.current = refetch; }, [refetch]);

  useGlobalEventStream((raw) => {
    const event = raw as { type?: string; projectId?: string };
    if (!event.type || !/^(session|schedule|task):/.test(event.type)) return;
    if (!projectIdRef.current || event.projectId !== projectIdRef.current) return;
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refetchRef.current();
    }, PROJECT_ACTIVITY_REFRESH_DELAY_MS);
  });

  return { activity, loading, error, refetch };
}
