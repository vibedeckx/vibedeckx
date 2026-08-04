// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getProjectWorktrees = vi.hoisted(() => vi.fn(async () => [{ branch: null }]));
let capturedListener: ((event: { type?: string; [key: string]: unknown }) => void) | null = null;

vi.mock("@/lib/api", () => ({ api: { getProjectWorktrees } }));
vi.mock("@/hooks/global-event-stream", () => ({
  useGlobalEventStream: (listener: typeof capturedListener) => {
    capturedListener = listener;
  },
}));

import { useWorktrees, WORKTREE_DRIFT_BACKSTOP_MS } from "./use-worktrees";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ projectId = "p1", branch }: { projectId?: string | null; branch?: string | null }) {
  useWorktrees(projectId, branch);
  return null;
}

describe("useWorktrees drift refresh triggers", () => {
  let root: Root;
  let container: HTMLElement;
  const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

  const render = async (branch?: string | null, projectId: string | null = "p1") => {
    await act(async () => {
      root.render(<Probe projectId={projectId} branch={branch} />);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    capturedListener = null;
    getProjectWorktrees.mockClear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState);
    }
  });

  it("refreshes in the background when the selected workspace changes", async () => {
    await render(null);
    expect(getProjectWorktrees).toHaveBeenCalledTimes(1);

    await render("dev");
    expect(getProjectWorktrees).toHaveBeenCalledTimes(2);
  });

  it("refreshes for terminal session and executor events from the current project", async () => {
    await render("dev");
    getProjectWorktrees.mockClear();

    await act(async () => {
      capturedListener?.({ type: "session:taskCompleted", projectId: "p1" });
      await Promise.resolve();
    });
    await act(async () => {
      capturedListener?.({ type: "session:status", projectId: "p1", status: "error" });
      await Promise.resolve();
    });
    await act(async () => {
      capturedListener?.({ type: "executor:stopped", projectId: "p1" });
      await Promise.resolve();
    });

    expect(getProjectWorktrees).toHaveBeenCalledTimes(3);
  });

  it("ignores unrelated, running, and other-project events", async () => {
    await render("dev");
    getProjectWorktrees.mockClear();

    act(() => {
      capturedListener?.({ type: "session:status", projectId: "p1", status: "running" });
      capturedListener?.({ type: "session:taskCompleted", projectId: "p2" });
      capturedListener?.({ type: "task:updated", projectId: "p1" });
    });

    expect(getProjectWorktrees).not.toHaveBeenCalled();
  });

  it("refreshes on focus", async () => {
    await render("dev");
    getProjectWorktrees.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(getProjectWorktrees).toHaveBeenCalledTimes(1);
  });

  it("uses a five-minute visible backstop and stays quiet while hidden", async () => {
    vi.useFakeTimers();
    await render("dev");
    getProjectWorktrees.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(WORKTREE_DRIFT_BACKSTOP_MS);
      await Promise.resolve();
    });
    expect(getProjectWorktrees).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    getProjectWorktrees.mockClear();
    act(() => vi.advanceTimersByTime(WORKTREE_DRIFT_BACKSTOP_MS * 2));
    expect(getProjectWorktrees).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(getProjectWorktrees).toHaveBeenCalledTimes(1);
  });
});
