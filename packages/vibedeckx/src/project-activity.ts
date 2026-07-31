import { Cron } from "croner";
import type {
  AgentSession,
  ProjectChatThread,
  ScheduledTask,
  ScheduledTaskRunActivity,
  Storage,
  Task,
} from "./storage/types.js";

const RECENT_THREAD_LIMIT = 3;
const RECENT_SESSION_LIMIT = 8;
const RECENT_RUN_LIMIT = 5;
const PRIORITY_TASK_LIMIT = 5;
const ATTENTION_LIMIT = 10;
const SCHEDULE_SCAN_LIMIT = 1_000;

export interface ProjectActivityAttentionItem {
  type: "agent_session" | "schedule_run";
  entityId: string;
  status: string;
  title: string;
  occurredAt: string;
}

export interface ProjectActivity {
  recentThreads: ProjectChatThread[];
  recentAgentSessions: AgentSession[];
  recentScheduleRuns: ScheduledTaskRunActivity[];
  priorityTasks: Task[];
  attention: ProjectActivityAttentionItem[];
  summary: {
    running: number;
    failed: number;
    nextScheduleAt: string | null;
  };
}

function nextRunAt(schedule: ScheduledTask): string | null {
  if (!schedule.enabled) return null;
  let cron: Cron | undefined;
  try {
    cron = new Cron(schedule.cron_expr, {
      paused: true,
      timezone: schedule.timezone,
    });
    return cron.nextRun()?.toISOString() ?? null;
  } catch {
    return null;
  } finally {
    cron?.stop();
  }
}

function earliestNextSchedule(schedules: ScheduledTask[]): string | null {
  let earliest: string | null = null;
  for (const schedule of schedules) {
    const next = nextRunAt(schedule);
    if (next !== null && (earliest === null || next < earliest)) earliest = next;
  }
  return earliest;
}

export async function getProjectActivity(
  storage: Storage,
  projectId: string,
  userId: string,
): Promise<ProjectActivity> {
  const [
    recentThreads,
    recentAgentSessions,
    recentScheduleRuns,
    priorityTasks,
    schedules,
    attentionSessions,
    attentionRuns,
    runningSessions,
    runningRuns,
    failedSessions,
    failedRuns,
  ] = await Promise.all([
    storage.projectChatThreads.listByProject(projectId, userId, RECENT_THREAD_LIMIT),
    storage.agentSessions.listRecentByProject(projectId, RECENT_SESSION_LIMIT),
    storage.scheduledTaskRuns.getRecentByProject(projectId, RECENT_RUN_LIMIT),
    storage.tasks.listPriorityByProject(projectId, PRIORITY_TASK_LIMIT),
    storage.scheduledTasks.listByProject(projectId, SCHEDULE_SCAN_LIMIT),
    storage.agentSessions.listAttentionByProject(projectId, ATTENTION_LIMIT),
    storage.scheduledTaskRuns.getAttentionByProject(projectId, ATTENTION_LIMIT),
    storage.agentSessions.countRunningByProject(projectId),
    storage.scheduledTaskRuns.countByProjectStatuses(projectId, ["starting", "running"]),
    storage.agentSessions.countAttentionByProject(projectId),
    storage.scheduledTaskRuns.countByProjectStatuses(projectId, ["failed", "timeout"]),
  ]);

  const attention: ProjectActivityAttentionItem[] = [
    ...attentionSessions
      .map((session) => ({
        type: "agent_session" as const,
        entityId: session.id,
        status: session.status,
        title: session.title ?? (session.branch || "Main workspace"),
        occurredAt: session.updated_at ?? session.created_at,
      })),
    ...attentionRuns
      .map((run) => ({
        type: "schedule_run" as const,
        entityId: run.id,
        status: run.status,
        title: run.scheduleName,
        occurredAt: run.finished_at ?? run.started_at,
      })),
  ]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.entityId.localeCompare(left.entityId))
    .slice(0, ATTENTION_LIMIT);

  return {
    recentThreads,
    recentAgentSessions,
    recentScheduleRuns,
    priorityTasks,
    attention,
    summary: {
      running: runningSessions + runningRuns,
      failed: failedSessions + failedRuns,
      nextScheduleAt: earliestNextSchedule(schedules),
    },
  };
}
