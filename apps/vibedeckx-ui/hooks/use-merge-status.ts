"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ProjectMergeStatusPairEntry,
  type MergeStatusValue,
  type TargetSource,
  type Worktree,
} from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

export type BranchMergeInfo =
  | {
      branch: string;
      status: MergeStatusValue;
      unmergedCount: number;
      dirty: boolean;
      target: string;
      error?: undefined;
    }
  | {
      branch: string;
      error: "target-not-found";
      requestedTarget: string;
      targetSource: TargetSource;
      /** Temporary type compatibility for consumers until they wire the error discriminant. */
      target?: undefined;
      status?: undefined;
      unmergedCount?: undefined;
      dirty?: undefined;
    };

export function effectiveTarget(info: BranchMergeInfo | undefined): string | null {
  if (!info) return null;
  return info.error === "target-not-found" ? info.requestedTarget : info.target;
}

export function buildStatusMap(
  entries: ProjectMergeStatusPairEntry[],
): Map<string, BranchMergeInfo> {
  const statuses = new Map<string, BranchMergeInfo>();
  for (const entry of entries) {
    if (entry.error === "target-not-found" && entry.requestedTarget) {
      statuses.set(entry.branch, {
        branch: entry.branch,
        error: entry.error,
        requestedTarget: entry.requestedTarget,
        targetSource: entry.targetSource,
      });
      continue;
    }
    if (entry.error || !entry.target || !entry.status) continue;
    statuses.set(entry.branch, {
      branch: entry.branch,
      status: entry.status,
      unmergedCount: entry.unmergedCount ?? 0,
      dirty: entry.dirty ?? false,
      target: entry.target,
    });
  }
  return statuses;
}

/** The first target that the backend resolved from the repository default. */
export function deriveDefaultTarget(entries: ProjectMergeStatusPairEntry[]): string | null {
  for (const entry of entries) {
    if (entry.targetSource === "default" && entry.target) return entry.target;
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
  const [repositoryLabel, setRepositoryLabel] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [seenProjectId, setSeenProjectId] = useState(projectId);

  // Project switch: drop the old project's statuses immediately — the
  // keep-on-failure behavior below must never carry badges across projects
  // (same-named branches like dev1/main would show the wrong project's state).
  if (projectId !== seenProjectId) {
    setSeenProjectId(projectId);
    setStatuses(new Map());
    setDefaultTarget(null);
    setRepositoryLabel(null);
  }

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
          setRepositoryLabel(null);
        }
        return;
      }

      const comparisons = branches.map((branch) => ({ branch }));
      const result = await api.getMergeStatus(projectId, comparisons);
      if (cancelled) return;
      if (!result.ok) return; // transport/server failure — keep previous statuses, touch nothing

      setStatuses(buildStatusMap(result.entries));
      setDefaultTarget(deriveDefaultTarget(result.entries));
      setRepositoryLabel(result.repository.label);
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, worktrees, nonce, refetch]);

  const setTarget = useCallback(
    (branch: string, target: string | null) => {
      if (!projectId) return;
      void api.setMergeTarget(projectId, branch, target).then((ok) => {
        if (ok) refetch();
      });
    },
    [projectId, refetch],
  );

  return { statuses, defaultTarget, repositoryLabel, setTarget, refetch };
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
 * turn (branch leaves the active set), on window focus, when an executor for
 * this project stops, and on a visible-tab backstop poll (30s active / 60s
 * idle, fully stopped while the tab is hidden). The tip-SHA cache makes
 * redundant refetches nearly free.
 */
export function useMergeStatusAutoRefresh(
  refetch: () => void,
  workspaceStatuses: ReadonlyMap<string, string> | undefined,
  projectId: string | null,
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

  // Executor runs (rebase/merge scripts) are not in the workspace active set,
  // so their finish must be its own trigger. Local and remote executors both
  // emit executor:stopped with projectId on the /api/events stream.
  useGlobalEventStream((evt) => {
    if (evt.type === "executor:stopped" && evt.projectId === projectId) {
      refetch();
    }
    if (
      evt.type === "merge-target:updated" &&
      projectId !== null &&
      evt.projectId === projectId
    ) {
      refetch();
    }
  });

  // Backstop poll: catches git operations no event covers (e.g. the user
  // rebasing in the app's built-in terminal — window already focused, so the
  // focus trigger never fires). 30s while an agent is active, 60s otherwise;
  // completely quiet while the tab is hidden. The window-focus listener
  // (above) handles the immediate refresh when the user returns, so becoming
  // visible only restarts the interval without an extra refetch.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    const start = () => {
      stop();
      interval = setInterval(refetch, anyActive ? 30_000 : 60_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refetch, anyActive]);
}
