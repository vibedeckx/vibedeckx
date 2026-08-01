// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProjects } from "./use-projects";
import { useUrlState } from "./use-url-state";
import type { Project } from "@/lib/api";

const getProjects = vi.fn<() => Promise<Project[]>>();

vi.mock("@/lib/api", () => ({
  api: { getProjects: () => getProjects() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projects = [
  { id: "project-a", name: "A" },
  { id: "project-b", name: "B" },
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
