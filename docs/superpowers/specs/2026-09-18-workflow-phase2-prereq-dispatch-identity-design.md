# Phase 2 前置：投递幂等与投递身份（dispatch identity）

> 日期：2026-09-18 · 分支：dev1 · 状态：**设计稿 v2，待用户确认后出实施计划**
> v2 吸收了一轮外部审阅（Codex）：去掉“唯一 open 步骤”猜测、派发只对空闲 session、
> 重试复用步骤与键、claim 与 run 迁移同事务、对账只认 `completed` 结局、claim 单一调用方、T7 暂缓。
> v2.1（第二轮审阅）：结果未知时 run 不回滚、仍接收身份匹配的完成；空闲检查与发送在
> session 互斥锁内原子完成；改稿后的重试不得沿用原键。
> 上游：主 spec [`2026-07-17-workflow-engine-review-loop-design.md`](./2026-07-17-workflow-engine-review-loop-design.md)
> §3.2b / §6 "Phase 2 的前置"。本文只做前置，不做循环模板、不解析 verdict、不动 UI。
> 所有 file:line 以 main = dev1 @ f769b6cd 为准。

---

## 0. 目标与非目标

Phase 2 的循环要让引擎**自动派发**下一跳（reviewer 完成 → 回投 implementer →
implementer 完成 → 再派 reviewer……每跳仍经人工闸门确认）。今天的引擎只在
"一个 reviewer、一次 turn"上成立，缺两样东西：

1. **投递幂等**：引擎发出的每条指令，HTTP/进程级重试不会重复投递，也不会静默丢失；
   stdin 层仍是 at-least-once（见非目标）。
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

**D3 唤醒路径改为等到 stdin 写完再返回。** 术语：账本与助手所说的“delivered”
= **运行时已接受**（user entry 已持久化，且 stdin 写入已返回或 provider 已缓冲，
如 Codex 线程未起前的缓冲分支 `:2983-2996`），不是 CLI 已消费；两者都不是 ACK。 `wakeDormantSession` 把 500ms 延迟
写入包成 Promise 并 `await`，写失败返回 `false`；同时把 `origin` /
`notificationDisposition` / `onUserEntryPersisted` / `dispatch` 完整转发到唤醒
时的 `pushEntry`。这顺带修好 lifecycle 在"prepared 后休眠再激活"场景丢失
`onUserEntryPersisted` 的问题。
影响评估：`sendUserMessage` 的调用方本就在 `deliver()` 里等完 spawn（秒级），多等
500ms 的延迟写入不触及任何超时；投递账本租约 30s、心跳 10s（`:1874`），
lifecycle 激活租约同理，都远大于该窗口。

**D4 hub 远程分支记录自身结果——本轮暂缓。** 在 `proxyAuto` 前先在 hub 的
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

**前提：引擎只向空闲 session 派发，且空闲检查与发送在同一把锁内。** 用户的 `/message`
路由在 `serializeSessionMutation(sessionId)` 下投递（`agent-session-routes.ts:82-95, 1833`）；
引擎的 `deliverInstruction` 走同一把每 session 互斥锁，并在锁内**重新检查**
`status !== "running"`，不满足则不发送、返回 `session-busy`（证明无副作用）。
只在发送前查一次空闲是不够的：用户的讨论消息可能在检查与发送之间抢先落地，
派发就会被 CLI 排到运行中的 turn 之后，讨论回复先完成时无法与派发区分。
（`requestFinalVerdict` 今天的前置检查 `:1312-1315` 保留为快速失败；`approveFeedback`
与复用路径补同样的前置检查。引擎在发送前做的 run 状态 CAS 若因用户消息触发的
`handleExternalUserMessage` 而被推回 `discussing`，引擎的回滚 CAS 落空即可，无害。）空闲时派发的 user entry 必然
自己开一个 turn，归属判定才能只靠“开 turn 的 entry”一条规则（2.5）；mid-turn
steering 与 CLI 排队两种歧义形态由此被排除在引擎派发之外（用户自己 mid-turn
发消息不受影响，那不是派发）。

**步骤 = 一次逻辑派发，重试复用。** 步骤 id 与键在一次逻辑派发内固定：同一
run 的同一 `(kind, round)` 只有一行，并记录 payload 的内容哈希；用户重试（再点
approve / 再点生成终稿）复用原步骤、原键、原 payload，让账本判断是复放（已 sent
→ 不重投）还是重投（已 released）。只有新的逻辑派发（下一轮终稿请求、下一轮
反馈）才新建步骤。**改稿不是重试**：若存在结果未知的 `feedback` 步骤而用户带着
不同内容再次 approve，返回 409 `bad-state`“上一次投递结果未知，请先重试原文或结束
review”——既不能偷偷沿用原键发新内容，也不能忽略修改继续发旧内容。为此
`requestFinalVerdict` 除 `discussing` 外也接受“`waiting_reviewer` 且存在结果未知的
`final_verdict` 步骤”作为重试入口；panel 在 run.error 标记未知时显示“重试投递”
（最小前端改动，见 T5）。

```
1. step = steps.getOrCreate({ run_id, kind, round }) → 已存在则复用 id/key/payload，否则
   create({ id: uuid, role, session_id, idempotency_key: run:<runId>:step:<id>, status: dispatched })
2. 目标 session 若 running → 409 session-busy（不发送，步骤保持 dispatched 或刚创建）
3. 发送（activateReviewer 或 deliverInstruction→sendUserMessage），opts = { …TURN, dispatch: {id, runId, round},
   onUserEntryPersisted: idx => steps.setUserEntryIndex(step.id, idx) }
4. 结果分三类：
   已接受   delivered / replayed / activated → 保持 dispatched，等 claim
   证明无副作用 not_running（entry 落库前拒绝）/ conflict / lifecycle retryable_failure
              → steps.abandon(step.id, reason)，再做现有的 run 状态回滚；下次重试重建同 (kind, round) 步骤
   结果未知 busy / 抛错 / unconfirmed（markSent 失败）/ lifecycle uncertain
              → 步骤保持 dispatched，error = "投递结果未知"；**run 不回滚**，停在派发后的等待态
                （reviewer 侧 kind → waiting_reviewer；feedback → 退回 waiting_feedback，因 completed
                须以发送确认为据），run.error 提示“投递结果未知：若目标已收到，其完成会自动归属；
                否则请重试（复用同一条指令）或结束”。没收到发送确认不等于没有发送——若随后
                收到身份匹配的完成事件，走 2.5/2.6 正常归属，真实结果不会因回滚而被拒收。
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

### 2.5 归属判定（claim）——单一调用方、严格匹配

**只有 WorkflowEngine 领取。** 它已是 `session:taskCompleted` 的订阅者
（`workflow-engine.ts:548-552`），claim 在其 `handleTaskCompleted` 内完成；
`ChatSessionManager` 本轮**不改**（保持 `:438` 的整 session 抑制），避免两处争抢
同一个 CAS。commander 行为不变，所以这层耦合本轮没有必要。

```
entries = getRawMessages(sessionId); boundary = event.turnEndEntryIndex ?? extractLatestTurnEndIndex(entries)
opening = findTurnOpeningUserEntry(entries, boundary)   // notification-milestones.ts:44：上一个 turn_end 之后最早的 user entry
if !opening?.dispatch → null
step = steps.getById(opening.dispatch.id)
if !step || step.session_id !== sessionId || step.status !== "dispatched" → null
→ 进入 2.6 的事务性 claim
```

去掉的两条规则及原因：
- “本 turn 无 user entry 时看最新 user entry”——派发只对空闲 session（2.4），
  派发 entry 必开 turn，这条规则失去场景。
- “只剩一个 open 步骤就领”——`user_entry_index < boundary` 只证明消息已记录，
  不证明 CLI 已处理它；指令在上一轮运行期间入队时，上一轮的完成也满足该条件，
  会被误领。**宁可不领**：步骤保持 dispatched，run 不动；无法归属的情况通过
  `run.error` 提示“收到 reviewer 完成事件但无法确认归属，请打开其窗口查看”
  （`console.warn` 不会出现在面板上）。

**legacy fallback 只对没有任何步骤行的旧 run**（升级前创建）：此时才退回
`participants.role === reviewer && status === waiting_reviewer` 的旧规则；
有步骤行但 claim 失败的事件一律不接收。保留一个发布周期后删除。

**claim 的 session 作用域**：`branchSession` 原样复制 entries（含 `dispatch`），
分支出的 transcript 会带着别的 session 的 dispatch id；`step.session_id !== sessionId`
的检查就是为此，绝不按 id 单独信任。

### 2.6 步骤驱动的 `handleTaskCompleted`：claim、run 迁移、outbox 同一事务

先把步骤改成 `claimed` 再推进 run，中间崩溃则重启只扫 `dispatched`，这次完成
永久漏处理。因此三件事必须一个事务：

```
workflowRuns.claimStepAndTransition({
  stepId, expectStepStatus: "dispatched", turnEndIndex, outputSnapshot,
  runId, from, to, patch, outbox?                       // 扩展 transitionWithOutbox（types.ts:2045）的模式
}) → boolean   // 任一 CAS 不成立则整体不写，不发通知
```

按 `step.kind` 路由：
- `reviewer_prompt / rereview_prompt / final_verdict` → 今天的
  `waiting_reviewer → waiting_feedback`，`feedback_snapshot = outputSnapshot`
  （= `extractLastAssistantInTurn(entries, boundary)`，取法不变），`review_ready`
  里程碑 id 不变，全部在上面一个事务里。
- `feedback`（source 完成）→ 只 claim 步骤（记 `turn_end_index` / `output_snapshot`），
  不改 run（run 早已 completed；Phase 2 在此接循环）。

`feedback` 步骤的 claim **不抑制 commander**：source 的完成今天就是用户面事件
（run 已 completed、参与者已被 `untrackRun` 移除），`ChatSessionManager` 照旧唤醒
commander。Phase 2 让引擎接管这一跳时再把“已 claim 的 feedback 步骤”加入抑制条件。

### 2.7 `init()` 对账（重启后没有 completion 事件可等）

`repairInterruptedTurn`（`agent-session-manager.ts:4256-4370`）会补一条
`turn_end{outcome: server_restart}` 但**不发** `session:taskCompleted`，所以
对账是必需的。对每条 `status=dispatched` 的步骤，先**定位派发 entry**，再**判定
其后的 turn 结局**，判定与实时路径用同一套校验（2.5 的 opening 匹配）：

1. 定位：`user_entry_index` 非空则用之；为空**不等于没落 entry**（entry 持久化
   与回填之间可能崩溃；激活路径是返回后才回填）——先按 `dispatch.id` 扫 transcript，
   激活步骤再查 session 行的 `activation_user_entry_index`；三者皆无 → `abandon("never persisted")`，
   run 侧沿用今天 `init()` 的回滚/提示。
2. 结局：从 entry 往后找第一个 `turn_end`：
   - 不存在 → session 仍在跑或尚未 repair → 保持 dispatched，等实时 completion；
   - `outcome ∈ {completed, completed_with_pending_tasks}` 且 2.5 的 opening 匹配 →
     现在走 2.6 的同一事务（迟到归属）；
   - 其他结局（`failed`、`server_restart`、stopped 等）→ `abandon("turn ended: <outcome>")`；
     run 保持今天的“可能错过完成事件”提示，由用户决定重试或结束。

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
- 引擎 claim：正常 turn；**陈旧完成事件**（派发 entry 落在上一轮运行期间，上一轮
  的 completion 不得被领）；用户 mid-turn 穿插后派发 entry 仍是开 turn 的 entry；
  分支出的 transcript 带外来 dispatch id 不误 claim；目标 running 时 409 不派发。
- 同键重试：首投已 sent → replayed 不重投；首投 released → 重投一次；结果未知路径
  保持 dispatched 并复用键；结果未知后改稿 approve → 409。
- 结果未知后真实完成到达：run 仍在等待态，身份匹配 → 正常进入 waiting_feedback。
- 竞争：空闲检查通过后、发送前用户消息抢先 → 锁内重检 → session-busy，不发送；
  讨论回复的完成不被领。
- 崩溃窗口：entry 落库后、回填前崩溃 → 对账按 dispatch.id 找回；claim 后、run 迁移前
  不存在独立崩溃窗口（同事务）。
- `init()` 对账：定位三来源；结局 completed / failed / server_restart / 无 turn_end。
- `handleTaskCompleted` 步骤驱动 + legacy fallback。
- 真机 e2e（本地 + 双服务器）：讨论轮次中用户穿插消息后终稿仍正确归属；
  派发后 kill -9 重启，步骤被 abandon、run 提示与今天一致；同键重放返回 replayed。

---

## 6. 实施顺序（每步可独立合入）

| # | 任务 | 范围 |
|---|---|---|
| T1 | 抽出 `deliverInstruction` 助手，路由与 project-chat 本地改用（缺口 A 的地基、F）；`serializeSessionMutation` 目前是路由插件内的闭包（`agent-session-routes.ts:82`），须一并提到共享模块供引擎复用 | hub+worker，无行为变化 |
| T2 | 唤醒路径 await stdin + 转发 opts（D3） | worker |
| T3 | 存储：`workflow_run_steps` + 仓库 + `AgentMessage.dispatch` + `FirstSendOptions.dispatch` + lifecycle 转发 | worker |
| T4 | 引擎四个发送点落步骤行、带键、回填 `user_entry_index`（2.4） | worker |
| T5 | 步骤驱动 `handleTaskCompleted`（事务性 claim）+ legacy fallback + 结果未知的重试入口 + panel“重试投递”按钮（2.5/2.6） | worker + 前端 |
| T6 | `init()` 对账（2.7） | worker |
| T7 | hub 远程分支记录结果 + 版本门控（D4）——**暂缓，单独立项** | hub |
| T8 | 真机 e2e + 主 spec §3.1/§3.2/§6 同步 | — |

T1–T6 是 Phase 2 的硬前置；T7 暂缓。
