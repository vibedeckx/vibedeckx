import { describe, expect, it } from "vitest";
import { findUnhealthyWorkspaces } from "./workspace-health.js";
import type { RegisteredWorkspaceCheckout, WorkspaceCheckoutStatus } from "../storage/types.js";

let sequence = 0;

function row(opts: {
  workspaceId: string;
  branch: string;
  targetId: string;
  status?: WorkspaceCheckoutStatus;
  error?: string | null;
  deleted?: boolean;
}): RegisteredWorkspaceCheckout {
  sequence += 1;
  return {
    workspace: {
      id: opts.workspaceId,
      project_id: "p1",
      branch: opts.branch,
      status: "ready",
      error: null,
      created_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-08T00:00:00Z",
    },
    checkout: {
      id: `checkout-${sequence}`,
      workspace_id: opts.workspaceId,
      target_id: opts.targetId,
      worktree_path: `/tmp/${opts.branch}`,
      path_source: "conventional",
      expected_branch: opts.branch,
      status: opts.status ?? "ready",
      error: opts.error ?? null,
      deleted_at: opts.deleted ? "2026-09-08T00:00:00Z" : null,
      created_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-08T00:00:00Z",
    },
  };
}

const labelOf = (targetId: string) => targetId === "local" ? "local" : targetId === "s1" ? "worker3" : "Mac";

describe("findUnhealthyWorkspaces", () => {
  it("reports a delete that finished on one machine and not the other", () => {
    // The shape the user hit: worker3 tombstoned, Mac still holding it.
    const health = findUnhealthyWorkspaces([
      row({ workspaceId: "w1", branch: "dev2", targetId: "s1", status: "deleting", deleted: true }),
      row({ workspaceId: "w1", branch: "dev2", targetId: "s2" }),
    ], labelOf);

    expect(health).toEqual([{
      branch: "dev2",
      unfinishedDelete: true,
      targets: [
        { targetId: "s1", label: "worker3", state: "deleted" },
        { targetId: "s2", label: "Mac", state: "present", status: "ready", error: null },
      ],
    }]);
  });

  it("says nothing about a workspace that lives on every machine", () => {
    expect(findUnhealthyWorkspaces([
      row({ workspaceId: "w1", branch: "dev", targetId: "s1" }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s2" }),
    ], labelOf)).toEqual([]);
  });

  it("says nothing once the delete has finished everywhere", () => {
    expect(findUnhealthyWorkspaces([
      row({ workspaceId: "w1", branch: "dev", targetId: "s1", deleted: true }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s2", deleted: true }),
    ], labelOf)).toEqual([]);
  });

  it("treats a machine that was made again as present, past its old tombstones", () => {
    // Every create/delete cycle leaves a row, so a machine carries its history.
    expect(findUnhealthyWorkspaces([
      row({ workspaceId: "w1", branch: "dev", targetId: "s1", deleted: true }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s1", deleted: true }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s1" }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s2" }),
    ], labelOf)).toEqual([]);
  });

  it("reports a machine that kept a reason it could not comply", () => {
    const health = findUnhealthyWorkspaces([
      row({ workspaceId: "w1", branch: "dev", targetId: "s1" }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s2", status: "error", error: "Branch 'dev' already exists" }),
    ], labelOf);

    expect(health).toHaveLength(1);
    expect(health[0].unfinishedDelete).toBe(false);
    expect(health[0].targets).toContainEqual({
      targetId: "s2",
      label: "Mac",
      state: "present",
      status: "error",
      error: "Branch 'dev' already exists",
    });
  });

  it("ignores a machine the workspace was never on, so a late-added remote is not a disagreement", () => {
    expect(findUnhealthyWorkspaces([
      row({ workspaceId: "w1", branch: "dev", targetId: "s1" }),
    ], labelOf)).toEqual([]);
  });

  it("spells the main workspace the way the list does", () => {
    const health = findUnhealthyWorkspaces([
      row({ workspaceId: "w1", branch: "", targetId: "s1", deleted: true }),
      row({ workspaceId: "w1", branch: "", targetId: "s2" }),
    ], labelOf);

    expect(health[0].branch).toBeNull();
  });
});
