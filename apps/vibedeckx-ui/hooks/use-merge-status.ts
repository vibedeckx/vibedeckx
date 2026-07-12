"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type MergeStatusEntry, type MergeStatusResult, type Worktree } from "@/lib/api";

export interface BranchMergeInfo extends MergeStatusEntry {
  target: string;
}

export function mergeTargetStorageKey(projectId: string, branch: string): string {
  return `vibedeckx:mergeTarget:${projectId}:${branch}`;
}

function readMergeTarget(projectId: string, branch: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(mergeTargetStorageKey(projectId, branch));
}

/** Group workspace branches by persisted target; null key = backend default. Pure — exported for tests. */
export function groupBranchesByTarget(
  branches: string[],
  readTarget: (branch: string) => string | null,
): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  for (const branch of branches) {
    const target = readTarget(branch);
    const list = groups.get(target) ?? [];
    list.push(branch);
    groups.set(target, list);
  }
  return groups;
}

/**
 * True only when a merge-status fetch for an *explicit* persisted target
 * fails with a genuine 400 (bad/deleted branch) — the signal that the
 * persisted target is stale and should be dropped. Any other failure
 * (network error, 401, 502, etc.) or a fetch for the default target (no
 * explicit target set, so nothing to clean up) leaves the persisted choice
 * alone. Pure — exported for tests.
 */
export function shouldClearStaleTarget(result: MergeStatusResult, target: string | null): boolean {
  return !result.ok && result.status === 400 && target !== null;
}

/**
 * Merge status per workspace branch, fetched once per distinct target.
 * Refreshes whenever the worktree list identity changes (same cadence as
 * useWorktrees) or after setTarget.
 */
export function useMergeStatus(projectId: string | null, worktrees: Worktree[]) {
  const [statuses, setStatuses] = useState<Map<string, BranchMergeInfo>>(new Map());
  const [defaultTarget, setDefaultTarget] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  // Depends on the worktrees array identity: useWorktrees replaces it on every
  // fetch, so merge status refreshes on the same cadence (spec requirement).
  useEffect(() => {
    const branches = worktrees
      .map((w) => w.branch)
      .filter((b): b is string => b !== null);
    let cancelled = false;

    (async () => {
      if (!projectId || branches.length === 0) {
        if (!cancelled) {
          setStatuses(new Map());
          setDefaultTarget(null);
        }
        return;
      }

      const groups = groupBranchesByTarget(branches, (b) => readMergeTarget(projectId, b));
      const next = new Map<string, BranchMergeInfo>();
      let nextDefault: string | null = null;
      let clearedStaleTarget = false;

      await Promise.all(
        Array.from(groups.entries()).map(async ([target, groupBranches]) => {
          const result = await api.getMergeStatus(projectId, target ?? undefined);
          if (!result.ok) {
            // Only a genuine 400 for an explicit persisted target means the
            // target itself is bad (e.g. branch deleted since it was chosen).
            // Any other failure (network blip, 401 during token refresh, 502
            // from an offline remote) must not wipe the user's choice.
            if (shouldClearStaleTarget(result, target) && !cancelled) {
              clearedStaleTarget = true;
              for (const b of groupBranches) {
                localStorage.removeItem(mergeTargetStorageKey(projectId, b));
              }
            }
            return;
          }
          const resp = result.data;
          if (!target) nextDefault = resp.target;
          for (const entry of resp.entries) {
            // The backend reports every worktree branch for the requested
            // target; keep only the branches that chose this target.
            if (groupBranches.includes(entry.branch)) {
              next.set(entry.branch, { ...entry, target: resp.target });
            }
          }
        }),
      );

      if (!cancelled) {
        setStatuses(next);
        setDefaultTarget(nextDefault);
        // Branches whose stale target we just cleared fall back to the
        // default group on the next fetch — trigger it now so they don't
        // stay badge-less until an unrelated refresh. A 400 on the default
        // group itself (target === null) never sets clearedStaleTarget, so
        // this can't loop forever.
        if (clearedStaleTarget) refetch();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, worktrees, nonce, refetch]);

  const setTarget = useCallback(
    (branch: string, target: string | null) => {
      if (!projectId) return;
      try {
        if (target) {
          localStorage.setItem(mergeTargetStorageKey(projectId, branch), target);
        } else {
          localStorage.removeItem(mergeTargetStorageKey(projectId, branch));
        }
      } catch {
        // ignore quota / privacy-mode errors
      }
      refetch();
    },
    [projectId, refetch],
  );

  return { statuses, defaultTarget, setTarget, refetch };
}
