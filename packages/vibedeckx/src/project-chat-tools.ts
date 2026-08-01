import { randomUUID } from "crypto";
import { z } from "zod";
import type {
  ProjectChatContextEntityType,
  ProjectChatOperationPayload,
  Storage,
} from "./storage/types.js";
export { projectChatPublicOperationContent } from "./project-chat-public-operation.js";
import { projectChatPublicOperationContent } from "./project-chat-public-operation.js";
import { sanitizeProjectChatPublicError } from "./project-chat-public-error.js";

const LIST_LIMIT = 20;
const TRANSCRIPT_ENTRY_LIMIT = 20;
const TRANSCRIPT_CHAR_LIMIT = 6_000;
const RUN_PREVIEW_CHAR_LIMIT = 4_000;
const ID_CHAR_LIMIT = 512;
export const MAX_TOOL_SELECTOR_ID = 512;
const CANONICAL_ID_CHAR_LIMIT = 65_536;
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
const LIST_NAME_CHAR_LIMIT = 256;
const LIST_DESCRIPTION_CHAR_LIMIT = 512;
const LIST_BRANCH_CHAR_LIMIT = 256;
const LIST_TARGET_CHAR_LIMIT = 256;
const LIST_MODEL_CHAR_LIMIT = 128;

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
      const unscoped = await options.storage.remoteSessionMappings.getByLocal(sessionId);
      if (!unscoped) return undefined;
      const row = await options.storage.remoteSessionMappings.getAuthorizedByLocal(sessionId, unscoped.project_id);
      return row ? {
        id: row.local_session_id,
        projectId: row.project_id,
        remoteServerId: row.remote_server_id,
        remoteSessionId: row.remote_session_id,
        branch: row.branch,
      } : undefined;
    },
    getDetail: async (mapping, limits) => {
      const association = await options.storage.projectRemotes.getByProjectAndServer(
        mapping.projectId,
        mapping.remoteServerId,
      );
      if (!association) return undefined;
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
  create_task: ProjectChatTool<{
    title: string; description?: string | null; status?: "todo" | "in_progress" | "done" | "cancelled";
    priority?: "low" | "medium" | "high" | "urgent"; assignedBranch?: string | null;
  }, Record<string, unknown>>;
  update_task: ProjectChatTool<{
    taskId: string; title?: string; description?: string | null;
    status?: "todo" | "in_progress" | "done" | "cancelled";
    priority?: "low" | "medium" | "high" | "urgent"; assignedBranch?: string | null;
  }, Record<string, unknown>>;
  create_agent_session: ProjectChatTool<{
    workspaceId?: string; instruction: string; permissionMode?: "plan" | "edit";
    agentType?: "claude-code" | "codex"; model?: string | null;
  }, Record<string, unknown>>;
  select_workspace: ProjectChatTool<{ requestId: string; workspaceId: string }, Record<string, unknown>>;
  send_agent_instruction: ProjectChatTool<{ sessionId: string; instruction: string }, Record<string, unknown>>;
  run_schedule_now: ProjectChatTool<{ scheduleId: string }, Record<string, unknown>>;
};

export interface ProjectChatMutationServices {
  createAgentSession(input: {
    sessionId: string; workerSessionId: string; idempotencyKey: string; projectId: string; userId: string;
    target: string; branch: string | null; instruction: string;
    permissionMode: "plan" | "edit"; agentType: "claude-code" | "codex"; model: string | null;
  }): Promise<{ sessionId: string }>;
  /**
   * At-least-once across process crashes. Callers persist `idempotencyKey`
   * before invoking this method and confirm delivery only after it resolves
   * true. Local raw stdin cannot close the write-before-confirm crash window;
   * remote transports receive the stable key when their endpoint supports it.
   */
  sendAgentInstruction(input: {
    projectId: string; userId: string; sessionId: string; instruction: string;
    idempotencyKey: string;
    target: "local" | { remoteServerId: string; remoteSessionId: string };
  }): Promise<boolean>;
  runScheduleNow(scheduleId: string, runId: string): Promise<
    { runId: string; skipped: boolean } | { error: string }
  >;
}

export interface CreateProjectChatToolsOptions {
  projectId: string;
  threadId: string;
  userId: string;
  storage: Storage;
  agentSessionManager: ProjectAgentSessionReader;
  remoteSessions?: RemoteProjectSessionReader;
  mutationServices?: ProjectChatMutationServices;
  /** Best-effort live projection after the operation message is durable. */
  onOperationMessage?: (message: import("./storage/types.js").ProjectChatMessage) => Promise<void> | void;
}

const emptySchema = z.object({}).strict();
const selectorSchema = z.string().min(1).max(MAX_TOOL_SELECTOR_ID);
const taskStatusSchema = z.enum(["todo", "in_progress", "done", "cancelled"]);
const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(NAME_CHAR_LIMIT),
  description: z.string().max(DESCRIPTION_CHAR_LIMIT).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assignedBranch: z.string().max(BRANCH_CHAR_LIMIT).nullable().optional(),
}).strict();
const updateTaskSchema = z.object({
  taskId: selectorSchema,
  title: z.string().trim().min(1).max(NAME_CHAR_LIMIT).optional(),
  description: z.string().max(DESCRIPTION_CHAR_LIMIT).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assignedBranch: z.string().max(BRANCH_CHAR_LIMIT).nullable().optional(),
}).strict().refine(({ taskId: _taskId, ...patch }) => Object.values(patch).some((value) => value !== undefined), {
  message: "At least one task field is required",
});
const instructionSchema = z.string().trim().min(1).max(8_000);
const createSessionSchema = z.object({
  workspaceId: selectorSchema.optional(),
  instruction: instructionSchema,
  permissionMode: z.enum(["plan", "edit"]).optional(),
  agentType: z.enum(["claude-code", "codex"]).optional(),
  model: z.string().trim().min(1).max(MODEL_CHAR_LIMIT).nullable().optional(),
}).strict();
const pendingSessionOperationSchema = z.object({
  version: z.literal(1),
  kind: z.literal("agent_session_create"),
  operationId: selectorSchema,
  status: z.literal("pending"),
  phase: z.literal("workspace_selection"),
  requestId: selectorSchema,
  sessionId: selectorSchema,
  workerSessionId: selectorSchema,
  instruction: instructionSchema,
  permissionMode: z.enum(["plan", "edit"]),
  agentType: z.enum(["claude-code", "codex"]),
  model: z.string().max(MODEL_CHAR_LIMIT).nullable(),
  initialInstructionDelivery: z.literal("pending"),
  candidates: z.array(z.object({
    id: selectorSchema, target: z.string().min(1).max(TARGET_CHAR_LIMIT),
    branch: z.string().max(BRANCH_CHAR_LIMIT).nullable(),
  }).strict()).max(LIST_LIMIT),
}).strict();
const activeSessionOperationSchema = z.object({
  version: z.literal(1), kind: z.literal("agent_session_create"),
  operationId: selectorSchema, status: z.enum(["running", "completed"]),
  sessionId: selectorSchema, workspaceId: selectorSchema,
  initialInstructionDelivery: z.literal("confirmed"),
}).passthrough();
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

function safePropertyRead(
  value: Record<PropertyKey, unknown>,
  key: PropertyKey,
): { readable: true; value: unknown } | { readable: false } {
  try {
    return { readable: true, value: value[key] };
  } catch {
    return { readable: false };
  }
}

function normalizeCollectionLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= CANONICAL_ID_CHAR_LIMIT && !value.includes("\0");
}

function isToolSelectorId(value: unknown): value is string {
  return isCanonicalId(value) && value.length <= MAX_TOOL_SELECTOR_ID;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || isNullableString(value);
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
  const {
    projectId, threadId, userId, storage, agentSessionManager, remoteSessions, mutationServices,
    onOperationMessage,
  } = options;
  const project = await storage.projects.getById(projectId, userId);
  if (!project) throw new Error("Project not found");
  const thread = await storage.projectChatThreads.getById(threadId, projectId, userId);
  if (!thread) throw new Error("Project Chat thread not found");

  const touchAll = async (entityType: ProjectChatContextEntityType, ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    const tracked = await storage.projectChatContextRefs.touchMany(
      threadId,
      projectId,
      userId,
      ids.map((entityId) => ({ entityType, entityId })),
    );
    if (!tracked) throw new Error("Failed to track Project Chat context");
  };
  const touch = async (entityType: ProjectChatContextEntityType, entityId: string): Promise<void> =>
    touchAll(entityType, [entityId]);

  const mutationService = (): ProjectChatMutationServices => {
    if (!mutationServices) throw new Error("Project Chat mutations are not configured");
    return mutationServices;
  };
  const revalidateScope = async (): Promise<void> => {
    const [ownedProject, ownedThread] = await Promise.all([
      storage.projects.getById(projectId, userId),
      storage.projectChatThreads.getById(threadId, projectId, userId),
    ]);
    if (!ownedProject || !ownedThread) throw new Error("Project Chat scope is no longer authorized");
  };
  const readInScope = <Args, Result>(
    execute: (args: Args) => Promise<Result>,
  ): ((args: Args) => Promise<Result>) => async (args) => {
    await revalidateScope();
    return execute(args);
  };
  const boundedError = (error: unknown): string => {
    return sanitizeProjectChatPublicError(error, "Mutation failed");
  };
  const operationPayload = (
    kind: Parameters<Storage["projectChatOperations"]["create"]>[0]["kind"],
    operationId: string,
    status: Parameters<Storage["projectChatOperations"]["transition"]>[0]["status"],
    details: Record<string, unknown>,
  ) => ({ version: 1 as const, kind, operationId, status, ...details }) as Parameters<Storage["projectChatOperations"]["create"]>[0]["payload"];
  const beginOperation = async (
    kind: Parameters<Storage["projectChatOperations"]["create"]>[0]["kind"],
    entityType: ProjectChatContextEntityType | null,
    entityId: string | null,
    details: Record<string, unknown>,
    ids: { operationId?: string; idempotencyKey?: string } = {},
  ) => {
    const operationId = ids.operationId ?? randomUUID();
    const idempotencyKey = ids.idempotencyKey ?? operationId;
    const row = await storage.projectChatOperations.create({
      id: operationId, thread_id: threadId, project_id: projectId, user_id: userId,
      kind, status: "pending", entity_type: entityType, entity_id: entityId,
      idempotency_key: idempotencyKey,
      payload: operationPayload(kind, operationId, "pending", details), error: null,
    });
    if (!row) throw new Error("Failed to record Project Chat operation");
    return row;
  };
  const finishOperation = async (
    operation: Awaited<ReturnType<typeof beginOperation>>,
    status: "running" | "completed" | "failed",
    details: Record<string, unknown>,
    error: string | null = null,
  ) => {
    const current = await storage.projectChatOperations.getById(
      operation.id, threadId, projectId, userId,
    );
    if (!current) throw new Error("Project Chat operation not found");
    const publicError = error === null ? null : sanitizeProjectChatPublicError(error, "Operation failed");
    const payload = { ...current.payload, status, ...details } as ProjectChatOperationPayload;
    const content = projectChatPublicOperationContent(payload, publicError);
    const result = await storage.projectChatOperations.transition({
      id: operation.id, thread_id: threadId, project_id: projectId, user_id: userId,
      status, payload, error: publicError,
      message: { id: `operation:${operation.id}:${status}`, content },
    });
    if (!result) throw new Error("Failed to update Project Chat operation");
    if (result.changed && onOperationMessage) {
      try { await onOperationMessage(result.message); } catch { /* durable state remains authoritative */ }
    }
    return result.operation;
  };
  const markOperationRunning = async (
    operation: Awaited<ReturnType<typeof beginOperation>>,
    details: Record<string, unknown>,
  ) => {
    const current = await storage.projectChatOperations.getById(
      operation.id, threadId, projectId, userId,
    );
    if (!current) throw new Error("Project Chat operation not found");
    if (current.status === "completed" || current.status === "failed" || current.status === "running") {
      return current;
    }
    return finishOperation(current, "running", details);
  };
  const workspaceCandidates = async () => {
    const project = await storage.projects.getById(projectId, userId);
    if (!project) throw new Error("Project is no longer authorized");
    const rows = await storage.searchCache.listWorkspacesByProject(projectId, LIST_LIMIT + 1);
    const candidates = rows.flatMap((row) => {
      if (typeof row.targetId !== "string" || !isNullableString(row.branch)) return [];
      if (row.targetId.length > TARGET_CHAR_LIMIT || (row.branch?.length ?? 0) > BRANCH_CHAR_LIMIT) return [];
      const id = JSON.stringify([row.targetId, row.branch]);
      if (!isToolSelectorId(id)) return [];
      return [{ id, target: row.targetId, branch: row.branch }];
    });
    const authorized = await Promise.all(candidates.map(async (candidate) => candidate.target === "local"
      ? candidate
      : (await storage.projectRemotes.getByProjectAndServer(projectId, candidate.target)) ? candidate : undefined));
    const available = authorized.filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    return { items: available.slice(0, LIST_LIMIT), truncated: available.length > LIST_LIMIT };
  };
  const validateAssignedBranch = async (branch: string | null | undefined): Promise<void> => {
    if (branch === null || branch === undefined) return;
    if (!(await workspaceCandidates()).items.some((workspace) => workspace.branch === branch)) {
      throw new Error("Assigned branch is not an available workspace in this project");
    }
  };
  const resolveWorkspace = async (workspaceId: string) => {
    const candidate = (await workspaceCandidates()).items.find(({ id }) => id === workspaceId);
    if (!candidate) throw new Error("Workspace is no longer available in this project");
    if (candidate.target !== "local") {
      const association = await storage.projectRemotes.getByProjectAndServer(projectId, candidate.target);
      if (!association) throw new Error("Workspace is no longer available in this project");
    }
    return candidate;
  };
  const sessionExistsInScope = async (sessionId: string): Promise<boolean> => {
    const local = await storage.agentSessions.getById(sessionId);
    if (local) return local.project_id === projectId;
    const mapping = await remoteSessions?.getMapping(sessionId);
    if (!mapping || mapping.projectId !== projectId) return false;
    return Boolean(await storage.projectRemotes.getByProjectAndServer(
      projectId, mapping.remoteServerId,
    ));
  };
  const rereadConfirmedSession = async (
    operation: Awaited<ReturnType<typeof beginOperation>>, sessionId: string,
  ) => {
    const local = await storage.agentSessions.getById(sessionId);
    if (local?.project_id === projectId && local.status !== "running") {
      const status = local.status === "stopped" && local.last_completed_at ? "completed" : "failed";
      return finishOperation(operation, status, { sessionId }, status === "failed" ? "Agent session failed" : null);
    }
    const mapping = await remoteSessions?.getMapping(sessionId);
    if (mapping?.projectId === projectId) {
      const detail = await remoteSessions?.getDetail(mapping, { maxEntries: 1, maxChars: 256 });
      if (detail?.status === "stopped" || detail?.status === "error") {
        const status = detail.status === "stopped" ? "completed" : "failed";
        return finishOperation(operation, status, { sessionId }, status === "failed" ? "Agent session failed" : null);
      }
    }
    return operation;
  };
  const canonicalSessionId = (
    workspace: { target: string; branch: string | null }, seed: string,
  ): string => {
    const sessionId = workspace.target === "local"
      ? seed
      : `remote-${workspace.target}-${projectId}-${seed}`;
    if (!isToolSelectorId(sessionId)) throw new Error("Workspace identity is too long for a session handle");
    return sessionId;
  };

  return {
    create_task: {
      description: "Create a task in this project.",
      inputSchema: createTaskSchema,
      execute: async ({ title, description, status, priority, assignedBranch }) => {
        mutationService();
        await revalidateScope();
        await validateAssignedBranch(assignedBranch);
        const taskId = randomUUID();
        const operation = await beginOperation("task_create", "task", taskId, {
          taskId, title, description: description ?? null, taskStatus: status ?? "todo",
          priority: priority ?? "medium", assignedBranch: assignedBranch ?? null,
        });
        try {
          await revalidateScope();
          await validateAssignedBranch(assignedBranch);
          const task = await storage.tasks.create({
            id: taskId, project_id: projectId, title, description, status, priority,
            assigned_branch: assignedBranch,
          });
          await touch("task", task.id);
          await finishOperation(operation, "completed", { taskId: task.id, title: task.title });
          return { ok: true, operationId: operation.id, taskId: task.id, status: "completed" };
        } catch (error) {
          const message = boundedError(error);
          const applied = await storage.tasks.getById(taskId);
          if (applied?.project_id === projectId) {
            return { ok: false, operationId: operation.id, taskId, status: "pending",
              retryable: true, error: "Task was created; confirmation is pending" };
          }
          await finishOperation(operation, "failed", { taskId }, message);
          return { ok: false, operationId: operation.id, status: "failed", error: message };
        }
      },
    },
    update_task: {
      description: "Update an existing task in this project.",
      inputSchema: updateTaskSchema,
      execute: async ({ taskId, assignedBranch, ...patch }) => {
        mutationService();
        await revalidateScope();
        const target = await storage.tasks.getById(taskId);
        if (!target) throw new Error("Task not found");
        if (target.project_id !== projectId) throw new Error("Object is not part of this project");
        await validateAssignedBranch(assignedBranch);
        const operationPatch = {
          ...patch, ...(assignedBranch !== undefined ? { assignedBranch } : {}),
        };
        const operation = await beginOperation("task_update", "task", taskId, {
          taskId, patch: operationPatch,
          before: {
            title: target.title, description: target.description, status: target.status,
            priority: target.priority, assignedBranch: target.assigned_branch,
          },
        });
        try {
          await revalidateScope();
          const current = await storage.tasks.getById(taskId);
          if (!current || current.project_id !== projectId) throw new Error("Task is no longer authorized");
          await validateAssignedBranch(assignedBranch);
          const updated = await storage.tasks.update(taskId, {
            ...patch, ...(assignedBranch !== undefined ? { assigned_branch: assignedBranch } : {}),
          });
          if (!updated) throw new Error("Task update failed");
          await touch("task", taskId);
          await finishOperation(operation, "completed", { taskId, title: updated.title });
          return { ok: true, operationId: operation.id, taskId, status: "completed" };
        } catch (error) {
          const message = boundedError(error);
          const applied = await storage.tasks.getById(taskId);
          const current = applied && {
            title: applied.title, description: applied.description, status: applied.status,
            priority: applied.priority, assignedBranch: applied.assigned_branch,
          };
          if (applied?.project_id === projectId && current
            && Object.entries(operationPatch).every(([key, value]) => current[key as keyof typeof current] === value)) {
            return { ok: false, operationId: operation.id, taskId, status: "pending",
              retryable: true, error: "Task was updated; confirmation is pending" };
          }
          await finishOperation(operation, "failed", { taskId }, message);
          return { ok: false, operationId: operation.id, status: "failed", error: message };
        }
      },
    },
    create_agent_session: {
      description: "Create an agent session in an explicitly selected existing workspace.",
      inputSchema: createSessionSchema,
      execute: async ({ workspaceId, instruction, permissionMode = "edit", agentType = "claude-code", model = null }) => {
        const service = mutationService();
        await revalidateScope();
        const operationId = randomUUID();
        const sessionSeed = randomUUID();
        const candidates = (await workspaceCandidates()).items;
        if (!workspaceId) {
          const operation = await beginOperation("agent_session_create", null, null, {
            phase: "workspace_selection", requestId: operationId, sessionId: sessionSeed,
            workerSessionId: sessionSeed, instruction,
            permissionMode, agentType, model,
            initialInstructionDelivery: "pending",
            candidates: candidates.map(({ id, target, branch }) => ({ id, target, branch })),
          }, { operationId, idempotencyKey: `session:${sessionSeed}` });
          const selectionContent = projectChatPublicOperationContent(operationPayload(
            "workspace_selection", operation.id, "pending",
            { requestId: operation.id, candidates: candidates.map(({ id, target, branch }) => ({ id, target, branch })) },
          ));
          const announced = await storage.projectChatOperations.announce({
            id: operation.id, thread_id: threadId, project_id: projectId, user_id: userId,
            message: { id: `operation:${operation.id}:workspace_selection`, content: selectionContent },
          });
          if (!announced) throw new Error("Failed to publish workspace selection request");
          if (onOperationMessage) {
            try { await onOperationMessage(announced); } catch { /* snapshot/reconnect recovers it */ }
          }
          return {
            ok: false, status: "workspace_selection_required", operationId: operation.id,
            requestId: operation.id,
            candidates: candidates.map(({ id, target, branch }) => ({ id, target, branch })),
          };
        }
        const workspace = await resolveWorkspace(workspaceId);
        const sessionId = canonicalSessionId(workspace, sessionSeed);
        const operation = await beginOperation("agent_session_create", "agent_session", sessionId, {
          sessionId, workerSessionId: sessionSeed, workspaceId, target: workspace.target, branch: workspace.branch,
          instruction, permissionMode, agentType, model,
          initialInstructionDelivery: "pending",
        }, { operationId, idempotencyKey: `session:${sessionId}` });
        try {
          await revalidateScope();
          await resolveWorkspace(workspaceId);
          const created = await service.createAgentSession({
            sessionId, workerSessionId: sessionSeed,
            idempotencyKey: operation.idempotency_key, projectId, userId,
            target: workspace.target, branch: workspace.branch, instruction,
            permissionMode, agentType, model,
          });
          if (created.sessionId !== sessionId) throw new Error("Session identity mismatch");
          await touchAll("workspace", [workspaceId]);
          await touch("agent_session", sessionId);
          const running = await markOperationRunning(operation, {
            sessionId, workspaceId, initialInstructionDelivery: "confirmed",
          });
          const latest = await rereadConfirmedSession(running, sessionId);
          return { ok: latest.status !== "failed", operationId: operation.id, sessionId, status: latest.status };
        } catch (error) {
          if (await sessionExistsInScope(sessionId)) {
            return {
              ok: false, operationId: operation.id, sessionId, status: "pending",
              error: "Agent session creation is awaiting delivery confirmation",
            };
          }
          const message = boundedError(error);
          await finishOperation(operation, "failed", { sessionId, workspaceId }, message);
          return { ok: false, operationId: operation.id, status: "failed", error: message };
        }
      },
    },
    select_workspace: {
      description: "Resolve a pending agent-session workspace selection request.",
      inputSchema: z.object({ requestId: selectorSchema, workspaceId: selectorSchema }).strict(),
      execute: async ({ requestId, workspaceId }) => {
        const service = mutationService();
        await revalidateScope();
        const operation = await storage.projectChatOperations.getById(
          requestId, threadId, projectId, userId,
        );
        if (!operation || operation.kind !== "agent_session_create") {
          throw new Error("Workspace selection request not found");
        }
        const decoded: unknown = operation.payload;
        if (operation.status === "running" || operation.status === "completed") {
          const active = activeSessionOperationSchema.safeParse(decoded);
          if (!active.success || active.data.workspaceId !== workspaceId) {
            throw new Error("Workspace selection request is already resolved");
          }
          return {
            ok: true, operationId: operation.id, sessionId: active.data.sessionId,
            status: active.data.status,
          };
        }
        if (operation.status === "resolving") {
          if (operation.payload.kind !== "agent_session_create"
            || operation.payload.selectedWorkspaceId !== workspaceId) {
            throw new Error("Workspace selection request is already resolved to another workspace");
          }
          let current = operation;
          for (let attempt = 0; attempt < 100 && current.status === "resolving"; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            current = await storage.projectChatOperations.getById(
              requestId, threadId, projectId, userId,
            ) ?? current;
          }
          if (current.status === "running" || current.status === "completed") {
            return { ok: true, operationId: current.id, sessionId: operation.payload.sessionId, status: current.status };
          }
          if (current.status === "failed") {
            return { ok: false, operationId: current.id, status: "failed", error: current.error ?? "Agent session creation failed" };
          }
          return {
            ok: false, operationId: current.id, sessionId: operation.payload.sessionId,
            status: "resolving", retryable: true,
            error: "Workspace selection resolution is still in progress",
          };
        }
        if (operation.status !== "pending") {
          throw new Error("Workspace selection request is already resolved");
        }
        const pending = pendingSessionOperationSchema.safeParse(decoded);
        if (!pending.success || pending.data.requestId !== requestId) {
          throw new Error("Workspace selection request is invalid");
        }
        if (!pending.data.candidates.some(({ id }) => id === workspaceId)) {
          throw new Error("Workspace was not offered by this selection request");
        }
        const workspace = await resolveWorkspace(workspaceId);
        const sessionId = canonicalSessionId(workspace, pending.data.sessionId);
        const claimToken = randomUUID();
        const resolvingPayload = {
          ...pending.data, version: 1 as const, kind: "agent_session_create" as const,
          operationId: operation.id,
          status: "resolving" as const,
          sessionId, workerSessionId: pending.data.workerSessionId,
          workspaceId, selectedWorkspaceId: workspaceId,
          claimToken, target: workspace.target, branch: workspace.branch,
          initialInstructionDelivery: "pending" as const,
        };
        const claim = await storage.projectChatOperations.claimWorkspaceSelection({
          id: operation.id, thread_id: threadId, project_id: projectId, user_id: userId,
          workspace_id: workspaceId, session_id: sessionId, claim_token: claimToken,
          payload: resolvingPayload,
          message: {
            id: `operation:${operation.id}:resolving`,
            content: projectChatPublicOperationContent(resolvingPayload),
          },
        });
        if (!claim) throw new Error("Workspace selection request not found");
        if (claim.claimed && claim.message && onOperationMessage) {
          try { await onOperationMessage(claim.message); } catch { /* snapshot/reconnect recovers it */ }
        }
        let correlated = claim.operation;
        if (!claim.claimed) {
          if (correlated.payload.kind !== "agent_session_create"
            || correlated.payload.selectedWorkspaceId !== workspaceId) {
            throw new Error("Workspace selection request is already resolved to another workspace");
          }
          for (let attempt = 0; attempt < 100 && correlated.status === "resolving"; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            correlated = await storage.projectChatOperations.getById(
              requestId, threadId, projectId, userId,
            ) ?? correlated;
          }
          if (correlated.status === "running" || correlated.status === "completed") {
            return { ok: true, operationId: correlated.id, sessionId, status: correlated.status };
          }
          if (correlated.status === "failed") {
            return { ok: false, operationId: correlated.id, status: "failed", error: correlated.error ?? "Agent session creation failed" };
          }
          return {
            ok: false, operationId: correlated.id, sessionId,
            status: "resolving", retryable: true,
            error: "Workspace selection resolution is still in progress",
          };
        }
        let created = false;
        let failure: unknown;
        try {
          await revalidateScope();
          await resolveWorkspace(workspaceId);
          const result = await service.createAgentSession({
            sessionId, workerSessionId: pending.data.workerSessionId,
            idempotencyKey: operation.idempotency_key, projectId, userId,
            target: workspace.target, branch: workspace.branch,
            instruction: pending.data.instruction,
            permissionMode: pending.data.permissionMode,
            agentType: pending.data.agentType,
            model: pending.data.model,
          });
          created = result.sessionId === sessionId;
          if (!created) failure = new Error("Session identity mismatch");
        } catch (error) {
          failure = error;
          if (await sessionExistsInScope(sessionId)) {
            return {
              ok: false, operationId: operation.id, sessionId, status: "pending",
              error: "Agent session creation is awaiting delivery confirmation",
            };
          }
        }
        if (!created) {
          const message = boundedError(failure ?? new Error("Agent session creation failed"));
          await finishOperation(correlated, "failed", { sessionId, workspaceId }, message);
          return { ok: false, operationId: operation.id, status: "failed", error: message };
        }
        await touchAll("workspace", [workspaceId]);
        await touch("agent_session", sessionId);
        const running = await markOperationRunning(correlated, {
          sessionId, workspaceId, initialInstructionDelivery: "confirmed",
        });
        const latest = await rereadConfirmedSession(running, sessionId);
        return { ok: latest.status !== "failed", operationId: operation.id, sessionId, status: latest.status };
      },
    },
    send_agent_instruction: {
      description: "Send a supplemental instruction to an existing agent session in this project.",
      inputSchema: z.object({ sessionId: selectorSchema, instruction: instructionSchema }).strict(),
      execute: async ({ sessionId, instruction }) => {
        const service = mutationService();
        await revalidateScope();
        const local = await storage.agentSessions.getById(sessionId);
        let target: "local" | { remoteServerId: string; remoteSessionId: string };
        if (local) {
          if (local.project_id !== projectId) throw new Error("Object is not part of this project");
          target = "local";
        } else {
          const mapping = await remoteSessions?.getMapping(sessionId);
          if (!mapping) throw new Error("Agent session not found");
          if (mapping.projectId !== projectId) throw new Error("Object is not part of this project");
          const association = await storage.projectRemotes.getByProjectAndServer(projectId, mapping.remoteServerId);
          if (!association) throw new Error("Agent session not found");
          target = { remoteServerId: mapping.remoteServerId, remoteSessionId: mapping.remoteSessionId };
        }
        const operation = await beginOperation("agent_instruction", "agent_session", sessionId, {
          sessionId, instruction, target, delivery: "pending",
        });
        let deliveryAttempted = false;
        try {
          await revalidateScope();
          if (target === "local") {
            const current = await storage.agentSessions.getById(sessionId);
            if (!current || current.project_id !== projectId) {
              throw new Error("Agent session is no longer authorized");
            }
          } else {
            const current = await remoteSessions?.getMapping(sessionId);
            if (!current || current.projectId !== projectId
              || current.remoteServerId !== target.remoteServerId
              || current.remoteSessionId !== target.remoteSessionId) {
              throw new Error("Agent session is no longer authorized");
            }
            const association = await storage.projectRemotes.getByProjectAndServer(
              projectId, current.remoteServerId,
            );
            if (!association) throw new Error("Agent session is no longer authorized");
          }
          await markOperationRunning(operation, { sessionId, instruction, target, delivery: "pending" });
          deliveryAttempted = true;
          const sent = await service.sendAgentInstruction({
            projectId, userId, sessionId, instruction, target,
            idempotencyKey: operation.idempotency_key,
          });
          if (!sent) throw new Error("Agent session did not accept the instruction");
          await touch("agent_session", sessionId);
          await finishOperation(operation, "completed", { sessionId, instruction, target, delivery: "confirmed" });
          return { ok: true, operationId: operation.id, sessionId, status: "completed" };
        } catch (error) {
          const message = boundedError(error);
          if (deliveryAttempted) {
            return { ok: false, operationId: operation.id, status: "pending", error: message };
          }
          await finishOperation(operation, "failed", { sessionId }, message);
          return { ok: false, operationId: operation.id, status: "failed", error: message };
        }
      },
    },
    run_schedule_now: {
      description: "Run an existing schedule in this project now without changing its configuration.",
      inputSchema: z.object({ scheduleId: selectorSchema }).strict(),
      execute: async ({ scheduleId }) => {
        const service = mutationService();
        await revalidateScope();
        const schedule = await storage.scheduledTasks.getById(scheduleId);
        if (!schedule) throw new Error("Schedule not found");
        if (schedule.project_id !== projectId) throw new Error("Object is not part of this project");
        const runId = randomUUID();
        const operation = await beginOperation("schedule_run", "schedule_run", runId, {
          scheduleId, runId, contextConfirmed: false,
        });
        try {
          await revalidateScope();
          const current = await storage.scheduledTasks.getById(scheduleId);
          if (!current || current.project_id !== projectId) throw new Error("Schedule is no longer authorized");
          const result = await service.runScheduleNow(scheduleId, runId);
          const [persisted, authorizedSchedule] = await Promise.all([
            storage.scheduledTaskRuns.getById(runId),
            storage.scheduledTasks.getById(scheduleId),
          ]);
          if (!authorizedSchedule || authorizedSchedule.project_id !== projectId) {
            throw new Error("Schedule is no longer authorized");
          }
          if (!("error" in result) && result.runId !== runId) {
            throw new Error("Schedule run identity mismatch");
          }
          if (!persisted || persisted.project_id !== projectId || persisted.schedule_id !== scheduleId) {
            throw new Error("error" in result ? result.error : "Schedule run identity mismatch");
          }
          const skipped = "error" in result ? persisted.status === "skipped" : result.skipped;
          const tracked = await storage.projectChatContextRefs.touchMany(
            threadId, projectId, userId, [
              { entityType: "schedule", entityId: scheduleId },
              { entityType: "schedule_run", entityId: runId },
            ],
          );
          if (!tracked) throw new Error("Failed to track Project Chat context");
          const status = persisted.status === "running" ? "running"
            : persisted.status === "completed" || persisted.status === "skipped" ? "completed" : "failed";
          const transitioned = status === "running"
            ? await markOperationRunning(operation, { scheduleId, runId, contextConfirmed: true, skipped })
            : await finishOperation(operation, status, { scheduleId, runId, contextConfirmed: true, skipped },
              status === "failed" ? "Schedule run failed" : null);
          let final = transitioned;
          if (status === "running") {
            const latest = await storage.scheduledTaskRuns.getById(runId);
            if (latest?.project_id === projectId && latest.schedule_id === scheduleId
              && latest.status !== "starting" && latest.status !== "running") {
              const latestStatus = latest.status === "completed" || latest.status === "skipped" ? "completed" : "failed";
              final = await finishOperation(transitioned, latestStatus, { scheduleId, runId, contextConfirmed: true, skipped },
                latestStatus === "failed" ? "Schedule run failed" : null);
            }
          }
          return { ok: final.status !== "failed", operationId: operation.id, scheduleId, runId, status: final.status, skipped };
        } catch (error) {
          const persisted = await storage.scheduledTaskRuns.getById(runId);
          if (persisted?.project_id === projectId && persisted.schedule_id === scheduleId) {
            return {
              ok: false, operationId: operation.id, scheduleId, runId, status: "pending",
              error: "Schedule run is awaiting context confirmation",
            };
          }
          const message = boundedError(error);
          await finishOperation(operation, "failed", { scheduleId, runId }, message);
          return { ok: false, operationId: operation.id, status: "failed", error: message };
        }
      },
    },
    get_project_summary: {
      description: "Return a safe summary of the current Project Chat project.",
      inputSchema: emptySchema,
      execute: readInScope(async () => ({
        id: preview(project.id, ID_CHAR_LIMIT),
        name: preview(project.name, NAME_CHAR_LIMIT),
        executionTarget: preview(project.agent_mode, ENUM_CHAR_LIMIT),
      })),
    },
    list_tasks: {
      description: "List or search tasks in this project. Results are capped by the server.",
      inputSchema: z.object({
        query: z.string().max(256).optional(),
        status: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
      }).strict(),
      execute: readInScope(async ({ query, status }) => {
        const rows = await storage.tasks.queryByProject(projectId, { query, status, limit: LIST_LIMIT });
        const validRows = rows.filter((row) => isToolSelectorId(row.id));
        await touchAll("task", validRows.map((row) => row.id));
        return {
          items: validRows.map((row) => ({
            id: preview(row.id, ID_CHAR_LIMIT),
            title: preview(row.title, LIST_NAME_CHAR_LIMIT),
            description: nullablePreview(row.description, LIST_DESCRIPTION_CHAR_LIMIT),
            status: preview(row.status, ENUM_CHAR_LIMIT),
            priority: preview(row.priority, ENUM_CHAR_LIMIT),
            assignedBranch: nullablePreview(row.assigned_branch, LIST_BRANCH_CHAR_LIMIT),
          })),
          truncated: rows.length === LIST_LIMIT,
        };
      }),
    },
    get_task: {
      description: "Inspect one task by id, only if it belongs to this project.",
      inputSchema: z.object({ taskId: z.string().min(1).max(MAX_TOOL_SELECTOR_ID) }).strict(),
      execute: readInScope(async ({ taskId }) => {
        const row = await storage.tasks.getById(taskId);
        if (!row) throw new Error("Task not found");
        if (row.project_id !== projectId) throw new Error("Object is not part of this project");
        if (!isToolSelectorId(row.id)) throw new Error("Task not found");
        await touch("task", row.id);
        return {
          id: preview(row.id, ID_CHAR_LIMIT),
          title: preview(row.title, NAME_CHAR_LIMIT),
          description: nullablePreview(row.description, DESCRIPTION_CHAR_LIMIT),
          status: preview(row.status, ENUM_CHAR_LIMIT),
          priority: preview(row.priority, ENUM_CHAR_LIMIT),
          assignedBranch: nullablePreview(row.assigned_branch, BRANCH_CHAR_LIMIT),
        };
      }),
    },
    list_workspaces: {
      description: "List known local and remote workspaces for this project.",
      inputSchema: emptySchema,
      execute: readInScope(async () => {
        const { items: candidates, truncated } = await workspaceCandidates();
        const entries = candidates.map(({ id: canonicalId, target: rawTarget, branch: rawBranch }) => {
          const target = preview(rawTarget, TARGET_CHAR_LIMIT);
          const branch = nullablePreview(rawBranch, BRANCH_CHAR_LIMIT);
          return [{
            canonicalId,
            item: {
              id: canonicalId,
              target,
              branch,
            },
          }];
        }).flat();
        await touchAll("workspace", entries.map((entry) => entry.canonicalId));
        return { items: entries.map((entry) => entry.item), truncated };
      }),
    },
    list_agent_sessions: {
      description: "List recent agent sessions across local and remote project workspaces.",
      inputSchema: emptySchema,
      execute: readInScope(async () => {
        const [localRows, untrustedRemoteRows] = await Promise.all([
          storage.agentSessions.listByProject(projectId, LIST_LIMIT / 2),
          remoteSessions?.listByProject(projectId, LIST_LIMIT / 2) ?? Promise.resolve([]),
        ]);
        const remoteRows = safeArrayPrefix(untrustedRemoteRows, LIST_LIMIT / 2);
        const local = localRows.flatMap((row) => isToolSelectorId(row.id) ? [{
          canonicalId: row.id,
          item: {
            id: preview(row.id, ID_CHAR_LIMIT),
            projectId: preview(row.project_id, ID_CHAR_LIMIT),
            branch: nullablePreview(row.branch || null, LIST_BRANCH_CHAR_LIMIT),
            title: nullablePreview(row.title, LIST_NAME_CHAR_LIMIT),
            status: preview(row.status, ENUM_CHAR_LIMIT),
            target: "local",
            agentType: nullablePreview(row.agent_type, ENUM_CHAR_LIMIT),
            model: nullablePreview(row.model, LIST_MODEL_CHAR_LIMIT),
          } satisfies ProjectSessionSummary,
        }] : []);
        const authorizedRemote: Array<{ canonicalId: string; item: ProjectSessionSummary }> = [];
        for (const rowValue of remoteRows) {
          const row = safeRecord(rowValue);
          if (!row) continue;
          const projectIdRead = safePropertyRead(row, "projectId");
          if (!projectIdRead.readable || projectIdRead.value !== projectId) continue;
          const idRead = safePropertyRead(row, "id");
          const statusRead = safePropertyRead(row, "status");
          const targetRead = safePropertyRead(row, "target");
          const branchRead = safePropertyRead(row, "branch");
          const titleRead = safePropertyRead(row, "title");
          const agentTypeRead = safePropertyRead(row, "agentType");
          const modelRead = safePropertyRead(row, "model");
          if (!idRead.readable || !statusRead.readable || !targetRead.readable
            || !branchRead.readable || !titleRead.readable
            || !agentTypeRead.readable || !modelRead.readable) continue;
          const rowProjectId = projectIdRead.value;
          const rowId = idRead.value;
          const rowStatus = statusRead.value;
          const rowTarget = targetRead.value;
          const rowBranch = branchRead.value;
          const rowTitle = titleRead.value;
          const rowAgentType = agentTypeRead.value;
          const rowModel = modelRead.value;
          if (!isToolSelectorId(rowId) || !isCanonicalId(rowProjectId)
            || typeof rowStatus !== "string" || typeof rowTarget !== "string"
            || !isNullableString(rowBranch) || !isNullableString(rowTitle)
            || !isOptionalNullableString(rowAgentType) || !isOptionalNullableString(rowModel)) continue;
          authorizedRemote.push({
            canonicalId: rowId,
            item: {
              id: preview(rowId, ID_CHAR_LIMIT),
              projectId: preview(rowProjectId, ID_CHAR_LIMIT),
              branch: nullablePreview(rowBranch, LIST_BRANCH_CHAR_LIMIT),
              title: nullablePreview(rowTitle, LIST_NAME_CHAR_LIMIT),
              status: preview(rowStatus, ENUM_CHAR_LIMIT),
              target: preview(rowTarget, LIST_TARGET_CHAR_LIMIT),
              agentType: nullablePreview(rowAgentType, ENUM_CHAR_LIMIT),
              model: nullablePreview(rowModel, LIST_MODEL_CHAR_LIMIT),
            },
          });
        }
        const entries = [...local, ...authorizedRemote].slice(0, LIST_LIMIT);
        await touchAll("agent_session", entries.map((entry) => entry.canonicalId));
        return {
          items: entries.map((entry) => entry.item),
          truncated: localRows.length === LIST_LIMIT / 2 || remoteRows.length === LIST_LIMIT / 2,
        };
      }),
    },
    get_agent_session: {
      description: "Return status and a server-bounded recent transcript for one project agent session.",
      inputSchema: z.object({ sessionId: z.string().min(1).max(MAX_TOOL_SELECTOR_ID) }).strict(),
      execute: readInScope(async ({ sessionId }) => {
        const local = await storage.agentSessions.getById(sessionId);
        if (local) {
          if (local.project_id !== projectId) throw new Error("Object is not part of this project");
          if (!isToolSelectorId(local.id)) throw new Error("Agent session not found");
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
        if (!isToolSelectorId(mappingId) || !isCanonicalId(mappingProjectId)
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
      }),
    },
    list_schedules: {
      description: "List schedules configured for this project without commands, prompts, or raw configuration.",
      inputSchema: emptySchema,
      execute: readInScope(async () => {
        const rows = await storage.scheduledTasks.listByProject(projectId, LIST_LIMIT);
        const validRows = rows.filter((row) => isToolSelectorId(row.id));
        await touchAll("schedule", validRows.map((row) => row.id));
        return {
          items: validRows.map((row) => ({
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
      }),
    },
    list_schedule_runs: {
      description: "List recent runs across this project's schedules without raw output or reports.",
      inputSchema: emptySchema,
      execute: readInScope(async () => {
        const rows = await storage.scheduledTaskRuns.listRecentByProject(projectId, LIST_LIMIT);
        const validRows = rows.filter((row) => isToolSelectorId(row.id));
        await touchAll("schedule_run", validRows.map((row) => row.id));
        return {
          items: validRows.map((row) => ({
            id: preview(row.id, ID_CHAR_LIMIT),
            scheduleId: preview(row.schedule_id, ID_CHAR_LIMIT),
            status: preview(row.status, ENUM_CHAR_LIMIT),
            exitCode: row.exit_code,
            startedAt: preview(row.started_at, TIMESTAMP_CHAR_LIMIT),
            finishedAt: nullablePreview(row.finished_at, TIMESTAMP_CHAR_LIMIT),
          })),
          truncated: rows.length === LIST_LIMIT,
        };
      }),
    },
    get_schedule_run: {
      description: "Inspect one project schedule run with server-bounded output and report previews.",
      inputSchema: z.object({ runId: z.string().min(1).max(MAX_TOOL_SELECTOR_ID) }).strict(),
      execute: readInScope(async ({ runId }) => {
        const run = await storage.scheduledTaskRuns.getById(runId);
        if (!run) throw new Error("Schedule run not found");
        const schedule = await storage.scheduledTasks.getById(run.schedule_id);
        if (!schedule) throw new Error("Schedule run not found");
        if (schedule.project_id !== projectId) throw new Error("Object is not part of this project");
        if (!isToolSelectorId(run.id)) throw new Error("Schedule run not found");
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
      }),
    },
  };
}
