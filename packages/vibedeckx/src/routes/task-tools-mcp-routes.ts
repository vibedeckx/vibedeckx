import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { getTaskToolsSecret, verifyTaskToolsToken, type TaskToolsTokenPayload } from "../utils/task-tools-token.js";
import {
  GET_TASK_DESCRIPTION,
  GET_TASK_INPUT_SCHEMA,
  GET_TASK_TOOL,
  LIST_TASKS_DESCRIPTION,
  LIST_TASKS_INPUT_SCHEMA,
  LIST_TASKS_TOOL,
  PROPOSE_TASK_UPDATE_ACK,
  PROPOSE_TASK_UPDATE_DESCRIPTION,
  PROPOSE_TASK_UPDATE_INPUT_SCHEMA,
  PROPOSE_TASK_UPDATE_TOOL,
  TASK_TOOLS_MCP_INSTRUCTIONS,
  TASK_TOOLS_MCP_PATH,
  parseProposeTaskUpdateArgs,
} from "../task-tools-mcp.js";
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

const TOOLS = [
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

/**
 * The hub-hosted project-task tools (task-tools-mcp.ts). Reads go straight to
 * storage, scoped to the one project the token names; propose_task_update is
 * fire-and-forget like propose_task — it validates against the current tasks
 * and returns, and the user applies it from the card through the ordinary
 * task REST routes. Nothing here writes.
 */
const routes: FastifyPluginAsync = async (fastify) => {
  let cachedSecret: Promise<string> | undefined;
  const getSecret = (): Promise<string> => {
    if (!cachedSecret) cachedSecret = getTaskToolsSecret(fastify.storage);
    return cachedSecret;
  };

  const authenticate = async (request: FastifyRequest): Promise<TaskToolsTokenPayload | null> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const payload = verifyTaskToolsToken(await getSecret(), header.slice("Bearer ".length), Date.now());
    if (!payload) return null;
    // A token outliving its session authorizes nothing — the same liveness
    // rule as the cross-remote gateway's isSessionUsable.
    const usable = payload.sessionId.startsWith("remote-")
      ? fastify.remoteSessionMap.has(payload.sessionId)
      : fastify.agentSessionManager.getSessionProcessAlive(payload.sessionId);
    if (!usable) return null;
    // Re-checked per call so a deleted or transferred project stops answering.
    const project = await fastify.storage.projects.getById(payload.projectId, payload.userId ?? undefined);
    return project ? payload : null;
  };

  /** The task, only if it belongs to the token's project. */
  const taskInProject = async (payload: TaskToolsTokenPayload, id: unknown): Promise<Task | null> => {
    if (typeof id !== "string" || !id.trim()) return null;
    const task = await fastify.storage.tasks.getById(id.trim());
    return task && task.project_id === payload.projectId ? task : null;
  };

  const listTasks = async (payload: TaskToolsTokenPayload, args: Record<string, unknown>) => {
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

  const getTask = async (payload: TaskToolsTokenPayload, args: Record<string, unknown>) => {
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

  const proposeTaskUpdate = async (payload: TaskToolsTokenPayload, args: Record<string, unknown>) => {
    const parsed = parseProposeTaskUpdateArgs(args);
    if (!parsed.ok) return textResult(parsed.error, true);
    // Per entry, never the whole batch: the card can't see this result (Claude
    // Code's never reaches the conversation), so it judges each row from the
    // tasks themselves — a missing task shows as gone, a no-op as up to date,
    // and the rest stay applicable. Rejecting the batch here would leave those
    // rows applicable on a card the agent was told failed. Only when no entry
    // proposes anything is it an error, and then the card offers nothing either.
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

  const callTool = (payload: TaskToolsTokenPayload, toolName: string, args: Record<string, unknown>) => {
    switch (toolName) {
      case LIST_TASKS_TOOL: return listTasks(payload, args);
      case GET_TASK_TOOL: return getTask(payload, args);
      case PROPOSE_TASK_UPDATE_TOOL: return proposeTaskUpdate(payload, args);
      default: return textResult(`Unknown tool: ${toolName}`, true);
    }
  };

  fastify.post(TASK_TOOLS_MCP_PATH, async (request, reply) => {
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
          serverInfo: { name: "vibedeckx-tasks", version: "1.0.0" },
          instructions: TASK_TOOLS_MCP_INSTRUCTIONS,
        });
      case "ping":
        return respond({});
      case "tools/list":
        return respond({ tools: TOOLS });
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

export default fp(routes, { name: "task-tools-mcp-routes" });
