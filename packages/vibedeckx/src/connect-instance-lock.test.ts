import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireInstanceLock,
  DataDirInUseError,
  instanceLockPath,
  isInstanceLockHeld,
} from "./connect-instance-lock.js";

const require = createRequire(import.meta.url);
const betterSqlitePath = require.resolve("better-sqlite3");

let dataDir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-lock-"));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/**
 * A separate process that takes the same lock the way the worker does and,
 * optionally, spawns a long-lived grandchild first (an agent CLI stand-in).
 */
function holdInChild(options: { grandchild?: boolean } = {}): Promise<{
  child: ChildProcess;
  grandchildPid?: number;
}> {
  const script = `
    const Database = require(${JSON.stringify(betterSqlitePath)});
    const { spawn } = require("node:child_process");
    const db = new Database(${JSON.stringify(instanceLockPath(dataDir))}, { timeout: 0 });
    db.exec("BEGIN EXCLUSIVE");
    let grandchild;
    if (${options.grandchild ? "true" : "false"}) {
      grandchild = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      grandchild.unref();
    }
    process.stdout.write(JSON.stringify({ held: true, grandchildPid: grandchild && grandchild.pid }) + "\\n");
    setInterval(() => db.open, 1000);
  `;
  fs.mkdirSync(path.dirname(instanceLockPath(dataDir)), { recursive: true });
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once("data", (data) => {
      const parsed = JSON.parse(String(data)) as { grandchildPid?: number };
      resolve({ child, grandchildPid: parsed.grandchildPid });
    });
    child.once("exit", (code) => reject(new Error(`holder exited early (${code})`)));
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

describe("instance lock", () => {
  it("excludes a second holder in the same process until released", () => {
    const first = acquireInstanceLock(dataDir);
    expect(() => acquireInstanceLock(dataDir, { timeoutMs: 0 })).toThrow(DataDirInUseError);
    first.release();
    const second = acquireInstanceLock(dataDir, { timeoutMs: 0 });
    second.release();
  });

  it("excludes another process and is released when that process is SIGKILLed", async () => {
    const { child } = await holdInChild();
    expect(() => acquireInstanceLock(dataDir, { timeoutMs: 0 })).toThrow(DataDirInUseError);
    expect(isInstanceLockHeld(dataDir)).toBe(true);

    child.kill("SIGKILL");
    await waitForExit(child);

    const lock = acquireInstanceLock(dataDir, { timeoutMs: 0 });
    lock.release();
  });

  it("is not held by a child that outlives the holder", async () => {
    const { child, grandchildPid } = await holdInChild({ grandchild: true });
    expect(grandchildPid).toBeGreaterThan(0);

    child.kill("SIGKILL");
    await waitForExit(child);
    // The grandchild is still alive…
    expect(() => process.kill(grandchildPid!, 0)).not.toThrow();
    try {
      // …and does not keep the data-dir locked.
      const lock = acquireInstanceLock(dataDir, { timeoutMs: 0 });
      lock.release();
    } finally {
      process.kill(grandchildPid!, "SIGKILL");
    }
  });

  it("reports an unlocked or never-used data dir as free", () => {
    expect(isInstanceLockHeld(dataDir)).toBe(false);
    acquireInstanceLock(dataDir).release();
    expect(isInstanceLockHeld(dataDir)).toBe(false);
  });

  it("names the data dir and the way out in the error", () => {
    const lock = acquireInstanceLock(dataDir);
    try {
      expect(() => acquireInstanceLock(dataDir, { timeoutMs: 0 })).toThrow(
        /in use by another vibedeckx connect worker.*connect stop/s,
      );
    } finally {
      lock.release();
    }
  });
});
