import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import { createSqliteStorage } from "./storage/sqlite.js";
import { createServer } from "./server.js";
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
    },
  },
  func: async (flags: { port: number | undefined; auth: boolean | undefined }) => {
    const port = flags.port ?? DEFAULT_PORT;
    const authEnabled = flags.auth ?? false;

    console.log("Starting vibedeckx...");

    const storage = await createSqliteStorage(DB_PATH);
    const server = createServer({ storage, authEnabled });

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

const routes = buildRouteMap({
  routes: {
    start: startCommand,
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
