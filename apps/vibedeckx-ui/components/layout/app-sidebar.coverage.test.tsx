// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Worktree } from "@/lib/api";
import type { BranchMergeInfo } from "@/hooks/use-merge-status";

import { AppSidebar } from "./app-sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: Project = {
  id: "p1",
  name: "echo-read-app",
  path: null,
  is_remote: true,
  agent_mode: "server-1",
  executor_mode: "server-1",
  created_at: "2026-09-08T00:00:00Z",
};

const partial: Worktree = {
  branch: "dev",
  machines: [
    { serverId: "server-1", name: "worker3", state: "present" },
    { serverId: "server-2", name: "Mac", state: "absent" },
    { serverId: "server-3", name: "ubuntu", state: "absent", deleted: true },
    { serverId: "server-4", name: "gpu", state: "present" },
  ],
};

describe("AppSidebar workspace coverage", () => {
  let container: HTMLElement;
  let root: Root;
  const onManageWorkspaceRemotes = vi.fn();
  const onDeleteWorktree = vi.fn();
  const onBranchChange = vi.fn();

  const render = (
    worktrees: Worktree[],
    extra?: {
      staleRemoteName?: string | null;
      activeRemoteInvalid?: boolean;
      mergeStatuses?: Map<string, BranchMergeInfo>;
      mergeRepositoryServerId?: string | null;
    },
  ) =>
    act(() => {
      root.render(
        <AppSidebar
          activeView="workspace"
          onViewChange={() => {}}
          worktrees={worktrees}
          selectedBranch={null}
          currentProject={project}
          onBranchChange={onBranchChange}
          onManageWorkspaceRemotes={onManageWorkspaceRemotes}
          onDeleteWorktree={onDeleteWorktree}
          staleRemoteName={extra?.staleRemoteName}
          activeRemoteInvalid={extra?.activeRemoteInvalid}
          mergeStatuses={extra?.mergeStatuses}
          mergeRepositoryServerId={extra?.mergeRepositoryServerId}
        />,
      );
    });

  const badge = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label$="remotes"]');

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("counts the machines that have it, and the count is the way to manage the rest", () => {
    render([{ branch: null }, partial]);

    const marker = badge();
    expect(marker).toBeTruthy();
    expect(marker!.textContent).toBe("2/4");
    expect(marker!.getAttribute("aria-label")).toBe("dev exists on 2 of 4 remotes");
    // The count is the row's only marker: no second icon for the gap.
    expect(container.querySelectorAll("button svg.lucide-triangle-alert").length).toBe(0);

    act(() => marker!.click());
    expect(onManageWorkspaceRemotes).toHaveBeenCalledWith(partial);
    // The row itself was not selected by clicking the badge.
    expect(onBranchChange).not.toHaveBeenCalled();
  });

  it("shows nothing, and reserves nothing, when every machine has it", () => {
    render([
      { branch: null },
      {
        branch: "dev",
        machines: [
          { serverId: "server-1", name: "worker3", state: "present" },
          { serverId: "server-2", name: "Mac", state: "present" },
        ],
      },
    ]);

    expect(badge()).toBeNull();
  });

  it("does not count an unplaced machine as a gap, nor a row from an older server", () => {
    render([
      { branch: null },
      {
        branch: "dev",
        machines: [
          { serverId: "server-1", name: "worker3", state: "present" },
          { serverId: "server-2", name: "Mac", state: "unknown" },
        ],
      },
      { branch: "old" },
    ]);

    expect(badge()).toBeNull();
  });

  it("counts a failed machine as a gap, with no second marker for the failure", () => {
    // A machine that kept a reason is one the workspace is not usable on, so
    // it shows in the count like a missing one; the reason is in the tooltip
    // and the retry is in the management the count opens. Before this, a
    // failure had its own amber icon beside the count, one more thing to read.
    render([
      { branch: null },
      {
        branch: "dev",
        machines: [
          { serverId: "server-1", name: "worker3", state: "present" },
          { serverId: "server-2", name: "Mac", state: "error", error: "disk full" },
        ],
        targets: [
          { targetId: "server-1", label: "worker3", state: "present", status: "ready" },
          { targetId: "server-2", label: "Mac", state: "present", status: "error", error: "disk full" },
        ],
      },
    ]);

    const count = badge();
    expect(count?.textContent).toBe("1/2");
    expect(container.querySelectorAll("button svg.lucide-triangle-alert").length).toBe(0);
    expect(container.querySelector('button[aria-label^="Create dev where"]')).toBeNull();

    act(() => count!.click());
    expect(onManageWorkspaceRemotes).toHaveBeenCalledTimes(1);
  });

  it("shows a delete that finished on some machines only as the same count", () => {
    // Deleted on worker3, still on Mac: the count reads 1/2 like any other
    // gap, and clicking it opens the same management rather than deleting —
    // the tooltip is what says to delete again. From the newer field and
    // from the older one an earlier server sends.
    const halfDeletedNow: Worktree = {
      branch: "dev2",
      machines: [
        { serverId: "server-1", name: "worker3", state: "absent", deleted: true },
        { serverId: "server-2", name: "Mac", state: "present" },
      ],
    };
    const halfDeletedThen: Worktree = {
      branch: "dev3",
      unfinishedDelete: true,
      targets: [
        { targetId: "server-1", label: "worker3", state: "deleted" },
        { targetId: "server-2", label: "Mac", state: "present", status: "ready" },
      ],
    };
    render([{ branch: null }, halfDeletedNow, halfDeletedThen]);

    const counts = container.querySelectorAll<HTMLButtonElement>('button[aria-label$="remotes"]');
    expect([...counts].map((count) => count.textContent)).toEqual(["1/2", "1/2"]);
    expect(container.querySelector('button[aria-label^="Finish deleting"]')).toBeNull();

    act(() => counts[0].click());
    expect(onManageWorkspaceRemotes).toHaveBeenCalledWith(halfDeletedNow);
    expect(onDeleteWorktree).not.toHaveBeenCalled();
  });

  it("hides the merge badge when the primary remote has no checkout of the workspace", () => {
    // Merge status is the primary remote's Git. Deleted there (branch ref
    // kept) or never made there, its numbers describe a frozen ref, not the
    // work on the machine that has it; the count already says where it is.
    // A machine the hub has not placed, or a badge for another machine's
    // Git, is left alone.
    const merge = new Map<string, BranchMergeInfo>([
      ["dev", { branch: "dev", status: "unmerged", unmergedCount: 3, dirty: false, target: "main" }],
      ["dev2", { branch: "dev2", status: "unmerged", unmergedCount: 3, dirty: false, target: "main" }],
      ["dev3", { branch: "dev3", status: "unmerged", unmergedCount: 3, dirty: false, target: "main" }],
    ]);
    const worktrees: Worktree[] = [
      { branch: null },
      { branch: "dev", machines: [
        { serverId: "server-1", name: "worker3", state: "absent", deleted: true },
        { serverId: "server-2", name: "Mac", state: "present" },
      ] },
      { branch: "dev2", machines: [
        { serverId: "server-1", name: "worker3", state: "error", error: "disk full" },
        { serverId: "server-2", name: "Mac", state: "present" },
      ] },
      { branch: "dev3", machines: [
        { serverId: "server-1", name: "worker3", state: "unknown" },
        { serverId: "server-2", name: "Mac", state: "present" },
      ] },
    ];
    const mergeBadges = () => container.querySelectorAll('button[aria-label^="3 commits not in main"]').length;

    render(worktrees, { mergeStatuses: merge, mergeRepositoryServerId: "server-1" });
    expect(mergeBadges()).toBe(1);

    render(worktrees, { mergeStatuses: merge, mergeRepositoryServerId: "server-2" });
    expect(mergeBadges()).toBe(3);
  });

  it("leaves a workspace every machine agrees on, or from an older server, unmarked", () => {
    render([{ branch: null }, { branch: "dev" }]);

    expect(badge()).toBeNull();
    expect(container.querySelectorAll("button svg.lucide-triangle-alert").length).toBe(0);
  });

  it("says whose Git the list is not, and when sessions target an unlinked remote", () => {
    render([{ branch: null }, partial], { staleRemoteName: "worker3" });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("worker3 is offline");

    render([{ branch: null }, partial], { activeRemoteInvalid: true });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("no longer has");

    render([{ branch: null }, partial]);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
