import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  computeBranchMergeStatus,
  computeMergeStatusPairs,
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

    it("rebased onto a base that shifted only diff context => merged (tier 4)", () => {
      // A change and a nearby-but-non-overlapping base edit. The rebased twin
      // has a byte-identical change (`-line3 +FEATURE`) but a different context
      // line, so its patch-id differs and `git cherry` flags it — yet the
      // content is fully in target. merge-tree containment must catch this.
      commit(repo, "f.txt", "line1\nline2\nline3\n", "seed file");
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "f.txt", "line1\nline2\nFEATURE\n", "dev edits line3");
      const devTip = run(repo, ["rev-parse", "dev1"]).trim();
      // target advances with an edit to line1 (nearby, no overlap), then takes
      // the dev change as a rebased copy (new SHA, shifted context).
      run(repo, ["checkout", "main"]);
      commit(repo, "f.txt", "TARGET2\nline2\nline3\n", "main edits line1");
      run(repo, ["cherry-pick", devTip]);
      expect(run(repo, ["cherry", "main", "dev1"]).trim()).toMatch(/^\+/); // cherry alone misses it
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "merged",
        unmergedCount: 0,
      });
    });

    it("squash-merged branch => merged (tier 4)", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit 1");
      commit(repo, "b.txt", "b", "dev commit 2");
      run(repo, ["checkout", "main"]);
      run(repo, ["merge", "--squash", "dev1"]);
      run(repo, ["commit", "-m", "squash dev1"]);
      // Squash flattens both commits into one with no matching patch-ids, so
      // cherry reports them unmerged; the resulting tree is identical.
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
      // Advance main first so the cherry-pick gets a different parent — an
      // unchanged parent + same-second timestamps yields a byte-identical
      // SHA, making the commit shared history that `git cherry` omits.
      commit(repo, "m.txt", "m", "main advances");
      run(repo, ["cherry-pick", first]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "partial",
        unmergedCount: 1,
      });
    });

    it("stays unmerged with deep pre-fork history (denominator regression)", () => {
      commit(repo, "h1.txt", "1", "history 1");
      commit(repo, "h2.txt", "2", "history 2");
      commit(repo, "h3.txt", "3", "history 3");
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit 1");
      commit(repo, "b.txt", "b", "dev commit 2");
      run(repo, ["checkout", "main"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "unmerged",
        unmergedCount: 2,
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

  describe("computeMergeStatusPairs", () => {
    function addWorktree(branch: string): string {
      const base = getWorktreeBaseForProject(repo);
      mkdirSync(base, { recursive: true });
      const wtPath = path.join(base, branch);
      run(repo, ["worktree", "add", "-b", branch, wtPath]);
      invalidateWorktreeListCache(repo);
      return wtPath;
    }

    it("computes each pair against its own target", () => {
      const dev1 = addWorktree("dev1");
      commit(dev1, "a.txt", "a", "dev1 commit");
      run(repo, ["branch", "release"]);
      const entries = computeMergeStatusPairs(repo, [
        { branch: "dev1" },
        { branch: "dev1", target: "release" },
      ]);
      expect(entries).toEqual([
        { branch: "dev1", target: "main", status: "unmerged", unmergedCount: 1, dirty: false },
        { branch: "dev1", target: "release", status: "unmerged", unmergedCount: 1, dirty: false },
      ]);
    });

    it("reports dirty from the branch's worktree; false when not checked out anywhere", () => {
      const dev1 = addWorktree("dev1");
      writeFileSync(path.join(dev1, "wip.txt"), "wip");
      run(repo, ["branch", "loose"]);
      const entries = computeMergeStatusPairs(repo, [{ branch: "dev1" }, { branch: "loose" }]);
      expect(entries[0].dirty).toBe(true);
      expect(entries[1].dirty).toBe(false);
    });

    it("reports per-pair errors without failing the batch", () => {
      run(repo, ["branch", "dev1"]);
      const entries = computeMergeStatusPairs(repo, [
        { branch: "dev1", target: "ghost" },
        { branch: "ghost" },
        { branch: "dev1" },
      ]);
      expect(entries[0]).toEqual({ branch: "dev1", target: null, error: "target-not-found" });
      expect(entries[1]).toEqual({ branch: "ghost", target: "main", error: "branch-not-found" });
      expect(entries[2].status).toBe("no-unique-commits");
    });

    it("errors no-default-branch only for pairs that need the default", () => {
      const trunk = initRepo("trunk");
      try {
        run(trunk, ["branch", "dev1"]);
        const entries = computeMergeStatusPairs(trunk, [
          { branch: "dev1" },
          { branch: "dev1", target: "trunk" },
        ]);
        expect(entries[0]).toEqual({ branch: "dev1", target: null, error: "no-default-branch" });
        expect(entries[1].status).toBe("no-unique-commits");
      } finally {
        rmSync(trunk, { recursive: true, force: true });
      }
    });

    it("memoizes a failed default detection across pairs", () => {
      const trunk = initRepo("trunk");
      try {
        run(trunk, ["branch", "dev1"]);
        run(trunk, ["branch", "dev2"]);
        const entries = computeMergeStatusPairs(trunk, [{ branch: "dev1" }, { branch: "dev2" }]);
        expect(entries.map((e) => e.error)).toEqual(["no-default-branch", "no-default-branch"]);
      } finally {
        rmSync(trunk, { recursive: true, force: true });
      }
    });

    it("branch equal to target reads no-unique-commits", () => {
      const entries = computeMergeStatusPairs(repo, [{ branch: "main", target: "main" }]);
      expect(entries[0].status).toBe("no-unique-commits");
    });

    it("returns an empty array for an empty batch", () => {
      expect(computeMergeStatusPairs(repo, [])).toEqual([]);
    });
  });
});
