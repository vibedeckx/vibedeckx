import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimDaemonState,
  daemonStatePath,
  inspectDaemonState,
  parseLinuxProcessStartTicks,
  readLinuxProcessStartTicks,
  removeDaemonStateIfOwned,
  removeVerifiedStaleState,
  type ConnectDaemonState,
} from "./connect-daemon.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-daemon-"));
});

afterEach(() => {
  vi.restoreAllMocks();
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

function validState(
  overrides: Partial<ConnectDaemonState> = {},
): ConnectDaemonState {
  return {
    schemaVersion: 1,
    pid: process.pid,
    processStartTicks: readLinuxProcessStartTicks(process.pid)!,
    startedAt: new Date().toISOString(),
    connectTo: "https://example.com",
    version: "test",
    ...overrides,
  };
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

  it("rejects proc stat with too few fields after the process name", () => {
    expect(() => parseLinuxProcessStartTicks("123 (node) S 1 2")).toThrow(
      "Malformed Linux process stat",
    );
  });

  it("rejects a non-numeric start ticks field", () => {
    const stat =
      "123 (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 nope 20";
    expect(() => parseLinuxProcessStartTicks(stat)).toThrow(
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

  it("reports a missing process as stale", () => {
    writeState(
      validState({
        pid: Number.MAX_SAFE_INTEGER,
        processStartTicks: "1",
      }),
    );
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

  it.each([
    ["non-numeric process start ticks", "processStartTicks", "not-a-number"],
    ["invalid start timestamp", "startedAt", "not-a-date"],
    ["empty target", "connectTo", ""],
    ["empty version", "version", ""],
  ] as const)("reports %s as invalid without deleting it", (_, field, value) => {
    writeState(JSON.stringify({ ...validState(), [field]: value }));
    expect(inspectDaemonState(dataDir).kind).toBe("invalid");
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });

  it("reports state read errors as invalid without an exists/read race", () => {
    writeState(validState());
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    expect(inspectDaemonState(dataDir)).toEqual({
      kind: "invalid",
      path: daemonStatePath(dataDir),
      reason: "permission denied",
    });
    expect(existsSpy).not.toHaveBeenCalled();

    existsSpy.mockRestore();
    readSpy.mockRestore();
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });
});

describe("daemon state ownership", () => {
  it("claims state exclusively for the current process with private permissions", () => {
    const before = Date.now();
    const state = claimDaemonState(
      dataDir,
      "https://connect.example.com",
      "1.2.3",
    );
    const after = Date.now();
    const statePath = daemonStatePath(dataDir);

    expect(state).toEqual({
      schemaVersion: 1,
      pid: process.pid,
      processStartTicks: readLinuxProcessStartTicks(process.pid),
      startedAt: expect.any(String),
      connectTo: "https://connect.example.com",
      version: "1.2.3",
    });
    expect(Date.parse(state.startedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(state.startedAt)).toBeLessThanOrEqual(after);
    expect(fs.readFileSync(statePath, "utf8")).toBe(
      `${JSON.stringify(state)}\n`,
    );
    expect(fs.statSync(path.dirname(statePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("does not overwrite an existing state claim", () => {
    const state = claimDaemonState(
      dataDir,
      "https://connect.example.com",
      "1.2.3",
    );
    const statePath = daemonStatePath(dataDir);

    expect(() =>
      claimDaemonState(dataDir, "https://other.example.com", "2.0.0"),
    ).toThrow(/EEXIST|already exists/i);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual(state);
  });

  it("enforces private permissions even with a restrictive process umask", () => {
    const previousUmask = process.umask(0o777);
    try {
      claimDaemonState(dataDir, "https://example.com", "test");

      const statePath = daemonStatePath(dataDir);
      expect(fs.statSync(path.dirname(statePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
      const runDir = path.dirname(daemonStatePath(dataDir));
      if (fs.existsSync(runDir)) fs.chmodSync(runDir, 0o700);
    }
  });

  it("does not remove state owned by a different process identity", () => {
    const state = claimDaemonState(dataDir, "https://example.com", "test");

    expect(
      removeDaemonStateIfOwned(dataDir, {
        ...state,
        processStartTicks: `${state.processStartTicks}0`,
      }),
    ).toBe(false);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });

  it("removes state with the expected process identity regardless of metadata", () => {
    const state = claimDaemonState(dataDir, "https://example.com", "test");

    expect(
      removeDaemonStateIfOwned(dataDir, {
        ...state,
        connectTo: "https://different.example.com",
        version: "different",
      }),
    ).toBe(true);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(false);
  });

  it("returns false when removing missing state", () => {
    expect(removeDaemonStateIfOwned(dataDir, validState())).toBe(false);
  });
});

describe("verified stale state cleanup", () => {
  it("removes verified stale state", () => {
    writeState(
      validState({
        pid: Number.MAX_SAFE_INTEGER,
        processStartTicks: "1",
      }),
    );

    expect(removeVerifiedStaleState(dataDir)).toBe(true);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(false);
  });

  it("refuses to remove invalid state", () => {
    writeState("{");
    const statePath = daemonStatePath(dataDir);

    expect(() => removeVerifiedStaleState(dataDir)).toThrow(
      new RegExp(`${statePath}.*cannot safely remove`, "i"),
    );
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("refuses to remove running state and reports its PID", () => {
    const state = validState();
    writeState(state);

    expect(() => removeVerifiedStaleState(dataDir)).toThrow(
      new RegExp(String(state.pid)),
    );
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });

  it("returns false when state is missing", () => {
    expect(removeVerifiedStaleState(dataDir)).toBe(false);
  });
});
