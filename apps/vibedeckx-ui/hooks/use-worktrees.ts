"use client";

import { useState, useEffect, useCallback } from "react";
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

export function useWorktrees(projectId: string | null) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [fetching, setFetching] = useState(true);
  // The project the current `worktrees` list was fetched for.
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);

  const fetchWorktrees = useCallback(async () => {
    if (!projectId) {
      setWorktrees([]);
      setLoadedProjectId(null);
      setFetching(false);
      return;
    }

    setFetching(true);
    try {
      const data = await api.getProjectWorktrees(projectId);
      setWorktrees(data);
    } catch (error) {
      console.error("Failed to fetch worktrees:", error);
      setWorktrees([{ branch: null }]);
    } finally {
      setLoadedProjectId(projectId);
      setFetching(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchWorktrees();
  }, [fetchWorktrees]);

  return {
    worktrees,
    loading: isWorktreesLoading(fetching, loadedProjectId, projectId),
    refetch: fetchWorktrees,
  };
}
