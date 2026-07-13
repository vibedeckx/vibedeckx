import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSecretForms } from "./secret-redaction.js";

export const CONNECT_DAEMON_CHILD_ENV = "VIBEDECKX_INTERNAL_CONNECT_DAEMON";
export const CONNECT_DAEMON_TOKEN_ENV = "VIBEDECKX_INTERNAL_CONNECT_TOKEN";

export function buildDaemonChildArgs(argv: string[]): string[] {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--daemon" || argument.startsWith("--daemon=")) {
      continue;
    }
    if (argument === "--token") {
      if (index + 1 >= argv.length) {
        throw new Error("--token requires a value");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--token=")) continue;
    args.push(argument);
  }
  return args;
}

export function consumeDaemonChildEnvironment(env: NodeJS.ProcessEnv): {
  isDaemonChild: boolean;
  token: string | undefined;
} {
  const childMarker = env[CONNECT_DAEMON_CHILD_ENV];
  const token = env[CONNECT_DAEMON_TOKEN_ENV];
  delete env[CONNECT_DAEMON_CHILD_ENV];
  delete env[CONNECT_DAEMON_TOKEN_ENV];
  return { isDaemonChild: childMarker === "1", token };
}

export function resolveConnectToken(
  flagToken: string | undefined,
  child: { isDaemonChild: boolean; token: string | undefined },
): string {
  const token = flagToken ?? (child.isDaemonChild ? child.token : undefined);
  if (!token) {
    throw new Error("Missing required --token for vibedeckx connect");
  }
  return token;
}

export function assertConnectDaemonPlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux") {
    throw new Error("Vibedeckx connect daemon mode is only supported on Linux");
  }
}

export interface StartConnectDaemonOptions {
  dataDir: string;
  connectTo: string;
  token: string;
  argv: string[];
  entrypoint?: string;
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface StartedConnectDaemon {
  pid: number;
  target: string;
  logPath: string;
}

type DaemonParentMessage =
  | { type: "ready"; pid: number }
  | { type: "error"; message: string };

export interface DaemonParentProcess {
  pid: number;
  connected?: boolean;
  send?: (
    message: DaemonParentMessage,
    callback: (error: Error | null) => void,
  ) => boolean;
  disconnect?: () => void;
}

function notifyDaemonParent(
  message: DaemonParentMessage,
  parent: DaemonParentProcess,
): void {
  if (!parent.send || !parent.connected) return;
  parent.send(message, () => {
    if (parent.connected) parent.disconnect?.();
  });
}

export function notifyDaemonParentReady(
  parent: DaemonParentProcess = process as unknown as DaemonParentProcess,
): void {
  notifyDaemonParent({ type: "ready", pid: parent.pid }, parent);
}

export function notifyDaemonParentError(
  _error: unknown,
  parent: DaemonParentProcess = process as unknown as DaemonParentProcess,
): void {
  notifyDaemonParent(
    {
      type: "error",
      message: "Vibedeckx connect daemon failed during startup",
    },
    parent,
  );
}

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseDaemonParentMessage(
  message: unknown,
  expectedPid: number,
): DaemonParentMessage | undefined {
  if (
    isExactObject(message, ["type", "pid"]) &&
    message.type === "ready" &&
    message.pid === expectedPid
  ) {
    return { type: "ready", pid: expectedPid };
  }
  if (
    isExactObject(message, ["type", "message"]) &&
    message.type === "error" &&
    typeof message.message === "string"
  ) {
    return { type: "error", message: message.message };
  }
  return undefined;
}

function waitForDaemonReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let disconnectTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (disconnectTimer) clearTimeout(disconnectTimer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown): void => {
      if (child.pid === undefined) {
        finish(new Error("Daemon child has no PID"));
        return;
      }
      const parsed = parseDaemonParentMessage(message, child.pid);
      if (!parsed) {
        finish(new Error("Invalid daemon IPC message"));
      } else if (parsed.type === "error") {
        finish(new Error(parsed.message));
      } else {
        finish();
      }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      const outcome =
        code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      finish(new Error(`Daemon child exited before readiness (${outcome})`));
    };
    const onDisconnect = (): void => {
      // A child that exits can close IPC just before Node reports its exit
      // status. Give the exit event one turn so the more useful code wins.
      disconnectTimer = setTimeout(() => {
        if (child.exitCode !== null) {
          finish(
            new Error(
              `Daemon child exited before readiness (code ${child.exitCode})`,
            ),
          );
        } else if (child.signalCode !== null) {
          finish(
            new Error(
              `Daemon child exited before readiness (signal ${child.signalCode})`,
            ),
          );
        } else {
          finish(new Error("Daemon child disconnected before readiness"));
        }
      }, 25);
    };
    const timer = setTimeout(() => {
      finish(
        new Error(`Timed out waiting for daemon readiness after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("disconnect", onDisconnect);
  });
}

function waitForChildIdentityExit(
  child: ChildProcess,
  pid: number,
  processStartTicks: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(exited);
    };
    const checkIdentity = (): void => {
      try {
        if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          readLinuxProcessStartTicks(pid) !== processStartTicks
        ) {
          finish(true);
        }
      } catch (error) {
        finish(false, error);
      }
    };
    const onExit = (): void => finish(true);
    child.once("exit", onExit);
    pollTimer = setInterval(checkIdentity, 10);
    timeoutTimer = setTimeout(() => finish(false), timeoutMs);
    checkIdentity();
  });
}

function signalFailedChild(
  child: ChildProcess,
  pid: number,
  processStartTicks: string,
  signal: NodeJS.Signals,
): boolean {
  if (readLinuxProcessStartTicks(pid) !== processStartTicks) return false;
  try {
    const sent = child.kill(signal);
    if (!sent && readLinuxProcessStartTicks(pid) === processStartTicks) {
      throw new Error(`Failed to send ${signal} to daemon child PID ${pid}`);
    }
    return sent;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return false;
    throw error;
  }
}

async function terminateFailedChild(
  child: ChildProcess,
  capturedPid: number | undefined,
  processStartTicks: string | undefined,
): Promise<void> {
  if (child.connected) {
    try {
      child.disconnect();
    } catch (error) {
      if (!hasErrorCode(error, "ERR_IPC_DISCONNECTED")) throw error;
    }
  }
  const pid = capturedPid;
  if (child.exitCode !== null || child.signalCode !== null || !pid) {
    return;
  }
  if (!processStartTicks) {
    throw new Error(
      `Cannot safely terminate daemon child PID ${pid}: process identity is unavailable`,
    );
  }

  if (!signalFailedChild(child, pid, processStartTicks, "SIGTERM")) return;
  if (await waitForChildIdentityExit(child, pid, processStartTicks, 1_000)) {
    return;
  }

  if (!signalFailedChild(child, pid, processStartTicks, "SIGKILL")) return;
  if (
    !(await waitForChildIdentityExit(child, pid, processStartTicks, 1_000))
  ) {
    throw new Error(
      `Daemon child PID ${pid} remained alive after SIGKILL`,
    );
  }
}

function removeFailedChildStateIfOwned(
  dataDir: string,
  pid: number | undefined,
  processStartTicks: string | undefined,
): void {
  if (!pid || !processStartTicks) return;
  withDaemonStateLock(dataDir, () => {
    const inspection = inspectDaemonState(dataDir);
    if (inspection.kind === "invalid") {
      throw new Error(
        `Cannot safely inspect daemon state at ${inspection.path}: ${inspection.reason}`,
      );
    }
    if (
      inspection.kind === "stale" &&
      inspection.state.pid === pid &&
      inspection.state.processStartTicks === processStartTicks
    ) {
      removeDaemonStateIfOwnedUnlocked(dataDir, inspection.state);
    }
  });
}

async function findForeignRunningDaemon(
  dataDir: string,
  childPid: number | undefined,
  childStartTicks: string | undefined,
  timeoutMs = 250,
): Promise<ConnectDaemonState | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const inspection = inspectDaemonState(dataDir);
      if (
        inspection.kind === "running" &&
        (inspection.state.pid !== childPid ||
          inspection.state.processStartTicks !== childStartTicks)
      ) {
        return inspection.state;
      }
    } catch {
      // Startup's original error remains authoritative unless a complete,
      // currently-live foreign state can be verified during this bounded wait.
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (true);
  return undefined;
}

export async function startConnectDaemon(
  options: StartConnectDaemonOptions,
): Promise<StartedConnectDaemon> {
  assertConnectDaemonPlatform(options.platform);

  const inspection = inspectDaemonState(options.dataDir);
  if (inspection.kind === "running") {
    throw new Error(
      `Vibedeckx connect daemon is already running (PID ${inspection.state.pid})`,
    );
  }
  if (inspection.kind === "invalid") {
    throw new Error(
      `Invalid daemon state at ${inspection.path}: ${inspection.reason}`,
    );
  }
  if (inspection.kind === "stale") {
    removeVerifiedStaleState(options.dataDir);
  }

  const configuredEntrypoint = options.entrypoint ?? process.argv[1];
  if (!configuredEntrypoint) {
    throw new Error("Cannot start connect daemon: CLI entrypoint is unavailable");
  }
  const entrypoint = path.resolve(configuredEntrypoint);
  const child = spawn(
    process.execPath,
    [entrypoint, ...buildDaemonChildArgs(options.argv)],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        ...options.extraEnv,
        [CONNECT_DAEMON_CHILD_ENV]: "1",
        [CONNECT_DAEMON_TOKEN_ENV]: options.token,
      },
    },
  );
  const childPid = child.pid;
  let childStartTicks: string | undefined;

  try {
    childStartTicks = childPid
      ? readLinuxProcessStartTicks(childPid)
      : undefined;
    await waitForDaemonReady(child, options.timeoutMs ?? 15_000);
    if (!child.pid) {
      throw new Error("Daemon child reported readiness without a PID");
    }
    if (child.connected) child.disconnect();
    child.unref();
    return {
      pid: child.pid,
      target: options.connectTo,
      logPath: path.join(options.dataDir, "logs", "vibedeckx.log"),
    };
  } catch (error) {
    let terminationCleanupError: unknown;
    try {
      await terminateFailedChild(child, childPid, childStartTicks);
    } catch (terminationError) {
      terminationCleanupError = terminationError;
      child.unref();
    }
    let stateCleanupError: unknown;
    try {
      removeFailedChildStateIfOwned(
        options.dataDir,
        childPid,
        childStartTicks,
      );
    } catch (stateError) {
      stateCleanupError = stateError;
    }
    const foreignDaemon = await findForeignRunningDaemon(
      options.dataDir,
      childPid,
      childStartTicks,
    );
    if (foreignDaemon) {
      throw new Error(
        `Vibedeckx connect daemon is already running (PID ${foreignDaemon.pid})`,
      );
    }
    const startupMessage =
      error instanceof Error ? error.message : String(error);
    const cleanupMessages: string[] = [];
    if (terminationCleanupError) {
      cleanupMessages.push(
        `child termination cleanup failed: ${terminationCleanupError instanceof Error ? terminationCleanupError.message : String(terminationCleanupError)}`,
      );
    }
    if (stateCleanupError) {
      cleanupMessages.push(
        `daemon state cleanup failed: ${stateCleanupError instanceof Error ? stateCleanupError.message : String(stateCleanupError)}`,
      );
    }
    const message = [startupMessage, ...cleanupMessages].join("; ");
    throw new Error(redactSecretForms(message, options.token));
  }
}

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

interface DaemonStateLockOwner {
  schemaVersion: 1;
  pid: number;
  processStartTicks: string;
  nonce: string;
}

function isDaemonStateLockOwner(value: unknown): value is DaemonStateLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return (
    Object.keys(owner).length === 4 &&
    owner.schemaVersion === 1 &&
    Number.isSafeInteger(owner.pid) &&
    (owner.pid as number) > 0 &&
    typeof owner.processStartTicks === "string" &&
    /^\d+$/.test(owner.processStartTicks) &&
    typeof owner.nonce === "string" &&
    owner.nonce.length > 0
  );
}

function daemonStateLockOwnerPath(lockPath: string): string {
  return path.join(lockPath, "owner.json");
}

function readDaemonStateLockOwner(
  lockPath: string,
): DaemonStateLockOwner | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(daemonStateLockOwnerPath(lockPath), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(contents);
    return isDaemonStateLockOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function createDaemonStateLockCandidate(lockPath: string): {
  path: string;
  owner: DaemonStateLockOwner;
} {
  const processStartTicks = readLinuxProcessStartTicks(process.pid);
  if (!processStartTicks) {
    throw new Error(
      `Cannot read Linux process start ticks for lock owner PID ${process.pid}`,
    );
  }

  const owner: DaemonStateLockOwner = {
    schemaVersion: 1,
    pid: process.pid,
    processStartTicks,
    nonce: randomUUID(),
  };
  const candidatePath = `${lockPath}.candidate-${process.pid}-${owner.nonce}`;
  fs.mkdirSync(candidatePath, { mode: 0o700 });
  try {
    fs.chmodSync(candidatePath, 0o700);
    const ownerPath = daemonStateLockOwnerPath(candidatePath);
    fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.chmodSync(ownerPath, 0o600);
    return { path: candidatePath, owner };
  } catch (error) {
    fs.rmSync(candidatePath, { recursive: true, force: true });
    throw error;
  }
}

function quarantineRecoverableDaemonStateLock(lockPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }

  const owner = readDaemonStateLockOwner(lockPath);
  if (
    owner &&
    readLinuxProcessStartTicks(owner.pid) === owner.processStartTicks
  ) {
    throw new Error(
      `daemon state operation already in progress at ${lockPath} (PID ${owner.pid})`,
    );
  }

  // A deterministic destination tied to the observed inode is deliberately
  // retained. Concurrent stale observers therefore cannot later move a newly
  // published live lock after the first observer has recovered the old one.
  const quarantinePath = `${lockPath}.stale-${stat.dev}-${stat.ino}-${String(stat.ctimeMs).replace(".", "-")}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (
      hasErrorCode(error, "ENOENT") ||
      hasErrorCode(error, "EEXIST") ||
      hasErrorCode(error, "ENOTEMPTY")
    ) {
      return;
    }
    throw error;
  }
}

function acquireDaemonStateLock(lockPath: string): DaemonStateLockOwner {
  const candidate = createDaemonStateLockCandidate(lockPath);
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        // The candidate already contains complete private metadata. Publishing
        // by rename means contenders never observe a half-created new lock.
        fs.renameSync(candidate.path, lockPath);
        acquired = true;
        return candidate.owner;
      } catch (error) {
        if (
          !hasErrorCode(error, "EEXIST") &&
          !hasErrorCode(error, "ENOTEMPTY") &&
          !hasErrorCode(error, "ENOTDIR") &&
          !hasErrorCode(error, "EISDIR")
        ) {
          throw error;
        }
      }
      quarantineRecoverableDaemonStateLock(lockPath);
    }
    throw new Error(
      `daemon state operation already in progress at ${lockPath}`,
    );
  } finally {
    if (!acquired) {
      fs.rmSync(candidate.path, { recursive: true, force: true });
    }
  }
}

function releaseDaemonStateLock(
  lockPath: string,
  expected: DaemonStateLockOwner,
): void {
  const current = readDaemonStateLockOwner(lockPath);
  if (
    !current ||
    current.pid !== expected.pid ||
    current.processStartTicks !== expected.processStartTicks ||
    current.nonce !== expected.nonce
  ) {
    throw new Error(
      `Cannot release daemon state lock at ${lockPath}: lock ownership changed`,
    );
  }
  fs.rmSync(lockPath, { recursive: true });
}

function withDaemonStateLock<T>(
  dataDir: string,
  operation: () => T,
): T {
  const lockPath = daemonStateLockPath(dataDir);
  const runDir = path.dirname(lockPath);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runDir, 0o700);

  const owner = acquireDaemonStateLock(lockPath);

  try {
    return operation();
  } finally {
    releaseDaemonStateLock(lockPath, owner);
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
