"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkflowRun } from "@/lib/api";
import type { AgentSession } from "@/hooks/use-agent-session";
import { fetchActiveWorkflowRuns } from "@/lib/workflow-runs-fetch";

const RUN_ACTIVE = new Set(["waiting_reviewer", "waiting_feedback", "discussing", "sending_feedback"]);

/**
 * 本 session 作为活跃 review run 的 reviewer 时的 run 状态,供终稿按钮使用。
 * frame-wins:WS 帧递增序号,REST 种子只在读取期间没有任何帧到达时落地——
 * 晚到的 REST 响应不能覆盖更新的帧状态(远程会话 REST 慢,这个竞态是真实的,
 * 且会话侧没有轮询,一旦覆盖不会自愈)。
 *
 * 帧到达/会话切换的同步派生用 render-time 状态调整(比较上一次渲染看到的值,
 * 差异时直接在渲染体内调用 setState)而非在 effect 里同步 setState——本仓库
 * 的 react-hooks/set-state-in-effect 规则不允许纯派生 state 的 effect 写法;
 * 做法同 components/diff/diff-panel.tsx 的 seenCompareNonce/seenBranch。帧
 * 序号本身则不能在渲染期读写 ref(react-hooks/refs),所以单独放进一个只做
 * ref 递增、不调用 setState 的 effect 里——这是该规则明确允许的写法。
 *
 * `streamEpoch` 是丢帧的唯一兜底。`workflowRunUpdated` 走 broadcastRaw:
 * 不入 MessageStore、重连不回放、服务端也不会补发(状态没再翻转时连第二帧
 * 都没有)。所以 socket 断着的那一刻发生的迁移会永久错过——症状是分隔线上
 * 的终稿按钮不出现,而左侧面板(有 5s 轮询)显示正常。把 epoch 放进种子依赖,
 * 等于把"每次 socket 连上"变成一次对账,断线/僵尸 socket/dormant 唤醒/服务
 * 端重启都一并覆盖。首连会多种一次(挂载一次 + Ready 一次),幂等,故意保留:
 * 无条件对账比"判断这次是不是重连"更不容易出错。
 *
 * `session` 传整个对象而不是 id:AgentConversation 跨项目/跨分支切换时不卸载,
 * useAgentSession 的 reset effect 与本 hook 的种子 effect 在同一 commit 跑,
 * setSession 下一帧才生效——本帧看到的仍是旧工作区的 session。只认
 * `session.projectId/branch` 与当前工作区一致的 session,否则当作没有 session,
 * 避免拿旧 session id 去读新工作区(纯浪费的一趟 tunnel 请求)。
 *
 * REST 种子走 fetchActiveWorkflowRuns 的并发合并:首次种子与 ReviewRunPanel
 * 同 commit 的首拉合成一次;epoch 变化(Ready 对账)必须 force——复用握手前
 * 发出的请求会拿到断线前的快照,兜底就失效了。
 */
export function useReviewerRun(
  projectId: string | null,
  branch: string | null,
  session: Pick<AgentSession, "id" | "projectId" | "branch"> | null,
  runUpdate: WorkflowRun | null,
  streamEpoch: number,
): WorkflowRun | null {
  const sessionId =
    session && session.projectId === projectId && session.branch === branch ? session.id : null;
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const frameSeqRef = useRef(0);
  const seededEpochRef = useRef<number | null>(null);

  const [seenFrame, setSeenFrame] = useState<{ runUpdate: WorkflowRun | null; sessionId: string | null }>({
    runUpdate: null,
    sessionId: null,
  });
  if (seenFrame.runUpdate !== runUpdate || seenFrame.sessionId !== sessionId) {
    setSeenFrame({ runUpdate, sessionId });
    if (runUpdate && runUpdate.reviewer_session_id === sessionId) {
      setRun(RUN_ACTIVE.has(runUpdate.status) ? runUpdate : null);
    }
  }

  // 帧序号只在这里递增——不掺杂 setState,单纯读写 ref，供下面 REST 种子的
  // frame-wins 判断使用。Layout effect 确保同步在 commit 任务内执行,
  // 避免 REST .then 在 ref bump 前读取到陈旧值。
  useLayoutEffect(() => {
    if (runUpdate && runUpdate.reviewer_session_id === sessionId) {
      frameSeqRef.current++;
    }
  }, [runUpdate, sessionId]);

  // 工作区/会话切换——先清掉旧值,避免旧 session 的 run 在种子返回前串台。
  const [seenSeedKey, setSeenSeedKey] = useState<{ projectId: string | null; sessionId: string | null }>({
    projectId: null,
    sessionId: null,
  });
  if (seenSeedKey.projectId !== projectId || seenSeedKey.sessionId !== sessionId) {
    setSeenSeedKey({ projectId, sessionId });
    setRun(null);
  }

  // REST 种子——订阅外部数据源,结果只在回调里落地(且服从上面的 frame-wins
  // 序号门槛),这是该 lint 规则明确允许的 effect 写法。
  useEffect(() => {
    if (!projectId || !sessionId) return;
    let stale = false;
    const seqAtStart = frameSeqRef.current;
    // 同一 epoch 内的重跑(工作区/会话切换)可以搭并发的便车;epoch 变了就是
    // socket 刚连上的对账,必须发新请求。
    const force = seededEpochRef.current !== null && seededEpochRef.current !== streamEpoch;
    seededEpochRef.current = streamEpoch;
    void fetchActiveWorkflowRuns(projectId, branch, { force })
      .then((runs) => {
        if (stale || frameSeqRef.current !== seqAtStart) return; // frame-wins
        setRun(runs.find((r) => r.reviewer_session_id === sessionId) ?? null);
      })
      .catch(() => { /* transient — 帧仍会驱动 */ });
    return () => { stale = true; };
  }, [projectId, branch, sessionId, streamEpoch]);

  return run;
}
