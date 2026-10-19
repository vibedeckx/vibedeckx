import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeShim, installShim, removeShim, shimPath } from "./connect-shim.js";

let home: string;
let dataDir: string;
let launcher: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-shim-"));
  dataDir = path.join(home, ".vibedeckx");
  // A launcher path with a space and a quote, to prove the quoting.
  launcher = path.join(home, "run time's", "launcher");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '#!/bin/sh\necho "launched:$*"\n', { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const binDir = () => path.join(home, ".local", "bin");

describe("installShim", () => {
  it("creates a command that execs the installed launcher with all arguments", () => {
    const outcome = installShim({ dataDir, launcher, home, pathEnv: `${binDir()}:/usr/bin` });
    expect(outcome).toEqual({ kind: "installed", path: shimPath(home), onPath: true, shadowedBy: undefined });
    expect(fs.statSync(shimPath(home)).mode & 0o111).not.toBe(0);
    expect(execFileSync(shimPath(home), ["connect", "status", "a b"], { encoding: "utf8" })).toBe(
      "launched:connect status a b\n",
    );
  });

  it("reports when its directory is not on PATH", () => {
    const outcome = installShim({ dataDir, launcher, home, pathEnv: "/usr/bin" });
    expect(outcome).toMatchObject({ kind: "installed", onPath: false });
    expect(describeShim(outcome, dataDir, launcher).join("\n")).toContain(`export PATH="${binDir()}:$PATH"`);
  });

  it("reports another vibedeckx earlier on PATH", () => {
    const other = path.join(home, "other-bin");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "vibedeckx"), "#!/bin/sh\n", { mode: 0o755 });
    const outcome = installShim({ dataDir, launcher, home, pathEnv: `${other}:${binDir()}` });
    expect(outcome).toMatchObject({ kind: "installed", shadowedBy: path.join(other, "vibedeckx") });
  });

  it("never overwrites a vibedeckx it did not write", () => {
    fs.mkdirSync(binDir(), { recursive: true });
    fs.writeFileSync(shimPath(home), "#!/bin/sh\necho mine\n", { mode: 0o755 });
    const outcome = installShim({ dataDir, launcher, home, pathEnv: binDir() });
    expect(outcome).toEqual({ kind: "foreign", path: shimPath(home) });
    expect(fs.readFileSync(shimPath(home), "utf8")).toContain("echo mine");
    expect(removeShim({ dataDir, home })).toBe(false);
    expect(fs.existsSync(shimPath(home))).toBe(true);
  });

  it("updates its own command in place", () => {
    installShim({ dataDir, launcher, home, pathEnv: binDir() });
    const moved = path.join(home, "launcher2");
    fs.copyFileSync(launcher, moved);
    fs.chmodSync(moved, 0o755);
    expect(installShim({ dataDir, launcher: moved, home, pathEnv: binDir() }).kind).toBe("installed");
    expect(fs.readFileSync(shimPath(home), "utf8")).toContain(moved);
  });

  it("is only created for the default data dir", () => {
    const other = path.join(home, "worker-b");
    const outcome = installShim({ dataDir: other, launcher, home, pathEnv: binDir() });
    expect(outcome).toEqual({ kind: "non-default" });
    expect(fs.existsSync(shimPath(home))).toBe(false);
    expect(describeShim(outcome, other, launcher)[0]).toContain(`--data-dir ${other}`);
  });

  it("removes only its own command", () => {
    installShim({ dataDir, launcher, home, pathEnv: binDir() });
    expect(removeShim({ dataDir: path.join(home, "worker-b"), home })).toBe(false);
    expect(removeShim({ dataDir, home })).toBe(true);
    expect(fs.existsSync(shimPath(home))).toBe(false);
  });
});
