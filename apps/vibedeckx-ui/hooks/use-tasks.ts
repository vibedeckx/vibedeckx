"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Task, type TaskStatus, type TaskPriority } from "@/lib/api";

// Page-lifetime cache of each project's task list — same pattern as
// use-schedules / use-worktrees. A revisited project's tasks show instantly
// (sidebar Tasks section + TasksView) while the project-change load
// revalidates; a never-visited project seeds [] instead of showing the
// previous project's rows until the fetch lands.
const taskListCache = new Map<string, Task[]>();

export function useTasks(projectId: string | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  // Seed on project change DURING render (same pattern as useSchedules), so
  // the first render for the new project never paints the old one's tasks.
  const [seededProjectId, setSeededProjectId] = useState<string | null>(null);
  if (projectId !== seededProjectId) {
    setSeededProjectId(projectId);
    const cached = projectId ? taskListCache.get(projectId) : undefined;
    setTasks(cached ?? []);
    // Only a cold project shows "Loading tasks..."; a cached one stays visible
    // while it revalidates.
    setLoading(!!projectId && !cached);
  }

  // Write-through so the next visit to this project can seed. Only a project
  // whose list has loaded at least once has an entry (see load): the seed's
  // placeholder [] must not pass as "cached" and suppress the loading state.
  useEffect(() => {
    if (projectId && taskListCache.has(projectId)) taskListCache.set(projectId, tasks);
  }, [projectId, tasks]);

  // `projectIdRef` and `generationRef` change together on every project
  // switch. Every load reads them instead of a closed-over projectId, so a
  // response (including a refetch() started before the switch) is applied
  // only if its generation is still current.
  const projectIdRef = useRef(projectId);
  const generationRef = useRef(0);

  const load = useCallback(async (forProjectId: string | null, generation: number) => {
    if (!forProjectId) {
      if (generationRef.current === generation) setLoading(false);
      return;
    }
    try {
      const data = await api.getTasks(forProjectId, { includeArchived: true });
      // Real data for that project even if the user has switched away.
      taskListCache.set(forProjectId, data);
      if (generationRef.current === generation) setTasks(data);
    } catch (error) {
      console.error("Failed to fetch tasks:", error);
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    projectIdRef.current = projectId;
    generationRef.current += 1;
    void load(projectId, generationRef.current);
  }, [projectId, load]);

  const fetchTasks = useCallback(async () => {
    await load(projectIdRef.current, generationRef.current);
  }, [load]);

  /** Whether a mutation started on `forProjectId` may still write state. */
  const stillOn = (forProjectId: string | null) => projectIdRef.current === forProjectId;

  const createTask = useCallback(
    async (opts: { title?: string; description: string; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null; parent_id?: string | null }) => {
      if (!projectId) return null;

      try {
        const task = await api.createTask(projectId, opts);
        if (stillOn(projectId)) setTasks((prev) => [...prev, task]);
        return task;
      } catch (error) {
        console.error("Failed to create task:", error);
        return null;
      }
    },
    [projectId]
  );

  const updateTask = useCallback(
    async (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null; parent_id?: string | null }) => {
      // Optimistic update
      const forProjectId = projectIdRef.current;
      const previousTasks = tasks;
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...opts, updated_at: new Date().toISOString() } : t))
      );

      try {
        const task = await api.updateTask(id, opts);
        if (stillOn(forProjectId)) setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
        return task;
      } catch (error) {
        console.error("Failed to update task:", error);
        if (stillOn(forProjectId)) setTasks(previousTasks);
        return null;
      }
    },
    [tasks]
  );

  const deleteTask = useCallback(async (id: string) => {
    const forProjectId = projectIdRef.current;
    const previousTasks = tasks;
    setTasks((prev) => prev.filter((t) => t.id !== id));

    try {
      await api.deleteTask(id);
    } catch (error) {
      console.error("Failed to delete task:", error);
      if (stillOn(forProjectId)) setTasks(previousTasks);
    }
  }, [tasks]);

  const archive = useCallback(async (id: string) => {
    const forProjectId = projectIdRef.current;
    const previousTasks = tasks;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, archived_at: Date.now() } : t)));
    try {
      const task = await api.archiveTask(id);
      if (stillOn(forProjectId)) setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
    } catch (error) {
      console.error("Failed to archive task:", error);
      if (stillOn(forProjectId)) setTasks(previousTasks);
    }
  }, [tasks]);

  const unarchive = useCallback(async (id: string) => {
    const forProjectId = projectIdRef.current;
    const previousTasks = tasks;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, archived_at: null } : t)));
    try {
      const task = await api.unarchiveTask(id);
      if (stillOn(forProjectId)) setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
    } catch (error) {
      console.error("Failed to unarchive task:", error);
      if (stillOn(forProjectId)) setTasks(previousTasks);
    }
  }, [tasks]);

  const reorderTasks = useCallback(
    async (orderedIds: string[]) => {
      if (!projectId) return;

      const forProjectId = projectIdRef.current;
      const previousTasks = tasks;
      const reordered = orderedIds
        .map((id) => tasks.find((t) => t.id === id))
        .filter((t): t is Task => t !== undefined);
      setTasks(reordered);

      try {
        await api.reorderTasks(projectId, orderedIds);
      } catch (error) {
        console.error("Failed to reorder tasks:", error);
        if (stillOn(forProjectId)) setTasks(previousTasks);
      }
    },
    [projectId, tasks]
  );

  return {
    tasks,
    loading,
    createTask,
    updateTask,
    deleteTask,
    archive,
    unarchive,
    reorderTasks,
    refetch: fetchTasks,
  };
}
