// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "@/lib/api";

const getExecutors = vi.hoisted(() => vi.fn());
const createExecutorApi = vi.hoisted(() => vi.fn());
const getRunningProcesses = vi.hoisted(() => vi.fn());
const updateExecutorApi = vi.hoisted(() => vi.fn());
const deleteExecutorApi = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      getExecutors,
      createExecutor: createExecutorApi,
      updateExecutor: updateExecutorApi,
      deleteExecutor: deleteExecutorApi,
      getRunningProcesses,
    },
  };
});

import { useExecutors } from "./use-executors";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const executor = (id: string): Executor =>
  ({ id, name: id, command: "true", disabled_targets: [], last_runs: {} }) as unknown as Executor;

/** A promise plus the handles to settle it, so response order is the test's to choose. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Result = ReturnType<typeof useExecutors>;

describe("useExecutors workspace scoping", () => {
  let container: HTMLElement;
  let root: Root;
  let latest: Result;

  function Probe({ branch }: { branch: string }) {
    const value = useExecutors("p1", branch);
    useEffect(() => { latest = value; });
    return null;
  }

  const ids = () => latest.executors.map((e) => e.id);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    getRunningProcesses.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("never shows the previous workspace's executors after a switch", async () => {
    const dev2List = deferred<Executor[]>();
    getExecutors.mockResolvedValueOnce([executor("main-exec")]).mockReturnValueOnce(dev2List.promise);

    await act(async () => { root.render(<Probe branch="main" />); });
    expect(ids()).toEqual(["main-exec"]);

    await act(async () => { root.render(<Probe branch="dev2" />); });
    expect(latest.loading).toBe(true);
    expect(ids()).toEqual([]);

    await act(async () => { dev2List.resolve([executor("dev2-exec")]); await dev2List.promise; });
    expect(latest.loading).toBe(false);
    expect(ids()).toEqual(["dev2-exec"]);
  });

  it("lands a late answer for the workspace left behind in that workspace, not this one", async () => {
    const mainList = deferred<Executor[]>();
    getExecutors.mockReturnValueOnce(mainList.promise).mockResolvedValueOnce([executor("dev2-exec")]);

    await act(async () => { root.render(<Probe branch="main" />); });
    await act(async () => { root.render(<Probe branch="dev2" />); });
    expect(ids()).toEqual(["dev2-exec"]);

    await act(async () => { mainList.resolve([executor("main-exec")]); await mainList.promise; });
    expect(ids()).toEqual(["dev2-exec"]);

    // ...and going back shows main's own list at once, from the cache.
    getExecutors.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { root.render(<Probe branch="main" />); });
    expect(latest.loading).toBe(false);
    expect(ids()).toEqual(["main-exec"]);
  });

  it("keeps an executor created before the workspace's first list failed to load", async () => {
    const list = deferred<Executor[]>();
    getExecutors.mockReturnValue(list.promise);
    createExecutorApi.mockResolvedValue(executor("new-exec"));

    await act(async () => { root.render(<Probe branch="dev2" />); });
    await act(async () => { await latest.createExecutor({ name: "new", command: "true" }); });
    expect(ids()).toEqual(["new-exec"]);

    await act(async () => { list.reject(new Error("offline")); await list.promise.catch(() => {}); });
    expect(ids()).toEqual(["new-exec"]);
  });

  it("merges an executor created while the list was in flight into that list", async () => {
    const list = deferred<Executor[]>();
    getExecutors.mockReturnValue(list.promise);
    createExecutorApi.mockResolvedValue(executor("new-exec"));

    await act(async () => { root.render(<Probe branch="dev2" />); });
    await act(async () => { await latest.createExecutor({ name: "new", command: "true" }); });

    // The list was read before the create, so it doesn't contain it.
    await act(async () => { list.resolve([executor("old-exec")]); await list.promise; });
    expect(ids()).toEqual(["old-exec", "new-exec"]);
  });

  it("does not bring back an executor deleted while the list was in flight", async () => {
    const list = deferred<Executor[]>();
    getExecutors.mockReturnValue(list.promise);
    createExecutorApi.mockResolvedValue(executor("new-exec"));
    deleteExecutorApi.mockResolvedValue(undefined);

    await act(async () => { root.render(<Probe branch="dev2" />); });
    await act(async () => { await latest.createExecutor({ name: "new", command: "true" }); });
    await act(async () => { await latest.deleteExecutor("new-exec"); });
    expect(ids()).toEqual([]);

    await act(async () => { list.resolve([]); await list.promise; });
    expect(ids()).toEqual([]);
  });

  it("keeps an edit made while the list was in flight", async () => {
    const list = deferred<Executor[]>();
    getExecutors.mockReturnValue(list.promise);
    createExecutorApi.mockResolvedValue(executor("new-exec"));
    updateExecutorApi.mockResolvedValue({ ...executor("new-exec"), name: "renamed" });

    await act(async () => { root.render(<Probe branch="dev2" />); });
    await act(async () => { await latest.createExecutor({ name: "new", command: "true" }); });
    await act(async () => { await latest.updateExecutor("new-exec", { name: "renamed" }); });

    await act(async () => { list.resolve([]); await list.promise; });
    expect(latest.executors.map((e) => e.name)).toEqual(["renamed"]);
  });
});
