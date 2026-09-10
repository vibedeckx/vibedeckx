// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/api";

const getProjectBranches = vi.hoisted(() => vi.fn());
const createWorktree = vi.hoisted(() => vi.fn());
const getProjectRemotes = vi.hoisted(() => vi.fn());
const getWorktreeMachines = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: { getProjectBranches, createWorktree, getProjectRemotes, getWorktreeMachines },
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { CreateWorktreeDialog } from "./create-worktree-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: Project = {
  id: "p1",
  name: "echo-read-app",
  path: null,
  is_remote: true,
  agent_mode: "server-1",
  executor_mode: "server-1",
  created_at: "2026-09-08T00:00:00Z",
};

describe("CreateWorktreeDialog opened to repair a workspace", () => {
  let container: HTMLElement;
  let root: Root;

  const render = (initialBranchName?: string) =>
    act(async () => {
      root.render(
        <CreateWorktreeDialog
          projectId="p1"
          project={project}
          open
          onOpenChange={() => {}}
          onWorktreeCreated={() => {}}
          initialBranchName={initialBranchName}
        />,
      );
    });

  const branchInput = () =>
    document.body.querySelector<HTMLInputElement>("#branch-name");

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectBranches.mockResolvedValue(["main", "dev"]);
    getWorktreeMachines.mockResolvedValue(null);
    getProjectRemotes.mockResolvedValue([
      {
        id: "link-1",
        project_id: "p1",
        remote_server_id: "srv-1",
        remote_path: "/srv/echo-read-app",
        sort_order: 0,
        server_name: "mac",
      },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens on the existing workspace, as its remote management", async () => {
    await render("dev");

    expect(branchInput()?.value).toBe("dev");
    // Managing an existing workspace machine by machine, not creating a new
    // one: the name is the subject of the operation.
    expect(document.body.textContent).toContain("Manage remotes for dev");
    expect(document.body.textContent).not.toContain("Create New Workspace");
  });

  it("keeps the name read-only rather than letting it slide into a new workspace", async () => {
    await render("dev");

    const input = branchInput()!;
    expect(input.readOnly).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "feature/new");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The framing does not change under the user's feet: to create another
    // workspace there is the + button.
    expect(document.body.textContent).toContain("Manage remotes for dev");
    expect(document.body.textContent).toContain("use the + button");
  });

  it("is still the ordinary empty dialog when opened from the + button", async () => {
    await render(undefined);

    expect(branchInput()?.value).toBe("");
    expect(document.body.textContent).toContain("Create New Workspace");
  });
});
