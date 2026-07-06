"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type ProjectRemote, type PromptProvider, type Schedule, type ScheduleInput, type Worktree } from "@/lib/api";

// Radix Select items can't have an empty-string value; sentinel for the main worktree.
const MAIN = "__main__";

export function ScheduleFormDialog({
  open,
  onOpenChange,
  onSubmit,
  initial,
  worktrees,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: ScheduleInput) => Promise<void>;
  /** Set when editing an existing schedule. */
  initial?: Schedule | null;
  worktrees: Worktree[];
  projectId?: string;
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
  const [directory, setDirectory] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("30");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)seed fields each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(initial?.name ?? "");
    setCronExpr(initial?.cron_expr ?? "0 9 * * *");
    setTimezone(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
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
    api.getProjectWorktrees(projectId, target)
      .then((items) => { if (!cancelled) setTargetWorktrees(items); })
      .catch((err) => {
        console.error("Failed to load target worktrees:", err);
        if (!cancelled) setTargetWorktrees([{ branch: null }]);
      });
    return () => { cancelled = true; };
  }, [open, projectId, target]);

  const handleSubmit = async () => {
    if (!name.trim() || !content.trim()) {
      setError("Name and content are required");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Scheduled Task" : "New Scheduled Task"}</DialogTitle>
          <DialogDescription>
            Run a command or a Claude prompt on a cron schedule
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily log analysis" disabled={loading} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Cron</label>
              <Input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} placeholder="0 9 * * *" className="font-mono" disabled={loading} />
              <p className="text-xs text-muted-foreground">5-field cron — “0 9 * * *” = every day at 09:00</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Timezone</label>
              <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Shanghai" disabled={loading} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Type</label>
              <Select value={runType} onValueChange={(v) => setRunType(v as "command" | "prompt")} disabled={loading}>
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="command">Command (shell)</SelectItem>
                  <SelectItem value="prompt">Prompt</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {runType === "prompt" && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Agent</label>
                <Select value={promptProvider} onValueChange={(v) => setPromptProvider(v as PromptProvider)} disabled={loading}>
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{runType === "command" ? "Command" : "Prompt"}</label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={runType === "command" ? "./scripts/scan.sh --daily" : "Analyze today's server logs under ./logs and summarize anomalies"}
              className="font-mono text-sm min-h-[80px]"
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Target</label>
            <Select value={target} onValueChange={(v) => { setTarget(v); setBranch(MAIN); }} disabled={loading}>
              <SelectTrigger size="sm">
                <SelectValue placeholder="Local" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local</SelectItem>
                {remotes.map((r) => (
                  <SelectItem key={r.remote_server_id} value={r.remote_server_id}>
                    {r.server_name ?? r.server_url ?? r.remote_server_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Runs in</label>
              <Select value={cwdMode} onValueChange={(v) => setCwdMode(v as "branch" | "directory")} disabled={loading}>
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="branch">Workspace (branch)</SelectItem>
                  <SelectItem value="directory">Directory</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              {cwdMode === "branch" ? (
                <>
                  <label className="text-sm font-medium">Workspace</label>
                  <Select value={branch} onValueChange={setBranch} disabled={loading}>
                    <SelectTrigger size="sm">
                      <SelectValue placeholder="Select workspace" />
                    </SelectTrigger>
                    <SelectContent>
                      {targetWorktrees.map((wt) => (
                        <SelectItem key={wt.branch ?? MAIN} value={wt.branch ?? MAIN}>
                          {wt.branch ?? "main"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <>
                  <label className="text-sm font-medium">Directory</label>
                  <Input value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="/var/log/myapp" className="font-mono" disabled={loading} />
                </>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Timeout (minutes)</label>
            <Input value={timeoutMinutes} onChange={(e) => setTimeoutMinutes(e.target.value)} className="w-24" disabled={loading} />
          </div>

          {error && <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={loading || !name.trim() || !content.trim()}>
            {loading ? "Saving..." : initial ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
