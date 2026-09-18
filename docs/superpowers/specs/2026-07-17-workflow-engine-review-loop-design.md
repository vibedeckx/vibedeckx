# Workflow 引擎与 Design–Review Loop 设计

> 状态（2026-09-18 对账，以 main 为准）：**Phase 1 / 1.5 及其后五波演进均已合入 main**；
> **Phase 2（循环模板）尚未开始**，但其两项硬前置——投递幂等覆盖与投递身份
> （`workflow_run_steps`）——已于 2026-09-18 在 dev1 落地并过真机 e2e（未合入 main，
> worker 侧需发版），见 `2026-09-18-workflow-phase2-prereq-dispatch-identity-design.md`；
> Phase 3 仅有讨论记录。
> 本文在 2026-09-18 按代码实况重写了 §2.3、§3、§4、§5、§6——原 2026-07-17 版
> 只描述 Phase 1 的一次性单程 review，随后两个月里 review 从"一次性"长成
> "可准备、可讨论、可复用、有作用域、有上下文阶梯"的形态，主 spec 未同步。
> 已合入的子设计（各自的状态头同日修正）：
> - Phase 1 ad-hoc review：`../plans/2026-07-17-adhoc-review-phase1.md`
> - Phase 1.5 remote：`../plans/2026-07-17-remote-adhoc-review-phase15.md`
> - 复用上一个 reviewer：`../../plans/2026-07-18-reuse-reviewer-session-design.md`
> - 作用域快照 + 范围选择：`2026-07-23-review-scope-snapshot-design.md`、
>   `2026-07-23-review-scope-phase2-span-selector-design.md`
> - 持久化通知里程碑：`../../plans/2026-07-25-persistent-notification-milestones-design.md`
> - 讨论轮次：`2026-07-28-review-discussion-rounds-design.md`
> - 两段式启动 / 预备 session 生命周期 / 远程创建 saga：
>   `2026-08-31-prepared-agent-session-lifecycle-design.md`（§9.2、§10.4）
> - 意图简报的真机评估：`../../review-brief-eval.md`
>
> 背景：用户当前手动运行 "implementer 出设计 → branch 出 reviewer session 审 →
> 手动把意见粘贴回 implementer → 循环" 的工作流，希望自动化。本文定义 vibedeckx
> 的**确定性 workflow 引擎**（第一个模板：Design–Review Loop），以及 Main Chat /
> Commands 在 "agent 路由器 + workflow 库" 目标形态下的分层。
> 关联：[`multi-level-commander-design.md`](../../multi-level-commander-design.md)（三原语、
> 分级批准）、[`chat-session-orchestrator-state.md`](../../chat-session-orchestrator-state.md)
> （orchestrator 现状）、[`event-driven-outbound-approval-design.md`](../../event-driven-outbound-approval-design.md)
> （审批卡片机制）。

---

## 1. 定位与论证

### 1.1 为什么不是 prompt / Command / 指挥官即兴编排

- Command 今天只是一段存好的 prompt，执行 = 原样发给 Main Chat（`app/page.tsx`
  `handleExecuteCommand` → `mainChatRef.sendMessage`），每次都重新进入模型即兴
  编排路径。固化的只有"输入"，没固化"控制流"。
- Main Chat 默认跑 DeepSeek flash、每 turn `stepCountIs(3)`——让它维持多轮跨
  session 循环，会撞上 agentic laziness / 目标漂移 / 自我偏好三个失败模式；
  `event-driven-outbound-approval-design.md` 防的"事件→外呼→再唤醒"自激循环
  就是这条路的事故形态。
- design→review 循环已被用户手动跑出稳定形状（"agent 发现，workflow 固化"），
  属于 build-time 已知任务 + 中等错误代价 → 该由**代码持有控制流**，模型只当
  叶子节点（设计、review、verdict）。

### 1.2 目标分层（三层，不是取代关系）

| 层 | 固化什么 | 数量预期 |
|---|---|---|
| **Prompt command**（现状保留） | 措辞 / checklist | 多数 |
| **Workflow**（本文新增） | 控制流（循环、闸门、中继） | 少数高价值循环 |
| **Main Chat** | 路由 + 兜底 + 升级判断 | 1 |

Prompt command 继续作为发现层与长尾载体；workflow 只收编那些"失败来自控制流
失控"的流程。Main Chat 顶层保持模型驱动（copilot 任务 run-time 定义，硬约束），
但显式唤起的 workflow **绕过路由器**，确定性 dispatch。

### 1.3 v1 信任基线（用户已拍板）

**每一跳中继都必须经用户确认后才传递。** 自动放权（"第 N 轮起自动继续"）不在
v1，等流程跑顺后再加。v1 的最坏情况 = "比手动粘贴少一半操作"，永远不劣于现状。

2026-09 补充：这条基线至今未动摇——两个月的演进全部发生在"单程 review 做深"
（作用域、上下文、讨论、可靠启动），没有一处引入自动中继。Phase 2 的循环仍
以此为前提。

---

## 2. 数据模型

### 2.1 `commands` 表扩展（Phase 2，未实现）

- 新增 `kind: 'prompt' | 'workflow'`（默认 `'prompt'`，向后兼容）。
- `kind='workflow'` 时 `content` 存 JSON 定义（见 2.2）。
- 作用域沿用现有 project/branch 两级（`branch: null` = 项目级）。

现状：`commands` 表没有 `kind` 列，`hooks/use-commands.ts` 的 `createCommand`
只收 `{name, content}`。

### 2.2 Workflow 定义（Phase 2，未实现；v1 = 模板 + 参数，非自由步骤）

```jsonc
{
  "template": "design-review-loop",     // v1 唯一模板
  "params": {
    "reviewerPrompt": "…",              // 叶子 prompt，用户可打磨（预填默认对抗性 review 指令）
    "reviewerAgentType": "claude-code", // claude-code | codex（与现有 REVIEWER_AGENT_TYPES 一致）
    "reviewerContext": "briefed",       // briefed | blind（现有 ReviewContextMode；原 auto/fresh/branch 三值已被 3.3 的上下文阶梯取代）
    "reviewSpan": "this_turn",          // this_turn | session_start（现有 ReviewSpan）
    "maxRounds": 3,
    "placeholder": "描述要设计/修复的任务，或指向已有设计文档…"  // 输入框 placeholder
  }
}
```

存储按通用 schema 设计（`template` 可扩展），但 v1 **不做**自由步骤编辑器 /
DAG 画布。逃生舱 = 编辑对话框里的 "Edit as JSON" 切换。

对账说明：原稿的 `reviewerContext: auto|fresh|branch`（"有产出物路径→fresh，
否则→branch-from-history"）已被实际落地的方案替代——reviewer 永远是 fresh
session（或复用上一个 reviewer），上下文靠 3.3 的意图简报 + 作用域快照喂入，
不再走 branch-from-history。Phase 2 定义模板参数时以现有 `ReviewSpan` /
`ReviewContextMode` / `REVIEWER_AGENT_TYPES` 为准。

### 2.3 `workflow_runs` 表（现状）

DDL 见 `storage/sqlite.ts`（`CREATE TABLE workflow_runs`），行类型
`WorkflowRun`（`storage/types.ts`）：

| 列 | 含义 |
|---|---|
| `id` | run id。本地 `randomUUID()`；远程由 hub 预分配并随请求下发（durable replay 的稳定身份），同时是 reviewer 预备身份的 `operationId` |
| `project_id`, `branch` | branch **由服务端从 source session 的投影推导**，从不取自请求体 |
| `source_session_id`, `source_turn_end_index` | 被 review 的 session 与作为 cutoff 的 `turn_end` 索引 |
| `reviewer_session_id` | 可空：run 创建到 reviewer 预备之间为 null |
| `review_focus` | 用户填写的本次审查重点 |
| `review_target` | JSON `{ baseHead, diffDigest, diffStat, capturedAt }`（3.3 漂移检测） |
| `review_span` | `'this_turn'`（默认）\| `'session_start'`，决定作用域起点快照 |
| `feedback_snapshot` | reviewer 该 turn 最后一条 assistant 消息的原文快照；approve 时被 `editedPayload` 覆盖 |
| `status` | 见 3.2；无 CHECK 约束 |
| `error` | **兼作警告通道**：漂移提示、"发送状态未知"、"激活结果未知"、cancel reason；approve / finalize / 进入 discussing 时清空 |
| `prepared_context` | JSON `{ scope, taskContext, originalIntent, authorSelfReport }`——prepare 时冻结的 prompt 输入，重启后 activate 仍能拼出同一份 prompt；复用 reviewer 的 run 与旧行为 null |
| `created_at`, `updated_at` | `created_at` 用于重启后计算剩余的准备超时窗口 |

索引 `idx_workflow_runs_project_branch_status (project_id, branch, status)`。

**有意不落在 run 行上的三样东西**（后续设计需知）：意图简报、上下文模式
（briefed/blind）、reviewer agent 类型。它们只是 prepare/activate 的一次性参数；
唯一的持久副本在 hub 侧 `remote_reviewer_creation_intents`（远程 saga 需要
重放）。事后判断某次 review "是盲审还是有简报"，只能看 reviewer prompt 末尾的
`(review context: …)` 归因行。Phase 2 若需按轮次统计/回放，先把这三项落列。

**相邻表**：
- `turn_snapshots (session_id, turn_end_index, head, dirty JSON, captured_at)`，
  PK `(session_id, turn_end_index)`，session 起点哨兵 `turn_end_index = -1`。
  在 session 启动、每次 `endActiveTurn`、review 发起时抓取；只对本地
  `!skipDb` session 生效（远程 worker 侧尚未接线）。见 3.3 作用域。
- `notification_outbox`（带 `workflow_run_id`）：里程碑与状态迁移同一事务写入。
- hub 侧 `remote_reviewer_creation_intents`：远程 reviewer 创建 saga 的持久意图
  （预分配的 run id / reviewer id、span、context mode、agent type、brief）。

**`workflow_run_steps`（投递身份，2026-09-18 dev1 已实现）**：引擎每次逻辑派发一行——
`id`（= dispatch id）/ `run_id`（级联删除）/ `round` / `role` / `kind`
（`reviewer_prompt | rereview_prompt | final_verdict | feedback`）/ `session_id`（无 FK）/
`idempotency_key` / `payload_hash` / `status`（`dispatched | claimed | abandoned`）/
`user_entry_index` / `turn_end_index` / `output_snapshot` / `error`。
部分唯一索引保证同一 run 同一 kind 至多一条 `dispatched`（重试复用它）；abandoned 行保留
作历史、不计入轮次。与 transcript 的连接点只有 `user_entry_index`——**entry 上不加任何字段**。

**Phase 2 预留（未实现）**：`command_id` / `template` / `params_snapshot` /
`task_text` / `step` / `pending_gate`（`gateType`:
`relay_to_reviewer | relay_to_implementer | accept_result |
max_rounds_escalation`）。run 行上今天没有轮次计数、没有 verdict 列（轮次目前只存在于步骤行）。

**并发约束（session 级锁，按角色记账）**：
- 引擎内存里有 `participants: Map<sessionId, { runId, role: source|reviewer }>`，
  启动时由 `init()` 从活跃 run 重建。创建 run 时**在第一个 await 之前同步预留**
  参与者（防双击竞态），再做 `getActiveBySession` 的持久校验；冲突 → 409
  `session-busy`。
- source session 正在 `running` → 409 `source-running`；复用的 reviewer 不是
  `stopped`、不同 project/branch、checkout 不可用、agent 类型不支持 → 409
  `reviewer-unavailable`。
- 同 workspace 上参与集合不相交的多个 run 可以并行。
- 活跃状态集 `WORKFLOW_ACTIVE_STATUSES`（`storage/workflow-run-status.ts`）被
  session 保留策略共用：活跃 run 的参与者永不被自动删除。

---

## 3. Workflow 引擎

模块 `packages/vibedeckx/src/workflow-engine.ts`，经 `shared-services` 插件
装饰到 fastify 实例。核心原则：**控制流全在代码里，模型不在中继链路上。**

2026-09 措辞修正：模型仍不在**中继**链路上——没有任何模型输出改变引擎的状态
迁移。但模型已进入**准备**链路：review 启动时会跑一条多次调用的意图简报蒸馏
（3.3），这正是 `preparing` 状态存在的原因。

### 3.1 事件身份与归属判定（现状）

**turn 边界前置**（已落地）：`commitCompletion` 先持久化 `turn_end`，再发
`session:taskCompleted`，事件携带 `turnEndEntryIndex`。一个索引同时解决三件事：
task_text（该 turn 的 user message）、完整反馈（turn 内最后一条 assistant 消息）、
branch cutoff。

**归属判定（2026-09-18 起按派发身份，dev1）**：

```
session:taskCompleted
  → open = workflow_run_steps 中 session_id = 该 session 且 status = dispatched 的行
  → openingIndex = 开这个 turn 的 user entry 的索引（上一个 turn_end 之后最早的 user entry）
  → step = open 中 有效 entry 索引 === openingIndex 的那一条
      有效索引 = step.user_entry_index ?? （reviewer_prompt 时）session 行的 activation_user_entry_index
      命中 reviewer 侧 kind 且 run.status === waiting_reviewer：
            feedback = extractLastAssistantInTurn(entries, turnEndEntryIndex)
            → 单事务：步骤 dispatched→claimed + run waiting_reviewer→waiting_feedback + review_ready 里程碑
            → **不唤醒指挥官模型**
      命中 feedback：只 claim 步骤（run 已 completed；Phase 2 在此接循环），不抑制指挥官
      有 open 步骤但无一匹配：不接收；run 在 waiting_reviewer 时写 run.error 提示
  → 无 open 步骤：仅当该 run **没有任何步骤行**（升级前创建）才走旧规则
      participants role === reviewer 且 run.status === waiting_reviewer（保留一个发布周期）
```

规则成立的前提：**引擎只向空闲 session 派发**，且空闲检查与发送在与 `/message` 路由
共用的每 session 互斥锁内完成——空闲时的派发必然自己开一个 turn。发送路径保证
“entry 持久化 → await 回调写索引 → 才写 stdin”（普通、dormant 唤醒、激活三条路径一致），
所以“索引为空”即“stdin 从未写过”。`WorkflowEngine` 是唯一领取方。

`shouldSuppressAgentEvent(sessionId)` = "该 session 是某活跃 run 的 reviewer"。
两处消费：ChatSessionManager 在唤醒模型前调用；AgentSessionManager 把结果盖成
`taskCompleted` WS 帧的 `workflowSuppressed` 字段，remote 桥接原样转发——
所以 hub 也会抑制 worker 上 reviewer 的完成事件（Phase 1.5 的跨机抑制协调）。

通知抑制是另一套机制：reviewer 首条指令带 `notificationDisposition:
"milestone-managed"`，关闭 `session_result_ready`，一次 review 只响一次铃
（响的是 `review_ready` 里程碑）。

**人接管不在 completion 侧猜测**，而在消息发送入口：`/message` 路由投递前
调用 `handleExternalUserMessage`（**永不抛错**，否则会打断用户消息投递）。
规则见 3.4——2026-09 起**发消息不再取消 run**。

**普通 completion 的结构化元数据**：`[Agent Event: Task Completed]` chat entry
带 `event?: { kind: "agent_task_completed", sessionId, turnEndEntryIndex }`，
UI 凭它渲染 Review 按钮，模型只读 content。

**summaryText 不可作 payload**：`SUMMARY_TEXT_CAP=1500` 截断；引擎一律按
`turnEndEntryIndex` 从存储读全文。

### 3.2 Ad-hoc review 状态机（现状，已实现）

状态集：`preparing | waiting_reviewer | waiting_feedback | discussing |
sending_feedback | completed | cancelled | failed`；前五个为活跃状态。

```
(none) ──create, fresh reviewer──▶ [preparing] ──activate (CAS)──▶ [waiting_reviewer]
(none) ──create, reuse reviewer──────────────────────────────────▶ [waiting_reviewer]
[preparing] ──准备超时 10min / 激活失败──▶ [failed]      ──cancel──▶ [cancelled]
[preparing] ──激活结果 uncertain──▶ [waiting_reviewer] + error（绝不重发）

[waiting_reviewer] ──reviewer taskCompleted (CAS+outbox review_ready)──▶ [waiting_feedback]
[waiting_reviewer] ──用户向 reviewer 发消息──▶ [discussing]
[waiting_feedback] ──用户向 reviewer 发消息──▶ [discussing]
[discussing]       ──finalize (CAS, 注入 FINAL_VERDICT_PROMPT)──▶ [waiting_reviewer]
                     （reviewer 正在 running → 409 session-busy；发送失败回滚 discussing + error）

[waiting_feedback] ──approve(editedPayload?) (CAS)──▶ [sending_feedback]
[sending_feedback] ──发送成功──▶ [completed]
[sending_feedback] ──发送失败──▶ [waiting_feedback] + error（人工重试）
[sending_feedback] ──cancel──▶ 409 "反馈正在发送，无法取消"
[sending_feedback] ──重启 (init)──▶ [waiting_feedback] + error "发送状态未知"

{preparing, waiting_reviewer, waiting_feedback, discussing} ──cancel──▶ [cancelled]
任意非终态 ──failRun──▶ [failed]（outbox workflow_failed）
completed / cancelled / failed：吸收态
```

要点：
- **多轮已是事实**：`discussing → waiting_reviewer → waiting_feedback` 可无限循环，
  `review_ready` 里程碑 id 按 reviewer turn 的边界索引分轮
  （`workflow:<runId>:turn:<idx>:review-ready`）。但没有轮次计数列、没有上限。
- gate 只在**刻意生成的终稿** turn 之后出现（"拉"而非"推"）：`discussing` 期间
  的闲聊 completion 不满足 `status === waiting_reviewer`，被丢弃。
- 所有状态迁移都是条件 UPDATE（SQLite 单写者即 CAS，first-wins）；带里程碑的
  迁移走 `transitionWithOutbox`，CAS 失败则不写通知。
- `WorkflowError` 码 → HTTP：`session-busy` / `source-running` /
  `reviewer-unavailable` / `bad-state` → 409，`no-completed-turn` → 400，
  `send-failed` → 502，`spawn-failed` → 500。错误体是中文文案，**没有机器可读
  的 code 字段**（前端 `explainStale` 靠状态而非文案解释过期点击）。

### 3.2b Design–Review Loop 状态机（Phase 2 草案，未实现）

保留 2026-07-17 的草案作为 Phase 2 的起点，但以下几处必须按现状改写后再实施：

1. **verdict 词汇**：草案的 `VERDICT: APPROVE | REVISE` 已被实际 prompt 的
   `ship / needs-changes / cannot-verify` 取代（3.3）。今天**没有任何解析**——
   引擎不读 verdict，只把全文经人工闸门中继。Phase 2 要解析时以三值为准，
   `cannot-verify` 必须映射为人工裁决而非 REVISE。
2. **起点是两段式**：循环的每一轮 reviewer 派发都要经过 3.6 的
   prepare/activate（或复用路径），不是草案里的一次 `dispatch()`。
3. **`discussing` 要进循环**：任一轮 reviewer 完成后用户都可能进入讨论再终稿，
   状态机需容纳 `waiting_gate ⇄ discussing`。
4. **reviewer 跨轮复用**：现有 "Continue last reviewer" 路径（`buildRereviewerPrompt`，
   禁止扩 scope）就是循环第 ≥2 轮的 reviewer 派发形态，可直接复用。
5. **implementer 侧派发**：`buildFeedbackMessage` 已定义回投消息形状（含逐条
   交代义务，供下一轮 rereview 读作 author self-report）；循环只需在其完成后
   自动 claim（需 dispatchId）。

```
start(taskText):
  implementer = 当前 workspace 活跃 session（无则按模板 spawn）
  dispatch(implementer, taskText)                    → waiting_agent (implementing)
  （dispatch = 生成 dispatchId、落 steps 行、sendToAgentSession）

on taskCompleted(implementer):                     ← 按 dispatchId claim
  payload = 完整输出快照 + 产出物指针 + review_target/scope 快照
  → pending_gate { gateType: relay_to_reviewer }   → waiting_gate

on gate approved (可编辑后):
  round == 1 且 reviewer 未建 → 两段式 prepare/activate 新 reviewer（3.6）
  round >= 2 → 复用路径（rereview prompt）
  → waiting_agent (reviewing)

on taskCompleted(reviewer):                          ← 按 dispatchId claim，读全文快照
  解析尾部 verdict：ship / needs-changes / cannot-verify
  ship          → pending_gate { accept_result }                  → waiting_gate
  needs-changes → pending_gate { relay_to_implementer, payload }  → waiting_gate
  cannot-verify → 人工裁决（同无 verdict）
  round >= maxRounds → pending_gate { max_rounds_escalation }     → waiting_gate

on gate approved（所有 gateType 通用）:
  条件 UPDATE … WHERE status='waiting_gate' 原子领取
  → status=sending → sendToAgentSession
  → 成功 → round+1 → waiting_agent
  → 明确失败 → 退回 waiting_gate，允许用户重试
```

**投递语义是诚实的 at-least-once + 永不把未发的报成已发**（2026-09-18 起，dev1）：
引擎每次派发带稳定键 `run:<runId>:step:<stepId>`（fresh reviewer 沿用 lifecycle 的
`review:<runId>`），经 `deliverInstruction` 走 `/message` 路由同一本账本
`agent_instruction_deliveries`——HTTP/进程级重试不再重复投递；stdin 层没有带 ID 的
ACK，重复消灭不了。结果分三类：已接受 / 证明无副作用（作废步骤 + 回滚 run）/
结果未知（步骤保持 dispatched、run 停在等待态，真实完成仍被接收，面板给“重试投递”，
复用同一步骤与键；改稿重试 → 409）。崩溃后**不自动重投**：`init()` 按步骤行对账——
两列索引皆空 ⇒ 未送达 ⇒ 回滚到派发前状态（可改稿）；turn 已完成 ⇒ 迟到归属；
turn 被重启打断 ⇒ 作废 + 诚实提示。无步骤行的旧 run 仍是“发送状态未知”。

### 3.3 Payload 原则：传指针 + 客观作用域 + 上下文阶梯

**指针原则不变**：reviewer → implementer 的反馈原文中继（经可编辑闸门）；
implementer → reviewer 不序列化成果，双方在同一 worktree，reviewer 自己读文件、
跑 `git diff`。

**作用域快照（已实现，取代"reviewer 自己判断范围"）**：`turn_snapshots` 记录
每个 turn 边界的 `head` 与 dirty 文件的内容哈希；发起 review 时
`computeScope(startSnap, endSnap)` 按**内容哈希差**（非 git status）得出本 turn
真正改动的文件集，预先存在的脏文件、期间的手工 commit、暂存区抖动都被排除。
起点由 `review_span` 决定（`this_turn` = 上一个 turn_end；`session_start` = `-1`
哨兵行）。reviewer prompt 的 `## Scope` 有四种形态：文件清单 + `startHead`
（"confine your review to these files"）；无改动但有实质自述（≥80 字）→
"review THAT analysis"；无改动无自述 → 不要审无关改动；快照缺失 → "scope
unknown，自己判断"。抓取是 best-effort、永不抛进 turn 生命周期；远程
`skipDb` session 目前无快照 → 恒为 scope unknown。

**Review target（漂移检测，提示级）**：`{ baseHead, diffDigest, diffStat,
capturedAt }`，不存 patch 全文；reviewer 完成时复查，漂移则在 `error` 通道写
"workspace 在 review 期间发生了变化"并进 prompt。

**上下文阶梯（已实现，主 spec 原先没有这个概念）**：reviewer prompt 的
session 派生部分按可得性降级，并在末尾盖归因行以便事后区分：

| 层 | 内容 | 归因行 |
|---|---|---|
| Tier 1 | LLM 蒸馏的**意图简报**（`utils/review-brief.ts`：reversal 预扫 + 压缩折叠 + 终稿，判断类调用走用户**主**模型、切片压缩走快模型；证据打 `[settled]`/`[tentative]` 标签；prompt 要求 <500 词，生成侧硬上限 `BRIEF_MAX_CHARS`=4000 字符；客户端预生成后随创建请求带回时路由层再按 8000 字符钳位） | `distilled intent brief + author self-report + live workspace`（无自述时为 `distilled intent brief + live workspace`） |
| Tier 2 | 确定性原文摘录：首条用户消息 + 最新用户消息 + 作者自述（`<author-self-report>`，标注 unverified） | `deterministic excerpt of the source conversation + live workspace` |
| Tier 3 | 仅工作区（源对话不可得，如旧 worker 无 `brief-source` 路由） | `live workspace only — the source conversation was unavailable` |
| Tier 0 / **blind** | 用户显式选择：**扣留全部 session 叙事**（简报、摘录、自述），只给仓库派生证据（scope、git），要求 reviewer 先陈述自己推断的意图，可疑处标 "possibly intended — needs author confirmation" | `independent review — session context deliberately withheld` |

"deliberately withheld" 与 "was unavailable" 必须可区分。blind 不能与复用
reviewer 同用（旧 reviewer 已带上下文）。简报可由前端在弹窗打开时预生成
（`POST /api/workflow-runs/intent-brief`）并随创建请求带回，跳过再次蒸馏；简报
质量由 `review-brief.eval.test.ts` 真机评估把关（见 `docs/review-brief-eval.md`）。

**有简报时的纪律**：`[settled]` 的决定不得作为发现重提（但其具体后果可以）；
被违反的硬约束一律 blocking；不得提出简报范围之外的增强——scope 扩张是产品
决定，不是 review 发现。

**Verdict 词汇（prompt 层，不解析）**：`VERDICT_INSTRUCTIONS` 定义 blocking 门槛
（真实缺陷、用户会碰到的情况、安全/数据风险、关键逻辑缺测试）与非 blocking
（过度工程、投机防御、风格偏好），结尾要求：verdict ∈ `ship / needs-changes /
cannot-verify`，blocking 清单，non-blocking 备注。`FINAL_VERDICT_PROMPT`
（讨论后终稿）要求把 review 写成可原样送达作者的成品，吸收讨论中已达成的修正。

**回投消息 `[Review Feedback]`**：声明 reviewer 只读、只见本 turn diff + 简报、
可能前提有误；要求逐条核实、有据则反驳而非迎合、先 blocking、不扩 scope、
**结尾逐条交代 fixed / not fixed and why**——这份交代就是下一轮 rereview prompt
读到的 author self-report。

### 3.4 边界情况（现状）

| 情况 | 处理 |
|---|---|
| 用户向 **reviewer** 发消息 | 不取消。CAS `waiting_feedback|waiting_reviewer → discussing`，gate 收起；无论 CAS 是否生效都重广播当前行（补丢帧）。用户点"生成终稿"才回到 `waiting_reviewer`。从 `waiting_reviewer` 切入时，该 run 的 reviewer 侧 open 步骤一并作废（在途那一轮的产出算讨论，不算结论；下一次终稿用新步骤新键）（dev1） |
| 用户向 **source** 发消息 | **无任何动作**。review 针对启动时的快照独立进行；继续源对话不得隐式取消 review 或丢掉在途 verdict（原稿与讨论轮次 spec 的"source 消息取消 run"均已作废） |
| 取消 | 只能显式：gate `cancel` 或 `/cancel`。`sending_feedback` 不可取消（409）；已终态幂等返回；从 `preparing` 取消会把预备中的 reviewer 打成墓碑 |
| 输出无 verdict | 不解析，反馈直接呈给用户裁决（Phase 2 才解析；`cannot-verify` 归人工） |
| 准备超时 | `preparing` 10 分钟未被激活（蒸馏方死亡）→ `failed` + `workflow_failed` 里程碑；重启后按 `created_at` 续算剩余窗口 |
| 激活结果未知 | lifecycle 服务返回 `uncertain`（首条指令落库后、写 stdin 前崩溃）→ run 进 `waiting_reviewer` 并写 error，**绝不自动重发** |
| 服务重启 | `init()` 先按步骤行对账（dev1：未送达 ⇒ 回滚可改稿；已完成 ⇒ 迟到归属；被打断 ⇒ 作废 + 提示），其余（无步骤行的旧 run、无法判定的）沿用：`sending_feedback` → `waiting_feedback` + "发送状态未知"；`waiting_reviewer` 保持 + "可能错过完成事件"提示；`preparing` 续超时；内存 `pendingActivations` 丢失则从 `prepared_context` 重建，两者皆无（旧行）才退化 scope=null；重建 participants 表 |
| 蒸馏失败 / 压缩溢出 / 旧 worker 无 brief-source | 静默降级到 Tier 2/3，不阻塞启动 |
| hub 在蒸馏期间与 worker 断连 | 重放以单发方式激活，无简报（降级 Tier 2），已接受的代价 |
| 快照抓取失败 | 非致命，scope unknown |
| 同 branch 多 session 并发 | 归属按派发步骤的 entry 索引（3.1）；无关事件落回普通路径 |
| 派发目标正在运行（dev1） | 引擎只向空闲 session 派发：approve 时 source 在跑、终稿/复审时 reviewer 在跑 → 409 `session-busy`，不发送、run 不变。检查在 session 互斥锁内重做一次，用户消息抢先落地同样得到 409 |
| 投递结果未知（dev1） | 步骤保持 dispatched，run 停在等待态（反馈侧退回 `waiting_feedback`），`run.error` 以“投递结果未知”开头；真实完成仍会被归属；重试复用同一步骤与键，改稿重试 → 409 `bad-state` |
| 参与 session 已在其他活跃 run | 创建时 409 `session-busy` |
| switch-mode / accept-plan 打到活跃 run 的参与者 | 409 "Session is participating in an active review"（仅本地 session；远程靠 worker 自查）。delete / branch / stop / restart **未**受保护 |

### 3.5 与指挥官的关系

v1 指挥官**不新增** `runWorkflow` tool，不做意图路由建议——workflow 只由用户
显式唤起。指挥官/Main Chat 的角色是**显示面**：run 卡片、中继卡片、事件都出现
在 Main Chat 时间线，但转发决策全在引擎代码。（指挥官建议 chip、自动 dispatch
留到后续阶段。）现状与此一致。

### 3.6 Ad-hoc review — 启动、复用、远程（现状）

**两段式启动（fresh reviewer）**：
1. `prepareAdhocReview`：校验（2.3 并发约束、source 有已完成 turn、checkout ready）
   → 抓 review_target → 落 run 行（`preparing`）→ 计算 scope →
   `prepareReviewer`（**预备身份，无进程，不进 sidebar / alive 投影**，
   `purpose: workflow_review`，`owner: {workflow_run, runId}`，`permissionMode: plan`）
   → 确定性标题 `Review - <source 标题>`（先于首条消息写入，防 AI 起题竞态）
   → 冻结 `prepared_context` → 起 10 分钟超时 → 201 立即返回。
2. 蒸馏方（本地 = 路由里 fire-and-forget；远程 = hub）生成简报后调
   `activateAdhocReview`：拼 prompt → `activateReviewer(activationKey =
   "review:<runId>")` → CAS `preparing → waiting_reviewer`。同进程按 runId 去重；
   已非 `preparing` 的重放幂等返回。
3. `startAdhocReview` = prepare + activate 内联，保留给旧调用方与 durable
   replay（它也能把 hub 崩溃后遗留在 `preparing` 的 run 收尾）。

**复用上一个 reviewer**：`getReviewerCandidate(sourceSessionId)` 取该 source 最近
一个 `completed` run 的 reviewer，逐项校验（存在、同 project/branch、checkout
ready、agent ∈ {claude-code, codex}、`stopped`、不在其他 run 中），返回
`{available, sessionId, title, agentType, lastActiveAt, reason}`；从未 review
过返回 null。选中则**跳过 `preparing`**：强制切回 plan 模式，直接发
`buildRereviewerPrompt`（校验上次反馈是否被处理、改动区按新代码审、禁止扩
scope）。列表路由附带 `reviewedSessionIds` 让弹窗打开前就知道有无候选。

**reviewer 只读**：`permissionMode: plan`（codex 映射 sandbox read-only），
prompt 里同时声明 "Do NOT modify any files"。

**远程（Phase 1.5 架构 + 2026-09 saga）**：引擎仍跑在 worker，hub 代理五条路由
（id 映射 `remote-{serverId}-{projectId}-{bareId}`，`parseRemoteRunId` 三段
锚定 UUID 形状防路径注入）。但 review **启动**不再是纯代理：
- hub 先落 `remote_reviewer_creation_intents`（预分配 run id / reviewer id），
  再按 worker capability 选路：worker 同时具备 `prepare` + `activate`
  （≥0.3.30）→ 两段式；否则回退单发 + 内联蒸馏。
- prepare 阶段 hub **不发布** reviewer（无 map、无 mapping、无标题槽、无通知
  watch）；蒸馏在 hub 做（provider key 不下发 worker），activate 只重试
  `status === 0`（没碰到 worker）最多 3 次、5s·n 退避；语义失败归 worker。
- worker 报 `waiting_reviewer` 后 `publishRemoteReviewer`：mapping（通知游标
  from_start）→ 活动投影 → 通知 watch → 常驻流 → 显示级 branch activity →
  标题槽 → confirm intent。
- 启动时 `recoverPendingRemoteReviewerOnce` 补齐半完成的发布或用同一组 id
  单发重放，worker 返回已激活的 run。
- 边界纪律（Phase 3 讨论已定）：worker 引擎不长出跨 remote 能力；hub 只拥有
  "持久创建意图 + 发布顺序"，不持有第二套状态机；prompt 组装权在 worker，
  hub 只传不透明数据（简报、context mode）。

**里程碑**：`review_ready`（`workflow:<runId>:turn:<idx>:review-ready`，目标
reviewer session）与 `workflow_failed`（`workflow:<runId>:failed:<from>`），
均在状态迁移同一事务写 outbox；`setMilestoneListener` 只缩短延迟，正确性靠
定期/启动 drain。

---

## 4. API（现状）

用户面路由（`workflow-run-routes.ts`，全部 `requireAuth` + project 所有权）：

```
POST /api/workflow-runs
     { projectId, branch?, sourceSessionId, reviewFocus?, sourceTurnEndIndex?,
       reviewerAgentType? | reviewerSessionId?   （二选一）,
       reviewSpan?: this_turn|session_start, reviewContextMode?: briefed|blind,
       intentBrief? }
     → 201 { run }（fresh 时 status=preparing，激活在后台）
     400 校验 / 404 session|project / 409 session-busy|source-running|reviewer-unavailable|checkout unavailable
     502 { errorCode: "notification_baseline_failed" }（远程通知基线不可达）
POST /api/workflow-runs/intent-brief        { projectId, sourceSessionId } → { brief|null }（弹窗打开时预生成）
GET  /api/workflow-runs/reviewer-candidate  ?projectId&sourceSessionId → { candidate|null }
GET  /api/workflow-runs                     ?projectId&branch → { runs, reviewedSessionIds? }
GET  /api/workflow-runs/:id                 → { run }
POST /api/workflow-runs/:id/gate            { action: approve|cancel|finalize, editedPayload? }
POST /api/workflow-runs/:id/cancel
```

- **没有 `gateId`**：run id 是唯一句柄，双击靠引擎 CAS 消解。
- `editedPayload` 只对 `approve` 有效；`undefined` = 发存储快照，空串 = 有意
  的编辑。
- `branch` 由服务端推导；body 里的 branch 与 source 不符 → 400。
- 远程：`sourceSessionId` / run id 以 `remote-` 开头时代理到 worker；
  `GET 列表` 在 `project.agent_mode !== local` 且有 `projectRemotes` 行时代理。
  hub 侧 `remoteRunMap` 仍是内存表（hydrate-by-use，终态即逐出；重启后靠
  `parseRemoteRunId` + `projectRemotes` 校验兜底）。

worker 镜像（`/api/path/*`，仅 `--accept-remote`，raw auth，信任 hub）：

```
POST /api/path/workflow-runs                      单发（body 加 runId?, newReviewerSessionId? 稳定身份，去 projectId）
POST /api/path/workflow-runs/prepare              两段式第一段（runId、newReviewerSessionId 必填）   since 0.3.30
POST /api/path/workflow-runs/:id/activate         { intentBrief?, reviewContextMode? }               since 0.3.30
GET  /api/path/workflow-runs/reviewer-candidate   ?sourceSessionId
GET  /api/path/workflow-runs                      ?path&branch（未知 project → 200 空列表）
```

gate / cancel / get-by-id 无需镜像：裸 run id 直接走普通路由。
`reverse-connect-capabilities.ts` 登记全部服务端→worker 调用（0.2.5 起有
workflow 路由；在 workflow 路由里，两段式对是唯一被显式 capability 门控的一对，
其余 workflow 调用靠 404 容忍——仓库其他地方另有 lifecycle prepare、远程 MCP
broker、附件上传三处显式门控，遵循同一条『不用 404 探测旧 worker』纪律）。`MIN_WORKER_VERSION` 仍为 0.0.0。

**推送**：`workflow:run-updated { projectId, branch, run }` 三路分发——
Main Chat WS（帧 `{ WorkflowRunUpdated }`，大写）、参与 session 的 agent 流
（帧 `{ workflowRunUpdated }`，小写；远程侧由 `runUpdatedFrameForSubscribers`
带映射后 id 重播，否则前端 reviewer 匹配静默失败）、全局 SSE `/api/events`
（喂 preparing 占位）。hub 代理的 create / gate / cancel 成功后也直接 emit
一次，不依赖 worker 帧被观察到。agent 流帧无重放，客户端以 `Ready` 纪元为
唯一兜底。

---

## 5. UI（现状）

### 5.1 唤起：输入框 + chip（Phase 2，未实现）

Main Chat 输入框的 "+" 选择器、`/` 快速补全、workflow chip、Commands 页
`kind` 分组与模板参数表单——**均未实现**。Main Chat 输入框今天只有
textarea + 发送。

### 5.2 活跃 run 的 pinned panel（已实现）

`review-run-panel.tsx`，**只在 Main Chat** 顶部渲染（agent 会话页没有），
`max-h-[50vh]` 可滚。数据源 = `GET /api/workflow-runs` + `WorkflowRunUpdated`
帧，**不依赖 chat entries**。每个活跃 run 一张卡：`Review — <focus>` + 状态词
（准备中 / reviewer 审查中 / 等你确认反馈 / 讨论中 / 发送中）、`结束` 按钮、
`error` 通道的琥珀色提示；`waiting_feedback` 时反馈**默认 markdown 预览**，
`编辑/预览` 切换，单个 `发送反馈给原 session` 按钮（发送编辑稿或原稿，不再是
三个离散按钮）；`discussing` 时给 `生成 review 终稿` 图标按钮。

可靠性机制：`reqSeq` 后发优先、每次 `Ready` 强制重读、每帧强制重读、持有
run 时 5s 轮询、`visibilitychange`/`online` 对账、过期点击按状态而非文案
重写解释（`explainStale`）、孤儿错误顶置可关闭。

**未实现**：source / reviewer session 跳转链接；"任务描述"只显示 review_focus。

### 5.2b Review 入口（已实现，形态超出原稿）

- **稳定入口**：agent 会话头部 `SearchCheck` 图标按钮（无 "…" 菜单变体），
  快捷键 `⌃⇧R / Ctrl+Alt+R`（仅 agent tab 激活时），弹窗内 `⌘⏎` 提交。
- **弹窗 "Start Review"**（不是原稿的"一键 + 可选 focus 行"）：
  - Reviewer：`Continue last reviewer`（显示 agent、相对时间、上次标题；
    **有候选时默认选中**）/ `New reviewer session`；候选失效时琥珀提示并强制
    切 new。
  - Agent：复用时锁定为上次 agent；新建时下拉，**默认 = 与源 session 不同的
    可用 agent**，标注 same as / differs from current agent。
  - Scope：`This turn only`（默认）/ `Whole session`。
  - Context：`With context`（默认）/ `Blind`；复用时禁用。
  - Review focus：单行可选。
  - 打开即预生成简报 + 查候选；提交为单个 `POST /api/workflow-runs`。
- **快捷入口**：Main Chat 完成事件卡的 `Review` 按钮——**单发**默认配置
  （无弹窗、无 focus/agent/span/context 选择，agent 用引擎默认），session 在
  活跃 run 中时 disabled + tooltip 解释，**无 run 跳转链接**，也不种下 preparing
  占位。

### 5.3 中继确认交互（已实现，见 5.2）

在 panel 内展开；引擎自己的 gate，不走 AI SDK `needsApproval`。按钮形态见 5.2。
Phase 2 终局形态：`ship` 收敛（"采纳？"）与 maxRounds 升级同一组件。

### 5.4 准备态、讨论态与可见性（已实现部分 + 缺口）

**准备态（已实现，原稿没有）**：run 在 `preparing` 时——
- sidebar 出灰色慢闪占位行 `Review - <source 标题>`（`hooks/preparing-reviews.ts`，
  以 run 为键、单调版本号、60s 墓碑、12 分钟展示 TTL，reviewer 进入 `/alive`
  后退休），点击进占位页；
- 占位页（`preparing-review-view.tsx`）：`distilling`（"Summarizing… briefing the
  reviewer"）/ `starting` / 失败可重试 / 已结束；
- source 会话顶部状态条 "Preparing review — summarizing this conversation and
  starting the reviewer" + View；
- reviewer 会话本身只剩启动诊断时也显示准备/失败占位；
- 5s 轮询 + SSE 重连重读；`resolvePreparingSwitch` 要求 reviewer 真的出现在
  `/alive` 才交接。

**讨论态（已实现）**：用户直接在 reviewer 会话发消息即进入 `discussing`，无
专门 UI；`生成 review 终稿` 按钮在 reviewer 会话最新 `turn_end` 分隔线
（branch 菜单旁）与 panel 两处，仅 `discussing` 时出现。UI 无轮次编号；铃里
每轮一条 `review_ready` 且**不合并**。

**通知**：`review_ready` → "Review feedback is ready"（深链到 reviewer
session）、`workflow_failed` → "Workflow needs attention"；panel 内操作自动已读；
reviewer 开始运行**不抢占**当前窗口（commander 自动浮现先查活跃 run 表）。

**未实现（原稿 5.4）**：sidebar 角色角标（implementer/reviewer）；活跃 reviewer
无 workflow 标记（只有普通 running 点）；session 内接管横幅——且其语义已变
（发消息不再结束 run），若做应改为"此 session 属于 Review run，发消息将进入
讨论 / 不影响 review"。

---

## 6. 范围与路线图（2026-09-18 对账）

**Phase 1 — ad-hoc review 最小闭环**：已实现（2026-07-17）。

**Phase 1.1 — sidebar 角标、session 内横幅**：**部分**。做了 preparing 占位行
与灰点；角色角标与接管横幅未做（且横幅语义需按 3.4 重定义）。

**Phase 1.5 — Remote Ad-hoc Review**：已实现（2026-07-17）。形状决策不变：
引擎在 worker，hub 代理；理由（`captureReviewTarget` 需在 worktree 所在机跑
git；同一二进制；复用 remote 代理约定）仍成立。2026-09 补充：hub 对 review
**启动**持有持久创建意图与发布顺序（3.6），但仍不持有状态机。

**Phase 1.x — 单程 review 做深（2026-07-18 ~ 2026-09-01，全部已合入）**：
1. 复用上一个 reviewer（rereview prompt、候选校验、`reviewedSessionIds`）；
2. 作用域快照 P1（`turn_snapshots`、内容哈希差、`## Scope`）与 P2（`review_span`
   选择器）；
3. 意图简报（三层上下文阶梯、`[settled]/[tentative]` 证据标签、真机评估集）
   与 blind 模式（Tier 0）；verdict 门槛改写为 `ship / needs-changes /
   cannot-verify`；rereview 禁止扩 scope；
4. 讨论轮次（`discussing` + finalize，按轮里程碑）；
5. 持久化通知里程碑（outbox 与迁移同事务）；
6. 两段式启动 + 预备 session 生命周期（`preparing`、`prepared_context`、
   `activation_uncertain`、墓碑）+ 远程 durable reviewer 创建 saga +
   preparing 占位 UI；
7. 可靠性：REST/WS 竞态守卫、重连对账、过期点击解释、`runUpdatedFrameForSubscribers`。

**Phase 2 — 完整 workflow（决定于 2026-09-18：做）**。动机不是手摇摩擦，而是
单程 review 已成熟、基础已齐，进入流程自动化。内容：`commands.kind` + 定义
JSON + Design–Review Loop 模板（3.2b 状态机、verdict 三值解析、maxRounds /
升级卡片、pause/resume 语义定义）+ `dispatchId` / `workflow_run_steps` 投递
身份 + 输入框 chip/斜杠选择器 + 模板参数表单（含 Edit as JSON）。
引擎位置已由 Phase 1.5 定死——Phase 2 落地即同时覆盖本地与 remote。

Phase 2 的**前置**（独立于模板设计）：
- ✅ agent 消息入口 idempotency key 的**覆盖**（原语 2026-07-31 已在 main；2026-09-18 dev1
  补齐：共享 `deliverInstruction`、引擎四个发送点带键、dormant 唤醒路径等 stdin 写完再返回、
  project-chat 本地目标不再丢键）；
- ✅ 投递身份 `workflow_run_steps`（2026-09-18 dev1；§2.3 / §3.1）；
- ⏸ hub 远程分支记录自身投递结果（传输歧义时今天什么都不记）——暂缓单独立项：
  账本 FK 指向本地 `agent_sessions`，`remote-` id 没有行；对循环不是硬依赖；
- 把意图简报 / context mode / reviewer agent 类型落到 run 行（2.3），否则按轮
  回放与统计无据可依；
- 主 spec 对账（本次）。

Phase 2 落地时顺手清的 1.5 遗留：hub `remoteRunMap` 持久化（重启后 gate 依赖
一次列表刷新）；被抑制的 reviewer 完成仍翻转 branch activity 圆点。

所有 Phase 都保持：每跳必确认，无自动模式。

**Phase 3 — 跨 remote 编排（讨论记录，未排期）**：见
[`2026-07-18-workflow-phase3-cross-remote-orchestration.md`](./2026-07-18-workflow-phase3-cross-remote-orchestration.md)。
结论概要：分层模型（SaaS Global Orchestrator + worker Local Workflow Runtime，
本引擎即后者，design-review 永远是 worker 本地 subworkflow）方向达成共识，
但全局层形态（确定性 DAG 引擎 vs commander 脚下的受控原语）有意不预先决定，
等第一个真实跨 remote 需求出现再选型。当下唯一行动项 = 边界纪律（见 3.6 远程）。

**显式不做（后续按信任解锁顺序）**：
1. "第 N 轮起自动继续"放权旋钮（流程跑顺后）；
2. 指挥官 `runWorkflow` tool / 意图建议 chip；
3. AI 辅助创建（"把刚才手摇的这套存成 workflow" → 预填参数表单）；
4. 更多模板（test-fix loop、implement→review 单程）；
5. 自由步骤 schema / 编辑器（除非 ≥5 个模板仍盖不住真实用例）；
6. 作用域：文件内行级隔离、区分人工/agent 的 turn 间编辑、fix-vs-implementation
   分类器（作用域快照 spec 已拒绝）；
7. 讨论轮次：复活终态 run、逐消息手动中继、自动识别哪个 turn 是终稿。

---

## 7. 安全与信任

- 每跳人工闸门本身即 v1 的安全边界：引擎的一切外呼（prepare / activate / send）
  都发生在用户确认之后，不存在无人值守的自激循环。准备链路里的模型调用
  （简报蒸馏）只产出 prompt 文本，不产出控制流。
- 引擎调用 session 原语走与指挥官相同的内部路径，受同样的 project 所有权与
  branch 约束；用户面 API 全部 `requireAuth` + 所有权；`/api/path/*` 镜像
  只在 `--accept-remote` 下开放、信任 hub、不做 per-user 作用域。
- reviewer 以 plan 模式运行（codex = sandbox read-only），结构上不能改被审
  worktree；prompt 层再声明只读。
- reviewer final report 与意图简报均属半信任内容（与 `[Agent Event]` 同级）：
  卡片如实展示，但**用户编辑权在闸门上**，且引擎从不因内容改变控制流
  （今天不解析 verdict；Phase 2 解析也只产生 ship/needs-changes 二值，
  `cannot-verify` 与其余一律人工裁决）。回投消息明确要求 source "有据则反驳"，
  防止 reviewer 权威压过代码事实。
- 远程 run id 的三段 UUID 锚定（`parseRemoteRunId`）防止 URL 编码尾巴变成对
  worker `/api/path/*` 的任意已认证 GET；hub 对未在 map 中的 run 额外要求
  `projectRemotes` 行存在。
- 未来开放自动模式时，须与 `event-driven-outbound-approval-design.md` 的
  `wokenByEvent` 闸门对齐评估（自动中继 = 受控的事件驱动外呼）。
