/**
 * CLI invocation contract for the codex binary: the exact flags vibedeckx
 * passes in app-server (interactive session) and exec (one-shot prompt
 * executor) modes.
 */
import type { SpawnConfig } from "../../agent-provider.js";
import type { CrossRemoteMcpConfig } from "../../cross-remote-mcp-config.js";
import { CODEX_NPM_PACKAGE } from "./schema.js";

const CROSS_REMOTE_MCP_TOKEN_ENV = "VIBEDECKX_CROSS_REMOTE_MCP_TOKEN";

export function buildCodexAppServerSpawnConfig(
  nativeBinary: string | null,
  crossRemoteMcp?: CrossRemoteMcpConfig,
): SpawnConfig {
  const args = ["app-server"];
  if (crossRemoteMcp) {
    args.push(
      "-c",
      `mcp_servers.cross-remote={ url = ${JSON.stringify(crossRemoteMcp.url)}, bearer_token_env_var = ${JSON.stringify(CROSS_REMOTE_MCP_TOKEN_ENV)} }`,
    );
  }

  const env = crossRemoteMcp
    ? { [CROSS_REMOTE_MCP_TOKEN_ENV]: crossRemoteMcp.token }
    : undefined;

  if (nativeBinary) {
    return { command: nativeBinary, args, ...(env ? { env } : {}), shell: false };
  }
  return { command: "npx", args: ["-y", CODEX_NPM_PACKAGE, ...args], ...(env ? { env } : {}), shell: false };
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
