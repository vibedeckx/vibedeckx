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

const halfDeleted: Worktree = {
  branch: "dev2",
  unfinishedDelete: true,
  targets: [
    { targetId: "server-1", label: "worker3", state: "deleted" },
    { targetId: "server-2", label: "Mac", state: "present", status: "ready" },
  ],
};

describe("AppSidebar workspace that its machines disagree about", () => {
  let container: HTMLElement;
  let root: Root;
  const onDeleteWorktree = vi.fn();
  const onRecreateWorktree = vi.fn();

  const render = (worktrees: Worktree[]) =>
    act(() => {
      root.render(
        <AppSidebar
          activeView="workspace"
          onViewChange={() => {}}
          worktrees={worktrees}
          selectedBranch={null}
          currentProject={project}
          onDeleteWorktree={onDeleteWorktree}
          onRecreateWorktree={onRecreateWorktree}
        />,
      );
    });

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

  it("marks it, and the mark is the way to finish the delete", () => {
    render([{ branch: null }, halfDeleted]);

    const marker = container.querySelector<HTMLButtonElement>('button[aria-label="Finish deleting dev2"]');
    expect(marker).toBeTruthy();

    act(() => marker!.click());
    expect(onDeleteWorktree).toHaveBeenCalledWith(halfDeleted);
    expect(onRecreateWorktree).not.toHaveBeenCalled();
  });

  it("leaves a workspace every machine agrees on unmarked", () => {
    render([{ branch: null }, { branch: "dev" }]);

    expect(container.querySelector('button[aria-label^="Finish deleting"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Create dev where"]')).toBeNull();
  });

  it("offers to create it where it is missing, not to delete it, when a machine never got it", () => {
    // The two ways machines disagree want opposite actions; sending this one to
    // the delete dialog would offer to remove what the user is missing.
    const missingOnMac: Worktree = {
      branch: "dev",
      targets: [
        { targetId: "server-1", label: "worker3", state: "present", status: "ready" },
        { targetId: "server-2", label: "Mac", state: "present", status: "error", error: "Branch 'dev' already exists" },
      ],
    };
    render([missingOnMac]);

    const marker = container.querySelector<HTMLButtonElement>('button[aria-label="Create dev where it is missing"]');
    expect(marker).toBeTruthy();

    act(() => marker!.click());
    expect(onRecreateWorktree).toHaveBeenCalledWith(missingOnMac);
    expect(onDeleteWorktree).not.toHaveBeenCalled();
  });
  it("reads the same two contradictions off the newer per-machine field", () => {
    // A server past the `targets` field sends only `machines`.
    const halfDeletedNow: Worktree = {
      branch: "dev2",
      machines: [
        { serverId: "server-1", name: "worker3", state: "absent", deleted: true },
        { serverId: "server-2", name: "Mac", state: "present" },
      ],
    };
    const failedOnMac: Worktree = {
      branch: "dev",
      machines: [
        { serverId: "server-1", name: "worker3", state: "present" },
        { serverId: "server-2", name: "Mac", state: "error", error: "Branch 'dev' already exists" },
      ],
    };
    render([{ branch: null }, halfDeletedNow, failedOnMac]);

    const finish = container.querySelector<HTMLButtonElement>('button[aria-label="Finish deleting dev2"]');
    const create = container.querySelector<HTMLButtonElement>('button[aria-label="Create dev where it is missing"]');
    expect(finish).toBeTruthy();
    expect(create).toBeTruthy();

    act(() => finish!.click());
    expect(onDeleteWorktree).toHaveBeenCalledWith(halfDeletedNow);
    act(() => create!.click());
    expect(onRecreateWorktree).toHaveBeenCalledWith(failedOnMac);
  });

  it("leaves a deliberate gap unmarked by the amber warning", () => {
    render([
      { branch: null },
      {
        branch: "dev",
        machines: [
          { serverId: "server-1", name: "worker3", state: "present" },
          { serverId: "server-2", name: "Mac", state: "absent" },
        ],
      },
    ]);

    expect(container.querySelector('button[aria-label^="Finish deleting"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Create dev where"]')).toBeNull();
  });
});
