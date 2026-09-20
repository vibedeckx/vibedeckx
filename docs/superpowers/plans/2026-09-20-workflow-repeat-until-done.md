# Repeat-until-done（Ralph loop）—— 实施计划

> 设计：[`../specs/2026-09-20-workflow-repeat-until-done-design.md`](../specs/2026-09-20-workflow-repeat-until-done-design.md)（v1.1，2026-09-20 确认）
> 分支 dev1。每个任务 TDD、单独提交；相关测试 + `tsc --noEmit` 通过才提交。路径相对 `packages/vibedeckx/src/`。
> 已定案：引擎在 worker；remote worker 是主要目标；`continue / done / blocked`；默认 20 次 / 240 分钟；
> 被打断不自动重开；`confirmDone` 本轮不做。

## 实施时定下的形态细节

- **session id 预分配。** `workflow_runs.source_session_id` 非空；`repeat` run 在创建时就带一个预分配的 uuid，
  prepare 用它建 session（`PrepareAgentSessionInput.sessionId`）。闸门 run 的 id 同样预分配，`resume` 时才真正建；
  `source_turn_end_index` 对 `repeat` 恒为 -1。hub"见到就发布"只对 `running_task` 的 run 生效。
- **代码位置。** 新模块 `workflow-repeat-loop.ts`（`RepeatLoopRunner`），引擎只做分派：发起、`handleTaskCompleted`
  中 `task_prompt` 步骤、`session:status`、`init()`、gate 动作。`workflow-engine.ts` 已 2100 行，不再往里堆。
- **params JSON**：`{ name, prompt, agentType, model?, maxIterations, maxMinutes, checkCommand?, startedAt,
  anchorSessionId, prevSessionId?, prevItem?, stopAfterCurrent? }`，逐迭代复制。

## R1 存储
`workflow_runs`：`kind TEXT NOT NULL DEFAULT 'review'`、`params TEXT`、`outcome_status TEXT`（幂等 ALTER）。
状态 `running_task` / `waiting_resume` 进 `WorkflowRunStatus` 与 `WORKFLOW_ACTIVE_STATUSES`。步骤 kind `task_prompt`。
`NotificationKind` 加 `loop_done`。`create` 接受 `kind/params`；`claimStepAndTransition` 加 `insertRun`（无条件插入一行
`repeat` run，可指定 status/error）；新读取 `getActiveInLoop(loopId)`、`getActiveRepeat(projectId, branch)`。
测试：`storage/workflow-run-steps.test.ts` 增补。

## R2 收尾字段解析
`utils/review-verdict.ts` 抽 `parseClosingField(text, label, values)`，`parseVerdict` 改为调用它（既有测试零改动）；
新 `parseTaskStatus` + `parseClosingLine(text, "Item")`；`TASK_STATUS_INSTRUCTIONS` 常量。

## R3 引擎主路径
`AgentOps` 增 `prepareTask / activateTask / cancelTask`（lifecycle，purpose `workflow_task`）、`stopSession`、
`getSessionStatus`。`RepeatLoopRunner`：`start`、`dispatchIteration`（prepare → 标题 → step.open → activate →
CAS `preparing→running_task`，每个 await 后复查）、`onStepClaimed`（解析 → 可选 checkCommand → 刹车 → 同事务
complete + insertRun → stop 旧 session → 派发/里程碑）、`pause / resume / cancel`（按 `loop_id` 解析活跃 run）。
引擎：`shouldSuppressAgentEvent` 覆盖 `repeat` 的 source；`cancelRun` 认识两个新状态。

## R4 引擎边角
`session:status` 订阅 → 非正常结束（`stopped` ⇒ cancelled + 闸门无铃；`failed/process_exit` ⇒ failed + 闸门 + 铃）。
`init()`：`preparing` 的 `repeat` run 重新派发；completed run 的 session 仍在跑则停；`reconcileOpenSteps` 对
`task_prompt`：未送达 ⇒ 闸门；已完成 ⇒ 迟到领取；被打断 ⇒ 闸门。里程碑写锚点 outbox。`emitRunUpdated` 对
`repeat` 追加镜像到锚点流。

## R5 路由与 hub
本地 `POST /api/workflow-runs {kind:"repeat"}`；`/api/path/workflow-runs` 镜像（按 path 解析项目）；gate 增 `pause / resume`。
hub：项目绑定 worker 时代理；`REPEAT_LOOP_MIN_WORKER_VERSION` 门控 → 409；响应里的锚点 session 当场发布 +
`extendNotificationWatch(until = now + maxMinutes + 30min)`；`resume` 再延；列表 / 单 run / 帧三处"见到就发布"。
`GET /api/workflow-runs?projectId&branch` 对 remote 项目已代理，确认 `repeat` run 能通过 `mapRemoteRun`。

## R6 前端
`lib/api.ts` 类型与 `createRepeatLoop`；Main Chat review 面板旁 "New loop" 弹窗；面板 `repeat` 卡片
（第 N / M 次、Item、Remaining、session 链接、"做完这项后停" / "结束" / "继续循环"）；`preparing-reviews` 状态序；
通知点击按 `workflow_run_id` 跳到 run 的 session；`loop_done` 标题。

## R7 e2e 与收尾
单机真机 e2e（todo.json 循环：continue×N → done；blocked；上限；软停；Stop 按钮；kill -9）→ 双服务器
hub + worker e2e（发布、面板、铃、重启 hub 后补拉）。`classify-diff`；设计稿补"实现记录"；记忆更新。
