/**
 * The `vibedeckx` MCP server every agent session gets: proposals (schedule,
 * task, task update) and reads of the session's project tasks. Always served
 * by the HUB — tasks live only in its storage. A local session reaches it on
 * the hub's loopback; a remote session's agent runs on a worker, so it reaches
 * it over VIBEDECKX_PUBLIC_URL with a hub-signed token the hub hands the worker
 * (create/start/activate/branch bodies, refreshed on every forwarded message).
 *
 * Lives outside routes/ so providers and the session manager can import the
 * contract (path, tool names, config shape) without pulling Fastify in.
 * Full design: docs/schedule-proposal-tool-design.md
 */
import type { Storage, TaskPriority, TaskStatus } from "./storage/types.js";
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

/** Bare name of the record-for-later tool: proposes project tasks for the user to confirm. */
export const PROPOSE_TASK_TOOL = "propose_task";

export const CANONICAL_PROPOSE_TASK_TOOL = `mcp__${SESSION_TOOLS_MCP_SERVER_NAME}__${PROPOSE_TASK_TOOL}`;

/** Reads of the session's project task list, and the update-proposal card. */
export const LIST_TASKS_TOOL = "list_tasks";
export const GET_TASK_TOOL = "get_task";
export const PROPOSE_TASK_UPDATE_TOOL = "propose_task_update";
export const CANONICAL_LIST_TASKS_TOOL = `mcp__${SESSION_TOOLS_MCP_SERVER_NAME}__${LIST_TASKS_TOOL}`;
export const CANONICAL_GET_TASK_TOOL = `mcp__${SESSION_TOOLS_MCP_SERVER_NAME}__${GET_TASK_TOOL}`;
export const CANONICAL_PROPOSE_TASK_UPDATE_TOOL = `mcp__${SESSION_TOOLS_MCP_SERVER_NAME}__${PROPOSE_TASK_UPDATE_TOOL}`;

/** The two tools that need no task data — all a worker's fallback endpoint serves. */
export const SESSION_TOOLS_PROPOSAL_NAMES = [CANONICAL_PROPOSE_SCHEDULE_TOOL, CANONICAL_PROPOSE_TASK_TOOL] as const;

/** Every tool the hub offers, as Claude reports them — the plan-mode allowlist. */
export const SESSION_TOOLS_CANONICAL_NAMES = [
  ...SESSION_TOOLS_PROPOSAL_NAMES,
  CANONICAL_LIST_TASKS_TOOL,
  CANONICAL_GET_TASK_TOOL,
  CANONICAL_PROPOSE_TASK_UPDATE_TOOL,
] as const;

export interface SessionToolsMcpConfig {
  url: string;
  token: string;
  /**
   * Set on the worker's own fallback config: the worker serves only the two
   * proposals (it has no task data), so the agent is told about only those.
   * See AgentSessionManager.sessionToolsMcpFor.
   */
  proposalsOnly?: boolean;
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
 * Soft guidance only — the conversation links any absolute path the agent
 * mentions regardless (see FileRefLink), this just makes the path more likely
 * to come out complete and on its own line instead of buried mid-sentence.
 */
export const ARTIFACT_PATH_HINT =
  "Files for the user to look at: when you produce a screenshot, image, or report file for "
  + "the user, write its absolute path on its own line in your reply so it can be previewed.";

/**
 * Shared by the instructions and the system-prompt hint. Only routes an explicit
 * request: the agent must neither propose tasks unprompted nor remind the user
 * that it could. Agents already list leftover work at the end of a turn; a
 * "you could make this a task" nudge would only add noise to most replies.
 */
const TASK_ROUTING_HINT =
  `Tasks: when the user asks to record something as a task or to-do for later, call \`${CANONICAL_PROPOSE_TASK_TOOL}\``
  + " to propose it, and do not do the work itself now. Never call it, or suggest creating a task, unless the user asks.";

const TASK_DATA_HINT =
  ` \`${CANONICAL_LIST_TASKS_TOOL}\` and \`${CANONICAL_GET_TASK_TOOL}\` read the project's existing tasks; use them`
  + " when the user refers to existing tasks, and before proposing new ones so you don't duplicate one."
  + ` To change existing tasks (status, priority, title, description), call \`${CANONICAL_PROPOSE_TASK_UPDATE_TOOL}\``
  + " when the user asks; the user confirms each change on a card. Never claim you created or updated a task."
  + " When you mention an existing task to the user, link it as [title](#ref:task:<id>) so they can open it.";

/**
 * Server-level `instructions` returned from MCP `initialize`. Claude Code folds
 * these into the system prompt, so they are read even when the model never
 * considers the tool list — which is the actual failure mode: "set up a nightly
 * check" reads as an engineering task, so the agent writes a cron job instead of
 * looking for a tool. Kept short; the tool description carries the detail.
 */
export function sessionToolsInstructions(proposalsOnly = false): string {
  return [
    `\`${PROPOSE_SCHEDULE_TOOL}\` is the only way to schedule work in this environment.`,
    "When the user asks for anything recurring — nightly, hourly, every morning, on a cron, \"keep",
    "watching\" — call it instead of writing a crontab entry, systemd timer, or setInterval loop.",
    "Scheduling inside the user's own product remains ordinary coding work.",
    "",
    proposalsOnly ? TASK_ROUTING_HINT : TASK_ROUTING_HINT + TASK_DATA_HINT,
    "",
    ARTIFACT_PATH_HINT,
  ].join("\n");
}

export const SESSION_TOOLS_MCP_INSTRUCTIONS = sessionToolsInstructions();

/**
 * Same rule as a system-prompt append, for CLIs that take one. Belt to the
 * instructions' braces: this lands in context by construction rather than by
 * the CLI's choice to surface server instructions.
 */
export function sessionToolsSystemPromptHint(proposalsOnly = false): string {
  return [
    "Scheduling: when the user asks you to run something on a schedule (nightly, hourly, every",
    `morning, on a cron, "keep watching"), call the \`${CANONICAL_PROPOSE_SCHEDULE_TOOL}\` tool. That`,
    "is the only way to schedule work here — do not hand-roll a crontab entry, systemd timer, or",
    "setInterval loop for it. Writing scheduling into the user's own project is still normal coding.",
    proposalsOnly ? TASK_ROUTING_HINT : TASK_ROUTING_HINT + TASK_DATA_HINT,
    ARTIFACT_PATH_HINT,
  ].join(" ");
}

export const SESSION_TOOLS_SYSTEM_PROMPT_HINT = sessionToolsSystemPromptHint();

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

export const PROPOSE_TASK_DESCRIPTION = [
  "Propose one or more tasks for the project's task list: work to be done LATER, recorded so it",
  "isn't lost. Call this only when the user asks to record work as a task (\"make this a task\",",
  "\"add a to-do for the skipped test\"). Never call it on your own initiative.",
  "",
  "Do not do the work. Even when the task reads like an instruction (\"add error handling to X\"),",
  "the user is asking you to write it down, not to carry it out now.",
  "",
  "The proposal is shown to the user as a confirmation card; it does NOT create anything by itself",
  "and this call does not wait for the user. Say you have proposed the task (never that you created",
  "it) and continue.",
  "",
  "Each description must be self-contained: the task may be picked up later in a fresh session with",
  "none of this conversation's context. Cover the background, the relevant files, what remains to",
  "be done, and how to tell it is finished. Propose several tasks in one call when the user asks to",
  "split the work. Keep tasks coarse: one per piece of work someone would pick up and finish on its",
  "own, not one per step; steps belong in that task's description. At most 10 tasks per call.",
  "",
  "Write each file in this repository that a description refers to (a design doc, the source to",
  "change) as a Markdown link with a path relative to the repository root, e.g.",
  "[design doc](docs/foo-design.md) or [handler](src/routes/foo.ts:42). Such links open the file in",
  "the workspace; bare paths and absolute paths do not.",
  "",
  "To file the tasks as sub-tasks of an existing task (e.g. a follow-up found while working on",
  "step 2 of a plan), pass that task's id as `parent_task_id`. Take the id from `list_tasks` /",
  "`get_task`, or from a <vtasks-created> note (ids of tasks the user created from your earlier",
  "proposals, on a later user message) — never a guessed id. When `list_tasks` is available, check",
  "it first so you don't propose a task that already exists. Omit the parent when you don't know",
  "its id — the user can still pick one on the card. One call files all its tasks under the same",
  "parent; make separate calls for different parents.",
  "",
  "Project and source session are taken from this session — do not describe them here.",
].join("\n");

export const PROPOSE_TASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description: "The tasks to propose, usually one.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short, specific title, e.g. \"Cover remote path in retention-hold tests\"" },
          description: { type: "string", description: "Self-contained Markdown description: background, relevant files (as repo-relative Markdown links, e.g. [design](docs/foo.md) or [handler](src/foo.ts:42)), remaining work, definition of done." },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Optional; defaults to medium." },
        },
        required: ["title", "description"],
      },
    },
    parent_task_id: {
      type: "string",
      description: "Optional id of an existing task to file all these tasks under, taken from list_tasks / get_task or a <vtasks-created> note.",
    },
  },
  required: ["tasks"],
} as const;

export const PROPOSE_TASK_ACK =
  "Proposal shown to the user as a confirmation card. Nothing has been created yet — the user "
  + "decides whether to accept it. Tell the user you PROPOSED the task and that they can confirm it "
  + "on the card above. Do not start working on it.";

export type ProposedTaskPriority = "low" | "medium" | "high" | "urgent";

export interface ProposedTask {
  title: string;
  description: string;
  priority: ProposedTaskPriority;
}

export const PROPOSE_TASK_MAX_ITEMS = 10;
export const TASK_TITLE_MAX = 200;
export const TASK_DESCRIPTION_MAX = 20_000;
const PARENT_TASK_ID_MAX = 200;
const TASK_PRIORITIES: readonly ProposedTaskPriority[] = ["low", "medium", "high", "urgent"];

/** Shape validation only; nothing is stored until the user confirms the card. */
export function parseProposeTaskArgs(
  args: Record<string, unknown>,
): { ok: true; value: ProposedTask[] } | { ok: false; error: string } {
  const raw = args.tasks;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "tasks must be a non-empty array" };
  if (raw.length > PROPOSE_TASK_MAX_ITEMS) {
    return {
      ok: false,
      error: `propose at most ${PROPOSE_TASK_MAX_ITEMS} tasks at a time. This split is likely too fine: `
        + "merge related items into coarser tasks, listing their steps in the description, and call again. "
        + "Only if the user explicitly asked for each item as its own task, split them across several calls.",
    };
  }
  const parentTaskId = args.parent_task_id;
  if (parentTaskId !== undefined && parentTaskId !== null
    && (typeof parentTaskId !== "string" || parentTaskId.length > PARENT_TASK_ID_MAX)) {
    return { ok: false, error: "parent_task_id must be a task id string" };
  }
  const tasks: ProposedTask[] = [];
  for (const [i, item] of raw.entries()) {
    const obj = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const title = str(obj.title);
    if (!title) return { ok: false, error: `tasks[${i}].title is required` };
    if (title.length > TASK_TITLE_MAX) {
      return { ok: false, error: `tasks[${i}].title must be at most ${TASK_TITLE_MAX} characters` };
    }
    const description = str(obj.description);
    if (!description) return { ok: false, error: `tasks[${i}].description is required` };
    if (description.length > TASK_DESCRIPTION_MAX) {
      return { ok: false, error: `tasks[${i}].description must be at most ${TASK_DESCRIPTION_MAX} characters` };
    }
    const priorityRaw = str(obj.priority)?.toLowerCase();
    if (priorityRaw && !TASK_PRIORITIES.includes(priorityRaw as ProposedTaskPriority)) {
      return { ok: false, error: `tasks[${i}].priority must be one of: ${TASK_PRIORITIES.join(", ")}` };
    }
    tasks.push({ title, description, priority: (priorityRaw || "medium") as ProposedTaskPriority });
  }
  return { ok: true, value: tasks };
}

export const LIST_TASKS_DESCRIPTION = [
  "List or search the tasks of the project this session belongs to — the user's to-do list for the",
  "project, not your own todo list. Returns ids, titles, status, priority, parent and the start of",
  "each description; call get_task for a task's full description and sub-tasks.",
  "",
  "By default only open tasks (todo / in_progress) are listed. Archived tasks are never listed.",
  "When you mention a task to the user, link it as [title](#ref:task:<id>) so they can open it.",
  "Results come in pages of 50: when `next_offset` is present, call again with it as `offset`",
  "to read the rest.",
].join("\n");

export const LIST_TASKS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Optional case-insensitive text to match in titles and descriptions." },
    status: {
      type: "string",
      enum: ["open", "all", "todo", "in_progress", "done", "cancelled"],
      description: "Optional; \"open\" (default) = todo or in_progress.",
    },
    offset: { type: "integer", minimum: 0, description: "Optional; the `next_offset` of the previous page." },
  },
  additionalProperties: false,
} as const;

export const GET_TASK_DESCRIPTION =
  "Read one task of this project in full: its description, status, priority, parent and sub-tasks.";

export const GET_TASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    task_id: { type: "string", description: "Task id, from list_tasks or a <vtasks-created> note." },
  },
  required: ["task_id"],
  additionalProperties: false,
} as const;

export const PROPOSE_TASK_UPDATE_DESCRIPTION = [
  "Propose changes to existing tasks of this project: status, priority, title or description. Call",
  "it when the user asks to update, close, reprioritize or rewrite tasks — \"mark the retention task",
  "done\", \"fold what we learned into the task\". Never call it on your own initiative.",
  "",
  "The proposal is shown to the user as a confirmation card listing each change against the task's",
  "current values; it does NOT change anything by itself and this call does not wait for the user.",
  "Say you have proposed the update (never that you made it) and continue.",
  "",
  "Give only the fields that should change. `description` replaces the whole description: read it",
  "with get_task first and keep everything that should remain. Write files in this repository as",
  "Markdown links with repo-relative paths, as for propose_task. Use ids from list_tasks / get_task;",
  "never a guessed id. At most 10 tasks per call, each at most once. An entry whose task doesn't",
  "exist or already has those values is left off the card and reported back to you.",
].join("\n");

export const PROPOSE_TASK_UPDATE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    updates: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description: "One entry per task to change.",
      items: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Id of the task to change." },
          title: { type: "string", description: "New title." },
          description: { type: "string", description: "New full Markdown description (replaces the current one)." },
          status: { type: "string", enum: ["todo", "in_progress", "done", "cancelled"], description: "New status." },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "New priority." },
        },
        required: ["task_id"],
      },
    },
  },
  required: ["updates"],
} as const;

export const PROPOSE_TASK_UPDATE_ACK =
  "Proposal shown to the user as a confirmation card. Nothing has changed yet — the user decides "
  + "whether to apply it. Tell the user you PROPOSED the update and that they can apply it on the card above.";

export interface ProposedTaskUpdate {
  task_id: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
}

export const PROPOSE_TASK_UPDATE_MAX_ITEMS = 10;
const TASK_ID_MAX = 200;
const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "cancelled"];

/**
 * Shape validation only — whether each task exists in the project is checked
 * by the route, which owns storage. Mirrored by the card's replay
 * (task-update-proposal.tsx) so a rejected call never offers changes.
 */
export function parseProposeTaskUpdateArgs(
  args: Record<string, unknown>,
): { ok: true; value: ProposedTaskUpdate[] } | { ok: false; error: string } {
  const raw = args.updates;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "updates must be a non-empty array" };
  if (raw.length > PROPOSE_TASK_UPDATE_MAX_ITEMS) {
    return { ok: false, error: `propose at most ${PROPOSE_TASK_UPDATE_MAX_ITEMS} task updates at a time` };
  }
  const seen = new Set<string>();
  const updates: ProposedTaskUpdate[] = [];
  for (const [i, item] of raw.entries()) {
    const obj = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const taskId = typeof obj.task_id === "string" ? obj.task_id.trim() : "";
    if (!taskId || taskId.length > TASK_ID_MAX) return { ok: false, error: `updates[${i}].task_id is required` };
    if (seen.has(taskId)) return { ok: false, error: `task ${taskId} appears more than once; merge its changes into one entry` };
    seen.add(taskId);

    const update: ProposedTaskUpdate = { task_id: taskId };
    if (obj.title !== undefined) {
      const title = typeof obj.title === "string" ? obj.title.trim() : "";
      if (!title || title.length > TASK_TITLE_MAX) {
        return { ok: false, error: `updates[${i}].title must be a non-empty string of at most ${TASK_TITLE_MAX} characters` };
      }
      update.title = title;
    }
    if (obj.description !== undefined) {
      const description = typeof obj.description === "string" ? obj.description : "";
      if (!description.trim() || description.length > TASK_DESCRIPTION_MAX) {
        return { ok: false, error: `updates[${i}].description must be non-empty and at most ${TASK_DESCRIPTION_MAX} characters` };
      }
      update.description = description;
    }
    if (obj.status !== undefined) {
      if (!TASK_STATUSES.includes(obj.status as TaskStatus)) {
        return { ok: false, error: `updates[${i}].status must be one of: ${TASK_STATUSES.join(", ")}` };
      }
      update.status = obj.status as TaskStatus;
    }
    if (obj.priority !== undefined) {
      if (!TASK_PRIORITIES.includes(obj.priority as ProposedTaskPriority)) {
        return { ok: false, error: `updates[${i}].priority must be one of: ${TASK_PRIORITIES.join(", ")}` };
      }
      update.priority = obj.priority as TaskPriority;
    }
    if (Object.keys(update).length === 1) {
      return { ok: false, error: `updates[${i}] changes nothing; give at least one of title, description, status, priority` };
    }
    updates.push(update);
  }
  return { ok: true, value: updates };
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
const aliasesOf = (tool: string, canonical: string): Set<string> => new Set(
  [
    tool,
    canonical,
    `${SESSION_TOOLS_MCP_SERVER_NAME}.${tool}`,
    `${SESSION_TOOLS_MCP_SERVER_NAME}/${tool}`,
    `${SESSION_TOOLS_MCP_SERVER_NAME}__${tool}`,
    `${SESSION_TOOLS_MCP_SERVER_NAME}-${tool}`,
  ].map((n) => n.toLowerCase()),
);

const SESSION_TOOL_ALIASES: ReadonlyArray<[Set<string>, string]> = [
  [aliasesOf(PROPOSE_SCHEDULE_TOOL, CANONICAL_PROPOSE_SCHEDULE_TOOL), CANONICAL_PROPOSE_SCHEDULE_TOOL],
  [aliasesOf(PROPOSE_TASK_TOOL, CANONICAL_PROPOSE_TASK_TOOL), CANONICAL_PROPOSE_TASK_TOOL],
  [aliasesOf(PROPOSE_TASK_UPDATE_TOOL, CANONICAL_PROPOSE_TASK_UPDATE_TOOL), CANONICAL_PROPOSE_TASK_UPDATE_TOOL],
];

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
  const key = tool.trim().toLowerCase();
  return SESSION_TOOL_ALIASES.find(([aliases]) => aliases.has(key))?.[1] ?? tool;
}

/** Public base URL remote agents reach the hub on; remote sessions get no tools without it. */
export function sessionToolsPublicBaseUrl(): string | null {
  return process.env.VIBEDECKX_PUBLIC_URL?.trim() || null;
}

/**
 * Mints the config for one session's agent. `baseUrl` is how that agent
 * reaches the hub: its loopback for a local session, the public URL for a
 * remote one. Undefined (tools absent) when there is no usable base URL.
 */
export async function mintSessionToolsMcpConfig(
  deps: { storage: Pick<Storage, "settings"> },
  args: { sessionId: string; projectId: string; userId: string | null | undefined; baseUrl: string | null },
): Promise<SessionToolsMcpConfig | undefined> {
  const baseUrl = args.baseUrl?.trim();
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return undefined;
  if (!args.sessionId || !args.projectId) return undefined;
  // The solo sentinel is not a principal: solo projects are stored ownerless.
  const userId = args.userId && args.userId !== "local" ? args.userId : null;

  const secret = await getSessionToolsSecret(deps.storage);
  const token = signSessionToolsToken(secret, { sessionId: args.sessionId, projectId: args.projectId, userId }, Date.now());
  return { url: `${baseUrl.replace(/\/+$/, "")}${SESSION_TOOLS_MCP_PATH}`, token };
}

/**
 * Hub side, for a remote session: the config to hand its worker. Best-effort —
 * a failed mint leaves the tools off rather than failing the caller.
 */
export async function mintRemoteSessionToolsMcpConfig(
  deps: { storage: Pick<Storage, "settings"> },
  args: { sessionId: string; projectId: string | null | undefined; userId: string | null | undefined },
): Promise<SessionToolsMcpConfig | undefined> {
  if (!args.projectId) return undefined;
  return mintSessionToolsMcpConfig(deps, {
    sessionId: args.sessionId, projectId: args.projectId, userId: args.userId, baseUrl: sessionToolsPublicBaseUrl(),
  }).catch((err) => {
    console.error(`[SessionTools] mint for remote session ${args.sessionId} failed:`, err);
    return undefined;
  });
}

/** Worker side: accept the hub-minted config from a request body, or nothing. */
export function parseSessionToolsMcpConfig(value: unknown): SessionToolsMcpConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { url, token } = value as Record<string, unknown>;
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || typeof token !== "string" || !token) return undefined;
  return { url, token };
}
