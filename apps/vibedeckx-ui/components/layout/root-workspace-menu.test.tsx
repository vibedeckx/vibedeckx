// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getProjectBranches = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: { getProjectBranches },
}));

import { RootWorkspaceMenu } from "./root-workspace-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent?.includes(text) || element.title === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function openBranchSubmenu() {
  act(() => {
    findButton("Workspace menu").dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
    );
  });
  await enterBranchSubmenu();
}

/** Re-enter an already-open menu — reopening it from the trigger would toggle it shut. */
async function enterBranchSubmenu() {
  const trigger = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (element) => element.textContent?.includes("Anchor to branch"),
  ) as HTMLElement | undefined;
  expect(trigger).toBeTruthy();
  await act(async () => {
    // React maps onFocus to focusin; a plain "focus" event leaves the branch
    // list unloaded and every item assertion below vacuous.
    trigger!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
  });
}

function findBranchItem(branch: string): HTMLElement {
  const item = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find(
    (element) => element.textContent === branch,
  ) as HTMLElement | undefined;
  if (!item) throw new Error(`Branch item not found: ${branch}`);
  return item;
}

beforeEach(() => {
  getProjectBranches.mockReset();
  getProjectBranches.mockResolvedValue(["feat/passage-finder", "main"]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll("[data-radix-menu-content]").forEach((node) => node.remove());
});

describe("RootWorkspaceMenu", () => {
  it("anchors to a branch the workspace is not already on", async () => {
    const onAnchorChange = vi.fn();
    act(() => {
      root.render(
        <RootWorkspaceMenu
          projectId="p1"
          anchoredBranch="feat/passage-finder"
          onAnchorChange={onAnchorChange}
        />,
      );
    });

    await openBranchSubmenu();

    // The anchored branch is listed too, marked as the current one, so the user
    // can see what the workspace is named after without opening anything else.
    expect(findBranchItem("feat/passage-finder").getAttribute("data-state")).toBe("checked");

    act(() => findBranchItem("main").click());
    expect(onAnchorChange).toHaveBeenCalledWith("main");
  });

  it("reloads branches when the same row is reused by another project", async () => {
    const onAnchorChange = vi.fn();
    act(() => {
      root.render(
        <RootWorkspaceMenu projectId="p1" anchoredBranch="main" onAnchorChange={onAnchorChange} />,
      );
    });
    await openBranchSubmenu();
    expect(getProjectBranches).toHaveBeenCalledWith("p1");

    // The root row's key is constant across projects, so this component is
    // reused rather than remounted when the sidebar switches project.
    getProjectBranches.mockResolvedValue(["release"]);
    act(() => {
      root.render(
        <RootWorkspaceMenu projectId="p2" anchoredBranch="release" onAnchorChange={onAnchorChange} />,
      );
    });
    await enterBranchSubmenu();

    expect(getProjectBranches).toHaveBeenLastCalledWith("p2");
    expect(findBranchItem("release")).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).map((e) => e.textContent),
    ).not.toContain("feat/passage-finder");
  });

  it("keeps the current project's list when the previous project's request lands late", async () => {
    const pending: Array<(branches: string[]) => void> = [];
    getProjectBranches.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));

    act(() => {
      root.render(<RootWorkspaceMenu projectId="p1" anchoredBranch="main" onAnchorChange={vi.fn()} />);
    });
    await openBranchSubmenu(); // p1's request is now in flight and unresolved.
    act(() => {
      root.render(<RootWorkspaceMenu projectId="p2" anchoredBranch="release" onAnchorChange={vi.fn()} />);
    });
    await enterBranchSubmenu();
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1](["release"]); // p2 answers first…
      await Promise.resolve();
    });
    await act(async () => {
      pending[0](["feat/passage-finder"]); // …then p1's outlived request lands.
      await Promise.resolve();
    });

    expect(findBranchItem("release")).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent),
    ).not.toContain("Loading…");
  });

  it("does not re-anchor to the branch already anchored", async () => {
    const onAnchorChange = vi.fn();
    act(() => {
      root.render(
        <RootWorkspaceMenu projectId="p1" anchoredBranch="main" onAnchorChange={onAnchorChange} />,
      );
    });

    await openBranchSubmenu();
    act(() => findBranchItem("main").click());

    expect(onAnchorChange).not.toHaveBeenCalled();
  });
});
