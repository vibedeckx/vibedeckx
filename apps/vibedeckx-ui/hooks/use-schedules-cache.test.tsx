// @vitest-environment jsdom
//
// Page-lifetime schedule-list cache: revisiting a project seeds its schedules
// synchronously while the project-change load revalidates; a never-visited
// project seeds [] rather than showing the previous project's rows. Project
// ids are unique per test — the cache is module-level and survives across
// tests in this file.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule } from "@/lib/api";

const getSchedules = vi.hoisted(() => vi.fn(async (projectId: string): Promise<Schedule[]> => []));

vi.mock("@/lib/api", () => ({ api: { getSchedules } }));
vi.mock("@/hooks/global-event-stream", () => ({ useGlobalEventStream: () => {} }));

import { useSchedules } from "./use-schedules";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookApi = ReturnType<typeof useSchedules>;
let latest: HookApi | null = null;

function Probe({ projectId }: { projectId: string | null }) {
  latest = useSchedules(projectId);
  return null;
}

const schedule = (id: string) => ({ id } as Schedule);

describe("useSchedules cache", () => {
  let root: Root;
  let container: HTMLElement;

  const render = async (projectId: string | null) => {
    await act(async () => {
      root.render(<Probe projectId={projectId} />);
      await Promise.resolve();
    });
  };

  const schedulesByProject = (lists: Record<string, Schedule[]>) => {
    getSchedules.mockImplementation(async (projectId: string) => lists[projectId] ?? []);
  };

  beforeEach(() => {
    getSchedules.mockReset();
    getSchedules.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = null;
  });

  it("seeds a revisited project's schedules while the load revalidates", async () => {
    schedulesByProject({ a1: [schedule("sch-1")], a2: [] });
    await render("a1");
    expect(latest!.schedules.map((s) => s.id)).toEqual(["sch-1"]);
    await render("a2");

    // Hang the network: only the cache can produce rows.
    getSchedules.mockImplementation(() => new Promise<never>(() => {}));
    await render("a1");
    expect(latest!.schedules.map((s) => s.id)).toEqual(["sch-1"]);
    expect(latest!.loading).toBe(true); // revalidation in flight
  });

  it("shows no schedules for a never-visited project instead of the previous project's", async () => {
    schedulesByProject({ b1: [schedule("sch-b")] });
    await render("b1");
    expect(latest!.schedules.map((s) => s.id)).toEqual(["sch-b"]);

    getSchedules.mockImplementation(() => new Promise<never>(() => {}));
    await render("b2");
    expect(latest!.schedules).toEqual([]);
  });

  it("revalidation replaces a seeded list with the fresh one", async () => {
    schedulesByProject({ c1: [schedule("old")], c2: [] });
    await render("c1");
    await render("c2");

    schedulesByProject({ c1: [schedule("old"), schedule("new")], c2: [] });
    await render("c1");
    expect(latest!.schedules.map((s) => s.id)).toEqual(["old", "new"]);
    expect(latest!.loading).toBe(false);
  });
});
