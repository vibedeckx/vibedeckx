"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type MergeComparison,
  type MergeStatusPairEntry,
  type MergeStatusValue,
  type Worktree,
} from "@/lib/api";

export interface BranchMergeInfo {
  branch: string;
  status: MergeStatusValue;
  unmergedCount: number;
  dirty: boolean;
  target: string;
}

export function mergeTargetStorageKey(projectId: string, branch: string): string {
  return `vibedeckx:mergeTarget:${projectId}:${branch}`;
}

function readMergeTarget(projectId: string, branch: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(mergeTargetStorageKey(projectId, branch));
}

/** One comparison per branch, carrying its persisted target when set. Pure — exported for tests. */
export function buildComparisons(
  branches: string[],
  readTarget: (branch: string) => string | null,
): MergeComparison[] {
  return branches.map((branch) => {
    const target = readTarget(branch);
    return target ? { branch, target } : { branch };
  });
}

/** Branches whose PERSISTED target no longer exists — their stored keys should
 *  be cleared. Only explicit targets qualify; default-target failures
 *  (no-default-branch) and unrelated errors never clear keys. Pure — exported
 *  for tests. */
export function staleTargetBranches(
  comparisons: MergeComparison[],
  entries: MergeStatusPairEntry[],
): string[] {
  const explicit = new Set(comparisons.filter((c) => c.target !== undefined).map((c) => c.branch));
  return entries
    .filter((e) => e.error === "target-not-found" && explicit.has(e.branch))
    .map((e) => e.branch);
}

/** The backend-resolved default target: the resolved target of any pair sent
 *  without an explicit choice. Pure — exported for tests. */
export function deriveDefaultTarget(
  comparisons: MergeComparison[],
  entries: MergeStatusPairEntry[],
): string | null {
  const explicit = new Set(comparisons.filter((c) => c.target !== undefined).map((c) => c.branch));
  for (const entry of entries) {
    if (!explicit.has(entry.branch) && entry.target) return entry.target;
  }
  return null;
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

      const comparisons = buildComparisons(branches, (b) => readMergeTarget(projectId, b));
      const result = await api.getMergeStatus(projectId, comparisons);
      if (cancelled) return;
      if (!result.ok) return; // transport/server failure — keep previous statuses, touch nothing

      const next = new Map<string, BranchMergeInfo>();
      for (const entry of result.entries) {
        if (entry.error || !entry.target || !entry.status) continue;
        next.set(entry.branch, {
          branch: entry.branch,
          status: entry.status,
          unmergedCount: entry.unmergedCount ?? 0,
          dirty: entry.dirty ?? false,
          target: entry.target,
        });
      }

      const stale = staleTargetBranches(comparisons, result.entries);
      for (const branch of stale) {
        try {
          localStorage.removeItem(mergeTargetStorageKey(projectId, branch));
        } catch {
          // localStorage unavailable (e.g. Safari private mode) — skip.
        }
      }

      setStatuses(next);
      setDefaultTarget(deriveDefaultTarget(comparisons, result.entries));
      if (stale.length > 0) refetch(); // one-shot fallback: cleared branches re-fetch on the default
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

/** Workspace statuses that mean an agent is actively working on the branch. */
const ACTIVE_WORKSPACE_STATUSES = new Set(["working", "main-running"]);

/** Branch keys currently in an active status. Pure — exported for tests. */
export function activeBranchSet(
  statuses: ReadonlyMap<string, string> | undefined,
): Set<string> {
  const active = new Set<string>();
  if (!statuses) return active;
  for (const [branch, status] of statuses) {
    if (ACTIVE_WORKSPACE_STATUSES.has(status)) active.add(branch);
  }
  return active;
}

/** True when some branch was active before and no longer is. Pure — exported for tests. */
export function someActivityEnded(prev: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  for (const branch of prev) {
    if (!next.has(branch)) return true;
  }
  return false;
}

/** Collision-free serialization for effect deps — the main workspace's branch
 *  key is "" so a plain join("\n") cannot distinguish {} from {""}.
 *  Pure — exported for tests. */
export function serializeBranchSet(set: ReadonlySet<string>): string {
  return JSON.stringify(Array.from(set).sort());
}

export function deserializeBranchSet(key: string): Set<string> {
  return new Set(JSON.parse(key) as string[]);
}

/**
 * Live refresh triggers for merge status: refetch when an agent finishes a
 * turn (branch leaves the active set), on window focus, and on a 30s interval
 * while any branch is active. Quiet when nothing is running — the tip-SHA
 * cache makes redundant refetches nearly free.
 */
export function useMergeStatusAutoRefresh(
  refetch: () => void,
  workspaceStatuses: ReadonlyMap<string, string> | undefined,
): void {
  const prevActiveRef = useRef<Set<string>>(new Set());
  const active = activeBranchSet(workspaceStatuses);
  const anyActive = active.size > 0;
  // Serialize for stable effect deps (Set identity changes every render).
  const activeKey = serializeBranchSet(active);

  useEffect(() => {
    const next = deserializeBranchSet(activeKey);
    const prev = prevActiveRef.current;
    prevActiveRef.current = next;
    if (someActivityEnded(prev, next)) refetch();
  }, [activeKey, refetch]);

  useEffect(() => {
    const onFocus = () => refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(refetch, 30_000);
    return () => clearInterval(id);
  }, [anyActive, refetch]);
}
