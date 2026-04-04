"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Executor, type ExecutorType, type PromptProvider, type ExecutorProcess } from "@/lib/api";

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

export function useExecutors(projectId: string | null, groupId: string | null | undefined, executorMode?: string) {
  const [executors, setExecutors] = useState<Executor[]>([]);
  const [runningProcesses, setRunningProcesses] = useState<Map<string, Array<{ processId: string; target: string }>>>(
    new Map()
  ); // executorId -> [{ processId, target }]
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
      const processMap = new Map<string, Array<{ processId: string; target: string }>>();
      for (const proc of processes) {
        const entry = { processId: proc.id, target: proc.target ?? "local" };
        const existing = processMap.get(proc.executor_id);
        if (existing) {
          existing.push(entry);
        } else {
          processMap.set(proc.executor_id, [entry]);
        }
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

  // Reconcile stale running-process state when the browser tab regains focus.
  // SSE events emitted while the tab was backgrounded may have been lost.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchRunningProcesses();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [fetchRunningProcesses]);

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
          target?: string;
        };

        if (data.projectId !== projectId) return;
        if (!executorIdsRef.current.has(data.executorId)) return;

        if (data.type === "executor:started") {
          setRunningProcesses((prev) => {
            const entries = prev.get(data.executorId) ?? [];
            if (entries.some(e => e.processId === data.processId)) return prev;
            const newMap = new Map(prev);
            newMap.set(data.executorId, [...entries, { processId: data.processId, target: data.target ?? "local" }]);
            return newMap;
          });
        } else if (data.type === "executor:stopped") {
          setRunningProcesses((prev) => {
            const entries = prev.get(data.executorId);
            if (!entries) return prev;
            const filtered = entries.filter(e => e.processId !== data.processId);
            const newMap = new Map(prev);
            if (filtered.length === 0) {
              newMap.delete(data.executorId);
            } else {
              newMap.set(data.executorId, filtered);
            }
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
    async (opts: { name: string; command: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string; pty?: boolean }) => {
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
      opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean }
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
      const processId = await api.startExecutor(executorId, branch, executorMode);
      setRunningProcesses((prev) => {
        const entries = prev.get(executorId) ?? [];
        const newMap = new Map(prev);
        newMap.set(executorId, [...entries, { processId, target: executorMode ?? "local" }]);
        return newMap;
      });
      return processId;
    } catch (error) {
      console.error("Failed to start executor:", error);
      return null;
    }
  }, [executorMode]);

  // Stop executor
  const stopExecutor = useCallback(async (executorId: string, processId?: string) => {
    const entries = runningProcesses.get(executorId);
    const targetEntry = entries?.find(e => e.target === (executorMode ?? "local"));
    const targetProcessId = processId || targetEntry?.processId;
    if (!targetProcessId) return;

    try {
      await api.stopProcess(targetProcessId);
    } catch (error) {
      // Process already finished — still need to clear stale local state
      console.error("Failed to stop executor:", error);
    }
    // Always clear from runningProcesses — if the stop call failed the
    // process is already gone, so the entry is stale either way.
    setRunningProcesses((prev) => {
      const entries = prev.get(executorId);
      if (!entries) return prev;
      const filtered = entries.filter(e => e.processId !== targetProcessId);
      const newMap = new Map(prev);
      if (filtered.length === 0) {
        newMap.delete(executorId);
      } else {
        newMap.set(executorId, filtered);
      }
      return newMap;
    });
  }, [runningProcesses, executorMode]);

  // Mark process as finished (called when WebSocket receives finished message)
  const markProcessFinished = useCallback((executorId: string, processId?: string | null) => {
    setRunningProcesses((prev) => {
      const entries = prev.get(executorId);
      if (!entries) return prev;
      if (processId) {
        const filtered = entries.filter(e => e.processId !== processId);
        if (filtered.length === entries.length) return prev;
        const newMap = new Map(prev);
        if (filtered.length === 0) {
          newMap.delete(executorId);
        } else {
          newMap.set(executorId, filtered);
        }
        return newMap;
      }
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

  // Get executor with process info, filtered by current executor mode
  const executorsWithProcess: ExecutorWithProcess[] = executors.map((executor) => {
    const entries = runningProcesses.get(executor.id);
    const targetMode = executorMode ?? "local";
    const match = entries?.find(e => e.target === targetMode);
    return {
      ...executor,
      currentProcessId: match?.processId ?? null,
      isRunning: !!match,
    };
  });

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
