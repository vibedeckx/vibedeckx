// @vitest-environment jsdom
//
// Page-lifetime task-list cache + project-switch guards: revisiting a project
// seeds its tasks synchronously while the load revalidates; a never-visited
// project seeds [] rather than showing the previous project's rows; a late
// response for a project already switched away from is dropped. Project ids
// are unique per test — the cache is module-level and survives across tests.
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/api";

const getTasks = vi.hoisted(() => vi.fn<(projectId: string) => Promise<Task[]>>(async () => []));
const createTask = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: { getTasks, createTask } }));

import { useTasks } from "./use-tasks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookApi = ReturnType<typeof useTasks>;
let latest: HookApi | null = null;
const seen: string[][] = [];

function Probe({ projectId }: { projectId: string | null }) {
  const result = useTasks(projectId);
  // Committed (painted) renders only — a render-phase seed discards its pass.
  useLayoutEffect(() => {
    latest = result;
    seen.push(result.tasks.map((t) => t.id));
  });
  return null;
}

const task = (id: string) => ({ id } as Task);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("useTasks cache", () => {
  let root: Root;
  let container: HTMLElement;

  const render = async (projectId: string | null) => {
    await act(async () => {
      root.render(<Probe projectId={projectId} />);
      await Promise.resolve();
    });
  };

  const tasksByProject = (lists: Record<string, Task[]>) => {
    getTasks.mockImplementation(async (projectId: string) => lists[projectId] ?? []);
  };

  beforeEach(() => {
    getTasks.mockReset();
    getTasks.mockResolvedValue([]);
    createTask.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = null;
    seen.length = 0;
  });

  it("seeds a revisited project's tasks without a loading state", async () => {
    tasksByProject({ a1: [task("t-1")], a2: [] });
    await render("a1");
    expect(latest!.tasks.map((t) => t.id)).toEqual(["t-1"]);
    await render("a2");

    // Hang the network: only the cache can produce rows.
    getTasks.mockImplementation(() => new Promise<never>(() => {}));
    await render("a1");
    expect(latest!.tasks.map((t) => t.id)).toEqual(["t-1"]);
    expect(latest!.loading).toBe(false);
  });

  it("never paints the previous project's tasks for a never-visited project", async () => {
    tasksByProject({ b1: [task("t-b")] });
    await render("b1");
    seen.length = 0;

    getTasks.mockImplementation(() => new Promise<never>(() => {}));
    await render("b2");
    expect(seen.every((ids) => ids.length === 0)).toBe(true);
    expect(latest!.loading).toBe(true);
  });

  it("keeps loading on a revisit before the project's first load ever landed", async () => {
    getTasks.mockImplementation(() => new Promise<never>(() => {}));
    await render("e1");
    await render("e2");
    await render("e1");
    expect(latest!.tasks).toEqual([]);
    expect(latest!.loading).toBe(true);
  });

  it("keeps loading on a revisit after the project's only load failed", async () => {
    getTasks.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await render("f1");
    await render("f2");
    getTasks.mockImplementation(() => new Promise<never>(() => {}));
    await render("f1");
    expect(latest!.loading).toBe(true);
  });

  it("drops a late response for a project already switched away from", async () => {
    const slow = deferred<Task[]>();
    getTasks.mockImplementation(async (projectId: string) =>
      projectId === "c1" ? slow.promise : [task("t-c2")]);
    await render("c1");
    await render("c2");
    expect(latest!.tasks.map((t) => t.id)).toEqual(["t-c2"]);

    await act(async () => { slow.resolve([task("t-c1")]); await slow.promise; });
    expect(latest!.tasks.map((t) => t.id)).toEqual(["t-c2"]);
  });

  it("does not append a task created before a project switch to the new project", async () => {
    tasksByProject({ d1: [], d2: [task("t-d2")] });
    const created = deferred<Task>();
    createTask.mockReturnValue(created.promise);
    await render("d1");

    let pending!: Promise<unknown>;
    act(() => { pending = latest!.createTask({ description: "x" }); });
    await render("d2");
    await act(async () => { created.resolve(task("t-new")); await pending; });
    expect(latest!.tasks.map((t) => t.id)).toEqual(["t-d2"]);
  });
});
