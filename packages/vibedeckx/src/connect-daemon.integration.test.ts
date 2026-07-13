import { spawn } from "node:child_process";
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

const temporaryDirectories: string[] = [];
const daemonIdentities: DaemonIdentity[] = [];

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
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }

  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) throw new Error(`Malformed /proc/${pid}/stat`);
  return stat.slice(closeParen + 1).trim().split(/\s+/)[19];
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
  if (readProcessStartTicks(identity.pid) !== identity.processStartTicks) return;

  process.kill(identity.pid, "SIGTERM");
  if (await waitForIdentityToDisappear(identity, 2_000)) return;

  if (readProcessStartTicks(identity.pid) === identity.processStartTicks) {
    process.kill(identity.pid, "SIGKILL");
  }
  if (!(await waitForIdentityToDisappear(identity, 2_000))) {
    throw new Error(`Failed to clean up daemon PID ${identity.pid}`);
  }
}

afterEach(async () => {
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

  const cleanupErrors: unknown[] = [];
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

    expect(start.exitCode, combinedOutput(start)).toBe(0);
    expect(start.signal).toBeNull();
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
    expect(duplicate.exitCode).not.toBe(0);
    expect(combinedOutput(duplicate)).toContain(`PID ${state.pid}`);
    expect(combinedOutput(duplicate)).not.toContain(token);

    const status = await runCli([
      "connect",
      "status",
      "--data-dir",
      dataDir,
    ]);
    expect(status.exitCode, combinedOutput(status)).toBe(0);
    expect(status.stdout).toContain(`PID ${state.pid}`);

    const stop = await runCli([
      "connect",
      "stop",
      "--data-dir",
      dataDir,
    ]);
    expect(stop.exitCode, combinedOutput(stop)).toBe(0);
    expect(stop.stdout).toContain(`PID ${state.pid}`);
    expect(await waitForIdentityToDisappear(state)).toBe(true);

    const secondStop = await runCli([
      "connect",
      "stop",
      "--data-dir",
      dataDir,
    ]);
    expect(secondStop.exitCode, combinedOutput(secondStop)).toBe(0);
    expect(secondStop.stdout).toContain("not running");
  }, integrationTestTimeoutMs);

  it("returns non-zero for missing, stale, and invalid status", async () => {
    const missingDir = temporaryDataDir();
    const missing = await runCli([
      "connect",
      "status",
      "--data-dir",
      missingDir,
    ]);
    expect(missing.exitCode).not.toBe(0);
    expect(combinedOutput(missing)).toContain("not running");

    const staleDir = temporaryDataDir();
    writeState(
      staleDir,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        processStartTicks: "0",
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
      expect(result.exitCode).not.toBe(0);
      expect(combinedOutput(result)).toContain("stale daemon state");
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
      expect(result.exitCode).not.toBe(0);
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
      expect(result.exitCode).not.toBe(0);
      expect(combinedOutput(result)).toContain(
        "connect daemon failed during startup",
      );
      expect(combinedOutput(result)).not.toContain(token);
      expect(fs.existsSync(statePath(dataDir))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        portOwner.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, integrationTestTimeoutMs);
});
