'use client';

import { useState, useCallback } from 'react';
import { api, type DiffResponse } from '@/lib/api';

export function useDiff(projectId: string | null, branch?: string | null, commit?: string | null, target?: 'local' | 'remote') {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setDiff(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await api.getDiff(projectId, branch, commit, target);
      setDiff(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diff');
      setDiff(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, branch, commit, target]);

  return {
    diff,
    loading,
    error,
    refresh,
  };
}
