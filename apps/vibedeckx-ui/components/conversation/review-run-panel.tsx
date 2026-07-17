"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type WorkflowRun } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, X } from "lucide-react";

const ACTIVE = new Set(["waiting_reviewer", "waiting_feedback", "sending_feedback"]);

export function ReviewRunPanel({
  projectId,
  branch,
  runUpdate,
  onRunsChange,
}: {
  projectId: string | null;
  branch: string | null;
  runUpdate: WorkflowRun | null;
  onRunsChange?: (runs: WorkflowRun[]) => void;
}) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const active = await api.getActiveWorkflowRuns(projectId, branch);
      setRuns(active);
      onRunsChange?.(active);
    } catch {
      /* transient */
    }
  }, [projectId, branch, onRunsChange]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (runUpdate) void refresh(); }, [runUpdate, refresh]);
  // Polling fallback while a run is active (WS push is best-effort).
  useEffect(() => {
    if (runs.length === 0) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [runs.length, refresh]);

  const act = async (fn: () => Promise<unknown>, runId: string) => {
    setBusy(runId);
    setActionError(null);
    try { await fn(); } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); await refresh(); }
  };

  const activeRuns = runs.filter((r) => ACTIVE.has(r.status));
  if (activeRuns.length === 0) return null;

  return (
    <div className="border-b bg-muted/30 px-4 py-2 space-y-2">
      {activeRuns.map((run) => (
        <div key={run.id} className="text-sm space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium">
              Review{run.review_focus ? ` — ${run.review_focus}` : ""}
              <span className="ml-2 text-muted-foreground">
                {run.status === "waiting_reviewer" && "reviewer 审查中…"}
                {run.status === "waiting_feedback" && "等你确认反馈"}
                {run.status === "sending_feedback" && "发送中…"}
              </span>
            </span>
            <Button variant="ghost" size="sm" disabled={busy === run.id}
              onClick={() => act(() => api.cancelWorkflowRun(run.id), run.id)}>
              <X className="h-3 w-3 mr-1" />结束
            </Button>
          </div>
          {run.error && <div className="text-xs text-amber-600">{run.error}</div>}
          {run.status === "waiting_reviewer" && (
            <div className="flex items-center text-muted-foreground text-xs">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> reviewer session 正在工作
            </div>
          )}
          {run.status === "waiting_feedback" && (
            <>
              <Textarea
                className="text-xs font-mono min-h-28"
                value={draft[run.id] ?? run.feedback_snapshot ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [run.id]: e.target.value }))}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={busy === run.id}
                  onClick={() => act(() => api.workflowRunGate(run.id, "approve", draft[run.id] ?? undefined), run.id)}>
                  发送反馈给原 session
                </Button>
              </div>
            </>
          )}
          {actionError && <div className="text-xs text-destructive">{actionError}</div>}
        </div>
      ))}
    </div>
  );
}
