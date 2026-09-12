"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type WorkflowRun } from "@/lib/api";
import { fetchActiveWorkflowRunsAt } from "@/lib/workflow-runs-fetch";
import { useNotificationInbox } from "@/hooks/notification-inbox-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageResponse } from "@/components/ai-elements/message";
import { Eye, FileCheck, Loader2, Pencil, X } from "lucide-react";

type GateAction = "approve" | "finalize" | "cancel";

const ACTIVE = new Set(["preparing", "waiting_reviewer", "waiting_feedback", "discussing", "sending_feedback"]);

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
      const active = await read.request;
      if (seq !== reqSeqRef.current) return;
      landedRef.current = { at: read.issuedAt, runs: active };
      setRuns(active);
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
      markReviewRunRead(runId, { runEnded: action !== "finalize" });
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
  const orphanError = actionError && !activeRuns.some((r) => r.id === actionError.runId) ? actionError : null;
  if (activeRuns.length === 0 && !orphanError) return null;

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
                  onClick={() => act(run.id, "approve", () => api.workflowRunGate(run.id, "approve", draft[run.id] ?? undefined))}>
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
          {actionError?.runId === run.id && (
            <div className="text-destructive" style={{ fontSize: "var(--conv-font-size, 12px)" }}>{actionError.message}</div>
          )}
        </div>
      ))}
    </div>
  );
}
