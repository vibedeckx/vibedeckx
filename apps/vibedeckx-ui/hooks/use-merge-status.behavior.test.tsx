// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Worktree } from "@/lib/api";
import { useMergeStatus, type BranchMergeInfo } from "./use-merge-status";

vi.mock("@/lib/api", () => ({
  api: {
    getMergeStatus: vi.fn(),
    setMergeTarget: vi.fn(),
  },
}));

import { api } from "@/lib/api";

const getMergeStatus = vi.mocked(api.getMergeStatus);
const setMergeTarget = vi.mocked(api.setMergeTarget);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: {
  statuses: Map<string, BranchMergeInfo>;
  defaultTarget: string | null;
  repositoryLabel: string | null;
  setTarget: (branch: string, target: string | null) => void;
} | null = null;

function Probe({ projectId, worktrees }: { projectId: string | null; worktrees: Worktree[] }) {
  const { statuses, defaultTarget, repositoryLabel, setTarget } = useMergeStatus(projectId, worktrees);
  // Capture in an effect (not during render) — react-hooks/globals forbids
  // reassigning module variables mid-render. Effects run inside act(), so
  // `latest` reflects the settled state by the time assertions run.
  useEffect(() => {
    latest = { statuses, defaultTarget, repositoryLabel, setTarget };
  }, [statuses, defaultTarget, repositoryLabel, setTarget]);
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(projectId: string | null, worktrees: Worktree[]) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const r = root;
  // Async act: the hook's effect awaits api.getMergeStatus before setState.
  await act(async () => {
    r.render(<Probe projectId={projectId} worktrees={worktrees} />);
  });
}

beforeEach(() => {
  getMergeStatus.mockReset();
  setMergeTarget.mockReset();
  getMergeStatus.mockResolvedValue({
    ok: true,
    repository: { kind: "local", label: "Local" },
    entries: [],
  });
  setMergeTarget.mockResolvedValue(true);
  latest = null;
});

afterEach(() => {
  if (root) {
    const r = root;
    act(() => r.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  localStorage.clear();
});

describe("useMergeStatus (project switch reset)", () => {
  it("drops the previous project's statuses when the new project's first fetch fails", async () => {
    // Regression: keep-on-failure must never carry badges across projects —
    // same-named branches (dev1, main…) would show the old project's state.
    const worktrees: Worktree[] = [{ branch: "dev1" }];
    getMergeStatus.mockResolvedValueOnce({
      ok: true,
      repository: { kind: "remote", remoteServerId: "remote-a", label: "Remote A" },
      entries: [
        { branch: "dev1", target: "main", targetSource: "default", requestedTarget: "main", status: "unmerged", unmergedCount: 1, dirty: false },
      ],
    });
    await render("p1", worktrees);
    expect(latest!.statuses.get("dev1")).toEqual({
      branch: "dev1",
      status: "unmerged",
      unmergedCount: 1,
      dirty: false,
      target: "main",
    });
    expect(latest!.defaultTarget).toBe("main");

    getMergeStatus.mockResolvedValue({ ok: false, status: 0 });
    await render("p2", worktrees);
    expect(latest!.statuses.size).toBe(0);
    expect(latest!.defaultTarget).toBe(null);
  });

  it("keeps the same project's previous statuses on a transport failure", async () => {
    // The keep-on-failure behavior itself, scoped to one project: a refresh
    // that fails must not wipe existing badges.
    const worktrees: Worktree[] = [{ branch: "dev1" }];
    getMergeStatus.mockResolvedValueOnce({
      ok: true,
      repository: { kind: "local", label: "Local" },
      entries: [
        { branch: "dev1", target: "main", targetSource: "default", requestedTarget: "main", status: "merged", unmergedCount: 0, dirty: false },
      ],
    });
    await render("p1", worktrees);
    expect(latest!.statuses.get("dev1")).toMatchObject({ status: "merged" });

    getMergeStatus.mockResolvedValue({ ok: false, status: 0 });
    // New worktrees array identity retriggers the effect for the same project.
    await render("p1", [{ branch: "dev1" }]);
    expect(latest!.statuses.get("dev1")).toMatchObject({ status: "merged" });
  });

  it("stores the repository label from a successful batch", async () => {
    getMergeStatus.mockResolvedValueOnce({
      ok: true,
      repository: { kind: "remote", remoteServerId: "remote-a", label: "Remote A" },
      entries: [],
    });

    await render("p1", [{ branch: "dev1" }]);
    expect(latest!.repositoryLabel).toBe("Remote A");
  });

  it("keeps the label on same-project failure and clears it on project switch", async () => {
    getMergeStatus.mockResolvedValueOnce({
      ok: true,
      repository: { kind: "remote", remoteServerId: "remote-a", label: "Remote A" },
      entries: [],
    });
    await render("p1", [{ branch: "dev1" }]);
    expect(latest!.repositoryLabel).toBe("Remote A");

    getMergeStatus.mockResolvedValueOnce({ ok: false, status: 0 });
    await render("p1", [{ branch: "dev1" }]);
    expect(latest!.repositoryLabel).toBe("Remote A");

    getMergeStatus.mockResolvedValueOnce({ ok: false, status: 0 });
    await render("p2", [{ branch: "dev1" }]);
    expect(latest!.repositoryLabel).toBe(null);
  });
});

describe("useMergeStatus (server-persisted targets)", () => {
  it("keeps a missing stored target as a warning without automatically clearing it", async () => {
    getMergeStatus.mockResolvedValueOnce({
      ok: true,
      repository: { kind: "local", label: "Local" },
      entries: [
        { branch: "dev1", target: null, targetSource: "stored", requestedTarget: "ghost", error: "target-not-found" },
      ],
    });

    await render("p1", [{ branch: "dev1" }]);

    expect(latest!.statuses.get("dev1")).toEqual({
      branch: "dev1",
      error: "target-not-found",
      requestedTarget: "ghost",
      targetSource: "stored",
    });
    expect(setMergeTarget).not.toHaveBeenCalled();
    expect(getMergeStatus).toHaveBeenCalledTimes(1);
  });

  it("sends bare branch comparisons even when legacy localStorage has a target", async () => {
    localStorage.setItem("vibedeckx:mergeTarget:p1:dev1", "release");
    getMergeStatus.mockResolvedValueOnce({
      ok: true,
      repository: { kind: "local", label: "Local" },
      entries: [],
    });

    await render("p1", [{ branch: "dev1" }]);

    expect(getMergeStatus).toHaveBeenCalledWith("p1", [{ branch: "dev1" }]);
  });

  it("persists a target through the API and refetches after success", async () => {
    getMergeStatus.mockResolvedValue({
      ok: true,
      repository: { kind: "local", label: "Local" },
      entries: [],
    });
    await render("p1", [{ branch: "dev1" }]);

    await act(async () => {
      latest!.setTarget("dev1", "release");
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(getMergeStatus).toHaveBeenCalledTimes(2));

    expect(setMergeTarget).toHaveBeenCalledWith("p1", "dev1", "release");
  });

  it("does not refetch when persisting the target fails", async () => {
    setMergeTarget.mockResolvedValueOnce(false);
    getMergeStatus.mockResolvedValue({
      ok: true,
      repository: { kind: "local", label: "Local" },
      entries: [],
    });
    await render("p1", [{ branch: "dev1" }]);

    await act(async () => {
      latest!.setTarget("dev1", "release");
      await Promise.resolve();
    });

    expect(setMergeTarget).toHaveBeenCalledWith("p1", "dev1", "release");
    expect(getMergeStatus).toHaveBeenCalledTimes(1);
  });
});

describe("useMergeStatus (legacy target import)", () => {
  it("imports this project's legacy target before the first fetch and leaves other projects alone", async () => {
    let finishImport!: (ok: boolean) => void;
    setMergeTarget.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishImport = resolve;
      }),
    );
    localStorage.setItem("vibedeckx:mergeTarget:p1:feature: odd", "release candidate");
    localStorage.setItem("vibedeckx:mergeTarget:p2:dev1", "other-main");

    await render("p1", [{ branch: "feature: odd" }]);

    await vi.waitFor(() =>
      expect(setMergeTarget).toHaveBeenCalledWith(
        "p1",
        "feature: odd",
        "release candidate",
        { ifAbsent: true },
      ),
    );
    expect(getMergeStatus).not.toHaveBeenCalled();

    await act(async () => {
      finishImport(true);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(getMergeStatus).toHaveBeenCalledTimes(1));

    expect(localStorage.getItem("vibedeckx:mergeTarget:p1:feature: odd")).toBeNull();
    expect(localStorage.getItem("vibedeckx:mergeTarget:p2:dev1")).toBe("other-main");
    expect(getMergeStatus).toHaveBeenCalledWith("p1", [{ branch: "feature: odd" }]);
  });

  it("deletes the legacy key when a successful response means the server value won", async () => {
    localStorage.setItem("vibedeckx:mergeTarget:p1:dev1", "stale-local-target");

    await render("p1", [{ branch: "dev1" }]);

    await vi.waitFor(() => expect(getMergeStatus).toHaveBeenCalledTimes(1));
    expect(setMergeTarget).toHaveBeenCalledWith("p1", "dev1", "stale-local-target", {
      ifAbsent: true,
    });
    expect(localStorage.getItem("vibedeckx:mergeTarget:p1:dev1")).toBeNull();
  });

  it("keeps a failed legacy import and still fetches merge status", async () => {
    setMergeTarget.mockResolvedValueOnce(false);
    localStorage.setItem("vibedeckx:mergeTarget:p1:dev1", "release");

    await render("p1", [{ branch: "dev1" }]);

    await vi.waitFor(() => expect(getMergeStatus).toHaveBeenCalledTimes(1));
    expect(setMergeTarget).toHaveBeenCalledWith("p1", "dev1", "release", {
      ifAbsent: true,
    });
    expect(setMergeTarget).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("vibedeckx:mergeTarget:p1:dev1")).toBe("release");
  });

  it("drains a changed value before the first fetch without deleting the replacement", async () => {
    let finishOldImport!: (ok: boolean) => void;
    let finishNewImport!: (ok: boolean) => void;
    setMergeTarget
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishOldImport = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishNewImport = resolve;
        }),
      );
    const key = "vibedeckx:mergeTarget:p-changed:dev1";
    localStorage.setItem(key, "old-target");

    await render("p-changed", [{ branch: "dev1" }]);
    await vi.waitFor(() =>
      expect(setMergeTarget).toHaveBeenNthCalledWith(
        1,
        "p-changed",
        "dev1",
        "old-target",
        { ifAbsent: true },
      ),
    );

    localStorage.setItem(key, "new-target");
    await act(async () => {
      finishOldImport(true);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(setMergeTarget).toHaveBeenNthCalledWith(
        2,
        "p-changed",
        "dev1",
        "new-target",
        { ifAbsent: true },
      ),
    );
    expect(localStorage.getItem(key)).toBe("new-target");
    expect(getMergeStatus).not.toHaveBeenCalled();

    await act(async () => {
      finishNewImport(true);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(getMergeStatus).toHaveBeenCalledTimes(1));

    expect(localStorage.getItem(key)).toBeNull();
    expect(setMergeTarget.mock.invocationCallOrder[1]).toBeLessThan(
      getMergeStatus.mock.invocationCallOrder[0]!,
    );
  });

  it("drains a newly added branch before the first fetch", async () => {
    let finishFirstImport!: (ok: boolean) => void;
    let finishAddedImport!: (ok: boolean) => void;
    setMergeTarget
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishFirstImport = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishAddedImport = resolve;
        }),
      );
    const firstKey = "vibedeckx:mergeTarget:p-added:dev1";
    const addedKey = "vibedeckx:mergeTarget:p-added:dev2";
    localStorage.setItem(firstKey, "main");

    await render("p-added", [{ branch: "dev1" }, { branch: "dev2" }]);
    await vi.waitFor(() => expect(setMergeTarget).toHaveBeenCalledTimes(1));

    localStorage.setItem(addedKey, "release");
    await act(async () => {
      finishFirstImport(true);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(setMergeTarget).toHaveBeenNthCalledWith(
        2,
        "p-added",
        "dev2",
        "release",
        { ifAbsent: true },
      ),
    );
    expect(getMergeStatus).not.toHaveBeenCalled();

    await act(async () => {
      finishAddedImport(true);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(getMergeStatus).toHaveBeenCalledTimes(1));

    expect(localStorage.getItem(firstKey)).toBeNull();
    expect(localStorage.getItem(addedKey)).toBeNull();
    expect(setMergeTarget.mock.invocationCallOrder[1]).toBeLessThan(
      getMergeStatus.mock.invocationCallOrder[0]!,
    );
  });

  it("shares an in-flight import across repeated effects for the same project", async () => {
    let finishImport!: (ok: boolean) => void;
    setMergeTarget.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishImport = resolve;
      }),
    );
    localStorage.setItem("vibedeckx:mergeTarget:p-dedup:dev1", "release");

    try {
      await render("p-dedup", [{ branch: "dev1" }]);
      await vi.waitFor(() => expect(setMergeTarget).toHaveBeenCalledTimes(1));

      await render("p-dedup", [{ branch: "dev1" }]);
      expect(setMergeTarget).toHaveBeenCalledTimes(1);
      expect(getMergeStatus).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        finishImport(true);
        await Promise.resolve();
      });
    }
    await vi.waitFor(() => expect(getMergeStatus).toHaveBeenCalledTimes(1));
  });
});
