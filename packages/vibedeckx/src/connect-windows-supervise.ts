import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { connectConfigDir, INSTALL_MODE_ENV, SUPERVISOR_ENV } from "./connect-config.js";
import { readCurrentVersion, runtimeNodePath, runtimeRoot } from "./connect-runtime.js";
import { writeFileAtomic } from "./utils/atomic-file.js";
import { killProcessTree, treeSpawnOptions } from "./utils/process-tree.js";

/**
 * `vibedeckx connect supervise`: the Windows process supervisor
 * (worker-supervision-design §4.3). Task Scheduler only launches it; it runs
 * the worker and restarts it on any exit, with backoff, forever.
 *
 * A named pipe is both the single-instance guard (it disappears with the
 * process, so it never goes stale) and the control channel. Windows has no
 * SIGTERM, so a graceful worker stop is "close the worker's stdin".
 *
 * Keep this small: while it is down, nothing restarts the worker until the
 * task's next repetition (up to a minute).
 */

export const SUPERVISOR_NAME = "task-scheduler";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A worker that stayed up this long resets the backoff. */
const STABLE_AFTER_MS = 10_000;
/** The worker's own shutdown force-exits after 5 s; allow for that and more. */
const WORKER_STOP_GRACE_MS = 20_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** Uptime-derived boot times jitter; two boots are never this close. */
const BOOT_TOLERANCE_MS = 2 * 60_000;

export function supervisePipePath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const key = createHash("sha256").update(path.resolve(dataDir).toLowerCase()).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\vibedeckx-supervise-${key}`;
  // Only the tests run the supervisor elsewhere; a unix socket stands in.
  return path.join(os.tmpdir(), `vibedeckx-supervise-${key}.sock`);
}

// ---------------------------------------------------------------------------
// Stop marker: `connect stop` holds until the next boot (§3.1)
// ---------------------------------------------------------------------------

export function stopMarkerPath(dataDir: string): string {
  return path.join(connectConfigDir(dataDir), "service-stopped.json");
}

export function currentBootTimeMs(now: number = Date.now(), uptimeSeconds: number = os.uptime()): number {
  return now - uptimeSeconds * 1000;
}

export function writeStopMarker(dataDir: string, bootTimeMs: number = currentBootTimeMs()): void {
  writeFileAtomic(stopMarkerPath(dataDir), `${JSON.stringify({ bootTimeMs })}\n`);
}

export function clearStopMarker(dataDir: string): void {
  fs.rmSync(stopMarkerPath(dataDir), { force: true });
}

/** A marker from an earlier boot is void: a reboot starts the worker again. */
export function stoppedThisBoot(dataDir: string, bootTimeMs: number = currentBootTimeMs()): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(stopMarkerPath(dataDir), "utf8")) as { bootTimeMs?: unknown };
    return typeof parsed.bootTimeMs === "number" && Math.abs(parsed.bootTimeMs - bootTimeMs) < BOOT_TOLERANCE_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Control channel (client side)
// ---------------------------------------------------------------------------

export type SuperviseCommand = "ping" | "quit";

/**
 * Send one command and return the reply line, or undefined when no
 * supervisor is listening.
 */
export function sendSuperviseCommand(
  dataDir: string,
  command: SuperviseCommand,
  timeoutMs = 30_000,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(supervisePipePath(dataDir));
    let reply = "";
    let settled = false;
    const finish = (value: string | undefined, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(undefined, new Error(`The worker supervisor did not answer \`${command}\` within ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", (chunk: string) => {
      reply += chunk;
    });
    socket.on("end", () => finish(reply.trim()));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish(undefined);
      else finish(undefined, error);
    });
  });
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

export interface WorkerCommand {
  command: string;
  args: string[];
  runtimeDir?: string;
}

/**
 * Resolve `current` on every (re)start, as the launcher would, so a runtime
 * switch takes effect at the worker's next restart. Outside an installed
 * runtime (development), run this process's own entry point.
 */
export function resolveWorkerCommand(dataDir: string, entry: string = process.argv[1] ?? ""): WorkerCommand {
  const current = readCurrentVersion(dataDir);
  if (current) {
    const versionDir = path.join(runtimeRoot(dataDir), current);
    const node = runtimeNodePath(versionDir);
    const bin = path.join(versionDir, "package", "dist", "bin.js");
    if (fs.existsSync(node) && fs.existsSync(bin)) {
      return { command: node, args: [bin, "connect", "--data-dir", dataDir], runtimeDir: versionDir };
    }
  }
  return { command: process.execPath, args: [entry, "connect", "--data-dir", dataDir] };
}

export function nextBackoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** failures, BACKOFF_MAX_MS);
}

function openLog(file: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // missing, or the rename lost a race: append to whatever is there
  }
  return fs.openSync(file, "a");
}

export interface SuperviseOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Tests: what to run instead of the installed worker. */
  resolveWorker?: () => WorkerCommand;
  /** Tests: shorten the waits. */
  backoff?: (failures: number) => number;
  stopGraceMs?: number;
}

/** Resolves with the process exit code once the supervisor is done. */
export async function runSupervise(options: SuperviseOptions): Promise<number> {
  const { dataDir } = options;
  const env = options.env ?? process.env;
  const logsDir = path.join(dataDir, "logs");
  const logFd = openLog(path.join(logsDir, "supervise.log"));
  const log = (message: string): void => {
    fs.writeSync(logFd, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  };

  if (stoppedThisBoot(dataDir)) {
    log("stopped by `connect stop` during this boot; not starting the worker");
    return 0;
  }

  const server = net.createServer();
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(supervisePipePath(dataDir), () => resolve(true));
  });
  if (!listening) {
    // The task's repetition fires every minute while we run.
    return 0;
  }
  log("supervisor started");

  let worker: ChildProcess | null = null;
  let stopping = false;
  let failures = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let done: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => {
    done = resolve;
  });

  const startWorker = (): void => {
    restartTimer = null;
    if (stopping) return;
    const target = options.resolveWorker?.() ?? resolveWorkerCommand(dataDir);
    const consoleFd = openLog(path.join(logsDir, "worker-console.log"));
    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(target.command, target.args, {
        ...treeSpawnOptions(),
        stdio: ["pipe", consoleFd, consoleFd],
        env: {
          ...env,
          [SUPERVISOR_ENV]: SUPERVISOR_NAME,
          [INSTALL_MODE_ENV]: "native-service",
          ...(target.runtimeDir ? { VIBEDECKX_RUNTIME_DIR: target.runtimeDir } : {}),
        },
      });
    } finally {
      fs.closeSync(consoleFd);
    }
    worker = child;
    let gone = false;
    // A failed spawn may emit only "error", a normal one only "exit".
    const onGone = (how: string): void => {
      if (gone) return;
      gone = true;
      if (worker === child) worker = null;
      if (stopping) return;
      if (Date.now() - startedAt >= STABLE_AFTER_MS) failures = 0;
      const delay = (options.backoff ?? nextBackoffMs)(failures);
      failures += 1;
      log(`worker ${how}; restarting in ${delay / 1000}s`);
      restartTimer = setTimeout(startWorker, delay);
    };
    child.stdin?.on("error", () => {});
    child.on("error", (error) => onGone(`failed: ${error.message}`));
    child.on("exit", (code, signal) => onGone(`exited (code ${code ?? "none"}${signal ? `, ${signal}` : ""})`));
    log(`worker started (PID ${child.pid ?? "?"}): ${target.command}`);
  };

  const stopWorker = (): Promise<void> =>
    new Promise((resolve) => {
      const child = worker;
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
      const graceMs = options.stopGraceMs ?? WORKER_STOP_GRACE_MS;
      const force = setTimeout(() => {
        log(`worker did not exit within ${graceMs / 1000}s; killing its process tree`);
        if (child.pid === undefined || !killProcessTree(child.pid, "SIGKILL")) child.kill("SIGKILL");
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.stdin?.end();
    });

  server.on("connection", (socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const command = buffer.slice(0, newline).trim();
      buffer = "";
      if (command === "ping") {
        socket.end(`${JSON.stringify({ pid: process.pid, workerPid: worker?.pid ?? null })}\n`);
        return;
      }
      if (command === "quit") {
        if (stopping) return void socket.end("ok\n");
        stopping = true;
        if (restartTimer) clearTimeout(restartTimer);
        log("quit requested; stopping the worker");
        void stopWorker().then(() => {
          log("supervisor exiting");
          socket.end("ok\n", () => {
            server.close();
            done(0);
          });
        });
        return;
      }
      socket.end(`error: unknown command ${JSON.stringify(command)}\n`);
    });
  });

  startWorker();
  const code = await finished;
  fs.closeSync(logFd);
  return code;
}
