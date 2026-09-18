# Phase 2 前置：投递幂等覆盖 + 投递身份 —— 实施计划

> 设计：[`../specs/2026-09-18-workflow-phase2-prereq-dispatch-identity-design.md`](../specs/2026-09-18-workflow-phase2-prereq-dispatch-identity-design.md)（v2.2，2026-09-18 确认）
> 分支：dev1。每个任务 TDD：先写失败测试，再实现，再跑相关测试 + `tsc --noEmit`，单独提交。
> 已定案：只向空闲 session 派发；entry 不加字段；T7（hub 远程分支记录结果）暂缓。

所有路径相对 `packages/vibedeckx/src/`。

## T1 共享投递助手 + session 互斥锁上提（无行为变化）

新文件 `instruction-delivery.ts`：
- `serializeSessionMutation(sessionId, effect)`、`serializeInstructionDelivery(key, effect)`：
  从 `routes/agent-session-routes.ts:63-95` 原样搬出，锁表改为模块级（进程内单例，
  路由与引擎必须共用同一张表，否则互斥不成立）。
- `instructionContentHash(content)`：从 `:97-103` 搬出。
- `instructionReceiverToken`：模块级 `randomUUID()`（每进程一个，语义与今天一致）。
- `deliverInstruction({ storage, sessionId, idempotencyKey, rawContent, deliver })` →
  `"delivered" | "replayed" | "conflict" | "busy" | "not_running" | "ownership_lost" | "unconfirmed"`；
  `deliver` 抛错 → release 后原样抛出。**不**自己拿 session 锁（调用方决定锁的范围，
  路由的锁还包着 404 重检）。

路由 `:1833-1902` 改为调用助手，结果到状态码的映射保持原样：
delivered→200、replayed→200+replayed、conflict→409、busy→409、not_running→404、
ownership_lost→409、unconfirmed→503。`:2631` 的 discard 路由改用模块级锁。

缺口 F：`plugins/shared-services.ts:210-216` 的本地分支在
`serializeSessionMutation` 内经 `deliverInstruction` 带 `input.idempotencyKey` 投递
（键缺省时保持原直发）。

测试：新 `instruction-delivery.test.ts`（七种结果 + deliver 抛错 release + 同键并发串行）；
既有 `routes/*idempotency*` 测试零改动通过。

## T2 唤醒路径：await stdin + 转发回调 + 顺序钉桩

`agent-session-manager.ts`：
- `wakeDormantSession(Inner)` 接收完整 `FirstSendOptions`（今天只收 origin + disposition）；
  `pushEntry` 带 `strictPersist`（传了回调时）；`await opts.onUserEntryPersisted(index)`
  置于 `pushEntry` 之后、stdin 之前。
- 500ms 延迟写改为 awaited Promise；`session.process?.stdin` 缺失或 `write` 抛错 →
  返回 `false`。`wakeDormantSession` 返回 `Promise<boolean>`，`sendUserMessageClaimed`
  透传。
- 回调抛错：沿用普通路径语义（向上抛）；session 状态复原放 T4 的引擎包装里，
  但唤醒路径此时已 spawn 进程——抛错前不写 stdin 即可，进程保留为 resident 空闲态，
  状态置回 `stopped` 并广播（否则卡 running）。

测试（`agent-session-manager.*.test.ts` 新文件 `dispatch-order.test.ts`）：
普通路径与唤醒路径各一组——回调 resolve 之前 stdin 零写入；回调抛错 → stdin 零写入；
唤醒路径 stdin 写失败 → `false`；回调收到的索引 = 落库 user entry 的索引。
激活路径的顺序由 `agent-session-lifecycle*.test.ts` 既有用例覆盖，补一条断言即可。

## T3 存储：`workflow_run_steps`

三文件模式（`storage/schema.ts`、`storage/sqlite.ts` DDL、`storage/repositories/workflow-run-steps.ts`）
+ `storage/types.ts` 接口 + `Storage.workflowRunSteps`。DDL 见设计 §2.2，另加
`payload_hash TEXT NOT NULL`（重试/改稿判定）与 `UNIQUE(run_id, kind, round)`。

仓库方法：`getOrCreate`（按 `(run_id, kind, round)`；已存在且非 abandoned 则返回原行，
abandoned 则原地复活为 dispatched + 新键 + 清索引——保持唯一约束）、`getById`、
`getOpenBySession`、`listByRun`、`listAllOpen`、`setUserEntryIndex`（CAS dispatched，允许覆盖）、
`abandon`（CAS dispatched）、`maxRound(runId)`。
`workflowRuns.claimStepAndTransition(...)`：与 `transitionWithOutbox` 同构的单事务；
`run` 部分可选（feedback 步骤只 claim 不迁移）。
`agentSessions.getActivationUserEntryIndex(sessionId)` 若无现成读法则补一个。

测试：`storage/repositories/workflow-run-steps.test.ts`——CAS 语义、唯一约束、
复活、事务整体回滚（run CAS 落空时步骤不变、outbox 不写）。

## T4 引擎四个发送点

`workflow-engine.ts`：
- `AgentOps.sendUserMessage` opts 增 `onUserEntryPersisted?`；新增
  `AgentOps.deliverKeyed?`——不加：引擎直接 import `deliverInstruction` /
  `serializeSessionMutation`，`deliver` 内调 `agentOps.sendUserMessage`。
- 私有 `dispatchStep({ run, kind, round, role, sessionId, payload, projectPath, turn })` →
  `"accepted" | "no_side_effect" | "unknown"`：getOrCreate → 改稿检查（存在 dispatched
  步骤且 `payload_hash` 不同 → `WorkflowError("bad-state")`）→ 锁内重检
  `agentSessions.getById(sessionId).status !== "running"`（否则 `session-busy`，步骤若刚建则 abandon）
  → `deliverInstruction`；结果分类按设计 §2.4；`no_side_effect` 时 abandon。
  回调/写库抛错：捕获，若 session 状态被翻成 running 而无 turn，则经
  `agentOps.restoreIdleStatus?(sessionId)` 复原（管理器新增小方法）。
- 三个 `sendUserMessage` 发送点改走 `dispatchStep`；`unknown` 时 run 停在等待态
  （feedback → 回 `waiting_feedback`）并写 `run.error`。
- 激活发送点：先 getOrCreate（key = activationKey），返回后用
  `outcome.view.userEntryIndex` 回填；`uncertain` → 步骤保持 dispatched；失败类 → abandon。
- `requestFinalVerdict` 接受“`waiting_reviewer` 且存在 dispatched 的 `final_verdict` 步骤”作为重试入口；
  `approveFeedback` 的改稿 409。

测试：`workflow-engine.*.test.ts` 扩充——每个发送点落步骤行、键格式、回填索引；
三类结果的 run 状态；锁内重检竞争；同键重试 replayed 不重投；改稿 409。

## T5 步骤驱动的 `handleTaskCompleted` + 前端重试入口

- `notification-milestones.ts`：`findTurnOpeningUserEntryIndex`（与现有函数同一扫描；
  现有函数改为基于它实现）。
- `handleTaskCompleted`：先查 `getOpenBySession(event.sessionId)`，按
  `effectiveEntryIndex === openingIndex` 匹配 → `claimStepAndTransition`；
  run 有步骤行但无匹配 → 不接收，reviewer 且 run 在 `waiting_reviewer` 时写 `run.error` 提示；
  run 无任何步骤行 → legacy 规则。feedback 步骤只 claim。
- 参与者表：feedback 步骤 claim 需要在 run completed 后仍能收到 source 的完成——
  改为按步骤行查询而不依赖 `participants`。
- 前端：review panel 在 `run.status === "waiting_reviewer"` 且 `run.error` 以
  “投递结果未知”开头时显示“重试投递”（调 finalize）；`waiting_feedback` 同理走 approve 原文。
  先读 `apps/vibedeckx-ui` 的 panel 组件再定最小改法。

测试：正常归属；陈旧完成不领；用户 mid-turn 穿插；分支会话不领；激活步骤回填前完成先到；
结果未知后真实完成到达；legacy fallback；前端按钮的 vitest。

## T6 `init()` 对账

按设计 §2.7：`listAllOpen()` 逐条处理；两列皆空 → abandon + 按 kind 回滚 + 新文案；
有索引 → 找其后第一个 `turn_end` 分三种结局。现有 `init()` 对 `sending_feedback` /
`waiting_reviewer` 的一刀切提示只保留给无步骤行的 legacy run。

测试：四种 kind 的回滚；仅步骤行为空而 `activation_user_entry_index` 有值不得判未投递；
completed 迟到归属；server_restart/failed → abandon；无 turn_end → 保持。

## T8 收尾

全量后端 + 前端测试、两端 `tsc`、`node scripts/classify-diff.mjs`（确认无隧道契约变化）；
真机 e2e 用 `--data-dir` 一次性 daemon（**绝不** `connect stop`）；主 spec §3.1/§3.2/§6 同步；
记忆文件更新。worker 侧改动（T2–T6）需发版。
