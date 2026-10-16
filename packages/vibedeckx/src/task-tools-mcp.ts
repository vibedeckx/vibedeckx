/**
 * Project-task MCP tool surface: read the session's project tasks and propose
 * changes to them. Unlike the session tools (session-tools-mcp.ts), which the
 * spawning process serves on its own loopback, these are always served by the
 * HUB — tasks live only in the hub's storage. A local session reaches them on
 * the hub's loopback; a remote session's agent runs on a worker, so it reaches
 * them over VIBEDECKX_PUBLIC_URL with a hub-signed token the hub hands the
 * worker (create/activate/branch bodies, refreshed on every forwarded message).
 *
 * Lives outside routes/ so providers and the session manager can import the
 * contract without pulling Fastify in.
 */
import type { Storage, TaskPriority, TaskStatus } from "./storage/types.js";
import { getTaskToolsSecret, signTaskToolsToken } from "./utils/task-tools-token.js";
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX } from "./session-tools-mcp.js";

export const TASK_TOOLS_MCP_PATH = "/api/task-tools-mcp";

/** MCP server name as declared to the CLIs; part of Claude's reported tool name. */
export const TASK_TOOLS_MCP_SERVER_NAME = "vibedeckx-tasks";

export const LIST_TASKS_TOOL = "list_tasks";
export const GET_TASK_TOOL = "get_task";
export const PROPOSE_TASK_UPDATE_TOOL = "propose_task_update";

const canonical = (tool: string) => `mcp__${TASK_TOOLS_MCP_SERVER_NAME}__${tool}`;
export const CANONICAL_LIST_TASKS_TOOL = canonical(LIST_TASKS_TOOL);
export const CANONICAL_GET_TASK_TOOL = canonical(GET_TASK_TOOL);
/** The name the frontend's update card matches on; Codex is normalized onto it. */
export const CANONICAL_PROPOSE_TASK_UPDATE_TOOL = canonical(PROPOSE_TASK_UPDATE_TOOL);

export const TASK_TOOLS_CANONICAL_NAMES = [
  CANONICAL_LIST_TASKS_TOOL,
  CANONICAL_GET_TASK_TOOL,
  CANONICAL_PROPOSE_TASK_UPDATE_TOOL,
] as const;

export interface TaskToolsMcpConfig {
  url: string;
  token: string;
}

const UPDATE_ROUTING =
  `To change existing tasks — status, priority, title or description — call \`${CANONICAL_PROPOSE_TASK_UPDATE_TOOL}\``
  + " when the user asks; the user confirms each change on a card. Never claim you updated a task.";

export const TASK_TOOLS_MCP_INSTRUCTIONS = [
  `\`${LIST_TASKS_TOOL}\` and \`${GET_TASK_TOOL}\` read this project's task list (the Tasks page the user`,
  "keeps). Use them when the user refers to existing tasks, and before proposing new tasks so you",
  "don't duplicate one and can file new ones under the right parent.",
  "",
  UPDATE_ROUTING,
].join("\n");

/** Same rule as a system-prompt append, for CLIs that take one (see SESSION_TOOLS_SYSTEM_PROMPT_HINT). */
export const TASK_TOOLS_SYSTEM_PROMPT_HINT =
  `Project tasks: \`${CANONICAL_LIST_TASKS_TOOL}\` and \`${CANONICAL_GET_TASK_TOOL}\` read the project's task list. `
  + UPDATE_ROUTING;

export const LIST_TASKS_DESCRIPTION = [
  "List or search the tasks of the project this session belongs to — the user's to-do list for the",
  "project, not your own todo list. Returns ids, titles, status, priority, parent and the start of",
  "each description; call get_task for a task's full description and sub-tasks.",
  "",
  "By default only open tasks (todo / in_progress) are listed. Archived tasks are never listed.",
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
const STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "cancelled"];
const PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high", "urgent"];

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
      if (!STATUSES.includes(obj.status as TaskStatus)) {
        return { ok: false, error: `updates[${i}].status must be one of: ${STATUSES.join(", ")}` };
      }
      update.status = obj.status as TaskStatus;
    }
    if (obj.priority !== undefined) {
      if (!PRIORITIES.includes(obj.priority as TaskPriority)) {
        return { ok: false, error: `updates[${i}].priority must be one of: ${PRIORITIES.join(", ")}` };
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

/** Public base URL remote agents reach the hub on; the remote half of the feature is off without it. */
export function taskToolsPublicBaseUrl(): string | null {
  return process.env.VIBEDECKX_PUBLIC_URL?.trim() || null;
}

/**
 * Mints the config for one session's agent. `baseUrl` is how that agent
 * reaches the hub: its loopback for a local session, the public URL for a
 * remote one. Undefined (tools absent) when there is no usable base URL.
 */
export async function mintTaskToolsMcpConfig(
  deps: { storage: Pick<Storage, "settings"> },
  args: { sessionId: string; projectId: string; userId: string | null | undefined; baseUrl: string | null },
): Promise<TaskToolsMcpConfig | undefined> {
  const baseUrl = args.baseUrl?.trim();
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return undefined;
  if (!args.sessionId || !args.projectId) return undefined;
  // The solo sentinel is not a principal: solo projects are stored ownerless.
  const userId = args.userId && args.userId !== "local" ? args.userId : null;

  const secret = await getTaskToolsSecret(deps.storage);
  const token = signTaskToolsToken(secret, { sessionId: args.sessionId, projectId: args.projectId, userId }, Date.now());
  return { url: `${baseUrl.replace(/\/+$/, "")}${TASK_TOOLS_MCP_PATH}`, token };
}

/** Worker side: accept the hub-minted config from a request body, or nothing. */
export function parseTaskToolsMcpConfig(value: unknown): TaskToolsMcpConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { url, token } = value as Record<string, unknown>;
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || typeof token !== "string" || !token) return undefined;
  return { url, token };
}

/**
 * Hub side, for a remote session: the config to hand its worker. Best-effort —
 * a failed mint leaves the tools off rather than failing the caller.
 */
export async function mintRemoteTaskToolsMcpConfig(
  deps: { storage: Pick<Storage, "settings"> },
  args: { sessionId: string; projectId: string | null | undefined; userId: string | null | undefined },
): Promise<TaskToolsMcpConfig | undefined> {
  if (!args.projectId) return undefined;
  return mintTaskToolsMcpConfig(deps, {
    sessionId: args.sessionId, projectId: args.projectId, userId: args.userId, baseUrl: taskToolsPublicBaseUrl(),
  }).catch((err) => {
    console.error(`[TaskTools] mint for remote session ${args.sessionId} failed:`, err);
    return undefined;
  });
}
