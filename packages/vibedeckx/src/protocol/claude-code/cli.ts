/**
 * CLI invocation contract for the claude binary: interactive session mode,
 * one-shot stream-json executor mode, and -p print mode.
 */
import type { SpawnConfig } from "../../agent-provider.js";
import type { LineProbe } from "../shared/line-probe.js";
import { CLAUDE_NPM_PACKAGE, ClaudeInitializeModelsSchema } from "./schema.js";

const STREAM_JSON_ARGS = ["--output-format=stream-json", "--input-format=stream-json"] as const;

export interface ClaudeHttpMcpServer {
  url: string;
  token: string;
}

/**
 * Serializes `--mcp-config`'s JSON for a set of bearer-authenticated HTTP MCP
 * servers, keyed by the server name the CLI reports tools under
 * (`mcp__<name>__<tool>`).
 */
export function buildClaudeMcpConfigArg(servers: Record<string, ClaudeHttpMcpServer>): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, { url, token }]) => [
        name,
        { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
      ]),
    ),
  });
}

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
  model?: string | null,
  allowedTools?: string[],
  appendSystemPrompt?: string,
): SpawnConfig {
  const permissionFlag = permissionMode === "plan"
    ? "--permission-mode=plan"
    : "--dangerously-skip-permissions";

  const args = [
    ...STREAM_JSON_ARGS,
    permissionFlag,
  ];

  // Unvalidated by design: an alias ("opus"), a full id, or a typo all get
  // passed straight through. claude exits 1 with its own message on stdout if
  // it doesn't recognize the name — see the startup-failure path in
  // agent-session-manager.
  if (model && model.trim()) {
    args.push("--model", model.trim());
  }

  args.push(
    // AskUserQuestion can't work over piped (non-TTY) stdin: claude resolves it
    // internally as "dismissed" before we can present a picker and wait for the
    // user. Disable it so the agent falls back to asking in plain text, which the
    // user answers through the normal conversation input.
    "--disallowedTools",
    "AskUserQuestion",
    "--verbose",
  );

  if (mcpConfigArg) {
    args.push("--mcp-config", mcpConfigArg);
  }

  // An allowlist, not a restriction: named tools skip the permission prompt,
  // everything else keeps the mode's default handling. Needed so vibedeckx's
  // own MCP tools don't stall on a prompt in plan mode (edit mode already runs
  // with --dangerously-skip-permissions).
  if (allowedTools?.length) {
    args.push("--allowedTools", allowedTools.join(","));
  }

  // Appended, not replacing: the default system prompt still applies. Used to
  // state routing rules the model would otherwise have to infer from a tool
  // description it never reads (see SESSION_TOOLS_SYSTEM_PROMPT_HINT).
  if (appendSystemPrompt?.trim()) {
    args.push("--append-system-prompt", appendSystemPrompt.trim());
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

const MODELS_REQUEST_ID = "vibedeckx-models";

/**
 * Reads the model catalog from the `initialize` control handshake: no prompt
 * is sent, so no model is called. "default" is dropped — the picker's own
 * Default (no --model) already means the same thing.
 */
export function buildClaudeModelsProbe(nativeBinary: string | null, timeoutMs: number): { config: SpawnConfig; probe: LineProbe<string[]> } {
  return {
    config: withNpxFallback(nativeBinary, [...STREAM_JSON_ARGS, "--verbose"]),
    probe: {
      initial: [JSON.stringify({ type: "control_request", request_id: MODELS_REQUEST_ID, request: { subtype: "initialize" } }) + "\n"],
      onLine: (line) => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { return; }
        if ((value as { type?: unknown })?.type !== "control_response") return;
        const parsed = ClaudeInitializeModelsSchema.parse(value);
        if (parsed.response.request_id !== MODELS_REQUEST_ID) return;
        const models = parsed.response.response.models.map((m) => m.value.trim()).filter((m) => m && m !== "default");
        return { done: [...new Set(models)] };
      },
      timeoutMs,
    },
  };
}
