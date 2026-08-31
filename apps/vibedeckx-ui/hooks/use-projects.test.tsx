// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProjects } from "./use-projects";
import { useUrlState } from "./use-url-state";
import type { Project } from "@/lib/api";

const getProjects = vi.fn<() => Promise<Project[]>>();
const updateProjectApi = vi.fn<(id: string, opts: Record<string, unknown>) => Promise<Project>>();

vi.mock("@/lib/api", () => ({
  api: {
    getProjects: () => getProjects(),
    updateProject: (id: string, opts: Record<string, unknown>) => updateProjectApi(id, opts),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projects = [
  { id: "project-a", name: "A", executor_mode: "local", agent_mode: "local" },
  { id: "project-b", name: "B", executor_mode: "local", agent_mode: "local" },
] as Project[];

let root: Root;
let container: HTMLDivElement;
let observed: Array<{ projectId: string | null; pending: boolean; notFound: boolean }>;

function Harness({ routeProjectId }: { routeProjectId: string | null }) {
  const { currentProject, routeProjectPending, routeProjectNotFound } = useProjects(routeProjectId);
  useEffect(() => {
    observed.push({ projectId: currentProject?.id ?? null, pending: routeProjectPending, notFound: routeProjectNotFound });
  }, [currentProject, routeProjectNotFound, routeProjectPending]);
  return <output>{currentProject?.id ?? "not-found"}</output>;
}

function BrowserHarness({ combinations }: { combinations: string[] }) {
  const route = useUrlState();
  const { currentProject, routeProjectNotFound } = useProjects(route.projectId);
  const value = `${currentProject?.id ?? (routeProjectNotFound ? "not-found" : "pending")}:${route.threadId ?? "none"}`;
  useEffect(() => { combinations.push(value); }, [combinations, value]);
  return <output>{value}</output>;
}

type UpdateFn = ReturnType<typeof useProjects>["updateProject"];
let updateProjectHandle: UpdateFn;

function UpdateHarness() {
  const { currentProject, projects: list, updateProject } = useProjects("project-a");
  // Re-captured after every render: updateProject closes over the latest state.
  useEffect(() => { updateProjectHandle = updateProject; });
  const inList = list.find((p) => p.id === "project-a");
  return <output>{`${currentProject?.executor_mode ?? "-"}|${inList?.executor_mode ?? "-"}|${currentProject?.name ?? "-"}`}</output>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  getProjects.mockResolvedValue(projects);
  observed = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("useProjects route restoration", () => {
  it("masks the old project while browser navigation resolves another project", async () => {
    await act(async () => root.render(<Harness routeProjectId="project-a" />));
    expect(container.textContent).toBe("project-a");

    act(() => root.render(<Harness routeProjectId="project-b" />));
    await act(async () => {});

    expect(container.textContent).toBe("project-b");
    expect(observed).toContainEqual({ projectId: null, pending: true, notFound: false });
    expect(observed.at(-1)).toEqual({ projectId: "project-b", pending: false, notFound: false });
  });

  it("keeps an unknown or unauthorized routed project terminally unselected", async () => {
    await act(async () => root.render(<Harness routeProjectId="project-missing" />));

    expect(container.textContent).toBe("not-found");
    expect(observed).not.toEqual(expect.arrayContaining([expect.objectContaining({ projectId: "project-a" })]));
    expect(observed.at(-1)).toEqual({ projectId: null, pending: false, notFound: true });
  });

  it("restores browser A↔B project chat navigation without combining identities", async () => {
    const combinations: string[] = [];
    window.history.replaceState(null, "", "/p/project-a/chat/thread-a");
    await act(async () => root.render(<BrowserHarness combinations={combinations} />));
    expect(container.textContent).toBe("project-a:thread-a");

    await act(async () => {
      window.history.replaceState(null, "", "/p/project-b/chat/thread-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(container.textContent).toBe("project-b:thread-b");
    expect(combinations).not.toContain("project-a:thread-b");
    expect(combinations).not.toContain("project-b:thread-a");
  });
});

describe("useProjects optimistic mode updates", () => {
  it("applies executorMode locally before the PUT resolves, then adopts the server row", async () => {
    await act(async () => root.render(<UpdateHarness />));
    expect(container.textContent).toBe("local|local|A");

    const put = deferred<Project>();
    updateProjectApi.mockReturnValueOnce(put.promise);

    let pending!: Promise<Project>;
    act(() => { pending = updateProjectHandle("project-a", { executorMode: "srv-1" as Project["executor_mode"] }); });
    // Both the current project and the list entry flip synchronously.
    expect(container.textContent).toBe("srv-1|srv-1|A");
    expect(updateProjectApi).toHaveBeenCalledWith("project-a", { executorMode: "srv-1" });

    await act(async () => {
      put.resolve({ ...projects[0], executor_mode: "srv-1", name: "A (server)" } as Project);
      await pending;
    });
    expect(container.textContent).toBe("srv-1|srv-1|A (server)");
  });

  it("reverts to the last confirmed value when the PUT fails", async () => {
    await act(async () => root.render(<UpdateHarness />));
    const put = deferred<Project>();
    updateProjectApi.mockReturnValueOnce(put.promise);

    let pending!: Promise<Project>;
    act(() => { pending = updateProjectHandle("project-a", { executorMode: "srv-1" as Project["executor_mode"] }); });
    expect(container.textContent).toBe("srv-1|srv-1|A");

    await act(async () => {
      put.reject(new Error("boom"));
      await expect(pending).rejects.toThrow("boom");
    });
    expect(container.textContent).toBe("local|local|A");
  });

  it("keeps the newest choice when an earlier PUT resolves last", async () => {
    await act(async () => root.render(<UpdateHarness />));
    const first = deferred<Project>();
    const second = deferred<Project>();
    updateProjectApi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let p1!: Promise<Project>;
    let p2!: Promise<Project>;
    act(() => { p1 = updateProjectHandle("project-a", { executorMode: "srv-1" as Project["executor_mode"] }); });
    act(() => { p2 = updateProjectHandle("project-a", { executorMode: "srv-2" as Project["executor_mode"] }); });
    expect(container.textContent).toBe("srv-2|srv-2|A");

    await act(async () => {
      second.resolve({ ...projects[0], executor_mode: "srv-2" } as Project);
      await p2;
    });
    expect(container.textContent).toBe("srv-2|srv-2|A");

    // The stale first response must not roll the UI back to srv-1.
    await act(async () => {
      first.resolve({ ...projects[0], executor_mode: "srv-1" } as Project);
      await p1;
    });
    expect(container.textContent).toBe("srv-2|srv-2|A");
  });

  it("restores the pre-chain baseline when the final request of a burst fails", async () => {
    await act(async () => root.render(<UpdateHarness />));
    const first = deferred<Project>();
    const second = deferred<Project>();
    updateProjectApi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let p1!: Promise<Project>;
    let p2!: Promise<Project>;
    act(() => { p1 = updateProjectHandle("project-a", { executorMode: "srv-1" as Project["executor_mode"] }); });
    act(() => { p2 = updateProjectHandle("project-a", { executorMode: "srv-2" as Project["executor_mode"] }); });

    await act(async () => {
      first.reject(new Error("first failed"));
      await expect(p1).rejects.toThrow("first failed");
    });
    // Not the latest request: no rollback yet.
    expect(container.textContent).toBe("srv-2|srv-2|A");

    await act(async () => {
      second.reject(new Error("second failed"));
      await expect(p2).rejects.toThrow("second failed");
    });
    expect(container.textContent).toBe("local|local|A");
  });

  it("does not apply non-mode edits until the server confirms them", async () => {
    await act(async () => root.render(<UpdateHarness />));
    const put = deferred<Project>();
    updateProjectApi.mockReturnValueOnce(put.promise);

    let pending!: Promise<Project>;
    act(() => { pending = updateProjectHandle("project-a", { name: "Renamed" }); });
    expect(container.textContent).toBe("local|local|A");

    await act(async () => {
      put.resolve({ ...projects[0], name: "Renamed" } as Project);
      await pending;
    });
    expect(container.textContent).toBe("local|local|Renamed");
  });
});
