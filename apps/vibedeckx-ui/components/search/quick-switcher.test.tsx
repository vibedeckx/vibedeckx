// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickSwitcher } from "./quick-switcher";
import { refreshSearchCache, searchAll } from "@/lib/api";

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
    vi.useRealTimers();
    vi.mocked(searchAll).mockReset();
    vi.mocked(searchAll).mockResolvedValue({
      projects: [],
      workspaces: [],
      sessions: [],
      favorites: [],
      cacheState: "fresh",
    });
  });

  const renderOpen = () =>
    act(async () => {
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
    expect(dialog!.classList.contains("data-[state=closed]:animate-none!")).toBe(true);
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.classList.contains("data-[state=closed]:animate-none!")).toBe(true);
  });

  const timeout = () => new DOMException("timed out", "TimeoutError");

  it("retries a search that times out instead of failing it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(refreshSearchCache).mockReturnValueOnce(new Promise(() => {}));
    vi.mocked(searchAll)
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({
        projects: [{ id: "p1", name: "retried-project", path: null }],
        workspaces: [],
        sessions: [],
        favorites: [],
        cacheState: "fresh",
      });

    await renderOpen();
    // Fast failures back off 1s, then 2s, before the next attempt.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(searchAll).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("retried-project");
    expect(document.body.textContent).not.toContain("Search failed.");
  });

  it("shows the failure once every attempt has failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(refreshSearchCache).mockReturnValueOnce(new Promise(() => {}));
    vi.mocked(searchAll).mockRejectedValue(timeout());

    await renderOpen();
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });

    expect(searchAll).toHaveBeenCalledTimes(4);
    expect(document.body.textContent).toContain("Search failed.");
  });

  it("stops retrying once the palette closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(refreshSearchCache).mockReturnValueOnce(new Promise(() => {}));
    vi.mocked(searchAll).mockRejectedValue(timeout());

    await renderOpen();
    // Flush the 0ms debounce that fires the initial search.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(searchAll).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(searchAll).toHaveBeenCalledTimes(1);
  });
});
