"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type Worktree } from "@/lib/api";

export function useWorktrees(projectId: string | null) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchWorktrees = useCallback(async () => {
    if (!projectId) {
      setWorktrees([]);
      setLoading(false);
      return;
    }

    // Flag loading synchronously (before the await) so callers gating on
    // `loading` — e.g. page.tsx's auto-select effect — don't act on the
    // previous project's worktrees during a project switch. Without this, a
    // cross-project notification's pending branch gets consumed against stale
    // worktrees and the selection falls back to the main workspace.
    setLoading(true);
    try {
      const data = await api.getProjectWorktrees(projectId);
      setWorktrees(data);
    } catch (error) {
      console.error("Failed to fetch worktrees:", error);
      setWorktrees([{ branch: null }]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchWorktrees();
  }, [fetchWorktrees]);

  return { worktrees, loading, refetch: fetchWorktrees };
}
