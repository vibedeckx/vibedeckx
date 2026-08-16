import { api, type WorkflowRun } from "@/lib/api";

/**
 * `GET /api/workflow-runs?projectId&branch` 的并发合并层。
 *
 * 一次工作区切换里 ReviewRunPanel(面板)和 useReviewerRun(终稿按钮)会在同一
 * commit 各自读一遍同一份数据;远程项目每次都是一趟 ~1.5s 的 tunnel 往返。这里
 * 只做"同键 in-flight 共享"——不缓存结果,请求一落地就从表里删掉,下一次读取
 * 仍然打真实请求。
 *
 * `force`:调用方明确需要"此刻之后"的快照时用(WS Ready 对账、runUpdate 触发的
 * 刷新、面板轮询、gate 操作后的刷新)。这些场景复用一个更早发出的 in-flight
 * promise 会拿到过期快照——尤其是 Ready 对账,它是 workflowRunUpdated 丢帧的唯一
 * 兜底,复用握手前的请求等于兜底失效。force 请求会替换表里的条目,让随后的
 * 非 force 调用搭这趟新的。
 */
const inflight = new Map<string, Promise<WorkflowRun[]>>();

function keyOf(projectId: string, branch: string | null): string {
  return `${projectId}\u0000${branch ?? ""}`;
}

export function fetchActiveWorkflowRuns(
  projectId: string,
  branch: string | null,
  opts?: { force?: boolean },
): Promise<WorkflowRun[]> {
  const key = keyOf(projectId, branch);
  if (!opts?.force) {
    const existing = inflight.get(key);
    if (existing) return existing;
  }
  const request = api.getActiveWorkflowRuns(projectId, branch);
  inflight.set(key, request);
  // 只清理自己那条——被 force 替换后不能误删新的。原 promise 原样返回给调用方,
  // 拒绝也由调用方处理;这里的 catch 只是吞掉 finally 派生链的 unhandled rejection。
  request
    .finally(() => { if (inflight.get(key) === request) inflight.delete(key); })
    .catch(() => {});
  return request;
}

/** 测试用:清空 in-flight 表,避免一个用例里永不 resolve 的请求泄漏到下一个。 */
export function resetWorkflowRunsInflightForTests(): void {
  inflight.clear();
}
