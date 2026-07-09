"use client";

import { useCallback, useEffect, useState } from "react";
import { Play, Pencil, Trash2, CalendarClock } from "lucide-react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import { api, type Schedule, type ScheduleInput, type ScheduleRun, type Worktree } from "@/lib/api";
import { PageHeader } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScheduleFormDialog } from "./schedule-form-dialog";

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-500/15 text-blue-600",
  completed: "bg-emerald-500/15 text-emerald-600",
  failed: "bg-red-500/15 text-red-600",
  timeout: "bg-amber-500/15 text-amber-600",
  killed: "bg-amber-500/15 text-amber-600",
  skipped: "bg-muted text-muted-foreground",
};

// PTY output carries ANSI escapes and \r line endings; clean for <pre> display.
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function cleanOutput(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// SQLite timestamps are UTC "YYYY-MM-DD HH:MM:SS"; next_run_at is already ISO.
function parseTs(ts: string): Date {
  return new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
}
function fmtTs(ts: string | null | undefined): string {
  return ts ? parseTs(ts).toLocaleString() : "—";
}
function fmtDuration(run: ScheduleRun): string {
  if (!run.finished_at) return "…";
  const s = Math.max(0, Math.round((parseTs(run.finished_at).getTime() - parseTs(run.started_at).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function SchedulesView({
  projectId,
  schedules,
  loading,
  selectedId,
  onSelect,
  worktrees,
  onCreate,
  onUpdate,
  onDelete,
  onRunNow,
  createOpen,
  onCreateOpenChange,
}: {
  projectId: string;
  schedules: Schedule[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  worktrees: Worktree[];
  onCreate: (input: ScheduleInput) => Promise<Schedule>;
  onUpdate: (id: string, input: Partial<ScheduleInput>) => Promise<Schedule>;
  onDelete: (id: string) => Promise<void>;
  onRunNow: (id: string) => Promise<{ runId: string }>;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const selected = schedules.find((s) => s.id === selectedId) ?? schedules[0] ?? null;

  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [viewRun, setViewRun] = useState<ScheduleRun | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refetchRuns = useCallback(async (scheduleId: string) => {
    try {
      return await api.getScheduleRuns(scheduleId);
    } catch (err) {
      console.error("Failed to fetch schedule runs:", err);
      return null;
    }
  }, []);

  // Refetch on selection change AND whenever the schedules array identity
  // changes (useSchedules refetches on schedule:* SSE events, so a finished
  // run refreshes this list too). Guards against a stale response from a
  // superseded selection clobbering the latest one.
  useEffect(() => {
    const scheduleId = selected?.id;
    let stale = false;
    void (scheduleId ? refetchRuns(scheduleId) : Promise.resolve([])).then((result) => {
      if (!stale) setRuns(result ?? []);
    });
    return () => {
      stale = true;
    };
  }, [selected?.id, schedules, refetchRuns]);

  const handleRunNow = async () => {
    if (!selected) return;
    setActionError(null);
    try {
      await onRunNow(selected.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start run");
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete scheduled task "${selected.name}" and its run history?`)) return;
    await onDelete(selected.id);
  };

  const openRun = async (run: ScheduleRun) => {
    if (run.status === "skipped") return;
    try {
      setViewRun(await api.getScheduleRun(run.id));
    } catch (err) {
      console.error("Failed to fetch run output:", err);
    }
  };

  if (!loading && schedules.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-center">
        <CalendarClock className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">No scheduled tasks yet</p>
        <Button size="sm" onClick={() => onCreateOpenChange(true)}>
          New Scheduled Task
        </Button>
        <ScheduleFormDialog open={createOpen} onOpenChange={onCreateOpenChange} onSubmit={async (input) => { await onCreate(input); }} worktrees={worktrees} projectId={projectId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {selected && (
        <>
          <PageHeader
            title={selected.name}
            description={`${selected.cron_expr} · ${selected.timezone} · next: ${fmtTs(selected.next_run_at)}`}
            actions={
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleRunNow} disabled={!!selected.running}>
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  {selected.running ? "Running…" : "Run now"}
                </Button>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.enabled}
                    onChange={(e) => void onUpdate(selected.id, { enabled: e.target.checked })}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span>Enabled</span>
                </label>
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="outline" onClick={handleDelete} className="hover:bg-destructive/15 hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            }
          />

          <div className="px-5 py-3 grid grid-cols-2 gap-x-8 gap-y-1 text-sm border-b border-border/50">
            <div>
              <span className="text-muted-foreground">Type: </span>
              {selected.run_type === "command" ? "Command" : `Prompt (${selected.prompt_provider === "codex" ? "Codex" : "Claude"})`}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Runs in: </span>
              {selected.cwd_mode === "branch" ? `workspace ${selected.branch ?? "main"}` : selected.directory}
              {selected.target !== "local" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-600">
                  remote
                </span>
              )}
            </div>
            <div className="col-span-2 font-mono text-xs text-muted-foreground truncate" title={selected.content}>
              {selected.content}
            </div>
            <div>
              <span className="text-muted-foreground">Timeout: </span>
              {Math.round(selected.timeout_seconds / 60)}m
            </div>
          </div>

          {actionError && <div className="mx-5 mt-3 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{actionError}</div>}

          <div className="flex-1 overflow-auto px-5 py-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Exit code</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id} onClick={() => void openRun(run)} className={cn(run.status !== "skipped" && "cursor-pointer")}>
                    <TableCell>{fmtTs(run.started_at)}</TableCell>
                    <TableCell>{run.status === "skipped" ? "—" : fmtDuration(run)}</TableCell>
                    <TableCell>
                      <span className={cn("px-1.5 py-0.5 rounded text-[11px] font-medium", STATUS_STYLES[run.status])}>{run.status}</span>
                    </TableCell>
                    <TableCell>{run.exit_code ?? "—"}</TableCell>
                  </TableRow>
                ))}
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      No runs yet — click “Run now” to try it
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <ScheduleFormDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            initial={selected}
            onSubmit={async (input) => {
              await onUpdate(selected.id, input);
            }}
            worktrees={worktrees}
            projectId={projectId}
          />
        </>
      )}

      <ScheduleFormDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        onSubmit={async (input) => {
          const created = await onCreate(input);
          onSelect(created.id);
        }}
        worktrees={worktrees}
        projectId={projectId}
      />

      <Dialog open={viewRun !== null} onOpenChange={(o) => !o && setViewRun(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {viewRun?.report ? "Run report" : "Run output"} — {viewRun ? fmtTs(viewRun.started_at) : ""}{" "}
              {viewRun && <span className={cn("ml-2 px-1.5 py-0.5 rounded text-[11px] font-medium", STATUS_STYLES[viewRun.status])}>{viewRun.status}</span>}
            </DialogTitle>
          </DialogHeader>
          {viewRun?.report ? (
            <>
              <div className="max-h-[50vh] overflow-auto rounded-md border border-border/50 p-3 text-sm">
                <Streamdown className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{viewRun.report}</Streamdown>
              </div>
              <details>
                <summary className="text-xs text-muted-foreground cursor-pointer select-none">Raw output</summary>
                <pre className="mt-2 max-h-[30vh] overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap">
                  {viewRun.output ? cleanOutput(viewRun.output) : "(no output captured)"}
                </pre>
              </details>
            </>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap">
              {viewRun?.output ? cleanOutput(viewRun.output) : "(no output captured)"}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
