import { describe, expect, it } from "vitest";
import { computeWorkspaceMachines, workspaceCoverage } from "./workspace-health.js";
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

describe("computeWorkspaceMachines", () => {
  const linked = [
    { serverId: "s1", name: "worker3", synced: true },
    { serverId: "s2", name: "Mac", synced: true },
    { serverId: "s3", name: "ubuntu", synced: false },
  ];

  it("lists every linked machine for every workspace, in the linked order", () => {
    const machines = computeWorkspaceMachines([
      row({ workspaceId: "w1", branch: "dev", targetId: "s2" }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s1", status: "error", error: "disk full" }),
    ], linked);

    expect(machines.get("dev")).toEqual([
      { serverId: "s1", name: "worker3", state: "error", error: "disk full" },
      { serverId: "s2", name: "Mac", state: "present" },
      // Never listed: no row is no evidence.
      { serverId: "s3", name: "ubuntu", state: "unknown" },
    ]);
  });

  it("keeps a refused delete's reason on a machine that still has it", () => {
    const machines = computeWorkspaceMachines([
      row({ workspaceId: "w1", branch: "dev", targetId: "s1", deleted: true }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s2", error: "Worktree has uncommitted changes" }),
    ], linked);

    expect(machines.get("dev")?.[1]).toEqual({
      serverId: "s2", name: "Mac", state: "present", error: "Worktree has uncommitted changes",
    });
  });

  it("tells a machine that deleted it from one that never had it", () => {
    const machines = computeWorkspaceMachines([
      row({ workspaceId: "w1", branch: "dev", targetId: "s1", deleted: true }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s2" }),
    ], linked);

    expect(machines.get("dev")?.[0]).toEqual({ serverId: "s1", name: "worker3", state: "absent", deleted: true });
  });

  it("lets a live row outrank an older tombstone on the same machine", () => {
    const machines = computeWorkspaceMachines([
      row({ workspaceId: "w1", branch: "dev", targetId: "s1", deleted: true }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s1", status: "creating" }),
    ], linked);

    expect(machines.get("dev")?.[0]).toEqual({ serverId: "s1", name: "worker3", state: "creating" });
  });

  it("counts only ready checkouts as coverage", () => {
    const machines = computeWorkspaceMachines([
      row({ workspaceId: "w1", branch: "dev", targetId: "s1" }),
      row({ workspaceId: "w1", branch: "dev", targetId: "s2", status: "creating" }),
    ], linked);

    expect(workspaceCoverage(machines.get("dev")!)).toEqual({ present: 1, total: 3 });
  });
});
