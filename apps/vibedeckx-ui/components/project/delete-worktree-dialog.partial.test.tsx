// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "@/lib/api";

const deleteWorktree = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: { deleteWorktree } }));
vi.mock("sonner", () => ({ toast: { info: toastInfo, success: toastSuccess } }));

import { DeleteWorktreeDialog } from "./delete-worktree-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const worktree: Worktree = { branch: "dev2", path: "/tmp/dev2" } as Worktree;

const partial = {
  success: true,
  partialSuccess: true,
  results: {
    "server-1": { success: true, label: "worker3", targetId: "server-1" },
    "server-2": { success: false, label: "Mac", targetId: "server-2", error: "not a working tree" },
  },
};

describe("DeleteWorktreeDialog partial delete", () => {
  let container: HTMLElement;
  let root: Root;
  const onWorktreeDeleted = vi.fn();
  const onOpenChange = vi.fn();
  const onOpenTerminal = vi.fn();

  const render = () =>
    act(() => {
      root.render(
        <DeleteWorktreeDialog
          projectId="p1"
          worktree={worktree}
          open
          onOpenChange={onOpenChange}
          onWorktreeDeleted={onWorktreeDeleted}
          onOpenTerminal={onOpenTerminal}
        />,
      );
    });

  const click = async (label: string) => {
    const button = Array.from(document.body.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim() === label);
    expect(button, `no "${label}" button`).toBeTruthy();
    await act(async () => {
      button!.click();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names the machine that still has the workspace, and retries only by retrying the delete", async () => {
    // Retrying belongs here because this is where the failure is being read;
    // the sidebar's marker is the same action from the other direction.
    deleteWorktree.mockResolvedValueOnce(partial);
    render();
    await click("Delete");

    expect(document.body.textContent).toContain("Partly deleted");
    expect(document.body.textContent).toContain("Mac");
    expect(document.body.textContent).toContain("not a working tree");

    deleteWorktree.mockResolvedValueOnce({ success: true, partialSuccess: false, results: {} });
    await click("Retry");

    expect(deleteWorktree).toHaveBeenCalledTimes(2);
    expect(deleteWorktree).toHaveBeenLastCalledWith("p1", "dev2");
    expect(document.body.textContent).not.toContain("Partly deleted");
    expect(toastSuccess).toHaveBeenCalledWith("Deleted 'dev2' everywhere");
    // The list is refreshed after each attempt, including the retry.
    expect(onWorktreeDeleted).toHaveBeenCalledTimes(2);
  });

  it("keeps the window open, with the fresh reasons, when a retry fails again", async () => {
    deleteWorktree.mockResolvedValueOnce(partial);
    render();
    await click("Delete");

    deleteWorktree.mockResolvedValueOnce({
      success: true,
      partialSuccess: true,
      results: { "server-2": { success: false, label: "Mac", error: "remote is offline" } },
    });
    await click("Retry");

    expect(document.body.textContent).toContain("Partly deleted");
    expect(document.body.textContent).toContain("remote is offline");
    expect(document.body.textContent).not.toContain("not a working tree");
  });

  it("offers a shell on the machine that refused, since some failures no retry can clear", async () => {
    // Uncommitted changes are the case in point: Retry will refuse forever,
    // and the fix has to happen on that machine.
    deleteWorktree.mockResolvedValueOnce({
      success: true,
      partialSuccess: true,
      results: {
        "server-2": {
          success: false,
          label: "Mac",
          targetId: "server-2",
          error: "Worktree has uncommitted changes",
        },
      },
    });
    render();
    await click("Delete");
    await click("Open a terminal there");

    expect(onOpenTerminal).toHaveBeenCalledWith("dev2", "server-2");
    // The window steps out of the way so the terminal is what you see.
    expect(document.body.textContent).not.toContain("Partly deleted");
  });

  it("offers no shell for the machine that succeeded", async () => {
    deleteWorktree.mockResolvedValueOnce(partial);
    render();
    await click("Delete");

    const shells = Array.from(document.body.querySelectorAll("button"))
      .filter((button) => button.textContent?.includes("Open a terminal there"));
    expect(shells).toHaveLength(1);
  });

  it("shows a thrown error without losing the per-machine list", async () => {
    deleteWorktree.mockResolvedValueOnce(partial);
    render();
    await click("Delete");

    deleteWorktree.mockRejectedValueOnce(new Error("Failed to delete worktree on all remotes"));
    await click("Retry");

    expect(document.body.textContent).toContain("Failed to delete worktree on all remotes");
    expect(document.body.textContent).toContain("Mac");
  });
});
