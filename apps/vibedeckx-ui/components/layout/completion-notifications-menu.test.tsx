// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompletionNotificationsMenu, KIND_META } from "./completion-notifications-menu";
import type { ServerNotification } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (overrides: Partial<ServerNotification> = {}): ServerNotification => ({
  id: "n1",
  kind: "session_result_ready",
  project_id: "p1",
  branch: "dev",
  session_id: "s1",
  workflow_run_id: null,
  title: "Session result is ready",
  body: "Fix login",
  created_at: Date.now(),
  read_at: null,
  ...overrides,
});

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

describe("CompletionNotificationsMenu rendering", () => {
  function renderWith(notifications: ServerNotification[]) {
    const onNavigate = vi.fn<(p: string, b: string | null, s: string | null) => void>();
    const markRead = vi.fn<(id: string) => void>();
    const remove = vi.fn<(id: string) => void>();
    act(() => {
      root.render(
        <CompletionNotificationsMenu
          notifications={notifications}
          unreadCount={notifications.filter((n) => n.read_at === null).length}
          projects={[{ id: "p1", name: "Checkout" } as never]}
          onNavigate={onNavigate}
          markRead={markRead}
          markAllRead={vi.fn()}
          remove={remove}
          clear={vi.fn()}
        />,
      );
    });
    pressKey({ key: "j", metaKey: true });
    return { onNavigate, markRead, remove };
  }

  it.each([
    ["session_result_ready", "Session result is ready"],
    ["review_ready", "Review feedback is ready"],
    ["session_failed", "Session failed"],
    ["workflow_failed", "Workflow needs attention"],
  ] as const)("renders distinct copy for %s", (kind, label) => {
    renderWith([row({ kind })]);
    expect(menuContent()?.textContent).toContain(label);
  });

  it("gives both failure kinds the destructive dot and successes their own colors", () => {
    // Four kinds, three visual buckets: success, review, needs-attention.
    expect(KIND_META.session_failed.dot).toBe(KIND_META.workflow_failed.dot);
    expect(KIND_META.session_failed.dot).toContain("destructive");
    expect(KIND_META.session_result_ready.dot).not.toBe(KIND_META.review_ready.dot);
    expect(KIND_META.session_result_ready.dot).not.toBe(KIND_META.session_failed.dot);
  });

  it("shows the server-generated body, falling back to the project name", () => {
    renderWith([row({ id: "a", body: "Fix login redirect" })]);
    expect(menuContent()?.textContent).toContain("Fix login redirect");

    pressKey({ key: "j", metaKey: true }); // close
    renderWith([row({ id: "b", body: null })]);
    expect(menuContent()?.textContent).toContain("Checkout");
  });

  it("clicking navigates to the notification's exact session, not just its branch", () => {
    const { onNavigate, markRead } = renderWith([
      row({ id: "a", project_id: "p1", branch: "dev", session_id: "s-target" }),
    ]);
    const item = Array.from(menuContent()?.querySelectorAll("[role='menuitem']") ?? [])
      .find((el) => el.textContent?.includes("Fix login"))!;
    act(() => {
      (item as HTMLElement).click();
    });
    expect(onNavigate).toHaveBeenCalledWith("p1", "dev", "s-target");
    expect(markRead).toHaveBeenCalledWith("a");
  });

  it("renders one entry per milestone for two sessions on the same branch", () => {
    renderWith([
      row({ id: "session:sA:turn:2:result-ready", session_id: "sA", body: "Session A" }),
      row({ id: "session:sB:turn:2:result-ready", session_id: "sB", body: "Session B" }),
    ]);
    const text = menuContent()?.textContent ?? "";
    expect(text).toContain("Session A");
    expect(text).toContain("Session B");
  });

  it("shows an empty state when there is nothing to attend to", () => {
    renderWith([]);
    expect(menuContent()?.textContent).toContain("Nothing needs your attention");
  });
});
