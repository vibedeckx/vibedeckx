"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type ProjectChatThread } from "@/lib/api";

export interface UseProjectChatThreadHistoryResult {
  threads: ProjectChatThread[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  query: string;
  includeArchived: boolean;
  setQuery: (query: string) => void;
  showArchived: () => void;
  loadMore: () => Promise<void>;
}

function mergeUnique(
  current: ProjectChatThread[],
  incoming: ProjectChatThread[],
): ProjectChatThread[] {
  const seen = new Set<string>();
  return [...current, ...incoming].filter((thread) => {
    if (seen.has(thread.id)) return false;
    seen.add(thread.id);
    return true;
  });
}

export function useProjectChatThreadHistory(
  projectId: string,
  enabled: boolean,
  /**
   * Seeds the archived toggle so a caller can open straight into archived
   * threads. Read once, at mount — callers that need to switch intent should
   * remount the dialog rather than flip this underneath a live fetch.
   */
  initialIncludeArchived = false,
): UseProjectChatThreadHistoryResult {
  const [threads, setThreads] = useState<ProjectChatThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(initialIncludeArchived);
  const requestEpochRef = useRef(0);
  const loadMoreEpochRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scopeRef = useRef({ projectId, enabled, query, includeArchived });
  scopeRef.current = { projectId, enabled, query, includeArchived };

  useEffect(() => {
    requestEpochRef.current += 1;
    const epoch = requestEpochRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    loadMoreEpochRef.current = null;
    setLoadingMore(false);
    if (!enabled || !projectId) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setThreads([]);
    setNextCursor(null);
    setError(null);
    setLoading(true);
    void api.listProjectChatThreadPage(projectId, {
      includeArchived,
      ...(query.trim() ? { query: query.trim() } : {}),
      signal: controller.signal,
    }).then((page) => {
      if (controller.signal.aborted || requestEpochRef.current !== epoch) return;
      setThreads(mergeUnique([], page.threads));
      setNextCursor(page.nextCursor);
    }).catch((reason) => {
      if (controller.signal.aborted || requestEpochRef.current !== epoch) return;
      setError(reason instanceof Error ? reason.message : "Failed to load thread history");
    }).finally(() => {
      if (requestEpochRef.current === epoch) setLoading(false);
      if (abortRef.current === controller) abortRef.current = null;
    });

    return () => {
      controller.abort();
    };
  }, [enabled, includeArchived, projectId, query]);

  const loadMore = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope.enabled || !scope.projectId || !nextCursor || loading || loadingMore
      || loadMoreEpochRef.current !== null) return;
    const epoch = ++requestEpochRef.current;
    loadMoreEpochRef.current = epoch;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.listProjectChatThreadPage(scope.projectId, {
        includeArchived: scope.includeArchived,
        ...(scope.query.trim() ? { query: scope.query.trim() } : {}),
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted || requestEpochRef.current !== epoch
        || scopeRef.current.projectId !== scope.projectId
        || scopeRef.current.query !== scope.query
        || scopeRef.current.includeArchived !== scope.includeArchived) return;
      setThreads((current) => mergeUnique(current, page.threads));
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (!controller.signal.aborted && requestEpochRef.current === epoch) {
        setError(reason instanceof Error ? reason.message : "Failed to load more threads");
      }
    } finally {
      if (requestEpochRef.current === epoch) setLoadingMore(false);
      if (loadMoreEpochRef.current === epoch) loadMoreEpochRef.current = null;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [loading, loadingMore, nextCursor]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    threads,
    loading,
    loadingMore,
    error,
    nextCursor,
    query,
    includeArchived,
    setQuery,
    showArchived: useCallback(() => setIncludeArchived(true), []),
    loadMore,
  };
}
