"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Schedule, type ScheduleInput } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

/**
 * Schedules for a project. Refetches on any schedule:* SSE event for the
 * project, so run status dots and next_run_at stay live.
 */
export function useSchedules(projectId: string | null) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!projectId) {
      setSchedules([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const data = await api.getSchedules(projectId);
      setSchedules(data);
    } catch (err) {
      console.error("Failed to fetch schedules:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const projectIdRef = useRef(projectId);
  const refetchRef = useRef(refetch);

  useEffect(() => {
    projectIdRef.current = projectId;
    refetchRef.current = refetch;
  }, [projectId, refetch]);

  useGlobalEventStream((raw) => {
    const data = raw as { type?: string; projectId?: string };
    if (!data.type?.startsWith("schedule:")) return;
    if (!projectIdRef.current || data.projectId !== projectIdRef.current) return;
    void refetchRef.current();
  });

  const createSchedule = useCallback(
    async (opts: ScheduleInput) => {
      if (!projectId) throw new Error("No project selected");
      const created = await api.createSchedule(projectId, opts);
      await refetch();
      return created;
    },
    [projectId, refetch]
  );

  const updateSchedule = useCallback(
    async (id: string, opts: Partial<ScheduleInput>) => {
      const updated = await api.updateSchedule(id, opts);
      await refetch();
      return updated;
    },
    [refetch]
  );

  const deleteSchedule = useCallback(
    async (id: string) => {
      await api.deleteSchedule(id);
      await refetch();
    },
    [refetch]
  );

  const runNow = useCallback(
    async (id: string) => {
      const result = await api.runScheduleNow(id);
      await refetch();
      return result;
    },
    [refetch]
  );

  return { schedules, loading, refetch, createSchedule, updateSchedule, deleteSchedule, runNow };
}
