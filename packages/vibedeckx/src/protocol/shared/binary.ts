/**
 * Single implementation of CLI binary detection for all agent protocol
 * integrations. Replaces the three copies that previously lived in
 * claude-code-provider.ts, codex-provider.ts, and process-manager.ts.
 */
import { execFileSync } from "child_process";

const pathCache = new Map<string, string | null>();
const versionCache = new Map<string, string | null>();

/** Locate a binary on PATH via which/where. Returns absolute path or null. Cached unless a fresh spawn-time check is requested. */
export function detectBinary(name: string, options?: { refresh?: boolean }): string | null {
  if (!options?.refresh && pathCache.has(name)) {
    return pathCache.get(name)!;
  }
  let found: string | null = null;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, [name], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    found = result || null;
  } catch {
    found = null;
  }
  pathCache.set(name, found);
  console.log(
    found
      ? `[protocol] Native ${name} binary found: ${found}`
      : `[protocol] Native ${name} binary not found on PATH`,
  );
  return found;
}

/**
 * Run `<command> --version` once and cache the trimmed output. Returns null
 * when the probe fails. Used to attribute protocol failures to an agent
 * version in session logs — never gates behavior.
 */
export function getBinaryVersion(command: string): string | null {
  if (versionCache.has(command)) {
    return versionCache.get(command)!;
  }
  let version: string | null = null;
  try {
    const result = execFileSync(command, ["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    version = result || null;
  } catch {
    version = null;
  }
  versionCache.set(command, version);
  return version;
}

/** Test helper: reset module-level caches. */
export function clearBinaryCaches(): void {
  pathCache.clear();
  versionCache.clear();
}
