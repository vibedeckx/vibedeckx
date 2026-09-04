import type {
  AgentSessionActivity,
  ProjectChatThread,
  ScheduledTaskRunActivity,
  Storage,
  Task,
} from "./storage/types.js";

// Five fills the Project Chat card's thread list without spilling past the
// Recent Agent Sessions card beside it; anything longer belongs in the history
// dialog the card's footer opens.
const RECENT_THREAD_LIMIT = 5;
const RECENT_SESSION_LIMIT = 8;
const RECENT_RUN_LIMIT = 5;
const PRIORITY_TASK_LIMIT = 5;
const ATTENTION_LIMIT = 10;
// Starring is deliberate and rare, so the whole set normally fits; the cap only
// stops a pathological project from unrolling a hundred rows into the sidebar.
const STARRED_LIMIT = 10;

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
  /** Sessions the user starred, newest star first. */
  starredSessions: AgentSessionActivity[];
  recentScheduleRuns: ScheduledTaskRunActivity[];
  priorityTasks: Task[];
  attention: ProjectActivityAttentionItem[];
  summary: {
    running: number;
    nextScheduleAt: string | null;
  };
}

const parseDbTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const explicitZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(value);
  const parsed = Date.parse(explicitZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? null : parsed;
};

const mergeBy = (
  local: AgentSessionActivity[],
  remote: AgentSessionActivity[],
  limit: number,
  rank: (row: AgentSessionActivity) => number,
) => {
  const byId = new Map<string, AgentSessionActivity>();
  for (const row of [...local, ...remote]) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()]
    .sort((left, right) => rank(right) - rank(left) || left.id.localeCompare(right.id))
    .slice(0, limit);
};

const mergeActivity = (local: AgentSessionActivity[], remote: AgentSessionActivity[], limit: number) =>
  mergeBy(local, remote, limit, (row) => row.lastActiveAt ?? 0);

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
    localStarredSessions,
    remoteStarredSessions,
    attentionRuns,
    runningSessions,
    runningRuns,
    remoteCounts,
    nextScheduleAt,
  ] = await Promise.all([
    storage.projectChatThreads.listByProject(projectId, userId, RECENT_THREAD_LIMIT),
    storage.agentSessions.listRecentActivityByProject(projectId, RECENT_SESSION_LIMIT, "project-activity"),
    storage.searchCache.listRemoteSessionActivityByProject(projectId, RECENT_SESSION_LIMIT, "project-activity"),
    storage.scheduledTaskRuns.getRecentByProject(projectId, RECENT_RUN_LIMIT),
    storage.tasks.listPriorityByProject(projectId, PRIORITY_TASK_LIMIT),
    storage.agentSessions.listAttentionActivityByProject(projectId, ATTENTION_LIMIT, "project-activity"),
    storage.searchCache.listRemoteSessionAttentionByProject(projectId, ATTENTION_LIMIT, "project-activity"),
    storage.agentSessions.listFavoritedActivityByProject(projectId, STARRED_LIMIT, "project-activity"),
    storage.searchCache.listRemoteSessionFavoritesByProject(projectId, STARRED_LIMIT, "project-activity"),
    storage.scheduledTaskRuns.getAttentionByProject(projectId, ATTENTION_LIMIT),
    storage.agentSessions.countRunningActivityByProject(projectId),
    storage.scheduledTaskRuns.countByProjectStatuses(projectId, ["starting", "running"]),
    storage.searchCache.countRemoteSessionActivityByProject(projectId),
    storage.scheduledTasks.getEarliestNextRunAt(projectId),
  ]);

  const recentAgentSessions = mergeActivity(
    localRecentSessions,
    remoteRecentSessions,
    RECENT_SESSION_LIMIT,
  );
  const attentionSessions = mergeActivity(
    localAttentionSessions,
    remoteAttentionSessions,
    ATTENTION_LIMIT,
  );
  const starredSessions = mergeBy(
    localStarredSessions,
    remoteStarredSessions,
    STARRED_LIMIT,
    (row) => row.favoritedAt ?? 0,
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
    starredSessions,
    recentScheduleRuns,
    priorityTasks,
    attention,
    summary: {
      running: runningSessions + runningRuns + remoteCounts.running,
      nextScheduleAt,
    },
  };
}
