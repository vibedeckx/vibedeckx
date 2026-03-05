"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Executor, type ExecutorProcess } from "@/lib/api";

function getApiBase(): string {
  if (typeof window === "undefined") return "";
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:5173";
  }
  return "";
}

export interface ExecutorWithProcess extends Executor {
  currentProcessId: string | null;
  isRunning: boolean;
}

export function useExecutors(projectId: string | null, groupId: string | null | undefined) {
  const [executors, setExecutors] = useState<Executor[]>([]);
  const [runningProcesses, setRunningProcesses] = useState<Map<string, string>>(
    new Map()
  ); // executorId -> processId
  const [loading, setLoading] = useState(true);

  // Fetch executors scoped to group
  const fetchExecutors = useCallback(async () => {
    if (!projectId || !groupId) {
      setExecutors([]);
      setLoading(false);
      return;
    }

    try {
      const data = await api.getExecutors(projectId, groupId);
      setExecutors(data);
    } catch (error) {
      console.error("Failed to fetch executors:", error);
    } finally {
      setLoading(false);
    }
  }, [projectId, groupId]);

  // Fetch running processes
  const fetchRunningProcesses = useCallback(async () => {
    try {
      const processes = await api.getRunningProcesses();
      const processMap = new Map<string, string>();
      for (const proc of processes) {
        processMap.set(proc.executor_id, proc.id);
      }
      setRunningProcesses(processMap);
    } catch (error) {
      console.error("Failed to fetch running processes:", error);
    }
  }, []);

  useEffect(() => {
    fetchExecutors();
    fetchRunningProcesses();
  }, [fetchExecutors, fetchRunningProcesses]);

  // Keep a ref of current executor IDs for the SSE handler
  const executorIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    executorIdsRef.current = new Set(executors.map((e) => e.id));
  }, [executors]);

  // Subscribe to global executor lifecycle events (SSE)
  // This syncs state when executors are started/stopped externally (e.g. from chat)
  useEffect(() => {
    if (!projectId) return;

    const url = `${getApiBase()}/api/events`;
    const es = new EventSource(url);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string;
          projectId: string;
          executorId: string;
          processId: string;
        };

        if (data.projectId !== projectId) return;
        if (!executorIdsRef.current.has(data.executorId)) return;

        if (data.type === "executor:started") {
          setRunningProcesses((prev) => {
            if (prev.get(data.executorId) === data.processId) return prev;
            const newMap = new Map(prev);
            newMap.set(data.executorId, data.processId);
            return newMap;
          });
        } else if (data.type === "executor:stopped") {
          setRunningProcesses((prev) => {
            if (!prev.has(data.executorId)) return prev;
            const newMap = new Map(prev);
            newMap.delete(data.executorId);
            return newMap;
          });
        }
      } catch {
        // Ignore parse errors (e.g. keepalive comments)
      }
    };

    return () => {
      es.close();
    };
  }, [projectId]);

  // Create executor in the active group
  const createExecutor = useCallback(
    async (opts: { name: string; command: string; cwd?: string; pty?: boolean }) => {
      if (!projectId || !groupId) return null;

      try {
        const executor = await api.createExecutor(projectId, { ...opts, group_id: groupId });
        setExecutors((prev) => [...prev, executor]);
        return executor;
      } catch (error) {
        console.error("Failed to create executor:", error);
        return null;
      }
    },
    [projectId, groupId]
  );

  // Update executor
  const updateExecutor = useCallback(
    async (
      id: string,
      opts: { name?: string; command?: string; cwd?: string | null; pty?: boolean }
    ) => {
      try {
        const executor = await api.updateExecutor(id, opts);
        setExecutors((prev) =>
          prev.map((e) => (e.id === id ? executor : e))
        );
        return executor;
      } catch (error) {
        console.error("Failed to update executor:", error);
        return null;
      }
    },
    []
  );

  // Delete executor
  const deleteExecutor = useCallback(async (id: string) => {
    try {
      await api.deleteExecutor(id);
      setExecutors((prev) => prev.filter((e) => e.id !== id));
    } catch (error) {
      console.error("Failed to delete executor:", error);
    }
  }, []);

  // Start executor
  const startExecutor = useCallback(async (executorId: string, branch?: string | null) => {
    try {
      const processId = await api.startExecutor(executorId, branch);
      setRunningProcesses((prev) => {
        const newMap = new Map(prev);
        newMap.set(executorId, processId);
        return newMap;
      });
      return processId;
    } catch (error) {
      console.error("Failed to start executor:", error);
      return null;
    }
  }, []);

  // Stop executor
  const stopExecutor = useCallback(async (executorId: string, processId?: string) => {
    const targetProcessId = processId || runningProcesses.get(executorId);
    if (!targetProcessId) return;

    try {
      await api.stopProcess(targetProcessId);
      setRunningProcesses((prev) => {
        const newMap = new Map(prev);
        newMap.delete(executorId);
        return newMap;
      });
    } catch (error) {
      console.error("Failed to stop executor:", error);
    }
  }, [runningProcesses]);

  // Mark process as finished (called when WebSocket receives finished message)
  const markProcessFinished = useCallback((executorId: string) => {
    setRunningProcesses((prev) => {
      const newMap = new Map(prev);
      newMap.delete(executorId);
      return newMap;
    });
  }, []);

  // Reorder executors with optimistic update
  const reorderExecutors = useCallback(
    async (orderedIds: string[]) => {
      if (!projectId || !groupId) return;

      // Optimistic update: reorder local state immediately
      const previousExecutors = executors;
      const reorderedExecutors = orderedIds
        .map((id) => executors.find((e) => e.id === id))
        .filter((e): e is Executor => e !== undefined);
      setExecutors(reorderedExecutors);

      try {
        await api.reorderExecutors(projectId, orderedIds, groupId);
      } catch (error) {
        // Revert on error
        console.error("Failed to reorder executors:", error);
        setExecutors(previousExecutors);
      }
    },
    [projectId, groupId, executors]
  );

  // Get executor with process info
  const executorsWithProcess: ExecutorWithProcess[] = executors.map((executor) => ({
    ...executor,
    currentProcessId: runningProcesses.get(executor.id) ?? null,
    isRunning: runningProcesses.has(executor.id),
  }));

  return {
    executors: executorsWithProcess,
    loading,
    createExecutor,
    updateExecutor,
    deleteExecutor,
    startExecutor,
    stopExecutor,
    markProcessFinished,
    reorderExecutors,
    refetch: fetchExecutors,
  };
}
