import { describe, expect, it } from "vitest";
import type { BranchMergeInfo } from "@/hooks/use-merge-status";
import { mergeBadgeAriaLabel } from "./workspace-merge-badge";

const inSync: BranchMergeInfo = {
  branch: "dev1",
  target: "main",
  status: "no-unique-commits",
  unmergedCount: 0,
  dirty: false,
};

const merged: BranchMergeInfo = {
  branch: "dev1",
  target: "main",
  status: "merged",
  unmergedCount: 0,
  dirty: false,
};

const missingTarget: BranchMergeInfo = {
  branch: "dev1",
  error: "target-not-found",
  requestedTarget: "ghost",
  targetSource: "stored",
};

describe("mergeBadgeAriaLabel", () => {
  it("keeps the existing merged label", () => {
    expect(mergeBadgeAriaLabel(merged, "Local")).toBe(
      "Merged into main · Local",
    );
  });

  it("explains how to recover when the requested target is missing", () => {
    expect(mergeBadgeAriaLabel(missingTarget)).toBe(
      "Target branch 'ghost' not found — pick a new target or reset to default",
    );
  });

  it("appends the repository to a missing-target warning", () => {
    expect(mergeBadgeAriaLabel(missingTarget, "Remote A")).toBe(
      "Target branch 'ghost' not found — pick a new target or reset to default · Remote A",
    );
  });

  it("includes the repository used for the comparison", () => {
    expect(mergeBadgeAriaLabel(inSync, "Remote A")).toBe(
      "In sync with main · Remote A",
    );
  });

  it("places dirty state before the repository label", () => {
    expect(mergeBadgeAriaLabel({ ...inSync, dirty: true }, "Local")).toBe(
      "In sync with main · uncommitted changes · Local",
    );
  });
});
