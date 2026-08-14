// @vitest-environment jsdom
//
// Page-lifetime worktree-list cache: revisiting a project seeds its list
// synchronously (stale=false) so cross-project navigation can apply a staged
// workspace/session selection without waiting for the network; the regular
// fetch still revalidates. Project ids are unique per test — the cache is
// module-level and survives across tests in this file.
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "@/lib/api";

const getProjectWorktrees = vi.hoisted(() =>
  vi.fn(async (projectId: string): Promise<Worktree[]> => [{ branch: null }]),
);

vi.mock("@/lib/api", () => ({ api: { getProjectWorktrees } }));
vi.mock("@/hooks/global-event-stream", () => ({ useGlobalEventStream: () => {} }));

import { useWorktrees } from "./use-worktrees";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookApi = ReturnType<typeof useWorktrees>;
let latest: HookApi | null = null;
// One snapshot per COMMIT. Consumers (page.tsx's pending-apply effect) decide
// per commit, so assertions about "never exposed" states must look here, not
// at the post-act value.
let commits: Array<{ loading: boolean; stale: boolean }> = [];

function Probe({ projectId, agentMode }: { projectId: string | null; agentMode?: string | null }) {
  const hook = useWorktrees(projectId, null, agentMode);
  latest = hook;
  useEffect(() => {
    commits.push({ loading: hook.loading, stale: hook.stale });
  });
  return null;
}

describe("useWorktrees list cache", () => {
  let root: Root;
  let container: HTMLElement;

  const render = async (projectId: string | null, agentMode?: string | null) => {
    await act(async () => {
      root.render(<Probe projectId={projectId} agentMode={agentMode} />);
      await Promise.resolve();
    });
  };

  const listsByProject = (lists: Record<string, Worktree[]>) => {
    getProjectWorktrees.mockImplementation(async (projectId: string) =>
      lists[projectId] ?? [{ branch: null }],
    );
  };

  beforeEach(() => {
    getProjectWorktrees.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = null;
  });

  it("seeds a revisited project's list from cache while revalidating", async () => {
    listsByProject({
      a1: [{ branch: null }, { branch: "dev6" }],
      a2: [{ branch: null }],
    });
    await render("a1");
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "dev6" }]);
    await render("a2");

    // Hang the network: only the cache can produce a usable list.
    getProjectWorktrees.mockImplementation(() => new Promise<never>(() => {}));
    await render("a1");
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "dev6" }]);
    expect(latest!.stale).toBe(false);
    expect(latest!.loading).toBe(true); // revalidation in flight
  });

  it("keeps the retained list marked stale for a never-visited project", async () => {
    listsByProject({ b1: [{ branch: null }, { branch: "feat" }] });
    await render("b1");

    getProjectWorktrees.mockImplementation(() => new Promise<never>(() => {}));
    await render("b2");
    // The previous project's list is retained (existing behavior) but must
    // never be trusted for b2.
    expect(latest!.stale).toBe(true);
    expect(latest!.loading).toBe(true);
  });

  it("revalidation replaces a seeded list with the fresh one", async () => {
    listsByProject({
      c1: [{ branch: null }, { branch: "old" }],
      c2: [{ branch: null }],
    });
    await render("c1");
    await render("c2");

    listsByProject({
      c1: [{ branch: null }, { branch: "old" }, { branch: "new" }],
      c2: [{ branch: null }],
    });
    await render("c1");
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "old" }, { branch: "new" }]);
    expect(latest!.loading).toBe(false);
  });

  it("never exposes an authoritative list while a seeded cache awaits revalidation", async () => {
    // The dangerous window: the cache predates a branch the user is jumping
    // to. page.tsx's pending-apply effect DROPS a staged selection on any
    // commit where the list is non-stale AND settled (loading=false) AND
    // missing the target — so no such commit may exist between the seed and
    // the fresh fetch settling.
    listsByProject({ e1: [{ branch: null }], e2: [{ branch: null }] });
    await render("e1");
    await render("e2");

    let resolveFetch!: (worktrees: Worktree[]) => void;
    getProjectWorktrees.mockImplementation(
      () => new Promise<Worktree[]>((resolve) => { resolveFetch = resolve; }),
    );
    commits = [];
    await render("e1"); // seeded from a cache that lacks "newbranch"
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.filter((c) => !c.stale && !c.loading)).toEqual([]);

    await act(async () => {
      resolveFetch([{ branch: null }, { branch: "newbranch" }]);
    });
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "newbranch" }]);
    expect(latest!.loading).toBe(false);
  });

  it("a prior visit's validation cannot authorize a failed revalidation (A→B→A)", async () => {
    // validatedScope is per-VISIT: A validating earlier this page lifetime
    // says nothing about branches created while the user was away on B, so a
    // failed return-visit revalidation must not re-arm the DROP path.
    listsByProject({
      g1: [{ branch: null }, { branch: "dev" }],
      g2: [{ branch: null }],
    });
    await render("g1"); // A validates
    getProjectWorktrees.mockRejectedValue(new Error("tunnel down"));
    await render("g2"); // B fails — never validated

    commits = [];
    await render("g1"); // back to A: seeded, revalidation fails
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "dev" }]);
    expect(latest!.stale).toBe(false);
    expect(latest!.loading).toBe(true);
    expect(commits.filter((c) => !c.stale && !c.loading)).toEqual([]);

    // Only a success in the CURRENT visit restores authority.
    listsByProject({ g1: [{ branch: null }, { branch: "dev" }, { branch: "new" }] });
    await act(async () => {
      await latest!.refetch();
    });
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "dev" }, { branch: "new" }]);
    expect(latest!.loading).toBe(false);
  });

  it("distrusts the list across an agent_mode switch (per-target scoping)", async () => {
    // Cross-target same-project jump: the worktree list on hand belongs to the
    // PREVIOUS target. Trusting it would let page.tsx's auto-select stomp a
    // just-applied branch that only exists on the new target.
    listsByProject({ f1: [{ branch: null }, { branch: "local-only" }] });
    await render("f1", "local");
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "local-only" }]);

    let resolveFetch!: (worktrees: Worktree[]) => void;
    getProjectWorktrees.mockImplementation(
      () => new Promise<Worktree[]>((resolve) => { resolveFetch = resolve; }),
    );
    commits = [];
    await render("f1", "remote-1");
    // No commit may present the local list as authoritative for the remote target.
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.filter((c) => !c.stale && !c.loading)).toEqual([]);

    await act(async () => {
      resolveFetch([{ branch: null }, { branch: "remote-only" }]);
    });
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "remote-only" }]);
    expect(latest!.loading).toBe(false);

    // The cache is scoped per target too: coming back to local seeds the
    // local list, not the remote one.
    getProjectWorktrees.mockImplementation(() => new Promise<never>(() => {}));
    await render("f1", "local");
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "local-only" }]);
    expect(latest!.stale).toBe(false);
    expect(latest!.loading).toBe(true); // revalidation in flight
  });

  it("keeps the seeded list non-authoritative when revalidation fails", async () => {
    listsByProject({
      d1: [{ branch: null }, { branch: "dev" }],
      d2: [{ branch: null }],
    });
    await render("d1");
    await render("d2");

    getProjectWorktrees.mockRejectedValue(new Error("tunnel down"));
    commits = [];
    await render("d1");
    // The seed survives the failure (better answer than the stub) and may
    // still APPLY a pending selection…
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "dev" }]);
    expect(latest!.stale).toBe(false);
    // …but a failed fetch must never authorize it: page.tsx's pending-apply
    // effect DROPS a staged branch on any !stale && !loading commit, and the
    // cache may simply predate that branch. No such commit may exist — not
    // during the attempt, and not after the failure settles.
    expect(latest!.loading).toBe(true);
    expect(commits.filter((c) => !c.stale && !c.loading)).toEqual([]);

    // A later successful fetch is what settles authority.
    listsByProject({ d1: [{ branch: null }, { branch: "dev" }, { branch: "new" }] });
    await act(async () => {
      await latest!.refetch();
    });
    expect(latest!.worktrees).toEqual([{ branch: null }, { branch: "dev" }, { branch: "new" }]);
    expect(latest!.loading).toBe(false);
  });
});
