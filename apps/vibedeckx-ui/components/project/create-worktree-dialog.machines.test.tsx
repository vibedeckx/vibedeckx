// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectRemote } from "@/lib/api";
import type { WorkspaceTargetState } from "@/lib/worktree-target-results";

const getProjectBranches = vi.hoisted(() => vi.fn());
const createWorktree = vi.hoisted(() => vi.fn());
const getProjectRemotes = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: { getProjectBranches, createWorktree, getProjectRemotes },
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { CreateWorktreeDialog } from "./create-worktree-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: Project = {
  id: "p1",
  name: "vibedeckx",
  path: "/home/me/code/vibedeckx",
  remote_path: undefined,
  is_remote: false,
  agent_mode: "local",
  executor_mode: "local",
  created_at: "2026-09-08T00:00:00Z",
};

const remote = (id: string, name: string, path: string): ProjectRemote => ({
  id: `link-${id}`,
  project_id: "p1",
  remote_server_id: id,
  remote_path: path,
  sort_order: 0,
  server_name: name,
});

describe("CreateWorktreeDialog machine list", () => {
  let container: HTMLElement;
  let root: Root;

  const render = (props?: { initialBranchName?: string; initialTargets?: WorkspaceTargetState[] }) =>
    act(async () => {
      root.render(
        <CreateWorktreeDialog
          projectId="p1"
          project={project}
          open
          onOpenChange={() => {}}
          onWorktreeCreated={() => {}}
          initialBranchName={props?.initialBranchName}
          initialTargets={props?.initialTargets}
        />,
      );
    });

  const machineRows = () =>
    Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

  const rowFor = (label: string) =>
    machineRows().find((box) => box.closest("label")?.textContent?.includes(label))!;

  const typeBranch = async (value: string) => {
    const input = document.body.querySelector<HTMLInputElement>("#branch-name")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  // The submit button carries its shortcut hint, so match on the label alone.
  const createButton = () =>
    Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Create"),
    )!;

  const clickCreate = async () => {
    const create = createButton();
    await act(async () => {
      create.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectBranches.mockResolvedValue(["main", "dev"]);
    createWorktree.mockResolvedValue({ worktree: { branch: "feature/x" } });
    getProjectRemotes.mockResolvedValue([
      remote("srv-1", "gpu-01", "/srv/work/vibedeckx"),
      remote("srv-2", "gpu-02", "/srv/work/vibedeckx"),
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists every remote as its own machine, ticked, alongside local", async () => {
    await render();

    expect(machineRows()).toHaveLength(3);
    expect(document.body.textContent).toContain("Remote · gpu-01");
    expect(document.body.textContent).toContain("Remote · gpu-02");
    expect(machineRows().every((box) => box.checked)).toBe(true);
  });

  it("picks the base branch once, from every machine's own branches", async () => {
    getProjectBranches.mockImplementation(async (_id: string, target?: string) => {
      if (target === "local") return ["main"];
      if (target === "srv-1") return ["main", "release"];
      return ["main", "only-on-gpu-02"];
    });

    await render();

    // One picker, not one per machine: the same start point everywhere.
    expect(document.body.querySelectorAll('[role="combobox"]')).toHaveLength(1);
    // Asked machine by machine: "the remote" would only ever be the first one,
    // hiding a start point that lives on the second.
    expect(getProjectBranches.mock.calls.map((call: unknown[]) => call[1]))
      .toEqual(["local", "srv-1", "srv-2"]);
    // main + release + only-on-gpu-02
    expect(document.body.textContent).toContain("3 branches");
  });

  it("ticks a machine whose last create failed, though its checkout is registered", async () => {
    await render({
      initialBranchName: "dev",
      initialTargets: [
        { targetId: "local", label: "local", state: "present", status: "ready" },
        { targetId: "srv-1", label: "gpu-01", state: "present", status: "ready" },
        // The registry keeps the row that failed. It is the machine without a
        // usable workspace, so it is the one the repair is for.
        {
          targetId: "srv-2",
          label: "gpu-02",
          state: "present",
          status: "error",
          error: "ssh: connect timeout",
        },
      ],
    });

    expect(rowFor("Local").checked).toBe(false);
    expect(rowFor("gpu-01").checked).toBe(false);
    expect(rowFor("gpu-02").checked).toBe(true);
    expect(document.body.textContent).toContain("Failed");

    await clickCreate();
    expect(createWorktree).toHaveBeenCalledWith("p1", "dev", ["srv-2"], "main");
  });

  it("refuses to create when the machine list could not be read", async () => {
    getProjectRemotes.mockRejectedValue(new Error("remote list unavailable"));

    await render();
    await typeBranch("feature/x");

    // Creating here would quietly go local-only on a project that has remotes.
    expect(createButton().hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).toContain("Could not read this project's machines");
    expect(document.body.textContent).toContain("Try again");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("creates only on the machines left ticked", async () => {
    await render();
    await typeBranch("feature/x");

    const gpu02 = rowFor("gpu-02");
    await act(async () => {
      gpu02.click();
    });
    await clickCreate();

    expect(createWorktree).toHaveBeenCalledWith("p1", "feature/x", ["local", "srv-1"], "main");
  });

  it("refuses to create with no machine ticked", async () => {
    await render();
    await typeBranch("feature/x");

    for (const box of machineRows()) {
      await act(async () => {
        box.click();
      });
    }

    expect(createButton().hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).toContain("Pick at least one machine");
  });

  it("opens a repair ticked only where the workspace is missing", async () => {
    await render({
      initialBranchName: "dev",
      initialTargets: [
        { targetId: "local", label: "local", state: "present" },
        { targetId: "srv-1", label: "gpu-01", state: "present" },
        { targetId: "srv-2", label: "gpu-02", state: "deleted" },
      ],
    });

    expect(rowFor("Local").checked).toBe(false);
    expect(rowFor("gpu-01").checked).toBe(false);
    expect(rowFor("gpu-02").checked).toBe(true);

    await clickCreate();
    expect(createWorktree).toHaveBeenCalledWith("p1", "dev", ["srv-2"], "main");
  });
});
