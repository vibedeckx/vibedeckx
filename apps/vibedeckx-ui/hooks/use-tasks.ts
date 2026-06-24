"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type Task, type TaskStatus, type TaskPriority } from "@/lib/api";

export function useTasks(projectId: string | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    if (!projectId) {
      setTasks([]);
      setLoading(false);
      return;
    }

    try {
      const data = await api.getTasks(projectId, { includeArchived: true });
      setTasks(data);
    } catch (error) {
      console.error("Failed to fetch tasks:", error);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const createTask = useCallback(
    async (opts: { title?: string; description: string; status?: TaskStatus; priority?: TaskPriority }) => {
      if (!projectId) return null;

      try {
        const task = await api.createTask(projectId, opts);
        setTasks((prev) => [...prev, task]);
        return task;
      } catch (error) {
        console.error("Failed to create task:", error);
        return null;
      }
    },
    [projectId]
  );

  const updateTask = useCallback(
    async (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => {
      // Optimistic update
      const previousTasks = tasks;
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...opts, updated_at: new Date().toISOString() } : t))
      );

      try {
        const task = await api.updateTask(id, opts);
        setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
        return task;
      } catch (error) {
        console.error("Failed to update task:", error);
        setTasks(previousTasks);
        return null;
      }
    },
    [tasks]
  );

  const deleteTask = useCallback(async (id: string) => {
    const previousTasks = tasks;
    setTasks((prev) => prev.filter((t) => t.id !== id));

    try {
      await api.deleteTask(id);
    } catch (error) {
      console.error("Failed to delete task:", error);
      setTasks(previousTasks);
    }
  }, [tasks]);

  const archive = useCallback(async (id: string) => {
    const previousTasks = tasks;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, archived_at: Date.now() } : t)));
    try {
      const task = await api.archiveTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
    } catch (error) {
      console.error("Failed to archive task:", error);
      setTasks(previousTasks);
    }
  }, [tasks]);

  const unarchive = useCallback(async (id: string) => {
    const previousTasks = tasks;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, archived_at: null } : t)));
    try {
      const task = await api.unarchiveTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
    } catch (error) {
      console.error("Failed to unarchive task:", error);
      setTasks(previousTasks);
    }
  }, [tasks]);

  const reorderTasks = useCallback(
    async (orderedIds: string[]) => {
      if (!projectId) return;

      const previousTasks = tasks;
      const reordered = orderedIds
        .map((id) => tasks.find((t) => t.id === id))
        .filter((t): t is Task => t !== undefined);
      setTasks(reordered);

      try {
        await api.reorderTasks(projectId, orderedIds);
      } catch (error) {
        console.error("Failed to reorder tasks:", error);
        setTasks(previousTasks);
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
