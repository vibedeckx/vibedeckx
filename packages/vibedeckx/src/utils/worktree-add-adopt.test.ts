import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  applyWorktreeAdd,
  conventionalWorktreePath,
  getWorktreeBaseForProject,
  invalidateWorktreeListCache,
  parseGitWorktreeList,
  planWorktreeAdd,
  worktreeRecordExists,
} from "./worktree-paths.js";

/** Plan + apply, the way the create routes run them. */
const addOrAdoptWorktree = (projectPath: string, branch: string, startPoint: string) => {
  const plan = planWorktreeAdd(projectPath, branch, startPoint);
  applyWorktreeAdd(projectPath, plan);
  return { worktreePath: plan.worktreePath, adopted: plan.adopted };
};

describe("addOrAdoptWorktree", () => {
  let dir: string;
  let projectPath: string;

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", projectPath, ...args], { encoding: "utf-8" }).trim();

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-worktree-adopt-"));
    projectPath = path.join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", projectPath]);
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-m", "base");
    invalidateWorktreeListCache(projectPath);
  });

  afterEach(() => {
    const base = getWorktreeBaseForProject(projectPath);
    if (existsSync(base)) {
      for (const entry of parseGitWorktreeList(projectPath)) {
        if (entry.path !== projectPath) {
          execFileSync("git", ["-C", projectPath, "worktree", "remove", "--force", entry.path]);
        }
      }
      rmSync(base, { recursive: true, force: true });
    }
    invalidateWorktreeListCache(projectPath);
    rmSync(dir, { recursive: true, force: true });
  });

  it("cuts a new branch from the base branch when nothing exists yet", () => {
    const outcome = addOrAdoptWorktree(projectPath, "dev", "main");

    expect(outcome).toEqual({ worktreePath: conventionalWorktreePath(projectPath, "dev"), adopted: false });
    expect(git("rev-parse", "dev")).toBe(git("rev-parse", "main"));
  });

  it("checks out a leftover branch instead of refusing it", () => {
    // Exactly the state a deleted workspace leaves behind: the branch survives
    // its worktree, and it carries commits the base branch does not have.
    git("branch", "dev", "main");
    git("commit", "--allow-empty", "-m", "work on dev");
    git("branch", "-f", "dev", "HEAD");
    git("reset", "--hard", "HEAD~1");
    invalidateWorktreeListCache(projectPath);
    const devHead = git("rev-parse", "dev");
    expect(devHead).not.toBe(git("rev-parse", "main"));

    const outcome = addOrAdoptWorktree(projectPath, "dev", "main");

    expect(outcome).toEqual({ worktreePath: conventionalWorktreePath(projectPath, "dev"), adopted: true });
    // The adopted branch keeps its own history — the base branch was ignored.
    expect(execFileSync("git", ["-C", outcome.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim())
      .toBe(devHead);
  });

  it("adopts the existing worktree without touching Git when there already is one", () => {
    const first = addOrAdoptWorktree(projectPath, "dev", "main");
    execFileSync("git", ["-C", first.worktreePath, "commit", "--allow-empty", "-m", "later"], { encoding: "utf-8" });
    invalidateWorktreeListCache(projectPath);
    const head = execFileSync("git", ["-C", first.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    const second = addOrAdoptWorktree(projectPath, "dev", "main");

    expect(second).toEqual({ worktreePath: first.worktreePath, adopted: true });
    expect(parseGitWorktreeList(projectPath)).toHaveLength(2);
    expect(execFileSync("git", ["-C", first.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim())
      .toBe(head);
  });

  it("re-checks out a branch whose worktree directory was deleted by hand", () => {
    const first = addOrAdoptWorktree(projectPath, "dev", "main");
    rmSync(first.worktreePath, { recursive: true, force: true });
    invalidateWorktreeListCache(projectPath);

    const second = addOrAdoptWorktree(projectPath, "dev", "main");

    expect(second).toEqual({ worktreePath: first.worktreePath, adopted: true });
    expect(existsSync(second.worktreePath)).toBe(true);
  });

  it("refuses the main workspace even when the project is reached through a symlink", () => {
    // Git answers with the resolved root, so a textual comparison against the
    // symlinked project path would miss it and adopt the main checkout.
    const link = path.join(dir, "link");
    symlinkSync(dir, link);
    const symlinkedProject = path.join(link, "repo");
    invalidateWorktreeListCache(symlinkedProject);

    expect(() => addOrAdoptWorktree(symlinkedProject, "main", "main"))
      .toThrowError(/checked out in the main workspace/);
  });

  it("refuses a branch that is the main workspace's own checkout", () => {
    expect(() => addOrAdoptWorktree(projectPath, "main", "main"))
      .toThrowError(/checked out in the main workspace/);
    try {
      addOrAdoptWorktree(projectPath, "main", "main");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(409);
    }
  });
});

describe("worktrees behind a symlinked base", () => {
  // The macOS shape: /var is a symlink to /private/var, so Git reports every
  // managed worktree under a path that is not literally WORKTREE_BASE_DIR.
  let dir: string;
  let projectPath: string;
  let base: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-worktree-symlink-"));
    projectPath = path.join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", projectPath]);
    execFileSync("git", ["-C", projectPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", projectPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", projectPath, "commit", "--allow-empty", "-m", "base"]);
    base = getWorktreeBaseForProject(projectPath);
    mkdirSync(path.dirname(base), { recursive: true });
    rmSync(base, { recursive: true, force: true });
    symlinkSync(mkdtempSync(path.join(tmpdir(), "vdx-worktree-real-")), base);
    invalidateWorktreeListCache(projectPath);
  });

  afterEach(() => {
    const real = existsSync(base) ? realpathSync(base) : null;
    for (const entry of parseGitWorktreeList(projectPath)) {
      if (entry.path !== projectPath) {
        execFileSync("git", ["-C", projectPath, "worktree", "remove", "--force", entry.path]);
      }
    }
    rmSync(base, { force: true });
    if (real) rmSync(real, { recursive: true, force: true });
    invalidateWorktreeListCache(projectPath);
    rmSync(dir, { recursive: true, force: true });
  });

  it("still sees its own worktrees, so they can be listed and adopted", () => {
    const first = addOrAdoptWorktree(projectPath, "dev", "main");
    invalidateWorktreeListCache(projectPath);

    // Git reports the resolved path; the entry must survive the trust filter.
    expect(parseGitWorktreeList(projectPath).map((e) => e.branch)).toEqual(["main", "dev"]);
    expect(addOrAdoptWorktree(projectPath, "dev", "main"))
      .toEqual({ worktreePath: realpathSync(first.worktreePath), adopted: true });
  });
});

describe("worktreeRecordExists", () => {
  let dir: string;
  let projectPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-worktree-record-"));
    projectPath = path.join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", projectPath]);
    execFileSync("git", ["-C", projectPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", projectPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", projectPath, "commit", "--allow-empty", "-m", "base"]);
    invalidateWorktreeListCache(projectPath);
  });

  afterEach(() => {
    // These cases leave the cached list deliberately stale, so re-read it.
    invalidateWorktreeListCache(projectPath);
    for (const entry of parseGitWorktreeList(projectPath)) {
      if (entry.path !== projectPath) {
        execFileSync("git", ["-C", projectPath, "worktree", "remove", "--force", entry.path]);
      }
    }
    rmSync(getWorktreeBaseForProject(projectPath), { recursive: true, force: true });
    invalidateWorktreeListCache(projectPath);
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers from Git now, not from the cached list", () => {
    const { worktreePath } = addOrAdoptWorktree(projectPath, "dev", "main");
    // Warm the ten-second cache, then move on behind its back.
    expect(parseGitWorktreeList(projectPath)).toHaveLength(2);
    execFileSync("git", ["-C", projectPath, "worktree", "remove", worktreePath]);

    expect(worktreeRecordExists(projectPath, worktreePath)).toBe(false);
    expect(parseGitWorktreeList(projectPath)).toHaveLength(2); // cache really was stale
  });

  it("is true while the worktree is there", () => {
    const { worktreePath } = addOrAdoptWorktree(projectPath, "dev", "main");
    expect(worktreeRecordExists(projectPath, worktreePath)).toBe(true);
  });

  it("counts a hand-deleted directory as gone, since Git marks it prunable", () => {
    const { worktreePath } = addOrAdoptWorktree(projectPath, "dev", "main");
    rmSync(worktreePath, { recursive: true, force: true });

    expect(worktreeRecordExists(projectPath, worktreePath)).toBe(false);
  });

  it("says it cannot tell, rather than 'gone', when Git cannot be asked", () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), "vdx-not-a-repo-"));
    try {
      expect(worktreeRecordExists(notARepo, path.join(notARepo, "dev"))).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
