import { describe, expect, it } from "vitest";
import { isWorktreesLoading, preserveSelectedWorkspace, worktreesEqual } from "./use-worktrees";

describe("isWorktreesLoading", () => {
  it("is loading while a fetch is in flight", () => {
    expect(isWorktreesLoading(true, "proj-a", "proj-a")).toBe(true);
  });

  it("is not loading once the fetch for the current project has landed", () => {
    expect(isWorktreesLoading(false, "proj-a", "proj-a")).toBe(false);
  });

  // The cross-project notification race: in the commit where currentProject
  // changes, the fetch effect's setLoading(true) is not yet visible to the
  // auto-select effect running in the same pass — it would consume the pending
  // workspace selection against the PREVIOUS project's worktree list and fall
  // back to the main workspace. Deriving loading from the list's owning
  // project closes that window: a list loaded for another project is never
  // trusted, no matter what the fetch flag says.
  it("is loading when the list on hand was loaded for a different project", () => {
    expect(isWorktreesLoading(false, "proj-a", "proj-b")).toBe(true);
  });

  it("is loading before anything was fetched for a real project", () => {
    expect(isWorktreesLoading(false, null, "proj-a")).toBe(true);
  });

  it("is not loading in the no-project state", () => {
    expect(isWorktreesLoading(false, null, null)).toBe(false);
  });
});

describe("worktreesEqual", () => {
  it("treats separately allocated but structurally identical lists as equal", () => {
    expect(worktreesEqual(
      [{ branch: null }, { branch: "dev", currentBranch: "agent/work" }],
      [{ branch: null }, { branch: "dev", currentBranch: "agent/work" }],
    )).toBe(true);
  });

  it("detects a live branch change", () => {
    expect(worktreesEqual(
      [{ branch: "dev" }],
      [{ branch: "dev", currentBranch: "agent/work" }],
    )).toBe(false);
  });

  it("detects a re-anchored root whose live branch did not move", () => {
    expect(worktreesEqual(
      [{ branch: null, currentBranch: "hotfix", expectedBranch: "main" }],
      [{ branch: null, currentBranch: "hotfix", expectedBranch: "master" }],
    )).toBe(false);
  });
});

describe("preserveSelectedWorkspace", () => {
  it("keeps the selected prior workspace when a background response omits it", () => {
    expect(preserveSelectedWorkspace(
      [{ branch: null }, { branch: "dev" }],
      [{ branch: null }, { branch: "agent/work" }],
      "dev",
    )).toEqual([{ branch: null }, { branch: "dev" }, { branch: "agent/work" }]);
  });

  it("does not retain an unselected missing workspace", () => {
    const incoming = [{ branch: null }, { branch: "agent/work" }];
    expect(preserveSelectedWorkspace([{ branch: null }, { branch: "dev" }], incoming, "other"))
      .toBe(incoming);
  });
});
