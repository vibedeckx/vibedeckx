import { describe, it, expect } from "vitest";
import {
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
        "5a967959": { success: true, label: "worker3" },
        "8629d781": { success: false, label: "Mac", error: "not a working tree" },
      }),
    ).toEqual([
      { key: "5a967959", label: "worker3", ok: true, detail: undefined },
      { key: "8629d781", label: "Mac", ok: false, detail: "not a working tree" },
    ]);
  });

  it("is empty without a per-target map", () => {
    expect(targetOutcomeLines(undefined)).toEqual([]);
  });
});
