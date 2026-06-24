# 事件驱动出站确认闸（Event-driven Outbound Approval Gate）

## 1. 背景与问题

Main Chat 的 commander 通过两个工具向 coding agent 发起动作：

- `spawnAgentSession` — 在当前 workspace 新建一个 agent 并交付任务
- `sendToAgentSession` — 给当前 workspace 已有 agent 追发消息

这两个工具的 `execute` 当前**直接**调用 `agentSessionManager.sendUserMessage(...)`，没有任何人类确认环节（见 `packages/vibedeckx/src/chat-session-manager.ts`）。

问题出在**事件驱动的 turn**：当 commander 自己 spawn 的 agent 跑完、发出 `[Agent Event: Task Completed]`，EventBus 订阅者会在后台把这条事件作为消息注入 chat（`handleSessionTaskCompleted → enqueueOrSend → sendMessage`），唤醒 commander。此时 commander 可能**在无人在场的情况下**自动调用 `sendToAgentSession`/`spawnAgentSession` 继续推进——形成"事件→外发→再被事件唤醒"的自激链，且：

- 事件正文（agent 最终报告、executor 输出）是**半可信**内容，存在把 commander 带偏的注入面；
- 用户不在回路里，无法在外发前介入纠偏。

> 注：browser 事件这条路已在 `sendMessage` 里被摘掉全部工具（`isBrowserEvent ? {} : createTools()`），到不了本设计的工具，无需额外处理。

## 2. 目标与非目标

**目标**：在**事件驱动的 turn**里，commander 对 agent 的外发动作（spawn / sendTo）必须经过用户**批准/拒绝**后才真正执行；用户敲字发起的 turn 不受任何影响。

**非目标 / YAGNI**：

- 不做"编辑草稿再发"。已查实 AI SDK v6 与 v7 的 HITL 均为**批准/拒绝**两态，`ToolApprovalResponse` 仅 `{ type, approvalId, approved, reason? }`，`reason` 是给模型的文字反馈、不能覆盖工具 input。编辑能力无论版本都需自定义，故先不做；措辞不对走"拒绝 + 反馈让模型重拟"。
- 不做批量草稿 UI。阻塞/暂停天然逐个处理（见 §6）。
- 不升级到 v7（v6 的 `needsApproval` 已满足，升级无收益且有迁移成本）。

## 3. 方案选型

采用 **AI SDK 原生 `needsApproval`（方案甲：纯批准/拒绝）**。

- 否决"在 `execute` 里手搓阻塞 promise"：会把 stream 挂住数分钟，与框架 HITL 设计相悖，abort/超时处理脆弱。
- 否决复用 `agent-types.ts` 的 `approval_request`：那套是给 agent 子进程的命令/文件审批设计的，语义与本场景不符。

`needsApproval` 的机制：模型调用工具时 SDK **不立即执行 `execute`**，而是发出 `tool-approval-request` part 并在 step 边界暂停；待 `tool-approval-response` 追加进消息历史后 resume，`execute` 才运行。这是"暂停—续跑"，不是"挂住 stream"，更稳。

## 4. Provenance — 哪些 turn 触发审批

新增 per-turn 标志 `session.wokenByEvent`，在 `sendMessage` 内与 `eventDrivenTurn` **并列**设置：

```
session.wokenByEvent = isSystemEventMessage(content);
```

**关键：不能复用 `eventDrivenTurn`**。`eventDrivenTurn` 被重载用于 orchestrator dot 上色，且 chat-initiated 的 agent 完成会显式传 `eventDriven=false`（`handleSessionTaskCompleted` 里的 `!isChatInitiated`）。而 chat-initiated 完成正是我们最想拦的自激链——它的 `eventDrivenTurn=false` 却应当 `wokenByEvent=true`。两者必须分开。

| 触发来源 | 内容 | `eventDrivenTurn` | `wokenByEvent` | 是否审批 |
|---|---|---|---|---|
| 用户敲字 | 普通消息 | false | false | 否 |
| commander spawn 的 agent 跑完 | `[Agent Event…]` | false（画 dot） | **true** | **是** |
| agent 窗口里用户起的 agent 跑完 | `[Agent Event…]` | true | true | 是 |
| executor 结束 | `[Executor Event…]` | true | true | 是 |

`wokenByEvent` 基于内容前缀判定，fail-safe：极端情况下误判也只是多弹一次确认，不会漏放。

## 5. 实现

### 5.1 后端：工具接线（`chat-session-manager.ts`）

`createTools` 每轮在 `sendMessage` 内重建（在 `wokenByEvent` 确定之后），故可按当轮 provenance 设置：

```ts
spawnAgentSession: tool({
  ...,
  needsApproval: session.wokenByEvent,   // 当轮布尔；false 时行为与今天完全一致
  execute: async ({ prompt, agentType }) => { /* 仅批准后运行 */ },
})
// sendToAgentSession 同理
```

`createTools` 需要拿到当轮的 `wokenByEvent`（通过传参或读 `this.sessions.get(sessionId)`）。

### 5.2 后端：fullStream 处理 + resume

现 `fullStream` 循环只处理 `text-delta`/`tool-call`/`tool-result`。新增：

1. **`tool-approval-request` 分支**：push 一条交互 entry（携带 `approvalId`、`toolName`、`input`、目标 branch），`broadcastPatch` 给全体 subscriber；记录到 `session.pendingApprovals: Map<approvalId, …>`。
2. **捕获 resume 所需的消息**：保存本次 stream 的 `result.response.messages`（SDK 自带的 assistant + tool-call 消息）。**resume 不能用现有"只保留 user/assistant 文本"的历史重建（`messages` 数组构造处）**，否则 SDK 无法把 tool-call 与 approval-response 配对。
3. **resume 流程**：收到决定后，以 `[...savedResponseMessages, { role: 'tool', content: [{ type: 'tool-approval-response', approvalId, approved, reason? }]}]` 为基础调起新的 streamText（resume 变体）。批准 → `execute` 运行、续跑；拒绝 → `output-denied`，模型据此重拟。

### 5.3 后端：WS 入站决定通道

chat WS 新增入站类型：

```ts
{ toolApproval: { approvalId: string; approved: boolean } }
```

处理器：校验 `approvalId` 存在于 `session.pendingApprovals`；**幂等 first-wins**（已解析则 no-op，见 §6）；解析并触发 §5.2 的 resume。鉴权沿用现有 chat session ownership（与 message/stream 同一套）。

### 5.4 前端：审批卡片

Main Chat 会话流新增审批卡片组件（参考 `ask-user-question.tsx` / `exit-plan-mode.tsx` 模式）：

- 展示：动作类型（新建 / 追发）、目标 branch、**待发消息原文**；
- 两个按钮：Approve / Deny → 经 WS 发 `{ toolApproval }`；
- 已决议后按钮消失（沿用 `messageIndex`"下一条是否已响应"判定），并随后端 patch 显示 `output-available` / `output-denied`。

## 6. 边界情况

- **页面未打开**：事件驱动 turn 由后端 EventBus 触发，与客户端是否连接无关。turn 跑到审批点后**在后台暂停**等待决定；消息不外发、agent 不推进（fail-safe 安全属性）。客户端稍后连接时，`use-agent-session` 重放历史补出 pending 卡片，再批不迟。
- **服务器重启**：pending 暂停是 in-memory in-flight stream，**重启会丢失**。后果仍 fail-safe（消息从未发出），但 pending 卡片丢失、该 turn 需重新触发。本期不持久化，仅在文档与 UI 上明确（可后续作 self-heal 增量）。
- **并发决定**：卡片广播给全体 subscriber（同一 owner 的多标签/多设备）。多客户端可能近乎同时点击 → 对同一 `approvalId` **幂等 first-wins**：首条 response 解析，后续 no-op；其余客户端收到决议态 patch。
- **一轮多审批**：`stopWhen: stepCountIs(3)`，一轮内最多约 3 步，可能产生多个审批请求。逐个批/拒，数量有界，无需批量 UI。
- **turn abort / session 关闭**：清理 `session.pendingApprovals` 对应条目，丢弃未决审批。
- **watchdog**：现有"零 tool 调用即注入 correction"的不变量检查（fullStream 后）须把 `tool-approval-request` 步**计为有效工具步**，避免暂停轮被误判触发 correction。

## 7. 安全收益

- 闸门后端强制：客户端缺席/伪造/改前端都无法绕过审批外发。
- 直接收窄事件驱动自激链与半可信事件内容的注入面（用户在外发前必经一道人工确认）。
- 与既有部署模型一致：solo 单用户多设备共享卡片；`--auth` 下 chat session 按 owner 鉴权，跨租户订阅不进来。

## 8. 改动清单（概览）

- `packages/vibedeckx/src/chat-session-manager.ts`
  - `sendMessage`：设置 `session.wokenByEvent`
  - `createTools` / 两个工具：`needsApproval: session.wokenByEvent`
  - `fullStream`：新增 `tool-approval-request` 处理 + 保存 `response.messages` + resume 路径
  - WS 入站：`{ toolApproval }` 处理 + `pendingApprovals` 状态 + 幂等 first-wins + abort/close 清理
  - watchdog：approval 步计为有效工具步
- `RunningSession` 类型：新增 `wokenByEvent`、`pendingApprovals`
- chat WS 路由：放行/转发 `{ toolApproval }` 入站消息
- 前端：审批卡片组件 + 会话 hook 对新交互 part 的渲染与 WS 发送
