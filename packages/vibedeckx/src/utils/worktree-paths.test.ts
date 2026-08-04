import path from "path";
import { describe, expect, it } from "vitest";
import { getWorktreeBaseForProject, reconcileWorktreeBranches } from "./worktree-paths.js";

describe("reconcileWorktreeBranches", () => {
  const projectPath = "/repo/project";
  const managedPath = (branch: string) =>
    path.join(getWorktreeBaseForProject(projectPath), branch.replace(/\//g, "-"));

  it("keeps the session branch as workspace identity and exposes the live drift branch", () => {
    expect(reconcileWorktreeBranches(projectPath, [
      { path: projectPath, branch: "main" },
      { path: managedPath("feature/auth"), branch: "agent/experiment" },
    ], ["feature/auth"])).toEqual([
      { branch: null },
      { branch: "feature/auth", currentBranch: "agent/experiment" },
    ]);
  });

  it("does not add drift metadata while the physical worktree is aligned", () => {
    expect(reconcileWorktreeBranches(projectPath, [
      { path: projectPath, branch: "main" },
      { path: managedPath("dev"), branch: "dev" },
    ], ["dev"])).toEqual([{ branch: null }, { branch: "dev" }]);
  });

  it("reports a detached HEAD for a workspace anchored by session history", () => {
    expect(reconcileWorktreeBranches(projectPath, [
      { path: projectPath, branch: "main" },
      { path: managedPath("dev"), branch: null },
    ], ["dev"])).toEqual([
      { branch: null },
      { branch: "dev", currentBranch: null },
    ]);
  });

  it("uses the live branch for worktrees without any session identity anchor", () => {
    expect(reconcileWorktreeBranches(projectPath, [
      { path: projectPath, branch: "main" },
      { path: managedPath("manual"), branch: "manual" },
    ])).toEqual([{ branch: null }, { branch: "manual" }]);
  });

  it("uses a persisted checkout as the identity anchor without any sessions", () => {
    const worktreePath = managedPath("dev");
    expect(reconcileWorktreeBranches(projectPath, [
      { path: projectPath, branch: "main" },
      { path: worktreePath, branch: "agent/experiment" },
    ], [], [{ branch: "dev", worktreePath, expectedBranch: "dev" }])).toEqual([
      { branch: null },
      { branch: "dev", currentBranch: "agent/experiment" },
    ]);
  });

  it("detects drift in the main workspace once its expected branch is registered", () => {
    expect(reconcileWorktreeBranches(projectPath, [
      { path: projectPath, branch: "agent/experiment" },
    ], [], [{ branch: "", worktreePath: projectPath, expectedBranch: "main" }])).toEqual([
      { branch: null, currentBranch: "agent/experiment" },
    ]);
  });
});
