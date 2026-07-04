import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { pino, multistream, type Logger, type Level, type StreamEntry } from "pino";
import pretty from "pino-pretty";
import { createStream, type RotatingFileStream } from "rotating-file-stream";

// Central logging setup. Design doc: docs/superpowers/specs/2026-07-04-logging-design.md
//
// dist/bin.js is a single esbuild bundle, so pino's worker-thread transports
// (which resolve their target by module name at runtime) cannot be used —
// everything here is in-process streams via multistream.

const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

let rootLogger: Logger | undefined;
let fileStream: RotatingFileStream | undefined;
let originalConsole:
  | Pick<Console, "log" | "info" | "warn" | "error" | "debug">
  | undefined;
let crashHandlersInstalled = false;

function resolveLevel(flagLevel: string | undefined): string {
  const requested = flagLevel ?? process.env.VIBEDECKX_LOG_LEVEL;
  if (!requested) return "info";
  if (VALID_LEVELS.has(requested)) return requested;
  console.warn(`Warning: invalid log level "${requested}" (valid: ${[...VALID_LEVELS].join(", ")}); using "info"`);
  return "info";
}

/**
 * Root logger accessor. Before setupLogging runs (unit tests, direct
 * createServer use) this falls back to a plain stdout pino so importing
 * modules never crash.
 */
export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = pino({ level: resolveLevel(undefined) });
  }
  return rootLogger;
}

export interface SetupLoggingOptions {
  /** Base data directory; log files go to <dataDir>/logs/ */
  dataDir: string;
  /** Explicit level (--log-level flag); falls back to VIBEDECKX_LOG_LEVEL, then "info" */
  level?: string;
  /** Install uncaughtException/unhandledRejection fatal-loggers (default true; tests pass false) */
  crashHandlers?: boolean;
}

/**
 * Initialize logging for a server process (both `start` and `connect` commands):
 * pretty human-readable stdout + rotating NDJSON file at <dataDir>/logs/vibedeckx.log,
 * and bridge all console.* calls into the logger so existing call sites need no changes.
 */
export function setupLogging(opts: SetupLoggingOptions): Logger {
  const level = resolveLevel(opts.level);
  const streams: StreamEntry[] = [];

  if (level !== "silent") {
    streams.push({
      level: level as Level,
      stream: pretty({
        destination: 1,
        sync: true,
        colorize: process.stdout.isTTY,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
      }),
    });

    const logsDir = path.join(opts.dataDir, "logs");
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fileStream = createStream("vibedeckx.log", {
        path: logsDir,
        size: "10M",
        interval: "1d",
        maxFiles: 14,
      });
      // Without a handler a stream error (disk full, permissions) would crash
      // the process. Write straight to stderr — going through console would
      // loop back into this very stream via the bridge.
      fileStream.on("error", (err) => {
        process.stderr.write(`[logger] log file error: ${format(err)}\n`);
      });
      streams.push({ level: level as Level, stream: fileStream });
    } catch (err) {
      console.warn(`Warning: cannot create log directory ${logsDir}: ${(err as Error).message}; file logging disabled`);
    }
  }

  rootLogger = pino({ level }, multistream(streams));
  installConsoleBridge(rootLogger);
  if (opts.crashHandlers !== false) installCrashHandlers(rootLogger);
  return rootLogger;
}

/**
 * Route console.* through the logger so all ~355 existing call sites gain
 * levels, timestamps, and file persistence without being touched.
 */
function installConsoleBridge(logger: Logger): void {
  if (!originalConsole) {
    originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
  }
  console.log = (...args: unknown[]) => logger.info(format(...args));
  console.info = (...args: unknown[]) => logger.info(format(...args));
  console.warn = (...args: unknown[]) => logger.warn(format(...args));
  console.error = (...args: unknown[]) => logger.error(format(...args));
  console.debug = (...args: unknown[]) => logger.debug(format(...args));
}

/** Undo installConsoleBridge (tests only). */
export function restoreConsole(): void {
  if (originalConsole) {
    Object.assign(console, originalConsole);
    originalConsole = undefined;
  }
}

function installCrashHandlers(logger: Logger): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  // Preserve crash semantics (process still dies with code 1) while getting
  // the trace into the log file — crashes are exactly the logs worth keeping.
  process.on("uncaughtException", (err) => {
    logger.fatal(err, "Uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason: format(reason) }, "Unhandled rejection");
    process.exit(1);
  });
}

/**
 * Flush and close the rotating file stream. Call right before process.exit
 * on graceful shutdown so the final log lines reach disk; also keeps vitest
 * from hanging on the rotation timer.
 */
export async function shutdownLogging(): Promise<void> {
  const stream = fileStream;
  fileStream = undefined;
  if (!stream) return;
  await new Promise<void>((resolve) => {
    stream.end(() => resolve());
  });
}
