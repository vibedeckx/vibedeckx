import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { runCompareToDiff } from "./diff-routes.js";

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function commit(repo: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(repo, file), content);
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", message]);
}

describe("runCompareToDiff", () => {
  it("returns only the branch's changes since the merge-base (three-dot)", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "diff-compare-test-"));
    try {
      run(repo, ["init", "-b", "main"]);
      run(repo, ["config", "user.email", "test@test.local"]);
      run(repo, ["config", "user.name", "Test"]);
      commit(repo, "base.txt", "base", "base");
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "feature.txt", "branch-change", "dev commit");
      run(repo, ["checkout", "main"]);
      commit(repo, "mainline.txt", "main-only-change", "main advances");
      run(repo, ["checkout", "dev1"]);

      const diff = runCompareToDiff(repo, "main");
      expect(diff).toContain("+branch-change");
      // Three-dot must NOT show main's own advance as a deletion.
      expect(diff).not.toContain("main-only-change");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
