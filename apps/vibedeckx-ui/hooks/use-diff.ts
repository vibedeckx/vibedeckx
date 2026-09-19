'use client';

import { useState, useCallback, useRef } from 'react';
import { api, type DiffResponse } from '@/lib/api';

export function useDiff(projectId: string | null, branch?: string | null, commit?: string | null, target?: 'local' | 'remote', compareTo?: string | null) {
  // A result is tagged with the workspace it was fetched for: after a
  // workspace switch the previous workspace's diff is never shown as this
  // one's — the panel reads as loading until its own answer lands.
  const workspace = `${projectId ?? ''}::${branch ?? ''}`;
  const [result, setResult] = useState<{ workspace: string; diff: DiffResponse | null; error: string | null } | null>(null);
  const [fetching, setFetching] = useState(false);
  // Only the latest request may write; an older one answering late would
  // otherwise overwrite a newer workspace's (or commit's) diff.
  const latestRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++latestRequestRef.current;
    if (!projectId) {
      setResult({ workspace, diff: null, error: null });
      setFetching(false);
      return;
    }

    setFetching(true);

    try {
      const diff = await api.getDiff(projectId, branch, commit, target, compareTo);
      if (requestId !== latestRequestRef.current) return;
      setResult({ workspace, diff, error: null });
    } catch (err) {
      if (requestId !== latestRequestRef.current) return;
      setResult({ workspace, diff: null, error: err instanceof Error ? err.message : 'Failed to load diff' });
    } finally {
      if (requestId === latestRequestRef.current) setFetching(false);
    }
  }, [projectId, branch, commit, target, compareTo, workspace]);

  const current = result?.workspace === workspace ? result : null;

  return {
    diff: current?.diff ?? null,
    loading: fetching || current === null,
    error: current?.error ?? null,
    refresh,
  };
}
