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
const inflight = new Map<string, { request: Promise<WorkflowRun[]>; tick: object }>();

function keyOf(projectId: string, branch: string | null): string {
  return `${projectId}\u0000${branch ?? ""}`;
}

// 同步 tick 标记:同一轮 effect flush(同一个 commit 的所有 effect 同步执行,中间
// 没有微任务边界)里发出的请求共享一个 token,微任务一到就失效。
// 用途:两个组件因同一个事件(WS epoch 变化)在同一 commit 各自 force 时,第二个
// force 复用第一个——它们都在事件之后发出,拿到的快照一样新;跨 tick 的 force
// 仍然各发各的,因为无法证明更早那趟是在"我的"事件之后发出的。
let currentTick: object | null = null;
function thisTick(): object {
  if (currentTick === null) {
    const t = {};
    currentTick = t;
    queueMicrotask(() => { if (currentTick === t) currentTick = null; });
  }
  return currentTick;
}

/**
 * 「这条分支上哪些 session 已经 review 过」的快照,由上面那个请求顺带捎回来
 * (`reviewedSessionIds`),给 Start Review 弹窗在**打开前**就知道 Continue last
 * reviewer 这个选项存不存在——省掉打开后那趟请求和随之而来的禁用窗口。
 * 「此刻还能不能复用」仍然只有 getReviewerCandidate 说了算。
 *
 * 三条不变式:
 *
 * 1. **只并集,不替换。** 这里的 force 只替换 in-flight 条目、不取消旧请求,而
 *    远程读会互相超车(见 review-run-panel.tsx 的 reqSeq 注释)。旧的空响应若
 *    覆盖新快照,刚跑完的那次 review 就被抹掉,轮询一停还会永久卡住。集合对单个
 *    session 是单调的(review 过就永远 review 过),所以并集既安全又不需要定序。
 *    代价是被 retention 清掉的 id 会留下,后果只是多发一次 candidate 请求并拿到
 *    unavailable——良性。
 * 2. **undefined ≠ 空集。** 老 worker 不返回该字段,此时一个字节都不写,key 保持
 *    「未知」,弹窗退回原来的行为。写成空集等于谎称「没 review 过」,会让 Continue
 *    last reviewer 永远不出现。
 * 3. **渲染期可读。** 消费方用 useSyncExternalStore 订阅:面板轮询落地时不保证
 *    触发任何组件重渲染(useReviewerRun 无活跃 run 时 setRun(null) 会被 React
 *    bail out),靠 prop 传递会一直停在 undefined。
 */
const reviewedByKey = new Map<string, Set<string>>();
const reviewedListeners = new Set<() => void>();

function mergeReviewed(key: string, ids: string[] | undefined): void {
  if (!ids) return; // 不变式 2
  const existing = reviewedByKey.get(key);
  if (existing && ids.every((id) => existing.has(id))) return; // 无变化,不惊动订阅者
  const next = new Set(existing ?? []);
  ids.forEach((id) => next.add(id)); // 不变式 1
  reviewedByKey.set(key, next);
  reviewedListeners.forEach((l) => l());
}

export function subscribeReviewedSessions(listener: () => void): () => void {
  reviewedListeners.add(listener);
  return () => { reviewedListeners.delete(listener); };
}

/**
 * `true`/`false` = 已知;`undefined` = 还没有任何一次成功读取,或这条隧道对面的
 * worker 答不了这个问题。调用方必须把 undefined 当「不知道」,而不是「否」。
 */
export function hasPriorReview(
  projectId: string | null,
  branch: string | null,
  sessionId: string | null,
): boolean | undefined {
  if (!projectId || !sessionId) return undefined;
  const set = reviewedByKey.get(keyOf(projectId, branch));
  return set ? set.has(sessionId) : undefined;
}

export function fetchActiveWorkflowRuns(
  projectId: string,
  branch: string | null,
  opts?: { force?: boolean },
): Promise<WorkflowRun[]> {
  const key = keyOf(projectId, branch);
  const tick = thisTick();
  const existing = inflight.get(key);
  if (existing && (!opts?.force || existing.tick === tick)) return existing.request;
  const request = api.getActiveWorkflowRuns(projectId, branch).then((payload) => {
    mergeReviewed(key, payload.reviewedSessionIds);
    return payload.runs;
  });
  const entry = { request, tick };
  inflight.set(key, entry);
  // 只清理自己那条——被 force 替换后不能误删新的。原 promise 原样返回给调用方,
  // 拒绝也由调用方处理;这里的 catch 只是吞掉 finally 派生链的 unhandled rejection。
  request
    .finally(() => { if (inflight.get(key) === entry) inflight.delete(key); })
    .catch(() => {});
  return request;
}

/** 测试用:清空 in-flight 表,避免一个用例里永不 resolve 的请求泄漏到下一个。 */
export function resetWorkflowRunsInflightForTests(): void {
  inflight.clear();
  currentTick = null;
  reviewedByKey.clear();
}
