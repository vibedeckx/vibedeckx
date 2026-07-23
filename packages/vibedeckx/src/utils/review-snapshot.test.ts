import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, rmSync as rmFile } from "fs";
import { tmpdir } from "os";
import path from "path";
import { captureSnapshot, computeScope, ABSENT } from "./review-snapshot.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vdx-cap-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "kept.ts"), "const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

describe("captureSnapshot", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("clean tree yields empty dirty map and current head", () => {
    const snap = captureSnapshot(dir)!;
    expect(snap.head).toBe(git(dir, ["rev-parse", "HEAD"]));
    expect(snap.dirty).toEqual({});
  });

  it("hashes an untracked file", () => {
    writeFileSync(path.join(dir, "new.ts"), "x\n");
    const snap = captureSnapshot(dir)!;
    expect(snap.dirty["new.ts"]).toBe(git(dir, ["hash-object", "new.ts"]));
  });

  it("hashes a modified tracked file", () => {
    writeFileSync(path.join(dir, "kept.ts"), "const a = 2;\n");
    const snap = captureSnapshot(dir)!;
    expect(snap.dirty["kept.ts"]).toBe(git(dir, ["hash-object", "kept.ts"]));
  });

  it("records a deletion as the ABSENT sentinel", () => {
    rmFile(path.join(dir, "kept.ts"));
    const snap = captureSnapshot(dir)!;
    expect(snap.dirty["kept.ts"]).toBe(ABSENT);
  });

  it("hashes a staged (added, not committed) file", () => {
    writeFileSync(path.join(dir, "staged.ts"), "y\n");
    git(dir, ["add", "staged.ts"]);
    const snap = captureSnapshot(dir)!;
    expect(snap.dirty["staged.ts"]).toBe(git(dir, ["hash-object", "staged.ts"]));
  });

  it("hashes an untracked file with a non-ASCII name", () => {
    const name = "café.ts";
    writeFileSync(path.join(dir, name), "z\n");
    const snap = captureSnapshot(dir)!;
    expect(snap).not.toBeNull();
    expect(snap.dirty[name]).toBe(git(dir, ["hash-object", name]));
  });

  it("returns null when not a git repo", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "vdx-norepo-"));
    expect(captureSnapshot(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("computeScope", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("excludes a pre-existing dirty file untouched by the turn; includes the new one", () => {
    // start: request-url.ts already dirty (h1). end: same request-url.ts (h1) + new actions.ts (h4)
    const start = { head: git(dir, ["rev-parse", "HEAD"]), dirty: { "request-url.ts": "h1" } };
    const end = { head: git(dir, ["rev-parse", "HEAD"]), dirty: { "request-url.ts": "h1", "actions.ts": "h4" } };
    const scope = computeScope(start, end, dir);
    expect(scope.changedFiles).toEqual(["actions.ts"]);
    expect(scope.startHead).toBe(start.head);
  });

  it("excludes a file whose prior uncommitted content was merely committed between boundaries", () => {
    // request-url.ts dirty with content C at start; user commits exactly C between turns.
    writeFileSync(path.join(dir, "request-url.ts"), "C\n");
    const startSha = git(dir, ["hash-object", "request-url.ts"]);
    const start = { head: git(dir, ["rev-parse", "HEAD"]), dirty: { "request-url.ts": startSha } };
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "commit request-url"]);
    const end = { head: git(dir, ["rev-parse", "HEAD"]), dirty: {} };
    // The committed blob equals startSha, so content is unchanged across boundaries.
    expect(computeScope(start, end, dir).changedFiles).toEqual([]);
  });

  it("includes an uncommitted deletion", () => {
    const start = { head: git(dir, ["rev-parse", "HEAD"]), dirty: {} };
    const end = { head: git(dir, ["rev-parse", "HEAD"]), dirty: { "kept.ts": ABSENT } };
    expect(computeScope(start, end, dir).changedFiles).toEqual(["kept.ts"]);
  });

  it("includes files changed by commits between the two heads", () => {
    const startHead = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(dir, "kept.ts"), "committed change\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "turn commit"]);
    const endHead = git(dir, ["rev-parse", "HEAD"]);
    const scope = computeScope({ head: startHead, dirty: {} }, { head: endHead, dirty: {} }, dir);
    expect(scope.changedFiles).toEqual(["kept.ts"]);
  });
});
