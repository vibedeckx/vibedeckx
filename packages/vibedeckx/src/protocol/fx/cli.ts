import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { SpawnConfig } from "../../agent-provider.js";
import type { PipedRunSpec } from "../shared/piped-run.js";

const permissionOverrideCache = new Map<string, { fingerprint: string; supported: boolean }>();

/** Probe ACP itself: interactive flags are not necessarily supported by ACP. */
export function supportsFxPermissionOverride(binary: string): boolean {
  let fingerprint = binary;
  try {
    const stat = statSync(binary);
    fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { /* Missing binaries still get the usual spawn failure. */ }
  const cached = permissionOverrideCache.get(binary);
  if (cached?.fingerprint === fingerprint) return cached.supported;
  let supported = false;
  try {
    const help = execFileSync(binary, ["acp", "--help"], {
      encoding: "utf8", timeout: 5000, env: { ...process.env, FX_AUTO_UPGRADE: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supported = /--permission-mode\s+<mode>/.test(help);
  } catch { /* Handshake validates the starting mode when probing fails. */ }
  permissionOverrideCache.set(binary, { fingerprint, supported });
  return supported;
}

export function buildFxSpawnConfig(binary: string | null, model?: string | null): SpawnConfig {
  const args = ["acp"];
  // 0.0.17 supports a process-local override. 0.0.16 does not: its native
  // starting mode is checked in the handshake, without writing global settings.
  if (binary && supportsFxPermissionOverride(binary)) args.push("--permission-mode", "full-access");
  if (model?.trim()) args.push("--model", model.trim());
  // Use the original profile and its credential locks. Never copy refresh tokens.
  return { command: binary ?? "fx", args, env: { FX_AUTO_UPGRADE: "0" }, shell: false };
}

/**
 * Unattended requests use full-access, matching interactive fx sessions and the
 * Claude / Codex executors: no tool call may wait for (or fail on) an approval
 * that nobody can give. Request-local flag; global settings are untouched.
 */
export function buildFxAskSpawnConfig(binary: string | null, prompt: string): SpawnConfig {
  return {
    command: binary ?? "fx",
    args: ["ask", "--permission-mode", "full-access", "--json", "--", prompt],
    env: { FX_AUTO_UPGRADE: "0" },
    shell: false,
  };
}

/** ask emits one final JSON object, not ACP or a JSONL event stream. */
export function parseFxAskResult(stdout: string): { output: string; finalResult?: string; exitCode: number } {
  const value = JSON.parse(stdout);
  if (!value || typeof value.output !== "string" || typeof value.final_output !== "string"
    || !Number.isInteger(value.exit_code) || value.exit_code < 0 || value.exit_code > 2) {
    throw new Error("Invalid fx ask result");
  }
  return { output: value.output, finalResult: value.final_output || undefined, exitCode: value.exit_code };
}

/**
 * An unattended `fx ask` executor run. stdout carries one JSON object at exit,
 * so it is buffered and settled in finish(); stderr is live progress.
 */
export function buildFxAskRun(binary: string | null, prompt: string): PipedRunSpec {
  const config = buildFxAskSpawnConfig(binary, prompt);
  let stdout = "";
  return {
    command: config.command,
    args: config.args,
    shell: false,
    env: config.env,
    // No interactive approval: a request that needs one must fail, not hang.
    stdin: null,
    decoder: {
      stdout: (chunk) => { stdout += chunk; return undefined; },
      stderr: (chunk) => chunk,
      finish: ({ code, stopped }) => {
        const exitCode = code ?? 1;
        try {
          const result = parseFxAskResult(stdout);
          return { output: result.output || undefined, finalResult: result.finalResult, exitCode: exitCode === 0 ? result.exitCode : exitCode };
        } catch {
          // A stopped run is expected to end without its final JSON.
          return {
            error: stopped ? undefined : "fx ask did not return a valid final JSON result.\n",
            exitCode: exitCode === 0 ? 1 : exitCode,
          };
        } finally {
          stdout = "";
        }
      },
    },
  };
}
