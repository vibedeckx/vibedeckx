import type {
  AgentSession,
  AgentSessionActivity,
  ProjectChatThread,
  ScheduledTaskRunActivity,
  Storage,
  Task,
} from "./storage/types.js";

const RECENT_THREAD_LIMIT = 3;
const RECENT_SESSION_LIMIT = 8;
const RECENT_RUN_LIMIT = 5;
const PRIORITY_TASK_LIMIT = 5;
const ATTENTION_LIMIT = 10;

export interface ProjectActivityAttentionItem {
  type: "agent_session" | "schedule_run";
  entityId: string;
  status: string;
  title: string;
  occurredAt: string;
  target?: string;
  workspace?: { target: string; branch: string | null };
}

export interface ProjectActivity {
  recentThreads: ProjectChatThread[];
  recentAgentSessions: AgentSessionActivity[];
  recentScheduleRuns: ScheduledTaskRunActivity[];
  priorityTasks: Task[];
  attention: ProjectActivityAttentionItem[];
  summary: {
    running: number;
    failed: number;
    nextScheduleAt: string | null;
  };
}

const parseDbTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const explicitZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(value);
  const parsed = Date.parse(explicitZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? null : parsed;
};

const maxTimestamp = (...values: Array<number | null | undefined>): number | null => {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return valid.length > 0 ? Math.max(...valid) : null;
};

const localActivity = (session: AgentSession): AgentSessionActivity => {
  const branch = session.branch || null;
  return {
    id: session.id,
    projectId: session.project_id,
    branch,
    status: session.status,
    title: session.title ?? null,
    target: "local",
    workspace: { target: "local", branch },
    agentType: session.agent_type ?? null,
    model: session.model ?? null,
    lastActiveAt: maxTimestamp(
      session.last_user_message_at,
      session.last_completed_at,
      parseDbTimestamp(session.updated_at),
      parseDbTimestamp(session.created_at),
    ),
    lastUserMessageAt: session.last_user_message_at ?? null,
    lastCompletedAt: session.last_completed_at ?? null,
  };
};

const mergeActivity = (local: AgentSessionActivity[], remote: AgentSessionActivity[], limit: number) => {
  const byId = new Map<string, AgentSessionActivity>();
  for (const row of [...local, ...remote]) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()]
    .sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0)
      || left.id.localeCompare(right.id))
    .slice(0, limit);
};

export async function getProjectActivity(
  storage: Storage,
  projectId: string,
  userId: string,
): Promise<ProjectActivity> {
  const [
    recentThreads,
    localRecentSessions,
    remoteRecentSessions,
    recentScheduleRuns,
    priorityTasks,
    localAttentionSessions,
    remoteAttentionSessions,
    attentionRuns,
    runningSessions,
    runningRuns,
    failedSessions,
    failedRuns,
    remoteCounts,
    nextScheduleAt,
  ] = await Promise.all([
    storage.projectChatThreads.listByProject(projectId, userId, RECENT_THREAD_LIMIT),
    storage.agentSessions.listRecentByProject(projectId, RECENT_SESSION_LIMIT),
    storage.searchCache.listRemoteSessionActivityByProject(projectId, RECENT_SESSION_LIMIT),
    storage.scheduledTaskRuns.getRecentByProject(projectId, RECENT_RUN_LIMIT),
    storage.tasks.listPriorityByProject(projectId, PRIORITY_TASK_LIMIT),
    storage.agentSessions.listAttentionByProject(projectId, ATTENTION_LIMIT),
    storage.searchCache.listRemoteSessionAttentionByProject(projectId, ATTENTION_LIMIT),
    storage.scheduledTaskRuns.getAttentionByProject(projectId, ATTENTION_LIMIT),
    storage.agentSessions.countRunningByProject(projectId),
    storage.scheduledTaskRuns.countByProjectStatuses(projectId, ["starting", "running"]),
    storage.agentSessions.countAttentionByProject(projectId),
    storage.scheduledTaskRuns.countByProjectStatuses(projectId, ["failed", "timeout"]),
    storage.searchCache.countRemoteSessionActivityByProject(projectId),
    storage.scheduledTasks.getEarliestNextRunAt(projectId),
  ]);

  const recentAgentSessions = mergeActivity(
    localRecentSessions.map(localActivity),
    remoteRecentSessions,
    RECENT_SESSION_LIMIT,
  );
  const attentionSessions = mergeActivity(
    localAttentionSessions.map(localActivity),
    remoteAttentionSessions,
    ATTENTION_LIMIT,
  );

  const attention = [
    ...attentionSessions
      .map((session) => ({
        type: "agent_session" as const,
        entityId: session.id,
        status: session.status,
        title: session.title ?? (session.branch || "Main workspace"),
        occurredAtMs: session.lastActiveAt ?? 0,
        target: session.target,
        workspace: session.workspace,
      })),
    ...attentionRuns
      .map((run) => ({
        type: "schedule_run" as const,
        entityId: run.id,
        status: run.status,
        title: run.scheduleName,
        occurredAtMs: parseDbTimestamp(run.finished_at ?? run.started_at) ?? 0,
      })),
  ]
    .sort((left, right) => right.occurredAtMs - left.occurredAtMs || right.entityId.localeCompare(left.entityId))
    .slice(0, ATTENTION_LIMIT)
    .map(({ occurredAtMs, ...item }): ProjectActivityAttentionItem => ({
      ...item,
      occurredAt: new Date(occurredAtMs).toISOString(),
    }));

  return {
    recentThreads,
    recentAgentSessions,
    recentScheduleRuns,
    priorityTasks,
    attention,
    summary: {
      running: runningSessions + runningRuns + remoteCounts.running,
      failed: failedSessions + failedRuns + remoteCounts.failed,
      nextScheduleAt,
    },
  };
}
