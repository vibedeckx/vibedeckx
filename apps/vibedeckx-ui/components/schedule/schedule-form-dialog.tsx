"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Check,
  Clock,
  Folder,
  GitBranch,
  Info,
  Loader2,
  Monitor,
  Plus,
  Server,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  api,
  type ProjectRemote,
  type PromptProvider,
  type Schedule,
  type ScheduleInput,
  type ScheduleRun,
  type Worktree,
} from "@/lib/api";
import { browserTimezone, previewCron } from "@/lib/schedule-cron";
import { formatDuration } from "@/lib/format-duration";
import { isMacPlatform } from "@/lib/tab-shortcuts";
import { cn } from "@/lib/utils";
import { ScheduleTimingField } from "./schedule-timing-field";
import {
  BOX_INPUT,
  CONTROL_INPUT,
  CONTROL_TRIGGER,
  ControlBox,
  FieldLabel,
  HintLine,
  InlineLink,
  Segmented,
  Strip,
} from "./schedule-form-chrome";

// Radix Select items can't have an empty-string value; sentinel for the main worktree.
const MAIN = "__main__";

const noopSubscribe = () => () => {};

const PROVIDER_LABELS: Record<PromptProvider, string> = { claude: "Claude", codex: "Codex" };

// SQLite timestamps are UTC "YYYY-MM-DD HH:MM:SS"; ISO strings pass through.
function parseTs(ts: string): Date {
  return new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
}

function relativeTime(at: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "succeeded in 3m 12s" / "failed after 40s" / "running now" for the edit-mode strip. */
function describeRunOutcome(run: ScheduleRun): string {
  const elapsed = run.finished_at
    ? formatDuration(parseTs(run.finished_at).getTime() - parseTs(run.started_at).getTime())
    : null;
  switch (run.status) {
    case "completed": return elapsed ? `succeeded in ${elapsed}` : "succeeded";
    case "failed": return elapsed ? `failed after ${elapsed}` : "failed";
    case "timeout": return elapsed ? `timed out after ${elapsed}` : "timed out";
    case "killed": return elapsed ? `stopped after ${elapsed}` : "stopped";
    case "skipped": return "skipped";
    default: return "running now";
  }
}

export function ScheduleFormDialog({
  open,
  onOpenChange,
  onSubmit,
  initial,
  worktrees,
  projectId,
  onOpenRun,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: ScheduleInput) => Promise<void>;
  /** Set when editing an existing schedule. */
  initial?: Schedule | null;
  worktrees: Worktree[];
  projectId?: string;
  /** Edit mode: "Open run" on the last-run strip. The dialog closes itself first. */
  onOpenRun?: (run: ScheduleRun) => void;
  /** Edit mode: "Delete task" in the footer. The dialog closes itself first. */
  onDelete?: (schedule: Schedule) => void;
}) {
  const [name, setName] = useState("");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState("");
  const [target, setTarget] = useState<string>("local");
  const [remotes, setRemotes] = useState<ProjectRemote[]>([]);
  const [runType, setRunType] = useState<"command" | "prompt">("command");
  const [promptProvider, setPromptProvider] = useState<PromptProvider>("claude");
  const [content, setContent] = useState("");
  const [cwdMode, setCwdMode] = useState<"branch" | "directory">("branch");
  const [branch, setBranch] = useState<string>(MAIN);
  const [targetWorktrees, setTargetWorktrees] = useState<Worktree[]>(worktrees);
  const [targetLoading, setTargetLoading] = useState(false);
  const [directory, setDirectory] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("30");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMac = useSyncExternalStore(noopSubscribe, isMacPlatform, () => false);

  // (Re)seed fields each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(initial?.name ?? "");
    setCronExpr(initial?.cron_expr ?? "0 9 * * *");
    setTimezone(initial?.timezone ?? browserTimezone());
    setTarget(initial?.target ?? "local");
    setRunType(initial?.run_type ?? "command");
    setPromptProvider(initial?.prompt_provider ?? "claude");
    setContent(initial?.content ?? "");
    setCwdMode(initial?.cwd_mode ?? "branch");
    setBranch(initial?.branch ?? MAIN);
    setDirectory(initial?.directory ?? "");
    setTimeoutMinutes(String(Math.round((initial?.timeout_seconds ?? 1800) / 60)));
  }, [open, initial]);

  useEffect(() => {
    if (target === "local") setTargetWorktrees(worktrees);
  }, [target, worktrees]);

  // Load the project's configured remotes while the dialog is open, for the Target selector.
  useEffect(() => {
    let cancelled = false;
    if (open && projectId) {
      api.getProjectRemotes(projectId)
        .then((r) => { if (!cancelled) setRemotes(r); })
        .catch((err) => console.error("Failed to load project remotes:", err));
    }
    return () => { cancelled = true; };
  }, [open, projectId]);

  // Load workspace choices for the selected execution target. Local worktrees
  // are already supplied by the page; remote targets need a target-scoped fetch.
  useEffect(() => {
    let cancelled = false;
    if (!open || !projectId || target === "local") return;
    setTargetLoading(true);
    api.getProjectWorktrees(projectId, target)
      .then((items) => { if (!cancelled) setTargetWorktrees(items); })
      .catch((err) => {
        console.error("Failed to load target worktrees:", err);
        if (!cancelled) setTargetWorktrees([{ branch: null }]);
      })
      .finally(() => { if (!cancelled) setTargetLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, target]);

  const preview = useMemo(() => previewCron(cronExpr, timezone || "UTC"), [cronExpr, timezone]);

  const submitDisabled = loading || !name.trim() || !content.trim() || !preview.ok;

  const handleSubmit = async () => {
    if (!name.trim() || !content.trim()) {
      setError("Name and content are required");
      return;
    }
    if (!preview.ok) {
      setError(preview.error);
      return;
    }
    const minutes = parseInt(timeoutMinutes, 10);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      setError("Timeout must be a positive number of minutes");
      return;
    }
    if (cwdMode === "directory" && !directory.trim()) {
      setError("Directory is required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        cron_expr: cronExpr.trim(),
        timezone: timezone.trim() || "UTC",
        target,
        run_type: runType,
        prompt_provider: runType === "prompt" ? promptProvider : null,
        content,
        cwd_mode: cwdMode,
        branch: cwdMode === "branch" ? (branch === MAIN ? null : branch) : null,
        directory: cwdMode === "directory" ? directory.trim() : null,
        timeout_seconds: minutes * 60,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save schedule");
    } finally {
      setLoading(false);
    }
  };

  const editing = Boolean(initial);
  const lastRun = initial?.last_run ?? null;
  const remoteName = target === "local"
    ? null
    : (remotes.find((r) => r.remote_server_id === target)?.server_name ?? target);
  const submitLabel = editing ? "Save" : "Create";

  // The strip only ever shows one thing: a submit failure wins over the
  // standing "fix the cron" reminder, which in turn mirrors the disabled button.
  const blocker = error ?? (preview.ok ? null : "Fix the cron expression before saving.");

  const footNote = runType === "prompt"
    ? `${PROVIDER_LABELS[promptProvider]} runs unattended on ${remoteName ?? "this machine"}`
    : "Runs even while the app is closed";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] min-w-0 gap-0 overflow-hidden bg-card p-0 grid-rows-[auto_minmax(0,1fr)_auto] sm:w-full sm:max-w-[520px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !submitDisabled) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
      >
        <div className="flex items-start gap-3 border-b bg-secondary px-4 py-3.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-primary/20 bg-accent text-accent-foreground">
            <Clock className="size-[15px]" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[14.5px] font-semibold tracking-tight">
              {editing ? "Edit Scheduled Task" : "New Scheduled Task"}
            </DialogTitle>
            <DialogDescription className="mt-0.5 max-w-[42ch] text-[11.5px] leading-snug">
              {editing
                ? "Changes take effect from the next run. The current run, if any, finishes on the old settings."
                : "Run a command or an agent prompt on a schedule."}
            </DialogDescription>
          </div>
          <DialogClose className="ml-auto grid size-6 shrink-0 place-items-center rounded-md border border-transparent text-muted-foreground/70 transition-colors hover:border-border hover:bg-muted hover:text-foreground">
            <X className="size-3.5" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        <div
          data-slot="schedule-form-body"
          className="flex min-h-0 min-w-0 flex-col gap-[13px] overflow-x-hidden overflow-y-auto px-4 pt-3.5 pb-1"
        >
          {editing && lastRun && (
            <Strip tone="info" icon={<Info />}>
              Last run <b className="font-semibold">{relativeTime(parseTs(lastRun.started_at))}</b>
              {" · "}{describeRunOutcome(lastRun)}
              {onOpenRun && lastRun.status !== "skipped" && (
                <>
                  {" · "}
                  <InlineLink onClick={() => { onOpenChange(false); onOpenRun(lastRun); }}>Open run</InlineLink>
                </>
              )}
            </Strip>
          )}

          <div className="flex min-w-0 flex-col gap-[7px]">
            <FieldLabel note={name.trim() ? undefined : "Required"}>Name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily log analysis"
              aria-label="Name"
              className={cn(CONTROL_INPUT, "h-[34px] px-[11px]")}
              disabled={loading}
            />
          </div>

          <ScheduleTimingField
            cronExpr={cronExpr}
            onCronExprChange={setCronExpr}
            timezone={timezone || "UTC"}
            onTimezoneChange={setTimezone}
            preview={preview}
            disabled={loading}
          />

          <div className="flex min-w-0 flex-col gap-[7px]">
            <FieldLabel
              after={runType === "prompt" && (
                <Select value={promptProvider} onValueChange={(v) => setPromptProvider(v as PromptProvider)} disabled={loading}>
                  <SelectTrigger
                    size="sm"
                    aria-label="Agent"
                    className="h-[23px] gap-1 rounded-[7px] border-input bg-card px-2 py-0 text-[11px] font-medium text-secondary-foreground shadow-none hover:bg-muted [&_svg:not([class*='size-'])]:size-2.5"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PROVIDER_LABELS) as PromptProvider[]).map((p) => (
                      <SelectItem key={p} value={p}>{PROVIDER_LABELS[p]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              trailing={
                <Segmented
                  label="Task type"
                  value={runType}
                  onChange={setRunType}
                  disabled={loading}
                  options={[
                    { value: "command", label: "Command (shell)" },
                    { value: "prompt", label: "Prompt" },
                  ]}
                />
              }
            >
              {runType === "command" ? "Command" : "Prompt"}
            </FieldLabel>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={runType === "command" ? "./scripts/scan.sh --daily" : "Analyze today's server logs under ./logs and summarize anomalies"}
              aria-label={runType === "command" ? "Command" : "Prompt"}
              className={cn(
                CONTROL_INPUT,
                "field-sizing-fixed min-h-[74px] min-w-0 max-w-full resize-y overflow-auto px-[11px] py-2 font-mono text-xs leading-[1.55] md:text-xs",
              )}
              disabled={loading}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-[7px]">
            <FieldLabel note="Runs in">Target</FieldLabel>
            <div className="grid min-w-0 grid-cols-2 gap-2.5">
              <Select value={target} onValueChange={(v) => { setTarget(v); setBranch(MAIN); }} disabled={loading}>
                <SelectTrigger size="sm" aria-label="Target" className={CONTROL_TRIGGER}>
                  <SelectValue placeholder="Local" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">
                    <Monitor className="size-3 text-muted-foreground/70" />
                    Local
                  </SelectItem>
                  {remotes.map((r) => (
                    <SelectItem key={r.remote_server_id} value={r.remote_server_id}>
                      <Server className="size-3 text-muted-foreground/70" />
                      {r.server_name ?? r.remote_server_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {cwdMode === "branch" ? (
                targetLoading ? (
                  <ControlBox disabled className="cursor-default px-2.5">
                    <Loader2 className="animate-spin" />
                    <span className="truncate">Loading workspaces…</span>
                  </ControlBox>
                ) : (
                  <Select value={branch} onValueChange={setBranch} disabled={loading}>
                    <SelectTrigger size="sm" aria-label="Workspace" className={CONTROL_TRIGGER}>
                      <SelectValue placeholder="Select workspace" />
                    </SelectTrigger>
                    <SelectContent>
                      {targetWorktrees.map((wt) => (
                        <SelectItem key={wt.branch ?? MAIN} value={wt.branch ?? MAIN}>
                          <GitBranch className="size-3 text-muted-foreground/70" />
                          <span className="font-mono text-xs">{wt.branch ?? "main"}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              ) : (
                <ControlBox disabled={loading}>
                  <Folder />
                  <input
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                    placeholder="/var/log/myapp"
                    aria-label="Directory"
                    spellCheck={false}
                    className={cn(BOX_INPUT, "font-mono text-xs tracking-tight")}
                    disabled={loading}
                  />
                </ControlBox>
              )}
            </div>
            {/* One line in both modes — the description truncates rather than
                wrapping, so toggling the mode never shifts the fields below. */}
            <HintLine nowrap>
              <span className="truncate">
                {cwdMode === "branch"
                  ? remoteName
                    ? targetLoading
                      ? `Loading workspaces on ${remoteName}`
                      : `${targetWorktrees.length} ${targetWorktrees.length === 1 ? "workspace" : "workspaces"} on ${remoteName}`
                    : "Runs in the selected workspace"
                  : "Runs straight in this directory, with no workspace"}
              </span>
              <span className="shrink-0">·</span>
              {cwdMode === "branch" ? (
                <>
                  <InlineLink onClick={() => setCwdMode("directory")} disabled={loading}>use a plain directory</InlineLink>
                  <span className="shrink-0">for non-repo work</span>
                </>
              ) : (
                <InlineLink onClick={() => setCwdMode("branch")} disabled={loading}>use a workspace instead</InlineLink>
              )}
            </HintLine>
          </div>

          <div className="flex min-w-0 flex-col gap-[7px]">
            <FieldLabel>Timeout</FieldLabel>
            <ControlBox disabled={loading} className="w-32">
              <input
                value={timeoutMinutes}
                onChange={(e) => setTimeoutMinutes(e.target.value)}
                inputMode="numeric"
                aria-label="Timeout in minutes"
                className={BOX_INPUT}
                disabled={loading}
              />
              <span className="text-[11px] whitespace-nowrap text-muted-foreground/70">minutes</span>
            </ControlBox>
          </div>

          {blocker && (
            <Strip tone="rose" icon={<TriangleAlert />}>{blocker}</Strip>
          )}
        </div>

        <div className="mt-2.5 flex min-w-0 items-center gap-2.5 overflow-hidden border-t bg-secondary px-4 py-2.5">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
            {editing && initial && onDelete ? (
              <>
                <Trash2 className="size-3 shrink-0 text-muted-foreground/70" />
                <InlineLink onClick={() => { onOpenChange(false); onDelete(initial); }} disabled={loading}>
                  Delete task
                </InlineLink>
              </>
            ) : (
              <>
                <Info className="size-3 shrink-0 text-muted-foreground/70" />
                <span className="truncate">{footNote}</span>
              </>
            )}
          </span>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1.5 text-xs"
            aria-label={submitLabel}
            onClick={() => void handleSubmit()}
            disabled={submitDisabled}
          >
            {loading ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                {editing ? <Check className="size-3" /> : <Plus className="size-3" />}
                {submitLabel}
                <kbd
                  className="rounded border border-primary-foreground/30 bg-primary-foreground/15 px-1 font-mono text-[10px] leading-[1.4] text-primary-foreground/90"
                  title={isMac ? "Command+Enter" : "Ctrl+Enter"}
                >
                  {isMac ? "⌘⏎" : "Ctrl⏎"}
                </kbd>
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
