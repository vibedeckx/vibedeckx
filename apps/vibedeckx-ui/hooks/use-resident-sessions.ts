"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { listBranchSessions, type BranchSessionSummary, type Worktree } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

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
    setSessions(results.flat());
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
