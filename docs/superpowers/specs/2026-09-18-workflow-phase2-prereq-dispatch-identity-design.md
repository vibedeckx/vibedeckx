# Phase 2 前置：投递幂等与投递身份（dispatch identity）

> 日期：2026-09-18 · 分支：dev1 · 状态：**设计稿，待用户确认后出实施计划**
> 上游：主 spec [`2026-07-17-workflow-engine-review-loop-design.md`](./2026-07-17-workflow-engine-review-loop-design.md)
> §3.2b / §6 "Phase 2 的前置"。本文只做前置，不做循环模板、不解析 verdict、不动 UI。
> 所有 file:line 以 main = dev1 @ f769b6cd 为准。

---

## 0. 目标与非目标

Phase 2 的循环要让引擎**自动派发**下一跳（reviewer 完成 → 回投 implementer →
implementer 完成 → 再派 reviewer……每跳仍经人工闸门确认）。今天的引擎只在
"一个 reviewer、一次 turn"上成立，缺两样东西：

1. **投递幂等**：引擎发出的每条指令，崩溃/重试后不会重复投递，也不会静默丢失。
2. **投递身份**：session 跨轮复用、用户穿插自己的消息时，一条 `taskCompleted`
   仍能被归到"是哪次派发触发的"，而不是靠"这个 session 是 reviewer 且状态是
   waiting_reviewer"这种整 session 粒度的猜测。

非目标：
- 不追求 stdin 层的数学 exactly-once。provider 没有带 ID 的 ACK，
  `2026-08-31-prepared-agent-session-lifecycle-design.md` §3.2 / §14.1 的结论不变：
  **稳定键消灭 HTTP 重试造成的重复，消灭不了 stdin 层的重复**。语义是
  "诚实的 at-least-once + 永不把未发的报成已发"。
- 不改 UI 的 `/message` 协议；前端照旧不带键。
- 不引入循环状态机、verdict 解析、`commands.kind`。

---

## 1. 投递幂等：原语已存在，补覆盖

### 1.1 现状（2026-07-31 已落地，主 spec 之前漏记）

`POST /api/agent-sessions/:id/message` 已接受可选 `idempotencyKey`
（`routes/agent-session-routes.ts:1598-1621`，1..512 字符），背后是持久账本
`agent_instruction_deliveries`（`storage/sqlite.ts:454-466`）：

```
PK (session_id, idempotency_key), content_hash, status ∈ {pending, sent},
claim_token, owner_token, lease_expires_at
```

`claim` / `markSent` / `renewClaim` / `release`（`storage/repositories/agent-sessions.ts:1301-1364`）：
同键同内容 → 复放 `{replayed:true}`；同键异内容 → 409 conflict；他人持有活租约
→ 409 busy；租约过期可接管；`sent` 为终态。哈希取用户原文 `rawContent` 而非
拼上 grant 块的送达文本（`:1852-1856`）。worker 自 **v0.3.1** 起支持。

### 1.2 缺口

| # | 缺口 | 位置 |
|---|---|---|
| A | 引擎三处发送不带键，靠"发送失败则 CAS 回滚"当去重 | `workflow-engine.ts:970, 1267, 1321` |
| B | hub 的远程分支纯透传，传输层歧义（`status:0` network_error/timeout）时返回 502 且**什么都不记**——worker 可能已写 stdin | `agent-session-routes.ts:1712-1729`、`utils/remote-proxy.ts:40-65`（无重试） |
| C | dormant 唤醒路径在 stdin 写入前就返回 `true`（`setTimeout(…,500)` 火后不管），且丢掉 `opts.onUserEntryPersisted` | `agent-session-manager.ts:4116, 4176-4187`、`:2920-2926` |
| D | 旧 worker（<0.3.1）收到键会静默忽略，返回和首投一样的 `200 {success:true}`；注册表表达不了 body 字段 | `reverse-connect-capabilities.ts:63`（路由自 0.2.0） |
| E | 没有 pending 行清扫器；崩溃后无人复放的键成孤儿 | 仅靠 session 级联删除 |
| F | project-chat 本地目标丢弃了传入的键 | `plugins/shared-services.ts:210-216` |

### 1.3 决定

**D1 抽出共享投递助手。** 新模块 `instruction-delivery.ts`：
`deliverInstruction({ storage, sessionId, idempotencyKey, rawContent, claimToken, deliver })`
→ `"delivered" | "replayed" | "conflict" | "busy" | "not_running" | "unconfirmed"`。
把路由 `:1848-1902` 的 claim/renew/心跳/markSent/release 块原样搬进去，路由改为
调用它（对外行为、状态码、测试 `agent-session-idempotency-routes.test.ts` 不变）。
内部调用方（引擎、project-chat 本地 = 缺口 F）同样走它。`serializeInstructionDelivery`
与 `instructionContentHash` 随之迁入。

**D2 引擎每次发送都带键，键 = 投递身份。** `AgentOps.sendUserMessage` 的 `opts`
增加 `idempotencyKey?` 与 `dispatch?`（§2）。键格式 `run:<runId>:step:<stepId>`，
一次派发一把键；内容哈希 = 送出的 prompt。fresh reviewer 的首条指令走 lifecycle
`activateReviewer`，**沿用其 `activationKey = review:<runId>`**，不在路由层再造
第二套 claim（lifecycle spec §6.2 禁止并行 claim 集）；步骤行记录的键即该
activationKey。

**D3 唤醒路径改为等到 stdin 写完再返回。** `wakeDormantSession` 把 500ms 延迟
写入包成 Promise 并 `await`，写失败返回 `false`；同时把 `origin` /
`notificationDisposition` / `onUserEntryPersisted` / `dispatch` 完整转发到唤醒
时的 `pushEntry`。这顺带修好 lifecycle 在"prepared 后休眠再激活"场景丢失
`onUserEntryPersisted` 的问题。
影响评估：`sendUserMessage` 的调用方本就在 `deliver()` 里等完 spawn（秒级），多等
500ms 的延迟写入不触及任何超时；投递账本租约 30s、心跳 10s（`:1874`），
lifecycle 激活租约同理，都远大于该窗口。

**D4 hub 远程分支记录自身结果（可拆分任务）。** 在 `proxyAuto` 前先在 hub 的
账本按 `(localSessionId, key)` claim；`ok` → `markSent`；语义拒绝（status>0）→
`release`；传输歧义（status 0）→ 保留 `pending` 行让租约自然过期，返回
`errorCode: "delivery_uncertain"` 而非平 502。仅当 `remoteServers.worker_version ≥
INSTRUCTION_IDEMPOTENCY_MIN_WORKER_VERSION = "0.3.1"` 时才保留 pending（旧 worker
不会去重，保留只会把重复变成卡死）——照抄 `remote-executor-starts.ts:84-90, 165-170`
的门控模式。不需要新注册表条目（路由已存在），`MIN_WORKER_VERSION` 不动。
注：Phase 2 的引擎跑在 worker 上、发送全是本地，D4 对循环不是硬依赖；它修的是
UI / project-chat / commander 经 hub 发消息时"传输歧义 = 什么都不记"这一既有洞。

**D5 pending 清扫只做引擎自己的。** 引擎在 `init()` 对账 `workflow_run_steps`
（§2.5）即覆盖引擎发出的所有键；通用清扫器不做（无消费者）。

**D6 文档措辞。** 账本的 `sent` 含义是"stdin 写入已被本进程确认"，不是"CLI 已消费"；
`markSent` 失败返回 503 后客户端重试会再投一次（`:1888-1893`）。一律写 at-least-once。

---

## 2. 投递身份：`workflow_run_steps` + entry 上的 `dispatch` 字段

### 2.1 为什么两处都放

- **表是真相源**：引擎在发送**之前**落行，崩溃后有据可对账；claim 用 CAS。
- **entry 上带副本**用于重启后的几何判定：内存映射没了，但 transcript 仍说得出
  "这个 turn 是哪条指令开的"。这是 `event?: {...}` 字段的既有先例
  （`agent-types.ts:53`，commander 用它记"哪个 session/turn 唤醒了我"）。
  entry 是无 schema 的 JSON blob，存储、WS patch、远程 patch 缓存、restore、
  branch 复制全部原样透传（`session-history-reader.ts:85-90`、`conversation-patch.ts:26`、
  `remote-patch-cache.ts:99`），前端类型更窄会忽略未知字段，零成本。

### 2.2 表

```sql
CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id               TEXT PRIMARY KEY,            -- dispatch id (UUID)
  run_id           TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  round            INTEGER NOT NULL,            -- 从 1 起；同一 run 内单调
  role             TEXT NOT NULL,               -- 'source' | 'reviewer'（现有词汇；Phase 2 可加）
  kind             TEXT NOT NULL,               -- 'reviewer_prompt' | 'rereview_prompt' | 'final_verdict' | 'feedback'
  session_id       TEXT NOT NULL,               -- 无 FK：步骤行须活过 session 删除（同 workflow_runs / notification_outbox 理由）
  idempotency_key  TEXT NOT NULL,               -- run:<runId>:step:<id>，或 activationKey
  status           TEXT NOT NULL,               -- 'dispatched' | 'claimed' | 'abandoned'
  user_entry_index INTEGER,                     -- 发送回调写入；null = 从未落 entry
  turn_end_index   INTEGER,                     -- claim 时写入
  output_snapshot  TEXT,                        -- claim 时写入（该 turn 最后一条 assistant 原文）
  error            TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_open ON workflow_run_steps(session_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run   ON workflow_run_steps(run_id, round);
```

按 `storage/sqlite.ts:2056-2067` 的幂等 `PRAGMA table_info` 模式与
`schema.ts:583-613` / `repositories/workflow-runs.ts` 的三文件模式落地。增长率：
每 run 数行到数十行（`docs/state-storage-and-migration.md` 规则 3 要求在表头注释说明）。

仓库方法：`create`, `getById`, `getOpenBySession(sessionId)`（status=dispatched），
`listByRun(runId)`, `setUserEntryIndex(id, idx)`（CAS status=dispatched），
`claim({ id, turnEndIndex, outputSnapshot })`（CAS `status='dispatched'` → `claimed`，
返回 bool），`abandon(id, error)`（CAS dispatched → abandoned）。

### 2.3 entry 字段

`AgentMessage` user 变体新增：

```ts
dispatch?: { id: string; runId: string; round: number }
```

`FirstSendOptions`（`agent-session-manager.ts:430-439`）增加 `dispatch?`，
`sendUserMessageClaimed`（`:2963-2972`）与唤醒路径（`:4165-4171`）把它写进
user entry；`ActivateAgentSessionInput`（`agent-session-lifecycle.ts:180-198`）
增加 `dispatch?` 并在 `:705-720` 转发给 `runtime.sendUserMessage`；`AgentOps.sendUserMessage`
增加 `opts.dispatch?` 与 `opts.onUserEntryPersisted?`。

### 2.4 发送时序（引擎侧，四个发送点统一）

```
1. step = steps.create({ id: uuid, run_id, round, role, kind, session_id, idempotency_key, status: dispatched })
2. 发送（activateReviewer 或 deliverInstruction→sendUserMessage），opts = { …TURN, dispatch: {id, runId, round},
   onUserEntryPersisted: idx => steps.setUserEntryIndex(step.id, idx) }
3. 结果：
   delivered / replayed / activated → 保持 dispatched，等 claim
   not_running / conflict / busy / 抛错 → 先 steps.abandon(step.id, reason)，再做现有的 run 状态回滚（不变）；
   两者都是 CAS，顺序只影响证据先落
   unconfirmed（markSent 失败）→ 保持 dispatched（entry 已落，下一步 claim 仍能对上）
```

激活路径的例外：lifecycle 已占用 `onUserEntryPersisted` 写 `activation_user_entry_index`
（`agent-session-lifecycle.ts:708-717`），引擎不叠第二个回调，而是在 `activateReviewer`
返回 `activated | replayed | uncertain` 后读 `ActivationResult.view.userEntryIndex`
（即 session 行的 `activation_user_entry_index`）回填步骤行。

四个发送点：fresh reviewer 激活（`:1152-1157`，键 = activationKey，kind
`reviewer_prompt`）、复用 reviewer（`:970`，`rereview_prompt`）、终稿请求
（`:1321`，`final_verdict`）、反馈回投 source（`:1267`，`feedback`）。
`round` 取该 run 当前最大 round，reviewer 侧派发 +1；`feedback` 与其对应的
reviewer 步骤同 round。

### 2.5 归属判定（claim）

新引擎方法 `claimDispatch({ sessionId, turnEndEntryIndex }) → WorkflowRunStep | null`，
由 `ChatSessionManager.handleSessionTaskCompleted` 在现有抑制检查
（`chat-session-manager.ts:438`）之后**直接 await 调用**——不能做成第二个总线
订阅者：引擎的总线 handler 是 `void` 异步派发（`workflow-engine.ts:548-552`），
其结论对 chat handler 不同步可见。

```
entries = getRawMessages(sessionId); boundary = event.turnEndEntryIndex ?? extractLatestTurnEndIndex(entries)
open = steps.getOpenBySession(sessionId)
         .filter(s => s.user_entry_index != null && s.user_entry_index < boundary)
   // 过滤掉尚未落 entry 的步骤，以及 entry 落在本次 turn_end 之后的步骤：一条在派发
   // 之前就结束的 turn（陈旧 completion 与派发赛跑）绝不能被第 3 步的"唯一 open 步骤"误领
if open.length == 0 → null（用户自己的 turn，照旧交 commander）

1. opening = findTurnOpeningUserEntry(entries, boundary)   // notification-milestones.ts:44：上一个 turn_end 之后最早的 user entry
   if opening?.dispatch && open 中有同 id → CAS claim → 返回
2. if !opening（排队消息：user entry 落在上一个 turn_end 之前，本 turn 无 user entry）
   latest = findLatestUserEntry(entries)                     // :86，穿越边界向回扫
   if latest?.dispatch && open 中有同 id → CAS claim → 返回      // 必须要求 open 匹配，否则排在派发之后的用户消息会抢 claim
3. if open.length == 1 → CAS claim（error 记 "attributed by sole open step"）
4. open.length > 1 且无法判定 → 不 claim，返回 null 并 console.warn；run 保持原状（人工可见：panel 显示"可能错过完成事件"路径同今天）
```

claim 成功后写 `turn_end_index` 与 `output_snapshot = extractLastAssistantInTurn(entries, boundary)`
（保持今天的取法：向回扫到第一条 user entry 为止取最后一条 assistant；用户穿插
steering 时取的是穿插后的尾巴——这是 reviewer 看过用户话之后的最终意见，作为
交付物是对的）。

**claim 的 session 作用域**：`branchSession` 原样复制 entries（含 `dispatch`），
分支出的 transcript 会带着别的 session 的 dispatch id；查找永远先按
`session_id` 取 open 步骤再比 id，绝不按 id 单独查。

### 2.6 `handleTaskCompleted` 改为步骤驱动

```
step = claimDispatch(...)
if !step:
   legacy fallback（本次发布保留一版）：participants.role === reviewer && run.status === waiting_reviewer → 今天的逻辑（覆盖升级前创建的、无步骤行的 run）
   否则 return
按 step.kind 路由：
   reviewer_prompt / rereview_prompt / final_verdict → 今天的 waiting_reviewer→waiting_feedback（feedback_snapshot = step.output_snapshot，review_ready 里程碑 id 不变）
   feedback（source 完成）→ 只记证据，不改 run 状态（run 早已 completed；Phase 2 在此处接循环）
```

`feedback` 步骤的 claim **不抑制 commander**：source 的完成今天就是用户面事件
（run 已 completed、参与者已被 `untrackRun` 移除），claim 只是留证据，
`handleSessionTaskCompleted` 照旧继续唤醒 commander。Phase 2 让引擎接管这一跳时
再把"已 claim 的 feedback 步骤"加入抑制条件。

抑制规则**不变**：`shouldSuppressAgentEvent` 仍是"该 session 是活跃 run 的
reviewer"（整 session），因为 `discussing` 期间 reviewer 的闲聊 turn 也不该唤醒
commander；claim 结果是它的补充而非替代。

### 2.7 `init()` 对账（重启后没有 completion 事件可等）

`repairInterruptedTurn`（`agent-session-manager.ts:4256-4370`）会补一条
`turn_end{outcome: server_restart}` 但**不发** `session:taskCompleted`，所以
对账是必需的，不是可选的。对每条 `status=dispatched` 的步骤：

| 情况 | 处理 |
|---|---|
| `user_entry_index` 为 null | 发送从未落 entry → `abandon("never persisted")`；run 侧沿用今天 `init()` 的回滚/提示 |
| entry 之后存在 `turn_end` 且 `outcome ∉ {server_restart}` | 迟到归属：现在 claim 并走 2.6 的同一 handler |
| entry 之后的 `turn_end` 是 `server_restart` | `abandon("turn interrupted by restart")`；run 保持今天的 "可能错过完成事件" 提示 |
| entry 之后没有 `turn_end` | session 仍在跑（或进程死了但尚未 repair）→ 保持 dispatched，等 completion |

### 2.8 远程

引擎在 worker 上，发送全部本地；hub 只经 `taskCompletedEventFromRemoteFrame`
拿到 `turnEndEntryIndex`，**帧格式不变**，无新 worker 路由 → 注册表无新条目。
`dispatch` 字段随 entry JSON 原样穿过 patch 缓存，hub 若要展示可读。
`turn_snapshots` 仍只有本地 session 有；远程步骤的 per-step scope 为 null，与今天一致。

---

## 3. 兼容与迁移

- 新表、新可选字段、新可选 opts：全部加法。旧 hub / 旧 worker 看到未知 entry
  字段直接忽略。
- 升级前已存在的活跃 run 没有步骤行：2.6 的 legacy fallback 覆盖一个发布周期，
  之后删除。
- D4 的 hub 侧门控用 `worker_version ≥ 0.3.1`；`MIN_WORKER_VERSION` 不动。
- 两端同一二进制；D3（唤醒路径）与 §2 在 worker 侧生效，需发 worker。

---

## 4. 明确不做 / 留给 Phase 2 本体

- 循环状态机、`pending_gate`、`round` 上限、verdict 解析——Phase 2。
- `feedback` 步骤 claim 后驱动下一跳——Phase 2（本文只留下钩子：source 完成
  已能被归到具体派发）。
- `GET /api/workflow-runs/:id` 返回 steps——等 panel 需要展示轮次时再加（加法）。
- 通用 pending 清扫器；stdin ACK。
- 2.5 第 4 步"多个 open 步骤无法判定"的 UI 呈现——今天不会出现（一个 session
  同时最多一个 open 步骤：引擎在上一步 claim 或 abandon 前不会再派）；Phase 2
  若引入并发派发再做。

---

## 5. 测试

- `instruction-delivery.test.ts`：六种结果；路由既有幂等测试零改动通过。
- `agent-session-manager` 唤醒路径：`sendUserMessage` 在 stdin 写完后才 resolve；
  写失败返回 false；`onUserEntryPersisted` 与 `dispatch` 落到 entry。
- `workflow-run-steps` 仓库：CAS 语义（claim 二次返回 false、abandon 不覆盖 claimed）。
- 引擎 claim 几何：正常 turn；用户 steering 穿插（earliest wins）；排队消息导致
  本 turn 无 user entry；排在派发之后的用户消息不抢 claim；分支出的 transcript
  带外来 dispatch id 不误 claim；多 open 步骤返回 null。
- `init()` 对账四种情况。
- `handleTaskCompleted` 步骤驱动 + legacy fallback。
- 真机 e2e（本地 + 双服务器）：讨论轮次中用户穿插消息后终稿仍正确归属；
  派发后 kill -9 重启，步骤被 abandon、run 提示与今天一致；同键重放返回 replayed。

---

## 6. 实施顺序（每步可独立合入）

| # | 任务 | 范围 |
|---|---|---|
| T1 | 抽出 `deliverInstruction` 助手，路由与 project-chat 本地改用（缺口 A 的地基、F） | hub+worker，无行为变化 |
| T2 | 唤醒路径 await stdin + 转发 opts（D3） | worker |
| T3 | 存储：`workflow_run_steps` + 仓库 + `AgentMessage.dispatch` + `FirstSendOptions.dispatch` + lifecycle 转发 | worker |
| T4 | 引擎四个发送点落步骤行、带键、回填 `user_entry_index`（2.4） | worker |
| T5 | `claimDispatch` + 步骤驱动 `handleTaskCompleted` + legacy fallback + ChatSessionManager 直接调用（2.5/2.6） | worker |
| T6 | `init()` 对账（2.7） | worker |
| T7 | hub 远程分支记录结果 + 版本门控（D4，可拆） | hub |
| T8 | 真机 e2e + 主 spec §3.1/§3.2/§6 同步 | — |

T1–T6 是 Phase 2 的硬前置；T7 独立。
