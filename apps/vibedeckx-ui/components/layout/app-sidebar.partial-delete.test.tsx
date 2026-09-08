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
  });

  it("leaves a workspace every machine agrees on unmarked", () => {
    render([{ branch: null }, { branch: "dev" }]);

    expect(container.querySelector('button[aria-label^="Finish deleting"]')).toBeNull();
    expect(container.querySelector('button[aria-label*="differs between machines"]')).toBeNull();
  });

  it("marks a machine holding an error too, without claiming a delete is pending", () => {
    render([{
      branch: "dev",
      targets: [
        { targetId: "server-1", label: "worker3", state: "present", status: "ready" },
        { targetId: "server-2", label: "Mac", state: "present", status: "error", error: "Branch 'dev' already exists" },
      ],
    }]);

    expect(container.querySelector('button[aria-label="dev differs between machines"]')).toBeTruthy();
  });
});
