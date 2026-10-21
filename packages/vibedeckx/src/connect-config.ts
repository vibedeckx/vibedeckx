import fs from "node:fs";
import path from "node:path";
import { VIBEDECKX_HOME } from "./constants.js";
import { canonicalizeHubUrl } from "./connect-preflight.js";
import { writeFileAtomic } from "./utils/atomic-file.js";

/**
 * Saved connect configuration and credential resolution
 * (worker-supervision-design §3.2).
 *
 * Precedence, highest first: CLI flags > environment > saved config. Two token
 * sources at the same level are an error, never a silent pick.
 */

export const CONNECT_TO_ENV = "VIBEDECKX_CONNECT_TO";
export const CONNECT_TOKEN_ENV = "VIBEDECKX_CONNECT_TOKEN";
export const CONNECT_TOKEN_FILE_ENV = "VIBEDECKX_CONNECT_TOKEN_FILE";
export const DATA_DIR_ENV = "VIBEDECKX_DATA_DIR";
/** Set by generated service definitions and the worker image: "systemd" | "launchd" | "docker". */
export const SUPERVISOR_ENV = "VIBEDECKX_SUPERVISOR";
/** "native-service" | "docker"; anything else (or unset) is a manual install. */
export const INSTALL_MODE_ENV = "VIBEDECKX_INSTALL_MODE";

export type InstallMode = "native-service" | "docker" | "manual";

export function resolveInstallMode(env: NodeJS.ProcessEnv = process.env): InstallMode {
  const raw = env[INSTALL_MODE_ENV];
  return raw === "native-service" || raw === "docker" ? raw : "manual";
}

export function resolveSupervisor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[SUPERVISOR_ENV]?.trim();
  return raw ? raw : undefined;
}

export function resolveDataDir(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = flag ?? env[DATA_DIR_ENV] ?? VIBEDECKX_HOME;
  return path.resolve(raw);
}

export function connectConfigDir(dataDir: string): string {
  return path.join(dataDir, "connect");
}

export function savedConfigPath(dataDir: string): string {
  return path.join(connectConfigDir(dataDir), "config.json");
}

export function savedTokenPath(dataDir: string): string {
  return path.join(connectConfigDir(dataDir), "token");
}

/** Presence = "re-pin on the next successful preflight", written by `setup --force`. */
export function repinRequestPath(dataDir: string): string {
  return path.join(connectConfigDir(dataDir), "repin-requested");
}

export interface SavedConnectConfig {
  schemaVersion: 1;
  connectTo: string;
}

export function readSavedConfig(dataDir: string): SavedConnectConfig | undefined {
  const configPath = savedConfigPath(dataDir);
  let contents: string;
  try {
    contents = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Saved connect config at ${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const config = parsed as Partial<SavedConnectConfig> | null;
  if (
    !config ||
    config.schemaVersion !== 1 ||
    typeof config.connectTo !== "string" ||
    config.connectTo.length === 0
  ) {
    throw new Error(`Saved connect config at ${configPath} is malformed`);
  }
  return { schemaVersion: 1, connectTo: config.connectTo };
}

function ensureConfigDir(dataDir: string): string {
  const directory = connectConfigDir(dataDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  return directory;
}

export function writeSavedConfig(dataDir: string, connectTo: string): void {
  canonicalizeHubUrl(connectTo);
  ensureConfigDir(dataDir);
  const config: SavedConnectConfig = { schemaVersion: 1, connectTo };
  writeFileAtomic(savedConfigPath(dataDir), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function writeSavedToken(dataDir: string, token: string): void {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Connect token is empty");
  if (/\s/.test(trimmed)) throw new Error("Connect token must not contain whitespace");
  ensureConfigDir(dataDir);
  writeFileAtomic(savedTokenPath(dataDir), `${trimmed}\n`, { mode: 0o600, private: true });
}

export function requestRepin(dataDir: string): void {
  ensureConfigDir(dataDir);
  writeFileAtomic(repinRequestPath(dataDir), `${new Date().toISOString()}\n`, {
    mode: 0o600,
  });
}

export function isRepinRequested(dataDir: string): boolean {
  return fs.existsSync(repinRequestPath(dataDir));
}

export function clearRepinRequest(dataDir: string): void {
  fs.rmSync(repinRequestPath(dataDir), { force: true });
}

export type TokenSource =
  | { kind: "literal"; value: string; origin: string }
  | { kind: "file"; path: string; origin: string };

export class TokenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenUnavailableError";
  }
}

/** Read the current token. File sources are re-read on every call. */
export function readToken(source: TokenSource): string {
  if (source.kind === "literal") {
    const value = source.value.trim();
    if (!value) throw new TokenUnavailableError(`Connect token from ${source.origin} is empty`);
    return value;
  }
  let contents: string;
  try {
    contents = fs.readFileSync(source.path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TokenUnavailableError(
      `Cannot read connect token file ${source.path} (${source.origin}): ${reason}`,
    );
  }
  const value = contents.trim();
  if (!value) {
    throw new TokenUnavailableError(
      `Connect token file ${source.path} (${source.origin}) is empty`,
    );
  }
  return value;
}

export interface TokenSourceInputs {
  dataDir: string;
  flagToken?: string;
  flagTokenFile?: string;
  /** Token handed to a --daemon child by its parent; counts as the CLI level. */
  daemonChildToken?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Pick the token source by precedence. Returns undefined when nothing is
 * configured at any level; the caller decides whether that is fatal.
 */
export function resolveTokenSource(inputs: TokenSourceInputs): TokenSource | undefined {
  const env = inputs.env ?? process.env;

  const cliLiteral = inputs.flagToken ?? inputs.daemonChildToken;
  if (cliLiteral !== undefined && inputs.flagTokenFile !== undefined) {
    throw new Error("Use either --token or --token-file, not both");
  }
  if (cliLiteral !== undefined) {
    return { kind: "literal", value: cliLiteral, origin: "--token" };
  }
  if (inputs.flagTokenFile !== undefined) {
    return {
      kind: "file",
      path: path.resolve(inputs.flagTokenFile),
      origin: "--token-file",
    };
  }

  const envToken = env[CONNECT_TOKEN_ENV];
  const envTokenFile = env[CONNECT_TOKEN_FILE_ENV];
  if (envToken !== undefined && envTokenFile !== undefined) {
    throw new Error(
      `Set either ${CONNECT_TOKEN_ENV} or ${CONNECT_TOKEN_FILE_ENV}, not both`,
    );
  }
  if (envToken !== undefined) {
    return { kind: "literal", value: envToken, origin: CONNECT_TOKEN_ENV };
  }
  if (envTokenFile !== undefined) {
    return {
      kind: "file",
      path: path.resolve(envTokenFile),
      origin: CONNECT_TOKEN_FILE_ENV,
    };
  }

  const saved = savedTokenPath(inputs.dataDir);
  if (fs.existsSync(saved)) {
    return { kind: "file", path: saved, origin: "saved config" };
  }
  return undefined;
}

export function resolveConnectTo(inputs: {
  dataDir: string;
  flag?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = inputs.env ?? process.env;
  const raw = inputs.flag ?? env[CONNECT_TO_ENV] ?? readSavedConfig(inputs.dataDir)?.connectTo;
  if (raw === undefined) return undefined;
  canonicalizeHubUrl(raw);
  return raw;
}

export const NOT_CONFIGURED_HINT =
  "Run `vibedeckx connect setup --connect-to <url>` first, or pass --connect-to and --token-file.";
