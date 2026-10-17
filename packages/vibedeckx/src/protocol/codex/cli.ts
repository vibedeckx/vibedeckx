/**
 * CLI invocation contract for the codex binary: the exact flags vibedeckx
 * passes in app-server (interactive session) and exec (one-shot prompt
 * executor) modes.
 */
import type { SpawnConfig } from "../../agent-provider.js";
import type { CrossRemoteMcpConfig } from "../../cross-remote-mcp-config.js";
import { SESSION_TOOLS_MCP_SERVER_NAME, type SessionToolsMcpConfig } from "../../session-tools-mcp.js";
import { CODEX_NPM_PACKAGE } from "./schema.js";

const CROSS_REMOTE_MCP_TOKEN_ENV = "VIBEDECKX_CROSS_REMOTE_MCP_TOKEN";
const SESSION_TOOLS_MCP_TOKEN_ENV = "VIBEDECKX_SESSION_MCP_TOKEN";

/** `-c mcp_servers.<name>={…}` — TOML inline table; JSON.stringify yields valid TOML basic strings. */
const mcpServerOverride = (name: string, url: string, tokenEnvVar: string): string =>
  `mcp_servers.${name}={ url = ${JSON.stringify(url)}, bearer_token_env_var = ${JSON.stringify(tokenEnvVar)}, default_tools_approval_mode = "approve" }`;

export function buildCodexAppServerSpawnConfig(
  nativeBinary: string | null,
  crossRemoteMcp?: CrossRemoteMcpConfig,
  model?: string | null,
  sessionToolsMcp?: SessionToolsMcpConfig,
): SpawnConfig {
  const args = ["app-server"];

  // codex app-server has no --model flag; the model is set through the same
  // generic `-c <toml-assignment>` override used for MCP servers below.
  // JSON.stringify produces a valid TOML basic string (double-quoted, with
  // inner quotes and backslashes escaped). One app-server process serves
  // exactly one session, so a process-wide override cannot leak across
  // sessions.
  if (model && model.trim()) {
    args.push("-c", `model=${JSON.stringify(model.trim())}`);
  }

  if (crossRemoteMcp) {
    args.push("-c", mcpServerOverride("cross-remote", crossRemoteMcp.url, CROSS_REMOTE_MCP_TOKEN_ENV));
  }

  if (sessionToolsMcp) {
    args.push(
      "-c",
      mcpServerOverride(SESSION_TOOLS_MCP_SERVER_NAME, sessionToolsMcp.url, SESSION_TOOLS_MCP_TOKEN_ENV),
    );
  }

  const env: Record<string, string> = {};
  if (crossRemoteMcp) env[CROSS_REMOTE_MCP_TOKEN_ENV] = crossRemoteMcp.token;
  if (sessionToolsMcp) env[SESSION_TOOLS_MCP_TOKEN_ENV] = sessionToolsMcp.token;
  const hasEnv = Object.keys(env).length > 0;

  if (nativeBinary) {
    return { command: nativeBinary, args, ...(hasEnv ? { env } : {}), shell: false };
  }
  return { command: "npx", args: ["-y", CODEX_NPM_PACKAGE, ...args], ...(hasEnv ? { env } : {}), shell: false };
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
