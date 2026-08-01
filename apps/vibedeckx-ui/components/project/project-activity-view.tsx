"use client";

import type { ReactNode } from "react";
import { AlertCircle, Bot, CalendarClock, Inbox, Loader2 } from "lucide-react";
import type { ProjectActivity, ProjectChatThread, Task } from "@/lib/api";
import { useProjectActivity } from "@/hooks/use-project-activity";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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

function nextScheduleTime(value: string | null): string {
  if (!value) return "None scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const clock = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round(
    (new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `Today · ${clock}`;
  if (days === 1) return `Tomorrow · ${clock}`;
  return `${date.toLocaleDateString()} · ${clock}`;
}

function untilNextSchedule(value: string | null): string {
  if (!value) return "No upcoming runs";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "Unrecognised schedule time";
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (minutes <= 0) return "Due now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Where the currently-running sessions are, e.g. "feat/streams · gpu-01 · main". */
function runningWhere(activity: ProjectActivity): string {
  const labels = activity.recentAgentSessions
    .filter((session) => session.status === "running")
    .map((session) => {
      const branch = session.workspace.branch || "main";
      return session.workspace.target === "local" ? branch : `${session.workspace.target} · ${branch}`;
    });
  if (labels.length === 0) return "Nothing running right now";
  return labels.slice(0, 2).join(" · ") + (labels.length > 2 ? ` +${labels.length - 2}` : "");
}

interface StatProps {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  detail: string;
}

/**
 * One cell of the summary strip: uppercase key, oversized mono value, and a
 * mono detail line that says *which* thing the number is about. Cells divide
 * vertically once they stack and horizontally once they sit side by side.
 */
function Stat({ label, icon, children, detail }: StatProps) {
  return (
    <div className="min-w-0 border-b border-border/60 py-3.5 last:border-b-0 sm:border-b-0 sm:border-r sm:px-6 sm:first:pl-0 sm:last:border-r-0 sm:last:pr-0">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/70">
        <span className="flex items-center">{icon}</span>
        {label}
      </div>
      {children}
      <p className="mt-1.5 truncate font-mono text-[10.5px] text-muted-foreground">{detail}</p>
    </div>
  );
}

/** Big mono number plus its unit, shared by the two counting tiles. */
function StatValue({ unit, children }: { unit: string; children: ReactNode }) {
  return (
    <p className="flex items-baseline gap-1.5 font-mono text-[22px] font-medium leading-[1.1] tracking-[-0.03em]">
      {children}
      <span className="text-[11.5px] font-normal tracking-normal text-muted-foreground/70">{unit}</span>
    </p>
  );
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
      <div className="grid grid-cols-1 border-t border-border/60 sm:grid-cols-3">
        <Stat
          label="Running"
          icon={<Bot className="size-[11px]" aria-hidden="true" />}
          detail={runningWhere(activity)}
        >
          <StatValue unit="agent sessions">
            <span className="text-blue-600 dark:text-blue-400">{activity.summary.running}</span>
          </StatValue>
        </Stat>

        <Stat
          label="Waiting"
          icon={<Inbox className="size-[11px]" aria-hidden="true" />}
          detail={waitingCount > 0 ? "Unread attention milestones" : "You're all caught up"}
        >
          <StatValue unit="updates for you">
            {/* Amber, never destructive: something waiting on you is not something broken. */}
            <span
              data-testid="waiting-count"
              aria-label={`${waitingCount} unread updates waiting for you`}
              className={waitingCount > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
            >
              {waitingCount}
            </span>
          </StatValue>
        </Stat>

        <Stat
          label="Next schedule"
          icon={<CalendarClock className="size-[11px]" aria-hidden="true" />}
          detail={untilNextSchedule(activity.summary.nextScheduleAt)}
        >
          <p className="truncate font-mono text-[13px] font-medium tracking-[-0.01em]">
            {nextScheduleTime(activity.summary.nextScheduleAt)}
          </p>
        </Stat>
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

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
        <RecentAgentSessionsCard sessions={activity.recentAgentSessions} onOpenSession={onOpenAgentSession} />
        <ScheduleResultsCard runs={activity.recentScheduleRuns} onOpenRun={onOpenScheduleRun} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
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
