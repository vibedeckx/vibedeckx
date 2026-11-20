import type { SpawnConfig } from "../../agent-provider.js";
import type { PipedRunSpec } from "../shared/piped-run.js";

export function buildFxSpawnConfig(binary: string | null, model?: string | null): SpawnConfig {
  // Process-local override (fx >= 0.0.17); global settings are untouched. The
  // handshake still verifies the mode that fx actually started in.
  const args = ["acp", "--permission-mode", "full-access"];
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
