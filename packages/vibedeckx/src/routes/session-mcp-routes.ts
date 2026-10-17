import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  getSessionToolsSecret,
  verifySessionToolsToken,
  type SessionToolsTokenPayload,
} from "../utils/session-tools-token.js";
import {
  GET_TASK_DESCRIPTION,
  GET_TASK_INPUT_SCHEMA,
  GET_TASK_TOOL,
  LIST_TASKS_DESCRIPTION,
  LIST_TASKS_INPUT_SCHEMA,
  LIST_TASKS_TOOL,
  PROPOSE_SCHEDULE_ACK,
  PROPOSE_SCHEDULE_DESCRIPTION,
  PROPOSE_SCHEDULE_INPUT_SCHEMA,
  PROPOSE_SCHEDULE_TOOL,
  PROPOSE_TASK_ACK,
  PROPOSE_TASK_DESCRIPTION,
  PROPOSE_TASK_INPUT_SCHEMA,
  PROPOSE_TASK_TOOL,
  PROPOSE_TASK_UPDATE_ACK,
  PROPOSE_TASK_UPDATE_DESCRIPTION,
  PROPOSE_TASK_UPDATE_INPUT_SCHEMA,
  PROPOSE_TASK_UPDATE_TOOL,
  SESSION_TOOLS_MCP_PATH,
  parseProposeScheduleArgs,
  parseProposeTaskArgs,
  parseProposeTaskUpdateArgs,
  sessionToolsInstructions,
} from "../session-tools-mcp.js";
import { validateCron } from "../scheduler.js";
import type { Task, TaskStatus } from "../storage/types.js";
import "../server-types.js";

const PROTOCOL_VERSION = "2024-11-05";
const LIST_LIMIT = 50;
const LIST_DESCRIPTION_PREVIEW = 200;
const QUERY_MAX = 256;

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const PROPOSAL_TOOLS = [
  { name: PROPOSE_SCHEDULE_TOOL, description: PROPOSE_SCHEDULE_DESCRIPTION, inputSchema: PROPOSE_SCHEDULE_INPUT_SCHEMA },
  { name: PROPOSE_TASK_TOOL, description: PROPOSE_TASK_DESCRIPTION, inputSchema: PROPOSE_TASK_INPUT_SCHEMA },
];

const TOOLS = [
  ...PROPOSAL_TOOLS,
  { name: LIST_TASKS_TOOL, description: LIST_TASKS_DESCRIPTION, inputSchema: LIST_TASKS_INPUT_SCHEMA },
  { name: GET_TASK_TOOL, description: GET_TASK_DESCRIPTION, inputSchema: GET_TASK_INPUT_SCHEMA },
  {
    name: PROPOSE_TASK_UPDATE_TOOL,
    description: PROPOSE_TASK_UPDATE_DESCRIPTION,
    inputSchema: PROPOSE_TASK_UPDATE_INPUT_SCHEMA,
  },
];

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});
const jsonResult = (value: unknown) => textResult(JSON.stringify(value, null, 2));

const LIST_STATUSES: Record<string, readonly TaskStatus[] | undefined> = {
  open: ["todo", "in_progress"],
  all: undefined,
  todo: ["todo"],
  in_progress: ["in_progress"],
  done: ["done"],
  cancelled: ["cancelled"],
};

const preview = (text: string | null, max: number): string | null => {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The agent-facing `vibedeckx` tool endpoint, served by the hub for every
 * session (session-tools-mcp.ts). Reads go straight to storage, scoped to the
 * one project the token names. The three proposals are fire-and-forget: they
 * validate and return, leaving the tool_use message in the conversation as
 * the only artifact; the user confirms it on a card, which calls the ordinary
 * REST routes. Nothing here writes. See docs/schedule-proposal-tool-design.md §3.
 *
 * The cards can't see these results (Claude Code's never reach the
 * conversation) and judge each proposal from its input and the current tasks.
 * So a whole call is only rejected for what the card also rejects — shape —
 * and anything it renders on its own terms (a missing parent, a task already
 * up to date) is reported back to the agent as a note, never as an error.
 */
const routes: FastifyPluginAsync = async (fastify) => {
  // A reverse-connect worker serves only its own fallback (sessions it started
  // without a hub config — see AgentSessionManager.sessionToolsMcpFor): the two
  // proposals, which need no task data. Its tasks table is not the user's.
  const proposalsOnly = fastify.isReverseConnectWorker === true;
  const tools = proposalsOnly ? PROPOSAL_TOOLS : TOOLS;

  // Memoized lazily: the secret is bootstrapped once and never rotates, and
  // reading it at registration time would miss secrets created after the app
  // is built (tests).
  let cachedSecret: Promise<string> | undefined;
  const getSecret = (): Promise<string> => {
    if (!cachedSecret) cachedSecret = getSessionToolsSecret(fastify.storage);
    return cachedSecret;
  };

  const authenticate = async (request: FastifyRequest): Promise<SessionToolsTokenPayload | null> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const payload = verifySessionToolsToken(await getSecret(), header.slice("Bearer ".length), Date.now());
    if (!payload) return null;
    // A token outliving its session authorizes nothing — the same liveness
    // rule as the cross-remote gateway's isSessionUsable.
    const usable = payload.sessionId.startsWith("remote-")
      ? fastify.remoteSessionMap.has(payload.sessionId)
      : fastify.agentSessionManager.getSessionProcessAlive(payload.sessionId);
    if (!usable) return null;
    if (proposalsOnly) return payload;
    // Re-checked per call so a deleted or transferred project stops answering.
    const project = await fastify.storage.projects.getById(payload.projectId, payload.userId ?? undefined);
    return project ? payload : null;
  };

  /** The task, only if it belongs to the token's project. */
  const taskInProject = async (payload: SessionToolsTokenPayload, id: unknown): Promise<Task | null> => {
    if (typeof id !== "string" || !id.trim()) return null;
    const task = await fastify.storage.tasks.getById(id.trim());
    return task && task.project_id === payload.projectId ? task : null;
  };

  const proposeSchedule = (args: Record<string, unknown>) => {
    const parsed = parseProposeScheduleArgs(args);
    if (!parsed.ok) return textResult(parsed.error, true);
    // Validate here rather than only at confirm time: a bad cron caught now is
    // something the agent can fix in the same turn, instead of a card the user
    // cannot accept.
    const cronError = validateCron(parsed.value.cron_expr, parsed.value.timezone);
    if (cronError) return textResult(`Invalid cron expression: ${cronError}`, true);
    return textResult(PROPOSE_SCHEDULE_ACK);
  };

  const proposeTask = async (payload: SessionToolsTokenPayload, args: Record<string, unknown>) => {
    const parsed = parseProposeTaskArgs(args);
    if (!parsed.ok) return textResult(parsed.error, true);
    if (proposalsOnly) return textResult(PROPOSE_TASK_ACK);
    const notes: string[] = [];
    // The card files under a parent_task_id only while it names a task of this
    // project, and otherwise under none — so a bad id is a note, not an error.
    const parentId = typeof args.parent_task_id === "string" ? args.parent_task_id.trim() : "";
    if (parentId && !(await taskInProject(payload, parentId))) {
      notes.push(`parent_task_id ${parentId} is not a task of this project, so the card files these without a parent `
        + "unless the user picks one. Take ids from list_tasks next time.");
    }
    const existing = await fastify.storage.tasks.getByProjectId(payload.projectId);
    for (const [i, item] of parsed.value.entries()) {
      const twin = existing.find((t) => sameTitle(t.title, item.title));
      if (twin) {
        notes.push(`tasks[${i}] has the same title as existing task ${twin.id} (${twin.status}); `
          + "if it is the same work, tell the user instead of letting them file it twice.");
      }
    }
    return textResult(notes.length ? `${PROPOSE_TASK_ACK}\nNote: ${notes.join(" ")}` : PROPOSE_TASK_ACK);
  };

  const listTasks = async (payload: SessionToolsTokenPayload, args: Record<string, unknown>) => {
    const statusKey = args.status === undefined ? "open" : args.status;
    if (typeof statusKey !== "string" || !(statusKey in LIST_STATUSES)) {
      return textResult(`status must be one of: ${Object.keys(LIST_STATUSES).join(", ")}`, true);
    }
    if (args.query !== undefined && typeof args.query !== "string") return textResult("query must be a string", true);
    const query = typeof args.query === "string" ? args.query.slice(0, QUERY_MAX) : undefined;
    const offset = args.offset === undefined ? 0 : args.offset;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      return textResult("offset must be a non-negative integer", true);
    }
    const rows = await fastify.storage.tasks.queryByProject(payload.projectId, {
      query, status: LIST_STATUSES[statusKey], limit: LIST_LIMIT + 1, offset,
    });
    return jsonResult({
      tasks: rows.slice(0, LIST_LIMIT).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        parent_id: task.parent_id,
        description: preview(task.description, LIST_DESCRIPTION_PREVIEW),
        ...(task.source_session_id === payload.sessionId ? { proposed_in_this_session: true } : {}),
      })),
      ...(rows.length > LIST_LIMIT ? { next_offset: offset + LIST_LIMIT } : {}),
    });
  };

  const getTask = async (payload: SessionToolsTokenPayload, args: Record<string, unknown>) => {
    const task = await taskInProject(payload, args.task_id);
    if (!task) return textResult("Task not found in this project", true);
    const parent = task.parent_id ? await taskInProject(payload, task.parent_id) : null;
    const all = await fastify.storage.tasks.getByProjectId(payload.projectId);
    return jsonResult({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      archived: task.archived_at !== null,
      parent: parent ? { id: parent.id, title: parent.title } : null,
      subtasks: all
        .filter((t) => t.parent_id === task.id)
        .map((t) => ({ id: t.id, title: t.title, status: t.status })),
      ...(task.source_session_id === payload.sessionId ? { proposed_in_this_session: true } : {}),
      created_at: task.created_at,
      updated_at: task.updated_at,
    });
  };

  const proposeTaskUpdate = async (payload: SessionToolsTokenPayload, args: Record<string, unknown>) => {
    const parsed = parseProposeTaskUpdateArgs(args);
    if (!parsed.ok) return textResult(parsed.error, true);
    // Per entry, never the whole batch: the card shows a missing task as gone
    // and a no-op as up to date, and leaves the rest applicable. Only when no
    // entry proposes anything is it an error, and then the card offers nothing.
    const skipped: string[] = [];
    for (const [i, update] of parsed.value.entries()) {
      const task = await taskInProject(payload, update.task_id);
      if (!task) {
        skipped.push(`updates[${i}]: task ${update.task_id} not found in this project`);
        continue;
      }
      const changes = (["title", "description", "status", "priority"] as const)
        .filter((field) => update[field] !== undefined && update[field] !== (task[field] ?? ""));
      if (changes.length === 0) skipped.push(`updates[${i}]: task ${update.task_id} already has these values`);
    }
    if (skipped.length === parsed.value.length) {
      return textResult(`Nothing to propose — ${skipped.join("; ")}. No card is actionable.`, true);
    }
    if (skipped.length === 0) return textResult(PROPOSE_TASK_UPDATE_ACK);
    return textResult(
      `${PROPOSE_TASK_UPDATE_ACK}\nNot on the card (nothing to apply): ${skipped.join("; ")}. `
        + "If one of those ids was wrong, propose that task's update again with the right id.",
    );
  };

  const callTool = async (payload: SessionToolsTokenPayload, toolName: string, args: Record<string, unknown>) => {
    if (!tools.some((tool) => tool.name === toolName)) return textResult(`Unknown tool: ${toolName}`, true);
    switch (toolName) {
      case PROPOSE_SCHEDULE_TOOL: return proposeSchedule(args);
      case PROPOSE_TASK_TOOL: return proposeTask(payload, args);
      case LIST_TASKS_TOOL: return listTasks(payload, args);
      case GET_TASK_TOOL: return getTask(payload, args);
      case PROPOSE_TASK_UPDATE_TOOL: return proposeTaskUpdate(payload, args);
      default: return textResult(`Unknown tool: ${toolName}`, true);
    }
  };

  fastify.post(SESSION_TOOLS_MCP_PATH, async (request, reply) => {
    const payload = await authenticate(request);
    if (!payload) return reply.code(401).send({ error: "Unauthorized" });

    const rpc = request.body as JsonRpcRequest;
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      return reply.code(400).send({ error: "Invalid JSON-RPC request" });
    }

    // Notifications carry no id and expect no body.
    if (rpc.id === undefined) return reply.code(202).send();

    const respond = (result: unknown) => reply.send({ jsonrpc: "2.0", id: rpc.id, result });

    switch (rpc.method) {
      case "initialize":
        return respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "vibedeckx-session-tools", version: "1.0.0" },
          instructions: sessionToolsInstructions(proposalsOnly),
        });
      case "ping":
        return respond({});
      case "tools/list":
        return respond({ tools });
      case "tools/call": {
        const name = rpc.params?.name;
        if (typeof name !== "string") {
          return reply.send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Missing tool name" } });
        }
        return respond(await callTool(payload, name, rpc.params?.arguments ?? {}));
      }
      default:
        return reply.send({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        });
    }
  });
};

export default fp(routes, { name: "session-mcp-routes" });
