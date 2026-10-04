"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api, type Task } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

/**
 * "Which items of this propose_task call already became tasks, and where are
 * they now?" — answered from the project's task list, which carries each row's
 * provenance (source_session_id / source_tool_use_id / source_item_index).
 * Same shape and reasoning as use-proposed-schedule: server state, so the card
 * survives a reload or another device; one fetch per project shared by every
 * card; refetched on task:* events so completing or deleting a task elsewhere
 * is reflected on the card. See docs/session-task-proposal-design.md §3.3.
 */
const cache = new Map<string, Task[]>();
const inFlight = new Map<string, Promise<Task[]>>();
const listeners = new Map<string, Set<() => void>>();
/**
 * Projects whose cache went unwatched: task:* events only reach mounted cards,
 * so once the last one unmounts the cache may miss a completion or delete.
 * The next mount refetches instead of trusting it.
 */
const unwatched = new Set<string>();

function emit(projectId: string) {
  for (const listener of listeners.get(projectId) ?? []) listener();
}

function subscribe(projectId: string, listener: () => void): () => void {
  const set = listeners.get(projectId) ?? new Set();
  set.add(listener);
  listeners.set(projectId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(projectId);
      unwatched.add(projectId);
    }
  };
}

/**
 * Projects whose in-flight fetch may already be out of date: a refresh was
 * requested, or a task was created locally, after it started.
 */
const dirty = new Set<string>();

/**
 * Fetches for one project are serial: a refresh requested while one is in
 * flight marks it dirty, its result is dropped, and exactly one follow-up
 * fetch runs. So responses can't land out of order (an older list can't
 * overwrite a newer one, nor a just-created task), and a burst of task:*
 * events seen by N cards costs one extra request, not N.
 */
function load(projectId: string, force: boolean): Promise<Task[]> {
  if (unwatched.delete(projectId)) force = true;
  const pending = inFlight.get(projectId);
  if (pending) {
    if (force) dirty.add(projectId);
    return pending;
  }
  const cached = cache.get(projectId);
  if (!force && cached) return Promise.resolve(cached);
  return fetchTasks(projectId);
}

function fetchTasks(projectId: string): Promise<Task[]> {
  dirty.delete(projectId);
  // Archived tasks included: an archived follow-up still exists, so its card
  // must not offer to create it again.
  const promise: Promise<Task[]> = api.getTasks(projectId, { includeArchived: true })
    .then((tasks) => {
      if (!dirty.has(projectId)) {
        cache.set(projectId, tasks);
        emit(projectId);
      }
      return tasks;
    })
    .finally(() => {
      if (inFlight.get(projectId) === promise) inFlight.delete(projectId);
      if (dirty.has(projectId)) void fetchTasks(projectId).catch(() => {});
    });
  inFlight.set(projectId, promise);
  return promise;
}

/** Test seam: the cache is module-level, so it outlives a test's component tree. */
export function __resetProposedTaskCache(): void {
  cache.clear();
  inFlight.clear();
  listeners.clear();
  unwatched.clear();
  dirty.clear();
}

/** Publish a just-created task so its card row flips without waiting for a refetch. */
export function noteTaskCreated(projectId: string, task: Task): void {
  const current = cache.get(projectId) ?? [];
  cache.set(projectId, [...current.filter((t) => t.id !== task.id), task]);
  // A list fetched before this create would drop the task again.
  if (inFlight.has(projectId)) dirty.add(projectId);
  emit(projectId);
}

export interface ProposedTasksState {
  /** Created task per proposal item index; missing = not (or no longer) created. */
  byItem: Map<number, Task>;
  /** True only until the project's tasks are known for the first time. */
  loading: boolean;
  /** Set when the first load failed; the cards can't tell what exists yet. */
  loadError: string | null;
  /** Try the first load again. */
  retry: () => void;
}

export function useProposedTasks(
  projectId: string | null,
  sessionId: string | null,
  toolUseId: string | null | undefined,
): ProposedTasksState {
  const tasks = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => (projectId ? subscribe(projectId, onChange) : () => {}),
      [projectId],
    ),
    useCallback(() => (projectId ? cache.get(projectId) ?? null : null), [projectId]),
    () => null,
  );

  const [loadError, setLoadError] = useState<string | null>(null);
  const loadOrReport = useCallback((force: boolean) => {
    if (!projectId) return;
    void load(projectId, force).catch((err) => {
      console.error("Failed to load tasks for proposal lookup:", err);
      setLoadError(err instanceof Error ? err.message : "Failed to load tasks");
    });
  }, [projectId]);

  useEffect(() => {
    loadOrReport(false);
  }, [loadOrReport]);

  const retry = useCallback(() => {
    setLoadError(null);
    loadOrReport(true);
  }, [loadOrReport]);

  useGlobalEventStream(
    useCallback(
      (raw: unknown) => {
        const data = raw as { type?: string; projectId?: string };
        if (!data.type?.startsWith("task:")) return;
        if (!projectId || data.projectId !== projectId) return;
        void load(projectId, true).catch(() => {});
      },
      [projectId],
    ),
  );

  // Both halves of the key, as for schedules: a branched session copies the
  // source session's entries verbatim, tool_use ids included.
  const byItem = useMemo(() => {
    const map = new Map<number, Task>();
    if (!toolUseId || !sessionId || !tasks) return map;
    for (const t of tasks) {
      if (t.source_tool_use_id === toolUseId && t.source_session_id === sessionId && t.source_item_index != null) {
        map.set(t.source_item_index, t);
      }
    }
    return map;
  }, [tasks, toolUseId, sessionId]);

  return {
    byItem,
    loading: tasks === null && loadError === null,
    loadError: tasks === null ? loadError : null,
    retry,
  };
}
