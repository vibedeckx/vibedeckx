"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useDeferredValue } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { searchFiles, type FuzzyResult } from "@/lib/fuzzy";

interface UseFileSearchOptions {
  projectId: string | null;
  branch?: string | null;
  target?: "local" | "remote";
}

// Owns the flat file list for the file finder, decoupled from the lazy file
// tree so the tree's expand state is untouched. The list is fetched lazily on
// the first search interaction and cached until project / branch / target
// change (or an explicit refresh).
export function useFileSearch({ projectId, branch, target }: UseFileSearchOptions) {
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  // Bumped on every fetch so stale responses (after a branch switch) are dropped.
  const fetchKeyRef = useRef(0);

  // Invalidate the cache when the source changes so switching branch re-fetches
  // that worktree's files.
  useEffect(() => {
    setAllFiles([]);
    setTruncated(false);
    setLoaded(false);
    setLoading(false);
    setQuery("");
    fetchKeyRef.current++;
  }, [projectId, branch, target]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    const key = ++fetchKeyRef.current;
    try {
      const result = await api.listProjectFiles(projectId, branch, target);
      if (key !== fetchKeyRef.current) return;
      setAllFiles(result.files);
      setTruncated(result.truncated);
      setLoaded(true);
    } catch (err) {
      if (key !== fetchKeyRef.current) return;
      setAllFiles([]);
      setLoaded(false);
      toast.error("Failed to load file list", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (key === fetchKeyRef.current) setLoading(false);
    }
  }, [projectId, branch, target]);

  // Lazy fetch on first search interaction; no-op once loaded or in flight.
  const ensureLoaded = useCallback(() => {
    if (loaded || loading) return;
    void load();
  }, [loaded, loading, load]);

  // Invalidate the cache (wired to the Files "Refresh" button); re-fetches
  // immediately when a search is currently open.
  const refresh = useCallback(() => {
    setLoaded(false);
    fetchKeyRef.current++;
    if (query) void load();
  }, [query, load]);

  const deferredQuery = useDeferredValue(query);
  const results = useMemo<FuzzyResult[]>(
    () => searchFiles(allFiles, deferredQuery, 50),
    [allFiles, deferredQuery],
  );

  return {
    query,
    setQuery,
    results,
    truncated,
    loading,
    loaded,
    ensureLoaded,
    refresh,
  };
}
