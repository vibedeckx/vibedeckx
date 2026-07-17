# Workflow 引擎与 Design–Review Loop 设计

> 状态：**设计定稿待评审**（2026-07-17）。
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

```
id, command_id, project_id, branch,
template, params_snapshot (JSON),     -- 运行时冻结的定义快照
task_text,                            -- 用户在输入框里给的任务描述
status: waiting_agent | waiting_gate | paused | completed | cancelled | failed
round,                                -- 当前轮次
step,                                 -- implementing | reviewing
implementer_session_id, reviewer_session_id,
pending_gate (JSON | null),           -- 待确认中继：{ from, to, payload, verdict }
created_at, updated_at
```

持久化到 SQLite（教训来自 approval 设计："内存态重启即丢"）。引擎另需内存索引
`sessionId → runId`（启动时从表重建），用于事件路由。

**Session 绑定与并发约束**：
- run 锚定的是**精确 session id**，不是 project+branch——事件路由、人接管检测
  都按 sessionId 查。同 branch 上其他无关 session（resident 多 session 池下
  可并发运行）的事件被引擎直接忽略，互不干扰。
- **v1 每 workspace（project+branch）同时至多一个活跃 run**（`status` 非终态）。
  `POST /api/workflow-runs` 时已有活跃 run → 409。放宽到多 run 并行（各自锚定
  不相交的 session 集合）留到后续。

---

## 3. Workflow 引擎

新模块 `packages/vibedeckx/src/workflow-engine.ts`，经 `shared-services` 插件
装饰到 fastify 实例。核心原则：**控制流全在代码里，模型不在中继链路上。**

### 3.1 事件接线（双订阅）

```
session:taskCompleted (EventBus, 已有)
  ├─→ ChatSessionManager（不动）：照常生成 [Agent Event] 展示在 Main Chat
  └─→ WorkflowEngine（新增）：
        sessionId → run 路由 → 取事件里的 final report
        → 解析 VERDICT → 生成中继确认卡片（pending_gate）→ 等用户
```

### 3.2 Design–Review Loop 状态机

```
start(taskText):
  implementer = 当前 workspace 活跃 session（无则按模板 spawn）
  sendToAgentSession(implementer, taskText)          → waiting_agent (implementing)

on taskCompleted(implementer):
  payload = final report + 产出物指针（artifactHint 匹配 / branch diff 提示）
  → pending_gate { to: reviewer }                    → waiting_gate

on gate approved (可编辑后):
  round == 1 且 reviewer 未建 → 创建 reviewer session：
    - fresh 模式：同 workspace 新 session，喂入 reviewerPrompt + 任务 + 产出物指针
    - branch 模式：POST branch（upToEntryIndex = 最新 turn_end）+ 追加 reviewerPrompt
  sendToAgentSession(reviewer, payload)              → waiting_agent (reviewing)

on taskCompleted(reviewer):
  解析尾部 "VERDICT: APPROVE | REVISE"
  APPROVE → 终局确认卡片（"review N 轮收敛，采纳设计？"）→ completed
  REVISE  → pending_gate { to: implementer, payload: review 意见原文 } → waiting_gate
  round >= maxRounds → 升级卡片（"未收敛，继续/结束？"）

on gate approved → sendToAgentSession(implementer, 意见) → round+1 → waiting_agent
```

### 3.3 Payload 原则：传指针，不传序列化成果

- reviewer → implementer：反馈文本本身是交付物，原文中继（经可编辑闸门）。
- implementer → reviewer：消息只带任务描述 + 产出物路径 / diff 提示；双方在
  **同一 worktree**，reviewer 自己读真实文件、跑 `git diff`。共享文件系统是
  无损上下文通道，消息只是触发器和路标（规避"父模型有损转述"的坑）。

### 3.4 边界情况

| 情况 | 处理 |
|---|---|
| final report 空 / 无 VERDICT | 降级 `getAgentConversation` 取末条 assistant 消息；再失败 → 一次便宜 LLM 分类（`resolveFastChatModel`）；仍失败 → 卡片请用户裁决 |
| 用户手动向任一 session 发消息（人接管） | 引擎检测到非引擎发起的 turn → run 置 `paused`，run 卡片上选择继续或结束 |
| 服务重启 | run 状态在表里；`waiting_agent` 中丢失的 taskCompleted 由启动时对账（查 session 当前状态）补偿；`waiting_gate` 天然可恢复 |
| 同 branch 多 session 并发（resident 池） | 事件按精确 sessionId 路由到 run，无关 session 的 taskCompleted 一律忽略；run 内部 ping-pong 本身串行（reviewer 跑时 implementer 在等） |
| 同 workspace 已有活跃 run | 创建时 409（见 2.3 并发约束） |
| run 卡片上取消 | 引擎停止调度，不打断正在跑的 turn（该 turn 完成事件被忽略） |

### 3.5 与指挥官的关系

v1 指挥官**不新增** `runWorkflow` tool，不做意图路由建议——workflow 只由用户
显式唤起。指挥官/Main Chat 的角色是**显示面**：run 卡片、中继卡片、事件都出现
在 Main Chat 时间线，但转发决策全在引擎代码。（指挥官建议 chip、自动 dispatch
留到后续阶段。）

---

## 4. API

```
POST   /api/workflow-runs                { commandId, taskText, projectId, branch }（同 workspace 已有活跃 run → 409）
GET    /api/workflow-runs?projectId&branch&status=active   列出 run（前端刷新后恢复 run 卡片、sidebar 关联标注）
GET    /api/workflow-runs/:id            run 状态（run 卡片轮询兜底；主推送走下述事件）
POST   /api/workflow-runs/:id/gate       { action: 'approve'|'cancel', editedPayload? }
POST   /api/workflow-runs/:id/cancel
POST   /api/workflow-runs/:id/resume     （paused → 继续）
```

- 全部过 `requireAuth` + project 所有权校验（沿用 command-routes 模式）。
- run 状态变更通过 EventBus 发 `workflow:run-updated`，经 Main Chat 的 WS 通道
  推给前端更新卡片（复用 chat session 的推送路径，不新开 SSE）。
- `gate` 幂等：first-wins（沿用 approval 设计的 `{ toolApproval }` 语义）。

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

### 5.2 Run 卡片（Main Chat 时间线常驻）

显示：模板名 + 任务描述、当前轮次（Round 2/3）、状态（implementing / reviewing /
等你确认 / 已暂停）、implementer 与 reviewer session 跳转链接、取消按钮。
随 `workflow:run-updated` 事件更新。

### 5.3 中继确认卡片（v1 核心交互）

- 出现在 Main Chat 时间线（`waiting_gate` 时），内容：来源方 final report /
  review 意见显示在**可编辑文本域**中。
- 按钮：**原样发送** / **修改后发送** / **结束循环**。
- 这是引擎自己的 gate step，不走 AI SDK `needsApproval`（后者仅 approve/deny，
  不支持编辑），但复用 approval 卡片的视觉与 first-wins 语义。
- 终局形态：APPROVE 收敛卡片（"采纳设计？"）与 maxRounds 升级卡片同一组件。

### 5.4 状态点与 session 关联可见性

- 复用现有 sidebar dot：workflow 运行中 = 指挥官 violet 常亮语义，不发明新状态。
- **Sidebar 关联标注**：属于活跃 run 的 session 在 resident 嵌套列表里加角标
  （如小循环图标 + 角色 implementer/reviewer），数据来自
  `GET /api/workflow-runs?status=active`。同 branch 上与 run 无关的并发 session
  无标注，一眼可辨。
- **Session 内横幅**：用户打开属于活跃 run 的 session 时，会话顶部显示
  "此 session 属于 Design–Review Loop（Round 2/3）——直接发消息将暂停该 run"，
  附 run 卡片跳转。与 3.4 的人接管检测配套：暂停不是惩罚，但要在打字前告知。

---

## 6. v1 范围与后续

**v1（本文范围）**：`commands.kind` + 定义 JSON；`workflow_runs` 表 + 引擎 +
Design–Review Loop 模板；4 条 API；输入框 chip 选择器 + 模板参数表单 + run
卡片 + 中继确认卡片。每跳必确认，无自动模式。

**显式不做（后续按信任解锁顺序）**：
1. "第 N 轮起自动继续"放权旋钮（流程跑顺后）；
2. 指挥官 `runWorkflow` tool / 意图建议 chip；
3. AI 辅助创建（"把我刚才手动做的存成 workflow" → 预填参数表单）；
4. 更多模板（test-fix loop、implement→review 单程）；
5. 自由步骤 schema / 编辑器（除非 ≥5 个模板仍盖不住真实用例）；
6. remote workspace 上的 run（v1 仅本地 session；remote 的 taskCompleted 事件
   路径需另行验证）。

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
