"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Worktree } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

export const WORKTREE_DRIFT_BACKSTOP_MS = 5 * 60_000;

/**
 * True while the worktree list can't be trusted for `scope` — a fetch is in
 * flight, or no fetch for this scope (project + target) has SUCCEEDED yet.
 * Pure — exported for tests.
 *
 * The second clause is what closes the cross-project navigation race: a
 * `setFetching(true)` from the fetch effect isn't visible to sibling effects
 * in the same commit, so a flag alone would let page.tsx's auto-select effect
 * consume a pending workspace selection against the PREVIOUS scope's
 * worktrees and fall back to the main workspace. Deriving loading from the
 * last-validated scope holds in the very render the scope changes — and keeps
 * a failed revalidation (kept seed / error stub) non-authoritative, so a
 * transient tunnel failure can never justify DROPPING a pending selection.
 */
export function isWorktreesLoading(
  fetching: boolean,
  validatedScope: string | null,
  scope: string | null,
): boolean {
  return fetching || validatedScope !== scope;
}

export function worktreesEqual(left: Worktree[], right: Worktree[]): boolean {
  return left.length === right.length && left.every((worktree, index) =>
    worktree.branch === right[index].branch
    && worktree.currentBranch === right[index].currentBranch
    && worktree.expectedBranch === right[index].expectedBranch
  );
}

/** Keep a selected workspace reachable when an old worker renames it on a background refresh. */
export function preserveSelectedWorkspace(
  previous: Worktree[],
  incoming: Worktree[],
  selectedBranch: string | null | undefined,
): Worktree[] {
  if (selectedBranch === undefined || incoming.some((worktree) => worktree.branch === selectedBranch)) {
    return incoming;
  }
  const previousIndex = previous.findIndex((worktree) => worktree.branch === selectedBranch);
  if (previousIndex < 0) return incoming;
  const preserved = [...incoming];
  preserved.splice(Math.min(previousIndex, preserved.length), 0, previous[previousIndex]);
  return preserved;
}

// Page-lifetime cache of the last fetched worktree list per scope
// (project + agent target). A revisited scope is seeded from it synchronously
// (render-phase, below), so cross-project navigation can apply a staged
// workspace/session selection immediately instead of waiting a network
// round-trip (remote projects list worktrees over the tunnel); the regular
// fetch then revalidates. Values are server truth from the last completed
// fetch — never the preserveSelectedWorkspace hybrid.
const worktreeListCache = new Map<string, Worktree[]>();

export function useWorktrees(
  projectId: string | null,
  selectedBranch?: string | null,
  agentMode?: string | null,
) {
  // Worktree lists are per (project, target): the server routes the fetch by
  // the project's CURRENT agent_mode, so a mode switch must invalidate the
  // list on hand — otherwise navigation gets validated against the previous
  // target's branches.
  const scope = projectId ? `${projectId}::${agentMode ?? "local"}` : null;
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [fetching, setFetching] = useState(true);
  // The scope the current `worktrees` list was fetched for (ownership: drives
  // `stale`, seed reuse, and the error-stub decision).
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  // The scope whose fetch last SUCCEEDED (authority: drives `loading`). A
  // failed revalidation settles `fetching` but never validates, so consumers
  // keep treating the kept seed / error stub as non-authoritative.
  const [validatedScope, setValidatedScope] = useState<string | null>(null);
  // Mirror for reads inside fetchWorktrees: its deps must stay [projectId,
  // scope] (the fetch effect keys off its identity), so the state value would
  // be a stale closure there.
  const loadedScopeRef = useRef<string | null>(null);
  const markLoadedFor = (s: string | null) => {
    loadedScopeRef.current = s;
    setLoadedScope(s);
  };

  // Seed a revisited scope's list from cache DURING render — same pattern
  // as page.tsx's render-phase branch reset — so sibling effects in the very
  // first commit after a project switch already see a non-stale list.
  const [seededScope, setSeededScope] = useState<string | null>(null);
  if (scope !== seededScope) {
    setSeededScope(scope);
    // Authority never survives a scope switch — even back to a scope that
    // validated earlier this page lifetime: branches created while we were
    // away wouldn't be in that old result, so DROP decisions must wait for a
    // success in the CURRENT visit. (Same-scope failures don't clear this,
    // so a refresh failing after this visit's success keeps authority.)
    setValidatedScope(null);
    const cached = scope ? worktreeListCache.get(scope) : undefined;
    if (cached) {
      setWorktrees(cached);
      markLoadedFor(scope);
      // The project-change revalidation is about to start, but the fetch
      // effect's own setFetching(true) is invisible to sibling effects in
      // this first commit. Set it here, synchronously, or that commit exposes
      // (stale=false, loading=false) — an "authoritative" list — and
      // page.tsx's pending-apply effect would DROP a staged branch that is
      // newer than this cache instead of waiting for the fresh list.
      setFetching(true);
    }
  }
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const previousSelectionRef = useRef<{ projectId: string | null; branch: string | null | undefined } | null>(null);
  const selectedBranchRef = useRef(selectedBranch);
  selectedBranchRef.current = selectedBranch;

  const fetchWorktrees = useCallback(async (background = false) => {
    if (background && requestController.current) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const generation = requestGeneration.current;
    if (!projectId || !scope) {
      requestController.current = null;
      setWorktrees([]);
      markLoadedFor(null);
      setValidatedScope(null);
      setFetching(false);
      return;
    }

    if (!background) setFetching(true);
    try {
      const data = await api.getProjectWorktrees(projectId, undefined, controller.signal);
      if (generation !== requestGeneration.current) return;
      worktreeListCache.set(scope, data);
      setValidatedScope(scope);
      setWorktrees((previous) => {
        const next = background
          ? preserveSelectedWorkspace(previous, data, selectedBranchRef.current)
          : data;
        return worktreesEqual(previous, next) ? previous : next;
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      if (error instanceof Error && error.name === "AbortError") return;
      console.error("Failed to fetch worktrees:", error);
      // A background health refresh must not erase a valid workspace list on a
      // transient network failure — and neither should a failed revalidation
      // of a cache-seeded list (the seed is a better answer than the stub).
      if (!background && loadedScopeRef.current !== scope) {
        setWorktrees([{ branch: null }]);
      }
    } finally {
      if (generation !== requestGeneration.current || requestController.current !== controller) return;
      markLoadedFor(scope);
      if (!background) setFetching(false);
      requestController.current = null;
    }
  }, [projectId, scope]);

  useEffect(() => {
    void fetchWorktrees();
    return () => {
      requestController.current?.abort();
      requestController.current = null;
      requestGeneration.current += 1;
    };
  }, [fetchWorktrees]);

  // Selecting another workspace is a natural point to verify its physical
  // checkout. Do not duplicate the initial/scope-change fetch above.
  useEffect(() => {
    const previous = previousSelectionRef.current;
    previousSelectionRef.current = { projectId: scope, branch: selectedBranch };
    if (
      previous
      && previous.projectId === scope
      && previous.branch !== selectedBranch
    ) {
      void fetchWorktrees(true);
    }
  }, [scope, selectedBranch, fetchWorktrees]);

  // Agent turns and executors are the normal sources of Git changes. Refresh
  // when they finish instead of spawning Git processes every few seconds.
  useGlobalEventStream((event) => {
    if (!projectId || event.projectId !== projectId) return;
    const terminalSessionStatus = event.type === "session:status"
      && (event.status === "stopped" || event.status === "error");
    if (
      event.type === "session:taskCompleted"
      || event.type === "executor:stopped"
      || terminalSessionStatus
    ) {
      void fetchWorktrees(true);
    }
  });

  // External Git commands may not produce an app event. Refresh immediately
  // when the user returns, then retain a low-frequency visible-tab backstop.
  useEffect(() => {
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => void fetchWorktrees(true), WORKTREE_DRIFT_BACKSTOP_MS);
    };
    const onFocus = () => void fetchWorktrees(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchWorktrees(true);
        start();
      } else {
        stop();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (document.visibilityState === "visible") start();
    return () => {
      stop();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchWorktrees]);

  const refetch = useCallback(() => fetchWorktrees(false), [fetchWorktrees]);

  return {
    worktrees,
    loading: isWorktreesLoading(fetching, validatedScope, scope),
    // Narrower than `loading`: true only while the list on hand belongs to a
    // DIFFERENT scope (the cross-project/cross-target navigation window).
    // Same-scope refetches keep it false, so consumers can gate selection
    // highlights on it without blinking them on every refresh.
    stale: loadedScope !== scope,
    refetch,
  };
}
