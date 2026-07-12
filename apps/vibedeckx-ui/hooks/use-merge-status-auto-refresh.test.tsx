// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useMergeStatusAutoRefresh } from "./use-merge-status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({
  refetch,
  statuses,
}: {
  refetch: () => void;
  statuses: ReadonlyMap<string, string> | undefined;
}) {
  useMergeStatusAutoRefresh(refetch, statuses);
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(refetch: () => void, statuses: ReadonlyMap<string, string> | undefined) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const r = root;
  act(() => {
    r.render(<Probe refetch={refetch} statuses={statuses} />);
  });
}

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
