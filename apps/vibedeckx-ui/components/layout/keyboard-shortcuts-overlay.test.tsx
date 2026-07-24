// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KeyboardShortcutsOverlay } from "./keyboard-shortcuts-overlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<KeyboardShortcutsOverlay />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll("[data-slot=dialog-portal]").forEach((n) => n.remove());
});

function pressKey(init: KeyboardEventInit, target?: HTMLElement) {
  act(() => {
    (target ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

const dialogVisible = () => document.body.textContent?.includes("Keyboard shortcuts") ?? false;

describe("KeyboardShortcutsOverlay", () => {
  it("toggles with ? outside inputs and lists registry entries", () => {
    expect(document.body.textContent).not.toContain("Workspace tabs");

    pressKey({ key: "?", shiftKey: true });
    expect(dialogVisible()).toBe(true);
    // Registry-driven content: a tab entry and a global entry.
    expect(document.body.textContent).toContain("Workspace tabs");
    expect(document.body.textContent).toContain("Ctrl+Alt+D");
    expect(document.body.textContent).toContain("Ctrl+K");

    pressKey({ key: "?", shiftKey: true });
    expect(document.body.textContent).not.toContain("Workspace tabs");
  });

  it("ignores ? typed into an input but honors Ctrl+/ there", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);

    pressKey({ key: "?", shiftKey: true }, input);
    expect(document.body.textContent).not.toContain("Workspace tabs");

    pressKey({ key: "/", ctrlKey: true }, input);
    expect(document.body.textContent).toContain("Workspace tabs");
    input.remove();
  });

  it("opens from the header icon button", () => {
    const button = container.querySelector("button[aria-label='Keyboard shortcuts']");
    expect(button).toBeTruthy();
    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Workspace tabs");
  });
});
