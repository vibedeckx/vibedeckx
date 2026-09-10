// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Worktree } from "@/lib/api";

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
  const onBranchChange = vi.fn();

  const render = (worktrees: Worktree[], extra?: { staleRemoteName?: string | null; activeRemoteInvalid?: boolean }) =>
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
          staleRemoteName={extra?.staleRemoteName}
          activeRemoteInvalid={extra?.activeRemoteInvalid}
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
    // A deliberate gap is not a fault: no amber warning for it.
    expect(container.querySelector('button[aria-label^="Create dev where"]')).toBeNull();

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

  it("keeps the amber warning beside the count when a machine also failed", () => {
    render([
      { branch: null },
      {
        branch: "dev",
        machines: [
          { serverId: "server-1", name: "worker3", state: "present" },
          { serverId: "server-2", name: "Mac", state: "error", error: "disk full" },
          { serverId: "server-3", name: "ubuntu", state: "absent" },
        ],
        targets: [
          { targetId: "server-1", label: "worker3", state: "present", status: "ready" },
          { targetId: "server-2", label: "Mac", state: "present", status: "error", error: "disk full" },
        ],
      },
    ]);

    const warning = container.querySelector('button[aria-label="Create dev where it is missing"]');
    const count = badge();
    expect(warning).toBeTruthy();
    expect(count?.textContent).toBe("1/3");
    // Warning left, count right.
    expect(warning!.compareDocumentPosition(count!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
