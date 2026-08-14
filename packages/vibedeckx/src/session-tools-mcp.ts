/**
 * Session-scoped MCP tool surface served by the vibedeckx process that spawned
 * the agent — always same-machine loopback (the hub for local sessions, the
 * worker for remote ones, since remote sessions are spawned by the worker's own
 * agent-session-manager). Unlike the cross-remote gateway this never crosses a
 * machine boundary, so it needs no VIBEDECKX_PUBLIC_URL and no tunnel call.
 *
 * Lives outside routes/ so providers and the session manager can import the
 * contract (path, tool names, config shape) without pulling Fastify in.
 * Full design: docs/schedule-proposal-tool-design.md
 */
import type { Storage } from "./storage/types.js";
import { getSessionToolsSecret, signSessionToolsToken } from "./utils/session-tools-token.js";

export const SESSION_TOOLS_MCP_PATH = "/api/session-mcp";

/** MCP server name as declared to the CLIs; part of Claude's reported tool name. */
export const SESSION_TOOLS_MCP_SERVER_NAME = "vibedeckx";

/** Bare tool name as declared over MCP. */
export const PROPOSE_SCHEDULE_TOOL = "propose_schedule";

/**
 * The one name the frontend matches on. Claude Code reports MCP tools in
 * exactly this shape; the Codex provider normalizes onto it (see
 * canonicalizeSessionToolName) so a single card branch serves both.
 */
export const CANONICAL_PROPOSE_SCHEDULE_TOOL = `mcp__${SESSION_TOOLS_MCP_SERVER_NAME}__${PROPOSE_SCHEDULE_TOOL}`;

export interface SessionToolsMcpConfig {
  url: string;
  token: string;
}

export const PROPOSE_SCHEDULE_DESCRIPTION = [
  "Propose a recurring scheduled check to the user. Call this when you tell the user that",
  "something needs periodic follow-up observation — e.g. after a fix whose effect can only be",
  "confirmed over time, or a flaky failure worth watching.",
  "",
  "The proposal is shown to the user as a confirmation card; it does NOT create anything by",
  "itself and this call does not wait for the user. Say you have SUGGESTED a scheduled check",
  "(never that you created one) and continue.",
  "",
  "`prompt` must be self-contained: the scheduled run is a fresh agent with none of this",
  "conversation's context. Spell out what to check, how to tell pass from fail, and what to",
  "write in the report when something regressed.",
  "",
  "Project, execution target and branch are taken from this session — do not describe them here.",
].join("\n");

export const PROPOSE_SCHEDULE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short label for the scheduled check, e.g. \"Watch nightly build flakiness\"" },
    cron_expr: { type: "string", description: "5-field cron expression, e.g. \"0 9 * * *\" for every day at 09:00" },
    prompt: { type: "string", description: "Self-contained instructions for the scheduled agent run" },
    timezone: { type: "string", description: "Optional IANA timezone for the cron expression, e.g. \"Asia/Shanghai\". Defaults to the user's browser timezone." },
  },
  required: ["name", "cron_expr", "prompt"],
} as const;

export const PROPOSE_SCHEDULE_ACK =
  "Proposal shown to the user as a confirmation card. Nothing has been created yet — the user "
  + "decides whether to accept it, outside this conversation. Tell the user you SUGGESTED a "
  + "scheduled check and that they can confirm it on the card above.";

export interface ProposeScheduleArgs {
  name: string;
  cron_expr: string;
  prompt: string;
  timezone?: string;
}

const NAME_MAX = 200;
const CRON_MAX = 200;
const PROMPT_MAX = 20_000;
const TIMEZONE_MAX = 100;

const str = (value: unknown): string | null => (typeof value === "string" ? value.trim() : null);

/**
 * Shape validation only — cron/timezone semantics are checked by the caller
 * (which owns the croner dependency), so this module stays importable from the
 * provider layer.
 */
export function parseProposeScheduleArgs(
  args: Record<string, unknown>,
): { ok: true; value: ProposeScheduleArgs } | { ok: false; error: string } {
  const name = str(args.name);
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > NAME_MAX) return { ok: false, error: `name must be at most ${NAME_MAX} characters` };

  const cronExpr = str(args.cron_expr);
  if (!cronExpr) return { ok: false, error: "cron_expr is required" };
  if (cronExpr.length > CRON_MAX) return { ok: false, error: `cron_expr must be at most ${CRON_MAX} characters` };

  const prompt = typeof args.prompt === "string" ? args.prompt : null;
  if (!prompt?.trim()) return { ok: false, error: "prompt is required" };
  if (prompt.length > PROMPT_MAX) return { ok: false, error: `prompt must be at most ${PROMPT_MAX} characters` };

  const timezone = str(args.timezone) ?? undefined;
  if (timezone && timezone.length > TIMEZONE_MAX) {
    return { ok: false, error: `timezone must be at most ${TIMEZONE_MAX} characters` };
  }

  return { ok: true, value: { name, cron_expr: cronExpr, prompt, ...(timezone ? { timezone } : {}) } };
}

/**
 * Every shape the two CLIs are known to report our MCP tool under, mapped onto
 * the canonical name. Claude Code prefixes `mcp__<server>__`. Codex (verified
 * against codex-cli 0.147.0 by the CX-SM1 live probe, fixture
 * protocol/codex/__fixtures__/session-mcp-tool-call.jsonl) reports the bare
 * tool name with the server in its own field; the qualified spellings are
 * tolerated in case that changes. An unrecognized shape simply renders as an
 * ordinary tool call instead of a card.
 */
const PROPOSE_SCHEDULE_ALIASES = new Set(
  [
    PROPOSE_SCHEDULE_TOOL,
    CANONICAL_PROPOSE_SCHEDULE_TOOL,
    `${SESSION_TOOLS_MCP_SERVER_NAME}.${PROPOSE_SCHEDULE_TOOL}`,
    `${SESSION_TOOLS_MCP_SERVER_NAME}/${PROPOSE_SCHEDULE_TOOL}`,
    `${SESSION_TOOLS_MCP_SERVER_NAME}__${PROPOSE_SCHEDULE_TOOL}`,
    `${SESSION_TOOLS_MCP_SERVER_NAME}-${PROPOSE_SCHEDULE_TOOL}`,
  ].map((n) => n.toLowerCase()),
);

/**
 * Normalizes a provider-reported MCP tool name onto the canonical name the UI
 * matches. Returns the input unchanged when it isn't one of our tools.
 *
 * `server` is the reporting MCP server when the provider names it separately
 * (Codex does). Given one, it decides: a bare `propose_schedule` from someone
 * else's server is left alone rather than dressed up as ours.
 */
export function canonicalizeSessionToolName(tool: string, server?: string): string {
  if (server !== undefined && server.trim().toLowerCase() !== SESSION_TOOLS_MCP_SERVER_NAME) return tool;
  return PROPOSE_SCHEDULE_ALIASES.has(tool.trim().toLowerCase())
    ? CANONICAL_PROPOSE_SCHEDULE_TOOL
    : tool;
}

/**
 * Mints a session-scoped bearer token for the loopback endpoint. `origin` is
 * the local base URL of the process that is about to spawn the agent; when it
 * is unknown (server not listening yet) or not plain http (TLS-terminated
 * locally — a loopback https URL cannot pass hostname verification against a
 * public certificate), no config is minted and the tool is simply absent.
 */
export async function mintSessionToolsMcpConfig(
  deps: { storage: Pick<Storage, "settings"> },
  args: { sessionId: string; origin: string | null },
): Promise<SessionToolsMcpConfig | undefined> {
  const origin = args.origin?.trim();
  if (!origin || !origin.startsWith("http://")) return undefined;
  if (!args.sessionId) return undefined;

  const secret = await getSessionToolsSecret(deps.storage);
  const token = signSessionToolsToken(secret, { sessionId: args.sessionId }, Date.now());
  return { url: `${origin.replace(/\/+$/, "")}${SESSION_TOOLS_MCP_PATH}`, token };
}
