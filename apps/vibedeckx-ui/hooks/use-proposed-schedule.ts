"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, type Schedule } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

/**
 * "Has this proposal already been turned into a schedule?" — answered from the
 * project's schedule list, which carries each row's provenance
 * (source_session_id / source_tool_use_id).
 *
 * The lookup has to survive a reload, a second device and a re-entry from a
 * notification, so it is deliberately server state rather than card state; see
 * docs/schedule-proposal-tool-design.md §3.2. The list is fetched once per
 * project and shared by every card in the conversation (a long session can
 * hold several), refetched on schedule:* events so a schedule deleted
 * elsewhere returns its card to the creatable state.
 */
const cache = new Map<string, Schedule[]>();
const inFlight = new Map<string, Promise<Schedule[]>>();
const listeners = new Map<string, Set<() => void>>();

function emit(projectId: string) {
  for (const listener of listeners.get(projectId) ?? []) listener();
}

function subscribe(projectId: string, listener: () => void): () => void {
  const set = listeners.get(projectId) ?? new Set();
  set.add(listener);
  listeners.set(projectId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(projectId);
  };
}

async function load(projectId: string, force: boolean): Promise<Schedule[]> {
  if (!force) {
    const cached = cache.get(projectId);
    if (cached) return cached;
    const pending = inFlight.get(projectId);
    if (pending) return pending;
  }
  const promise = api.getSchedules(projectId)
    .then((schedules) => {
      cache.set(projectId, schedules);
      emit(projectId);
      return schedules;
    })
    .finally(() => {
      if (inFlight.get(projectId) === promise) inFlight.delete(projectId);
    });
  inFlight.set(projectId, promise);
  return promise;
}

/** Test seam: the cache is module-level, so it outlives a test's component tree. */
export function __resetProposedScheduleCache(): void {
  cache.clear();
  inFlight.clear();
  listeners.clear();
}

/** Publish a just-created schedule so its card flips without waiting for a refetch. */
export function noteScheduleCreated(projectId: string, schedule: Schedule): void {
  const current = cache.get(projectId) ?? [];
  cache.set(projectId, [...current.filter((s) => s.id !== schedule.id), schedule]);
  emit(projectId);
}

export interface ProposedScheduleState {
  /** The schedule this proposal created, or null when it hasn't been accepted. */
  schedule: Schedule | null;
  /** True only until the project's schedules are known for the first time. */
  loading: boolean;
}

export function useProposedSchedule(
  projectId: string | null,
  sessionId: string | null,
  toolUseId: string | null | undefined,
): ProposedScheduleState {
  // The cache is an external store — reading it through useSyncExternalStore
  // keeps every card on one fetch and one shared, tearing-free snapshot.
  const schedules = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => (projectId ? subscribe(projectId, onChange) : () => {}),
      [projectId],
    ),
    useCallback(() => (projectId ? cache.get(projectId) ?? null : null), [projectId]),
    () => null,
  );

  useEffect(() => {
    if (!projectId) return;
    void load(projectId, false).catch((err) => {
      console.error("Failed to load schedules for proposal lookup:", err);
    });
  }, [projectId]);

  useGlobalEventStream(
    useCallback(
      (raw: unknown) => {
        const data = raw as { type?: string; projectId?: string };
        if (!data.type?.startsWith("schedule:")) return;
        if (!projectId || data.projectId !== projectId) return;
        void load(projectId, true).catch(() => {});
      },
      [projectId],
    ),
  );

  // Both halves of the key: a branched session copies the source session's
  // entries verbatim, so a tool_use id alone is not unique across sessions.
  const schedule = toolUseId && sessionId && schedules
    ? schedules.find((s) => s.source_tool_use_id === toolUseId && s.source_session_id === sessionId) ?? null
    : null;

  return { schedule, loading: schedules === null };
}
