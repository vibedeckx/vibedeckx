"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type MergeStatusEntry, type Worktree } from "@/lib/api";

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

      await Promise.all(
        Array.from(groups.entries()).map(async ([target, groupBranches]) => {
          const resp = await api.getMergeStatus(projectId, target ?? undefined);
          if (!resp) {
            // Explicit target failed (e.g. branch deleted since it was chosen) —
            // drop the stale persisted choice; the next refresh uses the default.
            if (target) {
              for (const b of groupBranches) {
                localStorage.removeItem(mergeTargetStorageKey(projectId, b));
              }
            }
            return;
          }
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
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, worktrees, nonce]);

  const setTarget = useCallback(
    (branch: string, target: string | null) => {
      if (!projectId) return;
      if (target) {
        localStorage.setItem(mergeTargetStorageKey(projectId, branch), target);
      } else {
        localStorage.removeItem(mergeTargetStorageKey(projectId, branch));
      }
      refetch();
    },
    [projectId, refetch],
  );

  return { statuses, defaultTarget, setTarget, refetch };
}
