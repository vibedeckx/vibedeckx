import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installRuntime,
  launcherPath,
  readCurrentVersion,
  runtimeRoot,
  validateRuntimeSource,
  verifyRuntimeVersion,
  writeServiceEnv,
  type RuntimeSource,
} from "./connect-runtime.js";

let workDir: string;
let dataDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-runtime-"));
  dataDir = path.join(workDir, "data");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A stand-in release: package with dist/bin.js + bundled native modules, and a fake node. */
function fakeRelease(version: string, nodeBody = "fake-node-v1"): RuntimeSource {
  const root = path.join(workDir, `pkg-${version}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@vibedeckx/test", version }));
  fs.writeFileSync(path.join(root, "dist", "bin.js"), `// bin ${version}\n`);
  for (const nativeModule of ["better-sqlite3", "node-pty"]) {
    fs.mkdirSync(path.join(root, "node_modules", nativeModule, "build"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", nativeModule, "build", "native.node"), `${nativeModule}-${version}`);
  }
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.symlinkSync("../node-pty/build/native.node", path.join(root, "node_modules", ".bin", "pty"));

  // The "node" just echoes what the launcher hands it.
  const nodePath = path.join(root, "fake-node");
  fs.writeFileSync(
    nodePath,
    `#!/bin/sh\n# ${nodeBody}\necho "runtime=$VIBEDECKX_RUNTIME_DIR"\necho "args=$*"\necho "path=$PATH"\n`,
  );
  fs.chmodSync(nodePath, 0o755);
  return validateRuntimeSource(root, nodePath);
}

describe("validateRuntimeSource", () => {
  it("rejects a source checkout whose native modules are symlinks", () => {
    const source = fakeRelease("1.0.0");
    const modulePath = path.join(source.packageRoot, "node_modules", "better-sqlite3");
    fs.rmSync(modulePath, { recursive: true });
    fs.symlinkSync(workDir, modulePath);
    expect(() => validateRuntimeSource(source.packageRoot, source.nodePath)).toThrow(/symlink/);
  });

  it("rejects a package without dist/bin.js", () => {
    const source = fakeRelease("1.0.0");
    fs.rmSync(path.join(source.packageRoot, "dist"), { recursive: true });
    expect(() => validateRuntimeSource(source.packageRoot, source.nodePath)).toThrow(/bin\.js/);
  });
});

const versionDirs = (): string[] =>
  fs
    .readdirSync(runtimeRoot(dataDir))
    .filter((name) => /^\d/.test(name))
    .sort();

describe("installRuntime", () => {
  it("installs a verified, self-contained build and makes it current", () => {
    const result = installRuntime(dataDir, fakeRelease("1.0.0"));

    expect(result).toMatchObject({ version: "1.0.0", copied: true });
    expect(result.buildId).toMatch(/^1\.0\.0\+[0-9a-f]{12}$/);
    expect(readCurrentVersion(dataDir)).toBe(result.buildId);
    const versionDir = result.versionDir;
    expect(versionDir).toBe(path.join(runtimeRoot(dataDir), result.buildId));
    expect(fs.existsSync(path.join(versionDir, "node"))).toBe(true);
    expect(fs.existsSync(path.join(versionDir, "package", "dist", "bin.js"))).toBe(true);
    expect(fs.readlinkSync(path.join(versionDir, "package", "node_modules", ".bin", "pty"))).toBe(
      "../node-pty/build/native.node",
    );
    expect(verifyRuntimeVersion(versionDir)).toBe(true);
    expect(fs.readdirSync(runtimeRoot(dataDir)).some((name) => name.startsWith(".staging-"))).toBe(false);
  });

  it("runs the current build's own node through the launcher", () => {
    const { versionDir: installed } = installRuntime(dataDir, fakeRelease("1.0.0"));
    const output = execFileSync(launcherPath(dataDir), ["connect", "--data-dir", "/d"], { encoding: "utf8" });
    const versionDir = fs.realpathSync(installed);
    expect(output).toContain(`runtime=${versionDir}`);
    expect(output).toContain(`args=${path.join(versionDir, "package", "dist", "bin.js")} connect --data-dir /d`);
  });

  it("loads service.env only when the service definition asks for it", () => {
    installRuntime(dataDir, fakeRelease("1.0.0"));
    // The fake node prints its PATH too; a quote in a directory must survive.
    const servicePath = "/opt/it's here:/usr/bin:/bin";
    expect(writeServiceEnv(dataDir, servicePath)).toBe(true);
    expect(writeServiceEnv(dataDir, servicePath)).toBe(false);
    const run = (args: string[]) =>
      execFileSync(launcherPath(dataDir), args, {
        encoding: "utf8",
        // Inherited by everything the worker spawns, so it must not count.
        env: { PATH: "/usr/bin:/bin", VIBEDECKX_SUPERVISOR: "launchd" },
      });

    const service = run(["--service-env", "connect"]);
    expect(service).toContain(`path=${servicePath}`);
    expect(service).toMatch(/args=\S+ connect$/m);
    // The ~/.local/bin shim runs from the user's shell, whose PATH must win.
    expect(run(["connect"])).toContain("path=/usr/bin:/bin");
  });

  it("is idempotent for an intact build", () => {
    const source = fakeRelease("1.0.0");
    const first = installRuntime(dataDir, source);
    const again = installRuntime(dataDir, source);
    expect(again).toMatchObject({ copied: false, buildId: first.buildId });
    expect(versionDirs()).toEqual([first.buildId]);
  });

  it("installs a rebuilt package with the same version beside the old one", () => {
    const first = installRuntime(dataDir, fakeRelease("1.0.0"));
    const rebuilt = fakeRelease("1.0.0");
    fs.writeFileSync(path.join(rebuilt.packageRoot, "dist", "bin.js"), "// rebuilt\n");
    const second = installRuntime(dataDir, rebuilt);

    expect(second.copied).toBe(true);
    expect(second.buildId).not.toBe(first.buildId);
    expect(readCurrentVersion(dataDir)).toBe(second.buildId);
    expect(fs.readFileSync(path.join(second.versionDir, "package", "dist", "bin.js"), "utf8")).toBe("// rebuilt\n");
    // The previous build is untouched (it may still be running) and kept for rollback.
    expect(verifyRuntimeVersion(first.versionDir)).toBe(true);
    expect(second.previous).toBe(first.buildId);
  });

  it("repairs a damaged current build without ever deleting it first", () => {
    const source = fakeRelease("1.0.0");
    const first = installRuntime(dataDir, source);
    fs.writeFileSync(path.join(first.versionDir, "package", "dist", "bin.js"), "tampered");
    expect(verifyRuntimeVersion(first.versionDir)).toBe(false);

    const repaired = installRuntime(dataDir, source);
    expect(repaired.copied).toBe(true);
    expect(repaired.versionDir).not.toBe(first.versionDir);
    expect(readCurrentVersion(dataDir)).toBe(repaired.buildId);
    expect(verifyRuntimeVersion(repaired.versionDir)).toBe(true);
  });

  it("keeps the current build runnable when an install is interrupted before the switch", () => {
    const first = installRuntime(dataDir, fakeRelease("1.0.0"));
    const rebuilt = fakeRelease("1.0.0");
    fs.writeFileSync(path.join(rebuilt.packageRoot, "dist", "bin.js"), "// rebuilt\n");

    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(".staging-")) throw new Error("interrupted");
      return realRename(from, to);
    });
    try {
      expect(() => installRuntime(dataDir, rebuilt)).toThrow("interrupted");
    } finally {
      spy.mockRestore();
    }

    expect(readCurrentVersion(dataDir)).toBe(first.buildId);
    expect(verifyRuntimeVersion(first.versionDir)).toBe(true);
    expect(execFileSync(launcherPath(dataDir), [], { encoding: "utf8" })).toContain(
      `runtime=${fs.realpathSync(first.versionDir)}`,
    );
  });

  it("keeps the previous build for rollback and prunes older ones", () => {
    const a = installRuntime(dataDir, fakeRelease("1.0.0"));
    const b = installRuntime(dataDir, fakeRelease("1.1.0"));
    const c = installRuntime(dataDir, fakeRelease("1.2.0"));

    expect(readCurrentVersion(dataDir)).toBe(c.buildId);
    expect(c.previous).toBe(b.buildId);
    expect(c.pruned).toEqual([a.buildId]);
    expect(fs.readFileSync(path.join(runtimeRoot(dataDir), "previous"), "utf8").trim()).toBe(b.buildId);
    expect(versionDirs()).toEqual([b.buildId, c.buildId].sort());
  });

  it("leaves current on the old build when installing the new one fails", () => {
    const first = installRuntime(dataDir, fakeRelease("1.0.0"));
    const broken = fakeRelease("2.0.0");
    // An unreadable file makes the copy fail part-way.
    const unreadable = path.join(broken.packageRoot, "dist", "secret.js");
    fs.writeFileSync(unreadable, "x");
    fs.chmodSync(unreadable, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root reads everything
      expect(() => installRuntime(dataDir, broken)).toThrow();
      expect(readCurrentVersion(dataDir)).toBe(first.buildId);
      expect(versionDirs()).toEqual([first.buildId]);
    } finally {
      fs.chmodSync(unreadable, 0o644);
    }
  });

  it("refuses to start from a broken layout with EX_CONFIG", () => {
    installRuntime(dataDir, fakeRelease("1.0.0"));
    fs.writeFileSync(path.join(runtimeRoot(dataDir), "current"), "../../etc\n");
    let status: number | undefined;
    try {
      execFileSync(launcherPath(dataDir), [], { stdio: "pipe" });
    } catch (error) {
      status = (error as { status?: number }).status;
    }
    expect(status).toBe(78);
  });
});
