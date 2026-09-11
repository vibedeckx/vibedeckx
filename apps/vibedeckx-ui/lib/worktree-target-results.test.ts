import { describe, it, expect } from "vitest";
import {
  machineStateText,
  machinesFromTargets,
  workspaceCoverage,
  coverageTooltipLead,
  type WorkspaceMachineState,
  adoptedTargets,
  appendTargetFailures,
  describeRetainedBranches,
  describeTargetResults,
  targetLabel,
  targetOutcomeLines,
} from "@/lib/worktree-target-results";

describe("describeTargetResults", () => {
  it("names the failing remote on a multi-remote project", () => {
    // The regression: keys are server ids here, so reading results.remote
    // reported "local creation failed: Unknown error".
    const message = describeTargetResults(
      {
        "5a967959": { success: true, label: "worker3" },
        "8629d781": { success: false, label: "Mac", error: "Branch 'dev2' already exists" },
      },
      "created",
    );
    expect(message).toBe(
      "Workspace created on worker3, but failed on Mac: Branch 'dev2' already exists",
    );
  });

  it("keeps working for the single-remote 'remote' key", () => {
    expect(
      describeTargetResults(
        { local: { success: true }, remote: { success: false, error: "boom" } },
        "created",
      ),
    ).toBe("Workspace created on local, but failed on remote: boom");
  });

  it("translates transport error codes and appends the request id", () => {
    const message = describeTargetResults(
      {
        local: { success: true },
        remote: { success: false, errorCode: "network_error", error: "fetch failed", requestId: "req-1" },
      },
      "created",
    );
    expect(message).toContain("remote is not connected");
    expect(message).toContain("(Request ID: req-1)");
  });

  it("lists every failure when nothing succeeded", () => {
    expect(
      describeTargetResults(
        { a: { success: false, label: "worker3", error: "x" }, b: { success: false, label: "Mac", error: "y" } },
        "created",
      ),
    ).toBe("Failed on worker3: x; Mac: y");
  });

  it("returns null when all targets succeeded", () => {
    expect(describeTargetResults({ local: { success: true } }, "created")).toBeNull();
    expect(describeTargetResults(undefined, "created")).toBeNull();
  });
});

describe("targetLabel", () => {
  it("falls back to the key when an older server sends no label", () => {
    expect(targetLabel("local")).toBe("local");
    expect(targetLabel("remote")).toBe("remote");
    expect(targetLabel("8629d781")).toBe("8629d781");
  });
});

describe("appendTargetFailures", () => {
  it("appends per-target reasons to an all-failed message", () => {
    expect(
      appendTargetFailures("Failed to create worktree on all remotes", {
        a: { success: false, label: "worker3", error: "Branch 'dev' already exists" },
        b: { success: false, label: "Mac", error: "Branch 'dev' already exists" },
      }),
    ).toBe(
      "Failed to create worktree on all remotes — worker3: Branch 'dev' already exists; Mac: Branch 'dev' already exists",
    );
  });

  it("leaves the message alone without results", () => {
    expect(appendTargetFailures("nope", undefined)).toBe("nope");
  });
});

describe("adoptedTargets", () => {
  it("names the targets that reused an existing branch", () => {
    expect(
      adoptedTargets({
        "5a967959": { success: true, label: "worker3" },
        "8629d781": { success: true, label: "Mac", adopted: true },
      }),
    ).toEqual(["Mac"]);
  });

  it("is empty when every target cut a new branch", () => {
    expect(adoptedTargets({ local: { success: true }, remote: { success: true } })).toEqual([]);
    expect(adoptedTargets(undefined)).toEqual([]);
  });
});

describe("describeRetainedBranches", () => {
  it("names the targets where the branch outlived its workspace", () => {
    expect(
      describeRetainedBranches({
        "5a967959": { success: true, label: "worker3" },
        "8629d781": { success: true, label: "Mac", branchRetained: { branch: "dev2", unmerged: true } },
      }),
    ).toBe("Kept the branch 'dev2' on Mac — it has commits that are not merged anywhere else");
  });

  it("reads the flat answer a single-target delete gives", () => {
    expect(describeRetainedBranches(undefined, { branch: "dev", unmerged: false }))
      .toBe("Kept the branch 'dev'");
  });

  it("says nothing when the branch went with the workspace", () => {
    expect(describeRetainedBranches({ local: { success: true } }, null)).toBeNull();
    expect(describeRetainedBranches(undefined, undefined)).toBeNull();
  });
});

describe("targetOutcomeLines", () => {
  it("gives one labelled line per target, with a reason only where it failed", () => {
    expect(
      targetOutcomeLines({
        "5a967959": { success: true, label: "worker3", targetId: "5a967959" },
        "8629d781": { success: false, label: "Mac", targetId: "8629d781", error: "not a working tree" },
      }),
    ).toEqual([
      { key: "5a967959", label: "worker3", targetId: "5a967959", ok: true, detail: undefined },
      // The machine id travels with the line so the UI can offer a shell there.
      { key: "8629d781", label: "Mac", targetId: "8629d781", ok: false, detail: "not a working tree" },
    ]);
  });

  it("is empty without a per-target map", () => {
    expect(targetOutcomeLines(undefined)).toEqual([]);
  });
});

describe("workspaceCoverage", () => {
  const m = (serverId: string, state: WorkspaceMachineState["state"], extra?: Partial<WorkspaceMachineState>): WorkspaceMachineState =>
    ({ serverId, name: serverId, state, ...extra });

  it("counts ready checkouts over every linked machine, and flags a known gap", () => {
    expect(workspaceCoverage([m("a", "present"), m("b", "absent"), m("c", "creating"), m("d", "unknown")]))
      .toEqual({ present: 1, total: 4, missing: true, unfinishedDelete: false });
  });

  it("calls a failed machine a gap, but not an unplaced one", () => {
    // Failed is known not to have a usable checkout; unknown is not known
    // either way, and must not read as a workspace to fill in.
    expect(workspaceCoverage([m("a", "present"), m("b", "error")]).missing).toBe(true);
    expect(workspaceCoverage([m("a", "present"), m("b", "unknown")]).missing).toBe(false);
  });

  it("reads a tombstone beside a live checkout as an unfinished delete", () => {
    expect(workspaceCoverage([m("a", "absent", { deleted: true }), m("b", "present")]))
      .toEqual({ present: 1, total: 2, missing: true, unfinishedDelete: true });
  });

  it("does not call a deliberate gap, or a never-made machine, an unfinished delete", () => {
    expect(workspaceCoverage([m("a", "present"), m("b", "absent"), m("c", "unknown")]).unfinishedDelete).toBe(false);
  });

  it("says the delete is over once it has finished everywhere", () => {
    expect(workspaceCoverage([m("a", "absent", { deleted: true }), m("b", "absent", { deleted: true })]).unfinishedDelete)
      .toBe(false);
  });
});

describe("coverageTooltipLead", () => {
  const m = (serverId: string, state: WorkspaceMachineState["state"], extra?: Partial<WorkspaceMachineState>): WorkspaceMachineState =>
    ({ serverId, name: serverId, state, ...extra });

  it("leads with the gap and the click, and names the current remote when it is the one without", () => {
    expect(coverageTooltipLead([m("a", "present"), m("b", "absent")], { branch: "dev", currentId: "b" })).toEqual([
      "Not on b, the current remote. Exists on 1 of 2 remotes. Click to create it on the others.",
    ]);
    expect(coverageTooltipLead([m("a", "present"), m("b", "error", { error: "disk full" })], { branch: "dev", currentId: "a" })).toEqual([
      "Exists on 1 of 2 remotes. Failed on b. Click to retry, or create it on the others.",
    ]);
    expect(coverageTooltipLead([m("a", "absent", { deleted: true }), m("b", "present")], { branch: "dev", currentId: "a" })).toEqual([
      "Deleted on a but still on b. Delete again to finish.",
    ]);
  });

  it("says why the merge badge is gone when the primary remote has no usable checkout", () => {
    // The primary remote (whose Git the merge badge reads) and the current
    // remote (where sessions run) are chosen separately; either can be the
    // one without. Deleted or failed there: no badge, and this says so.
    // Unknown there: the badge stays, so nothing to explain.
    expect(coverageTooltipLead([m("a", "absent", { deleted: true }), m("b", "present")], { branch: "dev", currentId: "b", primaryId: "a" })).toEqual([
      "Deleted on a but still on b. Delete again to finish.",
      "No merge status: no workspace dev on primary remote a.",
    ]);
    expect(coverageTooltipLead([m("a", "error", { error: "disk full" }), m("b", "present")], { branch: "dev", currentId: "b", primaryId: "a" })).toEqual([
      "Exists on 1 of 2 remotes. Failed on a. Click to retry, or create it on the others.",
      "No merge status: no workspace dev on primary remote a.",
    ]);
    expect(coverageTooltipLead([m("a", "unknown"), m("b", "present"), m("c", "absent")], { branch: "dev", currentId: "b", primaryId: "a" })).toEqual([
      "Exists on 1 of 3 remotes. Click to create it on the others.",
    ]);
    expect(coverageTooltipLead([m("a", "present"), m("b", "absent")], { branch: "dev", currentId: "b", primaryId: "a" })).toEqual([
      "Not on b, the current remote. Exists on 1 of 2 remotes. Click to create it on the others.",
    ]);
  });
});

describe("machinesFromTargets", () => {
  it("reads the older per-row shape as machine states", () => {
    expect(machinesFromTargets([
      { targetId: "s1", label: "worker3", state: "present", status: "ready" },
      { targetId: "s2", label: "Mac", state: "present", status: "error", error: "disk full" },
      { targetId: "s3", label: "ubuntu", state: "deleted" },
      { targetId: "s4", label: "gpu", state: "present", status: "creating" },
      { targetId: "s5", label: "mini", state: "present", status: "ready", error: "Worktree has uncommitted changes" },
    ])).toEqual([
      { serverId: "s1", name: "worker3", state: "present" },
      { serverId: "s2", name: "Mac", state: "error", error: "disk full" },
      { serverId: "s3", name: "ubuntu", state: "absent", deleted: true },
      { serverId: "s4", name: "gpu", state: "creating" },
      { serverId: "s5", name: "mini", state: "present", error: "Worktree has uncommitted changes" },
    ]);
  });
});

describe("machineStateText", () => {
  it("tells a deletion from a workspace never made, and keeps the machine's own reason", () => {
    expect(machineStateText({ serverId: "a", name: "a", state: "absent" })).toBe("Missing");
    expect(machineStateText({ serverId: "a", name: "a", state: "absent", deleted: true })).toBe("Deleted here");
    expect(machineStateText({ serverId: "a", name: "a", state: "error", error: "disk full" })).toBe("Failed — disk full");
    // A usable checkout that a delete could not take keeps the reason.
    expect(machineStateText({ serverId: "a", name: "a", state: "present", error: "uncommitted changes" }))
      .toBe("Present — could not delete: uncommitted changes");
    expect(machineStateText({ serverId: "a", name: "a", state: "unknown" })).toBe("Not checked yet");
  });
});
