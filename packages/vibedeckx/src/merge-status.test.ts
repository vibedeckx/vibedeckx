import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  computeBranchMergeStatus,
  computeMergeStatus,
  detectDefaultBranch,
  validateBranchExists,
  clearMergeStatusCache,
} from "./merge-status.js";
import {
  getWorktreeBaseForProject,
  invalidateWorktreeListCache,
} from "./utils/worktree-paths.js";

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function commit(repo: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(repo, file), content);
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", message]);
}

function initRepo(defaultBranch = "main"): string {
  const repo = mkdtempSync(path.join(tmpdir(), "merge-status-test-"));
  run(repo, ["init", "-b", defaultBranch]);
  run(repo, ["config", "user.email", "test@test.local"]);
  run(repo, ["config", "user.name", "Test"]);
  commit(repo, "base.txt", "base", "base commit");
  return repo;
}

describe("merge-status", () => {
  let repo: string;

  beforeEach(() => {
    clearMergeStatusCache();
    repo = initRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(getWorktreeBaseForProject(repo), { recursive: true, force: true });
  });

  describe("detectDefaultBranch", () => {
    it("prefers main", () => {
      expect(detectDefaultBranch(repo)).toBe("main");
    });

    it("falls back to master", () => {
      const masterRepo = initRepo("master");
      try {
        expect(detectDefaultBranch(masterRepo)).toBe("master");
      } finally {
        rmSync(masterRepo, { recursive: true, force: true });
      }
    });

    it("throws 400 when neither exists", () => {
      const bare = initRepo("trunk");
      try {
        expect(() => detectDefaultBranch(bare)).toThrowError(
          expect.objectContaining({ statusCode: 400 }),
        );
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  });

  describe("validateBranchExists", () => {
    it("true for existing, false for missing", () => {
      expect(validateBranchExists(repo, "main")).toBe(true);
      expect(validateBranchExists(repo, "nope")).toBe(false);
    });
  });

  describe("computeBranchMergeStatus", () => {
    it("fresh branch at target tip => no-unique-commits", () => {
      run(repo, ["branch", "dev1"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "no-unique-commits",
        unmergedCount: 0,
      });
    });

    it("commits not in target => unmerged with count", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit 1");
      commit(repo, "b.txt", "b", "dev commit 2");
      run(repo, ["checkout", "main"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "unmerged",
        unmergedCount: 2,
      });
    });

    it("normal merge => merged (tier 1: ancestor)", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit");
      run(repo, ["checkout", "main"]);
      commit(repo, "m.txt", "m", "main advances");
      run(repo, ["merge", "dev1", "--no-edit"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "merged",
        unmergedCount: 0,
      });
    });

    it("cherry-picked (rebase-style) => merged (tier 2: patch-id)", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit");
      const devTip = run(repo, ["rev-parse", "dev1"]).trim();
      run(repo, ["checkout", "main"]);
      commit(repo, "m.txt", "m", "main advances");
      run(repo, ["cherry-pick", devTip]);
      // dev1 tip is NOT an ancestor of main, but its patch is in main.
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "merged",
        unmergedCount: 0,
      });
    });

    it("some commits cherry-picked => partial with count", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit 1");
      const first = run(repo, ["rev-parse", "dev1"]).trim();
      commit(repo, "b.txt", "b", "dev commit 2");
      run(repo, ["checkout", "main"]);
      run(repo, ["cherry-pick", first]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "partial",
        unmergedCount: 1,
      });
    });

    it("throws 400 for unknown branch", () => {
      expect(() => computeBranchMergeStatus(repo, "ghost", "main")).toThrowError(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("recomputes when the target tip moves (cache invalidation)", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit");
      run(repo, ["checkout", "main"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main").status).toBe("unmerged");
      commit(repo, "m.txt", "m", "main advances");
      run(repo, ["merge", "dev1", "--no-edit"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main").status).toBe("merged");
    });
  });

  describe("computeMergeStatus", () => {
    function addWorktree(branch: string): string {
      const base = getWorktreeBaseForProject(repo);
      mkdirSync(base, { recursive: true });
      const wtPath = path.join(base, branch);
      run(repo, ["worktree", "add", "-b", branch, wtPath]);
      invalidateWorktreeListCache(repo);
      return wtPath;
    }

    it("reports all worktree branches with dirty flags, omitting target", () => {
      const dev1 = addWorktree("dev1");
      commit(dev1, "a.txt", "a", "dev1 commit");
      const dev2 = addWorktree("dev2");
      writeFileSync(path.join(dev2, "uncommitted.txt"), "wip");

      const result = computeMergeStatus(repo);
      expect(result.target).toBe("main");
      const byBranch = new Map(result.entries.map((e) => [e.branch, e]));
      expect(byBranch.get("dev1")).toEqual({
        branch: "dev1",
        status: "unmerged",
        unmergedCount: 1,
        dirty: false,
      });
      expect(byBranch.get("dev2")).toEqual({
        branch: "dev2",
        status: "no-unique-commits",
        unmergedCount: 0,
        dirty: true,
      });
      expect(byBranch.has("main")).toBe(false);
    });

    it("omits detached-HEAD worktrees", () => {
      const base = getWorktreeBaseForProject(repo);
      mkdirSync(base, { recursive: true });
      run(repo, ["worktree", "add", "--detach", path.join(base, "detached")]);
      invalidateWorktreeListCache(repo);
      expect(computeMergeStatus(repo).entries).toEqual([]);
    });

    it("throws 400 for a nonexistent explicit target", () => {
      expect(() => computeMergeStatus(repo, "ghost")).toThrowError(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("accepts an explicit target", () => {
      addWorktree("dev1");
      run(repo, ["branch", "release"]);
      const result = computeMergeStatus(repo, "release");
      expect(result.target).toBe("release");
      // With an explicit non-main target, the main worktree's branch is no
      // longer the target, so it appears in the entries too.
      expect(result.entries.map((e) => e.branch).sort()).toEqual(["dev1", "main"]);
    });
  });
});
