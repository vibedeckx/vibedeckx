// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectRemote } from "@/lib/api";
import type { WorkspaceMachineCheck, WorkspaceMachineState, WorkspaceTargetState } from "@/lib/worktree-target-results";

const getProjectBranches = vi.hoisted(() => vi.fn());
const createWorktree = vi.hoisted(() => vi.fn());
const getProjectRemotes = vi.hoisted(() => vi.fn());
const getWorktreeMachines = vi.hoisted(() => vi.fn());

// What the project screen already holds, when the dialog renders under it.
const sharedRemotes = vi.hoisted(() => ({
  value: null as null | { remotes: unknown[]; loading: boolean; loaded: boolean; refresh: () => Promise<void> },
}));

vi.mock("@/lib/api", () => ({
  api: { getProjectBranches, createWorktree, getProjectRemotes, getWorktreeMachines },
}));
vi.mock("@/hooks/project-remotes-context", () => ({
  useOptionalProjectRemotesContext: () => sharedRemotes.value,
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

  const onOpenChange = vi.fn();
  const render = (props?: {
    initialBranchName?: string;
    initialTargets?: WorkspaceTargetState[];
    initialMachines?: WorkspaceMachineState[];
    initialSelectedTargets?: string[];
    open?: boolean;
  }) =>
    act(async () => {
      root.render(
        <CreateWorktreeDialog
          projectId="p1"
          project={project}
          open={props?.open ?? true}
          onOpenChange={onOpenChange}
          onWorktreeCreated={() => {}}
          initialBranchName={props?.initialBranchName}
          initialTargets={props?.initialTargets}
          initialMachines={props?.initialMachines}
          initialSelectedTargets={props?.initialSelectedTargets}
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
    sharedRemotes.value = null;
    getProjectBranches.mockResolvedValue(["main", "dev"]);
    createWorktree.mockResolvedValue({ worktree: { branch: "feature/x" } });
    // A server without the live-check route; the list's view stands.
    getWorktreeMachines.mockResolvedValue(null);
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
    expect(document.body.textContent).toContain("gpu-01");
    expect(document.body.textContent).toContain("gpu-02");
    expect(machineRows().every((box) => box.checked)).toBe(true);
  });

  it("opens already showing the machines the project screen knows", async () => {
    sharedRemotes.value = {
      remotes: [remote("srv-1", "gpu-01", "/srv/work/vibedeckx"), remote("srv-2", "gpu-02", "/srv/work/vibedeckx")],
      loading: false,
      loaded: true,
      refresh: async () => {},
    };
    // The dialog's own request never settles, so anything on screen can only
    // be the list the app was already holding — no round trip, no resize.
    getProjectRemotes.mockReturnValue(new Promise(() => {}));

    await render();

    expect(machineRows()).toHaveLength(3);
    expect(document.body.textContent).toContain("gpu-02");
  });

  it("does not carry one workspace's base branch into the next", async () => {
    // No machine reports "main", so the pick lands on "dev".
    getProjectBranches.mockResolvedValue(["dev", "release"]);

    await render();
    await typeBranch("feature/x");

    const baseBranch = () =>
      document.body.querySelector('[data-slot="select-trigger"]')?.textContent;
    expect(baseBranch()).toBe("dev");

    await clickCreate();
    expect(createWorktree).toHaveBeenCalledTimes(1);
    // The parent closes the dialog on a create that fully succeeded.
    await render({ open: false });

    // Opened again, on machines that do report "main": the next workspace gets
    // the default, not whatever the last one happened to be cut from.
    getProjectBranches.mockResolvedValue(["main", "dev", "release"]);
    await render();

    expect(baseBranch()).toBe("main");
  });

  it("will not create on a shared list it has not confirmed", async () => {
    sharedRemotes.value = {
      remotes: [remote("srv-1", "gpu-01", "/srv/work/vibedeckx")],
      loading: false,
      loaded: true,
      refresh: async () => {},
    };
    getProjectRemotes.mockReturnValue(new Promise(() => {}));

    await render();
    await typeBranch("feature/x");

    // The shared list is as old as the project screen's last fetch: a remote
    // linked since then would be missed by a create that went out now.
    expect(createButton().hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).toContain("Confirming this project's machines");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("keeps the picked base branch when a late machine widens the list", async () => {
    // The project screen knows one remote; a second was linked since, and only
    // this dialog's own fetch turns it up.
    sharedRemotes.value = {
      remotes: [remote("srv-1", "gpu-01", "/srv/work/vibedeckx")],
      loading: false,
      loaded: true,
      refresh: async () => {},
    };
    let confirm: (list: ProjectRemote[]) => void;
    getProjectRemotes.mockReturnValue(new Promise<ProjectRemote[]>((resolve) => { confirm = resolve; }));
    getProjectBranches.mockImplementation(async (_id: string, target?: string) => {
      if (target === "local") return ["dev", "release"];
      if (target === "srv-1") return ["dev"];
      return ["main", "dev"];
    });

    await render();

    const baseBranch = () =>
      document.body.querySelector('[data-slot="select-trigger"]')?.textContent;
    // No "main" among the first two machines, so the pick landed on "dev".
    expect(baseBranch()).toBe("dev");

    await act(async () => {
      confirm([
        remote("srv-1", "gpu-01", "/srv/work/vibedeckx"),
        remote("srv-2", "gpu-02", "/srv/work/vibedeckx"),
      ]);
    });

    // gpu-02 brings "main" into the list, which the default would prefer —
    // but "dev" is still a valid start point and is the one that was picked.
    expect(document.body.textContent).toContain("3 branches");
    expect(baseBranch()).toBe("dev");
  });

  it("does not re-query branches when the confirmed list matches the shared one", async () => {
    sharedRemotes.value = {
      remotes: [remote("srv-1", "gpu-01", "/srv/work/vibedeckx"), remote("srv-2", "gpu-02", "/srv/work/vibedeckx")],
      loading: false,
      loaded: true,
      refresh: async () => {},
    };

    await render();

    // Same machines, a different array: one query per machine, not two.
    expect(getProjectBranches).toHaveBeenCalledTimes(3);
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

  const nameCell = (label: string) =>
    rowFor(label).closest("label")!.querySelector<HTMLElement>(`[title="${label}"]`)!;

  it("gives every row the same name width, so the badges start on one line", async () => {
    getProjectRemotes.mockResolvedValue([
      remote("srv-1", "gpu-01", "/srv/work/vibedeckx"),
      remote("srv-2", "build-runner-eu", "/srv/work/vibedeckx"),
    ]);

    await render();

    // Sized by the longest name in the list, not by each row's own.
    const widths = ["Local", "gpu-01", "build-runner-eu"].map((l) => nameCell(l).style.width);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe("16ch");
  });

  it("caps the name column so one long name cannot eat the row", async () => {
    getProjectRemotes.mockResolvedValue([
      remote("srv-1", "gpu-01", "/srv/work/vibedeckx"),
      remote("srv-2", "build-runner-eu-west-1-spot-fleet", "/srv/work/vibedeckx"),
    ]);

    await render();

    expect(nameCell("gpu-01").style.width).toBe("20ch");
  });

  // The row can only spare so much width for a path, and an end-ellipsis eats
  // the one part that tells two checkouts under the same parent apart.
  const pathCell = (label: string) =>
    rowFor(label).closest("label")!.querySelector<HTMLElement>("[title^='/']")!;

  it("keeps a path's last segment while the head ellipsizes", async () => {
    getProjectRemotes.mockResolvedValue([
      remote("srv-1", "gpu-01", "/srv/work/checkouts/vibedeckx-a"),
      remote("srv-2", "gpu-02", "/srv/work/checkouts/vibedeckx-b"),
    ]);

    await render();

    for (const [label, tail] of [["gpu-01", "/vibedeckx-a"], ["gpu-02", "/vibedeckx-b"]]) {
      const cell = pathCell(label);
      const [head, pinned] = Array.from(cell.children) as HTMLElement[];
      expect(cell.title).toBe(`/srv/work/checkouts${tail}`);
      expect(head.textContent).toBe("/srv/work/checkouts");
      expect(head.className).toContain("truncate");
      expect(pinned.textContent).toBe(tail);
      expect(pinned.className).toContain("shrink-0");
    }
  });

  it("leaves a path with no head to spare on plain end-truncation", async () => {
    // One segment, and one long enough that pinning it would push the row wide
    // — neither has a tail worth holding a row open for.
    const long = `/${"vibedeckx-checkout-with-a-very-long-name".repeat(1)}`;
    getProjectRemotes.mockResolvedValue([
      remote("srv-1", "gpu-01", "/vibedeckx"),
      remote("srv-2", "gpu-02", `/srv/work${long}`),
    ]);

    await render();

    for (const [label, path] of [["gpu-01", "/vibedeckx"], ["gpu-02", `/srv/work${long}`]]) {
      const [head, pinned] = Array.from(pathCell(label).children) as HTMLElement[];
      expect(head.textContent).toBe(path);
      expect(head.className).toContain("truncate");
      expect(pinned.textContent).toBe("");
    }
  });
});

describe("CreateWorktreeDialog managing an existing workspace", () => {
  let container: HTMLElement;
  let root: Root;
  const onOpenChange = vi.fn();

  const machine = (
    serverId: string,
    name: string,
    state: WorkspaceMachineState["state"],
    extra?: Partial<WorkspaceMachineState>,
  ): WorkspaceMachineState => ({ serverId, name, state, ...extra });

  const render = (props: {
    initialMachines?: WorkspaceMachineState[];
    initialSelectedTargets?: string[];
  }) =>
    act(async () => {
      root.render(
        <CreateWorktreeDialog
          projectId="p1"
          project={project}
          open
          onOpenChange={onOpenChange}
          onWorktreeCreated={() => {}}
          initialBranchName="dev"
          initialMachines={props.initialMachines}
          initialSelectedTargets={props.initialSelectedTargets}
        />,
      );
    });

  const rowFor = (label: string) =>
    Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((box) => box.closest("label")?.textContent?.includes(label))!;
  const rowText = (label: string) => rowFor(label).closest("label")!.textContent ?? "";
  const submitButton = () =>
    Array.from(document.body.querySelectorAll("button")).find((b) =>
      /^(Create|Retry) on/.test(b.textContent ?? ""),
    )!;
  const click = (element: Element) =>
    act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const flush = () => act(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    sharedRemotes.value = null;
    getProjectBranches.mockResolvedValue(["main", "dev"]);
    getProjectRemotes.mockResolvedValue([
      remote("srv-1", "gpu-01", "/srv/work/vibedeckx"),
      remote("srv-2", "gpu-02", "/srv/work/vibedeckx"),
    ]);
    getWorktreeMachines.mockResolvedValue(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("ticks the machines that lack it, and will not pick one that has it", async () => {
    await render({
      initialMachines: [
        machine("local", "local", "present"),
        machine("srv-1", "gpu-01", "absent"),
        machine("srv-2", "gpu-02", "error", { error: "disk full" }),
      ],
    });

    expect(document.body.textContent).toContain("Manage remotes for dev");
    expect(document.body.textContent).toContain("dev exists on 1 of 3 remotes");
    expect(rowFor("Local").disabled).toBe(true);
    expect(rowFor("Local").checked).toBe(false);
    expect(rowText("Local")).toContain("Has it");
    expect(rowFor("gpu-01").checked).toBe(true);
    expect(rowText("gpu-01")).toContain("Missing");
    expect(rowFor("gpu-02").checked).toBe(true);
    expect(rowText("gpu-02")).toContain("Failed");

    // Clicking a present row is a no-op: it never joins the submission.
    await click(rowFor("Local"));
    expect(submitButton().textContent).toContain("Create on 2 remotes");
    await click(submitButton());
    expect(createWorktree).toHaveBeenCalledWith("p1", "dev", ["srv-1", "srv-2"], "main");
  });

  it("keeps the name read-only: a different name is a different workspace", async () => {
    await render({ initialMachines: [machine("local", "local", "present"), machine("srv-1", "gpu-01", "absent")] });

    const input = document.body.querySelector<HTMLInputElement>("#branch-name")!;
    expect(input.value).toBe("dev");
    expect(input.readOnly).toBe(true);
    expect(document.body.textContent).toContain("Work done on other remotes is not copied");
  });

  it("will not pick a machine still creating, deleting, or one the hub cannot place", async () => {
    await render({
      initialMachines: [
        machine("local", "local", "creating"),
        machine("srv-1", "gpu-01", "deleting"),
        machine("srv-2", "gpu-02", "unknown"),
      ],
    });

    expect(rowFor("Local").disabled).toBe(true);
    expect(rowText("Local")).toContain("Creating…");
    expect(rowFor("gpu-01").disabled).toBe(true);
    expect(rowText("gpu-01")).toContain("Deleting…");
    // The live check is unavailable, so the unknown stays unknown.
    expect(rowFor("gpu-02").disabled).toBe(true);
    expect(rowText("gpu-02")).toContain("Could not check");
    expect(submitButton().hasAttribute("disabled")).toBe(true);
  });

  it("ticks only the machines the caller named", async () => {
    await render({
      initialMachines: [
        machine("local", "local", "present"),
        machine("srv-1", "gpu-01", "absent"),
        machine("srv-2", "gpu-02", "absent"),
      ],
      initialSelectedTargets: ["srv-2", "local"],
    });

    expect(rowFor("gpu-01").checked).toBe(false);
    expect(rowFor("gpu-02").checked).toBe(true);
    // Named but not pickable: ignored.
    expect(rowFor("Local").checked).toBe(false);
  });

  it("asks every machine once on opening, and places the ones the hub could not", async () => {
    let answer!: (value: { branch: string; machines: WorkspaceMachineCheck[] }) => void;
    getWorktreeMachines.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await render({
      initialMachines: [
        machine("local", "local", "present"),
        machine("srv-1", "gpu-01", "unknown"),
        machine("srv-2", "gpu-02", "unknown"),
      ],
    });

    expect(getWorktreeMachines).toHaveBeenCalledTimes(1);
    expect(getWorktreeMachines).toHaveBeenCalledWith("p1", "dev");
    expect(rowText("gpu-01")).toContain("Checking…");
    expect(rowFor("gpu-01").disabled).toBe(true);

    await act(async () => {
      answer({
        branch: "dev",
        machines: [
          { serverId: "local", name: "local", state: "present", checked: true },
          { serverId: "srv-1", name: "gpu-01", state: "absent", checked: true },
          { serverId: "srv-2", name: "gpu-02", state: "unknown", checked: false, checkError: "not connected" },
        ],
      });
    });

    // Placed as missing: ticked, like it would have opened.
    expect(rowFor("gpu-01").disabled).toBe(false);
    expect(rowFor("gpu-01").checked).toBe(true);
    expect(rowText("gpu-01")).toContain("Missing");
    // Still nowhere: cannot be picked, and says so.
    expect(rowFor("gpu-02").disabled).toBe(true);
    expect(rowText("gpu-02")).toContain("Could not check");
    expect(getWorktreeMachines).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's narrowing when the live check places another machine", async () => {
    // "Create it on gpu-01": gpu-02 turning out to be missing too is not a
    // reason to create it there as well.
    getWorktreeMachines.mockResolvedValue({
      branch: "dev",
      machines: [
        { serverId: "local", name: "local", state: "present", checked: true },
        { serverId: "srv-1", name: "gpu-01", state: "absent", checked: true },
        { serverId: "srv-2", name: "gpu-02", state: "absent", checked: true },
      ],
    });
    await render({
      initialMachines: [
        machine("local", "local", "present"),
        machine("srv-1", "gpu-01", "absent"),
        machine("srv-2", "gpu-02", "unknown"),
      ],
      initialSelectedTargets: ["srv-1"],
    });
    await flush();

    expect(rowFor("gpu-01").checked).toBe(true);
    expect(rowFor("gpu-02").disabled).toBe(false);
    expect(rowFor("gpu-02").checked).toBe(false);
    await click(submitButton());
    expect(createWorktree).toHaveBeenCalledWith("p1", "dev", ["srv-1"], "main");
  });

  it("does not create while the live check is still out", async () => {
    let answer!: (value: { branch: string; machines: WorkspaceMachineCheck[] }) => void;
    getWorktreeMachines.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await render({ initialMachines: [machine("local", "local", "present"), machine("srv-1", "gpu-01", "absent")] });

    // An answer landing after a create would describe the machines as they
    // were before it.
    expect(submitButton().hasAttribute("disabled")).toBe(true);
    await click(submitButton());
    expect(createWorktree).not.toHaveBeenCalled();

    await act(async () => {
      answer({
        branch: "dev",
        machines: [
          { serverId: "local", name: "local", state: "present", checked: true },
          { serverId: "srv-1", name: "gpu-01", state: "absent", checked: true },
        ],
      });
    });
    expect(submitButton().hasAttribute("disabled")).toBe(false);
  });

  it("asks again on request", async () => {
    getWorktreeMachines.mockResolvedValue({
      branch: "dev",
      machines: [
        { serverId: "local", name: "local", state: "present", checked: true },
        { serverId: "srv-1", name: "gpu-01", state: "present", checked: true },
        { serverId: "srv-2", name: "gpu-02", state: "absent", checked: true },
      ],
    });
    await render({ initialMachines: [machine("local", "local", "present"), machine("srv-1", "gpu-01", "absent"), machine("srv-2", "gpu-02", "absent")] });
    await flush();

    // The live answer outranks the list: gpu-01 turned out to have it.
    expect(rowFor("gpu-01").disabled).toBe(true);
    expect(rowText("gpu-01")).toContain("Has it");
    expect(rowFor("gpu-02").checked).toBe(true);

    const again = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("Check again"))!;
    await click(again);
    await flush();
    expect(getWorktreeMachines).toHaveBeenCalledTimes(2);
  });

  it("falls back to the list's view when the server has no live check", async () => {
    getWorktreeMachines.mockResolvedValue(null);
    await render({ initialMachines: [machine("local", "local", "present"), machine("srv-1", "gpu-01", "absent"), machine("srv-2", "gpu-02", "unknown")] });
    await flush();

    expect(rowFor("gpu-01").checked).toBe(true);
    expect(rowText("gpu-02")).toContain("Could not check");
  });

  it("after a partial success, keeps only the failures ticked and retries just those", async () => {
    createWorktree.mockResolvedValueOnce({
      worktree: { branch: "dev" },
      partialSuccess: true,
      results: {
        "srv-1": { success: true, label: "gpu-01", targetId: "srv-1", adopted: true },
        "srv-2": { success: false, label: "gpu-02", targetId: "srv-2", error: "disk full" },
      },
    });
    await render({
      initialMachines: [
        machine("local", "local", "present"),
        machine("srv-1", "gpu-01", "absent"),
        machine("srv-2", "gpu-02", "absent"),
      ],
    });

    await click(submitButton());

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(rowFor("gpu-01").checked).toBe(false);
    expect(rowFor("gpu-01").disabled).toBe(true);
    expect(rowText("gpu-01")).toContain("Reused");
    expect(rowFor("gpu-02").checked).toBe(true);
    expect(rowText("gpu-02")).toContain("disk full");
    expect(submitButton().textContent).toContain("Retry on 1 remote");

    createWorktree.mockResolvedValueOnce({
      worktree: { branch: "dev" },
      results: { "srv-2": { success: true, label: "gpu-02", targetId: "srv-2" } },
    });
    await click(submitButton());
    expect(createWorktree).toHaveBeenLastCalledWith("p1", "dev", ["srv-2"], "main");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
