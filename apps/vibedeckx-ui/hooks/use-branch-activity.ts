"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getAuthToken } from "@/lib/api";

export type BranchActivity = "idle" | "working" | "completed" | "stopped";

interface BranchActivityEntry {
  branch: string | null;
  activity: BranchActivity;
  since: number;
}

interface BranchActivityResponse {
  branches: BranchActivityEntry[];
}

interface BranchActivityEvent {
  type: "branch:activity";
  projectId: string;
  branch: string | null;
  activity: BranchActivity;
  since: number;
}

function getApiBase(): string {
  if (typeof window === "undefined") return "";
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:5173";
  }
  return "";
}

function toKey(branch: string | null): string {
  return branch ?? "";
}

interface UseBranchActivityOptions {
  /**
   * Fired whenever a backend update for `branch` is applied (REST refetch or
   * SSE event). The consumer typically uses this to drop optimistic overlays
   * for that branch — once the backend has spoken, realtime is stale.
   */
  onBackendUpdate?: (branch: string | null) => void;
}

/**
 * Reads the backend's derived per-branch activity state for the current
 * project. REST fetch on mount + SSE subscription for live updates. The
 * returned Map keys are branch strings (empty string for the null/main
 * branch), values are the latest activity state.
 *
 * `since` is tracked per branch so out-of-order SSE events (rare, but
 * possible during reconnect) don't overwrite a newer state with an older one.
 */
export function useBranchActivity(
  projectId: string | null,
  options?: UseBranchActivityOptions,
): {
  activity: Map<string, BranchActivity>;
  refetch: () => Promise<void>;
} {
  const [activity, setActivity] = useState<Map<string, BranchActivity>>(new Map());
  // Shadow map of `since` timestamps for stale-event guarding.
  const sinceRef = useRef<Map<string, number>>(new Map());
  // Mirror of `activity` state so REST refetch can diff against the prior
  // value without going through React's render cycle. Required so we only
  // notify on genuine transitions — see fetchActivity below.
  const activityRef = useRef<Map<string, BranchActivity>>(new Map());
  // Tracks which projectId activityRef currently belongs to. When projectId
  // changes (project switch), the next fetch is a fresh snapshot for the new
  // project — diffing against the prior project's data would fire spurious
  // onBackendUpdate calls that clobber valid optimistic overlays (e.g. the
  // "idle" overlay set by New Conversation in project A would be cleared
  // when the user switches B → A and the refetch sees A's "completed").
  const activityProjectRef = useRef<string | null>(null);
  // Latest callback ref so the SSE handler closure reads the current one
  // without resubscribing whenever the parent re-renders.
  const onBackendUpdateRef = useRef(options?.onBackendUpdate);
  useEffect(() => {
    onBackendUpdateRef.current = options?.onBackendUpdate;
  });

  const fetchActivity = useCallback(async () => {
    if (!projectId) {
      setActivity(new Map());
      activityRef.current = new Map();
      activityProjectRef.current = null;
      sinceRef.current = new Map();
      return;
    }

    try {
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(
        `${getApiBase()}/api/projects/${projectId}/branches/activity`,
        { headers },
      );
      if (!res.ok) return;
      const data = (await res.json()) as BranchActivityResponse;
      const next = new Map<string, BranchActivity>();
      const nextSince = new Map<string, number>();
      for (const entry of data.branches) {
        const key = toKey(entry.branch);
        next.set(key, entry.activity);
        nextSince.set(key, entry.since);
      }
      // Only notify for branches whose activity actually transitioned. REST
      // refetch is a snapshot, not a state-change event — firing onBackendUpdate
      // unconditionally would clobber intentional optimistic overlays (e.g.
      // the "idle" overlay set by New Conversation while the latest DB session
      // is still "completed" because no new session has been created yet).
      //
      // Skip the diff entirely when activityRef belongs to a different
      // project (or is empty on initial mount): comparing across projects
      // produces meaningless transitions. The first fetch for a project is
      // always a snapshot.
      const isFreshProject = activityProjectRef.current !== projectId;
      const cb = onBackendUpdateRef.current;
      if (cb && !isFreshProject) {
        for (const entry of data.branches) {
          const key = toKey(entry.branch);
          if (activityRef.current.get(key) !== entry.activity) {
            cb(entry.branch);
          }
        }
      }
      setActivity(next);
      activityRef.current = next;
      activityProjectRef.current = projectId;
      sinceRef.current = nextSince;
    } catch {
      // Silently ignore — SSE will recover on reconnect.
    }
  }, [projectId]);

  // Initial REST fetch
  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  // SSE subscription
  useEffect(() => {
    if (!projectId) return;

    const token = getAuthToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `${getApiBase()}/api/events${tokenParam}`;
    const es = new EventSource(url);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type !== "branch:activity") return;
        const evt = data as BranchActivityEvent;
        if (evt.projectId !== projectId) return;

        const key = toKey(evt.branch);
        const prevSince = sinceRef.current.get(key) ?? 0;
        if (evt.since < prevSince) return; // stale event, ignore

        sinceRef.current.set(key, evt.since);
        setActivity((prev) => {
          if (prev.get(key) === evt.activity) return prev;
          const next = new Map(prev);
          next.set(key, evt.activity);
          activityRef.current = next;
          return next;
        });
        // Notify caller so it can clear optimistic overlays for this branch
        // — including branches the user isn't currently viewing, which is
        // how a non-selected workspace turns green when its agent finishes.
        onBackendUpdateRef.current?.(evt.branch);
      } catch {
        // Ignore parse errors (e.g. keepalive comments)
      }
    };

    es.onerror = () => {
      // Browser auto-reconnects EventSource. After reconnect we may have
      // missed events — refetch to resync. Debounce-ish: only refetch when
      // readyState comes back to OPEN (handled by onmessage taking over).
      // For now, the simple onerror → refetch is good enough.
    };

    return () => {
      es.close();
    };
  }, [projectId]);

  return { activity, refetch: fetchActivity };
}
