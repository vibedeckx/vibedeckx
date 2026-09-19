"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { api, ExecutorProcessRequestError, getAuthToken, type Executor, type ExecutorType, type PromptProvider, type ExecutorProcess } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

function getApiBase(): string {
  if (typeof window === "undefined") return "";
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:5173";
  }
  return "";
}

type RunningProcessEntry = { processId: string; target: string };

export function buildExecutorEventsUrl(): string {
  const token = getAuthToken();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${getApiBase()}/api/events${tokenParam}`;
}

/**
 * Whether a failed stop proves the process is gone. Only a 404 does — a
 * transport failure or an unconfirmed remote stop leaves it running.
 */
export function stopFailureMeansStopped(error: unknown): boolean {
  return error instanceof ExecutorProcessRequestError && error.status === 404;
}

/** The confirmed running process a rejected start points at, if any. */
export function alreadyRunningProcessId(error: unknown): string | null {
  if (!(error instanceof ExecutorProcessRequestError) || error.status !== 409) return null;
  const { code, processId } = error.body;
  return code === "already_running" && typeof processId === "string" ? processId : null;
}

export function buildRunningProcessMaps(processes: ExecutorProcess[]): {
  runningProcesses: Map<string, RunningProcessEntry[]>;
  lastStartedProcess: Map<string, RunningProcessEntry>;
} {
  const runningProcesses = new Map<string, RunningProcessEntry[]>();
  const lastStartedProcess = new Map<string, RunningProcessEntry>();

  for (const proc of processes) {
    const entry = { processId: proc.id, target: proc.target ?? "local" };
    const existing = runningProcesses.get(proc.executor_id);
    if (existing) {
      existing.push(entry);
    } else {
      runningProcesses.set(proc.executor_id, [entry]);
    }
    lastStartedProcess.set(proc.executor_id, entry);
  }

  return { runningProcesses, lastStartedProcess };
}

export function pruneLastStartedProcess(
  previous: Map<string, RunningProcessEntry>,
  runningProcesses: Map<string, RunningProcessEntry[]>,
): Map<string, RunningProcessEntry> {
  const next = new Map<string, RunningProcessEntry>();

  for (const [executorId, entry] of previous) {
    const stillRunning = runningProcesses.get(executorId)?.some(
      (running) => running.processId === entry.processId && running.target === entry.target,
    );
    if (stillRunning) {
      next.set(executorId, entry);
    }
  }

  return next;
}

const NO_EXECUTORS: Executor[] = [];

export interface ExecutorWithProcess extends Executor {
  currentProcessId: string | null;
  isRunning: boolean;
  // Fallback handle and timestamp for the most recent run on the currently
  // selected target (local or a specific remote). Both are derived from
  // executor.last_runs[targetMode], so they reflect what happened on this
  // target only — never the global most-recent across all targets.
  lastProcessId: string | null;
  lastStartedAt: string | null;
  // Whether this executor is disabled on the currently-selected target.
  isDisabled: boolean;
}

export function useExecutors(
  projectId: string | null,
  selectedBranch: string | null | undefined,
  executorMode?: string,
) {
  // Executors belong to a workspace; the main workspace's branch is the ""
  // sentinel, which is what a null/absent selection resolves to.
  const branch = selectedBranch ?? "";
  // Lists are held per workspace, keyed by the (projectId, branch) they were
  // fetched for. With a single list, switching workspaces kept rendering the
  // previous workspace's executors until the new fetch landed. Keyed, the
  // switch renders the target's own list (cached, or "Loading") in the same
  // frame, and a late response or create/reorder can only land in the
  // workspace it was made for.
  const workspaceKey = projectId ? `${projectId}::${branch}` : null;
  const [lists, setLists] = useState<ReadonlyMap<string, Executor[]>>(() => new Map());
  const executors = (workspaceKey !== null ? lists.get(workspaceKey) : undefined) ?? NO_EXECUTORS;
  const loading = workspaceKey !== null && !lists.has(workspaceKey);

  const setList = useCallback((key: string, list: Executor[]) => {
    setLists((prev) => new Map(prev).set(key, list));
  }, []);
  // Executors created per workspace while its list request is in flight. The
  // list may have been read before they existed, so its answer is merged with
  // them rather than replacing them (same contract as useTerminals).
  const createdWhileFetchingRef = useRef(new Map<string, Executor[]>());
  // Id-addressed edits (update/delete/last-run) go to whichever list holds
  // the executor, so they stay correct if the workspace changed mid-request.
  // Pending creations get the same edit, or the merge would bring back a
  // deleted executor or its pre-edit values.
  const updateEveryList = useCallback((update: (prev: Executor[]) => Executor[]) => {
    const pending = createdWhileFetchingRef.current;
    for (const [key, created] of pending) pending.set(key, update(created));
    setLists((prev) => {
      const next = new Map<string, Executor[]>();
      for (const [key, list] of prev) next.set(key, update(list));
      return next;
    });
  }, []);
  const [runningProcesses, setRunningProcesses] = useState<Map<string, RunningProcessEntry[]>>(
    new Map()
  ); // executorId -> [{ processId, target }]
  // Tracks the most recent processId per executor+target, persists after the
  // process stops.  This prevents a React-batching race where executor:started
  // and executor:stopped SSE events arrive in the same render frame, causing
  // currentProcessId to never be seen as non-null by child components.
  const [lastStartedProcess, setLastStartedProcess] = useState<Map<string, RunningProcessEntry>>(
    new Map()
  );

  // Fetch executors scoped to the selected workspace
  const fetchExecutors = useCallback(async () => {
    if (!projectId || workspaceKey === null) return;
    const pending = createdWhileFetchingRef.current;
    pending.set(workspaceKey, []);

    try {
      const data = await api.getExecutors(projectId, branch);
      const created = pending.get(workspaceKey) ?? [];
      pending.delete(workspaceKey);
      setList(workspaceKey, [...data, ...created.filter((one) => !data.some((e) => e.id === one.id))]);
    } catch (error) {
      console.error("Failed to fetch executors:", error);
      pending.delete(workspaceKey);
      // Leave a known list as is (it already holds anything created since);
      // a first load settles on empty rather than "Loading" forever.
      setLists((prev) => (prev.has(workspaceKey) ? prev : new Map(prev).set(workspaceKey, [])));
    }
  }, [projectId, branch, workspaceKey, setList]);

  // Fetch running processes
  const fetchRunningProcesses = useCallback(async () => {
    try {
      const processes = await api.getRunningProcesses();
      console.log(`[useExecutors] fetchRunningProcesses: ${processes.length} running`, processes.map(p => `${p.executor_id}/${p.id}/${(p as unknown as Record<string, unknown>).target ?? "local"}`));
      const { runningProcesses: processMap, lastStartedProcess: lastStartedMap } = buildRunningProcessMaps(processes);
      setRunningProcesses(processMap);
      setLastStartedProcess((prev) => {
        const pruned = pruneLastStartedProcess(prev, processMap);
        for (const [executorId, entry] of lastStartedMap) {
          pruned.set(executorId, entry);
        }
        return pruned;
      });
    } catch (error) {
      console.error("Failed to fetch running processes:", error);
    }
  }, []);

  // Executors are scoped to the active workspace — refetch when
  // projectId/branch resolve or change.
  useEffect(() => {
    fetchExecutors();
  }, [fetchExecutors]);

  // Running processes are global (not workspace-scoped). One effect keyed on
  // projectId covers both reasons to read them: first display (projectId
  // resolving from undefined is the first run) and project switch — an
  // executor:stopped emitted while we were viewing another project is dropped
  // by the projectId filter in the SSE handler below (SSE has no replay), so
  // the stale "running" entry would otherwise survive the round trip and the
  // Stop button would stay red. A separate mount effect used to fire once more
  // before projectId existed, for an identical result.
  useEffect(() => {
    if (!projectId) return;
    fetchRunningProcesses();
  }, [projectId, fetchRunningProcesses]);

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

  // Subscribe to global executor lifecycle events via the shared `/api/events`
  // stream. This syncs state when executors are started/stopped externally
  // (e.g. from chat).
  useGlobalEventStream((raw) => {
    const data = raw as {
      type: string;
      projectId: string;
      executorId: string;
      processId: string;
      target?: string;
    };

    if (data.type === "executor:started" || data.type === "executor:stopped") {
      console.log(`[useExecutors] SSE received: ${data.type} executor=${data.executorId} process=${data.processId} target=${data.target ?? "local"} project=${data.projectId}`);
    }

    // No projectId (or a mismatch) means this event isn't ours.
    if (!projectId || data.projectId !== projectId) {
      if (data.type === "executor:started" || data.type === "executor:stopped") {
        console.log(`[useExecutors] SSE filtered: projectId mismatch (event=${data.projectId}, hook=${projectId})`);
      }
      return;
    }
    if (!executorIdsRef.current.has(data.executorId)) {
      if (data.type === "executor:started" || data.type === "executor:stopped") {
        console.log(`[useExecutors] SSE filtered: executorId ${data.executorId} not in current group (known: ${Array.from(executorIdsRef.current).join(",")})`);
      }
      return;
    }

    if (data.type === "executor:started") {
      console.log(`[useExecutors] Processing executor:started, adding to runningProcesses`);
      setRunningProcesses((prev) => {
        const entries = prev.get(data.executorId) ?? [];
        if (entries.some(e => e.processId === data.processId)) return prev;
        const newMap = new Map(prev);
        newMap.set(data.executorId, [...entries, { processId: data.processId, target: data.target ?? "local" }]);
        return newMap;
      });
      setLastStartedProcess((prev) => {
        const newMap = new Map(prev);
        newMap.set(data.executorId, { processId: data.processId, target: data.target ?? "local" });
        return newMap;
      });
      // Optimistically refresh "Last run" for this target so the hover
      // label updates immediately instead of waiting for the next
      // executor-list refetch (which only happens on workspace switch).
      updateEveryList((prev) =>
        prev.map((e) => {
          if (e.id !== data.executorId) return e;
          const targetKey = data.target ?? "local";
          return {
            ...e,
            last_runs: {
              ...(e.last_runs ?? {}),
              [targetKey]: {
                started_at: new Date().toISOString(),
                process_id: data.processId,
              },
            },
          };
        }),
      );
    } else if (data.type === "executor:stopped") {
      console.log(`[useExecutors] Processing executor:stopped, removing from runningProcesses`);
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
      setLastStartedProcess((prev) => {
        const entry = prev.get(data.executorId);
        if (!entry || entry.processId !== data.processId) return prev;
        const newMap = new Map(prev);
        newMap.delete(data.executorId);
        return newMap;
      });
    }
  });

  // Create executor in the active workspace
  const createExecutor = useCallback(
    async (opts: { name: string; command: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string; pty?: boolean }) => {
      if (!projectId || workspaceKey === null) return null;

      try {
        const executor = await api.createExecutor(projectId, { ...opts, branch });
        createdWhileFetchingRef.current.get(workspaceKey)?.push(executor);
        // Shown at once, even before the workspace's first list has landed.
        setLists((prev) => new Map(prev).set(workspaceKey, [...(prev.get(workspaceKey) ?? []), executor]));
        return executor;
      } catch (error) {
        console.error("Failed to create executor:", error);
        return null;
      }
    },
    [projectId, branch, workspaceKey]
  );

  // Update executor
  const updateExecutor = useCallback(
    async (
      id: string,
      opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean; target?: string; disabled?: boolean }
    ) => {
      try {
        const executor = await api.updateExecutor(id, opts);
        updateEveryList((prev) =>
          prev.map((e) => (e.id === id ? executor : e))
        );
        return executor;
      } catch (error) {
        console.error("Failed to update executor:", error);
        toast.error("Failed to update executor", {
          description: error instanceof Error ? error.message : undefined,
        });
        return null;
      }
    },
    [updateEveryList]
  );

  // Delete executor
  const deleteExecutor = useCallback(async (id: string) => {
    try {
      await api.deleteExecutor(id);
      updateEveryList((prev) => prev.filter((e) => e.id !== id));
    } catch (error) {
      console.error("Failed to delete executor:", error);
    }
  }, [updateEveryList]);

  // Start executor
  const startExecutor = useCallback(async (executorId: string) => {
    const target = executorMode ?? "local";
    const trackRunning = (processId: string) => {
      setRunningProcesses((prev) => {
        const entries = prev.get(executorId) ?? [];
        if (entries.some((e) => e.processId === processId)) return prev;
        const newMap = new Map(prev);
        newMap.set(executorId, [...entries, { processId, target }]);
        return newMap;
      });
      setLastStartedProcess((prev) => {
        const newMap = new Map(prev);
        newMap.set(executorId, { processId, target });
        return newMap;
      });
    };
    try {
      const processId = await api.startExecutor(executorId, executorMode);
      trackRunning(processId);
      // Mirror the SSE handler's optimistic "Last run" update so locally
      // initiated starts also refresh the hover label without waiting for
      // the next executor-list refetch.
      updateEveryList((prev) =>
        prev.map((e) => {
          if (e.id !== executorId) return e;
          return {
            ...e,
            last_runs: {
              ...(e.last_runs ?? {}),
              [target]: {
                started_at: new Date().toISOString(),
                process_id: processId,
              },
            },
          };
        }),
      );
      return processId;
    } catch (error) {
      console.error("Failed to start executor:", error);
      // Already running (e.g. the UI lost track of it): show it again so it
      // can be stopped, rather than starting a second copy.
      const runningProcessId = alreadyRunningProcessId(error);
      if (runningProcessId) {
        trackRunning(runningProcessId);
        toast.info("Executor is already running", { description: "Stop it before starting again." });
      } else if (error instanceof ExecutorProcessRequestError
        && (error.body.code === "starting" || error.body.code === "start_unknown")) {
        toast.error("Executor not started", { description: error.message });
      }
      return null;
    }
  }, [executorMode, updateEveryList]);

  // Stop executor
  const stopExecutor = useCallback(async (executorId: string, processId?: string) => {
    const entries = runningProcesses.get(executorId);
    const targetEntry = entries?.find(e => e.target === (executorMode ?? "local"));
    const targetProcessId = processId || targetEntry?.processId;
    if (!targetProcessId) return;

    try {
      await api.stopProcess(targetProcessId);
    } catch (error) {
      console.error("Failed to stop executor:", error);
      if (!stopFailureMeansStopped(error)) {
        // The stop may never have reached the process (e.g. its remote was
        // unreachable). Keep it running so Stop can be retried, and resync
        // with the server's view.
        toast.error("Failed to stop executor", {
          description: `${error instanceof Error ? error.message : String(error)}. The process may still be running.`,
        });
        void fetchRunningProcesses();
        return;
      }
    }
    // Stopped, or a 404: the process is gone and its entry is stale.
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
    setLastStartedProcess((prev) => {
      const entry = prev.get(executorId);
      if (!entry || entry.processId !== targetProcessId) return prev;
      const newMap = new Map(prev);
      newMap.delete(executorId);
      return newMap;
    });
  }, [runningProcesses, executorMode, fetchRunningProcesses]);

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
    setLastStartedProcess((prev) => {
      if (!processId) {
        if (!prev.has(executorId)) return prev;
        const newMap = new Map(prev);
        newMap.delete(executorId);
        return newMap;
      }
      const entry = prev.get(executorId);
      if (!entry || entry.processId !== processId) return prev;
      const newMap = new Map(prev);
      newMap.delete(executorId);
      return newMap;
    });
  }, []);

  // Reorder executors with optimistic update
  const reorderExecutors = useCallback(
    async (orderedIds: string[]) => {
      if (!projectId || workspaceKey === null) return;

      // Optimistic update: reorder local state immediately
      const previousExecutors = executors;
      const reorderedExecutors = orderedIds
        .map((id) => executors.find((e) => e.id === id))
        .filter((e): e is Executor => e !== undefined);
      setList(workspaceKey, reorderedExecutors);

      try {
        await api.reorderExecutors(projectId, orderedIds, branch);
      } catch (error) {
        // Revert on error
        console.error("Failed to reorder executors:", error);
        setList(workspaceKey, previousExecutors);
      }
    },
    [projectId, branch, workspaceKey, executors, setList]
  );

  // Get executor with process info, filtered by current executor mode.
  // Falls back to lastStartedProcess so that currentProcessId survives
  // even if executor:stopped arrives before React renders the started state.
  const executorsWithProcess: ExecutorWithProcess[] = executors.map((executor) => {
    const entries = runningProcesses.get(executor.id);
    const targetMode = executorMode ?? "local";
    const match = entries?.find(e => e.target === targetMode);
    const lastStarted = lastStartedProcess.get(executor.id);
    const lastStartedMatch = lastStarted?.target === targetMode ? lastStarted : undefined;
    // Per-target lookup: both the reconnect handle and the display timestamp
    // come from the same entry, so neither leaks across targets.
    const lastRun = executor.last_runs?.[targetMode];
    return {
      ...executor,
      currentProcessId: match?.processId ?? lastStartedMatch?.processId ?? null,
      isRunning: !!match,
      lastProcessId: lastRun?.process_id ?? null,
      lastStartedAt: lastRun?.started_at ?? null,
      isDisabled: executor.disabled_targets.includes(targetMode),
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
