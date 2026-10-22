import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { loadDiff } from "./diff-routes.js";

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function commit(repo: string, file: string, content: string, message: string): string {
  writeFileSync(path.join(repo, file), content);
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", message]);
  return run(repo, ["rev-parse", "HEAD"]).trim();
}

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function initRepo(): string {
  const repo = tempDir("diff-load-test-");
  run(repo, ["init", "-b", "main"]);
  run(repo, ["config", "user.email", "test@test.local"]);
  run(repo, ["config", "user.name", "Test"]);
  return repo;
}

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function paths(result: Awaited<ReturnType<typeof loadDiff>>): string[] {
  if (!("files" in result.body)) throw new Error(`expected files, got ${JSON.stringify(result.body)}`);
  return result.body.files.map((f) => f.path).sort();
}

describe("loadDiff", () => {
  it("returns tracked edits plus untracked files for the working tree", async () => {
    const repo = initRepo();
    commit(repo, "a.txt", "one\n", "base");
    writeFileSync(path.join(repo, "a.txt"), "two\n");
    writeFileSync(path.join(repo, "功.md"), "new\n");

    const result = await loadDiff(repo);
    expect(result.code).toBe(200);
    expect(paths(result)).toEqual(["a.txt", "功.md"]);
  });

  it("diffs a single commit, falling back to git show for a root commit", async () => {
    const repo = initRepo();
    const root = commit(repo, "a.txt", "one\n", "root");
    const second = commit(repo, "b.txt", "two\n", "second");

    expect(paths(await loadDiff(repo, second))).toEqual(["b.txt"]);
    expect(paths(await loadDiff(repo, root))).toEqual(["a.txt"]);
  });

  it("rejects an unknown compareTo branch", async () => {
    const repo = initRepo();
    commit(repo, "a.txt", "one\n", "base");
    const result = await loadDiff(repo, undefined, "nope");
    expect(result.code).toBe(400);
  });

  it("reports a git that never answers as a 504, not as an empty diff", async () => {
    const repo = initRepo();
    commit(repo, "a.txt", "one\n", "base");
    const bin = tempDir("diff-load-fake-git-");
    writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(path.join(bin, "git"), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;

    const started = Date.now();
    const result = await loadDiff(repo, undefined, undefined, 200);
    expect(result.code).toBe(504);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
