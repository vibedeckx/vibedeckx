import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, rmSync as rmFile } from "fs";
import { tmpdir } from "os";
import path from "path";
import { captureSnapshot, ABSENT } from "./review-snapshot.js";

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

  it("returns null when not a git repo", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "vdx-norepo-"));
    expect(captureSnapshot(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});
