// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getProjectBranches = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: { getProjectBranches },
}));

import { WorkspaceRowMenu } from "./workspace-row-menu";

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

beforeEach(() => {
  getProjectBranches.mockReset();
  getProjectBranches.mockResolvedValue(["dev", "main"]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll("[data-radix-menu-content]").forEach((node) => node.remove());
});

describe("WorkspaceRowMenu", () => {
  it("offers an automatic default reset and invokes it once", async () => {
    const onTargetReset = vi.fn();
    act(() => {
      root.render(
        <WorkspaceRowMenu
          projectId="p1"
          branch="dev"
          currentTarget="main"
          onTargetChange={vi.fn()}
          onTargetReset={onTargetReset}
          onDelete={vi.fn()}
        />,
      );
    });

    act(() => {
      findButton("Workspace menu").dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
      );
    });
    const compareTrigger = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (element) => element.textContent?.includes("Compare against"),
    ) as HTMLElement | undefined;
    expect(compareTrigger).toBeTruthy();

    await act(async () => {
      compareTrigger!.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      compareTrigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await Promise.resolve();
    });

    const resetItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (element) => element.textContent === "Default branch (auto)",
    ) as HTMLElement | undefined;
    expect(resetItem).toBeTruthy();
    expect(resetItem!.querySelector("span")?.classList.contains("text-xs")).toBe(true);

    act(() => resetItem!.click());
    expect(onTargetReset).toHaveBeenCalledTimes(1);
  });
});
