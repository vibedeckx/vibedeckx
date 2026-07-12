/**
 * CLI invocation contract for the codex binary: the exact flags vibedeckx
 * passes in app-server (interactive session) and exec (one-shot prompt
 * executor) modes.
 */
import type { SpawnConfig } from "../../agent-provider.js";
import { CODEX_NPM_PACKAGE } from "./schema.js";

export function buildCodexAppServerSpawnConfig(nativeBinary: string | null): SpawnConfig {
  if (nativeBinary) {
    return { command: nativeBinary, args: ["app-server"], shell: false };
  }
  return { command: "npx", args: ["-y", CODEX_NPM_PACKAGE, "app-server"], shell: false };
}

/**
 * One-shot prompt executor command (run under a shell/PTY by process-manager).
 * --output-last-message makes codex write the agent's final message to a
 * file, read back on exit as the run's structured report.
 */
export function buildCodexExecCommand(
  nativeBinary: string | null,
  prompt: string,
  outputLastMessageFile?: string,
): string {
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const lastMessageArg = outputLastMessageFile ? ` --output-last-message '${outputLastMessageFile}'` : "";
  const base = nativeBinary ?? `npx -y ${CODEX_NPM_PACKAGE}`;
  return `${base} --dangerously-bypass-approvals-and-sandbox exec '${escapedPrompt}'${lastMessageArg}`;
}
