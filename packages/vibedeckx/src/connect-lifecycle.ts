import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import {
  inspectDaemonState,
  startConnectDaemon,
  stopConnectDaemon,
  type DaemonCommandResult,
} from "./connect-daemon.js";
import {
  CONNECT_TOKEN_ENV,
  CONNECT_TOKEN_FILE_ENV,
  NOT_CONFIGURED_HINT,
  readSavedConfig,
  readToken,
  requestRepin,
  resolveConnectTo,
  resolveInstallMode,
  resolveTokenSource,
  savedConfigPath,
  savedTokenPath,
  writeSavedConfig,
  writeSavedToken,
} from "./connect-config.js";
import {
  judgeLiveness,
  readWorkerStatus,
  type WorkerStatus,
} from "./connect-heartbeat.js";
import {
  adapterForRecord,
  createServiceAdapter,
  readServiceRecord,
  removeServiceRecord,
  writeServiceRecord,
  SystemdUserAdapter,
  type Exec,
  type ServiceAdapter,
} from "./connect-service.js";
import {
  detectRuntimeSource,
  installRuntime,
  type RuntimeSource,
} from "./connect-runtime.js";
import { compareUpdateStatus, fetchLatestPublishedVersion } from "./update-check.js";
import { describeShim, installShim, removeShim } from "./connect-shim.js";

/**
 * `vibedeckx connect` lifecycle commands (worker-supervision-design §3.7).
 * Each returns a DaemonCommandResult; the CLI prints `message` and maps a
 * non-zero `exitCode` to a failing exit.
 */

const DOCKER_HINT =
  "This worker runs in Docker. Manage it from the host instead: " +
  "`docker start|stop|restart <container>`; to keep it stopped across reboots, " +
  "`docker update --restart=no <container>` then `docker stop <container>`.";

function refuseInDocker(env: NodeJS.ProcessEnv): DaemonCommandResult | undefined {
  if (resolveInstallMode(env) !== "docker") return undefined;
  return { exitCode: 1, message: DOCKER_HINT };
}

function ok(message: string): DaemonCommandResult {
  return { exitCode: 0, message };
}

function failed(message: string): DaemonCommandResult {
  return { exitCode: 1, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

export interface SetupOptions {
  dataDir: string;
  connectTo?: string;
  /** Token value from the command line (copy-pasted install command). */
  token?: string;
  tokenFile?: string;
  tokenStdin?: boolean;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Interactive hidden prompt; undefined when stdin is not a TTY. With
   * `keepExisting`, an empty answer keeps the saved token.
   */
  promptToken?: (keepExisting: boolean) => Promise<string>;
  readStdin?: () => Promise<string>;
}

export interface SetupOutcome {
  connectTo: string;
  tokenUpdated: boolean;
  repinRequested: boolean;
}

/**
 * Save the hub URL and token into the data-dir. The token never comes from
 * argv: a hidden prompt, stdin, a file, or the environment. Without a new
 * token, an already-saved one is kept.
 */
export async function runSetup(options: SetupOptions): Promise<SetupOutcome> {
  const env = options.env ?? process.env;
  const sources = [
    options.token !== undefined && "--token",
    options.tokenFile !== undefined && "--token-file",
    options.tokenStdin && "--token-stdin",
  ].filter(Boolean);
  if (sources.length > 1) {
    throw new Error(`Use only one of ${sources.join(", ")}`);
  }

  const connectTo = resolveConnectTo({ dataDir: options.dataDir, flag: options.connectTo, env });
  if (!connectTo) {
    throw new Error("No hub URL: pass --connect-to <url>");
  }

  let token: string | undefined;
  if (options.token !== undefined) {
    // Fine here, unlike on a long-running `connect --token`: the value is on
    // this short-lived command line only and is stored privately from now on.
    token = options.token.trim();
    if (!token) throw new Error("--token is empty");
  } else if (options.tokenFile !== undefined) {
    token = readToken({ kind: "file", path: path.resolve(options.tokenFile), origin: "--token-file" });
  } else if (options.tokenStdin) {
    token = (await (options.readStdin ?? readAllStdin)()).trim();
    if (!token) throw new Error("No token received on stdin");
  } else if (env[CONNECT_TOKEN_ENV] !== undefined || env[CONNECT_TOKEN_FILE_ENV] !== undefined) {
    const source = resolveTokenSource({ dataDir: options.dataDir, env });
    token = source ? readToken(source) : undefined;
  } else if (!fs.existsSync(savedTokenPath(options.dataDir))) {
    if (!options.promptToken) {
      throw new Error(
        "No connect token: pass --token-file <path> or --token-stdin (no terminal to prompt on)",
      );
    }
    token = (await options.promptToken(false)).trim();
    if (!token) throw new Error("No token entered");
  } else if (options.promptToken) {
    // A token is saved already: offer to replace it (rotation), Enter keeps it.
    const answer = (await options.promptToken(true)).trim();
    token = answer ? answer : undefined;
  }

  writeSavedConfig(options.dataDir, connectTo);
  if (token !== undefined) writeSavedToken(options.dataDir, token);
  if (options.force) requestRepin(options.dataDir);
  return {
    connectTo,
    tokenUpdated: token !== undefined,
    repinRequested: options.force ?? false,
  };
}

export function describeSetup(dataDir: string, outcome: SetupOutcome): string {
  const lines = [
    `Saved connect configuration in ${path.dirname(savedConfigPath(dataDir))}`,
    `Hub: ${outcome.connectTo}`,
    outcome.tokenUpdated ? "Token: updated" : "Token: unchanged (already saved)",
  ];
  if (outcome.repinRequested) {
    lines.push("Re-pin requested: the next successful identity check re-pins this machine.");
  }
  lines.push(
    "A running worker picks up a new token by itself; other changes need `vibedeckx connect restart`.",
  );
  return lines.join("\n");
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Prompt without echoing what is typed. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    process.stdout.write(question);
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      reject(new Error("Cancelled"));
    });
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface StatusOptions {
  checkUpdate?: boolean;
  /** Exit 0 only when connected to the hub (readiness). */
  requireConnected?: boolean;
  fetchLatestVersion?: () => Promise<string | undefined>;
  now?: Date;
  exec?: Exec;
}

function describeUpdate(current: string, latest: string | undefined): string {
  switch (compareUpdateStatus(current, latest)) {
    case "update-available":
      return ` (update available: ${latest})`;
    case "up-to-date":
      return " (up to date)";
    case "unknown":
      return " (update check failed)";
  }
}

function formatAge(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

function describeConnection(status: WorkerStatus | undefined, pid: number): string[] {
  if (!status || status.pid !== pid) {
    return ["Connection: unknown (this worker version does not report it)"];
  }
  const lines = [`Connection: ${status.state}${status.detail ? ` — ${status.detail}` : ""}`];
  if (status.fix) lines.push(`  Fix: ${status.fix}`);
  return lines;
}

function describeService(dataDir: string, exec?: Exec): string | undefined {
  const record = readServiceRecord(dataDir);
  if (!record) return undefined;
  const adapter = adapterForRecord(dataDir, record, { exec });
  let autoStart = "";
  if (adapter instanceof SystemdUserAdapter) {
    autoStart = adapter.isEnabled() ? ", auto-start enabled" : ", auto-start disabled";
  }
  return `Service: ${record.kind} (${record.name}${autoStart})`;
}

/** Local and network-free unless checkUpdate is set (§3.6). */
export async function describeWorker(
  dataDir: string,
  options: StatusOptions = {},
): Promise<DaemonCommandResult> {
  const inspection = inspectDaemonState(dataDir);
  const service = describeService(dataDir, options.exec);

  switch (inspection.kind) {
    case "running": {
      const state = inspection.state;
      const status = readWorkerStatus(dataDir);
      const liveness = judgeLiveness(status, state.pid, options.now);
      const lines = [`Running (PID ${state.pid}, since ${state.startedAt})`];
      lines.push(...describeConnection(status, state.pid));
      if (liveness) {
        lines.push(
          liveness.live
            ? `Heartbeat: ${formatAge(liveness.ageMs ?? 0)} ago`
            : `Heartbeat: STALE — none for ${formatAge(liveness.ageMs ?? 0)}; the worker may be unresponsive`,
        );
      }
      let version = `Version: ${state.version}`;
      if (options.checkUpdate) {
        const latest = await (options.fetchLatestVersion ?? fetchLatestPublishedVersion)();
        version += describeUpdate(state.version, latest);
      }
      lines.push(version);
      lines.push(`Target: ${state.connectTo}`);
      const supervisor = status && status.pid === state.pid ? status.supervisor : undefined;
      if (service) lines.push(service);
      else lines.push(`Supervisor: ${supervisor ?? "none (manual)"}`);
      lines.push(`Logs: ${path.join(dataDir, "logs", "vibedeckx.log")}`);

      let exitCode = liveness && !liveness.live ? 1 : 0;
      if (options.requireConnected) {
        const connected = status?.pid === state.pid && status.state === "connected";
        if (!connected) exitCode = 1;
      }
      return { exitCode, message: lines.join("\n") };
    }
    case "missing": {
      const lines = ["Vibedeckx connect is not running"];
      if (service) lines.push(service);
      return failed(lines.join("\n"));
    }
    case "stale":
      return failed(
        [
          `Vibedeckx connect has stale daemon state for PID ${inspection.state.pid}`,
          ...(service ? [service] : []),
        ].join("\n"),
      );
    case "invalid":
      return failed(`Invalid daemon state at ${inspection.path}: ${inspection.reason}`);
  }
}

// ---------------------------------------------------------------------------
// start / stop / restart / enable / disable
// ---------------------------------------------------------------------------

export interface LifecycleOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  platform?: NodeJS.Platform;
  /** Manual start: the CLI entry the daemon child runs (defaults to argv[1]). */
  entrypoint?: string;
}

function serviceAdapter(options: LifecycleOptions): ServiceAdapter | undefined {
  const record = readServiceRecord(options.dataDir);
  return record
    ? adapterForRecord(options.dataDir, record, { exec: options.exec, env: options.env })
    : undefined;
}

async function startManual(options: LifecycleOptions): Promise<DaemonCommandResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return failed(
      "No service is installed for this data directory. Run `vibedeckx connect install`, " +
        "or run `vibedeckx connect` in the foreground.",
    );
  }
  const env = options.env ?? process.env;
  const connectTo = resolveConnectTo({ dataDir: options.dataDir, env });
  const source = resolveTokenSource({ dataDir: options.dataDir, env });
  if (!connectTo || !source) return failed(`Not configured. ${NOT_CONFIGURED_HINT}`);
  const started = await startConnectDaemon({
    dataDir: options.dataDir,
    connectTo,
    // File sources (incl. the saved token) are resolved by the child itself.
    token: source.kind === "literal" ? source.value : undefined,
    argv: ["connect", "--data-dir", options.dataDir],
    entrypoint: options.entrypoint,
  });
  return ok(
    [
      `Vibedeckx connect started in background (PID ${started.pid}).`,
      `Target: ${started.target}`,
      `Logs: ${started.logPath}`,
    ].join("\n"),
  );
}

function runServiceAction(action: () => void, done: string): DaemonCommandResult {
  try {
    action();
    return ok(done);
  } catch (error) {
    return failed(errorMessage(error));
  }
}

export async function lifecycleStart(options: LifecycleOptions): Promise<DaemonCommandResult> {
  const refused = refuseInDocker(options.env ?? process.env);
  if (refused) return refused;
  const adapter = serviceAdapter(options);
  if (adapter) {
    return runServiceAction(() => adapter.start(), `Started ${adapter.name}`);
  }
  try {
    return await startManual(options);
  } catch (error) {
    return failed(errorMessage(error));
  }
}

export async function lifecycleStop(options: LifecycleOptions): Promise<DaemonCommandResult> {
  const refused = refuseInDocker(options.env ?? process.env);
  if (refused) return refused;
  const adapter = serviceAdapter(options);
  if (adapter) {
    return runServiceAction(
      () => adapter.stop(),
      `Stopped ${adapter.name}. It starts again at the next boot/login; use \`vibedeckx connect disable\` to keep it off.`,
    );
  }
  return stopConnectDaemon(options.dataDir);
}

export async function lifecycleRestart(options: LifecycleOptions): Promise<DaemonCommandResult> {
  const refused = refuseInDocker(options.env ?? process.env);
  if (refused) return refused;
  const adapter = serviceAdapter(options);
  if (adapter) {
    return runServiceAction(() => adapter.restart(), `Restarted ${adapter.name}`);
  }
  const stopped = await stopConnectDaemon(options.dataDir);
  if (stopped.exitCode !== 0) return stopped;
  return lifecycleStart(options);
}

export async function lifecycleEnable(options: LifecycleOptions): Promise<DaemonCommandResult> {
  const refused = refuseInDocker(options.env ?? process.env);
  if (refused) return refused;
  const adapter = serviceAdapter(options);
  if (!adapter) return failed("No service is installed. Run `vibedeckx connect install` first.");
  return runServiceAction(() => adapter.enable(), `Enabled and started ${adapter.name}`);
}

export async function lifecycleDisable(options: LifecycleOptions): Promise<DaemonCommandResult> {
  const refused = refuseInDocker(options.env ?? process.env);
  if (refused) return refused;
  const adapter = serviceAdapter(options);
  if (!adapter) return failed("No service is installed. Run `vibedeckx connect install` first.");
  return runServiceAction(
    () => adapter.disable(),
    `Stopped ${adapter.name} and disabled auto-start. It stays off across reboots until \`vibedeckx connect enable\`.`,
  );
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

export interface InstallServiceOptions extends SetupOptions {
  exec?: Exec;
  platform?: NodeJS.Platform;
  /** Override the runtime source (tests); defaults to this process's package. */
  runtimeSource?: RuntimeSource;
  /** How long to wait for the service's first heartbeat. */
  verifyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Manual-daemon restart on failed migration (defaults to argv[1]). */
  entrypoint?: string;
}

// Entries that only exist for the lifetime of the invoking shell or command:
// npx/npm-exec bins, node-gyp shims, fnm's per-shell multishell links.
const EPHEMERAL_PATH_ENTRY =
  /[\\/]_npx[\\/]|[\\/]node_modules[\\/]\.bin$|node-gyp-bin|[\\/]fnm_multishells[\\/]/;

/**
 * The PATH baked into the service: this shell's PATH minus entries that will
 * be gone once it exits, minus missing/relative/duplicate directories, with
 * the system directories guaranteed.
 */
export function sanitizeServicePath(pathEnv: string, exists: (dir: string) => boolean = fs.existsSync): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (directory: string): void => {
    if (seen.has(directory)) return;
    seen.add(directory);
    out.push(directory);
  };
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    if (EPHEMERAL_PATH_ENTRY.test(directory)) continue;
    if (!exists(directory)) continue;
    add(directory);
  }
  for (const directory of ["/usr/local/bin", "/usr/bin", "/bin"]) add(directory);
  return out.join(path.delimiter);
}

function findOnPath(command: string, pathEnv: string): string | undefined {
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

async function waitForServiceHeartbeat(
  dataDir: string,
  notBeforeMs: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<WorkerStatus | undefined> {
  const deadline = Date.now() + timeoutMs;
  let found: WorkerStatus | undefined;
  let settleUntil = 0;
  while (Date.now() < deadline) {
    const inspection = inspectDaemonState(dataDir);
    const status = readWorkerStatus(dataDir);
    if (
      inspection.kind === "running" &&
      status &&
      status.pid === inspection.state.pid &&
      // A process started by this install, not the one it replaced.
      Date.parse(status.startedAt) >= notBeforeMs - 1000
    ) {
      if (!found) settleUntil = Date.now() + 10_000;
      found = status;
      // Give the first connection attempt a moment so the report is useful.
      if (status.state !== "starting" || Date.now() >= settleUntil) return status;
    } else if (found) {
      // It came up and went away again (e.g. crashed right after starting).
      found = undefined;
    }
    await sleep(250);
  }
  return found;
}

/**
 * Install (or update) the worker as a service of the current user (§4.1):
 * save config → install runtime → write the service definition → stop a
 * running manual worker (last) → start the service → wait for its heartbeat.
 * Idempotent; on failure the data-dir and installed runtimes stay intact and
 * re-running brings the service up.
 */
export async function installService(options: InstallServiceOptions): Promise<DaemonCommandResult> {
  const env = options.env ?? process.env;
  const refused = refuseInDocker(env);
  if (refused) return refused;
  const log = options.log ?? ((line: string) => console.log(line));
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { dataDir } = options;

  let adapter: ServiceAdapter;
  try {
    adapter = createServiceAdapter(dataDir, { platform: options.platform, exec: options.exec, env });
    adapter.preflight();
  } catch (error) {
    return failed(errorMessage(error));
  }

  // 1. Configuration. The service only sees the saved config (plus PATH/HOME),
  //    never this shell's environment, so it must be complete on disk.
  const hasSaved = readSavedConfig(dataDir) !== undefined && fs.existsSync(savedTokenPath(dataDir));
  const wantsSetup =
    !hasSaved ||
    options.connectTo !== undefined ||
    options.token !== undefined ||
    options.tokenFile !== undefined ||
    options.tokenStdin ||
    options.force;
  if (wantsSetup) {
    try {
      const outcome = await runSetup(options);
      log(describeSetup(dataDir, outcome));
    } catch (error) {
      return failed(`Setup failed: ${errorMessage(error)}`);
    }
  }

  // 2. Runtime.
  let launcher: string;
  try {
    const source = options.runtimeSource ?? detectRuntimeSource();
    const runtime = installRuntime(dataDir, source);
    launcher = runtime.launcher;
    log(
      `Runtime ${runtime.version} ${runtime.copied ? "installed" : "already installed"} at ${runtime.versionDir}`,
    );
  } catch (error) {
    return failed(`Installing the runtime failed: ${errorMessage(error)}`);
  }

  // 3. Service definition (registered for auto-start, not started yet).
  const pathEnv = sanitizeServicePath(env.PATH ?? "");
  for (const cli of ["claude", "codex", "git"]) {
    if (!findOnPath(cli, pathEnv)) {
      log(`Note: \`${cli}\` is not on PATH; the service will not find it either.`);
    }
  }
  const wasActive = (() => {
    try {
      return adapter.isActive();
    } catch {
      return false;
    }
  })();
  try {
    adapter.install({ dataDir, launcher, pathEnv, home: env.HOME ?? os.homedir() });
    writeServiceRecord(dataDir, adapter);
  } catch (error) {
    return failed(`Writing the service definition failed: ${errorMessage(error)}`);
  }
  log(`Service definition: ${adapter.definitionPath}`);

  // 4. Migration: stop a manually started worker as the very last step before
  //    the service starts, so the two never fight over the data-dir lock.
  let stoppedManualPid: number | undefined;
  const inspection = inspectDaemonState(dataDir);
  if (inspection.kind === "running" && !wasActive) {
    const stopped = await stopConnectDaemon(dataDir);
    if (stopped.exitCode !== 0) {
      return failed(
        `The service is installed but was not started: the running worker (PID ${inspection.state.pid}) ` +
          `could not be stopped (${stopped.message}). Stop it, then run \`vibedeckx connect start\`.`,
      );
    }
    stoppedManualPid = inspection.state.pid;
    log(`Stopped the manually started worker (PID ${inspection.state.pid}).`);
  }

  // 5. Start (or restart onto the new definition/runtime) and verify.
  const startedAt = Date.now();
  try {
    if (wasActive) adapter.restart();
    else adapter.start();
  } catch (error) {
    return failed(await afterFailedStart(options, stoppedManualPid, errorMessage(error)));
  }
  const status = await waitForServiceHeartbeat(
    dataDir,
    startedAt,
    options.verifyTimeoutMs ?? 20_000,
    sleep,
  );
  if (!status) {
    return failed(
      await afterFailedStart(
        options,
        stoppedManualPid,
        `the service did not report a heartbeat in time (${logHint(adapter)})`,
      ),
    );
  }

  const lines = [
    `Installed and started ${adapter.name} (PID ${status.pid}, connection: ${status.state}).`,
    "It restarts on crashes and starts at boot. Check it with `vibedeckx connect status`.",
  ];
  if (adapter instanceof SystemdUserAdapter && adapter.lingerEnabled() === false) {
    if (adapter.tryEnableLinger()) lines.push("Enabled lingering so the worker starts at boot.");
  }
  lines.push(...adapter.notes());
  try {
    const shim = installShim({
      dataDir,
      launcher,
      home: env.HOME ?? os.homedir(),
      pathEnv: env.PATH ?? "",
    });
    lines.push(...describeShim(shim, dataDir, launcher));
  } catch (error) {
    // The service is up; a missing convenience command is not a failure.
    lines.push(`Could not create the \`vibedeckx\` command: ${errorMessage(error)}`);
  }
  return ok(lines.join("\n"));
}

function logHint(adapter: ServiceAdapter): string {
  return adapter.kind === "systemd"
    ? `see \`journalctl --user -u ${adapter.name}\``
    : "see logs/launchd.log in the data directory";
}

async function afterFailedStart(
  options: InstallServiceOptions,
  stoppedManualPid: number | undefined,
  reason: string,
): Promise<string> {
  const parts = [`Starting the service failed: ${reason}.`];
  if (stoppedManualPid !== undefined) {
    // Best effort: put the previously running worker back.
    const restarted = await lifecycleStartManualBestEffort(options);
    parts.push(
      restarted
        ? "The previously running worker was restarted."
        : "The previously running worker could not be restarted.",
    );
  }
  parts.push("Fix the cause and re-run `vibedeckx connect install`.");
  return parts.join(" ");
}

async function lifecycleStartManualBestEffort(options: InstallServiceOptions): Promise<boolean> {
  try {
    // The service definition exists but the service is not running; stop it
    // from retrying so the manual worker can hold the lock.
    const record = readServiceRecord(options.dataDir);
    if (record) {
      try {
        adapterForRecord(options.dataDir, record, { exec: options.exec, env: options.env }).stop();
      } catch {
        // ignore
      }
    }
    const result = await startManual({
      dataDir: options.dataDir,
      env: options.env,
      platform: options.platform,
      entrypoint: options.entrypoint,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function uninstallService(options: LifecycleOptions): Promise<DaemonCommandResult> {
  const refused = refuseInDocker(options.env ?? process.env);
  if (refused) return refused;
  const record = readServiceRecord(options.dataDir);
  if (!record) return ok("No service is installed for this data directory.");
  const adapter = adapterForRecord(options.dataDir, record, { exec: options.exec, env: options.env });
  try {
    adapter.uninstall();
    removeServiceRecord(options.dataDir);
    removeShim({ dataDir: options.dataDir, home: (options.env ?? process.env).HOME ?? os.homedir() });
  } catch (error) {
    return failed(`Uninstalling ${adapter.name} failed: ${errorMessage(error)}`);
  }
  return ok(
    [
      `Removed ${adapter.name}; the worker is stopped and will not start at boot.`,
      `Data, token and runtime are kept in ${options.dataDir}. ` +
        "Re-run `vibedeckx connect install` to bring it back.",
    ].join("\n"),
  );
}
