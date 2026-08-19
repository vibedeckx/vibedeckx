// @vitest-environment jsdom
//
// Page-lifetime resident-session cache: revisiting a project seeds its
// sidebar session rows synchronously; a never-visited project seeds [] rather
// than leaking the previous project's rows; a refresh that was in flight when
// the project switched must not land. Project ids are unique per test — the
// cache is module-level and survives across tests in this file.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "@/lib/api";

const listBranchSessions = vi.hoisted(() =>
  vi.fn(async (projectId: string, branch: string | null) => ({ sessions: [] as unknown[] })),
);
// Default the whole-project endpoint to "cannot enumerate" so these cache
// tests keep exercising the per-branch fallback they were written against;
// the primary path has its own describe block below.
const listAliveSessions = vi.hoisted(() =>
  vi.fn(async () => ({ sessions: [] as unknown[], complete: false })),
);

vi.mock("@/lib/api", () => ({ listBranchSessions, listAliveSessions }));
vi.mock("@/hooks/global-event-stream", () => ({
  useGlobalEventStream: () => {},
  useConnectionStatus: () => ({ state: "live" }),
}));

import { useResidentSessions } from "./use-resident-sessions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookApi = ReturnType<typeof useResidentSessions>;
let latest: HookApi | null = null;

function Probe({ projectId, worktrees }: { projectId: string | null; worktrees: Worktree[] }) {
  latest = useResidentSessions(projectId, worktrees);
  return null;
}

const session = (id: string, title = "New Session") => ({
  id,
  title,
  status: "stopped",
  processAlive: true,
  updated_at: "2026-08-12T00:00:00.000Z",
});

describe("useResidentSessions cache", () => {
  let root: Root;
  let container: HTMLElement;

  const render = async (projectId: string | null, worktrees: Worktree[]) => {
    await act(async () => {
      root.render(<Probe projectId={projectId} worktrees={worktrees} />);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    listBranchSessions.mockReset();
    listBranchSessions.mockResolvedValue({ sessions: [] });
    listAliveSessions.mockReset();
    listAliveSessions.mockResolvedValue({ sessions: [], complete: false });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = null;
  });

  it("seeds a revisited project's session rows while the refresh revalidates", async () => {
    listBranchSessions.mockImplementation(async (projectId, branch) =>
      projectId === "a1" && branch === "dev"
        ? { sessions: [session("s-dev", "Fix bug")] }
        : { sessions: [] },
    );
    await render("a1", [{ branch: null }, { branch: "dev" }]);
    expect(latest!.get("dev")?.map((s) => s.id)).toEqual(["s-dev"]);

    await render("a2", [{ branch: null }]);

    // Hang the network: only the cache can produce rows.
    listBranchSessions.mockImplementation(() => new Promise<never>(() => {}));
    await render("a1", [{ branch: null }, { branch: "dev" }]);
    expect(latest!.get("dev")?.map((s) => s.id)).toEqual(["s-dev"]);
    expect(latest!.get("dev")?.[0].title).toBe("Fix bug");
  });

  it("shows no rows for a never-visited project instead of the previous project's", async () => {
    listBranchSessions.mockImplementation(async (projectId, branch) =>
      projectId === "b1" && branch === null
        ? { sessions: [session("s-root")] }
        : { sessions: [] },
    );
    await render("b1", [{ branch: null }]);
    expect(latest!.get("")?.map((s) => s.id)).toEqual(["s-root"]);

    listBranchSessions.mockImplementation(() => new Promise<never>(() => {}));
    await render("b2", [{ branch: null }]);
    // Same-named branch (root) in the new project must not inherit b1's rows.
    expect(latest!.size).toBe(0);
  });

  it("discards a refresh that was in flight when the project switched", async () => {
    let resolveOld!: (value: { sessions: unknown[] }) => void;
    listBranchSessions.mockImplementation((projectId) =>
      projectId === "c1"
        ? new Promise<{ sessions: unknown[] }>((resolve) => { resolveOld = resolve; })
        : Promise.resolve({ sessions: [] }),
    );
    await render("c1", [{ branch: null }]);
    await render("c2", [{ branch: null }]);

    // The old project's fetch lands late: it must not surface under c2 (its
    // root branch key would collide) nor poison c2's cache entry.
    await act(async () => {
      resolveOld({ sessions: [session("s-old")] });
    });
    expect(latest!.size).toBe(0);

    listBranchSessions.mockImplementation(() => new Promise<never>(() => {}));
    await render("c1", [{ branch: null }]);
    await render("c2", [{ branch: null }]);
    expect(latest!.size).toBe(0); // c2's cache stayed clean too
  });
});

describe("useResidentSessions fetch shape", () => {
  let root: Root;
  let container: HTMLElement;

  const render = async (projectId: string | null, worktrees: Worktree[]) => {
    await act(async () => {
      root.render(<Probe projectId={projectId} worktrees={worktrees} />);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    listBranchSessions.mockReset();
    listBranchSessions.mockResolvedValue({ sessions: [] });
    listAliveSessions.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = null;
  });

  it("asks once for the whole project, not once per branch", async () => {
    // The endpoint's rows carry no timestamp: they arrive most recently active
    // first and that order is what the sidebar renders.
    listAliveSessions.mockResolvedValue({
      complete: true,
      sessions: [
        { id: "s-root", title: "Root work", status: "stopped", branch: null },
        { id: "s-dev-new", title: "Fix bug", status: "running", branch: "dev" },
        { id: "s-dev-old", title: "Older", status: "stopped", branch: "dev" },
      ],
    });

    await render("d1", [{ branch: null }, { branch: "dev" }, { branch: "spike" }]);

    expect(listAliveSessions).toHaveBeenCalledTimes(1);
    expect(listBranchSessions).not.toHaveBeenCalled();
    // Rows land under the branch the server reported, not the one we asked
    // for, and keep the order it sent them in.
    expect(latest!.get("")?.map((s) => s.id)).toEqual(["s-root"]);
    expect(latest!.get("dev")?.map((s) => s.id)).toEqual(["s-dev-new", "s-dev-old"]);
    expect(latest!.get("spike")).toBeUndefined();
  });

  it("does not refetch when the workspace list is a new array with the same branches", async () => {
    // Cold load: the cached worktree seed renders first, then the network copy
    // replaces it with an identical list under a new identity. The fetch is
    // keyed on the branch content, so that identity flip costs no request.
    listAliveSessions.mockResolvedValue({ complete: true, sessions: [] });
    await render("d-ident", [{ branch: null }, { branch: "dev" }]);
    expect(listAliveSessions).toHaveBeenCalledTimes(1);

    await render("d-ident", [{ branch: null }, { branch: "dev" }]); // same content, new array
    expect(listAliveSessions).toHaveBeenCalledTimes(1);

    await render("d-ident", [{ branch: null }, { branch: "dev" }, { branch: "spike" }]); // real change
    expect(listAliveSessions).toHaveBeenCalledTimes(2);
  });

  it("does not wait for the workspace list, and keeps its rows if only that is missing", async () => {
    // Liveness is a property of the project: gating it on the worktree fetch
    // would blank the sidebar for a round-trip on every project switch.
    listAliveSessions.mockResolvedValue({
      complete: true,
      sessions: [{ id: "s-dev", title: "Fix bug", status: "running", branch: "dev" }],
    });

    await render("d3", []);

    expect(listAliveSessions).toHaveBeenCalledTimes(1);
    expect(latest!.get("dev")?.map((s) => s.id)).toEqual(["s-dev"]);

    // Old worker + no workspace list = no answer at all; the rows must stay.
    // A fresh worktrees array re-runs refresh without remounting, so this
    // asserts the hold itself rather than the cache re-seeding the same rows.
    listAliveSessions.mockResolvedValue({ sessions: [], complete: false });
    await render("d3", []);
    expect(listBranchSessions).not.toHaveBeenCalled();
    expect(latest!.get("dev")?.map((s) => s.id)).toEqual(["s-dev"]);
  });

  it("falls back to the per-branch listing when the worker can't enumerate", async () => {
    // A remote worker older than the /alive endpoint: the hub answers
    // complete:false and the sidebar must still fill, the old way.
    listAliveSessions.mockResolvedValue({ sessions: [], complete: false });
    listBranchSessions.mockImplementation(async (projectId, branch) =>
      branch === "dev" ? { sessions: [session("s-dev", "Fix bug")] } : { sessions: [] },
    );

    await render("d2", [{ branch: null }, { branch: "dev" }]);

    expect(listBranchSessions).toHaveBeenCalledTimes(2);
    expect(latest!.get("dev")?.map((s) => s.id)).toEqual(["s-dev"]);
  });
});
