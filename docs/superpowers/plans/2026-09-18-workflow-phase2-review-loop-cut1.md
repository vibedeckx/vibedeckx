# Phase 2 第一刀：Review 闭环 —— 实施计划

> 设计：[`../specs/2026-09-18-workflow-phase2-review-loop-cut1-design.md`](../specs/2026-09-18-workflow-phase2-review-loop-cut1-design.md)（v1.1，2026-09-18 确认）
> 分支：dev1。每个任务 TDD，跑相关测试 + `tsc --noEmit`，单独提交。路径相对 `packages/vibedeckx/src/`。

## L1 存储
- `workflow_runs` 加 `loop_id` / `round`（默认 1）/ `max_rounds` / `verdict`：`storage/sqlite.ts` DDL +
  `PRAGMA table_info` 迁移、`storage/schema.ts`、`storage/types.ts`（`WorkflowRun`、
  `WorkflowRunStatus` 加 `waiting_rereview`、`WorkflowVerdict` 类型）、`storage/workflow-run-status.ts`。
- `workflowRuns.create` 接受四个新字段；`transition` / `claimStepAndTransition` 的 patch 类型
  放宽到 `verdict`、`reviewer_session_id`、`max_rounds`。
- `claimStepAndTransition` 增加 `nextRun?`：在同一事务内
  `INSERT … SELECT … WHERE NOT EXISTS (活跃 run 且 source/reviewer = 该 source)`；
  返回值改为 `{ claimed: boolean; nextRunCreated: boolean }`——或保留 boolean 并新增方法，
  以不破坏现有调用为准。
- 测试：迁移幂等；`nextRun` 的三种结果（插入 / 被占用跳过但步骤仍领取 / 步骤 CAS 落空则都不写）。

## L2 verdict
- `utils/review-verdict.ts`：`parseVerdict`（设计 §3 的完整匹配）。
- `claimStep` reviewer 分支把 `verdict` 写进同一事务的 patch。
- 测试：真机两条样本、全/半角冒号、破折号、粗体、`do not ship` → null、`ship (with notes)` → null、
  选项原样抄写 → null、正文提到 verdict 但结尾另有结论 → 取最后一处、标签行空 + 下一行给值。

## L3 引擎：循环身份与下一轮闸门
- `AdhocReviewOptions.loop?: { maxRounds }`；创建 run 时 `loop_id = run.id, round = 1`。
  重放（`existingRun`）的 `sameRequest` 判定不含 loop（已落库的为准）。
- `claimStep` feedback 分支：`run.loop_id && run.verdict !== "ship"` 且内存 `participants` 无该
  source → 带 `nextRun`（`randomUUID()`）领取；插入成功 → `trackParticipants` + `emitRunUpdated`。
  与前置 §7-10 的“顺带完成 run”分支正交：两种领取形态都要带 `nextRun`。
- `init()`：`waiting_rereview` 只重建参与者（source）。
- 测试：needs-changes 循环出闸门；ship 不出；非循环不出；source 已被新 review 占用不出；
  重启对账的迟到领取同样出闸门；闸门期间对 source 另起 review → 409。

## L4 引擎：闸门动作
- 抽 `dispatchRereview(run, reviewerSessionId, project)`，只返回派发结果；发起入口保留 `failRun`。
- `approveRereview(runId, { extend? })`：校验 `waiting_rereview`；`round > max_rounds` 需 `extend`
  （置 `max_rounds = round`）；意向 reviewer = 同 `loop_id` 上一轮 run 的 reviewer；可用性按
  `getReviewerCandidate` 的同一套检查（抽出共用的校验函数）；source running → `source-running`；
  重新取 source 最新已完成 turn 写回 `source_turn_end_index` 与 `review_target`；
  CAS → `waiting_reviewer` + 绑定 reviewer → 派发；`no_side_effect` → 回闸门并解绑；`unknown` → 留守。
- `acceptResult(runId)`：`waiting_feedback → completed`，不派发、`untrackRun`；只允许 `verdict === "ship"`？
  ——**不限制**：用户在任何结论下都可以“接受并结束”，UI 只在 ship 时把它设为主按钮。
- `cancelRun` 增加 `waiting_rereview` 起点。
- 测试：设计 §8 引擎部分其余各条。

## L5 路由
- `POST /api/workflow-runs`、`/api/path/workflow-runs`（及 prepare 变体）解析 `loop.maxRounds`（1..10 整数）；
  hub 远程分支与 durable intent 透传。gate action 增 `accept` / `rereview`（`extend`）。
- 远程：确认 hub 对 worker 自发创建的 run 可解析（`resolveRemoteRun`）；不可则在 run-updated 帧
  处登记。capability 注册表应无 diff。
- 测试：参数校验、action 分发、远程透传。

## L6 前端
- `lib/api.ts` 类型与调用；发起弹窗的循环开关 + 上限；面板徽标 / 轮次 / ship 主次按钮 /
  `waiting_rereview` 三形态 / 过期点击文案；`ACTIVE` 集合加新状态（含 `hooks/preparing-reviews` 等
  引用处）；旧 worker 降级提示。
- 测试：vitest（面板三形态、弹窗参数）。

## L7 收尾
全量后端 + 前端测试、两端 tsc、`classify-diff`；真机 e2e（needs-changes → 修 → 复审 → ship → accept；
上限升级；闸门态重启）；主 spec §3.2b/§4/§5/§6 同步；记忆更新。
