// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickSwitcher } from "./quick-switcher";

vi.mock("@/lib/api", () => ({
  searchAll: vi.fn().mockResolvedValue({
    projects: [],
    workspaces: [],
    sessions: [],
    favorites: [],
    cacheState: "fresh",
  }),
  refreshSearchCache: vi.fn().mockResolvedValue({ ok: true, cacheState: "fresh" }),
}));

vi.mock("@/lib/quick-switcher-cache", () => ({
  beginEmptyQuerySearch: vi.fn(() => 1),
  commitEmptyQueryResults: vi.fn(),
  getCachedEmptyResults: vi.fn(() => null),
  overlayRecents: vi.fn((results) => ({
    sessions: results.sessions,
    favorites: results.favorites,
  })),
  updateCachedSessionTitle: vi.fn(),
}));

vi.mock("@/hooks/global-event-stream", () => ({
  useGlobalEventStream: vi.fn(),
}));

describe("QuickSwitcher", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("anchors the search input at its full-results position", async () => {
    await act(async () => {
      root.render(
        <QuickSwitcher
          open
          onOpenChange={vi.fn()}
          onNavigateProject={vi.fn()}
          onNavigateWorkspace={vi.fn()}
          onNavigateSession={vi.fn()}
        />,
      );
    });

    const dialog = document.querySelector('[data-slot="dialog-content"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.classList.contains("top-[max(1rem,calc(50%_-_175px))]")).toBe(true);
    expect(dialog!.classList.contains("translate-y-0")).toBe(true);
    expect(dialog!.classList.contains("top-[50%]")).toBe(false);
    expect(dialog!.classList.contains("translate-y-[-50%]")).toBe(false);
  });
});
