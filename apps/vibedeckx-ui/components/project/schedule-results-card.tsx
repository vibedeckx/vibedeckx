"use client";

import { CalendarCheck, GitBranch } from "lucide-react";
import type { ProjectScheduleRunActivity, ScheduleRunStatus } from "@/lib/api";
import { workspaceLabel } from "@/lib/workspace-label";
import {
  ActivityCard,
  ActivityCardCount,
  ActivityCardEmpty,
  ActivityCardTitle,
  ActivityRow,
  StatusDot,
  type DotTone,
} from "./activity-card";

interface ScheduleResultsCardProps {
  runs: ProjectScheduleRunActivity[];
  /** Remote server id → name, so a run's workspace reads as "gpu-01 · main". */
  remoteNames: Map<string, string>;
  onOpenRun: (runId: string, scheduleId: string) => void;
}

const statusTone: Record<ScheduleRunStatus, DotTone> = {
  starting: "blue",
  running: "blue",
  completed: "green",
  failed: "rose",
  timeout: "amber",
  killed: "amber",
  skipped: "neutral",
};

function parseTimestamp(value: string): number {
  const explicitZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(value);
  return Date.parse(explicitZone ? value : `${value.replace(" ", "T")}Z`);
}

function duration(run: ProjectScheduleRunActivity): string {
  if (!run.finished_at) return "Running";
  const elapsed = parseTimestamp(run.finished_at) - parseTimestamp(run.started_at);
  if (!Number.isFinite(elapsed)) return "Unknown duration";
  const seconds = Math.max(0, Math.round(elapsed / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function completedTime(run: ProjectScheduleRunActivity): string {
  const value = run.finished_at || run.started_at;
  const timestamp = parseTimestamp(value);
  return Number.isNaN(timestamp) ? "Unknown time" : new Date(timestamp).toLocaleString();
}

export function ScheduleResultsCard({ runs, remoteNames, onOpenRun }: ScheduleResultsCardProps) {
  const visible = runs.slice(0, 5);
  return (
    <ActivityCard>
      <ActivityCardTitle
        icon={<CalendarCheck className="size-3" aria-hidden="true" />}
        trailing={<ActivityCardCount>{visible.length}</ActivityCardCount>}
      >
        Schedule Results
      </ActivityCardTitle>

      {visible.length === 0 ? (
        <ActivityCardEmpty>No schedule runs yet</ActivityCardEmpty>
      ) : (
        visible.map((run) => (
          <ActivityRow
            key={run.id}
            data-testid="schedule-run"
            aria-label={`Open schedule run: ${run.scheduleName}`}
            onClick={() => onOpenRun(run.id, run.schedule_id)}
          >
            <StatusDot tone={statusTone[run.status]} pulse={run.status === "running"} className="mt-[5px]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium">{run.scheduleName}</span>
              {run.reportPreview ? (
                <span className="mt-1 block line-clamp-2 text-[11.5px] leading-[1.45] text-muted-foreground">
                  {run.reportPreview}
                </span>
              ) : null}
              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
                <span className="capitalize">{run.status}</span>
                <span>{duration(run)}</span>
                <span>{completedTime(run)}</span>
                <span className="inline-flex min-w-0 max-w-50 items-center gap-1">
                  <GitBranch className="size-2.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                  <span className="truncate">
                    {workspaceLabel({ target: run.target, branch: run.branch }, remoteNames)}
                  </span>
                </span>
              </span>
            </span>
          </ActivityRow>
        ))
      )}
    </ActivityCard>
  );
}
