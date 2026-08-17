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
  "Propose a recurring scheduled check to the user. This is the only way to schedule work in this",
  "environment. Call it in either situation:",
  "- The user asks for something recurring — \"every morning\", \"nightly\", \"hourly\", \"on a cron\",",
  "  \"keep an eye on\". Such a request IS this tool; it is not a programming task.",
  "- You are telling the user that something needs periodic follow-up observation — e.g. after a",
  "  fix whose effect can only be confirmed over time, or a flaky failure worth watching.",
  "",
  "Never satisfy a scheduling request by writing a crontab entry, systemd timer, launchd plist, CI",
  "cron trigger, setInterval, or sleep loop: the platform owns execution, and anything you wire up",
  "by hand is invisible to the user and does not survive this session. (Adding scheduling to the",
  "user's OWN product — a cron block in their deployment config, a timer in their app — is still",
  "ordinary coding work. This tool is for scheduling YOUR follow-up runs, not their features.)",
  "",
  "The proposal is shown to the user as a confirmation card; it does NOT create anything by",
  "itself and this call does not wait for the user. Say you have SUGGESTED a scheduled check",
  "(never that you created one) and continue.",
  "",
  "Give EXACTLY ONE of `prompt` or `command`:",
  "- `command` runs a shell command in the project directory. Prefer it when the check is",
  "  mechanical and its output speaks for itself (a test suite, a health request, a disk",
  "  check). It is cheaper and its result is unambiguous.",
  "- `prompt` starts a fresh agent. Use it when the check needs judgement — reading logs,",
  "  comparing behaviour, deciding whether something counts as a regression.",
  "",
  "`prompt` must be self-contained: the scheduled run is a fresh agent with none of this",
  "conversation's context. Spell out what to check, how to tell pass from fail, and what to",
  "write in the report when something regressed. A `command` should likewise be non-interactive",
  "and exit non-zero when the check fails.",
  "",
  "Project, execution target and branch are taken from this session — do not describe them here.",
].join("\n");

/**
 * Server-level `instructions` returned from MCP `initialize`. Claude Code folds
 * these into the system prompt, so they are read even when the model never
 * considers the tool list — which is the actual failure mode: "set up a nightly
 * check" reads as an engineering task, so the agent writes a cron job instead of
 * looking for a tool. Kept short; the tool description carries the detail.
 */
export const SESSION_TOOLS_MCP_INSTRUCTIONS = [
  `\`${PROPOSE_SCHEDULE_TOOL}\` is the only way to schedule work in this environment.`,
  "When the user asks for anything recurring — nightly, hourly, every morning, on a cron, \"keep",
  "watching\" — call it instead of writing a crontab entry, systemd timer, or setInterval loop.",
  "Scheduling inside the user's own product remains ordinary coding work.",
].join("\n");

/**
 * Same rule as a system-prompt append, for CLIs that take one. Belt to the
 * instructions' braces: this lands in context by construction rather than by
 * the CLI's choice to surface server instructions.
 */
export const SESSION_TOOLS_SYSTEM_PROMPT_HINT = [
  "Scheduling: when the user asks you to run something on a schedule (nightly, hourly, every",
  `morning, on a cron, "keep watching"), call the \`${CANONICAL_PROPOSE_SCHEDULE_TOOL}\` tool. That`,
  "is the only way to schedule work here — do not hand-roll a crontab entry, systemd timer, or",
  "setInterval loop for it. Writing scheduling into the user's own project is still normal coding.",
].join(" ");

export const PROPOSE_SCHEDULE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short label for the scheduled check, e.g. \"Watch nightly build flakiness\"" },
    cron_expr: { type: "string", description: "5-field cron expression, e.g. \"0 9 * * *\" for every day at 09:00" },
    prompt: { type: "string", description: "Self-contained instructions for a scheduled agent run. Give this OR command, not both." },
    command: { type: "string", description: "Non-interactive shell command to run for the check, e.g. \"pnpm test --run flaky\". Give this OR prompt, not both." },
    timezone: { type: "string", description: "Optional IANA timezone for the cron expression, e.g. \"Asia/Shanghai\". Defaults to the user's browser timezone." },
  },
  required: ["name", "cron_expr"],
} as const;

export const PROPOSE_SCHEDULE_ACK =
  "Proposal shown to the user as a confirmation card. Nothing has been created yet — the user "
  + "decides whether to accept it, outside this conversation. Tell the user you SUGGESTED a "
  + "scheduled check and that they can confirm it on the card above.";

export interface ProposeScheduleArgs {
  name: string;
  cron_expr: string;
  /** Which kind of run the proposal is for; mirrors ScheduledTask.run_type. */
  run_type: "prompt" | "command";
  /** The agent instructions or the shell command, per run_type. */
  content: string;
  timezone?: string;
}

const NAME_MAX = 200;
const CRON_MAX = 200;
const CONTENT_MAX = 20_000;
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

  // The run kind is derived from which content field was given rather than
  // asked for separately: one field can't contradict the other that way.
  const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : null;
  const command = typeof args.command === "string" && args.command.trim() ? args.command : null;
  if (prompt && command) return { ok: false, error: "give either prompt or command, not both" };
  if (!prompt && !command) return { ok: false, error: "either prompt or command is required" };
  const run_type = prompt ? "prompt" as const : "command" as const;
  const content = (prompt ?? command)!;
  if (content.length > CONTENT_MAX) {
    return { ok: false, error: `${run_type} must be at most ${CONTENT_MAX} characters` };
  }

  const timezone = str(args.timezone) ?? undefined;
  if (timezone && timezone.length > TIMEZONE_MAX) {
    return { ok: false, error: `timezone must be at most ${TIMEZONE_MAX} characters` };
  }

  return { ok: true, value: { name, cron_expr: cronExpr, run_type, content, ...(timezone ? { timezone } : {}) } };
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
