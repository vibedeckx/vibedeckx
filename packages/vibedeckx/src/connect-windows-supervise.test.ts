import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearStopMarker,
  nextBackoffMs,
  resolveWorkerCommand,
  runSupervise,
  sendSuperviseCommand,
  stoppedThisBoot,
  supervisePipePath,
  writeStopMarker,
  type WorkerCommand,
} from "./connect-windows-supervise.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-supervise-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/**
 * A stand-in worker. It appends "start" to events.log, exits at once while
 * `exit-next` exists (consuming it), and otherwise runs until stdin closes
 * ("eof") — unless `ignore-eof` exists.
 */
function fakeWorker(): WorkerCommand {
  const script = path.join(dataDir, "fake-worker.cjs");
  fs.writeFileSync(
    script,
    `
const fs = require("fs"), path = require("path");
const dir = ${JSON.stringify(dataDir)};
const log = (line) => fs.appendFileSync(path.join(dir, "events.log"), line + "\\n");
log("start " + process.pid + " " + (process.env.VIBEDECKX_SUPERVISOR || ""));
const exitNext = path.join(dir, "exit-next");
if (fs.existsSync(exitNext)) { fs.unlinkSync(exitNext); log("exit"); process.exit(0); }
if (fs.existsSync(path.join(dir, "ignore-eof"))) { process.stdin.resume(); setInterval(() => {}, 1000); }
else { process.stdin.on("end", () => { log("eof"); process.exit(0); }); process.stdin.resume(); }
`,
  );
  return { command: process.execPath, args: [script] };
}

function events(): string[] {
  try {
    return fs.readFileSync(path.join(dataDir, "events.log"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("stop marker", () => {
  it("holds for the boot it was written in and lapses on another", () => {
    expect(stoppedThisBoot(dataDir, 1_000_000)).toBe(false);
    writeStopMarker(dataDir, 1_000_000);
    expect(stoppedThisBoot(dataDir, 1_000_000 + 30_000)).toBe(true);
    expect(stoppedThisBoot(dataDir, 1_000_000 + 60 * 60_000)).toBe(false);
    clearStopMarker(dataDir);
    expect(stoppedThisBoot(dataDir, 1_000_000)).toBe(false);
  });
});

describe("nextBackoffMs", () => {
  it("doubles from 1 s and caps at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(nextBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("resolveWorkerCommand", () => {
  it("runs the build named by runtime/current", () => {
    const versionDir = path.join(dataDir, "runtime", "1.2.3+abc");
    fs.mkdirSync(path.join(versionDir, "package", "dist"), { recursive: true });
    fs.writeFileSync(path.join(versionDir, process.platform === "win32" ? "node.exe" : "node"), "");
    fs.writeFileSync(path.join(versionDir, "package", "dist", "bin.js"), "");
    fs.writeFileSync(path.join(dataDir, "runtime", "current"), "1.2.3+abc\n");
    const resolved = resolveWorkerCommand(dataDir, "/unused/entry.js");
    expect(resolved.runtimeDir).toBe(versionDir);
    expect(resolved.args).toEqual([path.join(versionDir, "package", "dist", "bin.js"), "connect", "--data-dir", dataDir]);
  });

  it("falls back to this process outside an installed runtime", () => {
    expect(resolveWorkerCommand(dataDir, "/dev/entry.js")).toEqual({
      command: process.execPath,
      args: ["/dev/entry.js", "connect", "--data-dir", dataDir],
    });
  });
});

describe("supervisePipePath", () => {
  it("is a named pipe on Windows, stable per data-dir", () => {
    const pipe = supervisePipePath("C:\\Users\\me\\.vibedeckx", "win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\vibedeckx-supervise-[0-9a-f]{16}$/);
    expect(supervisePipePath("C:\\Users\\me\\.vibedeckx", "win32")).toBe(pipe);
    expect(supervisePipePath("C:\\Users\\me\\other", "win32")).not.toBe(pipe);
  });
});

describe("runSupervise", () => {
  it("restarts the worker after any exit and stops it gracefully on quit", async () => {
    fs.writeFileSync(path.join(dataDir, "exit-next"), "");
    const supervised = runSupervise({ dataDir, resolveWorker: fakeWorker, backoff: () => 50 });

    // First run exits 0 at once; the supervisor starts it again.
    await waitFor(() => events().filter((line) => line.startsWith("start")).length >= 2);
    expect(events()[0]).toMatch(/^start \d+ task-scheduler$/);
    expect(events()).toContain("exit");

    const ping = JSON.parse((await sendSuperviseCommand(dataDir, "ping")) ?? "{}");
    expect(ping.pid).toBe(process.pid);
    expect(typeof ping.workerPid).toBe("number");

    expect(await sendSuperviseCommand(dataDir, "quit")).toBe("ok");
    expect(await supervised).toBe(0);
    // Graceful: the worker saw its stdin close, and was not restarted.
    expect(events().at(-1)).toBe("eof");
    expect(await sendSuperviseCommand(dataDir, "ping")).toBeUndefined();
  });

  it("kills a worker that ignores the graceful stop", async () => {
    fs.writeFileSync(path.join(dataDir, "ignore-eof"), "");
    const supervised = runSupervise({ dataDir, resolveWorker: fakeWorker, stopGraceMs: 200 });
    await waitFor(() => events().length >= 1);
    const workerPid = Number(events()[0].split(" ")[1]);
    expect(await sendSuperviseCommand(dataDir, "quit")).toBe("ok");
    expect(await supervised).toBe(0);
    expect(() => process.kill(workerPid, 0)).toThrow();
  });

  it("leaves the running supervisor alone and exits", async () => {
    const first = runSupervise({ dataDir, resolveWorker: fakeWorker });
    await waitFor(() => events().length >= 1);
    expect(await runSupervise({ dataDir, resolveWorker: fakeWorker })).toBe(0);
    expect(events().filter((line) => line.startsWith("start"))).toHaveLength(1);
    await sendSuperviseCommand(dataDir, "quit");
    expect(await first).toBe(0);
  });

  it("does not start the worker after `connect stop` in this boot", async () => {
    writeStopMarker(dataDir);
    expect(await runSupervise({ dataDir, resolveWorker: fakeWorker })).toBe(0);
    expect(events()).toEqual([]);
    expect(fs.readFileSync(path.join(dataDir, "logs", "supervise.log"), "utf8")).toMatch(/stopped by `connect stop`/);
  });
});
