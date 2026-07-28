# Review 讨论轮次:与 reviewer 多轮讨论后生成终稿再过 gate

日期:2026-07-28 · 分支:dev6 · 状态:已与用户对齐方向

## 背景与问题

Review run 目前是一次性的:reviewer 完成初审 turn 后进入 `waiting_feedback`,用户在 gate
面板确认/编辑后发回 source session,run 完成。但实际场景中用户常对反馈不满意,想先和
reviewer 讨论几轮再发送修订后的意见。

现状下这条路是断的:`WorkflowEngine.handleExternalUserMessage`(由
`agent-session-routes.ts` 的 `/message` 路由在投递前调用)把"用户直接向 run 内任一
session 发消息"一律视为接管并 **取消 run**。第一条讨论消息发出的瞬间 gate 面板消失,
reviewer 之后给出的新建议没有任何路径发回 source,只能手动复制。

## 目标

用户可以和 reviewer 任意多轮讨论;讨论结束后,通过显式动作让 reviewer 生成标准格式的
review 终稿,终稿照常进入既有的确认/编辑 gate,再发回 source session。

设计取"拉"而非"推":gate 只在**刻意生成的终稿** turn 之后出现。讨论 turn 就是纯讨论,
不刷新 gate、不产生通知——避免了"讨论回复(如'你说得对,这条撤回')被当作待发送反馈"
的结构性噪音。

## 状态机

新增状态 `discussing`,三条规则:

```
                    ┌──────────────────────────────────────┐
                    ▼                                      │
  waiting_reviewer ──(reviewer taskCompleted)──→ waiting_feedback
        ▲                                          │
        │                              用户向 reviewer session 发消息
   "生成终稿"动作                                    │
   (注入固定 prompt)                                 ▼
        └──────────────────────────────────── discussing
```

1. **用户向 reviewer 发消息**(CAS 自 `waiting_reviewer` 或 `waiting_feedback`)→
   `discussing`。gate 收起;reviewer 工作中插话不再是接管,而是进入讨论态(中途打断
   补充上下文成为合法操作)。
2. **"生成终稿"动作**(CAS `discussing` → `waiting_reviewer`)→ 向 reviewer 注入固定
   prompt(见下),turn 处置为 `REVIEWER_TURN`(workflow-origin、milestone-managed)。
3. **`handleTaskCompleted` 仅在 `waiting_reviewer` 时开 gate**(现状不变)。初审走同一
   路径(初审 prompt 本身要求终稿格式,首轮无按钮、行为与现在一致);`discussing`
   期间的讨论 turn 完成不触发任何转移。

不变的语义:

- 用户向 **source** session 发消息 → 仍取消 run(工作目标变了,review 作废)。
- `结束` 按钮:`cancelRun` 增加 `discussing` → `cancelled` 的合法转移。
- `sending_feedback` 窗口的保护、at-most-once 发送、drift 检测均不变;每次终稿进入
  `waiting_feedback` 时 drift 检测照常执行。

## 各层改动

### storage(`storage/types.ts`、sqlite 实现)

- `WorkflowRunStatus` 联合类型加 `"discussing"`。
- `getAllActive` 的活跃状态集合纳入 `discussing`(boot 恢复与面板查询依赖它)。
- 无 schema 迁移:status 是文本列。

### engine(`workflow-engine.ts`)

- `handleExternalUserMessage`:按 `participants` 的 role 分流——`source` 保持
  cancelRun;`reviewer` 改为 CAS 转入 `discussing`(两个 from 状态各试一次,同
  cancelRun 的写法)。CAS 失败(如 `sending_feedback` 中)沿用现有 never-throws
  处理。转移成功后 `emitRunUpdated`。
- 新方法 `requestFinalVerdict(runId)`:校验状态为 `discussing` → CAS 至
  `waiting_reviewer` → `sendUserMessage(reviewer, FINAL_VERDICT_PROMPT, REVIEWER_TURN)`。
  发送失败则 CAS 回 `discussing` 并写 `error`(参照 approveFeedback 的回滚写法)。
- `FINAL_VERDICT_PROMPT`(新导出,便于测试):要求 reviewer 把讨论后的最终 review
  意见完整输出为面向作者的定稿,包含 `VERDICT_INSTRUCTIONS` 的裁决格式;明确"这段
  输出将原样发送给作者,不要包含对话性内容"。
- `init` boot 恢复:`discussing` 是可无限期停留的稳定态,原样保留,不写警告。

### 通知(`notification-milestones.ts`)

- `reviewReadyId(runId)` → `reviewReadyId(runId, turnEndEntryIndex)`,格式
  `workflow:<runId>:turn:<idx>:review-ready`(同 `sessionResultReadyId` 的模式)。
  每轮终稿是独立的 attention milestone;多轮 ding 由已有的 per-session 折叠
  (3d36396)收拢。`handleTaskCompleted` 处传入 boundary index。

### 路由(`routes/workflow-run-routes.ts` + 远端桥)

- gate 路由 `POST /api/workflow-runs/:id/gate` 的 `action` 联合加 `"finalize"`,
  映射到 `requestFinalVerdict`。复用 gate 路由使远端场景免费获得代理:remote run
  经 `proxyToRemoteAuto` 原样转发,worker 侧引擎处理(Phase 1.5 架构不变)。

### 前端

- `lib/api.ts`:`workflowRunGate` 的 action 类型加 `"finalize"`;`WorkflowRun`
  status 类型同步。
- `review-run-panel.tsx`:
  - `ACTIVE` 集合加 `discussing`;
  - `discussing` 状态显示"讨论中——与 reviewer 讨论后生成终稿"提示 +
    **"生成 review 终稿"按钮**(调 gate `finalize`)+ 既有 `结束` 按钮。
    (用户确认:面板镜像该按钮,作为 run 的控制台。)
- `turn-end-divider.tsx` / `agent-conversation.tsx`:reviewer 会话内,最新一个
  turn_end 上、BranchMenu 旁渲染"生成 review 终稿"按钮。渲染条件:当前 session 是
  某活跃 run 的 `reviewer_session_id` 且 run 状态为 `discussing`。数据来源:会话流
  已有的 `workflowRunUpdated` 广播 + 面板同款的活跃 run 查询;仅最新 turn_end 显示
  (与 branch 按钮的 emphasis 判断同一位置)。
- 点击后按钮进入 busy 态;run 转入 `waiting_reviewer` 后按钮消失(状态驱动,无需
  本地清理)。

## 测试

- engine 单测(`workflow-engine.test.ts` 追加):
  - reviewer 收到外部消息 → `discussing`(自两个 from 状态);source 收到 → 仍取消;
  - `requestFinalVerdict` 正常路径、发送失败回滚、非 `discussing` 状态报 `bad-state`;
  - `discussing` 中 taskCompleted 不产生转移与 milestone;
  - 多轮:v1 gate → 讨论 → 终稿 → v2 gate,两轮 milestone id 不同。
- 路由测试:gate `finalize` 本地 + remote 代理各一条。
- 前端:面板 `discussing` 分支渲染测试;turn_end 按钮渲染条件测试。

## 明确不做(YAGNI)

- 终态(completed/cancelled)run 的"复活"或逐消息手动发回——需要时重新发起 review
  (复用 reviewer 的再审路径已存在)。
- 讨论轮次的智能摘要/自动判断哪条是终稿——人 + 显式按钮即是判断。
- `discussing` 下直接发送旧 snapshot 的后门——点一次终稿按钮即可。
