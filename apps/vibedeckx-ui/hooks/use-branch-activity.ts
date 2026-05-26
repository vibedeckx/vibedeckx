"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getAuthToken } from "@/lib/api";

export type BranchActivity =
  | "idle"
  | "working"
  | "completed"
  | "stopped"
  | "main-running"
  | "main-completed";

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

/**
 * Apply an optimistic local activity seed to the activity map, returning the
 * same reference unchanged when the value already matches (so callers don't
 * trigger a needless render).
 *
 * Deliberately has NO access to the `since` map. Optimistic seeds exist purely
 * for sub-50ms visual feedback (e.g. "working" the instant the user hits send)
 * and must not participate in the `since`-based stale-event guard. `since`
 * lives entirely in the *server* clock domain — every real `branch:activity`
 * event carries the backend's `Date.now()` — whereas a client-stamped seed
 * would carry the *browser's* clock. When the two machines differ (a browser
 * on a box whose clock runs ahead of the server's — e.g. a Windows machine
 * ~20s ahead of a Linux server), a `Date.now()` seed would be larger than the
 * server's genuine `completed` timestamp, and `classifyActivityEvent` would
 * drop that real `completed` as "stale" — leaving the workspace dot stuck on
 * "working" (blue) forever.
 *
 * Leaving `since` anchored to the last real server event keeps the stale guard
 * a pure server-vs-server comparison. The optimistic activity is corrected by
 * the next genuine server transition, which carries a newer server `since`.
 *
 * Pure function — exported for tests.
 */
export function applyOptimisticActivity(
  activity: Map<string, BranchActivity>,
  branch: string | null,
  next: BranchActivity,
): Map<string, BranchActivity> {
  const key = toKey(branch);
  if (activity.get(key) === next) return activity;
  const m = new Map(activity);
  m.set(key, next);
  return m;
}

/**
 * Reads the backend's derived per-branch activity state for the current
 * project. REST fetch on mount + SSE subscription for live updates. The
 * returned `activity` map keys are branch strings (empty string for the
 * null/main branch), values are the latest activity state.
 *
 * `setOptimisticActivity(branch, activity)` lets callers seed the map
 * locally before the backend event lands (e.g. "working" on send, "idle" on
 * New Conversation). Internally written with `since = Date.now()` so a
 * subsequent backend SSE event with a newer `since` correctly takes over;
 * an event with the same activity is a no-op transition (the map is already
 * in the right state).
 *
 * `since` is tracked per branch so out-of-order SSE events (rare, but
 * possible during reconnect) don't overwrite a newer state with an older one.
 */
export function useBranchActivity(
  projectId: string | null,
): {
  activity: Map<string, BranchActivity>;
  /**
   * Per-branch `since` (epoch ms) of the current activity, exposed reactively
   * so callers can order a backend dot against other timestamps (e.g. a New
   * Conversation reset vs. a terminal `main-completed`). Mirrors `sinceRef`.
   */
  since: Map<string, number>;
  refetch: () => Promise<void>;
  setOptimisticActivity: (branch: string | null, activity: BranchActivity) => void;
} {
  const [activity, setActivity] = useState<Map<string, BranchActivity>>(new Map());
  const [since, setSince] = useState<Map<string, number>>(new Map());
  // Shadow map of `since` timestamps for stale-event guarding. Kept in sync
  // with the `since` state (the ref is read synchronously by the reconcile /
  // classify helpers; the state drives renders).
  const sinceRef = useRef<Map<string, number>>(new Map());
  // Mirror of `activity` state so REST refetch and the SSE handler can read
  // the current map synchronously (without going through React's render
  // cycle) — needed by `reconcileActivitySnapshot` and `classifyActivityEvent`.
  const activityRef = useRef<Map<string, BranchActivity>>(new Map());
  // Tracks which projectId activityRef currently belongs to. When projectId
  // changes (project switch), the next fetch is a fresh snapshot for the new
  // project — diffing against the prior project's data would be meaningless
  // and risks corrupting state during switches.
  const activityProjectRef = useRef<string | null>(null);

  const fetchActivity = useCallback(async () => {
    if (!projectId) {
      setActivity(new Map());
      setSince(new Map());
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
      const { nextActivity, nextSince } = reconcileActivitySnapshot(
        data.branches,
        activityRef.current,
        sinceRef.current,
        isFreshProject,
      );
      setActivity(nextActivity);
      setSince(nextSince);
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
        setSince(new Map(sinceRef.current));
        if (outcome.kind === "redundant") return;

        setActivity((prev) => {
          const next = new Map(prev);
          next.set(outcome.key, evt.activity);
          activityRef.current = next;
          return next;
        });
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

  /**
   * Seed the activity map for `branch` locally, ahead of the backend's SSE
   * event. Used for sub-50ms UX feedback on user actions (e.g. "working"
   * on send) and to override stale backend state during placeholder-only
   * UI transitions (e.g. "idle" on New Conversation, before any new DB
   * session has been created and emitted a real branch:activity event).
   *
   * Deliberately does NOT touch `since` — see `applyOptimisticActivity` for
   * why mixing the browser clock into the server-clock stale guard left the
   * dot stuck on a cross-machine clock skew. `since` stays anchored to the
   * last real server event; the next genuine backend transition (carrying a
   * newer server `since`) corrects the optimistic value.
   */
  const setOptimisticActivity = useCallback(
    (branch: string | null, next: BranchActivity) => {
      setActivity((prev) => {
        const m = applyOptimisticActivity(prev, branch, next);
        activityRef.current = m;
        return m;
      });
    },
    [],
  );

  return { activity, since, refetch: fetchActivity, setOptimisticActivity };
}
