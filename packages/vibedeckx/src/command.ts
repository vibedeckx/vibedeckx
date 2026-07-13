import fs from "node:fs";
import path from "node:path";
import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import { createSqliteStorage } from "./storage/sqlite.js";
import { createServer, type TLSOptions } from "./server.js";
import { resolveUiRoot } from "./ui-root.js";
import { ReverseConnectClient } from "./reverse-connect-client.js";
import { DEFAULT_PORT, VIBEDECKX_HOME } from "./constants.js";
import { setupLogging, shutdownLogging } from "./logger.js";
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
        brief: "Network interface to bind (default: 127.0.0.1, loopback only). Use 0.0.0.0 to expose on all interfaces — only do so behind --auth, VIBEDECKX_API_KEY, or a trusted tunnel/proxy.",
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
      "accept-remote": {
        kind: "boolean",
        brief: "Allow other vibedeckx servers to use this instance as a remote provider (exposes /api/path/*, /api/browse, /api/execute-one-shot)",
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
    "accept-remote": boolean | undefined;
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
    const acceptRemote = flags["accept-remote"] ?? false;
    const noLocalProjects = flags["no-local-projects"] ?? false;
    const tls = loadTLSOptions(flags);

    // Binding beyond loopback puts the (per-route-unauthenticated) executor API
    // on the network. Without --auth or an API key, anyone who can reach the
    // host can run commands. Warn rather than refuse — a trusted tunnel/proxy in
    // front is a legitimate setup, but the operator should know it's open.
    const isLoopbackHost =
      host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!isLoopbackHost && !authEnabled && !process.env.VIBEDECKX_API_KEY) {
      console.warn(
        `Warning: binding to ${host} exposes vibedeckx on the network with no authentication.\n` +
        "Anyone who can reach this host can run commands via the executor API. Enable --auth or\n" +
        "set VIBEDECKX_API_KEY, or keep the default loopback bind (127.0.0.1) behind a trusted tunnel/proxy."
      );
    }

    // --accept-remote exposes the path-based provider surface (/api/path/*,
    // /api/browse, /api/mkdir, /api/execute-one-shot). Those routes do privileged
    // work — including writing commands into a PTY via /api/path/terminals — and
    // are NOT individually authenticated; they rely entirely on the global API-key
    // hook, which is a no-op when VIBEDECKX_API_KEY is unset. Clerk (--auth) does
    // not cover them either, since they never call requireAuth. Accepting remotes
    // only makes sense when reachable over the network (typically paired with
    // --host 0.0.0.0), so without an API key it's unauthenticated RCE — and even on
    // loopback, other local users shouldn't get an unauthenticated provider surface.
    // Refuse to boot in that configuration. (Reverse-connect mode is unaffected: it
    // binds 127.0.0.1 behind a token-authenticated tunnel and never enters this command.)
    if (acceptRemote && !process.env.VIBEDECKX_API_KEY) {
      console.error(
        "Error: --accept-remote requires VIBEDECKX_API_KEY to be set.\n" +
        "It exposes privileged path-based endpoints (/api/path/*, /api/browse, /api/execute-one-shot)\n" +
        "to the network without per-route authentication. Set VIBEDECKX_API_KEY so callers must\n" +
        "present a matching x-vibedeckx-api-key header."
      );
      process.exit(1);
    }

    console.log(`Starting vibedeckx${acceptRemote ? " (accepting remote clients)" : ""}${tls ? " (HTTPS)" : ""}...`);

    const uiRoot = await resolveUiRoot({ uiDir: flags["ui-dir"], noUi: flags["no-ui"] });

    const dbPath = path.join(dataDir, "data.sqlite");
    const storage = await createSqliteStorage(dbPath);
    const server = await createServer({ storage, authEnabled, acceptRemote, noLocalProjects, tls, uiRoot });

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

const connectCommand = buildCommand({
  parameters: {
    flags: {
      "connect-to": {
        kind: "parsed",
        parse: String,
        brief: "URL of the Vibedeckx server to connect to",
      },
      token: {
        kind: "parsed",
        parse: String,
        brief: "Authentication token for the reverse connection",
      },
      port: {
        kind: "parsed",
        parse: parseInt,
        brief: "Local port for the server (default: 5173)",
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
      "log-level": {
        kind: "parsed",
        parse: String,
        brief: "Log level: trace, debug, info, warn, error, fatal, silent (default: info). Env: VIBEDECKX_LOG_LEVEL. Logs are written to <data-dir>/logs/ with daily/10MB rotation.",
        optional: true,
      },
    },
  },
  func: async (flags: { "connect-to": string; token: string; port: number | undefined; "data-dir": string | undefined; "env-file": string | undefined; "log-level": string | undefined }) => {
    const dataDir = flags["data-dir"] ?? VIBEDECKX_HOME;
    setupLogging({ dataDir, level: flags["log-level"] });

    const requestedPort = flags.port ?? 0;

    console.log("Starting vibedeckx in reverse-connect mode...");

    const dbPath = path.join(dataDir, "data.sqlite");
    const storage = await createSqliteStorage(dbPath);
    // Reverse-connect mode is inherently a remote-provider role: the inbound
    // server proxies requests through the tunnel into this instance, so the
    // path-based endpoints must be exposed. The UI is served by the upstream
    // server, never through the tunnel — run API-only so the lean npm install
    // (no dist/ui) works without downloading anything.
    const server = await createServer({ storage, acceptRemote: true, uiRoot: null });

    // Start local server on localhost only (not publicly exposed)
    // Port 0 lets the OS pick a random available port
    const { instance, port: localPort } = await server.startLocal(requestedPort);
    console.log(`Local server running on 127.0.0.1:${localPort}`);

    // Reverse-connect mode: the upstream vibedeckx server runs
    // generateAndPushRemoteSessionTitle and PATCHes the resulting title back
    // here, so locally generating one would waste tokens and emit a
    // duplicate Langfuse trace with userId="local".
    instance.agentSessionManager.suppressTitleGeneration = true;

    // Create and start the reverse-connect client
    const client = new ReverseConnectClient(instance, flags["connect-to"], flags.token, localPort);
    client.connect();

    console.log(`Connecting to ${flags["connect-to"]}...`);

    // Graceful shutdown
    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) {
        console.log("\nForce exiting...");
        process.exit(1);
      }
      shuttingDown = true;
      console.log("\nShutting down...");

      const forceExit = setTimeout(() => {
        console.log("Shutdown timed out, force exiting...");
        process.exit(1);
      }, 5000);
      forceExit.unref();

      try {
        client.shutdown();
        await server.close();
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
    brief: "Connect to a remote Vibedeckx server as an inbound node",
  },
});

const routes = buildRouteMap({
  routes: {
    start: startCommand,
    connect: connectCommand,
  },
  defaultCommand: "start",
  docs: {
    brief: "Vibedeckx - AI-powered app generator",
  },
});

export const program = buildApplication(routes, {
  name: "vibedeckx",
  versionInfo: {
    currentVersion: "0.1.0",
  },
});
