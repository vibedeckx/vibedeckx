// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useMergeStatusAutoRefresh } from "./use-merge-status";

let capturedListener: ((evt: { type?: string; [k: string]: unknown }) => void) | null = null;
vi.mock("@/hooks/global-event-stream", () => ({
  useGlobalEventStream: (listener: (evt: unknown) => void) => {
    capturedListener = listener;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({
  refetch,
  statuses,
  projectId,
}: {
  refetch: () => void;
  statuses: ReadonlyMap<string, string> | undefined;
  projectId: string | null;
}) {
  useMergeStatusAutoRefresh(refetch, statuses, projectId);
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(
  refetch: () => void,
  statuses: ReadonlyMap<string, string> | undefined,
  projectId: string | null = null,
) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const r = root;
  act(() => {
    r.render(<Probe refetch={refetch} statuses={statuses} projectId={projectId} />);
  });
}

beforeEach(() => {
  capturedListener = null;
});

afterEach(() => {
  if (root) {
    const r = root;
    act(() => r.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

describe("useMergeStatusAutoRefresh (activity-end transition)", () => {
  it("refetches exactly once when the main workspace (branch key \"\") finishes a turn", () => {
    // Regression: a join("\n") serialization collides for {} vs {""}, so the
    // idle → main-running → completed cycle on the main workspace alone never
    // changed the effect dep and the activity-end refetch never fired.
    const refetch = vi.fn();
    render(refetch, new Map());
    render(refetch, new Map([["", "main-running"]]));
    expect(refetch).not.toHaveBeenCalled();
    render(refetch, new Map([["", "completed"]]));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("refetches once when a named branch leaves the active set", () => {
    const refetch = vi.fn();
    render(refetch, new Map([["dev1", "working"]]));
    render(refetch, new Map([["dev1", "completed"]]));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when a branch merely becomes active", () => {
    const refetch = vi.fn();
    render(refetch, new Map([["dev1", "idle"]]));
    render(refetch, new Map([["dev1", "working"]]));
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe("useMergeStatusAutoRefresh (executor:stopped trigger)", () => {
  it("refetches exactly once on executor:stopped for the same project", () => {
    const refetch = vi.fn();
    render(refetch, new Map(), "p1");
    act(() => {
      capturedListener?.({ type: "executor:stopped", projectId: "p1" });
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch on executor:stopped for a different project", () => {
    const refetch = vi.fn();
    render(refetch, new Map(), "p1");
    act(() => {
      capturedListener?.({ type: "executor:stopped", projectId: "p2" });
    });
    expect(refetch).not.toHaveBeenCalled();
  });

  it("does not refetch on an unrelated event type", () => {
    const refetch = vi.fn();
    render(refetch, new Map(), "p1");
    act(() => {
      capturedListener?.({ type: "task:updated", projectId: "p1" });
    });
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe("useMergeStatusAutoRefresh (merge-target:updated trigger)", () => {
  it("refetches only when the merge target changed for the same project", () => {
    const refetch = vi.fn();
    render(refetch, new Map(), "p1");

    act(() => {
      capturedListener?.({ type: "merge-target:updated", projectId: "p2", branch: "dev1" });
    });
    expect(refetch).not.toHaveBeenCalled();

    act(() => {
      capturedListener?.({ type: "merge-target:updated", projectId: "p1", branch: "dev1" });
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch without a selected project", () => {
    const refetch = vi.fn();
    render(refetch, new Map(), null);

    act(() => {
      capturedListener?.({ type: "merge-target:updated", projectId: null, branch: "dev1" });
    });
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe("useMergeStatusAutoRefresh (visible-tab backstop poll)", () => {
  const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

  afterEach(() => {
    vi.useRealTimers();
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState);
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("ticks the idle poll at 60s", () => {
    const refetch = vi.fn();
    render(refetch, new Map([["dev1", "idle"]]), "p1");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("ticks the active poll at 30s", () => {
    const refetch = vi.fn();
    render(refetch, new Map([["dev1", "idle"]]), "p1");
    render(refetch, new Map([["dev1", "working"]]), "p1");
    const baseline = refetch.mock.calls.length;
    expect(baseline).toBe(0); // entering the active set alone must not refetch
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(refetch).toHaveBeenCalledTimes(baseline + 1);
  });

  it("stops the poll while the tab is hidden and resumes on visible", () => {
    const refetch = vi.fn();
    render(refetch, new Map([["dev1", "idle"]]), "p1");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(refetch).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
