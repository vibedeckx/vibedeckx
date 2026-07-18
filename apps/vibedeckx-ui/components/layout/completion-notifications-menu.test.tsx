// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompletionNotificationsMenu } from "./completion-notifications-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <CompletionNotificationsMenu
        notifications={[]}
        unreadCount={0}
        projects={[]}
        onNavigate={vi.fn()}
        markRead={vi.fn()}
        markAllRead={vi.fn()}
        remove={vi.fn()}
        clear={vi.fn()}
      />,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll("[data-radix-menu-content]").forEach((node) => node.remove());
});

function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function menuContent(): Element | null {
  return (
    Array.from(document.querySelectorAll("[data-radix-menu-content], [role='menu']")).find(
      (node) => node.textContent?.includes("Notifications"),
    ) ?? null
  );
}

describe("CompletionNotificationsMenu keyboard shortcut", () => {
  it("toggles the menu with Cmd+J", () => {
    expect(menuContent()).toBeNull();
    pressKey({ key: "j", metaKey: true });
    expect(menuContent()).not.toBeNull();
    pressKey({ key: "j", metaKey: true });
    expect(menuContent()).toBeNull();
  });

  it("opens the menu with Ctrl+J", () => {
    pressKey({ key: "j", ctrlKey: true });
    expect(menuContent()).not.toBeNull();
  });

  it("prevents the browser default (downloads panel) on Cmd+J", () => {
    const event = pressKey({ key: "j", metaKey: true });
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores a plain 'j' keypress", () => {
    const event = pressKey({ key: "j" });
    expect(menuContent()).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});
