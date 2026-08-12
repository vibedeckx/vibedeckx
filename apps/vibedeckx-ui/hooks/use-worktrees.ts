"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Worktree } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

export const WORKTREE_DRIFT_BACKSTOP_MS = 5 * 60_000;

/**
 * True while the worktree list can't be trusted for `projectId` — a fetch is
 * in flight, or the list on hand was loaded for a different project. Pure —
 * exported for tests.
 *
 * The second clause is what closes the cross-project navigation race: a
 * `setFetching(true)` from the fetch effect isn't visible to sibling effects
 * in the same commit, so a flag alone would let page.tsx's auto-select effect
 * consume a pending workspace selection against the PREVIOUS project's
 * worktrees and fall back to the main workspace. Deriving loading from the
 * list's owning project holds in the very render the project changes.
 */
export function isWorktreesLoading(
  fetching: boolean,
  loadedProjectId: string | null,
  projectId: string | null,
): boolean {
  return fetching || loadedProjectId !== projectId;
}

export function worktreesEqual(left: Worktree[], right: Worktree[]): boolean {
  return left.length === right.length && left.every((worktree, index) =>
    worktree.branch === right[index].branch
    && worktree.currentBranch === right[index].currentBranch
    && worktree.expectedBranch === right[index].expectedBranch
  );
}

/** Keep a selected workspace reachable when an old worker renames it on a background refresh. */
export function preserveSelectedWorkspace(
  previous: Worktree[],
  incoming: Worktree[],
  selectedBranch: string | null | undefined,
): Worktree[] {
  if (selectedBranch === undefined || incoming.some((worktree) => worktree.branch === selectedBranch)) {
    return incoming;
  }
  const previousIndex = previous.findIndex((worktree) => worktree.branch === selectedBranch);
  if (previousIndex < 0) return incoming;
  const preserved = [...incoming];
  preserved.splice(Math.min(previousIndex, preserved.length), 0, previous[previousIndex]);
  return preserved;
}

// Page-lifetime cache of the last fetched worktree list per project. A
// revisited project is seeded from it synchronously (render-phase, below), so
// cross-project navigation can apply a staged workspace/session selection
// immediately instead of waiting a network round-trip (remote projects list
// worktrees over the tunnel); the regular fetch then revalidates. Values are
// server truth from the last completed fetch — never the
// preserveSelectedWorkspace hybrid.
const worktreeListCache = new Map<string, Worktree[]>();

export function useWorktrees(
  projectId: string | null,
  selectedBranch?: string | null,
) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [fetching, setFetching] = useState(true);
  // The project the current `worktrees` list was fetched for.
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  // Mirror for reads inside fetchWorktrees: its deps must stay [projectId]
  // (the fetch effect keys off its identity), so the state value would be a
  // stale closure there.
  const loadedProjectIdRef = useRef<string | null>(null);
  const markLoadedFor = (pid: string | null) => {
    loadedProjectIdRef.current = pid;
    setLoadedProjectId(pid);
  };

  // Seed a revisited project's list from cache DURING render — same pattern
  // as page.tsx's render-phase branch reset — so sibling effects in the very
  // first commit after a project switch already see a non-stale list.
  const [seededProjectId, setSeededProjectId] = useState<string | null>(null);
  if (projectId !== seededProjectId) {
    setSeededProjectId(projectId);
    const cached = projectId ? worktreeListCache.get(projectId) : undefined;
    if (cached) {
      setWorktrees(cached);
      markLoadedFor(projectId);
      // The project-change revalidation is about to start, but the fetch
      // effect's own setFetching(true) is invisible to sibling effects in
      // this first commit. Set it here, synchronously, or that commit exposes
      // (stale=false, loading=false) — an "authoritative" list — and
      // page.tsx's pending-apply effect would DROP a staged branch that is
      // newer than this cache instead of waiting for the fresh list.
      setFetching(true);
    }
  }
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const previousSelectionRef = useRef<{ projectId: string | null; branch: string | null | undefined } | null>(null);
  const selectedBranchRef = useRef(selectedBranch);
  selectedBranchRef.current = selectedBranch;

  const fetchWorktrees = useCallback(async (background = false) => {
    if (background && requestController.current) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const generation = requestGeneration.current;
    if (!projectId) {
      requestController.current = null;
      setWorktrees([]);
      markLoadedFor(null);
      setFetching(false);
      return;
    }

    if (!background) setFetching(true);
    try {
      const data = await api.getProjectWorktrees(projectId, undefined, controller.signal);
      if (generation !== requestGeneration.current) return;
      worktreeListCache.set(projectId, data);
      setWorktrees((previous) => {
        const next = background
          ? preserveSelectedWorkspace(previous, data, selectedBranchRef.current)
          : data;
        return worktreesEqual(previous, next) ? previous : next;
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      if (error instanceof Error && error.name === "AbortError") return;
      console.error("Failed to fetch worktrees:", error);
      // A background health refresh must not erase a valid workspace list on a
      // transient network failure — and neither should a failed revalidation
      // of a cache-seeded list (the seed is a better answer than the stub).
      if (!background && loadedProjectIdRef.current !== projectId) {
        setWorktrees([{ branch: null }]);
      }
    } finally {
      if (generation !== requestGeneration.current || requestController.current !== controller) return;
      markLoadedFor(projectId);
      if (!background) setFetching(false);
      requestController.current = null;
    }
  }, [projectId]);

  useEffect(() => {
    void fetchWorktrees();
    return () => {
      requestController.current?.abort();
      requestController.current = null;
      requestGeneration.current += 1;
    };
  }, [fetchWorktrees]);

  // Selecting another workspace is a natural point to verify its physical
  // checkout. Do not duplicate the initial/project-change fetch above.
  useEffect(() => {
    const previous = previousSelectionRef.current;
    previousSelectionRef.current = { projectId, branch: selectedBranch };
    if (
      previous
      && previous.projectId === projectId
      && previous.branch !== selectedBranch
    ) {
      void fetchWorktrees(true);
    }
  }, [projectId, selectedBranch, fetchWorktrees]);

  // Agent turns and executors are the normal sources of Git changes. Refresh
  // when they finish instead of spawning Git processes every few seconds.
  useGlobalEventStream((event) => {
    if (!projectId || event.projectId !== projectId) return;
    const terminalSessionStatus = event.type === "session:status"
      && (event.status === "stopped" || event.status === "error");
    if (
      event.type === "session:taskCompleted"
      || event.type === "executor:stopped"
      || terminalSessionStatus
    ) {
      void fetchWorktrees(true);
    }
  });

  // External Git commands may not produce an app event. Refresh immediately
  // when the user returns, then retain a low-frequency visible-tab backstop.
  useEffect(() => {
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => void fetchWorktrees(true), WORKTREE_DRIFT_BACKSTOP_MS);
    };
    const onFocus = () => void fetchWorktrees(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchWorktrees(true);
        start();
      } else {
        stop();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (document.visibilityState === "visible") start();
    return () => {
      stop();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchWorktrees]);

  const refetch = useCallback(() => fetchWorktrees(false), [fetchWorktrees]);

  return {
    worktrees,
    loading: isWorktreesLoading(fetching, loadedProjectId, projectId),
    // Narrower than `loading`: true only while the list on hand belongs to a
    // DIFFERENT project (the cross-project navigation window). Same-project
    // refetches keep it false, so consumers can gate selection highlights on
    // it without blinking them on every refresh.
    stale: loadedProjectId !== projectId,
    refetch,
  };
}
