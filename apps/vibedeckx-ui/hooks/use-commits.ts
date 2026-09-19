'use client';

import { useState, useCallback, useRef } from 'react';
import { api, type CommitEntry } from '@/lib/api';

const NO_COMMITS: CommitEntry[] = [];

export function useCommits(projectId: string | null, branch?: string | null, limit?: number, target?: 'local' | 'remote') {
  // Tagged with the workspace they were fetched for, same as useDiff: a
  // workspace switch must not list the previous workspace's commits.
  const workspace = `${projectId ?? ''}::${branch ?? ''}`;
  const [result, setResult] = useState<{ workspace: string; commits: CommitEntry[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const latestRequestRef = useRef(0);

  const refetch = useCallback(async () => {
    const requestId = ++latestRequestRef.current;
    if (!projectId) {
      setResult({ workspace, commits: NO_COMMITS });
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const commits = await api.getCommits(projectId, branch, limit, target);
      if (requestId !== latestRequestRef.current) return;
      setResult({ workspace, commits });
    } catch {
      if (requestId !== latestRequestRef.current) return;
      setResult({ workspace, commits: NO_COMMITS });
    } finally {
      if (requestId === latestRequestRef.current) setLoading(false);
    }
  }, [projectId, branch, limit, target, workspace]);

  return {
    commits: result?.workspace === workspace ? result.commits : NO_COMMITS,
    loading,
    refetch,
  };
}
