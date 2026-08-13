"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Schedule, type ScheduleInput } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

/**
 * Schedules for a project. Refetches on any schedule:* SSE event for the
 * project, so run status dots and next_run_at stay live.
 *
 * `loading` reflects only the initial fetch for the current projectId;
 * background refetches (SSE events, post-mutation) update `schedules`
 * silently. `projectIdRef` and `generationRef` are updated together,
 * atomically, whenever projectId changes. Every refetch path reads the
 * *current* project + generation off those refs (never a closed-over
 * `projectId`) so a response is only applied if its generation is still
 * current — this also covers a mutation's refetch() call whose promise
 * chain started against an older project before a switch.
 */
// Page-lifetime cache of each project's schedule list — same pattern as
// use-worktrees / use-resident-sessions. A revisited project's schedules show
// instantly (sidebar section + SchedulesView) while the project-change load
// revalidates; a never-visited project seeds [] instead of showing the
// previous project's rows until the fetch lands. The generation guard below
// already discards cross-project late responses, so writes stay clean.
const scheduleListCache = new Map<string, Schedule[]>();

export function useSchedules(projectId: string | null) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);

  // Seed on project change DURING render (same pattern as useWorktrees).
  const [seededProjectId, setSeededProjectId] = useState<string | null>(null);
  if (projectId !== seededProjectId) {
    setSeededProjectId(projectId);
    setSchedules(projectId ? scheduleListCache.get(projectId) ?? [] : []);
  }

  // Write-through so the next visit to this project can seed.
  useEffect(() => {
    if (projectId) scheduleListCache.set(projectId, schedules);
  }, [projectId, schedules]);

  const projectIdRef = useRef(projectId);
  const generationRef = useRef(0);

  const load = useCallback(async (forProjectId: string | null, generation: number, showLoading: boolean) => {
    if (!forProjectId) {
      if (generationRef.current === generation) {
        setSchedules([]);
        setLoading(false);
      }
      return;
    }
    if (showLoading) setLoading(true);
    try {
      const data = await api.getSchedules(forProjectId);
      if (generationRef.current === generation) setSchedules(data);
    } catch (err) {
      console.error("Failed to fetch schedules:", err);
    } finally {
      if (showLoading && generationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    projectIdRef.current = projectId;
    generationRef.current += 1;
    void load(projectId, generationRef.current, true);
  }, [projectId, load]);

  const refetch = useCallback(async () => {
    const forProjectId = projectIdRef.current;
    if (!forProjectId) return;
    await load(forProjectId, generationRef.current, false);
  }, [load]);

  const refetchRef = useRef(refetch);

  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

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
    async (id: string, request?: { requestId: string; runId: string; sourceRunId?: string }) => {
      let resolvedRequest = request;
      if (!resolvedRequest) {
        const generatedId = crypto.randomUUID();
        resolvedRequest = { requestId: generatedId, runId: generatedId };
      }
      const result = await api.runScheduleNow(id, resolvedRequest);
      await refetch();
      return result;
    },
    [refetch]
  );

  return { schedules, loading, refetch, createSchedule, updateSchedule, deleteSchedule, runNow };
}
