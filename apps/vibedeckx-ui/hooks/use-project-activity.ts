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
  const requestEpochRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEventRefreshRef = useRef(false);
  const activeRequestRef = useRef<{
    generation: number;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);

  const load = useCallback(async function executeLoad(
    targetProjectId: string,
    generation: number,
    showLoading: boolean,
    replaceActive: boolean,
  ): Promise<void> {
    if (replaceActive) {
      pendingEventRefreshRef.current = false;
      activeRequestRef.current?.controller.abort();
    } else if (activeRequestRef.current?.generation === generation) {
      pendingEventRefreshRef.current = true;
      return activeRequestRef.current.promise;
    }

    const controller = new AbortController();
    const epoch = ++requestEpochRef.current;
    if (showLoading) setLoading(true);
    const promise = (async () => {
      try {
        const next = await api.getProjectActivity(targetProjectId, { signal: controller.signal });
        if (generationRef.current !== generation || projectIdRef.current !== targetProjectId
          || requestEpochRef.current !== epoch) return;
        setActivity(next);
        setError(null);
      } catch (reason) {
        if (controller.signal.aborted || generationRef.current !== generation
          || projectIdRef.current !== targetProjectId || requestEpochRef.current !== epoch) return;
        setError(reason instanceof Error ? reason.message : "Failed to fetch project activity");
      } finally {
        if (activeRequestRef.current?.controller !== controller) return;
        activeRequestRef.current = null;
        if (generationRef.current !== generation || projectIdRef.current !== targetProjectId) return;
        setLoading(false);
        if (pendingEventRefreshRef.current) {
          pendingEventRefreshRef.current = false;
          void executeLoad(targetProjectId, generation, false, false);
        }
      }
    })();
    activeRequestRef.current = { generation, controller, promise };
    return promise;
  }, []);

  useEffect(() => {
    projectIdRef.current = projectId;
    generationRef.current += 1;
    requestEpochRef.current += 1;
    const generation = generationRef.current;
    activeRequestRef.current?.controller.abort();
    activeRequestRef.current = null;
    pendingEventRefreshRef.current = false;
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
    void load(projectId, generation, true, false);

    return () => {
      if (generationRef.current === generation) {
        generationRef.current += 1;
        requestEpochRef.current += 1;
      }
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      pendingEventRefreshRef.current = false;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [load, projectId]);

  const refetch = useCallback(async () => {
    const targetProjectId = projectIdRef.current;
    if (!targetProjectId) return;
    await load(targetProjectId, generationRef.current, false, true);
  }, [load]);

  useGlobalEventStream((raw) => {
    const event = raw as { type?: string; projectId?: string };
    if (!event.type || !/^(session|schedule|task):/.test(event.type)) return;
    if (!projectIdRef.current || event.projectId !== projectIdRef.current) return;
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      const targetProjectId = projectIdRef.current;
      if (!targetProjectId) return;
      void load(targetProjectId, generationRef.current, false, false);
    }, PROJECT_ACTIVITY_REFRESH_DELAY_MS);
  });

  return { activity, loading, error, refetch };
}
