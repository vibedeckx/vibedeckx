import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { VIBEDECKX_HOME } from "./constants.js";

// Loads a .env file into process.env as a side effect of importing this module.
//
// This MUST run before any other module is imported: several modules capture
// environment variables at module-evaluation time (e.g. server.ts's top-level
// `const API_KEY = process.env.VIBEDECKX_API_KEY`, instrumentation.ts's
// LANGFUSE_* check, browser-proxy-routes.ts's VIBEDECKX_UI_ORIGIN). Loading the
// file later — e.g. inside the CLI command handler — would be too late for those
// captures. Because it runs before stricli parses flags, the env-file path is
// resolved by scanning argv directly rather than via the parsed flags.

/** Read a `--flag value` / `--flag=value` style argument straight from argv. */
function getArg(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`${name}=`));
  if (withEq) return withEq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function resolveEnvFilePath(argv: string[]): { envPath: string; explicit: boolean } {
  const explicit = getArg(argv, "--env-file");
  if (explicit) return { envPath: path.resolve(explicit), explicit: true };

  // Default alongside the data directory so config travels with the DB; falls
  // back to ~/.vibedeckx so the location is stable regardless of launch cwd.
  const dataDir = getArg(argv, "--data-dir");
  const baseDir = dataDir ? path.resolve(dataDir) : VIBEDECKX_HOME;
  return { envPath: path.join(baseDir, ".env"), explicit: false };
}

const { envPath, explicit } = resolveEnvFilePath(process.argv.slice(2));

if (!existsSync(envPath)) {
  // Only complain when the user explicitly pointed at a file; a missing default
  // ~/.vibedeckx/.env is the normal case and should stay quiet.
  if (explicit) {
    console.warn(`Warning: --env-file ${envPath} does not exist; skipping`);
  }
} else {
  try {
    const parsed = parseEnv(readFileSync(envPath, "utf8"));
    const loaded: string[] = [];
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      // Variables already present in the shell environment win over the file,
      // matching standard dotenv semantics — explicit `VAR=… vibedeckx` and
      // exported vars are never silently overridden.
      if (process.env[key] === undefined) {
        process.env[key] = value as string;
        loaded.push(key);
      } else {
        skipped.push(key);
      }
    }
    // Print names only — values are often secrets (API keys, tokens) and must
    // not be written to logs.
    if (loaded.length > 0) {
      console.log(`Loaded ${loaded.length} environment variable${loaded.length === 1 ? "" : "s"} from ${envPath}: ${loaded.join(", ")}`);
    }
    if (skipped.length > 0) {
      console.log(`Kept existing shell value for ${skipped.length} variable${skipped.length === 1 ? "" : "s"} (not overridden by ${envPath}): ${skipped.join(", ")}`);
    }
  } catch (err) {
    console.warn(`Warning: failed to load env file ${envPath}: ${(err as Error).message}`);
  }
}
