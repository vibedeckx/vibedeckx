// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getProjectActivity: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

const stream = vi.hoisted(() => ({ listener: null as ((event: unknown) => void) | null }));
vi.mock("@/hooks/global-event-stream", () => ({
  useGlobalEventStream: (listener: (event: unknown) => void) => {
    stream.listener = listener;
  },
}));

import { useProjectActivity, type UseProjectActivityResult } from "./use-project-activity";
import type { ProjectActivity } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const activity = (id: string): ProjectActivity => ({
  recentThreads: [{
    id: `thread-${id}`, project_id: id, user_id: "user", title: id,
    created_at: "2026-07-31 00:00:00", updated_at: "2026-07-31 00:00:00", archived_at: null,
  }],
  recentAgentSessions: [],
  recentScheduleRuns: [],
  priorityTasks: [],
  attention: [],
  summary: { running: 0, nextScheduleAt: null },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

let root: Root;
let container: HTMLDivElement;
let latest: UseProjectActivityResult;

function Probe({ projectId }: { projectId: string | null }) {
  const value = useProjectActivity(projectId);
  useEffect(() => { latest = value; }, [value]);
  return null;
}

function render(projectId: string | null) {
  act(() => root.render(<Probe projectId={projectId} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  stream.listener = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useProjectActivity", () => {
  it("rejects a stale response after switching projects", async () => {
    const first = deferred<ProjectActivity>();
    const second = deferred<ProjectActivity>();
    api.getProjectActivity.mockImplementation((projectId: string) =>
      projectId === "p1" ? first.promise : second.promise);

    render("p1");
    render("p2");
    await act(async () => second.resolve(activity("p2")));
    expect(latest.activity?.recentThreads[0].project_id).toBe("p2");

    await act(async () => first.resolve(activity("p1")));
    expect(latest.activity?.recentThreads[0].project_id).toBe("p2");
    expect(latest.loading).toBe(false);
  });

  it("keeps the newest same-project refetch when an older request resolves last", async () => {
    const older = deferred<ProjectActivity>();
    const newer = deferred<ProjectActivity>();
    api.getProjectActivity
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    render("p1");

    let refetch!: Promise<void>;
    act(() => { refetch = latest.refetch(); });
    await act(async () => newer.resolve(activity("newer")));
    await refetch;
    expect(latest.activity?.recentThreads[0].title).toBe("newer");

    await act(async () => older.resolve(activity("older")));
    expect(latest.activity?.recentThreads[0].title).toBe("newer");
  });

  it("clears the previous project immediately when no project is selected", async () => {
    api.getProjectActivity.mockResolvedValue(activity("p1"));
    render("p1");
    await act(async () => {});
    expect(latest.activity).not.toBeNull();

    render(null);
    expect(latest).toMatchObject({ activity: null, loading: false, error: null });
  });

  it("coalesces a burst of matching session, schedule, and task events", async () => {
    api.getProjectActivity.mockResolvedValue(activity("p1"));
    render("p1");
    await act(async () => {});
    expect(api.getProjectActivity).toHaveBeenCalledTimes(1);

    act(() => {
      stream.listener?.({ type: "session:updated", projectId: "p1" });
      stream.listener?.({ type: "schedule:run-finished", projectId: "p1" });
      stream.listener?.({ type: "task:updated", projectId: "p1" });
      vi.advanceTimersByTime(99);
    });
    expect(api.getProjectActivity).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(1); });
    expect(api.getProjectActivity).toHaveBeenCalledTimes(2);

    act(() => {
      stream.listener?.({ type: "executor:started", projectId: "p1" });
      stream.listener?.({ type: "task:updated", projectId: "other" });
      vi.advanceTimersByTime(100);
    });
    expect(api.getProjectActivity).toHaveBeenCalledTimes(2);
  });

  it("queues exactly one event refresh while a request is in flight", async () => {
    const initial = deferred<ProjectActivity>();
    const pending = deferred<ProjectActivity>();
    api.getProjectActivity
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(activity("latest"));
    render("p1");

    act(() => {
      stream.listener?.({ type: "session:updated", projectId: "p1" });
      stream.listener?.({ type: "schedule:run-finished", projectId: "p1" });
      vi.advanceTimersByTime(100);
      stream.listener?.({ type: "task:updated", projectId: "p1" });
      vi.advanceTimersByTime(100);
    });
    expect(api.getProjectActivity).toHaveBeenCalledTimes(1);

    await act(async () => initial.resolve(activity("initial")));
    expect(api.getProjectActivity).toHaveBeenCalledTimes(2);
    act(() => {
      stream.listener?.({ type: "task:updated", projectId: "p1" });
      stream.listener?.({ type: "session:updated", projectId: "p1" });
      vi.advanceTimersByTime(100);
    });
    expect(api.getProjectActivity).toHaveBeenCalledTimes(2);

    await act(async () => pending.resolve(activity("pending")));
    // Events that occurred after the pending request began produce one more
    // refresh, never concurrent requests or one request per event.
    expect(api.getProjectActivity).toHaveBeenCalledTimes(3);
  });

  it("cancels a queued event refresh on project switch and unmount", async () => {
    api.getProjectActivity.mockResolvedValue(activity("p1"));
    render("p1");
    await act(async () => {});

    act(() => stream.listener?.({ type: "task:updated", projectId: "p1" }));
    render("p2");
    await act(async () => {});
    expect(api.getProjectActivity.mock.calls.map(([id]) => id)).toEqual(["p1", "p2"]);
    act(() => vi.advanceTimersByTime(100));
    expect(api.getProjectActivity.mock.calls.map(([id]) => id)).toEqual(["p1", "p2"]);

    act(() => stream.listener?.({ type: "session:updated", projectId: "p2" }));
    act(() => root.unmount());
    act(() => vi.advanceTimersByTime(100));
    expect(api.getProjectActivity).toHaveBeenCalledTimes(2);
  });
});
