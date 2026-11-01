"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, repeatLoopParams, type WorkflowRun, type WorkflowVerdict } from "@/lib/api";
import { fetchActiveWorkflowRunsAt } from "@/lib/workflow-runs-fetch";
import { presetSourceLabel } from "@/lib/loop-presets";
import { useNotificationInbox } from "@/hooks/notification-inbox-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageResponse } from "@/components/ai-elements/message";
import { AlarmClock, AlertTriangle, Check, ChevronDown, ChevronRight, Eye, FileCheck, FileText, Loader2, Pause, Pencil, Play, X } from "lucide-react";

/** `schedule` = set or clear a loop gate's scheduled resume (not a gate action server-side). */
type GateAction = "approve" | "finalize" | "cancel" | "accept" | "rereview" | "pause" | "resume" | "schedule" | "dismiss";

const ACTIVE = new Set(["preparing", "waiting_reviewer", "waiting_feedback", "discussing", "sending_feedback", "waiting_rereview", "running_task", "waiting_resume"]);

const VERDICT_LABEL: Record<WorkflowVerdict, { text: string; className: string }> = {
  ship: { text: "ship", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  "needs-changes": { text: "needs-changes", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  "cannot-verify": { text: "cannot-verify", className: "border-border bg-muted text-muted-foreground" },
};

/** Loop runs only; fields are absent from workers that predate loops. */
function roundLabel(run: WorkflowRun): string | null {
  if (!run.loop_id) return null;
  const round = run.round ?? 1;
  const label = run.max_rounds ? `第 ${round} / ${run.max_rounds} 轮` : `第 ${round} 轮`;
  return run.loop_manual ? `${label} · 已转人工` : label;
}

/** The gate run's round is the one about to start; past the cap it needs an explicit extension. */
function isOverRoundCap(run: WorkflowRun): boolean {
  return run.max_rounds != null && (run.round ?? 1) > run.max_rounds;
}

/**
 * 动作落空时,新状态本身往往就是最好的解释——把它写出来,而不是把后端的
 * 状态守卫原文(如 "run 不在等待反馈确认的状态")甩给用户。返回 null 表示
 * 新状态并不解释这次失败(例如投递失败 502),此时原文更准确。
 */
/**
 * 无主提示(run 已消失)的清除依据。它的 `status` 恒为 null,靠状态比较永远清不掉,
 * 但列表本身一变——最典型的就是又开了一次 review——旧提示就该让位。
 */
function runsSignature(runs: WorkflowRun[]): string {
  return runs.map((r) => r.id).sort().join(",");
}

function explainStale(action: GateAction, fresh: WorkflowRun | null): string | null {
  // 结束本来就是幂等的,原文(如"反馈正在发送,无法取消")比任何改写都准。
  if (action === "cancel") return null;
  // 循环的动作按"整个循环"寻址:手里的 run id 过期(那次迭代刚结算、下一次已建)
  // 后端照样能执行,所以真失败时后端原文就是原因,无需改写。
  if (action === "pause" || action === "resume" || action === "schedule" || action === "dismiss") return null;
  if (!fresh) return "这次 review 已经结束了 —— 反馈可能已经发出,或者 run 已被取消。";
  if (action === "approve") {
    if (fresh.status === "discussing") return "reviewer 已进入讨论:先点「生成终稿」拿到新的结论,再发送反馈。";
    if (fresh.status === "waiting_reviewer") return "reviewer 正在重新出稿,等它完成后再发送。";
    if (fresh.status === "sending_feedback") return "反馈正在发送中。";
  }
  if (action === "finalize") {
    if (fresh.status === "waiting_feedback") return "终稿已经出来了,直接发送反馈即可。";
    if (fresh.status === "waiting_reviewer") return "reviewer 正在出稿,稍候再试。";
  }
  if (action === "accept") {
    if (fresh.status === "discussing") return "reviewer 已进入讨论:先点「生成终稿」拿到新的结论。";
    if (fresh.status === "waiting_reviewer") return "reviewer 正在重新出稿,等它完成后再决定。";
    if (fresh.status === "sending_feedback") return "反馈正在发送中。";
  }
  if (action === "rereview") {
    // 仍在闸门上 = 复审没发出去(reviewer 忙 / 未送达),后端原文就是原因。
    if (fresh.status === "waiting_rereview") return null;
    if (fresh.status === "waiting_reviewer") return "复审已经发起,reviewer 正在审查。";
    if (fresh.status === "waiting_feedback") return "这一轮复审已经出结论了。";
  }
  return null;
}

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
  /** Finished runs whose card stays until the user closes it (server-side flag, so it survives reloads). */
  const [awaitingDismissal, setAwaitingDismissal] = useState<WorkflowRun[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // 按 run 分组,并记下写入时该 run 的状态。面板是常驻挂载的(没有活跃 run 时
  // 只是 return null),所以一个裸字符串会在 state 里活到天荒地老:上一次
  // review 的失败提示会原样挂到下一次 review 的卡片下面,而它描述的 run 早
  // 已结束。`status` 让 refresh 落地时能判断这条提示是否已经过期并清掉。
  const [actionError, setActionError] =
    useState<{ runId: string; status: string | null; message: string; signature: string } | null>(null);
  /** 动作序号:新动作作废旧动作那趟还在路上的解释。 */
  const actionSeqRef = useRef(0);
  const { markReviewRunRead } = useNotificationInbox();

  // 切工作区一并丢弃:面板不 remount,否则 A 分支留下的提示会在切回来时复活。
  const [seenWorkspace, setSeenWorkspace] = useState(() => ({ projectId, branch }));
  if (seenWorkspace.projectId !== projectId || seenWorkspace.branch !== branch) {
    setSeenWorkspace({ projectId, branch });
    setActionError(null);
  }

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
  /** 最后一次**落地**的快照及其发出时刻——act() 用它判断自己读到的是不是旧货。 */
  const landedRef = useRef<{ at: number; runs: WorkflowRun[] } | null>(null);
  /** 当前工作区(渲染期不可读 ref,故用 effect 同步)——gate 动作跨工作区作废用。 */
  const workspaceRef = useRef({ projectId, branch });
  useEffect(() => { workspaceRef.current = { projectId, branch }; }, [projectId, branch]);

  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    if (!projectId) return;
    const seq = ++reqSeqRef.current;
    const read = fetchActiveWorkflowRunsAt(projectId, branch, opts);
    try {
      const [active, toDismiss] = await Promise.all([read.request, read.awaitingDismissal]);
      if (seq !== reqSeqRef.current) return;
      landedRef.current = { at: read.issuedAt, runs: active };
      setRuns(active);
      setAwaitingDismissal(toDismiss);
      onRunsChange?.(active);
      // 状态一变,上一条失败提示就过期了(讨论完出了终稿、别处已经发送、run
      // 结束……),留着只会误导。无主提示的 status 恒为 null,状态比较对它是
      // no-op,所以另按 run 列表的变化清——否则它会一路挂到下一次 review 头上,
      // 正是这次要修的病。
      setActionError((prev) => {
        if (!prev) return prev;
        const fresh = active.find((r) => r.id === prev.runId) ?? null;
        if ((fresh?.status ?? null) !== prev.status) return null;
        if (!fresh && runsSignature(active) !== prev.signature) return null;
        return prev;
      });
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
  // 唤醒/上线对账。机器休眠后 WS 是僵尸 socket:没有 `Ready`,streamEpoch 不
  // 动,上面那次强制重读不会发生;而睡眠期间的轮询在断网时抛错、被上面的
  // catch 静默吞掉。结果是唤醒后面板停留在睡前快照,用户点的是一张过期卡片,
  // 只能靠服务端的 409 才知道状态早变了。这里把恢复点从"下一次成功轮询"提
  // 到"页面重新可见 / 网络恢复"那一刻。按钮不因失联而禁用 —— 唤醒后立刻可
  // 点是有意的,过期点击由 act() 按新状态解释。
  useEffect(() => {
    const reconcile = () => { if (document.visibilityState === "visible") void refresh({ force: true }); };
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("online", reconcile);
    return () => {
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("online", reconcile);
    };
  }, [refresh]);

  /**
   * 动作之后一律强制对账;失败则按**动作之后**读到的真实状态解释,而不是把后端
   * 的状态守卫原文(如 "run 不在等待反馈确认的状态")甩给用户。
   *
   * 这里自己读一次而不是搭 refresh 的返回值:同一 tick 内的两次 force 读会被
   * 合并成同一趟请求(见 workflow-runs-fetch.ts),所以正常情况下提示和面板列表
   * 本就来自同一份快照;万一被更晚发出的读抢先落地,`landedRef` 让提示改用那份
   * 更新的快照。两条路都不会把后端原文当成"最新状态"写回去。
   *
   * setBusy + 对账留在 finally 里,不是风格问题:改成 try/catch 之后的平铺写法,
   * react-hooks/set-state-in-effect 就会把 refresh 判定成"会同步 setState",
   * 连带把上面三个调用 refresh 的 effect 全部标红。
   */
  const act = async (runId: string, action: GateAction, fn: () => Promise<unknown>) => {
    const mySeq = ++actionSeqRef.current;
    setBusy(runId);
    setActionError(null);
    let failure: string | null = null;
    try { await fn(); } catch (e) { failure = e instanceof Error ? e.message : String(e); }
    finally { setBusy(null); void refresh({ force: true }); }
    if (!failure) {
      // 在这里处理掉 review = 已经看过它了。`review_ready` 指向的是 reviewer
      // session,而这张卡片在**原 session** 的 Main Chat 里:发完反馈、或者结论
      // 是 ship 直接结束之后,还要专程点进 reviewer session 才能消掉铃铛上的红
      // 点,纯属跑腿。「生成终稿」同理——那一轮的结论已经被这次点击消费掉,新
      // 一轮完成时会另发一条未读把铃铛重新点亮。
      //
      // 只在成功后调用:动作失败(如 409「反馈正在发送,无法取消」)时 run 仍然
      // 等着用户,未读也就还该留着。
      //
      // approve/cancel 之后 run 是终态(completed / cancelled),不会再有新一轮,
      // 所以连「点击之后才送达」的迟到通知一并收掉——run 状态是 WS 直推的,而
      // 通知要过 outbox drain,面板先于铃铛拿到结果完全可能。finalize 不同:它
      // 让 run 继续跑,下一轮的未读必须照常亮起来。
      // `rereview` 同 finalize:run 继续跑,下一轮结论的未读要照常亮。
      // `schedule` 同理:闸门还在,只是换了个继续的时机。
      markReviewRunRead(runId, { runEnded: action !== "finalize" && action !== "rereview" && action !== "schedule" });
      return;
    }
    let active: WorkflowRun[] | null = null;
    if (projectId) {
      const read = fetchActiveWorkflowRunsAt(projectId, branch, { force: true });
      const mine = await read.request.catch(() => null);
      const landed = landedRef.current;
      // 更晚发出的读若已经先落地,以它为准:提示必须和面板此刻显示的那份快照一致。
      // 并列(同一趟共享请求,或同毫秒发出)时同样以已落地的为准——那才是屏幕上
      // 的东西。
      active = landed && landed.at >= read.issuedAt ? landed.runs : mine;
    }
    // 读期间用户换了工作区:这条提示已经无处可挂,写出去只会污染新工作区。
    if (workspaceRef.current.projectId !== projectId || workspaceRef.current.branch !== branch) return;
    // 期间又点了一次(按钮在 finally 里就已经放开):那一次说了算,自己这趟迟到的
    // 解释作废——否则重试成功之后还会冒出一条上一轮的红字。
    if (mySeq !== actionSeqRef.current) return;
    const fresh = active?.find((r) => r.id === runId) ?? null;
    setActionError({
      runId,
      status: fresh?.status ?? null,
      // 读也失败(如断网):没有可信状态,退回原文,别把这次点击悄悄吞掉。
      message: (active ? explainStale(action, fresh) : null) ?? failure,
      signature: runsSignature(active ?? []),
    });
  };

  const activeRuns = runs.filter((r) => ACTIVE.has(r.status));
  // run 已经不在列表里(已结束/被取消/反馈其实已经发出)时,提示没有卡片可挂。
  // 面板也不能因为"零活跃 run"直接消失 —— 否则用户点完只看到卡片凭空不见,
  // 得不到任何交代。它不会被对账清掉(status 恒为 null),所以配一个手动关闭。
  const orphanError = actionError && !activeRuns.some((r) => r.id === actionError.runId)
    && !awaitingDismissal.some((r) => r.id === actionError.runId) ? actionError : null;
  if (activeRuns.length === 0 && awaitingDismissal.length === 0 && !orphanError) return null;

  return (
    // shrink-0 + max-h: the panel sits above the flex-1 conversation; without a
    // cap, the content-sized feedback textarea below would grow the panel past
    // the viewport and push the rest of the chat off-screen with no way to
    // scroll to it.
    <div className="shrink-0 border-b bg-muted/30 px-4 py-2 space-y-2 max-h-[50vh] overflow-y-auto">
      {orphanError && (
        <div className="flex items-start justify-between gap-2 text-destructive"
          style={{ fontSize: "var(--conv-font-size, 12px)" }}>
          <span>{orphanError.message}</span>
          <Button variant="ghost" size="icon-sm" aria-label="关闭提示" onClick={() => setActionError(null)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
      {[...awaitingDismissal, ...activeRuns].map((run) => run.kind === "repeat" ? (
        <LoopCard key={run.id} run={run} busy={busy === run.id}
          error={actionError?.runId === run.id ? actionError.message : null}
          onAction={(action) => act(run.id, action, () =>
            action === "cancel" ? api.cancelWorkflowRun(run.id)
              : action === "dismiss" ? api.dismissWorkflowRun(run.id)
                : api.workflowRunGate(run.id, action))}
          onScheduleResume={(at) => act(run.id, "schedule", () => api.scheduleResume(run.id, at))} />
      ) : (
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
                {run.status === "waiting_rereview" && "等你确认复审"}
              </span>
              {roundLabel(run) && <span className="ml-2 text-muted-foreground">{roundLabel(run)}</span>}
            </span>
            <Button variant="ghost" size="sm" disabled={busy === run.id}
              onClick={() => act(run.id, "cancel", () => api.cancelWorkflowRun(run.id))}>
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
                onClick={() => act(run.id, "finalize", () => api.workflowRunGate(run.id, "finalize"))}>
                <FileCheck className="h-3 w-3" />
              </Button>
            </div>
          )}
          {run.status === "waiting_rereview" && (
            // Loop gate: the source finished the turn our feedback opened. A clear
            // needs-changes within the cap re-reviews on its own; the gate is
            // what is left — another verdict, the cap, a failed attempt, or a
            // loop the user stepped into.
            <>
              <div className="text-muted-foreground" style={{ fontSize: "var(--conv-font-size, 12px)" }}>
                {isOverRoundCap(run)
                  ? `source 已按反馈完成修改。已达上限 ${run.max_rounds} 轮——要再加一轮吗？`
                  : "source 已按反馈完成修改。由同一个 reviewer 复审这次修改？"}
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy === run.id}
                  onClick={() => act(run.id, "rereview", () =>
                    api.workflowRunGate(run.id, "rereview", undefined, { extend: isOverRoundCap(run) }))}>
                  {isOverRoundCap(run) ? "再加一轮" : `发起第 ${run.round ?? 2} 轮复审`}
                </Button>
                <Button variant="outline" size="sm" disabled={busy === run.id}
                  onClick={() => act(run.id, "cancel", () => api.cancelWorkflowRun(run.id))}>
                  结束循环
                </Button>
              </div>
            </>
          )}
          {run.status === "waiting_feedback" && (
            <>
              <div className="flex items-center gap-2" style={{ fontSize: "var(--conv-font-size, 12px)" }}>
                <span className="text-muted-foreground">reviewer 结论</span>
                {run.verdict
                  ? <span className={`rounded border px-1.5 py-px font-mono ${VERDICT_LABEL[run.verdict].className}`}>{VERDICT_LABEL[run.verdict].text}</span>
                  : <span className="rounded border border-dashed px-1.5 py-px text-muted-foreground">未识别，请自行判断</span>}
              </div>
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
                {run.verdict === "ship" && (
                  // Nothing blocking: taking the result is the natural exit, and
                  // it sends nothing. Sending the notes anyway stays possible.
                  <Button size="sm" disabled={busy === run.id}
                    onClick={() => act(run.id, "accept", () => api.workflowRunGate(run.id, "accept"))}>
                    接受并结束
                  </Button>
                )}
                <Button size="sm" variant={run.verdict === "ship" ? "outline" : "default"} disabled={busy === run.id}
                  onClick={() => act(run.id, "approve", () => api.workflowRunGate(run.id, "approve", draft[run.id] ?? undefined))}>
                  {run.verdict === "ship" ? "仍发送反馈" : "发送反馈给原 session"}
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
          {actionError?.runId === run.id && (
            <div className="text-destructive" style={{ fontSize: "var(--conv-font-size, 12px)" }}>{actionError.message}</div>
          )}
        </div>
      ))}
    </div>
  );
}

const HOUR_MS = 60 * 60 * 1000;
/** The server's limit on how far ahead a gate may be scheduled. */
const RESUME_SCHEDULE_MAX_MS = 7 * 24 * HOUR_MS;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "14:00", or "11/03 14:00" when it is not today — a schedule may be up to a week out. */
export function formatResumeAt(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** `<input type="datetime-local">` value for an epoch, in local time. */
function toLocalInput(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * "Continue later" (loop-presets design §4.3): the user picks a time and the engine
 * resumes the gate on its own then — covering "usage resets at 14:00" without
 * any automatic retry. The server re-checks the 7-day window; the check here
 * only saves a round trip for an obvious slip.
 */
function ScheduleResumePicker({ busy, onSchedule, onClose }: {
  busy: boolean;
  onSchedule: (at: number) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  /** When the picker opened — bounds for the native picker only; submit re-checks against the clock. */
  const [openedAt] = useState(() => Date.now());
  const submitCustom = () => {
    const at = new Date(custom).getTime();
    const now = Date.now();
    if (!custom || !Number.isFinite(at)) return setInvalid("Pick a time first");
    if (at <= now) return setInvalid("That time has already passed");
    if (at - now > RESUME_SCHEDULE_MAX_MS) return setInvalid("It has to be within 7 days");
    onSchedule(at);
  };
  return (
    <div className="space-y-1.5" style={{ fontSize: "var(--conv-font-size, 12px)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Continue in:</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onSchedule(Date.now() + HOUR_MS)}>+1h</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onSchedule(Date.now() + 5 * HOUR_MS)}>+5h</Button>
        <input type="datetime-local" aria-label="Custom resume time" value={custom}
          min={toLocalInput(openedAt)} max={toLocalInput(openedAt + RESUME_SCHEDULE_MAX_MS)}
          onChange={(e) => { setCustom(e.target.value); setInvalid(null); }}
          className="h-7 rounded-md border bg-background px-1.5 text-xs" />
        <Button size="sm" variant="outline" disabled={busy || !custom} onClick={submitCustom}>Set this time</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      </div>
      {invalid && <div className="text-destructive">{invalid}</div>}
    </div>
  );
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * One repeat-until-done loop (`run.kind === "repeat"`). The run in hand is the
 * loop's single active iteration — or its resume gate. Every action is
 * addressed to the loop as a whole server-side, so a card whose iteration was
 * settled a moment ago still stops / pauses the right thing.
 */
function LoopCard({ run, busy, error, onAction, onScheduleResume }: {
  run: WorkflowRun;
  busy: boolean;
  error: string | null;
  onAction: (action: "pause" | "resume" | "cancel" | "dismiss") => void;
  /** `null` cancels the schedule. */
  onScheduleResume: (at: number | null) => Promise<void>;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const params = repeatLoopParams(run);
  const doneItems = Array.isArray(params?.doneItems) ? params.doneItems : [];
  const round = run.round ?? 1;
  const gate = run.status === "waiting_resume";
  /** A loop that reported `Status: done`; its card stays until the user closes it. */
  const finished = run.status === "completed";
  // A gate is normally the NEXT iteration's run, so the round that stopped is
  // the one before it — unless this very iteration could not start and turned
  // into the gate in place: then it is this round, and it has no session.
  const failedToStart = gate && params?.dispatchFailed === true;
  const shown = gate && !failedToStart ? Math.max(1, round - 1) : round;
  const pausing = params?.stopAfterCurrent === true;
  // Absent on loops started before presets, or by a worker that predates them.
  const source = presetSourceLabel(params?.preset);
  const handoffNote = params?.handoffNote?.trim() || null;
  const resumeAt = gate && typeof params?.resumeAt === "number" ? params.resumeAt : null;
  const schedule = async (at: number | null) => {
    await onScheduleResume(at);
    setPicking(false);
  };
  const name = params?.name ?? "Loop";
  // A bar only when the ledger has entries and the session reported a plain
  // count; free-form remainders ("about a dozen") and loops without a ledger
  // stay text — "0 / 4" would misstate items done before the ledger existed.
  const remainingCount = params?.remaining && /^\d+$/.test(params.remaining.trim()) ? Number(params.remaining.trim()) : null;
  const total = remainingCount !== null && doneItems.length > 0 ? doneItems.length + remainingCount : null;
  const percent = total ? Math.round((doneItems.length / total) * 100) : finished ? 100 : null;
  const working = run.status === "preparing" || run.status === "running_task";
  const statusText = run.status === "preparing" ? `Starting ${name} #${round}…`
    : run.status === "running_task" ? `${name} #${round} ${pausing ? "will pause after this item…" : "is working"}`
      : gate ? "Paused — waiting for you"
        : finished ? "Done" : null;
  // The iteration cap is a safety limit, not progress — the bar is progress.
  // It only earns a place on the card once it is about to stop the loop, or did.
  const runsLeft = run.max_rounds != null ? run.max_rounds - round : null;
  const capNote = gate && isOverRoundCap(run) ? `Reached the ${run.max_rounds}-iteration limit`
    : working && runsLeft !== null && runsLeft <= 3
      ? (runsLeft <= 0 ? `Last iteration (limit ${run.max_rounds})` : `${plural(runsLeft, "iteration")} left before the limit`)
      : null;
  const tone = gate ? "bg-amber-500" : finished ? "bg-emerald-500" : "bg-sky-500";
  const meta = { fontSize: "var(--conv-font-size, 12px)" };
  const disclosure = "inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground";
  return (
    <div className="space-y-2.5 rounded-lg border bg-background/70 p-3 shadow-xs" style={{ fontSize: "var(--conv-font-size, 14px)" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
              {!gate && !finished && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${tone}`} />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${tone}`} />
            </span>
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Loop</span>
            <span className="min-w-0 truncate font-medium" title={name}>{name}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 pl-4 text-muted-foreground" style={meta}>
            {working && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
            {statusText && <span className={`min-w-0 truncate ${gate ? "text-amber-700 dark:text-amber-400" : ""}`}>{statusText}</span>}
            {capNote && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 text-amber-700 dark:text-amber-400">{capNote}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {run.status === "running_task" && !pausing && (
            // The safer stop: a hard stop can leave an item half-processed, and
            // only the instruction — not the engine — can make that harmless.
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("pause")}
              title="Pause the loop once the current session finishes this item">
              <Pause className="h-3 w-3" />Stop after this item
            </Button>
          )}
          {finished ? (
            <Button variant="ghost" size="icon-sm" disabled={busy} aria-label="Close" title="Close this card"
              onClick={() => onAction("dismiss")}>
              <X className="h-3 w-3" />
            </Button>
          ) : (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction("cancel")}
              className="text-muted-foreground hover:text-destructive"
              title="End the loop now and stop the running session">
              <X className="h-3 w-3" />End
            </Button>
          )}
        </div>
      </div>
      {source && (
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground" style={meta} title={source}>
          <FileText className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate font-mono">{source}</span>
        </div>
      )}
      {(percent !== null || params?.remaining) && (
        // Progress: the engine's ledger of completed items (design §5.3) against
        // the count the last session reported as left.
        <div className="flex items-center gap-3" style={meta}>
          {percent !== null && (
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar"
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className={`h-full rounded-full transition-all ${finished ? "bg-emerald-500" : "bg-primary/70"}`}
                style={{ width: `${percent}%` }} />
            </div>
          )}
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {/* With a total the bar already says what is left; a free-form remainder has no total. */}
            {total !== null ? `${doneItems.length} / ${total}` : params?.remaining && `${params.remaining} left`}
          </span>
        </div>
      )}
      {params?.prevItem && (
        <div className="flex min-w-0 items-baseline gap-2 rounded-md bg-muted/50 px-2.5 py-1.5" style={meta}>
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            <Check className="h-3 w-3 self-center text-emerald-600 dark:text-emerald-400" />Last item
          </span>
          <span className="min-w-0 break-words">{params.prevItem}</span>
        </div>
      )}
      {finished && (
        <div className="text-muted-foreground" style={meta}>
          Last session: {name} #{round} (in the sidebar)
        </div>
      )}
      {run.error && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-amber-700 dark:text-amber-400" style={meta}>
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{run.error}</span>
        </div>
      )}
      {(doneItems.length > 0 || handoffNote) && (
        <div className="space-y-2" style={meta}>
          <div className="flex flex-wrap items-center gap-1.5">
            {doneItems.length > 0 && (
              <button type="button" aria-expanded={doneOpen} onClick={() => setDoneOpen((o) => !o)} className={disclosure}>
                {doneOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {plural(doneItems.length, "item")} done
              </button>
            )}
            {handoffNote && (
              // The note the engine hands the next session (design §5.1) — the only
              // place it is visible short of opening a transcript.
              <button type="button" aria-expanded={noteOpen} onClick={() => setNoteOpen((o) => !o)} className={disclosure}>
                {noteOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Last handoff
              </button>
            )}
          </div>
          {doneOpen && doneItems.length > 0 && (
            <ol data-testid="loop-done-items"
              className="max-h-60 list-decimal overflow-y-auto rounded-md border bg-background py-2 pl-8 pr-3 font-mono text-muted-foreground">
              {doneItems.map((item, i) => <li key={i} className="break-words">{item}</li>)}
            </ol>
          )}
          {noteOpen && (
            <pre data-testid="loop-handoff-note"
              className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-background px-3 py-2 font-mono text-muted-foreground">
              {handoffNote}
            </pre>
          )}
        </div>
      )}
      {gate && (
        <>
          <div className="text-muted-foreground" style={meta}>
            {failedToStart
              ? `Iteration #${round} could not start, so it has no session`
              : `Session: ${name} #${shown} (in the sidebar)`}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("resume")}>
              <Play className="h-3 w-3" />Continue loop
            </Button>
            {resumeAt === null && !picking && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setPicking(true)}>
                <AlarmClock className="h-3 w-3" />Continue later
              </Button>
            )}
          </div>
        </>
      )}
      {resumeAt !== null && (
        <div className="flex items-center gap-1 text-muted-foreground" style={meta}>
          <AlarmClock className="h-3 w-3" />
          <span>Continues automatically at {formatResumeAt(resumeAt)} ·</span>
          <button type="button" disabled={busy} onClick={() => void schedule(null)}
            className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50">
            Cancel
          </button>
        </div>
      )}
      {gate && resumeAt === null && picking && (
        <ScheduleResumePicker busy={busy} onSchedule={(at) => void schedule(at)} onClose={() => setPicking(false)} />
      )}
      {error && <div className="text-destructive" style={meta}>{error}</div>}
    </div>
  );
}
