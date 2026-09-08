// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/api";

const getProjectBranches = vi.hoisted(() => vi.fn());
const createWorktree = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: { getProjectBranches, createWorktree } }));
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
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens on the branch that is missing somewhere, ready to create", async () => {
    await render("dev");

    expect(branchInput()?.value).toBe("dev");
    // Creating again is a repair, not a new workspace — say so, since the
    // machines that already have it will keep what they have.
    expect(document.body.textContent).toContain("Create where it is missing");
    expect(document.body.textContent).toContain("machines that do not have it");
  });

  it("drops the repair framing once the name is typed over", async () => {
    await render("dev");

    const input = branchInput()!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "feature/new");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // It is an ordinary new workspace now; promising to repair 'dev' would lie.
    expect(document.body.textContent).toContain("Create New Workspace");
    expect(document.body.textContent).not.toContain("machines that do not have it");
  });

  it("is still the ordinary empty dialog when opened from the + button", async () => {
    await render(undefined);

    expect(branchInput()?.value).toBe("");
    expect(document.body.textContent).toContain("Create New Workspace");
  });
});
