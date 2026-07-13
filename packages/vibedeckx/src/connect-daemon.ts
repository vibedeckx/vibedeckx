import fs from "node:fs";
import path from "node:path";

export interface ConnectDaemonState {
  schemaVersion: 1;
  pid: number;
  processStartTicks: string;
  startedAt: string;
  connectTo: string;
  version: string;
}

export type ConnectDaemonInspection =
  | { kind: "missing" }
  | { kind: "running"; state: ConnectDaemonState }
  | { kind: "stale"; state: ConnectDaemonState }
  | { kind: "invalid"; path: string; reason: string };

export interface DaemonCommandResult {
  exitCode: number;
  message: string;
}

export interface StopDaemonRuntime {
  readStartTicks: (pid: number) => string | undefined;
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

export type StopDaemonOptions = Partial<StopDaemonRuntime> & {
  pollIntervalMs?: number;
  firstTimeoutMs?: number;
  forceTimeoutMs?: number;
};

export function parseLinuxProcessStartTicks(stat: string): string {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) throw new Error("Malformed Linux process stat");

  const fieldsFromThree = stat.slice(closeParen + 1).trim().split(/\s+/);
  const startTicks = fieldsFromThree[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error("Malformed Linux process stat");
  }
  return startTicks;
}

export function readLinuxProcessStartTicks(pid: number): string | undefined {
  try {
    return parseLinuxProcessStartTicks(
      fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return undefined;
    }
    throw error;
  }
}

export function daemonStatePath(dataDir: string): string {
  return path.join(dataDir, "run", "connect.json");
}

function daemonStateLockPath(dataDir: string): string {
  return path.join(path.dirname(daemonStatePath(dataDir)), "connect.lock");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function withDaemonStateLock<T>(
  dataDir: string,
  operation: () => T,
): T {
  const lockPath = daemonStateLockPath(dataDir);
  const runDir = path.dirname(lockPath);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runDir, 0o700);

  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(
        `daemon state operation already in progress at ${lockPath}`,
      );
    }
    throw error;
  }

  try {
    fs.chmodSync(lockPath, 0o700);
    return operation();
  } finally {
    fs.rmdirSync(lockPath);
  }
}

function isConnectDaemonState(value: unknown): value is ConnectDaemonState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    state.schemaVersion === 1 &&
    Number.isSafeInteger(state.pid) &&
    (state.pid as number) > 0 &&
    typeof state.processStartTicks === "string" &&
    /^\d+$/.test(state.processStartTicks) &&
    typeof state.startedAt === "string" &&
    state.startedAt.length > 0 &&
    !Number.isNaN(Date.parse(state.startedAt)) &&
    typeof state.connectTo === "string" &&
    state.connectTo.length > 0 &&
    typeof state.version === "string" &&
    state.version.length > 0
  );
}

/**
 * Reads an identity snapshot of the recorded daemon process.
 *
 * This result must not be used alone to authorize sending a signal. Callers
 * must re-read the process start ticks immediately before signaling the PID.
 */
export function inspectDaemonState(dataDir: string): ConnectDaemonInspection {
  const statePath = daemonStatePath(dataDir);

  let contents: string;
  try {
    contents = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { kind: "missing" };
    }
    return {
      kind: "invalid",
      path: statePath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return {
      kind: "invalid",
      path: statePath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isConnectDaemonState(parsed)) {
    return {
      kind: "invalid",
      path: statePath,
      reason: "Unsupported or malformed daemon state",
    };
  }

  const actualTicks = readLinuxProcessStartTicks(parsed.pid);
  return actualTicks === parsed.processStartTicks
    ? { kind: "running", state: parsed }
    : { kind: "stale", state: parsed };
}

export function describeConnectDaemon(dataDir: string): DaemonCommandResult {
  const inspection = inspectDaemonState(dataDir);

  switch (inspection.kind) {
    case "running":
      return {
        exitCode: 0,
        message: [
          `Running (PID ${inspection.state.pid}, since ${inspection.state.startedAt})`,
          `Target: ${inspection.state.connectTo}`,
          `Logs: ${path.join(dataDir, "logs", "vibedeckx.log")}`,
        ].join("\n"),
      };
    case "missing":
      return { exitCode: 1, message: "Vibedeckx connect is not running" };
    case "stale":
      return {
        exitCode: 1,
        message: `Vibedeckx connect has stale daemon state for PID ${inspection.state.pid}`,
      };
    case "invalid":
      return {
        exitCode: 1,
        message: `Invalid daemon state at ${inspection.path}: ${inspection.reason}`,
      };
  }
}

const defaultStopDaemonRuntime: StopDaemonRuntime = {
  readStartTicks: readLinuxProcessStartTicks,
  sendSignal: (pid, signal) => {
    process.kill(pid, signal);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type SignalAttempt =
  | { kind: "sent" }
  | { kind: "identity-changed" }
  | { kind: "already-exited" }
  | { kind: "error"; error: unknown };

function signalDaemon(
  state: ConnectDaemonState,
  runtime: StopDaemonRuntime,
): SignalAttempt {
  /*
   * A PID can be reused after inspectDaemonState() returns. Re-read Linux's
   * process start ticks immediately before every signal so an old snapshot is
   * never our authorization to signal. There is still an unavoidable, tiny
   * snapshot window between this /proc read and process.kill(); ESRCH handles
   * the common exit race, while the start-ticks check minimizes reuse risk.
   */
  if (runtime.readStartTicks(state.pid) !== state.processStartTicks) {
    return { kind: "identity-changed" };
  }

  try {
    runtime.sendSignal(state.pid, "SIGTERM");
    return { kind: "sent" };
  } catch (error) {
    return hasErrorCode(error, "ESRCH")
      ? { kind: "already-exited" }
      : { kind: "error", error };
  }
}

async function waitForDaemonExit(
  state: ConnectDaemonState,
  runtime: StopDaemonRuntime,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  let elapsedMs = 0;
  while (elapsedMs < timeoutMs) {
    const delayMs = Math.min(pollIntervalMs, timeoutMs - elapsedMs);
    await runtime.sleep(delayMs);
    elapsedMs += delayMs;
    if (runtime.readStartTicks(state.pid) !== state.processStartTicks) {
      return true;
    }
  }
  return false;
}

function signalErrorResult(
  state: ConnectDaemonState,
  error: unknown,
): DaemonCommandResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    exitCode: 1,
    message: `Failed to signal Vibedeckx connect PID ${state.pid}: ${reason}`,
  };
}

function finishStopped(
  dataDir: string,
  state: ConnectDaemonState,
): DaemonCommandResult {
  try {
    removeDaemonStateIfOwned(dataDir, state);
    return {
      exitCode: 0,
      message: `Vibedeckx connect stopped (PID ${state.pid})`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      message: `Vibedeckx connect stopped, but its daemon state could not be cleaned up: ${reason}`,
    };
  }
}

export async function stopConnectDaemon(
  dataDir: string,
  options: StopDaemonOptions = {},
): Promise<DaemonCommandResult> {
  const inspection = inspectDaemonState(dataDir);
  switch (inspection.kind) {
    case "missing":
      return { exitCode: 0, message: "Vibedeckx connect is not running" };
    case "stale":
      return {
        exitCode: 1,
        message: `Vibedeckx connect has stale daemon state for PID ${inspection.state.pid}; no signal was sent`,
      };
    case "invalid":
      return {
        exitCode: 1,
        message: `Invalid daemon state at ${inspection.path}: ${inspection.reason}; no signal was sent`,
      };
    case "running":
      break;
  }

  const state = inspection.state;
  const runtime: StopDaemonRuntime = {
    readStartTicks:
      options.readStartTicks ?? defaultStopDaemonRuntime.readStartTicks,
    sendSignal: options.sendSignal ?? defaultStopDaemonRuntime.sendSignal,
    sleep: options.sleep ?? defaultStopDaemonRuntime.sleep,
  };
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const firstTimeoutMs = options.firstTimeoutMs ?? 7_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 1_000;

  const firstSignal = signalDaemon(state, runtime);
  if (firstSignal.kind === "identity-changed") {
    return {
      exitCode: 1,
      message: `Vibedeckx connect PID ${state.pid} no longer has the recorded process identity; no signal was sent`,
    };
  }
  if (firstSignal.kind === "already-exited") {
    return finishStopped(dataDir, state);
  }
  if (firstSignal.kind === "error") {
    return signalErrorResult(state, firstSignal.error);
  }

  if (
    await waitForDaemonExit(
      state,
      runtime,
      firstTimeoutMs,
      pollIntervalMs,
    )
  ) {
    return finishStopped(dataDir, state);
  }

  const secondSignal = signalDaemon(state, runtime);
  if (
    secondSignal.kind === "identity-changed" ||
    secondSignal.kind === "already-exited"
  ) {
    return finishStopped(dataDir, state);
  }
  if (secondSignal.kind === "error") {
    return signalErrorResult(state, secondSignal.error);
  }

  if (
    await waitForDaemonExit(
      state,
      runtime,
      forceTimeoutMs,
      pollIntervalMs,
    )
  ) {
    return finishStopped(dataDir, state);
  }

  return {
    exitCode: 1,
    message: `Timed out waiting for Vibedeckx connect PID ${state.pid} to stop; it is still running`,
  };
}

export function claimDaemonState(
  dataDir: string,
  connectTo: string,
  version: string,
): ConnectDaemonState {
  return withDaemonStateLock(dataDir, () =>
    claimDaemonStateUnlocked(dataDir, connectTo, version),
  );
}

function claimDaemonStateUnlocked(
  dataDir: string,
  connectTo: string,
  version: string,
): ConnectDaemonState {
  const processStartTicks = readLinuxProcessStartTicks(process.pid);
  if (!processStartTicks) {
    throw new Error(
      `Cannot read Linux process start ticks for current PID ${process.pid}`,
    );
  }

  const state: ConnectDaemonState = {
    schemaVersion: 1,
    pid: process.pid,
    processStartTicks,
    startedAt: new Date().toISOString(),
    connectTo,
    version,
  };
  const statePath = daemonStatePath(dataDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(statePath), 0o700);
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  fs.chmodSync(statePath, 0o600);
  return state;
}

export function removeDaemonStateIfOwned(
  dataDir: string,
  expected: ConnectDaemonState,
): boolean {
  return withDaemonStateLock(dataDir, () =>
    removeDaemonStateIfOwnedUnlocked(dataDir, expected),
  );
}

function removeDaemonStateIfOwnedUnlocked(
  dataDir: string,
  expected: ConnectDaemonState,
): boolean {
  const statePath = daemonStatePath(dataDir);

  let contents: string;
  try {
    contents = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }

  let current: unknown;
  try {
    current = JSON.parse(contents);
  } catch {
    return false;
  }
  if (
    !isConnectDaemonState(current) ||
    current.pid !== expected.pid ||
    current.processStartTicks !== expected.processStartTicks
  ) {
    return false;
  }

  try {
    fs.unlinkSync(statePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

export function removeVerifiedStaleState(dataDir: string): boolean {
  return withDaemonStateLock(dataDir, () =>
    removeVerifiedStaleStateUnlocked(dataDir),
  );
}

function removeVerifiedStaleStateUnlocked(dataDir: string): boolean {
  const inspection = inspectDaemonState(dataDir);
  switch (inspection.kind) {
    case "missing":
      return false;
    case "stale":
      return removeDaemonStateIfOwnedUnlocked(dataDir, inspection.state);
    case "running":
      throw new Error(
        `Vibedeckx connect daemon is already running (PID ${inspection.state.pid})`,
      );
    case "invalid":
      throw new Error(
        `Daemon state at ${inspection.path}: cannot safely remove it automatically (${inspection.reason})`,
      );
  }
}
