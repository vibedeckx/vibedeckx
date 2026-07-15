"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listBranchSessions, type BranchSessionSummary, type Worktree } from "@/lib/api";
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
  copy[index] = { ...next, title };
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

function sessionTitle(session: BranchSessionSummary): string {
  return session.title?.trim() || "New Session";
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

export function useResidentSessions(
  projectId: string | null,
  worktrees: Worktree[] | undefined,
  seedSession?: ResidentSidebarSession | null,
): Map<string, ResidentSidebarSession[]> {
  const branches = useMemo(
    () => worktrees?.map((wt) => wt.branch) ?? [],
    [worktrees],
  );
  const [sessions, setSessions] = useState<ResidentSidebarSession[]>([]);

  const refresh = useCallback(async () => {
    if (!projectId || branches.length === 0) {
      setSessions([]);
      return;
    }
    const results = await Promise.all(
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
    // Functional update so we reconcile against the freshest state: a
    // `session:title` event that landed while this fetch was in flight must not
    // be clobbered by the pre-title snapshot this request returned.
    setSessions((prev) => mergeRefreshedSessions(prev, results.flat()));
  }, [branches, projectId]);

  useEffect(() => {
    let cancelled = false;
    refresh().catch((error) => {
      if (!cancelled) console.warn("[ResidentSessions] refresh failed:", error);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

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
      list.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    }
    return byBranch;
  }, [sessions]);
}
