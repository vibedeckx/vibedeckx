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

export interface ActivitySnapshotEntry {
  branch: string | null;
  activity: BranchActivity;
  since: number;
}

/**
 * Reconcile a REST `/branches/activity` snapshot against the SSE-derived
 * in-memory state. For each branch, the SSE wins iff its `since` is strictly
 * newer than the snapshot — REST is a slow read, and a snapshot captured
 * before a recent SSE event must not roll the state back.
 *
 * Concrete bug this guards against: on first send after New Conversation,
 * `createNewSession` emits `branch:activity:idle` and `persistEntry` emits
 * `branch:activity:working` back-to-back. The `onSessionStarted` refetch
 * fired between the two HTTP calls can return a snapshot taken before
 * `persistEntry` lands — without this check that stale "idle" would clobber
 * the SSE "working" and leave the workspace dot gray until a workspace
 * switch triggers another refetch.
 *
 * On a fresh project (initial mount or project switch) the in-memory state
 * is meaningless, so the snapshot is trusted wholesale.
 *
 * Pure function — exported for tests.
 */
export function reconcileActivitySnapshot(
  snapshot: ActivitySnapshotEntry[],
  prevActivity: Map<string, BranchActivity>,
  prevSince: Map<string, number>,
  isFreshProject: boolean,
): {
  nextActivity: Map<string, BranchActivity>;
  nextSince: Map<string, number>;
  transitions: Array<string | null>;
} {
  const nextActivity = new Map<string, BranchActivity>();
  const nextSince = new Map<string, number>();
  const transitions: Array<string | null> = [];

  for (const entry of snapshot) {
    const key = toKey(entry.branch);
    const seenSince = prevSince.get(key) ?? 0;
    if (!isFreshProject && entry.since < seenSince) {
      const kept = prevActivity.get(key);
      if (kept !== undefined) {
        nextActivity.set(key, kept);
        nextSince.set(key, seenSince);
        continue;
      }
      // Defensive: prevSince had a value but prevActivity didn't (desync).
      // Fall through and accept the snapshot.
    }
    nextActivity.set(key, entry.activity);
    nextSince.set(key, entry.since);
    if (!isFreshProject && prevActivity.get(key) !== entry.activity) {
      transitions.push(entry.branch);
    }
  }

  return { nextActivity, nextSince, transitions };
}

/**
 * Classify an incoming SSE `branch:activity` event against the in-memory
 * state. Returns the outcome the SSE handler should apply.
 *
 * `kind`:
 *   - "stale"      → event.since older than what we've seen; ignore entirely.
 *   - "redundant"  → not stale, but activity matches what we already have.
 *                    Bump `since` (so future stale checks work) but do NOT
 *                    notify the caller — firing `onBackendUpdate` here would
 *                    clobber legitimate optimistic overlays (e.g. the "idle"
 *                    overlay set by New Conversation while the backend
 *                    re-emits "stopped" from a redundant `stopSession` call
 *                    on the already-stopped prior session).
 *   - "transition" → activity actually changed; update state and notify.
 *
 * Mirrors `reconcileActivitySnapshot`'s "transitions only" contract for the
 * REST path — both paths must agree that `onBackendUpdate` fires iff the
 * state genuinely changed.
 *
 * Pure function — exported for tests.
 */
export function classifyActivityEvent(
  event: { branch: string | null; activity: BranchActivity; since: number },
  prevActivity: Map<string, BranchActivity>,
  prevSince: Map<string, number>,
): { kind: "stale" } | { kind: "redundant" | "transition"; key: string } {
  const key = toKey(event.branch);
  const seenSince = prevSince.get(key) ?? 0;
  if (event.since < seenSince) return { kind: "stale" };
  const prev = prevActivity.get(key);
  if (prev === event.activity) return { kind: "redundant", key };
  return { kind: "transition", key };
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

      // Reconcile against the SSE-derived state, respecting per-branch
      // `since` so a stale snapshot can't roll back a newer SSE update.
      // See `reconcileActivitySnapshot` for the why.
      const isFreshProject = activityProjectRef.current !== projectId;
      const { nextActivity, nextSince, transitions } = reconcileActivitySnapshot(
        data.branches,
        activityRef.current,
        sinceRef.current,
        isFreshProject,
      );

      // Only notify for branches whose activity actually transitioned. REST
      // refetch is a snapshot, not a state-change event — firing onBackendUpdate
      // unconditionally would clobber intentional optimistic overlays (e.g.
      // the "idle" overlay set by New Conversation while the latest DB session
      // is still "completed" because no new session has been created yet).
      const cb = onBackendUpdateRef.current;
      if (cb) {
        for (const branch of transitions) cb(branch);
      }
      setActivity(nextActivity);
      activityRef.current = nextActivity;
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

        const outcome = classifyActivityEvent(
          evt,
          activityRef.current,
          sinceRef.current,
        );
        if (outcome.kind === "stale") return;

        sinceRef.current.set(outcome.key, evt.since);
        if (outcome.kind === "redundant") return;

        setActivity((prev) => {
          const next = new Map(prev);
          next.set(outcome.key, evt.activity);
          activityRef.current = next;
          return next;
        });
        // Notify caller so it can clear optimistic overlays for this branch
        // — including branches the user isn't currently viewing, which is
        // how a non-selected workspace turns green when its agent finishes.
        // Only fires on actual transitions (see classifyActivityEvent).
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
