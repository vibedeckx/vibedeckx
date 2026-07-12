/**
 * CLI invocation contract for the claude binary: interactive session mode,
 * one-shot stream-json executor mode, and -p print mode.
 */
import type { SpawnConfig } from "../../agent-provider.js";
import { CLAUDE_NPM_PACKAGE } from "./schema.js";

const STREAM_JSON_ARGS = ["--output-format=stream-json", "--input-format=stream-json"] as const;

function withNpxFallback(nativeBinary: string | null, args: string[]): SpawnConfig {
  if (nativeBinary) {
    return { command: nativeBinary, args };
  }
  return { command: "npx", args: ["-y", CLAUDE_NPM_PACKAGE, ...args] };
}

/** Interactive agent session (agent-session-manager). */
export function buildClaudeSessionSpawnConfig(
  nativeBinary: string | null,
  permissionMode: "plan" | "edit",
  mcpConfigArg?: string,
): SpawnConfig {
  const permissionFlag = permissionMode === "plan"
    ? "--permission-mode=plan"
    : "--dangerously-skip-permissions";

  const args = [
    ...STREAM_JSON_ARGS,
    permissionFlag,
    // AskUserQuestion can't work over piped (non-TTY) stdin: claude resolves it
    // internally as "dismissed" before we can present a picker and wait for the
    // user. Disable it so the agent falls back to asking in plain text, which the
    // user answers through the normal conversation input.
    "--disallowedTools",
    "AskUserQuestion",
    "--verbose",
  ];

  if (mcpConfigArg) {
    args.push("--mcp-config", mcpConfigArg);
  }

  return withNpxFallback(nativeBinary, args);
}

/** One-shot prompt executor in stream-json mode (process-manager). */
export function buildClaudeStreamExecutorSpawn(nativeBinary: string | null): SpawnConfig {
  return withNpxFallback(nativeBinary, [...STREAM_JSON_ARGS, "--dangerously-skip-permissions", "--verbose"]);
}

/** One-shot -p print-mode shell command (process-manager PTY path). */
export function buildClaudePrintCommand(nativeBinary: string | null, prompt: string): string {
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const base = nativeBinary ?? `npx -y ${CLAUDE_NPM_PACKAGE}`;
  return `${base} -p '${escapedPrompt}' --dangerously-skip-permissions --verbose`;
}
