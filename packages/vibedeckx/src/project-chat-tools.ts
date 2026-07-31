import { z } from "zod";
import type { ProjectChatContextEntityType, Storage } from "./storage/types.js";

const LIST_LIMIT = 50;
const TRANSCRIPT_ENTRY_LIMIT = 20;
const TRANSCRIPT_CHAR_LIMIT = 6_000;
const RUN_PREVIEW_CHAR_LIMIT = 4_000;
const FIELD_PREVIEW_CHAR_LIMIT = 1_000;

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
      if (!result.ok) return undefined;
      const data = result.data as {
        session?: { branch?: unknown; title?: unknown; status?: unknown; processAlive?: unknown };
        messages?: unknown[];
      };
      if (!data.session) return undefined;
      const transcript = transcriptPreview((data.messages ?? []).slice(-Math.min(limits.maxEntries, TRANSCRIPT_ENTRY_LIMIT)));
      return {
        id: mapping.id,
        projectId: mapping.projectId,
        branch: typeof data.session.branch === "string" ? data.session.branch : mapping.branch,
        title: typeof data.session.title === "string" ? data.session.title : null,
        status: typeof data.session.status === "string" ? data.session.status : "unknown",
        target: mapping.remoteServerId,
        processAlive: data.session.processAlive === true,
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
const preview = (value: string | null | undefined, limit: number): string => {
  if (!value) return "";
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
};

function transcriptPreview(entries: unknown[]): unknown[] {
  const selected = entries.slice(-TRANSCRIPT_ENTRY_LIMIT).filter((entry) => entry && typeof entry === "object");
  const perEntryLimit = Math.max(1, Math.floor(TRANSCRIPT_CHAR_LIMIT / Math.max(1, selected.length)) - 1);
  const result: unknown[] = [];
  for (const entry of selected) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const type = typeof value.type === "string" ? value.type : "message";
    const raw = typeof value.content === "string"
      ? value.content
      : typeof value.text === "string" ? value.text : JSON.stringify(value.content ?? "");
    const content = preview(raw, perEntryLimit);
    result.push({ type, content });
  }
  return result;
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
      execute: async () => ({ id: project.id, name: preview(project.name, FIELD_PREVIEW_CHAR_LIMIT), executionTarget: project.agent_mode }),
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
            id: row.id, title: preview(row.title, FIELD_PREVIEW_CHAR_LIMIT),
            description: preview(row.description, FIELD_PREVIEW_CHAR_LIMIT), status: row.status,
            priority: row.priority, assignedBranch: row.assigned_branch,
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
          id: row.id, title: preview(row.title, FIELD_PREVIEW_CHAR_LIMIT),
          description: preview(row.description, FIELD_PREVIEW_CHAR_LIMIT), status: row.status,
          priority: row.priority, assignedBranch: row.assigned_branch,
        };
      },
    },
    list_workspaces: {
      description: "List known local and remote workspaces for this project.",
      inputSchema: emptySchema,
      execute: async () => {
        const rows = await storage.searchCache.listWorkspacesByProject(projectId, LIST_LIMIT);
        const items = rows.map((row) => ({
          id: `${row.targetId}:${row.branch ?? "main"}`, target: row.targetId, branch: row.branch,
        }));
        await touchAll("workspace", items.map((item) => item.id));
        return { items, truncated: rows.length === LIST_LIMIT };
      },
    },
    list_agent_sessions: {
      description: "List recent agent sessions across local and remote project workspaces.",
      inputSchema: emptySchema,
      execute: async () => {
        const [localRows, remoteRows] = await Promise.all([
          storage.agentSessions.listByProject(projectId, LIST_LIMIT / 2),
          remoteSessions?.listByProject(projectId, LIST_LIMIT / 2) ?? Promise.resolve([]),
        ]);
        const local: ProjectSessionSummary[] = localRows.map((row) => ({
          id: row.id, projectId: row.project_id, branch: row.branch || null,
          title: preview(row.title, FIELD_PREVIEW_CHAR_LIMIT) || null,
          status: row.status, target: "local",
        }));
        const authorizedRemote = remoteRows
          .filter((row) => row.projectId === projectId)
          .map((row) => ({ ...row, title: preview(row.title, FIELD_PREVIEW_CHAR_LIMIT) || null }));
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
            id: local.id, projectId: local.project_id, branch: local.branch || null,
            title: preview(local.title, FIELD_PREVIEW_CHAR_LIMIT) || null,
            status: local.status, target: "local",
            processAlive: agentSessionManager.getSessionProcessAlive(local.id),
            transcript: transcriptPreview(agentSessionManager.getMessages(local.id)),
          };
          await touch("agent_session", local.id);
          return detail;
        }
        const mapping = await remoteSessions?.getMapping(sessionId);
        if (!mapping) throw new Error("Agent session not found");
        if (mapping.projectId !== projectId) throw new Error("Object is not part of this project");
        const remote = await remoteSessions?.getDetail(mapping, {
          maxEntries: TRANSCRIPT_ENTRY_LIMIT, maxChars: TRANSCRIPT_CHAR_LIMIT,
        });
        if (!remote) throw new Error("Agent session not found");
        if (remote.projectId !== projectId || remote.id !== mapping.id) {
          throw new Error("Object is not part of this project");
        }
        const detail: ProjectSessionDetail = {
          id: remote.id,
          projectId: remote.projectId,
          branch: remote.branch,
          title: preview(remote.title, FIELD_PREVIEW_CHAR_LIMIT) || null,
          status: preview(remote.status, FIELD_PREVIEW_CHAR_LIMIT),
          target: remote.target,
          processAlive: remote.processAlive,
          transcript: transcriptPreview(remote.transcript),
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
            id: row.id, name: preview(row.name, FIELD_PREVIEW_CHAR_LIMIT), enabled: row.enabled,
            cron: preview(row.cron_expr, FIELD_PREVIEW_CHAR_LIMIT),
            timezone: row.timezone, runType: row.run_type, target: row.target, branch: row.branch,
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
            id: row.id, scheduleId: row.schedule_id, status: row.status, exitCode: row.exit_code,
            startedAt: row.started_at, finishedAt: row.finished_at,
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
          id: run.id, scheduleId: run.schedule_id, status: run.status, exitCode: run.exit_code,
          startedAt: run.started_at, finishedAt: run.finished_at,
          outputPreview: preview(run.output, RUN_PREVIEW_CHAR_LIMIT),
          reportPreview: preview(run.report, RUN_PREVIEW_CHAR_LIMIT),
        };
      },
    },
  };
}
