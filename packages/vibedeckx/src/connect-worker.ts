import fs from "node:fs";
import path from "node:path";
import { createSqliteStorage } from "./storage/sqlite.js";
import { createServer } from "./server.js";
import { ReverseConnectClient } from "./reverse-connect-client.js";
import { setupLogging, shutdownLogging } from "./logger.js";
import {
  claimDaemonState,
  daemonStatePath,
  inspectDaemonState,
  notifyDaemonParentError,
  notifyDaemonParentReady,
  removeDaemonStateIfOwned,
  type ConnectDaemonState,
} from "./connect-daemon.js";
import { preflightIdentityCheck } from "./connect-preflight.js";
import {
  clearRepinRequest,
  connectConfigDir,
  isRepinRequested,
  NOT_CONFIGURED_HINT,
  readToken,
  resolveConnectTo,
  resolveInstallMode,
  resolveSupervisor,
  resolveTokenSource,
  savedTokenPath,
  type TokenSource,
} from "./connect-config.js";
import { acquireInstanceLock, type InstanceLock } from "./connect-instance-lock.js";
import { HeartbeatWriter } from "./connect-heartbeat.js";
import { ConnectionSupervisor } from "./connect-supervisor.js";
import { processIdentitySupported } from "./process-identity.js";
import { readPackageVersion } from "./utils/package-version.js";
import { redactErrorSecret } from "./secret-redaction.js";

export interface RunConnectWorkerOptions {
  dataDir: string;
  connectToFlag?: string;
  tokenFlag?: string;
  tokenFileFlag?: string;
  daemonChild: { isDaemonChild: boolean; token: string | undefined };
  force: boolean;
  port?: number;
  logLevel?: string;
  env?: NodeJS.ProcessEnv;
}

const CONFIG_POLL_MS = 30_000;

/**
 * Run a reverse-connect worker in the foreground until SIGTERM/SIGINT.
 *
 * Ordering is the single-instance guarantee (worker-supervision-design §3.5):
 * the data-dir lock is taken before anything shared is touched — run state,
 * the database, the identity pin, the hub. A loser exits without side effects.
 */
export async function runConnectWorker(options: RunConnectWorkerOptions): Promise<void> {
  const env = options.env ?? process.env;
  const { dataDir } = options;
  const supervisor = resolveSupervisor(env);
  const installMode = resolveInstallMode(env);
  // Under a supervisor, stay alive through config/auth problems; when run by
  // hand, fail the first attempt loudly instead (nobody restarts us anyway).
  const failFast = supervisor === undefined;

  // Configuration errors in manual mode surface before anything is touched.
  let tokenSource = resolveTokenSource({
    dataDir,
    flagToken: options.tokenFlag,
    flagTokenFile: options.tokenFileFlag,
    daemonChildToken: options.daemonChild.isDaemonChild ? options.daemonChild.token : undefined,
    env,
  });
  let connectTo = resolveConnectTo({ dataDir, flag: options.connectToFlag, env });
  if (failFast && (!connectTo || !tokenSource)) {
    throw new Error(
      `${!connectTo ? "No hub URL configured" : "No connect token configured"}. ${NOT_CONFIGURED_HINT}`,
    );
  }

  // Token text to scrub from any error we print ("" = nothing to scrub).
  const secret = (): string => {
    if (tokenSource?.kind === "literal") return tokenSource.value;
    try {
      return tokenSource ? readToken(tokenSource) : "";
    } catch {
      return "";
    }
  };

  let lock: InstanceLock | undefined;
  let ownedState: ConnectDaemonState | undefined;
  let heartbeat: HeartbeatWriter | undefined;
  let storage: Awaited<ReturnType<typeof createSqliteStorage>> | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let connection: ConnectionSupervisor | undefined;
  let configPoll: NodeJS.Timeout | undefined;
  let stopping = false;

  const closeResources = async (): Promise<unknown[]> => {
    const errors: unknown[] = [];
    const attempt = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        errors.push(error);
      }
    };
    if (configPoll) clearTimeout(configPoll);
    await attempt(() => connection?.stop());
    await attempt(() => server?.close());
    await attempt(() => storage?.close());
    await attempt(() => heartbeat?.stop());
    await attempt(() => {
      if (ownedState) removeDaemonStateIfOwned(dataDir, ownedState);
      ownedState = undefined;
    });
    // Last: once released, another worker may take the data-dir.
    await attempt(() => lock?.release());
    await attempt(() => shutdownLogging());
    return errors;
  };

  const cleanup = async (): Promise<void> => {
    if (stopping) {
      console.log("\nForce exiting...");
      process.exit(1);
    }
    stopping = true;
    console.log("\nShutting down...");
    const forceExit = setTimeout(() => {
      console.log("Shutdown timed out, force exiting...");
      process.exit(1);
    }, 5000);
    forceExit.unref();
    const cleanupErrors = await closeResources();
    for (const error of cleanupErrors) {
      process.stderr.write(`Error during shutdown: ${redactErrorSecret(error, secret())}\n`);
    }
    process.exit(cleanupErrors.length === 0 ? 0 : 1);
  };
  // Registered before startup so a stop during a long wait (e.g. for config)
  // still releases the lock and run state cleanly.
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    lock = acquireInstanceLock(dataDir);
    ownedState = claimRunState(dataDir, connectTo ?? "(not configured)");

    setupLogging({
      dataDir,
      level: options.logLevel,
      requireFileLogging: options.daemonChild.isDaemonChild || supervisor !== undefined,
    });
    console.log(
      `Starting vibedeckx in reverse-connect mode${supervisor ? ` (supervised by ${supervisor})` : ""}...`,
    );

    heartbeat = new HeartbeatWriter({
      dataDir,
      version: readPackageVersion(),
      connectTo: connectTo ?? "",
      supervisor,
      installMode,
    });
    heartbeat.start();

    if (!connectTo) {
      // Supervised and unconfigured: wait for `connect setup` instead of
      // crash-looping. The saved config is re-read periodically.
      heartbeat.setState("blocked", "No hub URL configured", NOT_CONFIGURED_HINT);
      console.warn(`[Connect] No hub URL configured; waiting. ${NOT_CONFIGURED_HINT}`);
      connectTo = await waitForConfig(dataDir, env, options.connectToFlag, (handle) => {
        configPoll = handle;
      }, () => stopping);
      if (!connectTo) return;
      heartbeat.setConnectTo(connectTo);
      updateRunStateTarget(dataDir, ownedState, connectTo);
    }
    const hubUrl = connectTo;

    if (!tokenSource) {
      // Supervised with no token anywhere: wait for the saved token file.
      fs.mkdirSync(connectConfigDir(dataDir), { recursive: true, mode: 0o700 });
      tokenSource = { kind: "file", path: savedTokenPath(dataDir), origin: "saved config" };
    }
    if (tokenSource.origin === "--token") {
      console.warn(
        "Warning: --token puts the token on the command line, visible in `ps`. " +
          "Prefer `vibedeckx connect setup` or --token-file.",
      );
    }

    storage = await createSqliteStorage(path.join(dataDir, "data.sqlite"));
    // Reverse-connect mode is inherently a remote-provider role: the inbound
    // server proxies requests through the tunnel into this instance, so the
    // path-based endpoints must be exposed. The UI is served by the upstream
    // server, never through the tunnel — run API-only so the lean npm install
    // (no dist/ui) works without downloading anything.
    server = await createServer({ storage, acceptRemote: true, uiRoot: null });
    // Localhost only; port 0 lets the OS pick.
    const { instance, port: localPort } = await server.startLocal(options.port ?? 0);
    console.log(`Local server running on 127.0.0.1:${localPort}`);
    // The upstream server generates session titles and PATCHes them back;
    // generating here too would waste tokens and duplicate traces.
    instance.agentSessionManager.suppressTitleGeneration = true;

    const settings = storage.settings;
    const beat = heartbeat;
    connection = new ConnectionSupervisor({
      tokenSource: tokenSource as TokenSource,
      readToken,
      preflight: (token, force) =>
        preflightIdentityCheck({ connectTo: hubUrl, token, settings, force }),
      createClient: (token, callbacks) =>
        new ReverseConnectClient(instance, hubUrl, token, localPort, callbacks),
      onState: (state, detail, fix) => beat.setState(state, detail, fix),
      repinRequested: () => isRepinRequested(dataDir),
      clearRepinRequest: () => clearRepinRequest(dataDir),
      forceRepin: options.force,
      failFast,
    });
    await connection.start();
    if (options.daemonChild.isDaemonChild) notifyDaemonParentReady();
    console.log(`Connecting to ${hubUrl}...`);
  } catch (error) {
    const safeMessage = redactErrorSecret(error, secret());
    console.error(`Error starting vibedeckx connect: ${safeMessage}`);
    const cleanupErrors = await closeResources();
    if (options.daemonChild.isDaemonChild) notifyDaemonParentError(error);
    const cleanupMessages = cleanupErrors.map(
      (cleanupError) => `cleanup failed: ${redactErrorSecret(cleanupError, secret())}`,
    );
    throw new Error([safeMessage, ...cleanupMessages].join("; "));
  }

}

/**
 * Record which process holds the data-dir (for status/stop). Called with the
 * instance lock held, so any existing record is necessarily dead — except one
 * left by a pre-lock worker version, which is refused.
 */
function claimRunState(dataDir: string, connectTo: string): ConnectDaemonState | undefined {
  if (!processIdentitySupported()) return undefined;
  const inspection = inspectDaemonState(dataDir);
  if (inspection.kind === "running" && inspection.state.pid !== process.pid) {
    throw new Error(
      `Data directory ${dataDir} is in use by an older vibedeckx connect worker (PID ${inspection.state.pid}). ` +
        "Stop it first with `vibedeckx connect stop`.",
    );
  }
  if (inspection.kind !== "missing") {
    fs.rmSync(daemonStatePath(dataDir), { force: true });
  }
  return claimDaemonState(dataDir, connectTo, readPackageVersion());
}

function updateRunStateTarget(
  dataDir: string,
  state: ConnectDaemonState | undefined,
  connectTo: string,
): void {
  if (!state) return;
  const statePath = daemonStatePath(dataDir);
  const next: ConnectDaemonState = { ...state, connectTo };
  fs.writeFileSync(statePath, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  state.connectTo = connectTo;
}

function waitForConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  flag: string | undefined,
  registerTimer: (handle: NodeJS.Timeout) => void,
  isStopping: () => boolean,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (isStopping()) {
        resolve(undefined);
        return;
      }
      let found: string | undefined;
      try {
        found = resolveConnectTo({ dataDir, flag, env });
      } catch (error) {
        console.warn(
          `[Connect] Saved config is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (found) {
        console.log(`[Connect] Hub URL configured: ${found}`);
        resolve(found);
        return;
      }
      registerTimer(setTimeout(check, CONFIG_POLL_MS));
    };
    check();
  });
}
