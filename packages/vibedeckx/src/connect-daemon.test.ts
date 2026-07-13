import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  daemonStatePath,
  inspectDaemonState,
  parseLinuxProcessStartTicks,
  readLinuxProcessStartTicks,
  type ConnectDaemonState,
} from "./connect-daemon.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-daemon-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeState(state: ConnectDaemonState | string): void {
  const file = daemonStatePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof state === "string" ? state : JSON.stringify(state),
  );
}

describe("Linux process identity", () => {
  it("reads field 22 from proc stat", () => {
    const stat =
      "123 (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20";
    expect(parseLinuxProcessStartTicks(stat)).toBe("987654");
  });

  it("handles process names containing spaces and closing parentheses", () => {
    const stat =
      "123 (name with ) paren) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20";
    expect(parseLinuxProcessStartTicks(stat)).toBe("424242");
  });

  it("rejects malformed proc stat", () => {
    expect(() => parseLinuxProcessStartTicks("not-a-stat-line")).toThrow(
      "Malformed Linux process stat",
    );
  });

  it("reads the current process start ticks", () => {
    expect(readLinuxProcessStartTicks(process.pid)).toMatch(/^\d+$/);
  });
});

describe("daemon state inspection", () => {
  it("reports missing state", () => {
    expect(inspectDaemonState(dataDir)).toEqual({ kind: "missing" });
  });

  it("reports a live process only when PID and start ticks match", () => {
    const processStartTicks = readLinuxProcessStartTicks(process.pid)!;
    const state: ConnectDaemonState = {
      schemaVersion: 1,
      pid: process.pid,
      processStartTicks,
      startedAt: new Date().toISOString(),
      connectTo: "https://example.com",
      version: "test",
    };
    writeState(state);
    expect(inspectDaemonState(dataDir)).toEqual({ kind: "running", state });
  });

  it("reports a reused PID as stale", () => {
    writeState({
      schemaVersion: 1,
      pid: process.pid,
      processStartTicks: "0",
      startedAt: new Date().toISOString(),
      connectTo: "https://example.com",
      version: "test",
    });
    expect(inspectDaemonState(dataDir).kind).toBe("stale");
  });

  it("reports malformed JSON without deleting it", () => {
    writeState("{");
    expect(inspectDaemonState(dataDir).kind).toBe("invalid");
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });

  it("reports an unknown schema without deleting it", () => {
    writeState(JSON.stringify({ schemaVersion: 99 }));
    expect(inspectDaemonState(dataDir).kind).toBe("invalid");
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });
});
