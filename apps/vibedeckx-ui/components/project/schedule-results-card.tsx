"use client";

import { CalendarCheck, Circle, GitBranch } from "lucide-react";
import type { ProjectScheduleRunActivity, ScheduleRunStatus } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ScheduleResultsCardProps {
  runs: ProjectScheduleRunActivity[];
  onOpenRun: (runId: string, scheduleId: string) => void;
}

const statusClass: Record<ScheduleRunStatus, string> = {
  starting: "text-blue-500 fill-blue-500",
  running: "text-blue-500 fill-blue-500",
  completed: "text-emerald-500 fill-emerald-500",
  failed: "text-destructive fill-destructive",
  timeout: "text-amber-500 fill-amber-500",
  killed: "text-amber-500 fill-amber-500",
  skipped: "text-muted-foreground fill-muted-foreground",
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

export function ScheduleResultsCard({ runs, onOpenRun }: ScheduleResultsCardProps) {
  const visible = runs.slice(0, 5);
  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <CalendarCheck className="size-4 text-muted-foreground" aria-hidden="true" />
            Schedule Results
          </span>
          <span className="font-normal text-muted-foreground">{visible.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No schedule runs yet</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {visible.map((run) => (
              <li key={run.id} data-testid="schedule-run">
                <button
                  type="button"
                  aria-label={`Open schedule run: ${run.scheduleName}`}
                  onClick={() => onOpenRun(run.id, run.schedule_id)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Circle className={cn("mt-1 size-2.5 shrink-0", statusClass[run.status])} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{run.scheduleName}</span>
                    {run.reportPreview ? (
                      <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                        {run.reportPreview}
                      </span>
                    ) : null}
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span className="capitalize">{run.status}</span>
                      <span>{duration(run)}</span>
                      <span>{completedTime(run)}</span>
                      <span className="inline-flex items-center gap-1">
                        <GitBranch className="size-3" aria-hidden="true" />
                        {run.target === "local" ? (run.branch || "main") : `${run.target} · ${run.branch || "main"}`}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
