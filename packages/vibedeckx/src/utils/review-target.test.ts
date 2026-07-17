import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { captureReviewTarget, hasDrifted } from "./review-target.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" });

describe("review-target", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-rt-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "init"]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("captures HEAD and a stable digest", () => {
    const t1 = captureReviewTarget(dir);
    expect(t1.baseHead).toMatch(/^[0-9a-f]{40}$/);
    const t2 = captureReviewTarget(dir);
    expect(t2.diffDigest).toBe(t1.diffDigest);
    expect(hasDrifted(dir, t1)).toBe(false);
  });

  it("detects uncommitted working-tree drift (no HEAD change)", () => {
    const t = captureReviewTarget(dir);
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    expect(hasDrifted(dir, t)).toBe(true);
  });

  it("detects untracked-file drift", () => {
    const t = captureReviewTarget(dir);
    writeFileSync(path.join(dir, "new.txt"), "x\n");
    expect(hasDrifted(dir, t)).toBe(true);
  });

  it("returns nulls (not throws) outside a git repo", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "vdx-plain-"));
    try {
      const t = captureReviewTarget(plain);
      expect(t.baseHead).toBeNull();
      expect(hasDrifted(plain, t)).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
