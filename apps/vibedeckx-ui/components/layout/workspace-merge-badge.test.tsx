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

describe("mergeBadgeAriaLabel", () => {
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
