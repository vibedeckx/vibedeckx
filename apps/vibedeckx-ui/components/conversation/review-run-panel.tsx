"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type WorkflowRun } from "@/lib/api";
import { fetchActiveWorkflowRuns } from "@/lib/workflow-runs-fetch";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageResponse } from "@/components/ai-elements/message";
import { Eye, FileCheck, Loader2, Pencil, X } from "lucide-react";

const ACTIVE = new Set(["preparing", "waiting_reviewer", "waiting_feedback", "discussing", "sending_feedback"]);

export function ReviewRunPanel({
  projectId,
  branch,
  runUpdate,
  streamEpoch,
  onRunsChange,
}: {
  projectId: string | null;
  branch: string | null;
  runUpdate: WorkflowRun | null;
  /** Bumped on every Main Chat WS `Ready` — see the reconciliation effect. */
  streamEpoch: number;
  onRunsChange?: (runs: WorkflowRun[]) => void;
}) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // `force`: the workspace-change read may share an in-flight request with
  // useReviewerRun's seed (same commit, same data); every other trigger wants a
  // snapshot taken *after* the event that caused it — a runUpdate frame, a
  // gate action, or the poll tick — so it must not ride an older request.
  //
  // `reqSeq` makes the last *issued* read the one that lands. `force` starts a
  // second request but cannot cancel the first, and these reads are remote
  // proxy round-trips that routinely overtake each other: the mount read
  // (issued before the run existed, resolving empty) finishing after the
  // reconnect read would blank the panel again — the exact bug the reconnect
  // reconciliation below is here to fix. The ref outlives projectId/branch
  // changes on purpose, so a read from the workspace you just left cannot land
  // either.
  const reqSeqRef = useRef(0);
  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    if (!projectId) return;
    const seq = ++reqSeqRef.current;
    try {
      const active = await fetchActiveWorkflowRuns(projectId, branch, opts);
      if (seq !== reqSeqRef.current) return;
      setRuns(active);
      onRunsChange?.(active);
    } catch {
      /* transient */
    }
  }, [projectId, branch, onRunsChange]);

  // Mount read, plus a forced re-read on every WS (re)connect. `runUpdate` is a
  // fire-and-forget push with no replay: a frame emitted while the socket was
  // down is gone for good, and with zero runs held the poll below never starts —
  // so without this reconciliation the panel stays blank forever (that is the
  // 2026-08-18 failure, docs/troubleshooting/review-panel-missing-in-main-chat.md).
  // The first pass after mount is unforced so it can share useReviewerRun's
  // in-flight read; later epochs must see state from after the reconnect.
  const seededEpochRef = useRef<number | null>(null);
  useEffect(() => {
    const force = seededEpochRef.current !== null && seededEpochRef.current !== streamEpoch;
    seededEpochRef.current = streamEpoch;
    void refresh({ force });
  }, [refresh, streamEpoch]);
  useEffect(() => { if (runUpdate) void refresh({ force: true }); }, [runUpdate, refresh]);
  // Polling fallback while a run is active (WS push is best-effort).
  useEffect(() => {
    if (runs.length === 0) return;
    const t = setInterval(() => void refresh({ force: true }), 5000);
    return () => clearInterval(t);
  }, [runs.length, refresh]);

  const act = async (fn: () => Promise<unknown>, runId: string) => {
    setBusy(runId);
    setActionError(null);
    try { await fn(); } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); await refresh({ force: true }); }
  };

  const activeRuns = runs.filter((r) => ACTIVE.has(r.status));
  if (activeRuns.length === 0) return null;

  return (
    // shrink-0 + max-h: the panel sits above the flex-1 conversation; without a
    // cap, the content-sized feedback textarea below would grow the panel past
    // the viewport and push the rest of the chat off-screen with no way to
    // scroll to it.
    <div className="shrink-0 border-b bg-muted/30 px-4 py-2 space-y-2 max-h-[50vh] overflow-y-auto">
      {activeRuns.map((run) => (
        <div key={run.id} className="space-y-2" style={{ fontSize: "var(--conv-font-size, 14px)" }}>
          <div className="flex items-center justify-between">
            <span className="font-medium">
              Review{run.review_focus ? ` — ${run.review_focus}` : ""}
              <span className="ml-2 text-muted-foreground">
                {run.status === "preparing" && "准备中…"}
                {run.status === "waiting_reviewer" && "reviewer 审查中…"}
                {run.status === "waiting_feedback" && "等你确认反馈"}
                {run.status === "discussing" && "讨论中"}
                {run.status === "sending_feedback" && "发送中…"}
              </span>
            </span>
            <Button variant="ghost" size="sm" disabled={busy === run.id}
              onClick={() => act(() => api.cancelWorkflowRun(run.id), run.id)}>
              <X className="h-3 w-3 mr-1" />结束
            </Button>
          </div>
          {run.error && (
            <div className="text-amber-600" style={{ fontSize: "var(--conv-font-size, 12px)" }}>{run.error}</div>
          )}
          {run.status === "preparing" && (
            <div className="flex items-center text-muted-foreground" style={{ fontSize: "var(--conv-font-size, 12px)" }}>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> 正在蒸馏上下文并启动 reviewer
            </div>
          )}
          {run.status === "waiting_reviewer" && (
            <div className="flex items-center text-muted-foreground" style={{ fontSize: "var(--conv-font-size, 12px)" }}>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> reviewer session 正在工作
            </div>
          )}
          {run.status === "discussing" && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground" style={{ fontSize: "var(--conv-font-size, 12px)" }}>
                与 reviewer 讨论后，生成终稿再发送
              </span>
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="生成 review 终稿"
                disabled={busy === run.id}
                onClick={() => act(() => api.workflowRunGate(run.id, "finalize"), run.id)}>
                <FileCheck className="h-3 w-3" />
              </Button>
            </div>
          )}
          {run.status === "waiting_feedback" && (
            <>
              {/* Rendered markdown by default; the textarea only appears while
                  editing. Both are max-h capped (the textarea auto-grows via
                  field-sizing-content) so a long review scrolls inside its box
                  instead of inflating the panel. */}
              {editing[run.id] ? (
                <Textarea
                  className="font-mono min-h-28 max-h-72"
                  style={{ fontSize: "var(--conv-font-size, 12px)" }}
                  value={draft[run.id] ?? run.feedback_snapshot ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [run.id]: e.target.value }))}
                />
              ) : (
                <div
                  className="border rounded-md bg-background px-3 py-2 max-h-72 overflow-y-auto"
                  style={{ fontSize: "var(--conv-font-size, 12px)" }}
                >
                  <MessageResponse>{draft[run.id] ?? run.feedback_snapshot ?? ""}</MessageResponse>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" disabled={busy === run.id}
                  onClick={() => act(() => api.workflowRunGate(run.id, "approve", draft[run.id] ?? undefined), run.id)}>
                  发送反馈给原 session
                </Button>
                <Button variant="outline" size="sm" disabled={busy === run.id}
                  onClick={() => setEditing((e) => ({ ...e, [run.id]: !e[run.id] }))}>
                  {editing[run.id]
                    ? <><Eye className="h-3 w-3 mr-1" />预览</>
                    : <><Pencil className="h-3 w-3 mr-1" />编辑</>}
                </Button>
              </div>
            </>
          )}
          {actionError && (
            <div className="text-destructive" style={{ fontSize: "var(--conv-font-size, 12px)" }}>{actionError}</div>
          )}
        </div>
      ))}
    </div>
  );
}
