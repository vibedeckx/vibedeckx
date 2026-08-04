"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Worktree } from "@/lib/api";

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

export function useWorktrees(
  projectId: string | null,
  selectedBranch?: string | null,
) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [fetching, setFetching] = useState(true);
  // The project the current `worktrees` list was fetched for.
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);
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
      setLoadedProjectId(null);
      setFetching(false);
      return;
    }

    if (!background) setFetching(true);
    try {
      const data = await api.getProjectWorktrees(projectId, undefined, controller.signal);
      if (generation !== requestGeneration.current) return;
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
      // transient network failure.
      if (!background) setWorktrees([{ branch: null }]);
    } finally {
      if (generation !== requestGeneration.current || requestController.current !== controller) return;
      setLoadedProjectId(projectId);
      if (!background) setFetching(false);
      requestController.current = null;
    }
  }, [projectId]);

  useEffect(() => {
    void fetchWorktrees();
    // Branch switches made by an agent happen outside React. A lightweight
    // background refresh makes drift visible without requiring navigation or
    // a page reload, while keeping the existing list rendered during fetches.
    const timer = window.setInterval(() => {
      if (!document.hidden) void fetchWorktrees(true);
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      requestController.current?.abort();
      requestController.current = null;
      requestGeneration.current += 1;
    };
  }, [fetchWorktrees]);

  const refetch = useCallback(() => fetchWorktrees(false), [fetchWorktrees]);

  return {
    worktrees,
    loading: isWorktreesLoading(fetching, loadedProjectId, projectId),
    refetch,
  };
}
