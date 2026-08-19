"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAliveSessions, listBranchSessions, type Worktree } from "@/lib/api";
import {
  useConnectionStatus,
  useGlobalEventStream,
  type ConnectionState,
} from "@/hooks/global-event-stream";

export interface ResidentSidebarSession {
  id: string;
  projectId: string;
  branch: string | null;
  title: string;
  status: string;
  processAlive: boolean;
  updated_at?: string;
}

/**
 * Insert a seeded session, or refresh the row it already has.
 *
 * The seed is an *insert-time* snapshot: it comes from `onSessionStarted`,
 * whose payload may be a `sessionCache` hit minted when the session was first
 * created — its `status` can be minutes stale ("running" long after the turn
 * ended). So for a row that already exists, both the title and the status stay
 * with the values the live channels (`session:title` / `session:status`) and
 * the authoritative REST refresh have resolved; re-selecting a session must
 * never flip its dot back to running.
 */
export function upsertResidentSession(
  previous: ResidentSidebarSession[],
  next: ResidentSidebarSession,
): ResidentSidebarSession[] {
  const index = previous.findIndex((session) => session.id === next.id);
  if (index === -1) return [next, ...previous];
  const existing = previous[index];
  const title =
    next.title === "New Session" && existing.title !== "New Session"
      ? existing.title
      : next.title;
  const copy = [...previous];
  copy[index] = { ...next, title, status: existing.status };
  return copy;
}

/**
 * Reconcile an authoritative `refresh()` result against the current state
 * without downgrading a title that a `session:title` event has already
 * resolved. A refresh started *before* the backend persisted the generated
 * title returns the placeholder ("New Session"); if that stale response lands
 * after the title event, a plain replace would revert the sidebar. The fetched
 * list stays authoritative for membership (dropped/added sessions), we only
 * keep the better title — mirrors `upsertResidentSession`'s guard. Titles are
 * write-once server-side, so preferring a real title over the placeholder is
 * always safe.
 */
export function mergeRefreshedSessions(
  previous: ResidentSidebarSession[],
  fetched: ResidentSidebarSession[],
): ResidentSidebarSession[] {
  const previousById = new Map(previous.map((session) => [session.id, session]));
  return fetched.map((next) => {
    const existing = previousById.get(next.id);
    if (existing && next.title === "New Session" && existing.title !== "New Session") {
      return { ...next, title: existing.title };
    }
    return next;
  });
}

/**
 * Resolve the display title carried by a `session:title` event. A real title is
 * trimmed and used as-is; a null/empty title (the user cleared the name) falls
 * back to the default placeholder so the clear reflects in the sidebar live
 * rather than lingering on the stale title until the next refetch.
 */
export function residentTitleFromEvent(rawTitle: unknown): string {
  const trimmed = typeof rawTitle === "string" ? rawTitle.trim() : "";
  return trimmed || "New Session";
}

export function updateResidentSessionTitle(
  previous: ResidentSidebarSession[],
  sessionId: string,
  title: string,
): ResidentSidebarSession[] {
  return previous.map((session) =>
    session.id === sessionId ? { ...session, title } : session,
  );
}

function sessionTitle(session: { title?: string | null }): string {
  return session.title?.trim() || "New Session";
}

/**
 * The sidebar's rows for one project: the sessions holding a live process.
 *
 * Primary path — one whole-project request, deliberately independent of the
 * workspace list: liveness is a property of the project, so it must not wait
 * on (or be scoped by, or be re-read because of) a worktree fetch. Returns
 * "incomplete" when the remote worker predates the `/alive` endpoint
 * (`complete: false`); only then does the per-branch fallback below run, and
 * it is the only path that needs `branches`. A worker that is offline or
 * erroring makes the request REJECT, and the caller keeps its current rows.
 */
async function fetchAliveSessions(
  projectId: string,
): Promise<ResidentSidebarSession[] | "incomplete"> {
  const alive = await listAliveSessions(projectId);
  if (!alive.complete) return "incomplete";
  // No `updated_at`: these arrive most-recently-active first and the grouping
  // below keeps that order (its sort is stable, and a row without a timestamp
  // never reorders against its peers).
  return alive.sessions.map((session) => ({
    id: session.id,
    projectId,
    branch: session.branch,
    title: sessionTitle(session),
    status: session.status,
    processAlive: true,
  }));
}

// Fallback — one listing per branch, of which everything but the live rows is
// discarded (what this hook used to do unconditionally). With no workspace list
// yet there is nothing to enumerate, and an empty fan-out result would read as
// "no live sessions": null = no answer, the caller keeps the rows it has.
async function fetchAliveSessionsByBranch(
  projectId: string,
  branches: Array<string | null>,
): Promise<ResidentSidebarSession[] | null> {
  if (branches.length === 0) return null;
  const perBranch = await Promise.all(
    branches.map(async (branch) => {
      const data = await listBranchSessions(projectId, branch);
      return data.sessions
        .filter((session) => session.processAlive)
        .map((session) => ({
          id: session.id,
          projectId,
          branch,
          title: sessionTitle(session),
          status: session.status,
          processAlive: true,
          updated_at: session.updated_at,
        }));
    }),
  );
  return perBranch.flat();
}

/**
 * True only when the SSE stream just came back after having dropped — i.e. it
 * was live at some point, went away, and is now live again. The EventBus→SSE
 * path has no replay, so any `session:title` (or other) event emitted while the
 * stream was down is lost; re-fetching on reconnect recovers it. Returns false
 * on the very first connect (the mount refresh already covers that) and while
 * merely re-rendering in the live state.
 */
export function isReconnectTransition(
  previous: ConnectionState | null,
  next: ConnectionState,
  everLive: boolean,
): boolean {
  return next === "live" && everLive && previous !== "live";
}

// Page-lifetime cache of each project's resident-session rows — same pattern
// as use-worktrees' list cache. A revisited project's sidebar sessions show
// instantly from the last visit while refresh() revalidates; a never-visited
// project seeds [] instead of leaking the previous project's rows under
// same-named branches until the first fetch lands. Row staleness (status,
// title) self-heals via the refresh and the SSE channels;
// mergeRefreshedSessions keeps membership authoritative.
const residentSessionListCache = new Map<string, ResidentSidebarSession[]>();

export function useResidentSessions(
  projectId: string | null,
  worktrees: Worktree[] | undefined,
  seedSession?: ResidentSidebarSession | null,
): Map<string, ResidentSidebarSession[]> {
  // Keyed on content, not array identity: the cached seed and the network
  // result usually carry the same branches, and a fetch keyed on the array
  // would re-run for that identity change alone (one extra /alive per load).
  const branchesKey = JSON.stringify((worktrees ?? []).map((wt) => wt.branch));
  const branches = useMemo(
    () => JSON.parse(branchesKey) as Array<string | null>,
    [branchesKey],
  );
  const [sessions, setSessions] = useState<ResidentSidebarSession[]>([]);

  // Seed on project change DURING render (same pattern as useWorktrees), so
  // the first commit after a switch already shows this project's rows.
  const [seededProjectId, setSeededProjectId] = useState<string | null>(null);
  if (projectId !== seededProjectId) {
    setSeededProjectId(projectId);
    setSessions(projectId ? residentSessionListCache.get(projectId) ?? [] : []);
  }
  // Guards async writes below: a refresh started for the previous project
  // must not land its rows into the new project's state (and, via the
  // write-through effect, poison its cache entry).
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Write-through so the next visit to this project can seed.
  useEffect(() => {
    if (projectId) residentSessionListCache.set(projectId, sessions);
  }, [projectId, sessions]);

  // Project whose worker answered `complete: false` on the primary endpoint —
  // only then does the branch list matter (one listing per branch). Keyed by
  // projectId so a stale flag from a previous project cannot trigger a fan-out.
  // `gen` makes every incomplete answer a fresh trigger: an old worker keeps
  // answering incomplete, and the reconnect / session:process refreshes must
  // still re-run the fan-out (a same-valued projectId alone would be a no-op).
  const [fallbackTrigger, setFallbackTrigger] = useState<{ projectId: string; gen: number } | null>(null);

  const commitRows = useCallback((pid: string, rows: ResidentSidebarSession[] | null) => {
    // null = the answer could not be produced (see fetchAliveSessionsByBranch);
    // hold the rows we have rather than reporting the project as idle.
    if (rows === null) return;
    if (projectIdRef.current !== pid) return;
    // Functional update so we reconcile against the freshest state: a
    // `session:title` event that landed while this fetch was in flight must not
    // be clobbered by the pre-title snapshot this request returned.
    setSessions((prev) => mergeRefreshedSessions(prev, rows));
  }, []);

  // Primary read: one whole-project request, independent of the workspace
  // list. Re-run only for a project switch or an SSE reconnect — NOT when the
  // branch list changes, which on a cold load happens once the worktrees land
  // (empty seed → real list) and used to cost a second identical /alive.
  const refresh = useCallback(async () => {
    if (!projectId) {
      setSessions([]);
      return;
    }
    const primary = await fetchAliveSessions(projectId);
    if (projectIdRef.current !== projectId) return;
    if (primary === "incomplete") {
      setFallbackTrigger((cur) => ({ projectId, gen: (cur?.gen ?? 0) + 1 }));
      return; // the fallback effect below takes it from here
    }
    setFallbackTrigger((cur) => (cur?.projectId === projectId ? null : cur));
    commitRows(projectId, primary);
  }, [projectId, commitRows]);

  useEffect(() => {
    let cancelled = false;
    refresh().catch((error) => {
      if (!cancelled) console.warn("[ResidentSessions] refresh failed:", error);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Fallback read: per-branch fan-out, and the only path that depends on
  // `branches` — so it (and only it) re-runs when the workspace list changes.
  useEffect(() => {
    if (!projectId || fallbackTrigger?.projectId !== projectId) return;
    let cancelled = false;
    fetchAliveSessionsByBranch(projectId, branches)
      .then((rows) => { if (!cancelled) commitRows(projectId, rows); })
      .catch((error) => {
        if (!cancelled) console.warn("[ResidentSessions] fallback refresh failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, fallbackTrigger, branches, commitRows]);

  // Recover from a dropped SSE stream: events (e.g. session:title) emitted
  // while disconnected are gone for good (no replay), so re-fetch once the
  // stream is live again. mergeRefreshedSessions keeps this non-destructive.
  const { state: connectionState } = useConnectionStatus();
  const prevConnRef = useRef<ConnectionState | null>(null);
  const everLiveRef = useRef(false);
  useEffect(() => {
    const previous = prevConnRef.current;
    prevConnRef.current = connectionState;
    const reconnected = isReconnectTransition(previous, connectionState, everLiveRef.current);
    if (connectionState === "live") everLiveRef.current = true;
    if (reconnected) {
      refresh().catch((error) =>
        console.warn("[ResidentSessions] reconnect refresh failed:", error),
      );
    }
  }, [connectionState, refresh]);

  useEffect(() => {
    if (!seedSession || !seedSession.processAlive) return;
    if (!projectId || seedSession.projectId !== projectId) return;
    setSessions((prev) => upsertResidentSession(prev, seedSession));
  }, [projectId, seedSession]);

  useGlobalEventStream((event) => {
    if (!projectId || event.projectId !== projectId) return;
    if (event.type === "session:process") {
      const sessionId = typeof event.sessionId === "string" ? event.sessionId : null;
      const alive = typeof event.alive === "boolean" ? event.alive : null;
      const branch = typeof event.branch === "string" ? event.branch : null;
      if (!sessionId || alive === null) return;
      if (!alive) {
        setSessions((prev) => prev.filter((session) => session.id !== sessionId));
        return;
      }
      refresh().catch((error) => console.warn("[ResidentSessions] process refresh failed:", error));
      if (branch !== null) {
        setSessions((prev) =>
          prev.map((session) =>
            session.id === sessionId ? { ...session, branch } : session,
          ),
        );
      }
    }
    if (event.type === "session:status") {
      const sessionId = typeof event.sessionId === "string" ? event.sessionId : null;
      const status = typeof event.status === "string" ? event.status : null;
      if (!sessionId || !status) return;
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId ? { ...session, status } : session,
        ),
      );
    }
    if (event.type === "session:title") {
      // Global title channel: reaches the sidebar even when the user has
      // navigated away from the session's workspace, so it no longer depends on
      // that session's AgentConversation still being mounted (the per-session WS
      // `titleUpdated` broadcast is lost the moment focus moves elsewhere).
      const sessionId = typeof event.sessionId === "string" ? event.sessionId : null;
      if (!sessionId) return;
      setSessions((prev) =>
        updateResidentSessionTitle(prev, sessionId, residentTitleFromEvent(event.title)),
      );
    }
  });

  return useMemo(() => {
    const byBranch = new Map<string, ResidentSidebarSession[]>();
    for (const session of sessions) {
      const key = session.branch ?? "";
      const list = byBranch.get(key) ?? [];
      list.push(session);
      byBranch.set(key, list);
    }
    for (const list of byBranch.values()) {
      // Newest first. Rows from the whole-project endpoint carry no timestamp
      // — they are already in that order, and a stable sort over equal keys
      // leaves them in it.
      list.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    }
    return byBranch;
  }, [sessions]);
}
