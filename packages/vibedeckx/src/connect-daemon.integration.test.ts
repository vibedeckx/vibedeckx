import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const runIntegration =
  process.platform === "linux" &&
  process.env.VIBEDECKX_DAEMON_INTEGRATION === "1";

const cliPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const target = "http://127.0.0.1:9";
const integrationTestTimeoutMs = 45_000;

interface CliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface DaemonIdentity {
  pid: number;
  processStartTicks: string;
}

interface DaemonState extends DaemonIdentity {
  schemaVersion: 1;
  startedAt: string;
  connectTo: string;
  version: string;
}

interface ActiveCliProcess {
  child: ChildProcess;
  identity: DaemonIdentity | undefined;
}

const temporaryDirectories: string[] = [];
const daemonIdentities: DaemonIdentity[] = [];
const activeCliProcesses = new Set<ActiveCliProcess>();

function temporaryDataDir(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "vdx-daemon-integration-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function statePath(dataDir: string): string {
  return path.join(dataDir, "run", "connect.json");
}

function writeState(dataDir: string, contents: string): void {
  const file = statePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function readProcessStartTicks(pid: number): string | undefined {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
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

  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) throw new Error(`Malformed /proc/${pid}/stat`);
  return stat.slice(closeParen + 1).trim().split(/\s+/)[19];
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function registerDaemonIdentity(identity: DaemonIdentity): void {
  if (
    !daemonIdentities.some(
      (known) =>
        known.pid === identity.pid &&
        known.processStartTicks === identity.processStartTicks,
    )
  ) {
    daemonIdentities.push(identity);
  }
}

function findProcessesWithArgument(argument: string): DaemonIdentity[] {
  const matches: DaemonIdentity[] = [];
  for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const argv = fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean);
      // Match a complete argv element, not a substring. Callers wait for the
      // launcher CLI's `close` event before scanning, so a remaining exact
      // data-dir argument belongs to a detached descendant, not the launcher.
      if (!argv.includes(argument)) continue;
      const processStartTicks = readProcessStartTicks(pid);
      if (processStartTicks) matches.push({ pid, processStartTicks });
    } catch (error) {
      if (
        hasErrorCode(error, "ENOENT") ||
        hasErrorCode(error, "ESRCH") ||
        hasErrorCode(error, "EACCES") ||
        hasErrorCode(error, "EPERM")
      ) {
        continue;
      }
      throw error;
    }
  }
  return matches;
}

async function waitForNoProcessesWithArgument(
  argument: string,
  timeoutMs = 5_000,
): Promise<DaemonIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let emptyScans = 0;
  let matches: DaemonIdentity[] = [];
  while (Date.now() < deadline) {
    matches = findProcessesWithArgument(argument);
    for (const identity of matches) registerDaemonIdentity(identity);
    if (matches.length === 0) {
      emptyScans += 1;
      if (emptyScans === 2) return [];
    } else {
      emptyScans = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  matches = findProcessesWithArgument(argument);
  for (const identity of matches) registerDaemonIdentity(identity);
  return matches;
}

async function waitForIdentityToDisappear(
  identity: DaemonIdentity,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readProcessStartTicks(identity.pid) !== identity.processStartTicks) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return readProcessStartTicks(identity.pid) !== identity.processStartTicks;
}

async function cleanupDaemon(identity: DaemonIdentity): Promise<void> {
  const sendSignal = (signal: NodeJS.Signals): boolean => {
    if (readProcessStartTicks(identity.pid) !== identity.processStartTicks) {
      return false;
    }
    try {
      process.kill(identity.pid, signal);
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ESRCH")) return false;
      throw error;
    }
  };

  if (!sendSignal("SIGTERM")) return;
  if (await waitForIdentityToDisappear(identity, 2_000)) return;

  if (!sendSignal("SIGKILL")) return;
  if (!(await waitForIdentityToDisappear(identity, 2_000))) {
    throw new Error(`Failed to clean up daemon PID ${identity.pid}`);
  }
}

function signalActiveCliProcess(
  active: ActiveCliProcess,
  signal: NodeJS.Signals,
): void {
  const pid = active.child.pid;
  if (
    !pid ||
    active.child.exitCode !== null ||
    active.child.signalCode !== null
  ) {
    return;
  }
  if (
    active.identity &&
    readProcessStartTicks(pid) !== active.identity.processStartTicks
  ) {
    return;
  }
  try {
    active.child.kill(signal);
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) throw error;
  }
}

async function terminateActiveCliProcess(
  active: ActiveCliProcess,
): Promise<void> {
  if (!activeCliProcesses.has(active)) return;
  await new Promise<void>((resolve, reject) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => {
        active.child.off("close", onClose);
        reject(new Error(`Failed to reap CLI PID ${active.child.pid}`));
      },
      5_000,
    );
    timer.unref();
    active.child.once("close", onClose);
    signalActiveCliProcess(active, "SIGKILL");
  });
}

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  for (const active of [...activeCliProcesses]) {
    try {
      await terminateActiveCliProcess(active);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  const identities = new Map(
    daemonIdentities
      .splice(0)
      .map((identity) => [
        `${identity.pid}:${identity.processStartTicks}`,
        identity,
      ]),
  );
  for (const directory of temporaryDirectories) {
    try {
      for (const identity of findProcessesWithArgument(directory)) {
        identities.set(
          `${identity.pid}:${identity.processStartTicks}`,
          identity,
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const state = JSON.parse(
        fs.readFileSync(statePath(directory), "utf8"),
      ) as Partial<DaemonIdentity>;
      if (
        Number.isSafeInteger(state.pid) &&
        typeof state.processStartTicks === "string"
      ) {
        const identity = state as DaemonIdentity;
        identities.set(
          `${identity.pid}:${identity.processStartTicks}`,
          identity,
        );
      }
    } catch {
      // Missing and deliberately-invalid state files do not identify a process.
    }
  }

  for (const identity of identities.values()) {
    try {
      await cleanupDaemon(identity);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Daemon integration cleanup failed");
  }
});

function redactCliArgs(args: string[]): string {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--token") {
      redacted.push(argument, "[redacted]");
      index += 1;
    } else if (argument.startsWith("--token=")) {
      redacted.push("--token=[redacted]");
    } else {
      redacted.push(argument);
    }
  }
  return redacted.join(" ");
}

function runCli(args: string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STRICLI_NO_COLOR: "1",
    };
    delete env.FORCE_COLOR;
    const child = spawn(process.execPath, [cliPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const processStartTicks = child.pid
      ? readProcessStartTicks(child.pid)
      : undefined;
    const active: ActiveCliProcess = {
      child,
      identity:
        child.pid && processStartTicks
          ? { pid: child.pid, processStartTicks }
          : undefined,
    };
    activeCliProcesses.add(active);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let terminalError: Error | undefined;

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      terminalError = new Error(`CLI timed out: ${redactCliArgs(args)}`);
      signalActiveCliProcess(active, "SIGKILL");
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      terminalError = error;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      activeCliProcesses.delete(active);
      if (terminalError) {
        reject(terminalError);
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function combinedOutput(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function expectCliExit(result: CliResult, exitCode: number): void {
  expect(result.exitCode, combinedOutput(result)).toBe(exitCode);
  expect(result.signal, combinedOutput(result)).toBeNull();
}

function expectTokenAbsent(result: CliResult, token: string): void {
  expect(combinedOutput(result)).not.toContain(token);
}

async function startSentinelProcess(): Promise<DaemonIdentity> {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  if (!child.pid) throw new Error("Sentinel process has no PID");

  const deadline = Date.now() + 2_000;
  let processStartTicks: string | undefined;
  while (Date.now() < deadline && !processStartTicks) {
    processStartTicks = readProcessStartTicks(child.pid);
    if (!processStartTicks) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!processStartTicks) {
    throw new Error(`Cannot identify sentinel PID ${child.pid}`);
  }
  const identity = { pid: child.pid, processStartTicks };
  registerDaemonIdentity(identity);
  return identity;
}

async function listenOnEphemeralPort(): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

describe.runIf(runIntegration)("built connect daemon CLI", () => {
  it("keeps the legacy connect route and exposes credential-free management help", async () => {
    const connectHelp = await runCli(["connect", "--help"]);
    expect(connectHelp.exitCode).toBe(0);
    expect(connectHelp.stdout).toContain("--connect-to");
    expect(connectHelp.stdout).toContain("--token");
    expect(connectHelp.stdout).toContain("--daemon");

    for (const command of ["status", "stop"]) {
      const help = await runCli(["connect", command, "--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("--data-dir");
      expect(help.stdout).not.toContain("--connect-to");
      expect(help.stdout).not.toContain("--token");
    }
  }, integrationTestTimeoutMs);

  it("starts, reports, rejects a duplicate, and stops a detached daemon", async () => {
    const dataDir = temporaryDataDir();
    const token = `daemon-integration-secret-${randomUUID()}`;
    const start = await runCli([
      "connect",
      "--connect-to",
      target,
      "--token",
      token,
      "--daemon",
      "--data-dir",
      dataDir,
    ]);

    expectCliExit(start, 0);
    expectTokenAbsent(start, token);
    expect(start.stdout).toContain(target);
    expect(start.stdout).toContain(path.join(dataDir, "logs", "vibedeckx.log"));
    const printedPid = /PID (\d+)/.exec(start.stdout)?.[1];
    expect(printedPid).toBeDefined();

    const daemonStateFile = statePath(dataDir);
    const state = JSON.parse(
      fs.readFileSync(daemonStateFile, "utf8"),
    ) as DaemonState;
    daemonIdentities.push(state);
    expect(state.pid).toBe(Number(printedPid));
    expect(state.connectTo).toBe(target);
    expect(fs.statSync(daemonStateFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(daemonStateFile, "utf8")).not.toContain(token);

    const commandLine = fs
      .readFileSync(`/proc/${state.pid}/cmdline`, "utf8")
      .replaceAll("\0", " ");
    expect(commandLine).not.toContain(token);
    expect(commandLine).not.toContain("--daemon");
    expect(readProcessStartTicks(state.pid)).toBe(state.processStartTicks);

    const duplicate = await runCli([
      "connect",
      "--connect-to",
      target,
      "--token",
      token,
      "--daemon",
      "--data-dir",
      dataDir,
    ]);
    expectCliExit(duplicate, 1);
    expect(combinedOutput(duplicate)).toContain(`PID ${state.pid}`);
    expectTokenAbsent(duplicate, token);

    const status = await runCli([
      "connect",
      "status",
      "--data-dir",
      dataDir,
    ]);
    expectCliExit(status, 0);
    expectTokenAbsent(status, token);
    expect(status.stdout).toContain(`PID ${state.pid}`);

    const stop = await runCli([
      "connect",
      "stop",
      "--data-dir",
      dataDir,
    ]);
    expectCliExit(stop, 0);
    expectTokenAbsent(stop, token);
    expect(stop.stdout).toContain(`PID ${state.pid}`);
    expect(await waitForIdentityToDisappear(state)).toBe(true);

    const secondStop = await runCli([
      "connect",
      "stop",
      "--data-dir",
      dataDir,
    ]);
    expectCliExit(secondStop, 0);
    expectTokenAbsent(secondStop, token);
    expect(secondStop.stdout).toContain("not running");

    const logContents = fs.readFileSync(
      path.join(dataDir, "logs", "vibedeckx.log"),
      "utf8",
    );
    expect(logContents).not.toContain(token);
  }, integrationTestTimeoutMs);

  it("returns non-zero for missing, stale, and invalid status", async () => {
    const missingDir = temporaryDataDir();
    const missing = await runCli([
      "connect",
      "status",
      "--data-dir",
      missingDir,
    ]);
    expectCliExit(missing, 1);
    expect(combinedOutput(missing)).toContain("not running");

    const staleDir = temporaryDataDir();
    const sentinel = await startSentinelProcess();
    const mismatchedTicks = (
      BigInt(sentinel.processStartTicks) + 1n
    ).toString();
    writeState(
      staleDir,
      JSON.stringify({
        schemaVersion: 1,
        pid: sentinel.pid,
        processStartTicks: mismatchedTicks,
        startedAt: new Date().toISOString(),
        connectTo: target,
        version: "integration-test",
      }),
    );
    for (const command of ["status", "stop"]) {
      const result = await runCli([
        "connect",
        command,
        "--data-dir",
        staleDir,
      ]);
      expectCliExit(result, 1);
      expect(combinedOutput(result)).toContain("stale daemon state");
      expect(readProcessStartTicks(sentinel.pid)).toBe(
        sentinel.processStartTicks,
      );
    }

    const invalidDir = temporaryDataDir();
    writeState(invalidDir, "{");
    for (const command of ["status", "stop"]) {
      const result = await runCli([
        "connect",
        command,
        "--data-dir",
        invalidDir,
      ]);
      expectCliExit(result, 1);
      expect(combinedOutput(result)).toContain("Invalid daemon state");
    }
  }, integrationTestTimeoutMs);

  it("fails child startup without echoing the token", async () => {
    const dataDir = temporaryDataDir();
    const token = `daemon-integration-secret-${randomUUID()}`;
    const portOwner = await listenOnEphemeralPort();
    const address = portOwner.address();
    if (!address || typeof address === "string") {
      portOwner.close();
      throw new Error("Failed to reserve an integration-test TCP port");
    }

    try {
      const result = await runCli([
        "connect",
        "--connect-to",
        target,
        "--token",
        token,
        "--daemon",
        "--port",
        String(address.port),
        "--data-dir",
        dataDir,
      ]);
      expectCliExit(result, 1);
      expect(combinedOutput(result)).toContain(
        "connect daemon failed during startup",
      );
      expectTokenAbsent(result, token);
      expect(fs.existsSync(statePath(dataDir))).toBe(false);
      const remainingProcesses = await waitForNoProcessesWithArgument(dataDir);
      expect(
        remainingProcesses,
        `orphan processes still reference ${dataDir}`,
      ).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        portOwner.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, integrationTestTimeoutMs);

  it("redacts timeout diagnostics and reaps the timed-out CLI", async () => {
    const dataDir = temporaryDataDir();
    const token = `daemon-integration-secret-${randomUUID()}`;
    let timeoutError: unknown;
    try {
      await runCli(
        [
          "connect",
          "--connect-to",
          target,
          "--token",
          token,
          "--data-dir",
          dataDir,
        ],
        500,
      );
    } catch (error) {
      timeoutError = error;
    }

    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toContain("CLI timed out");
    expect((timeoutError as Error).message).not.toContain(token);
    expect(activeCliProcesses.size).toBe(0);
    const remainingProcesses = await waitForNoProcessesWithArgument(dataDir);
    expect(
      remainingProcesses,
      `timed-out CLI still references ${dataDir}`,
    ).toEqual([]);
  }, integrationTestTimeoutMs);
});
