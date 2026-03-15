import path from "node:path";
import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import { createSqliteStorage } from "./storage/sqlite.js";
import { createServer } from "./server.js";
import { ReverseConnectClient } from "./reverse-connect-client.js";
import { DB_PATH, DEFAULT_PORT } from "./constants.js";
import open from "open";

const startCommand = buildCommand({
  parameters: {
    flags: {
      port: {
        kind: "parsed",
        parse: parseInt,
        brief: "Port to run the server on",
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
    },
  },
  func: async (flags: { port: number | undefined; auth: boolean | undefined; "data-dir": string | undefined }) => {
    const port = flags.port ?? DEFAULT_PORT;
    const authEnabled = flags.auth ?? false;

    console.log("Starting vibedeckx...");

    const dbPath = flags["data-dir"]
      ? path.join(flags["data-dir"], "data.sqlite")
      : DB_PATH;
    const storage = await createSqliteStorage(dbPath);
    const server = await createServer({ storage, authEnabled });

    const url = await server.start(port);
    console.log(`Server running at ${url}`);

    // 打开浏览器
    await open(url);

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
        storage.close();
      } catch (err) {
        console.error("Error during shutdown:", err);
      }
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
    },
  },
  func: async (flags: { "connect-to": string; token: string; port: number | undefined; "data-dir": string | undefined }) => {
    const localPort = flags.port ?? DEFAULT_PORT;

    console.log("Starting vibedeckx in reverse-connect mode...");

    const dbPath = flags["data-dir"]
      ? path.join(flags["data-dir"], "data.sqlite")
      : DB_PATH;
    const storage = await createSqliteStorage(dbPath);
    const server = await createServer({ storage });

    // Start local server on localhost only (not publicly exposed)
    const { instance } = await server.startLocal(localPort);
    console.log(`Local server running on 127.0.0.1:${localPort}`);

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
        storage.close();
      } catch (err) {
        console.error("Error during shutdown:", err);
      }
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
