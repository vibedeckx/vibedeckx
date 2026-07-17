# Workflow 引擎与 Design–Review Loop 设计

> 状态：**Phase 1 + 1.5 已实现**（实现计划 docs/superpowers/plans/2026-07-17-adhoc-review-phase1.md、
> docs/superpowers/plans/2026-07-17-remote-adhoc-review-phase15.md）。
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

---

## 2. 数据模型

### 2.1 `commands` 表扩展

- 新增 `kind: 'prompt' | 'workflow'`（默认 `'prompt'`，向后兼容）。
- `kind='workflow'` 时 `content` 存 JSON 定义（见 2.2）。
- 作用域沿用现有 project/branch 两级（`branch: null` = 项目级）。

### 2.2 Workflow 定义（v1 = 模板 + 参数，非自由步骤）

```jsonc
{
  "template": "design-review-loop",     // v1 唯一模板
  "params": {
    "reviewerPrompt": "…",              // 叶子 prompt，用户可打磨（预填默认对抗性 review 指令）
    "reviewerAgentType": "claude",      // claude | codex
    "reviewerContext": "auto",          // auto | fresh | branch（auto: 有产出物路径→fresh，否则→branch）
    "artifactHint": "docs/*-design.md", // 可选，产出物路径提示
    "maxRounds": 3,
    "placeholder": "描述要设计/修复的任务，或指向已有设计文档…"  // 输入框 placeholder
  }
}
```

存储按通用 schema 设计（`template` 可扩展），但 v1 **不做**自由步骤编辑器 /
DAG 画布。逃生舱 = 编辑对话框里的 "Edit as JSON" 切换。

### 2.3 `workflow_runs` 表（新）

Phase 1（ad-hoc 单程）最小形态：

```
id, project_id, branch,
source_session_id,                    -- 被 review 的 session
source_turn_end_index,                -- 触发 Review 的 turn_end（task 上下文 / branch cutoff 共用，见 3.1）
reviewer_session_id (nullable),
review_focus (nullable),              -- 用户补充的本次审查重点
review_target (JSON | null),         -- { baseHead, diffDigest, capturedAt }（见 3.3）
feedback_snapshot (nullable),         -- reviewer 完成时读取的完整反馈快照
status: waiting_reviewer | waiting_feedback | sending_feedback |
        completed | cancelled | failed
created_at, updated_at
```

Phase 2（循环模板）在此之上扩展：`command_id` / `template` /
`params_snapshot` / `task_text` / `round` / `step` / `pending_gate`
（`gateType`: `relay_to_reviewer | relay_to_implementer | accept_result |
max_rounds_escalation`，四种 gate 显式建模），以及 `workflow_run_steps` 表
（`dispatch_id` + `output_snapshot`——session 跨轮复用后，归属判定才需要
turn 级投递身份，见 3.1）。

持久化到 SQLite（教训来自 approval 设计："内存态重启即丢"）。

**并发约束（session 级锁，非 workspace 锁）**：
- **一个 session 同一时间至多属于一个活跃 run**（implementer / reviewer 身份
  均计）。创建 run 时校验参与 session 集合，冲突 → 409。
- 同 workspace 上参与集合不相交的多个 run **可以并行**——ad-hoc review 的
  高频轻量定位要求如此，不能让 A 在 review 时 B 失去 Review 入口。
- 入口态：session 已在活跃 run 中时，其 Review 入口 **disabled + 解释 +
  run 跳转链接**，而非隐藏。

---

## 3. Workflow 引擎

新模块 `packages/vibedeckx/src/workflow-engine.ts`，经 `shared-services` 插件
装饰到 fastify 实例。核心原则：**控制流全在代码里，模型不在中继链路上。**

### 3.1 事件身份与归属判定

**turn 边界前置修正（现有实现顺序问题）**：当前 `commitCompletion` 先 emit
`session:taskCompleted`、后 `endActiveTurn` 持久化 `turn_end`
（`agent-session-manager.ts:868/881`）——事件消费者此刻既拿不到可作 branch
cutoff 的 turn_end，也无法定位该 turn 的消息范围。修正：**先持久化
turn_end，再发事件，事件携带 `turnEndEntryIndex`**。一个索引同时解决三件
事：task_text（该 turn 的 user message）、完整反馈（turn_end 前最后一条
assistant 消息）、branch cutoff——无需引入额外的 turn 模型。

**归属判定（Phase 1 不需要 dispatchId）**：ad-hoc 的 reviewer 是本次 review
新建的专用 session、只跑一次，归属直接判断：

```
session:taskCompleted
  → 引擎检查：event.sessionId == 某活跃 run 的 reviewer_session_id
              && run.status == waiting_reviewer
      命中：按 turnEndEntryIndex 读完整输出 → 快照进 run.feedback_snapshot
        → pinned panel 展开可编辑反馈。**不唤醒指挥官模型**（否则指挥官对
           同一事件自行生成回复甚至外呼，与引擎双重处理）
      未命中（run 已取消 / 无关 session / 迟到事件）：交 ChatSessionManager
        现有路径（eventListening 开启时唤醒模型）
```

检查是 ChatSessionManager 处理前对引擎的一次同进程函数调用。人接管不靠
completion 侧猜测：**消息发送入口**检查目标 session 是否属于活跃 run，是则
结束 run（5.4 横幅已预告）。`dispatchId` / `workflow_run_steps` 留到
Phase 2——只有 session 跨轮复用（implementer 反复被投递、用户可能穿插
交互）时才需要 turn 级投递身份。

**普通 completion 的结构化元数据**：`[Agent Event: Task Completed]` 目前是
纯字符串 user message（`chat-session-manager.ts:384`），UI 无从知道 Review
该针对哪个 session/turn。不建通用 activity/event 系统，只给该 chat entry 加
可选元数据：`event?: { kind: "agent_task_completed", sessionId,
turnEndEntryIndex }`——UI 凭它渲染 Review 按钮，模型照旧只读 content。

**summaryText 不可作 payload**：completion 事件里的 final report 被
`SUMMARY_TEXT_CAP=1500` 保头截尾（`agent-session-manager.ts:44`）——长报告
末尾内容必被截掉，"原样发送"也不是原样。引擎一律按 `turnEndEntryIndex`
从存储读全文；summaryText 仅供事件卡片展示。

### 3.2 Design–Review Loop 状态机（Phase 2；Phase 1 单程见 3.1/3.6）

```
start(taskText):
  implementer = 当前 workspace 活跃 session（无则按模板 spawn）
  dispatch(implementer, taskText)                    → waiting_agent (implementing)
  （dispatch = 生成 dispatchId、落 steps 行、sendToAgentSession，见 3.1/3.2 末）

on taskCompleted(implementer):                     ← 按 dispatchId claim
  payload = 完整输出快照（completionEntryIndex 读取）+ 产出物指针 + review_target 快照
  → pending_gate { gateType: relay_to_reviewer }   → waiting_gate

on gate approved (可编辑后):
  round == 1 且 reviewer 未建 → 创建 reviewer session：
    - fresh 模式：同 workspace 新 session，喂入 reviewerPrompt + 任务 + 产出物指针
    - branch 模式：POST branch（upToEntryIndex = 最新 turn_end）+ 追加 reviewerPrompt
  dispatch(reviewer, payload)                        → waiting_agent (reviewing)

on taskCompleted(reviewer):                          ← 按 dispatchId claim，读全文快照
  解析快照尾部 "VERDICT: APPROVE | REVISE"
  APPROVE → pending_gate { gateType: accept_result }            → waiting_gate
            （用户确认后才 completed——终局确认本身也是 gate）
  REVISE  → pending_gate { gateType: relay_to_implementer,
                           payload: review 全文快照 }            → waiting_gate
  round >= maxRounds → pending_gate { gateType: max_rounds_escalation } → waiting_gate

on gate approved（所有 gateType 通用的投递协议）:
  条件 UPDATE … WHERE status='waiting_gate' 原子领取（SQLite 单写者即 CAS，first-wins）
  → status=sending → sendToAgentSession
  → 成功 → round+1 → waiting_agent
  → 明确失败 → 退回 waiting_gate，允许用户重试
```

**投递语义是诚实的 at-most-once + 人工重试**（Phase 1 的
`sending_feedback` 同此）：发送与状态更新之间崩溃时，恢复后**不自动重投**
——agent 消息入口没有幂等键，"启动对账重投"无法同时保证不漏发和不重发
（发送前记账崩溃 = 漏发风险，发送后记账前崩溃 = 重发风险）。恢复时把 run
标为"发送状态未知"，提示用户检查目标 session 后手动重试或结束。
exactly-once 需要 agent message API 支持 idempotency key，等 Phase 2 做
自动恢复时再评估。

### 3.3 Payload 原则：传指针，不传序列化成果

- reviewer → implementer：反馈文本本身是交付物，原文中继（经可编辑闸门）。
- implementer → reviewer：消息只带任务描述 + 产出物路径 / diff 提示；双方在
  **同一 worktree**，reviewer 自己读真实文件、跑 `git diff`。共享文件系统是
  高带宽上下文通道，消息只是触发器和路标（规避"父模型有损转述"的坑）。

**Review target（防 worktree 漂移，提示级）**：同 worktree 多 session 并发
意味着"完成"到"开审"之间文件可能被其他 session 改动——共享文件系统**不是
不可变快照**。发起 review 时记录 `{ baseHead, diffDigest, capturedAt }`：
`diffDigest` = `git diff` + `git status --porcelain` 输出的哈希 + shortstat，
**不存 patch 全文**（大 diff、二进制、敏感内容、SQLite 膨胀），但仍能发现
未 commit 的工作树漂移——只比对 baseHead 会漏掉这类最常见的漂移。reviewer
启动时复查，已漂移则在 panel 与 reviewer prompt 中提示"workspace 在 review
发起后发生变化"。到提示为止，不做硬隔离；patch 全量快照等真实使用证明漂移
经常导致误审再加。

### 3.4 边界情况

| 情况 | 处理 |
|---|---|
| 输出无 VERDICT（Phase 2 循环才解析） | 一次便宜 LLM 分类（`resolveFastChatModel`）；仍失败 → 卡片请用户裁决。**不用**"取 conversation 末条 assistant 消息"兜底——并发下"末条"可能已不是目标 turn 的输出。Phase 1 单程不解析 VERDICT，反馈直接呈给用户裁决 |
| 用户手动向 run 内 session 发消息（人接管） | 在**消息发送入口**检测（目标 session 属活跃 run → 结束 run，5.4 横幅已预告）。Phase 2 引入 dispatchId 后再加 completion 侧兜底；pause/resume 语义留给 Phase 2 定义 |
| 服务重启 / 迟到 completion | run 在表里；`sending_feedback` 中断 → 标"发送状态未知"，请用户检查后手动处理（见 3.2 投递语义）；`waiting_reviewer` 期间丢事件 → 启动时查 reviewer session 状态补偿；已取消 run 的迟到 completion 因归属检查失败落回普通路径 |
| 同 branch 多 session 并发（resident 池） | 事件归属：Phase 1 按 `reviewer_session_id + status` 判定，Phase 2 按 dispatchId；无关事件一律落回普通路径 |
| 参与 session 已在其他活跃 run | 创建时 409（见 2.3 session 级锁） |
| run 取消 | 引擎停止调度，不打断正在跑的 turn（其 completion 因归属检查失败而被忽略） |

### 3.5 与指挥官的关系

v1 指挥官**不新增** `runWorkflow` tool，不做意图路由建议——workflow 只由用户
显式唤起。指挥官/Main Chat 的角色是**显示面**：run 卡片、中继卡片、事件都出现
在 Main Chat 时间线，但转发决策全在引擎代码。（指挥官建议 chip、自动 dispatch
留到后续阶段。）

### 3.6 Ad-hoc review（隐式单程 run）— Phase 1 的 tracer bullet

面向最高频场景："agent 完成一次修复/设计后，让另一个 agent 复查一遍"——不需要
预先创建任何 workflow command，直接从事件卡片上发起。同时它是信任阶梯的第一级：
**用户自己当状态机的手摇版**，每一步亲手触发，但没有复制粘贴摩擦；手摇顺了再
升级到 Phase 2 的自动循环（后续的 AI 辅助创建从这里接："把刚才这套存成
workflow"）。

**交互**：
- Main Chat 里非 run 关联 session 的 `[Agent Event: Task Completed]` 卡片上
  显示一个 **Review 按钮**（克制为单个动作，不做按钮排）。点击 → 创建
  reviewer session（同 3.2 的 fresh/branch 逻辑）并投递指针 payload。
- reviewer 的 taskCompleted 到达后，出**中继确认卡片**（与 5.3 同一组件，即
  "Feedback"）：review 意见在可编辑文本域中，原样发送 / 修改后发送 / 结束。
  发送 → 回到原 session。单程结束，run 置 `completed`。
- 原 session 之后再次完成时，事件卡片上再次出现 Review 按钮——用户可手摇下一轮。

**机制**：点击 Review 即在 `workflow_runs` 落一行 run
（`source_session_id` + `source_turn_end_index` + 可选 `review_focus`；
reviewer 用内置默认 reviewerPrompt、`reviewerContext=auto`），并记录
review_target（3.3）。归属判定、刷新恢复、session 级锁（该 session 已在
run 中时 Review 入口 disabled + 解释，见 2.3）全部沿用引擎机制。Feedback
的回送目标就是 run 行里的 `source_session_id`，无需新机制。

---

## 4. API

```
POST   /api/workflow-runs                { commandId?, taskText?, projectId, branch, sourceSessionId?, reviewFocus? }
                                         （参与 session 已在活跃 run → 409；
                                           commandId 省略 = ad-hoc 单程 run，须给 sourceSessionId 作 implementer）
GET    /api/workflow-runs?projectId&branch&status=active   列出 run（刷新后恢复 pinned panel / 入口态）
GET    /api/workflow-runs/:id            run 状态（轮询兜底；主推送走下述事件）
POST   /api/workflow-runs/:id/gate       { gateId, action: 'approve'|'cancel', editedPayload? }
POST   /api/workflow-runs/:id/cancel
```

- 全部过 `requireAuth` + project 所有权校验（沿用 command-routes 模式）。
- run 状态变更通过 EventBus 发 `workflow:run-updated`，经 Main Chat 的 WS 通道
  推给前端更新卡片（复用 chat session 的推送路径，不新开 SSE）。
- `gate` 幂等：条件 UPDATE 原子领取（first-wins）；批准后经 `dispatch_pending`
  + 启动对账保证崩溃时不漏发、不重发（见 3.2）。`gateId` 防止对已被替换的
  旧 gate 误批。

---

## 5. UI

### 5.1 唤起：输入框 + chip（取代"Play 按钮 + 运行弹窗"）

- Main Chat 输入框加 **"+"** 按钮 → 选择器列出 workspace 可用库（workflow 与
  prompt command 分组）；另配 **`/` 触发的快速补全**，同一选择器两个入口。
- 选中 workflow → 以 **chip** 挂在输入框上方（可移除）；placeholder 换成模板
  提供的文案；输入任务描述（允许为空）→ 发送 → `POST /api/workflow-runs`。
- 选中 prompt command → 行为不变（内容作为消息发给 Main Chat），入口统一。
- Commands 列表页降级为**管理界面**（增删改、排序、kind 图标区分）；新建入口
  分 "Prompt Command / Workflow" 两选项，后者出模板参数表单（2.2 的字段），
  角落带 "Edit as JSON"。

### 5.2 活跃 run 的 pinned panel（数据源 = 持久化 runs，非 chat entries）

活跃 run 渲染为 Main Chat 顶部 **pinned panel**：任务描述、状态
（reviewing / 等你确认）、source 与 reviewer session 跳转链接、取消按钮。
数据源是 `workflow_runs` 表（`GET ?status=active` + `workflow:run-updated`
推送）——**不依赖 chat entries**：Main Chat 会话历史目前仅存内存，重启即失，
"时间线常驻"在现状上不成立。

**Phase 1 只有这一个 run 容器**：reviewer 完成后，可编辑反馈直接**在 panel
内展开**（原样发送 / 修改后发送 / 结束），不向 Main Chat 消息类型新增
workflow gate 卡片——刷新恢复只需恢复 panel。独立的时间线 gate 卡片等
Phase 2 多 gate 并存时再评估。已完成 run 的历史查看走 run 列表，不追求留在
时间线原位。

### 5.2b Review 入口（Phase 1）

- **稳定入口**：agent session 头部 / "…" 菜单的 Review 按钮。不依赖 Main
  Chat——其事件注入开关 `eventListeningEnabled` **默认关闭**，事件卡片可能
  根本不出现。点击直接用默认配置起 ad-hoc run，可展开补充一行
  "Review focus"（本次审查重点，随 payload 进 reviewer prompt）。
- **快捷入口**：Main Chat `[Agent Event: Task Completed]` 卡片上的 Review
  按钮（该 session 已在活跃 run 中时 disabled + 解释 + run 跳转，非隐藏）。
- 随后的 Feedback 交互复用 5.3 的中继确认卡片。详见 3.6。

### 5.3 中继确认交互（核心交互）

- Phase 1：在 pinned panel 内展开（见 5.2）；Phase 2 多 gate 并存时再评估
  独立卡片。内容：来源方反馈显示在**可编辑文本域**中。
- 按钮：**原样发送** / **修改后发送** / **结束**。
- 这是引擎自己的 gate，不走 AI SDK `needsApproval`（后者仅 approve/deny，
  不支持编辑），但复用 approval 卡片的视觉与 first-wins 语义。
- Phase 2 终局形态：APPROVE 收敛（"采纳设计？"）与 maxRounds 升级同一组件。

### 5.4 状态点与 session 关联可见性（Phase 1.1）

- 复用现有 sidebar dot：workflow 运行中 = 指挥官 violet 常亮语义，不发明新状态。
- **Sidebar 关联标注**：属于活跃 run 的 session 在 resident 嵌套列表里加角标
  （如小循环图标 + 角色 implementer/reviewer），数据来自
  `GET /api/workflow-runs?status=active`。同 branch 上与 run 无关的并发 session
  无标注，一眼可辨。
- **Session 内横幅**：用户打开属于活跃 run 的 session 时，会话顶部显示
  "此 session 属于 Review run——直接发消息将结束该 run"，附 run 跳转。
  与 3.4 的人接管检测配套：结束不是惩罚，但要在打字前告知。

---

## 6. v1 范围与后续

**Phase 1 — ad-hoc review 最小闭环（tracer bullet）**：
1. `commitCompletion` 重排：先持久化 `turn_end`，再发
   `session:taskCompleted`（携带 `turnEndEntryIndex`）；
2. Main Chat completion entry 加 `event` 元数据
   （sessionId + turnEndEntryIndex）；
3. `workflow_runs` 最小表 + 引擎（归属判定 = `reviewer_session_id` +
   `status`，见 3.1）；
4. Review 入口（session 菜单稳定入口 + 事件卡片快捷按钮，含 Review focus）
   → 创建 reviewer + 记录 review_target（baseHead + diffDigest）；
5. reviewer 完成 → 按 turnEndEntryIndex 读完整反馈 → 持久化
   `feedback_snapshot`；
6. pinned panel 内可编辑反馈 → 用户确认 → CAS `sending_feedback` → 回投
   source session → completed（失败退回，人工重试；崩溃标"发送状态未知"）；
7. 刷新/重启恢复 = 恢复 pinned panel；人接管在消息发送入口检测，直接结束
   run；session 级占用检查。

验证闭环：**完成 → Review → reviewer 完成 → 用户确认 → Feedback 回投。**

**Phase 1.1**：sidebar 角标、session 内横幅（5.4）。

**Phase 1.5 — Remote Ad-hoc Review（Phase 2 的前置）**：

生产拓扑（vibedeckx.dev 前端服务器 + reverse-connect worker）下所有 agent
session 从前端服务器视角均为 `remote-` 前缀——Phase 1 的三道 remote 闸
（路由 400 ×2 + ReviewDialog null guard）意味着整个功能在托管部署上不可用。
remote 支持因此不是增强项，是上线前提，且必须先于 Phase 2：多轮编排建立在
单程传递之上，传输层没打通就上循环，会把两类问题混在一起排查。

**形状决策：引擎跑在 session 所在的 worker 上，前端服务器只做代理。**
不做"前端引擎跨传输层远程编排"，三个理由：

1. `captureReviewTarget` 对 worktree 路径 `execFileSync("git", …)`——worktree
   在 worker 的文件系统上，前端服务器物理上跑不了（跨机编排要么砍漂移检测，
   要么发明远程 git RPC）；
2. worker 与前端服务器共用同一 server 二进制，`shared-services.ts` 无条件
   构造 WorkflowEngine——worker 端引擎已存在且对其本地 session 完全工作；
3. 复用既有 remote 代理模式（branch 路由的远程镜像、
   `remote-{serverId}-{projectId}-{sessionId}` id 约定），不发明新传输机制。

工作清单：

1. **路由代理**：workflow-run 五条路由加 remote 镜像（照
   `agent-session-routes.ts` branch 路由的代理模式），run/session id 映射
   沿用既有 `remote-` 约定；
2. **事件回传**：worker 的 `workflow:run-updated` 经 reverse-connect 通道
   转发到前端 chat WS。必须走**常驻桥接**，不得依赖附着的 log proxy——
   remote executor 曾有"事件只经附着 proxy 传递、切走即丢"的 unobserved
   finish 教训；
3. **抑制协调**（唯一真正新的跨机机制）：remote reviewer 完成时，桥接
   （`remote-agent-sessions.ts` 的 taskCompleted 分支）会把事件发到前端
   EventBus，而前端 ChatSessionManager 不认识 worker 上的 run——双重处理
   问题跨机复活。解法：worker 在 taskCompleted WS 帧上标记该 completion
   属于 workflow run，桥接见标记即不唤醒指挥官；
4. **桥接事件补 `turnEndEntryIndex`**：目前桥接只转发
   duration/cost/tokens/summaryText——前端事件卡片的 Review 按钮需要
   turn 边界（turn 边界本身无需跨机传递，worker 引擎本地读）;
5. **解锁 UI/后端的 remote 闸**：去掉三道 `remote-` 拦截；takeover 钩子
   免费获得（前端 `/message` 代理到 worker 的 `/message`，worker 自己的
   钩子会跑）；
6. **remote 场景完整验证单程闭环**：完成 → Review → 确认 → Feedback。

**Phase 2 — 完整 workflow**：`commands.kind` + 定义 JSON + Design–Review Loop
模板（循环状态机、VERDICT 解析、maxRounds/升级卡片、pause/resume 语义定义）+
`dispatchId` / `workflow_run_steps` 投递身份（3.1）+ 输入框 chip/斜杠选择器 +
模板参数表单（含 Edit as JSON）；如需自动恢复投递，先给 agent 消息入口加
idempotency key（3.2）。循环状态机在引擎内实现，而引擎位置（worker 端）已由
Phase 1.5 定死——Phase 2 落地即同时覆盖本地与 remote，无需二次 remote 适配。

所有 Phase 都保持：每跳必确认，无自动模式。

**显式不做（后续按信任解锁顺序）**：
1. "第 N 轮起自动继续"放权旋钮（流程跑顺后）；
2. 指挥官 `runWorkflow` tool / 意图建议 chip；
3. AI 辅助创建（"把刚才手摇的这套存成 workflow" → 预填参数表单；从 ad-hoc
   使用记录里接最顺）；
4. 更多模板（test-fix loop、implement→review 单程）；
5. 自由步骤 schema / 编辑器（除非 ≥5 个模板仍盖不住真实用例）。

（原第 6 条"remote workspace 上的 run"已提升为 Phase 1.5——生产拓扑下它是
上线前提，不是 backlog。）

---

## 7. 安全与信任

- 每跳人工闸门本身即 v1 的安全边界：引擎的一切外呼（spawn / branch / send）都
  发生在用户确认之后，不存在无人值守的自激循环。
- 引擎调用 session 原语走与指挥官相同的内部路径，受同样的 project 所有权与
  branch 约束；API 层全部 `requireAuth`。
- reviewer final report 属半信任内容（与 `[Agent Event]` 同级）：卡片如实展示，
  但**用户编辑权在闸门上**，且引擎从不因 report 内容改变控制流（VERDICT 解析
  只产生 APPROVE/REVISE 二值，其余一律走人工裁决）。
- 未来开放自动模式时，须与 `event-driven-outbound-approval-design.md` 的
  `wokenByEvent` 闸门对齐评估（自动中继 = 受控的事件驱动外呼）。
