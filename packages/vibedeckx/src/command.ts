import fs from "node:fs";
import path from "node:path";
import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import { createSqliteStorage } from "./storage/sqlite.js";
import { createServer, type TLSOptions } from "./server.js";
import { resolveUiRoot } from "./ui-root.js";
import { DEFAULT_PORT, VIBEDECKX_HOME } from "./constants.js";
import { setupLogging, shutdownLogging } from "./logger.js";
import {
  assertConnectDaemonPlatform,
  CONNECT_DAEMON_READY_TIMEOUT_ENV,
  DEFAULT_CONNECT_DAEMON_READY_TIMEOUT_MS,
  consumeDaemonChildEnvironment,
  resolveConnectDaemonReadyTimeoutMs,
  startConnectDaemon,
  type DaemonCommandResult,
} from "./connect-daemon.js";
import {
  CONNECT_TO_ENV,
  CONNECT_TOKEN_ENV,
  CONNECT_TOKEN_FILE_ENV,
  DATA_DIR_ENV,
  NOT_CONFIGURED_HINT,
  resolveConnectTo,
  resolveDataDir,
  resolveTokenSource,
} from "./connect-config.js";
import {
  describeSetup,
  describeWorker,
  installService,
  lifecycleDisable,
  lifecycleEnable,
  lifecycleRestart,
  lifecycleStart,
  lifecycleStop,
  promptHidden,
  runSetup,
  uninstallService,
} from "./connect-lifecycle.js";
import { runConnectWorker } from "./connect-worker.js";
import { runSupervise } from "./connect-windows-supervise.js";
import { readPackageVersion } from "./utils/package-version.js";
import open from "open";

function loadTLSOptions(flags: {
  cert: string | undefined;
  key: string | undefined;
  "client-ca": string | undefined;
}): TLSOptions | undefined {
  const certPath = flags.cert ?? process.env.VIBEDECKX_TLS_CERT;
  const keyPath = flags.key ?? process.env.VIBEDECKX_TLS_KEY;
  const clientCAPath = flags["client-ca"] ?? process.env.VIBEDECKX_TLS_CLIENT_CA;

  if (!certPath && !keyPath && !clientCAPath) return undefined;

  if (!certPath || !keyPath) {
    console.error("Error: --cert and --key must both be provided to enable HTTPS");
    process.exit(1);
  }

  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    ...(clientCAPath && { clientCA: fs.readFileSync(clientCAPath) }),
  };
}


const startCommand = buildCommand({
  parameters: {
    flags: {
      port: {
        kind: "parsed",
        parse: parseInt,
        brief: "Port to run the server on",
        optional: true,
      },
      host: {
        kind: "parsed",
        parse: String,
        brief: "Network interface to bind (default: 127.0.0.1, loopback only). Use 0.0.0.0 to expose on all interfaces — only do so behind --auth or an authenticating proxy.",
        optional: true,
      },
      auth: {
        kind: "boolean",
        brief: "Enable Clerk authentication (requires CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY env vars)",
        optional: true,
      },
      "data-dir": {
        kind: "parsed",
        parse: String,
        brief: "Directory for storing database file (default: ~/.vibedeckx)",
        optional: true,
      },
      "env-file": {
        kind: "parsed",
        parse: String,
        brief: "Path to a .env file loaded at startup (default: <data-dir or ~/.vibedeckx>/.env). Shell-set variables take precedence.",
        optional: true,
      },
      "no-local-projects": {
        kind: "boolean",
        brief: "Disable creation of local-folder projects (for SaaS/hosted deployments). Remote projects are unaffected.",
        optional: true,
      },
      cert: {
        kind: "parsed",
        parse: String,
        brief: "Path to TLS certificate (PEM). Enables HTTPS when provided together with --key. Env: VIBEDECKX_TLS_CERT",
        optional: true,
      },
      key: {
        kind: "parsed",
        parse: String,
        brief: "Path to TLS private key (PEM). Required with --cert. Env: VIBEDECKX_TLS_KEY",
        optional: true,
      },
      "client-ca": {
        kind: "parsed",
        parse: String,
        brief: "Path to client CA bundle (PEM) for mTLS, e.g. Cloudflare Authenticated Origin Pulls. Requires --cert/--key. Env: VIBEDECKX_TLS_CLIENT_CA",
        optional: true,
      },
      "log-level": {
        kind: "parsed",
        parse: String,
        brief: "Log level: trace, debug, info, warn, error, fatal, silent (default: info). Env: VIBEDECKX_LOG_LEVEL. Logs are written to <data-dir>/logs/ with daily/10MB rotation.",
        optional: true,
      },
      "ui-dir": {
        kind: "parsed",
        parse: String,
        brief: "Directory of UI static assets to serve (default: bundled dist/ui, installed @vibedeckx/ui-dist, or a one-time download cached in ~/.vibedeckx/ui). Env: VIBEDECKX_UI_DIR",
        optional: true,
      },
      "no-ui": {
        kind: "boolean",
        brief: "Serve the API only; skip UI assets entirely (no lookup, no download)",
        optional: true,
      },
    },
  },
  func: async (flags: {
    port: number | undefined;
    host: string | undefined;
    auth: boolean | undefined;
    "data-dir": string | undefined;
    // Consumed by load-env.ts before the CLI parses flags; declared here so the
    // flag is recognized and documented.
    "env-file": string | undefined;
    "no-local-projects": boolean | undefined;
    cert: string | undefined;
    key: string | undefined;
    "client-ca": string | undefined;
    "log-level": string | undefined;
    "ui-dir": string | undefined;
    "no-ui": boolean | undefined;
  }) => {
    const dataDir = flags["data-dir"] ?? VIBEDECKX_HOME;
    setupLogging({ dataDir, level: flags["log-level"] });

    const port = flags.port ?? DEFAULT_PORT;
    const host = flags.host ?? "127.0.0.1";
    const authEnabled = flags.auth ?? false;
    const noLocalProjects = flags["no-local-projects"] ?? false;
    const tls = loadTLSOptions(flags);

    // Binding beyond loopback puts the (per-route-unauthenticated) executor API
    // on the network. Without --auth, anyone who can reach the host can run
    // commands. Warn rather than refuse — a trusted tunnel/proxy in front is a
    // legitimate setup, but the operator should know it's open. VIBEDECKX_API_KEY
    // is deliberately not an escape from this warning: it gates /api/admin/*
    // only and protects nothing a caller would use to run commands.
    const isLoopbackHost =
      host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!isLoopbackHost && !authEnabled) {
      console.warn(
        `Warning: binding to ${host} exposes vibedeckx on the network with no authentication.\n` +
        "Anyone who can reach this host can run commands via the executor API. Enable --auth, or put\n" +
        "an authenticating proxy in front, or keep the default loopback bind (127.0.0.1)."
      );
    }

    // Anyone who set this expecting a lock on the whole API surface should hear
    // that it no longer is one — silence would leave them believing in a
    // protection that isn't there.
    if (process.env.VIBEDECKX_API_KEY) {
      console.log(
        "VIBEDECKX_API_KEY is set: it authenticates operator-only endpoints (/api/admin/*).\n" +
        "It does not lock the rest of the API and is not user authentication — use --auth or a\n" +
        "proxy in front for that."
      );
    }

    console.log(`Starting vibedeckx${tls ? " (HTTPS)" : ""}...`);

    const uiRoot = await resolveUiRoot({ uiDir: flags["ui-dir"], noUi: flags["no-ui"] });

    const dbPath = path.join(dataDir, "data.sqlite");
    const storage = await createSqliteStorage(dbPath);
    const server = await createServer({ storage, authEnabled, noLocalProjects, tls, uiRoot });

    const url = await server.start(port, host);
    console.log(`Server running at ${url}`);

    // Skip auto-open when TLS is on: the cert is for the public domain,
    // so https://localhost would just show a cert warning. API-only mode has
    // nothing to show in a browser either.
    if (!tls && uiRoot) {
      await open(url);
    }

    // Graceful shutdown with re-entrancy guard and force-exit timeout
    let shuttingDown = false;

    const cleanup = async () => {
      if (shuttingDown) {
        console.log("\nForce exiting...");
        process.exit(1);
      }
      shuttingDown = true;
      console.log("\nShutting down...");

      // Force exit after 5 seconds if cleanup hangs
      const forceExit = setTimeout(() => {
        console.log("Shutdown timed out, force exiting...");
        process.exit(1);
      }, 5000);
      forceExit.unref();

      try {
        await server.close(); // triggers onClose hooks that kill child processes
        await storage.close();
      } catch (err) {
        console.error("Error during shutdown:", err);
      }
      // Last: flush buffered log lines to disk before the hard exit.
      await shutdownLogging().catch(() => {});
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  },
  docs: {
    brief: "Start the vibedeckx server",
  },
});

const dataDirFlag = {
  kind: "parsed" as const,
  parse: String,
  brief: `Data directory (default: ~/.vibedeckx). Env: ${DATA_DIR_ENV}`,
  optional: true as const,
};

const setupFlags = {
  "connect-to": {
    kind: "parsed" as const,
    parse: String,
    brief: `URL of the Vibedeckx server to connect to. Env: ${CONNECT_TO_ENV}`,
    optional: true as const,
  },
  token: {
    kind: "parsed" as const,
    parse: String,
    brief: "Connect token, as in the command copied from Settings → Remote Servers. It is saved privately; the worker never runs with it on its command line",
    optional: true as const,
  },
  "token-file": {
    kind: "parsed" as const,
    parse: String,
    brief: "Read the connect token from this file",
    optional: true as const,
  },
  "token-stdin": {
    kind: "boolean" as const,
    brief: "Read the connect token from stdin",
    optional: true as const,
  },
  force: {
    kind: "boolean" as const,
    brief: "Re-pin this machine to the token's remote on the next start, overriding the pinned-identity guard",
    optional: true as const,
  },
  "data-dir": dataDirFlag,
};

interface SetupFlags {
  "connect-to": string | undefined;
  token: string | undefined;
  "token-file": string | undefined;
  "token-stdin": boolean | undefined;
  force: boolean | undefined;
  "data-dir": string | undefined;
}

function setupOptionsFromFlags(flags: SetupFlags) {
  return {
    dataDir: resolveDataDir(flags["data-dir"]),
    connectTo: flags["connect-to"],
    token: flags.token,
    tokenFile: flags["token-file"],
    tokenStdin: flags["token-stdin"] ?? false,
    force: flags.force ?? false,
    promptToken: process.stdin.isTTY
      ? (keepExisting: boolean) =>
          promptHidden(
            keepExisting
              ? "New connect token (input hidden; Enter keeps the saved one): "
              : "Connect token (input hidden): ",
          )
      : undefined,
  };
}

const connectCommand = buildCommand({
  parameters: {
    flags: {
      "connect-to": {
        kind: "parsed",
        parse: String,
        brief: `URL of the Vibedeckx server to connect to (default: saved by \`connect setup\`). Env: ${CONNECT_TO_ENV}`,
        optional: true,
      },
      token: {
        kind: "parsed",
        parse: String,
        brief: `Authentication token (visible in \`ps\`; prefer \`connect setup\` or --token-file). Env: ${CONNECT_TOKEN_ENV}`,
        optional: true,
      },
      "token-file": {
        kind: "parsed",
        parse: String,
        brief: `File containing the authentication token; re-read when it changes. Env: ${CONNECT_TOKEN_FILE_ENV}`,
        optional: true,
      },
      daemon: {
        kind: "boolean",
        brief: "Run in the background after initialization (Linux only)",
        optional: true,
      },
      "daemon-ready-timeout-ms": {
        kind: "parsed",
        parse: String,
        brief: `Maximum time to wait for daemon startup readiness (default: ${DEFAULT_CONNECT_DAEMON_READY_TIMEOUT_MS} ms). Env: ${CONNECT_DAEMON_READY_TIMEOUT_ENV}`,
        optional: true,
      },
      force: {
        kind: "boolean",
        brief: "Re-pin this machine to the token's remote, overriding the pinned-identity mismatch guard",
        optional: true,
      },
      port: {
        kind: "parsed",
        parse: parseInt,
        brief: "Local port for the server (default: 5173)",
        optional: true,
      },
      "data-dir": dataDirFlag,
      "env-file": {
        kind: "parsed",
        parse: String,
        brief: "Path to a .env file loaded at startup (default: <data-dir or ~/.vibedeckx>/.env). Shell-set variables take precedence.",
        optional: true,
      },
      "log-level": {
        kind: "parsed",
        parse: String,
        brief: "Log level: trace, debug, info, warn, error, fatal, silent (default: info). Env: VIBEDECKX_LOG_LEVEL. Logs are written to <data-dir>/logs/ with daily/10MB rotation.",
        optional: true,
      },
    },
  },
  func: async (flags: {
    "connect-to": string | undefined;
    token: string | undefined;
    "token-file": string | undefined;
    daemon: boolean | undefined;
    "daemon-ready-timeout-ms": string | undefined;
    force: boolean | undefined;
    port: number | undefined;
    "data-dir": string | undefined;
    "env-file": string | undefined;
    "log-level": string | undefined;
  }) => {
    const dataDir = resolveDataDir(flags["data-dir"]);
    const childContext = consumeDaemonChildEnvironment(process.env);

    if (flags.daemon) {
      assertConnectDaemonPlatform();
      const timeoutMs = resolveConnectDaemonReadyTimeoutMs(
        flags["daemon-ready-timeout-ms"],
        process.env[CONNECT_DAEMON_READY_TIMEOUT_ENV],
      );
      const source = resolveTokenSource({
        dataDir,
        flagToken: flags.token,
        flagTokenFile: flags["token-file"],
      });
      const connectTo = resolveConnectTo({ dataDir, flag: flags["connect-to"] });
      if (!connectTo || !source) {
        throw new Error(`${!connectTo ? "No hub URL configured" : "No connect token configured"}. ${NOT_CONFIGURED_HINT}`);
      }
      const started = await startConnectDaemon({
        dataDir,
        connectTo,
        // A --token value is moved into the child's environment; file and
        // saved sources are resolved by the child itself.
        token: flags.token,
        argv: process.argv.slice(2),
        timeoutMs,
      });
      console.log(
        `Vibedeckx connect started in background (PID ${started.pid}).`,
      );
      console.log(`Target: ${started.target}`);
      console.log(`Logs: ${started.logPath}`);
      return;
    }

    await runConnectWorker({
      dataDir,
      connectToFlag: flags["connect-to"],
      tokenFlag: flags.token,
      tokenFileFlag: flags["token-file"],
      daemonChild: childContext,
      force: flags.force ?? false,
      port: flags.port,
      logLevel: flags["log-level"],
    });
  },
  docs: {
    brief: "Connect to a remote Vibedeckx server as an inbound node",
  },
});

const connectManagementFlags = { "data-dir": dataDirFlag };

function reportDaemonCommandResult(
  result: DaemonCommandResult,
): void | Error {
  if (result.exitCode !== 0) return new Error(result.message);
  console.log(result.message);
}

const connectSetupCommand = buildCommand({
  parameters: { flags: setupFlags },
  func: async (flags: SetupFlags) => {
    const options = setupOptionsFromFlags(flags);
    const outcome = await runSetup(options);
    console.log(describeSetup(options.dataDir, outcome));
  },
  docs: { brief: "Save the hub URL and connect token (prompted, from stdin, or from a file)" },
});

const connectStatusCommand = buildCommand({
  parameters: {
    flags: {
      "data-dir": dataDirFlag,
      "check-update": {
        kind: "boolean",
        brief: "Also check the npm registry for a newer version (network)",
        optional: true,
      },
      ready: {
        kind: "boolean",
        brief: "Exit non-zero unless the worker is connected to the hub (readiness check)",
        optional: true,
      },
    },
  },
  func: async (flags: {
    "data-dir": string | undefined;
    "check-update": boolean | undefined;
    ready: boolean | undefined;
  }) => {
    const result = await describeWorker(resolveDataDir(flags["data-dir"]), {
      checkUpdate: flags["check-update"] ?? false,
      requireConnected: flags.ready ?? false,
    });
    return reportDaemonCommandResult(result);
  },
  docs: { brief: "Show the worker's status (local only; exit 0 = alive and responsive)" },
});

function lifecycleCommand(
  action: (options: { dataDir: string }) => Promise<DaemonCommandResult>,
  brief: string,
) {
  return buildCommand({
    parameters: { flags: connectManagementFlags },
    func: async (flags: { "data-dir": string | undefined }) =>
      reportDaemonCommandResult(
        await action({ dataDir: resolveDataDir(flags["data-dir"]) }),
      ),
    docs: { brief },
  });
}

const connectStartCommand = lifecycleCommand(
  lifecycleStart,
  "Start the worker (through its service if installed, else in the background)",
);
const connectStopCommand = lifecycleCommand(
  lifecycleStop,
  "Stop the worker until the next boot or `connect start` (auto-start unchanged)",
);
const connectRestartCommand = lifecycleCommand(
  lifecycleRestart,
  "Restart the worker",
);
const connectEnableCommand = lifecycleCommand(
  lifecycleEnable,
  "Resume auto-start and start the worker",
);
const connectDisableCommand = lifecycleCommand(
  lifecycleDisable,
  "Stop the worker and pause auto-start across reboots",
);
const connectUninstallServiceCommand = lifecycleCommand(
  uninstallService,
  "Remove the auto-start service and the `vibedeckx` command (keeps data, token and runtime)",
);

const connectInstallServiceCommand = buildCommand({
  parameters: { flags: setupFlags },
  func: async (flags: SetupFlags) =>
    reportDaemonCommandResult(await installService(setupOptionsFromFlags(flags))),
  docs: {
    brief: "Install the worker as a user service (systemd/launchd/Task Scheduler): starts at boot, restarts on crash",
  },
});

// Started by the Windows scheduled task (worker-supervision-design §4.3); not for users.
const connectSuperviseCommand = buildCommand({
  parameters: { flags: connectManagementFlags },
  func: async (flags: { "data-dir": string | undefined }) => {
    if (process.platform !== "win32") {
      return new Error("`connect supervise` is only used by the Windows service; use `connect install` instead");
    }
    process.exit(await runSupervise({ dataDir: resolveDataDir(flags["data-dir"]) }));
  },
  docs: { brief: "Run and restart the worker (used by the Windows scheduled task)" },
});

const connectRoutes = buildRouteMap({
  routes: {
    run: connectCommand,
    setup: connectSetupCommand,
    status: connectStatusCommand,
    start: connectStartCommand,
    stop: connectStopCommand,
    restart: connectRestartCommand,
    enable: connectEnableCommand,
    disable: connectDisableCommand,
    install: connectInstallServiceCommand,
    uninstall: connectUninstallServiceCommand,
    supervise: connectSuperviseCommand,
  },
  defaultCommand: "run",
  docs: {
    brief: "Connect to a Vibedeckx server as an inbound node",
    hideRoute: { supervise: true },
  },
});

const routes = buildRouteMap({
  routes: {
    start: startCommand,
    connect: connectRoutes,
  },
  defaultCommand: "start",
  docs: {
    brief: "Vibedeckx - AI-powered app generator",
  },
});

export const program = buildApplication(routes, {
  name: "vibedeckx",
  versionInfo: {
    currentVersion: readPackageVersion(),
  },
});
