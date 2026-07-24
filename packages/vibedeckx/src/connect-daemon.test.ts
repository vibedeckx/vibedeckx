import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDaemonChildArgs,
  claimDaemonState,
  CONNECT_DAEMON_CHILD_ENV,
  CONNECT_DAEMON_TOKEN_ENV,
  consumeDaemonChildEnvironment,
  daemonStatePath,
  describeConnectDaemon,
  inspectDaemonState,
  notifyDaemonParentError,
  notifyDaemonParentReady,
  parseLinuxProcessStartTicks,
  readLinuxProcessStartTicks,
  removeDaemonStateIfOwned,
  removeVerifiedStaleState,
  resolveConnectToken,
  assertConnectDaemonPlatform,
  startConnectDaemon,
  stopConnectDaemon,
  type ConnectDaemonState,
} from "./connect-daemon.js";

let dataDir: string;
const fixtureEntrypoint = fileURLToPath(
  new URL("./__fixtures__/connect-daemon-child.mjs", import.meta.url),
);
const liveFixtureProcesses = new Map<number, string>();

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-daemon-"));
});

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function waitForFixtureExit(
  pid: number,
  startTicks: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (readLinuxProcessStartTicks(pid) !== startTicks) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readLinuxProcessStartTicks(pid) !== startTicks;
}

function signalFixture(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isErrorCode(error, "ESRCH")) throw error;
  }
}

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    for (const [pid, startTicks] of liveFixtureProcesses) {
      try {
        if (readLinuxProcessStartTicks(pid) !== startTicks) continue;
        signalFixture(pid, "SIGTERM");
        if (!(await waitForFixtureExit(pid, startTicks))) {
          signalFixture(pid, "SIGKILL");
          await waitForFixtureExit(pid, startTicks);
        }
        if (readLinuxProcessStartTicks(pid) === startTicks) {
          throw new Error(
            `Fixture PID ${pid} remained alive after test cleanup`,
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  } finally {
    liveFixtureProcesses.clear();
    try {
      vi.restoreAllMocks();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Failed to clean up daemon fixtures");
  }
});

function writeState(state: ConnectDaemonState | string): void {
  const file = daemonStatePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof state === "string" ? state : JSON.stringify(state),
  );
}

function lockPath(): string {
  return path.join(path.dirname(daemonStatePath(dataDir)), "connect.lock");
}

function writeLockOwner(
  overrides: Partial<{
    schemaVersion: 1;
    pid: number;
    processStartTicks: string;
    nonce: string;
  }> = {},
): void {
  const directory = lockPath();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, "owner.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      processStartTicks: readLinuxProcessStartTicks(process.pid),
      nonce: "test-owner",
      ...overrides,
    })}\n`,
    { mode: 0o600 },
  );
}

function expectLockedError(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(Error);
  const message = thrown instanceof Error ? thrown.message : "";
  expect(message).toContain("daemon state operation already in progress");
  expect(message).toContain(lockPath());
}

function expectStateOperationLocked(operation: () => unknown): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expectLockedError(thrown);
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

describe("daemon child arguments and environment", () => {
  it.each([
    [
      [
        "connect",
        "--connect-to",
        "https://example.com",
        "--token",
        "secret",
        "--daemon",
      ],
      ["connect", "--connect-to", "https://example.com"],
    ],
    [
      ["connect", "--token=secret", "--daemon=true", "--data-dir=/tmp/data"],
      ["connect", "--data-dir=/tmp/data"],
    ],
  ])("removes daemon and token arguments", (input, expected) => {
    expect(buildDaemonChildArgs(input)).toEqual(expected);
  });

  it("preserves all unrelated arguments byte-for-byte", () => {
    const argv = [
      "connect",
      "--connect-to",
      "https://example.com/a?x=%20",
      "--data-dir",
      "/tmp/path with spaces",
      "--other-token",
      "keep-me",
    ];

    expect(buildDaemonChildArgs(argv)).toEqual(argv);
  });

  it("rejects a standalone token flag without a value", () => {
    expect(() => buildDaemonChildArgs(["connect", "--token"])).toThrow(
      /--token.*value/i,
    );
  });

  it("consumes and deletes the internal child environment", () => {
    const env: NodeJS.ProcessEnv = {
      [CONNECT_DAEMON_CHILD_ENV]: "1",
      [CONNECT_DAEMON_TOKEN_ENV]: "secret",
      UNRELATED: "preserved",
    };

    expect(consumeDaemonChildEnvironment(env)).toEqual({
      isDaemonChild: true,
      token: "secret",
    });
    expect(env[CONNECT_DAEMON_CHILD_ENV]).toBeUndefined();
    expect(env[CONNECT_DAEMON_TOKEN_ENV]).toBeUndefined();
    expect(env.UNRELATED).toBe("preserved");
  });

  it("only recognizes the exact daemon child marker", () => {
    const env: NodeJS.ProcessEnv = {
      [CONNECT_DAEMON_CHILD_ENV]: "true",
      [CONNECT_DAEMON_TOKEN_ENV]: "secret",
    };

    expect(consumeDaemonChildEnvironment(env)).toEqual({
      isDaemonChild: false,
      token: "secret",
    });
    expect(env[CONNECT_DAEMON_CHILD_ENV]).toBeUndefined();
    expect(env[CONNECT_DAEMON_TOKEN_ENV]).toBeUndefined();
  });
});

describe("connect daemon runtime policy", () => {
  it("prefers the explicit token flag over the daemon child token", () => {
    expect(
      resolveConnectToken("flag-secret", {
        isDaemonChild: true,
        token: "child-secret",
      }),
    ).toBe("flag-secret");
  });

  it("uses the internal token only for a daemon child", () => {
    expect(
      resolveConnectToken(undefined, {
        isDaemonChild: true,
        token: "child-secret",
      }),
    ).toBe("child-secret");
  });

  it("rejects a missing connect token", () => {
    expect(() =>
      resolveConnectToken(undefined, {
        isDaemonChild: false,
        token: undefined,
      }),
    ).toThrow("Missing required --token for vibedeckx connect");
  });

  it("does not expose an internal token to a non-child process", () => {
    expect(() =>
      resolveConnectToken(undefined, {
        isDaemonChild: false,
        token: "accidental-secret",
      }),
    ).toThrow("Missing required --token for vibedeckx connect");
  });

  it("accepts Linux for daemon management", () => {
    expect(() => assertConnectDaemonPlatform("linux")).not.toThrow();
  });

  it("rejects daemon management on other platforms", () => {
    expect(() => assertConnectDaemonPlatform("darwin")).toThrow(
      "Vibedeckx connect daemon mode is only supported on Linux",
    );
  });
});

describe("detached daemon startup", () => {
  const target = "https://connect.example.com";
  const secret = "super-secret-token";

  function fixtureOptions(
    mode: string,
    overrides: Partial<Parameters<typeof startConnectDaemon>[0]> = {},
  ): Parameters<typeof startConnectDaemon>[0] {
    return {
      dataDir,
      connectTo: target,
      token: secret,
      argv: ["connect", "--connect-to", target, "--token", secret, "--daemon"],
      entrypoint: fixtureEntrypoint,
      timeoutMs: 1_000,
      extraEnv: { VIBEDECKX_TEST_DAEMON_MODE: mode },
      ...overrides,
    };
  }

  function trackFixture(pid: number): void {
    const startTicks = readLinuxProcessStartTicks(pid);
    expect(startTicks).toMatch(/^\d+$/);
    liveFixtureProcesses.set(pid, startTicks!);
  }

  function expectAllRecordedFixturesStopped(): void {
    for (const [pid, startTicks] of liveFixtureProcesses) {
      expect(readLinuxProcessStartTicks(pid)).not.toBe(startTicks);
    }
  }

  async function runFixture(
    mode: string,
    overrides: Partial<Parameters<typeof startConnectDaemon>[0]> = {},
  ): Promise<Awaited<ReturnType<typeof startConnectDaemon>>> {
    const options = fixtureOptions(mode, overrides);
    const pidRecordPath = path.join(
      dataDir,
      `fixture-pid-${liveFixtureProcesses.size}.json`,
    );
    options.extraEnv = {
      ...options.extraEnv,
      VIBEDECKX_TEST_DAEMON_PID_RECORD: pidRecordPath,
    };

    try {
      return await startConnectDaemon(options);
    } finally {
      if (fs.existsSync(pidRecordPath)) {
        const record = JSON.parse(fs.readFileSync(pidRecordPath, "utf8")) as {
          pid: number;
          processStartTicks: string;
        };
        liveFixtureProcesses.set(record.pid, record.processStartTicks);
      }
    }
  }

  it("returns after readiness while the detached child remains alive", async () => {
    const result = await runFixture("ready");
    trackFixture(result.pid);

    expect(readLinuxProcessStartTicks(result.pid)).toBe(
      liveFixtureProcesses.get(result.pid),
    );
    expect(result).toEqual({
      pid: result.pid,
      target,
      logPath: path.join(dataDir, "logs", "vibedeckx.log"),
    });
  });

  it("reports a structured child startup error", async () => {
    await expect(runFixture("error")).rejects.toThrow(
      "fixture failed",
    );
    expectAllRecordedFixturesStopped();
  });

  it("redacts both raw and URL-encoded token forms from startup errors", async () => {
    const reservedToken = "secret/with?reserved=value&percent%";
    const encodedToken = encodeURIComponent(reservedToken);

    let rejected: unknown;
    try {
      await runFixture("error", {
        token: reservedToken,
        extraEnv: {
          VIBEDECKX_TEST_DAEMON_MODE: "error",
          VIBEDECKX_TEST_DAEMON_ERROR_MESSAGE:
            `failed URL token=${encodedToken}; raw=${reservedToken}`,
        },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(Error);
    const message = rejected instanceof Error ? rejected.message : "";
    expect(message).not.toContain(reservedToken);
    expect(message).not.toContain(encodedToken);
    expect(message).toContain("[redacted]");
    expectAllRecordedFixturesStopped();
  });

  it("removes stale daemon state claimed by a child that fails startup", async () => {
    await expect(
      runFixture("error-with-state", {
        extraEnv: {
          VIBEDECKX_TEST_DAEMON_MODE: "error-with-state",
          VIBEDECKX_TEST_DAEMON_STATE_DATA_DIR: dataDir,
        },
      }),
    ).rejects.toThrow("fixture failed");

    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(false);
    expectAllRecordedFixturesStopped();
  });

  it("reports state cleanup failure without replacing the startup error or leaking the token", async () => {
    const secretDataDir = path.join(dataDir, secret);
    let rejected: unknown;

    try {
      await runFixture("error-with-state-lock", {
        dataDir: secretDataDir,
        extraEnv: {
          VIBEDECKX_TEST_DAEMON_MODE: "error-with-state-lock",
          VIBEDECKX_TEST_DAEMON_STATE_DATA_DIR: secretDataDir,
        },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(Error);
    const message = rejected instanceof Error ? rejected.message : "";
    expect(message).toContain("fixture failed");
    expect(message).toMatch(/daemon state cleanup/i);
    expect(message).toMatch(/operation already in progress/i);
    expect(message).not.toContain(secret);
    expect(message).toContain("[redacted]");
    expect(fs.existsSync(daemonStatePath(secretDataDir))).toBe(true);
    expectAllRecordedFixturesStopped();
  });

  it("reports unreadable daemon state instead of silently preserving uncertainty", async () => {
    let rejected: unknown;

    try {
      await runFixture("error-with-unreadable-state", {
        extraEnv: {
          VIBEDECKX_TEST_DAEMON_MODE: "error-with-unreadable-state",
          VIBEDECKX_TEST_DAEMON_STATE_DATA_DIR: dataDir,
        },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(Error);
    const message = rejected instanceof Error ? rejected.message : "";
    expect(message).toContain("fixture failed");
    expect(message).toMatch(/daemon state cleanup/i);
    expect(message).toMatch(/EACCES|permission denied/i);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
    expectAllRecordedFixturesStopped();
  });

  it("preserves and reports daemon state owned by a different live process", async () => {
    await expect(
      runFixture("error-with-foreign-state", {
        extraEnv: {
          VIBEDECKX_TEST_DAEMON_MODE: "error-with-foreign-state",
          VIBEDECKX_TEST_DAEMON_STATE_DATA_DIR: dataDir,
        },
      }),
    ).rejects.toThrow(/already running.*PID/i);

    const preserved = JSON.parse(
      fs.readFileSync(daemonStatePath(dataDir), "utf8"),
    ) as ConnectDaemonState;
    expect(preserved.pid).toBe(process.pid);
    expect(preserved.processStartTicks).toBe(
      readLinuxProcessStartTicks(process.pid),
    );
    expectAllRecordedFixturesStopped();
  });

  it("reports an early child exit code", async () => {
    await expect(runFixture("exit")).rejects.toThrow(
      /exit.*2|code 2/i,
    );
    expectAllRecordedFixturesStopped();
  });

  it("times out and terminates a child that never reports readiness", async () => {
    const startedAt = Date.now();

    await expect(
      runFixture("hang", { timeoutMs: 30 }),
    ).rejects.toThrow(/timed out|timeout/i);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expectAllRecordedFixturesStopped();
  });

  it("rejects an invalid IPC readiness message", async () => {
    await expect(
      runFixture("invalid"),
    ).rejects.toThrow(/invalid.*IPC|IPC.*message/i);
    expectAllRecordedFixturesStopped();
  });

  it("rejects and terminates a child that disconnects without a message", async () => {
    await expect(runFixture("disconnect")).rejects.toThrow(
      /disconnected.*readiness/i,
    );
    expectAllRecordedFixturesStopped();
  });

  it("rejects a running daemon before spawning another child", async () => {
    const state = validState();
    const recordPath = path.join(dataDir, "child-record.json");
    writeState(state);

    await expect(
      runFixture(
        "ready",
        {
          extraEnv: {
            VIBEDECKX_TEST_DAEMON_MODE: "ready",
            VIBEDECKX_TEST_DAEMON_RECORD: recordPath,
          },
        },
      ),
    ).rejects.toThrow(
      new RegExp(`running.*${state.pid}|${state.pid}.*running`, "i"),
    );
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it("rejects invalid daemon state before spawning another child", async () => {
    const recordPath = path.join(dataDir, "child-record.json");
    writeState("{");

    await expect(
      runFixture(
        "ready",
        {
          extraEnv: {
            VIBEDECKX_TEST_DAEMON_MODE: "ready",
            VIBEDECKX_TEST_DAEMON_RECORD: recordPath,
          },
        },
      ),
    ).rejects.toThrow(new RegExp(daemonStatePath(dataDir)));
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it("removes verified stale state before starting the child", async () => {
    writeState(
      validState({ pid: Number.MAX_SAFE_INTEGER, processStartTicks: "1" }),
    );

    const result = await runFixture("ready");
    trackFixture(result.pid);

    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(false);
  });

  it("passes a sanitized argv and the token only through the internal environment", async () => {
    const recordPath = path.join(dataDir, "child-record.json");
    const result = await runFixture(
      "ready",
      {
        argv: [
          "connect",
          "--token=super-secret-token",
          "--daemon",
          "--connect-to",
          target,
          "--data-dir=/tmp/kept-byte-for-byte",
        ],
        extraEnv: {
          VIBEDECKX_TEST_DAEMON_MODE: "ready",
          VIBEDECKX_TEST_DAEMON_RECORD: recordPath,
        },
      },
    );
    trackFixture(result.pid);

    expect(JSON.parse(fs.readFileSync(recordPath, "utf8"))).toEqual({
      argv: [
        "connect",
        "--connect-to",
        target,
        "--data-dir=/tmp/kept-byte-for-byte",
      ],
      internalToken: secret,
      childMarker: "1",
    });
    expect(fs.readFileSync(recordPath, "utf8")).not.toContain(
      "VIBEDECKX_TEST_DAEMON",
    );
  });

  it("rejects daemon startup outside Linux without spawning", async () => {
    const recordPath = path.join(dataDir, "child-record.json");

    await expect(
      runFixture(
        "ready",
        {
          platform: "darwin",
          extraEnv: {
            VIBEDECKX_TEST_DAEMON_MODE: "ready",
            VIBEDECKX_TEST_DAEMON_RECORD: recordPath,
          },
        },
      ),
    ).rejects.toThrow(/Linux/i);
    expect(fs.existsSync(recordPath)).toBe(false);
  });
});

describe("daemon parent notifications", () => {
  it("flushes readiness before disconnecting IPC", () => {
    let sentCallback: ((error: Error | null) => void) | undefined;
    const parent = {
      pid: 4242,
      connected: true,
      send: vi.fn(
        (_message: unknown, callback: (error: Error | null) => void) => {
          sentCallback = callback;
          return true;
        },
      ),
      disconnect: vi.fn(),
    };

    notifyDaemonParentReady(parent);

    expect(parent.send).toHaveBeenCalledWith(
      { type: "ready", pid: 4242 },
      expect.any(Function),
    );
    expect(parent.disconnect).not.toHaveBeenCalled();
    sentCallback?.(null);
    expect(parent.disconnect).toHaveBeenCalledOnce();
  });

  it("flushes a credential-free error message before disconnecting IPC", () => {
    let sentCallback: ((error: Error | null) => void) | undefined;
    const parent = {
      pid: 4242,
      connected: true,
      send: vi.fn(
        (_message: unknown, callback: (error: Error | null) => void) => {
          sentCallback = callback;
          return true;
        },
      ),
      disconnect: vi.fn(),
    };

    notifyDaemonParentError(
      new Error("startup failed with super-secret-token"),
      parent,
    );

    expect(parent.send).toHaveBeenCalledWith(
      {
        type: "error",
        message: expect.not.stringContaining("super-secret-token"),
      },
      expect.any(Function),
    );
    expect(parent.disconnect).not.toHaveBeenCalled();
    sentCallback?.(null);
    expect(parent.disconnect).toHaveBeenCalledOnce();
  });

  it("is a safe no-op without an IPC channel", () => {
    const foregroundProcess = { pid: 4242, connected: false };

    expect(() => notifyDaemonParentReady(foregroundProcess)).not.toThrow();
    expect(() =>
      notifyDaemonParentError(new Error("ignored"), foregroundProcess),
    ).not.toThrow();
  });
});

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

describe("daemon status", () => {
  it("formats a running daemon with its identity, target, and log path", async () => {
    const state = validState({
      version: "0.5.4",
      startedAt: "2026-07-13T10:00:00.000Z",
      connectTo: "https://connect.example.com",
    });
    writeState(state);

    const result = await describeConnectDaemon(dataDir, async () => "0.5.4");

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`Running (PID ${state.pid}`);
    expect(result.message).toContain(state.startedAt);
    expect(result.message).toContain(`Version: ${state.version} (up to date)`);
    expect(result.message).toContain(`Target: ${state.connectTo}`);
    expect(result.message).toContain(
      `Logs: ${path.join(dataDir, "logs", "vibedeckx.log")}`,
    );
  });

  it("reports an available update from the npm registry", async () => {
    writeState(validState({ version: "0.5.2" }));

    const result = await describeConnectDaemon(dataDir, async () => "0.5.4");

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(
      "Version: 0.5.2 (update available: 0.5.4)",
    );
  });

  it("reports a failed update check when the registry is unreachable", async () => {
    writeState(validState({ version: "0.5.2" }));

    const result = await describeConnectDaemon(dataDir, async () => undefined);

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Version: 0.5.2 (update check failed)");
  });

  it("reports a failed update check for an incomparable daemon version", async () => {
    writeState(validState({ version: "unknown" }));

    const result = await describeConnectDaemon(dataDir, async () => "0.5.4");

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Version: unknown (update check failed)");
  });

  it("returns non-zero without an update check when the daemon is not running", async () => {
    const fetchLatestVersion = vi.fn(async () => "0.5.4");

    await expect(
      describeConnectDaemon(dataDir, fetchLatestVersion),
    ).resolves.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/not running/i),
    });
    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });

  it("reports stale state without deleting it or checking for updates", async () => {
    writeState(validState({ processStartTicks: "0" }));
    const fetchLatestVersion = vi.fn(async () => "0.5.4");

    await expect(
      describeConnectDaemon(dataDir, fetchLatestVersion),
    ).resolves.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/stale.*PID/i),
    });
    expect(fetchLatestVersion).not.toHaveBeenCalled();
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });

  it("reports invalid state with its path without deleting it", async () => {
    writeState("{");
    const statePath = daemonStatePath(dataDir);

    const result = await describeConnectDaemon(dataDir);

    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/invalid|cannot read/i);
    expect(result.message).toContain(statePath);
    expect(fs.existsSync(statePath)).toBe(true);
  });
});

describe("daemon stop", () => {
  const fastTimings = {
    pollIntervalMs: 1,
    firstTimeoutMs: 2,
    forceTimeoutMs: 1,
  };

  it("is idempotently successful when the daemon is not running", async () => {
    await expect(stopConnectDaemon(dataDir)).resolves.toEqual({
      exitCode: 0,
      message: "Vibedeckx connect is not running",
    });
  });

  it("does not signal or delete stale state", async () => {
    writeState(validState({ processStartTicks: "0" }));
    const sendSignal = vi.fn();

    const result = await stopConnectDaemon(dataDir, {
      sendSignal,
      ...fastTimings,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/stale.*PID/i);
    expect(sendSignal).not.toHaveBeenCalled();
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });

  it("does not signal or delete invalid state", async () => {
    writeState("{");
    const statePath = daemonStatePath(dataDir);
    const sendSignal = vi.fn();

    const result = await stopConnectDaemon(dataDir, {
      sendSignal,
      ...fastTimings,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain(statePath);
    expect(sendSignal).not.toHaveBeenCalled();
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("refuses to signal when the immediate identity recheck does not match", async () => {
    const state = validState();
    writeState(state);
    const sendSignal = vi.fn();

    const result = await stopConnectDaemon(dataDir, {
      readStartTicks: () => "different",
      sendSignal,
      sleep: async () => {},
      ...fastTimings,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/identity|PID/i);
    expect(sendSignal).not.toHaveBeenCalled();
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });

  it("sends SIGTERM only to the validated process and cleans its state", async () => {
    const state = validState();
    writeState(state);
    let alive = true;
    const signals: Array<[number, NodeJS.Signals]> = [];

    const result = await stopConnectDaemon(dataDir, {
      readStartTicks: () =>
        alive ? state.processStartTicks : undefined,
      sendSignal: (pid, signal) => {
        signals.push([pid, signal]);
        alive = false;
      },
      sleep: async () => {},
      ...fastTimings,
    });

    expect(signals).toEqual([[state.pid, "SIGTERM"]]);
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/stopped/i);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(false);
  });

  it("polls until the gracefully stopping process exits", async () => {
    const state = validState();
    writeState(state);
    const reads = [
      state.processStartTicks,
      state.processStartTicks,
      undefined,
    ];
    const sleep = vi.fn(async () => {});
    const sendSignal = vi.fn();

    const result = await stopConnectDaemon(dataDir, {
      readStartTicks: () => reads.shift(),
      sendSignal,
      sleep,
      pollIntervalMs: 1,
      firstTimeoutMs: 3,
      forceTimeoutMs: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(sendSignal).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("revalidates identity immediately before both SIGTERM signals", async () => {
    const state = validState();
    writeState(state);
    let alive = true;
    const events: string[] = [];

    const result = await stopConnectDaemon(dataDir, {
      readStartTicks: () => {
        events.push("read");
        return alive ? state.processStartTicks : undefined;
      },
      sendSignal: (_pid, signal) => {
        events.push(`signal:${signal}`);
        if (events.filter((event) => event.startsWith("signal:")).length === 2) {
          alive = false;
        }
      },
      sleep: async () => {},
      ...fastTimings,
    });

    expect(result.exitCode).toBe(0);
    const signalIndexes = events.flatMap((event, index) =>
      event.startsWith("signal:") ? [index] : [],
    );
    expect(signalIndexes).toHaveLength(2);
    for (const index of signalIndexes) {
      expect(events[index - 1]).toBe("read");
    }
  });

  it("does not send the second SIGTERM if the identity changes before it", async () => {
    const state = validState();
    writeState(state);
    const reads = [
      state.processStartTicks,
      state.processStartTicks,
      state.processStartTicks,
      "replacement-process",
    ];
    const sendSignal = vi.fn();

    const result = await stopConnectDaemon(dataDir, {
      readStartTicks: () => reads.shift(),
      sendSignal,
      sleep: async () => {},
      ...fastTimings,
    });

    expect(result.exitCode).toBe(0);
    expect(sendSignal).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(false);
  });

  it("returns a timeout without deleting state when both stop phases expire", async () => {
    const state = validState();
    writeState(state);
    const sendSignal = vi.fn();

    const result = await stopConnectDaemon(dataDir, {
      readStartTicks: () => state.processStartTicks,
      sendSignal,
      sleep: async () => {},
      ...fastTimings,
    });

    expect(sendSignal).toHaveBeenCalledTimes(2);
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/timed out|still running/i);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });

  it("treats an ESRCH signal race as an already exited process", async () => {
    const state = validState();
    writeState(state);

    const result = await stopConnectDaemon(dataDir, {
      readStartTicks: () => state.processStartTicks,
      sendSignal: () => {
        throw Object.assign(new Error("process disappeared"), { code: "ESRCH" });
      },
      sleep: async () => {},
      ...fastTimings,
    });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(false);
  });

  it.each(["EPERM", "EIO"])(
    "does not report success for a %s signal error",
    async (code) => {
      const state = validState();
      writeState(state);

      const result = await stopConnectDaemon(dataDir, {
        readStartTicks: () => state.processStartTicks,
        sendSignal: () => {
          throw Object.assign(new Error(`signal failed: ${code}`), { code });
        },
        sleep: async () => {},
        ...fastTimings,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.message).toContain(`signal failed: ${code}`);
      expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
    },
  );
});

describe("daemon state ownership", () => {
  it.each([
    [
      "claim",
      (state: ConnectDaemonState) =>
        claimDaemonState(dataDir, "https://new.example.com", state.version),
    ],
    [
      "owned removal",
      (state: ConnectDaemonState) =>
        removeDaemonStateIfOwned(dataDir, state),
    ],
    [
      "verified stale cleanup",
      () => removeVerifiedStaleState(dataDir),
    ],
  ])("rejects %s while the shared state lock is held", (_, operation) => {
    const state = validState({
      pid: Number.MAX_SAFE_INTEGER,
      processStartTicks: "1",
    });
    writeState(state);
    const before = fs.readFileSync(daemonStatePath(dataDir), "utf8");
    writeLockOwner();

    expectStateOperationLocked(() => operation(state));
    expect(fs.readFileSync(daemonStatePath(dataDir), "utf8")).toBe(before);
    expect(fs.existsSync(lockPath())).toBe(true);
  });

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

  it("recovers a lock whose recorded process identity is dead and does not leak the quarantine", () => {
    writeLockOwner({
      pid: Number.MAX_SAFE_INTEGER,
      processStartTicks: "1",
      nonce: "dead-owner",
    });

    const state = claimDaemonState(dataDir, "https://example.com", "test");

    expect(state.pid).toBe(process.pid);
    expect(fs.existsSync(lockPath())).toBe(false);
    // The recovered dead-owner lock is quarantined and then swept while the
    // lock is held, so it must not accumulate across crash/recovery cycles.
    const quarantines = fs.readdirSync(path.dirname(lockPath())).filter(
      (entry) => entry.startsWith("connect.lock.stale-"),
    );
    expect(quarantines).toHaveLength(0);
  });

  it("sweeps stale quarantines and dead-PID candidates but keeps live-PID candidates", () => {
    const runDir = path.dirname(lockPath());
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const stale = `${lockPath()}.stale-1-2-3`;
    const deadCandidate = `${lockPath()}.candidate-${Number.MAX_SAFE_INTEGER}-dead`;
    const liveCandidate = `${lockPath()}.candidate-${process.pid}-live`;
    fs.mkdirSync(stale, { mode: 0o700 });
    fs.mkdirSync(deadCandidate, { mode: 0o700 });
    fs.mkdirSync(liveCandidate, { mode: 0o700 });

    // Acquiring the lock runs the quarantine sweep while the lock is held.
    claimDaemonState(dataDir, "https://example.com", "test");

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(deadCandidate)).toBe(false);
    expect(fs.existsSync(liveCandidate)).toBe(true);
  });

  it.each([
    ["interrupted empty directory", undefined],
    ["malformed metadata", "{"],
  ])("recovers a %s lock publication", (_description, contents) => {
    fs.mkdirSync(lockPath(), { recursive: true, mode: 0o700 });
    if (contents !== undefined) {
      fs.writeFileSync(path.join(lockPath(), "owner.json"), contents, {
        mode: 0o600,
      });
    }

    expect(() =>
      claimDaemonState(dataDir, "https://example.com", "test"),
    ).not.toThrow();
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("recovers a malformed lock published as a regular file", () => {
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath(), "interrupted publication", { mode: 0o600 });

    expect(() =>
      claimDaemonState(dataDir, "https://example.com", "test"),
    ).not.toThrow();
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("keeps concurrent contenders out while a live owner mutates state", () => {
    const statePath = daemonStatePath(dataDir);
    const writeFileSync = fs.writeFileSync.bind(fs);
    let competingError: unknown;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, contents, options) => {
      if (file === statePath && competingError === undefined) {
        try {
          claimDaemonState(dataDir, "https://competitor.example.com", "test");
        } catch (error) {
          competingError = error;
        }
      }
      return writeFileSync(file, contents, options);
    });

    claimDaemonState(dataDir, "https://winner.example.com", "test");

    expectLockedError(competingError);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).connectTo).toBe(
      "https://winner.example.com",
    );
  });

  it("publishes private owner metadata while holding the lock", () => {
    const statePath = daemonStatePath(dataDir);
    const writeFileSync = fs.writeFileSync.bind(fs);
    let observedDirectoryMode: number | undefined;
    let observedOwnerMode: number | undefined;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, contents, options) => {
      if (file === statePath) {
        observedDirectoryMode = fs.statSync(lockPath()).mode & 0o777;
        observedOwnerMode =
          fs.statSync(path.join(lockPath(), "owner.json")).mode & 0o777;
      }
      return writeFileSync(file, contents, options);
    });

    claimDaemonState(dataDir, "https://example.com", "test");

    expect(observedDirectoryMode).toBe(0o700);
    expect(observedOwnerMode).toBe(0o600);
  });

  it("does not release a lock replaced by a different owner", () => {
    const statePath = daemonStatePath(dataDir);
    const writeFileSync = fs.writeFileSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, contents, options) => {
      const result = writeFileSync(file, contents, options);
      if (file === statePath && !replaced) {
        replaced = true;
        fs.rmSync(lockPath(), { recursive: true });
        writeLockOwner({ nonce: "replacement-owner" });
      }
      return result;
    });

    expect(() =>
      claimDaemonState(dataDir, "https://example.com", "test"),
    ).toThrow(/ownership|owner/i);
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(fs.readFileSync(path.join(lockPath(), "owner.json"), "utf8")).toContain(
      "replacement-owner",
    );
  });

  it("preserves an existing lock when owner metadata cannot be read", () => {
    writeLockOwner();
    const ownerPath = path.join(lockPath(), "owner.json");
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === ownerPath) {
        throw Object.assign(new Error("lock owner permission denied"), {
          code: "EACCES",
        });
      }
      return readFileSync(file, options as never);
    });

    expect(() =>
      claimDaemonState(dataDir, "https://example.com", "test"),
    ).toThrow(/permission denied/i);
    expect(fs.existsSync(lockPath())).toBe(true);
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

  it("releases the shared lock after a successful mutation", () => {
    const state = claimDaemonState(dataDir, "https://example.com", "test");
    expect(fs.existsSync(lockPath())).toBe(false);

    expect(removeDaemonStateIfOwned(dataDir, state)).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("releases the shared lock when claiming state fails", () => {
    claimDaemonState(dataDir, "https://example.com", "test");

    expect(() =>
      claimDaemonState(dataDir, "https://other.example.com", "test"),
    ).toThrow(/EEXIST|already exists/i);
    expect(fs.existsSync(lockPath())).toBe(false);
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

  it.each(["EACCES", "EIO"])(
    "propagates %s state read errors and releases the lock",
    (code) => {
      const state = validState();
      writeState(state);
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw Object.assign(new Error(`state read failed: ${code}`), { code });
      });

      expect(() => removeDaemonStateIfOwned(dataDir, state)).toThrow(
        `state read failed: ${code}`,
      );
      expect(fs.existsSync(lockPath())).toBe(false);

      readSpy.mockRestore();
    },
  );
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

  it("releases the shared lock when verified cleanup fails", () => {
    writeState("{");

    expect(() => removeVerifiedStaleState(dataDir)).toThrow(
      /cannot safely remove/i,
    );
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("holds the shared lock through stale state deletion", () => {
    const staleState = validState({
      pid: Number.MAX_SAFE_INTEGER,
      processStartTicks: "1",
    });
    writeState(staleState);
    const statePath = daemonStatePath(dataDir);
    const unlinkSync = fs.unlinkSync.bind(fs);
    let firstStateUnlink = true;
    let competingRemoveError: unknown;
    let competingClaimError: unknown;
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (target === statePath && firstStateUnlink) {
        firstStateUnlink = false;
        try {
          removeDaemonStateIfOwned(dataDir, staleState);
        } catch (error) {
          competingRemoveError = error;
        }
        try {
          claimDaemonState(dataDir, "https://new.example.com", "next");
        } catch (error) {
          competingClaimError = error;
        }
      }
      unlinkSync(target);
    });

    expect(removeVerifiedStaleState(dataDir)).toBe(true);
    expectLockedError(competingRemoveError);
    expectLockedError(competingClaimError);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
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
