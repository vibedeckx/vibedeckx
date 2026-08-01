"use client";

import { AlertCircle, CalendarClock, Loader2 } from "lucide-react";
import type { ProjectChatThread, Task } from "@/lib/api";
import { useProjectActivity } from "@/hooks/use-project-activity";
import { Button } from "@/components/ui/button";
import { ProjectChatCard } from "./project-chat-card";
import { RecentAgentSessionsCard } from "./recent-agent-sessions-card";
import { ScheduleResultsCard } from "./schedule-results-card";
import { PriorityTasksCard } from "./priority-tasks-card";
import { AttentionRequiredCard } from "./attention-required-card";

export interface ProjectActivityViewProps {
  projectId: string;
  /**
   * Unread attention milestones for this project — the bell's own state, scoped
   * and counted by the owner of the notification hook. Passed in rather than
   * read from the activity aggregate: marking a notification read emits no
   * event, so a server-side count would sit stale until unrelated activity
   * happened to refetch it. See
   * docs/superpowers/specs/2026-08-01-project-waiting-tile-design.md.
   */
  waitingCount: number;
  onCreateThread?: (message: string) => Promise<ProjectChatThread>;
  onOpenThread?: (threadId: string) => void;
  onOpenAgentSession: (sessionId: string, target: string, branch: string | null) => void;
  onOpenScheduleRun: (runId: string, scheduleId?: string) => void;
  onRunScheduleAgain: (runId: string) => Promise<void> | void;
  onOpenTask: (task: Task) => void;
  onViewAllTasks: () => void;
}

function nextScheduleLabel(value: string | null): string {
  if (!value) return "None scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function ProjectActivityView({
  projectId,
  waitingCount,
  onCreateThread,
  onOpenThread,
  onOpenAgentSession,
  onOpenScheduleRun,
  onRunScheduleAgain,
  onOpenTask,
  onViewAllTasks,
}: ProjectActivityViewProps) {
  const { activity, loading, error, refetch } = useProjectActivity(projectId);

  if (loading && !activity) {
    return (
      <div aria-busy="true" aria-live="polite" className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading project activity…
      </div>
    );
  }

  if (error && !activity) {
    return (
      <div role="alert" className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-6 text-center">
        <AlertCircle className="size-6 text-destructive" aria-hidden="true" />
        <div>
          <p className="font-medium">Project activity is unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!activity) return null;

  return (
    <section aria-label="Project activity dashboard" className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-lg border bg-card px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Running</p>
          <p className="text-lg font-semibold text-blue-600">{activity.summary.running}</p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2" title="Unread updates waiting for you">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Waiting</p>
          {/* Amber, never destructive: something waiting on you is not something broken. */}
          <p
            data-testid="waiting-count"
            aria-label={`${waitingCount} unread updates waiting for you`}
            className={waitingCount > 0 ? "text-lg font-semibold text-amber-600" : "text-lg font-semibold"}
          >
            {waitingCount}
          </p>
        </div>
        <div className="col-span-2 rounded-lg border bg-card px-3 py-2 sm:col-span-1">
          <p className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            <CalendarClock className="size-3" aria-hidden="true" />
            Next schedule
          </p>
          <p className="truncate text-sm font-medium">{nextScheduleLabel(activity.summary.nextScheduleAt)}</p>
        </div>
      </div>

      {error ? (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm">
          <span>Live refresh failed: {error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refetch()}>Retry</Button>
        </div>
      ) : null}

      <ProjectChatCard
        scopeKey={projectId}
        threads={activity.recentThreads}
        onCreateThread={onCreateThread ? async (message) => {
          const created = await onCreateThread(message);
          void refetch();
          return created;
        } : undefined}
        onOpenThread={onOpenThread}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
        <RecentAgentSessionsCard sessions={activity.recentAgentSessions} onOpenSession={onOpenAgentSession} />
        <ScheduleResultsCard runs={activity.recentScheduleRuns} onOpenRun={onOpenScheduleRun} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PriorityTasksCard tasks={activity.priorityTasks} onOpenTask={onOpenTask} onViewAll={onViewAllTasks} />
        <AttentionRequiredCard
          scopeKey={projectId}
          items={activity.attention}
          onOpenAgentSession={onOpenAgentSession}
          onOpenScheduleRun={onOpenScheduleRun}
          onRunScheduleAgain={onRunScheduleAgain}
        />
      </div>
    </section>
  );
}
