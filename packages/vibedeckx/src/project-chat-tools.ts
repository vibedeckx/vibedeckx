import { z } from "zod";
import type { ProjectChatContextEntityType, Storage } from "./storage/types.js";

const LIST_LIMIT = 50;
const TRANSCRIPT_ENTRY_LIMIT = 20;
const TRANSCRIPT_CHAR_LIMIT = 6_000;
const RUN_PREVIEW_CHAR_LIMIT = 4_000;
const ID_CHAR_LIMIT = 512;
const NAME_CHAR_LIMIT = 512;
const DESCRIPTION_CHAR_LIMIT = 2_000;
const BRANCH_CHAR_LIMIT = 512;
const TARGET_CHAR_LIMIT = 512;
const ENUM_CHAR_LIMIT = 64;
const MODEL_CHAR_LIMIT = 256;
const TIMESTAMP_CHAR_LIMIT = 128;
const CRON_CHAR_LIMIT = 512;
const TIMEZONE_CHAR_LIMIT = 128;
const TRANSCRIPT_TYPE_CHAR_LIMIT = 32;
const STRUCTURAL_DEPTH_LIMIT = 4;
const STRUCTURAL_ENTRY_LIMIT = 20;
const STRUCTURAL_NODE_LIMIT = 100;
const STRUCTURAL_KEY_CHAR_LIMIT = 128;
const STRUCTURAL_STRING_CHAR_LIMIT = 1_000;

export interface ProjectAgentSessionReader {
  getMessages(sessionId: string): unknown[];
  getSessionProcessAlive(sessionId: string): boolean;
}

export interface RemoteProjectSessionMapping {
  id: string;
  projectId: string;
  remoteServerId: string;
  remoteSessionId: string;
  branch: string | null;
}

export interface ProjectSessionSummary {
  id: string;
  projectId: string;
  branch: string | null;
  title: string | null;
  status: string;
  target: string;
  agentType?: string | null;
  model?: string | null;
}

export interface ProjectSessionDetail extends ProjectSessionSummary {
  processAlive?: boolean;
  transcript: unknown[];
}

/**
 * Project-bound remote lookup/transport boundary. Implementations resolve the
 * opaque local id through the persisted mapping; tool handlers never decode it.
 */
export interface RemoteProjectSessionReader {
  listByProject(projectId: string, limit: number): Promise<ProjectSessionSummary[]>;
  getMapping(sessionId: string): Promise<RemoteProjectSessionMapping | undefined>;
  getDetail(
    mapping: RemoteProjectSessionMapping,
    limits: { maxEntries: number; maxChars: number },
  ): Promise<ProjectSessionDetail | undefined>;
}

interface RemoteProxyResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export function createRemoteProjectSessionReader(options: {
  storage: Storage;
  proxy(remoteServerId: string, method: string, path: string): Promise<RemoteProxyResult>;
}): RemoteProjectSessionReader {
  return {
    listByProject: async (projectId, limit) => {
      const rows = await options.storage.remoteSessionMappings.listByProject(projectId, limit);
      return rows.map((row) => ({
        id: row.local_session_id,
        projectId: row.project_id,
        branch: row.branch,
        title: null,
        status: "unknown",
        target: row.remote_server_id,
      }));
    },
    getMapping: async (sessionId) => {
      const row = await options.storage.remoteSessionMappings.getByLocal(sessionId);
      return row ? {
        id: row.local_session_id,
        projectId: row.project_id,
        remoteServerId: row.remote_server_id,
        remoteSessionId: row.remote_session_id,
        branch: row.branch,
      } : undefined;
    },
    getDetail: async (mapping, limits) => {
      const result = await options.proxy(
        mapping.remoteServerId,
        "GET",
        `/api/agent-sessions/${encodeURIComponent(mapping.remoteSessionId)}`,
      );
      if (!isSafeRecord(result) || safeProperty(result, "ok") !== true) return undefined;
      const data = safeRecord(safeProperty(result, "data"));
      if (!data) return undefined;
      const session = safeRecord(safeProperty(data, "session"));
      if (!session) return undefined;
      const branch = safeProperty(session, "branch");
      const title = safeProperty(session, "title");
      const status = safeProperty(session, "status");
      const processAlive = safeProperty(session, "processAlive");
      const agentType = safeProperty(session, "agentType");
      const legacyAgentType = typeof agentType === "string" ? undefined : safeProperty(session, "agent_type");
      const model = safeProperty(session, "model");
      const messages = safeProperty(data, "messages");
      const transcript = transcriptPreview(safeArrayTail(
        messages,
        Math.min(normalizeCollectionLimit(limits.maxEntries), TRANSCRIPT_ENTRY_LIMIT),
      ));
      return {
        id: mapping.id,
        projectId: mapping.projectId,
        branch: typeof branch === "string" ? branch : mapping.branch,
        title: typeof title === "string" ? title : null,
        status: typeof status === "string" ? status : "unknown",
        target: mapping.remoteServerId,
        agentType: typeof agentType === "string" ? agentType
          : typeof legacyAgentType === "string" ? legacyAgentType : null,
        model: typeof model === "string" ? model : null,
        processAlive: typeof processAlive === "boolean" ? processAlive : false,
        transcript: JSON.stringify(transcript).length <= Math.min(limits.maxChars, TRANSCRIPT_CHAR_LIMIT) + 1_000
          ? transcript
          : transcriptPreview(transcript),
      };
    },
  };
}

export interface ProjectChatTool<Args, Result> {
  description: string;
  inputSchema: z.ZodType<Args>;
  execute(args: Args): Promise<Result>;
}

interface ListResult<T> { items: T[]; truncated: boolean }

export type ProjectChatTools = {
  get_project_summary: ProjectChatTool<Record<string, never>, { id: string; name: string; executionTarget: string }>;
  list_tasks: ProjectChatTool<{ query?: string; status?: "todo" | "in_progress" | "done" | "cancelled" }, ListResult<Record<string, unknown>>>;
  get_task: ProjectChatTool<{ taskId: string }, Record<string, unknown>>;
  list_workspaces: ProjectChatTool<Record<string, never>, ListResult<{ id: string; target: string; branch: string | null }>>;
  list_agent_sessions: ProjectChatTool<Record<string, never>, ListResult<ProjectSessionSummary>>;
  get_agent_session: ProjectChatTool<{ sessionId: string }, ProjectSessionDetail>;
  list_schedules: ProjectChatTool<Record<string, never>, ListResult<Record<string, unknown>>>;
  list_schedule_runs: ProjectChatTool<Record<string, never>, ListResult<Record<string, unknown>>>;
  get_schedule_run: ProjectChatTool<{ runId: string }, Record<string, unknown> & { outputPreview: string; reportPreview: string }>;
};

export interface CreateProjectChatToolsOptions {
  projectId: string;
  threadId: string;
  userId: string;
  storage: Storage;
  agentSessionManager: ProjectAgentSessionReader;
  remoteSessions?: RemoteProjectSessionReader;
}

const emptySchema = z.object({}).strict();
const preview = (value: unknown, limit: number): string => {
  if (typeof value !== "string" || !value) return "";
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
};

const nullablePreview = (value: unknown, limit: number): string | null =>
  value === null || value === undefined ? null : preview(value, limit);

function safeIsArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isSafeRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object" || safeIsArray(value)) return false;
  try {
    Object.getPrototypeOf(value);
    return true;
  } catch {
    return false;
  }
}

function safeRecord(value: unknown): Record<PropertyKey, unknown> | undefined {
  return isSafeRecord(value) ? value : undefined;
}

function safeProperty(value: Record<PropertyKey, unknown>, key: PropertyKey): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function normalizeCollectionLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function safeArrayTail(value: unknown, requestedLimit: number): unknown[] {
  if (!safeIsArray(value)) return [];
  let rawLength: unknown;
  try {
    rawLength = value.length;
  } catch {
    return [];
  }
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) return [];
  const limit = Math.min(normalizeCollectionLimit(requestedLimit), TRANSCRIPT_ENTRY_LIMIT);
  const start = Math.max(0, rawLength - limit);
  const result: unknown[] = [];
  for (let index = start; index < rawLength; index++) {
    try {
      result.push(value[index]);
    } catch {
      result.push(undefined);
    }
  }
  return result;
}

function safeArrayPrefix(value: unknown, requestedLimit: number): unknown[] {
  if (!safeIsArray(value)) return [];
  let rawLength: unknown;
  try {
    rawLength = value.length;
  } catch {
    return [];
  }
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) return [];
  const count = Math.min(rawLength, normalizeCollectionLimit(requestedLimit));
  const result: unknown[] = [];
  for (let index = 0; index < count; index++) {
    try {
      result.push(value[index]);
    } catch {
      result.push(undefined);
    }
  }
  return result;
}

interface StructuralBudget {
  nodes: number;
  seen: WeakSet<object>;
}

function boundedStructure(value: unknown, depth: number, budget: StructuralBudget): unknown {
  if (budget.nodes >= STRUCTURAL_NODE_LIMIT) return "[node limit]";
  budget.nodes++;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return preview(value, STRUCTURAL_STRING_CHAR_LIMIT);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return preview(`${value}n`, STRUCTURAL_STRING_CHAR_LIMIT);
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return "[symbol]";
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object") return "[unavailable]";
  if (depth >= STRUCTURAL_DEPTH_LIMIT) return "[depth limit]";
  if (budget.seen.has(value)) return "[circular]";
  budget.seen.add(value);

  if (safeIsArray(value)) {
    const result: unknown[] = [];
    let rawLength: unknown;
    try { rawLength = value.length; } catch { return "[unavailable]"; }
    if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) return "[unavailable]";
    const count = Math.min(rawLength, STRUCTURAL_ENTRY_LIMIT);
    for (let index = 0; index < count && budget.nodes < STRUCTURAL_NODE_LIMIT; index++) {
      let item: unknown;
      try { item = value[index]; } catch { item = "[unavailable]"; }
      result.push(boundedStructure(item, depth + 1, budget));
    }
    if (rawLength > count) result.push(`[${rawLength - count} more items]`);
    return result;
  }

  const result: Record<string, unknown> = {};
  let count = 0;
  try {
    for (const key in value) {
      if (count >= STRUCTURAL_ENTRY_LIMIT || budget.nodes >= STRUCTURAL_NODE_LIMIT) break;
      let isOwn = false;
      try { isOwn = Object.prototype.hasOwnProperty.call(value, key); } catch { /* hostile proxy */ }
      if (!isOwn) continue;
      const safeKey = preview(key, STRUCTURAL_KEY_CHAR_LIMIT) || "[empty key]";
      let item: unknown;
      try { item = (value as Record<string, unknown>)[key]; } catch { item = "[unavailable]"; }
      result[safeKey] = boundedStructure(item, depth + 1, budget);
      count++;
    }
  } catch {
    result["[enumeration error]"] = true;
  }
  return result;
}

function boundedTranscriptContent(value: unknown): string {
  if (typeof value === "string") return preview(value, TRANSCRIPT_CHAR_LIMIT);
  const bounded = boundedStructure(value, 0, { nodes: 0, seen: new WeakSet() });
  try {
    return preview(JSON.stringify(bounded), TRANSCRIPT_CHAR_LIMIT);
  } catch {
    return "[unavailable]";
  }
}

function fitTranscriptBudget(entries: Array<{ type: string; content: string }>): Array<{ type: string; content: string }> {
  if (JSON.stringify(entries).length <= TRANSCRIPT_CHAR_LIMIT) return entries;
  let low = 0;
  let high = Math.max(0, ...entries.map((entry) => entry.content.length));
  let best = entries.map((entry) => ({ ...entry, content: "" }));
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = entries.map((entry) => ({ ...entry, content: preview(entry.content, middle) }));
    if (JSON.stringify(candidate).length <= TRANSCRIPT_CHAR_LIMIT) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function transcriptPreview(entries: unknown): unknown[] {
  const selected = safeArrayTail(entries, TRANSCRIPT_ENTRY_LIMIT);
  const result: Array<{ type: string; content: string }> = [];
  for (const entry of selected) {
    const record = safeRecord(entry);
    if (!record) continue;
    let typeValue: unknown;
    let contentValue: unknown;
    let textValue: unknown;
    typeValue = safeProperty(record, "type");
    contentValue = safeProperty(record, "content");
    if (contentValue === null || contentValue === undefined) textValue = safeProperty(record, "text");
    const type = preview(typeValue, TRANSCRIPT_TYPE_CHAR_LIMIT) || "message";
    const content = boundedTranscriptContent(contentValue ?? textValue ?? "");
    result.push({ type, content });
  }
  return fitTranscriptBudget(result);
}

export async function createProjectChatTools(options: CreateProjectChatToolsOptions): Promise<ProjectChatTools> {
  const { projectId, threadId, userId, storage, agentSessionManager, remoteSessions } = options;
  const project = await storage.projects.getById(projectId, userId);
  if (!project) throw new Error("Project not found");
  const thread = await storage.projectChatThreads.getById(threadId, projectId, userId);
  if (!thread) throw new Error("Project Chat thread not found");

  const touch = async (entityType: ProjectChatContextEntityType, entityId: string): Promise<void> => {
    const tracked = await storage.projectChatContextRefs.touch(threadId, projectId, userId, entityType, entityId);
    if (!tracked) throw new Error("Failed to track Project Chat context");
  };
  const touchAll = async (entityType: ProjectChatContextEntityType, ids: string[]): Promise<void> => {
    for (const id of ids) await touch(entityType, id);
  };

  return {
    get_project_summary: {
      description: "Return a safe summary of the current Project Chat project.",
      inputSchema: emptySchema,
      execute: async () => ({
        id: preview(project.id, ID_CHAR_LIMIT),
        name: preview(project.name, NAME_CHAR_LIMIT),
        executionTarget: preview(project.agent_mode, ENUM_CHAR_LIMIT),
      }),
    },
    list_tasks: {
      description: "List or search tasks in this project. Results are capped by the server.",
      inputSchema: z.object({
        query: z.string().max(256).optional(),
        status: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
      }).strict(),
      execute: async ({ query, status }) => {
        const rows = await storage.tasks.queryByProject(projectId, { query, status, limit: LIST_LIMIT });
        await touchAll("task", rows.map((row) => row.id));
        return {
          items: rows.map((row) => ({
            id: preview(row.id, ID_CHAR_LIMIT),
            title: preview(row.title, NAME_CHAR_LIMIT),
            description: nullablePreview(row.description, DESCRIPTION_CHAR_LIMIT),
            status: preview(row.status, ENUM_CHAR_LIMIT),
            priority: preview(row.priority, ENUM_CHAR_LIMIT),
            assignedBranch: nullablePreview(row.assigned_branch, BRANCH_CHAR_LIMIT),
          })),
          truncated: rows.length === LIST_LIMIT,
        };
      },
    },
    get_task: {
      description: "Inspect one task by id, only if it belongs to this project.",
      inputSchema: z.object({ taskId: z.string().min(1).max(256) }).strict(),
      execute: async ({ taskId }) => {
        const row = await storage.tasks.getById(taskId);
        if (!row) throw new Error("Task not found");
        if (row.project_id !== projectId) throw new Error("Object is not part of this project");
        await touch("task", row.id);
        return {
          id: preview(row.id, ID_CHAR_LIMIT),
          title: preview(row.title, NAME_CHAR_LIMIT),
          description: nullablePreview(row.description, DESCRIPTION_CHAR_LIMIT),
          status: preview(row.status, ENUM_CHAR_LIMIT),
          priority: preview(row.priority, ENUM_CHAR_LIMIT),
          assignedBranch: nullablePreview(row.assigned_branch, BRANCH_CHAR_LIMIT),
        };
      },
    },
    list_workspaces: {
      description: "List known local and remote workspaces for this project.",
      inputSchema: emptySchema,
      execute: async () => {
        const rows = await storage.searchCache.listWorkspacesByProject(projectId, LIST_LIMIT);
        const items = rows.map((row) => {
          const target = preview(row.targetId, TARGET_CHAR_LIMIT);
          const branch = nullablePreview(row.branch, BRANCH_CHAR_LIMIT);
          return {
            id: preview(`${target}:${branch ?? "main"}`, ID_CHAR_LIMIT * 2),
            target,
            branch,
          };
        });
        await touchAll("workspace", items.map((item) => item.id));
        return { items, truncated: rows.length === LIST_LIMIT };
      },
    },
    list_agent_sessions: {
      description: "List recent agent sessions across local and remote project workspaces.",
      inputSchema: emptySchema,
      execute: async () => {
        const [localRows, untrustedRemoteRows] = await Promise.all([
          storage.agentSessions.listByProject(projectId, LIST_LIMIT / 2),
          remoteSessions?.listByProject(projectId, LIST_LIMIT / 2) ?? Promise.resolve([]),
        ]);
        const remoteRows = safeArrayPrefix(untrustedRemoteRows, LIST_LIMIT / 2);
        const local: ProjectSessionSummary[] = localRows.map((row) => ({
          id: preview(row.id, ID_CHAR_LIMIT),
          projectId: preview(row.project_id, ID_CHAR_LIMIT),
          branch: nullablePreview(row.branch || null, BRANCH_CHAR_LIMIT),
          title: nullablePreview(row.title, NAME_CHAR_LIMIT),
          status: preview(row.status, ENUM_CHAR_LIMIT),
          target: "local",
          agentType: nullablePreview(row.agent_type, ENUM_CHAR_LIMIT),
          model: nullablePreview(row.model, MODEL_CHAR_LIMIT),
        }));
        const authorizedRemote: ProjectSessionSummary[] = [];
        for (const rowValue of remoteRows) {
          const row = safeRecord(rowValue);
          if (!row) continue;
          const rowProjectId = safeProperty(row, "projectId");
          if (rowProjectId !== projectId) continue;
          const rowId = safeProperty(row, "id");
          if (typeof rowId !== "string" || !rowId) continue;
          authorizedRemote.push({
            id: preview(rowId, ID_CHAR_LIMIT),
            projectId: preview(rowProjectId, ID_CHAR_LIMIT),
            branch: nullablePreview(safeProperty(row, "branch"), BRANCH_CHAR_LIMIT),
            title: nullablePreview(safeProperty(row, "title"), NAME_CHAR_LIMIT),
            status: preview(safeProperty(row, "status"), ENUM_CHAR_LIMIT),
            target: preview(safeProperty(row, "target"), TARGET_CHAR_LIMIT),
            agentType: nullablePreview(safeProperty(row, "agentType"), ENUM_CHAR_LIMIT),
            model: nullablePreview(safeProperty(row, "model"), MODEL_CHAR_LIMIT),
          });
        }
        const items = [...local, ...authorizedRemote].slice(0, LIST_LIMIT);
        await touchAll("agent_session", items.map((item) => item.id));
        return {
          items,
          truncated: localRows.length === LIST_LIMIT / 2 || remoteRows.length === LIST_LIMIT / 2,
        };
      },
    },
    get_agent_session: {
      description: "Return status and a server-bounded recent transcript for one project agent session.",
      inputSchema: z.object({ sessionId: z.string().min(1).max(512) }).strict(),
      execute: async ({ sessionId }) => {
        const local = await storage.agentSessions.getById(sessionId);
        if (local) {
          if (local.project_id !== projectId) throw new Error("Object is not part of this project");
          const detail: ProjectSessionDetail = {
            id: preview(local.id, ID_CHAR_LIMIT),
            projectId: preview(local.project_id, ID_CHAR_LIMIT),
            branch: nullablePreview(local.branch || null, BRANCH_CHAR_LIMIT),
            title: nullablePreview(local.title, NAME_CHAR_LIMIT),
            status: preview(local.status, ENUM_CHAR_LIMIT),
            target: "local",
            agentType: nullablePreview(local.agent_type, ENUM_CHAR_LIMIT),
            model: nullablePreview(local.model, MODEL_CHAR_LIMIT),
            processAlive: agentSessionManager.getSessionProcessAlive(local.id),
            transcript: transcriptPreview(agentSessionManager.getMessages(local.id)),
          };
          await touch("agent_session", local.id);
          return detail;
        }
        const mappingValue: unknown = await remoteSessions?.getMapping(sessionId);
        const mappingRecord = safeRecord(mappingValue);
        if (!mappingRecord) throw new Error("Agent session not found");
        const mappingId = safeProperty(mappingRecord, "id");
        const mappingProjectId = safeProperty(mappingRecord, "projectId");
        const mappingRemoteServerId = safeProperty(mappingRecord, "remoteServerId");
        const mappingRemoteSessionId = safeProperty(mappingRecord, "remoteSessionId");
        const mappingBranch = safeProperty(mappingRecord, "branch");
        if (typeof mappingId !== "string" || typeof mappingProjectId !== "string"
          || typeof mappingRemoteServerId !== "string" || typeof mappingRemoteSessionId !== "string") {
          throw new Error("Agent session not found");
        }
        if (mappingProjectId !== projectId) throw new Error("Object is not part of this project");
        const mapping: RemoteProjectSessionMapping = {
          id: mappingId,
          projectId: mappingProjectId,
          remoteServerId: mappingRemoteServerId,
          remoteSessionId: mappingRemoteSessionId,
          branch: typeof mappingBranch === "string" ? mappingBranch : null,
        };
        const remoteValue: unknown = await remoteSessions?.getDetail(mapping, {
          maxEntries: TRANSCRIPT_ENTRY_LIMIT, maxChars: TRANSCRIPT_CHAR_LIMIT,
        });
        const remote = safeRecord(remoteValue);
        if (!remote) throw new Error("Agent session not found");
        const remoteId = safeProperty(remote, "id");
        const remoteProjectId = safeProperty(remote, "projectId");
        if (typeof remoteId !== "string" || typeof remoteProjectId !== "string") {
          throw new Error("Agent session not found");
        }
        if (remoteProjectId !== projectId || remoteId !== mapping.id) {
          throw new Error("Object is not part of this project");
        }
        const remoteProcessAlive = safeProperty(remote, "processAlive");
        const remoteTranscript = safeProperty(remote, "transcript");
        const detail: ProjectSessionDetail = {
          id: preview(remoteId, ID_CHAR_LIMIT),
          projectId: preview(remoteProjectId, ID_CHAR_LIMIT),
          branch: nullablePreview(safeProperty(remote, "branch"), BRANCH_CHAR_LIMIT),
          title: nullablePreview(safeProperty(remote, "title"), NAME_CHAR_LIMIT),
          status: preview(safeProperty(remote, "status"), ENUM_CHAR_LIMIT) || "unknown",
          target: preview(safeProperty(remote, "target"), TARGET_CHAR_LIMIT),
          agentType: nullablePreview(safeProperty(remote, "agentType"), ENUM_CHAR_LIMIT),
          model: nullablePreview(safeProperty(remote, "model"), MODEL_CHAR_LIMIT),
          processAlive: typeof remoteProcessAlive === "boolean" ? remoteProcessAlive : false,
          transcript: transcriptPreview(remoteTranscript),
        };
        await touch("agent_session", mapping.id);
        return detail;
      },
    },
    list_schedules: {
      description: "List schedules configured for this project without commands, prompts, or raw configuration.",
      inputSchema: emptySchema,
      execute: async () => {
        const rows = await storage.scheduledTasks.listByProject(projectId, LIST_LIMIT);
        await touchAll("schedule", rows.map((row) => row.id));
        return {
          items: rows.map((row) => ({
            id: preview(row.id, ID_CHAR_LIMIT),
            name: preview(row.name, NAME_CHAR_LIMIT),
            enabled: row.enabled,
            cron: preview(row.cron_expr, CRON_CHAR_LIMIT),
            timezone: preview(row.timezone, TIMEZONE_CHAR_LIMIT),
            runType: preview(row.run_type, ENUM_CHAR_LIMIT),
            target: preview(row.target, TARGET_CHAR_LIMIT),
            branch: nullablePreview(row.branch, BRANCH_CHAR_LIMIT),
          })),
          truncated: rows.length === LIST_LIMIT,
        };
      },
    },
    list_schedule_runs: {
      description: "List recent runs across this project's schedules without raw output or reports.",
      inputSchema: emptySchema,
      execute: async () => {
        const rows = await storage.scheduledTaskRuns.listRecentByProject(projectId, LIST_LIMIT);
        await touchAll("schedule_run", rows.map((row) => row.id));
        return {
          items: rows.map((row) => ({
            id: preview(row.id, ID_CHAR_LIMIT),
            scheduleId: preview(row.schedule_id, ID_CHAR_LIMIT),
            status: preview(row.status, ENUM_CHAR_LIMIT),
            exitCode: row.exit_code,
            startedAt: preview(row.started_at, TIMESTAMP_CHAR_LIMIT),
            finishedAt: nullablePreview(row.finished_at, TIMESTAMP_CHAR_LIMIT),
          })),
          truncated: rows.length === LIST_LIMIT,
        };
      },
    },
    get_schedule_run: {
      description: "Inspect one project schedule run with server-bounded output and report previews.",
      inputSchema: z.object({ runId: z.string().min(1).max(256) }).strict(),
      execute: async ({ runId }) => {
        const run = await storage.scheduledTaskRuns.getById(runId);
        if (!run) throw new Error("Schedule run not found");
        const schedule = await storage.scheduledTasks.getById(run.schedule_id);
        if (!schedule) throw new Error("Schedule run not found");
        if (schedule.project_id !== projectId) throw new Error("Object is not part of this project");
        await touch("schedule_run", run.id);
        return {
          id: preview(run.id, ID_CHAR_LIMIT),
          scheduleId: preview(run.schedule_id, ID_CHAR_LIMIT),
          status: preview(run.status, ENUM_CHAR_LIMIT),
          exitCode: run.exit_code,
          startedAt: preview(run.started_at, TIMESTAMP_CHAR_LIMIT),
          finishedAt: nullablePreview(run.finished_at, TIMESTAMP_CHAR_LIMIT),
          outputPreview: preview(run.output, RUN_PREVIEW_CHAR_LIMIT),
          reportPreview: preview(run.report, RUN_PREVIEW_CHAR_LIMIT),
        };
      },
    },
  };
}
