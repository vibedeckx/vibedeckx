# Prepared Agent Session 生命周期设计

> 状态：**提案，待实现**（2026-08-31；同日经两轮评审裁剪，见 §14.6）  
> 目标：把“建立 session 身份”和“启动 agent 并接受第一条指令”拆开建模，消除
> create-then-send 产生的空 session，同时不把两阶段协议复杂度扩散给所有调用方。  
> 排期前提：**Phase 1+ 是开放多用户前的前置项**，不以观测数据为闸门——后果已能从
> 代码推出（§14.5），单用户阶段测不出频率，多用户后频率线性放大、resident 驱逐的
> 副作用超线性放大。Phase 0 的日志用于多用户后看实际频率和 Phase 1 落地后的验证（§12）。

---

## 1. 决策摘要

新增一个深模块 `AgentSessionLifecycleService`，成为所有“新建 session 并发送第一条
指令”流程的唯一入口。模块对外提供两层接口：

```ts
// 普通调用方：一个操作完成创建、启动和首发。
start(input: StartAgentSessionInput): Promise<ActiveAgentSession>

// 只有激活前必须先拿到稳定 session ID 的调用方使用。
prepare(input: PrepareAgentSessionInput): Promise<PreparedAgentSession>
activate(input: ActivateAgentSessionInput): Promise<ActivationResult>
cancel(input: CancelPreparedSessionInput): Promise<CancelResult>
```

核心语义：

- `pending_first_turn` 只有持久化身份和 workspace binding；**不 spawn、不占 resident、
  不进普通 sidebar/search/alive 列表**。
- `activate` 在服务端统一执行容量检查、spawn、首条用户消息投递和 active 发布。
- `start` 是 `prepare + activate` 的服务端便利操作；普通 UI、Commander 和 Project
  Chat 不需要理解 pending 状态。
- 相同 operation/activation key 的网络重试复用同一个 session，不重新生成 ID，
  不重复创建进程或逻辑指令。
- 持久化的生命周期结果只有四种：`pending_first_turn`、`active`、
  `activation_uncertain`、`expired`。“正在激活”不是持久化状态，由 session 行上的
  activation lease 表达（§5.1）。
- `activation_uncertain` 和 `expired` tombstone **不可裁剪**：前者是 provider 没有
  投递 ACK 时唯一诚实的崩溃恢复结果（§8.3），后者是同 operation key 迟到重放不重建
  session、cancel 重试能返回 410 的唯一依据（§8.1、§11）。
- 不建独立 activation 表、不加 `GET /lifecycle` 路由：activation 字段并入
  `agent_sessions`（§6.2），lifecycle 视图由 `activate` 的 replay 响应携带（§9.1）。
- pending/expired 行的物理清理由现有 session maintenance sweep 顺带完成，不新增一个
  独立的高频 reconciler；正确性不依赖物理删除是否及时。cancel/timeout 只写
  tombstone，**不立即物理删除**。
- 现有 `discard-if-empty` / `deleteIfEmpty` 是迁移期补偿。所有调用方和最低 worker
  版本迁移完成后删除。

这项改造会改变 UI 内部的创建协议，但正常用户体验不变：点击发送后仍进入运行态；
fresh review 在真正激活前只显示 workflow 的“Preparing review…”，不会先出现一个蓝色
`New Session`。

---

## 2. 背景

### 2.1 当前生命周期把两个事实混在了一起

今天 `createNewSession` 同时做了：

```text
写 agent_sessions 行
→ 绑定 checkout / 记录 snapshot
→ 放入 AgentSessionManager
→ spawn CLI 进程
```

第一条指令由后续独立调用完成：

```text
createNewSession(...)
→ 准备 paste / 翻译 / review prompt
→ sendUserMessage(sessionId, firstInstruction)
```

因此“session 已经存在”和“session 已经开始被用户使用”之间有一个真实窗口。只要调用方
在这个窗口消失或失败，系统就可能留下标题为空、没有用户消息、进程仍存活的 session。

### 2.2 已经观察到的事故

现场 session `039e75d0-...` 的证据链是：worker/hub 已正常确认创建，但浏览器随后切换
workspace，没有继续投递首条消息；23 秒后用户再次发送，创建了另一个正常 session。
review 本身只是在刷新 alive sessions 时把旧空 session 暴露到了 sidebar。

现有修复已经封住这条高频 UI race：创建成功后，即使 workspace 已切换，仍用捕获的
session ID 投递原消息；上传、翻译或首发失败时尝试 `discard-if-empty`。Commander 和
Project Chat 也会检查首发结果并清理空 session。

这些修复有必要，但属于补偿式协议，无法覆盖所有窗口。

### 2.3 补偿式协议仍然存在的边界

客户端或调用方补偿天然覆盖不到：

- worker 完成创建后，浏览器在 HTTP 响应返回前关闭、刷新、断网或休眠；
- 服务端已经创建并 spawn，随后在返回调用方前出错；调用方拿不到可清理的 ID；
- 首发失败的根因也是网络故障，紧随其后的清理请求同样可能失败；
- 旧 remote worker 不支持 `discard-if-empty`；
- review prepare、Commander 或其他服务端 producer 自己也可能 create 后没有完成 send。

周期扫描“超过 N 分钟且零消息的 session”能收垃圾，但它只能猜测业务语义：reviewer
可能有意处于 prepare，系统 entry 也可能使真正的空业务 session 逃出零 entry 条件。
更重要的是，它把正确性依赖放在时间阈值和后台定时器上。

根本问题不是缺一个更聪明的清理器，而是 session 生命周期没有表达“第一条指令尚未
激活”。

---

## 3. 目标与非目标

### 3.1 目标

1. 第一条用户指令被接受前，不启动 CLI 进程、不占 resident 名额。
2. pending 身份不会伪装成普通 active session，也不进入普通列表投影。
3. 浏览器、Hub 或网络响应丢失后，重试同一 operation 不创建第二个 session。
4. 普通 UI、Commander、Project Chat、fresh review、本地和 remote 共享同一套规则。
5. resident limit 在真正 activation 时检查；prepare 本身永远不驱逐现有进程。
6. 失败和崩溃恢复语义诚实，不把无法确认的外部副作用宣称为 exactly-once。
7. 不新增一个专用于孤儿 session 的常驻定时器。

### 3.2 非目标

- 不改变已有 active session 的后续 `/message` 协议。
- 不把 workflow 状态机并入 lifecycle service；workflow 仍拥有 review 控制流。
- 不保证 CLI stdin 层面的数学意义 exactly-once。现有 provider 没有携带 activation ID
  的端到端 ACK。
- 不要求数据库里永远不存在过期 pending 行。它们只需不可见、无进程、不占容量并可被
  确定清理。
- 不在第一阶段删除现有 `/new`、`discard-if-empty` 或旧 worker fallback。

---

## 4. 方案比较

### 4.1 方案 A：继续扩展 `discard-if-empty`

优点是改动小；缺点是补偿依赖原请求方仍存活、仍有网络、仍知道准确 session ID。它不能
闭合“服务端已提交、响应未返回”的窗口，也无法统一 review/remote 的恢复语义。

结论：保留为迁移期保护，不作为长期模型。

### 4.2 方案 B：所有调用方都直接使用 `prepare/activate/cancel`

可以表达完整生命周期，但会让普通文本首发、Commander、Project Chat 都自己持有
pending、activation key、取消和重试规则。协议正确性会再次分散到调用方。

结论：不采用。

### 4.3 方案 C：深生命周期模块 + 两层入口（推荐）

普通调用方只使用 `start()`；只有在 activation 前确实需要 execution-target ID 的流程
使用显式 `prepare/activate/cancel`。两层入口最终进入同一个 service 和同一份持久化状态
机。

这兼顾了：

- common case 简单；
- paste / review 等特殊流程可控；
- 本地和远程实现只有一套不变量；
- 以后能完整移除基于“是否为空”的猜测式清理。

---

## 5. 领域模型

### 5.1 生命周期与运行时状态分离

`agent_sessions.status = running | stopped | error` 继续描述 agent runtime。
新增 `lifecycle_state` 描述 session 是否已经接受第一条指令：

```text
                              cancel / TTL / owner failed
pending_first_turn --------------------------------------> expired
       |                                                  (tombstone)
       | activate(activationKey, content)
       | = 在 pending 行上 CAS 写入 activation lease
       v
  [pending_first_turn + live lease]        （非持久化状态，仅 lease 字段）
       |  确认首发成功
       +-----------------------------------------------> active
       |
       |  能证明尚未发生投递副作用的可重试失败
       +---------------------------------> pending_first_turn（清 lease）
       |
       |  无法确认 stdin 是否已经收到
       +-----------------------------------------------> activation_uncertain
```

持久化的 `lifecycle_state` 只有四个值。原提案的 `activating` 枚举被裁掉：它和
`pending_first_turn` 的区别只在于“是否有人持有 lease”，用 `activation_lease_*`
字段表达即可，少一个需要在恢复逻辑里单独处理的状态。

`activation_uncertain` 不是普通空 session：它表达“用户意图已持久化，但外部投递结果
无法证明”，必须显示明确告警，且不能自动重发。这个状态**不能用两态模型替代**——
现有代码在两条首发路径上都是先持久化 user entry 再写 stdin
（`sendUserMessageClaimed`：`agent-session-manager.ts` pushEntry → provider stdin；
dormant wake：spawn → pushEntry → 延迟后 stdin），崩溃落在 entry 已落库、stdin 未写
的窗口时，回 pending 重试可能重复投递，判 active 则把从未送达的任务宣称成功。
没有 provider ACK 正是需要这个结果的原因，而不是省掉它的理由。

### 5.2 状态不变量

| lifecycle state | DB identity | manager/runtime | 普通 sidebar/search/alive | resident | 可执行操作 |
|---|---:|---:|---:|---:|---|
| `pending_first_turn`（无 lease） | 有 | 无 | 否 | 否 | activate / cancel |
| `pending_first_turn`（live lease） | 有 | 最多一个 | 否 | activation 时计入 | 同 key replay（202）/ cancel（CAS 竞争） |
| `active` | 有 | 按 runtime status | 是 | 按现有规则 | 普通 message / stop / restart |
| `activation_uncertain` | 有 | 可能有 | 是，带告警标记 | 若进程在则计入 | inspect / 明确处置；**禁止自动重投** |
| `expired`（tombstone） | 有，replay 窗口后 GC | 无 | 否 | 否 | 同 key replay → 410 |

`activation_uncertain` 的投影不必是独立的 sidebar 分区：它走 active 投影，但行上带
“首次指令投递结果未知”的告警标记，且必须可见、可处置，不能藏。

只有 lifecycle service 可以改变上述状态。route、Commander、Project Chat 和
WorkflowEngine 不再直接组合 `createNewSession + sendUserMessage`。

### 5.3 Purpose 与 owner

`purpose` 表达业务来源，而不是让客户端任意控制展示：

```ts
type SessionPurpose =
  | "interactive"
  | "interactive_upload"
  | "commander"
  | "project_chat"
  | "workflow_review";
```

可选 owner：

```ts
type SessionOwner =
  | { kind: "workflow_run"; id: string }
  | { kind: "project_chat_operation"; id: string }
  | { kind: "commander_request"; id: string };
```

purpose 策略由服务端注册表决定，例如 TTL、是否允许 owner 投影、取消权限。外部请求不能
提交任意 visibility。

---

## 6. 持久化设计

### 6.1 `agent_sessions` 増列

```text
-- 生命周期
lifecycle_state              pending_first_turn | active |
                             activation_uncertain | expired
purpose                      interactive | interactive_upload | commander |
                             project_chat | workflow_review
owner_kind                   nullable
owner_id                     nullable
prepare_operation_id         稳定 operation key（prepare/start 幂等用）
pending_expires_at           nullable epoch ms
activated_at                 nullable epoch ms
expired_reason               nullable（cancelled | ttl | owner_failed | ...）
expired_at                   nullable epoch ms（tombstone GC 依据）

-- activation（原提案独立表的字段，并入 session 行；见 §6.2）
activation_key               nullable，stable idempotency key
activation_content_hash      nullable，检测同 key 不同内容
activation_content_json      nullable，崩溃恢复所需的首条指令快照
activation_lease_owner       nullable
activation_lease_expires_at  nullable epoch ms
activation_attempt           integer default 0
activation_user_entry_index  nullable
activation_error_code        nullable
```

迁移时所有旧行设为 `active`，因此现有历史不会被隐藏。

选择在 `agent_sessions` 上显式建模，而不是建立一套与 session 完全分离的 preparation
身份，原因是 pending 已经拥有稳定 session ID、workspace checkout、remote mapping、
paste namespace 和 workflow 引用。把它放到另一张身份表会在 activation 时引入一次身份
搬迁，并把 remote/paste 权限判断拆成两套。

为避免 lifecycle filter 散落到所有查询中，repository 必须提供语义化入口：

```ts
listActiveByProject(...)
getLatestActiveByBranch(...)
listResidentActive(...)
getLifecycleById(...)       // 仅 lifecycle service / owner 使用
```

普通列表、search cache、notification watch 和 branch activity 只能调用 active-scoped
repository；不得由调用方临时拼 `lifecycle_state = 'active'`。

### 6.2 activation 字段并入 `agent_sessions`（不建独立表）

原提案的 `agent_session_activations` 表被裁掉，字段并入 session 行（§6.1 第二组）。
理由：一个 session 只有一次首发 activation，一对一的表只是多一次 join 和一处事务
边界；把 key / hash / payload / lease / outcome 放在同一行上，§8.1 的 claim CAS 可以在
单条 UPDATE 里完成。原表的 `state` 列不再需要——它的取值被 `lifecycle_state` +
lease 是否存活 + `activation_error_code` 覆盖。

**不能裁的是字段语义**：`activation_key`、`activation_content_hash`、
`activation_content_json`、lease、`activation_user_entry_index` 都必须存在。没有
hash 就判定不了“同 key 不同内容 → 409”；没有 payload 就无法在崩溃后重放；没有
`user_entry_index` 就无法在 recover 时区分“entry 已写、stdin 未证”的 uncertain 窗口。

首条指令内容只保留到 activation 进入可终结状态并超过幂等 replay 窗口；之后可以清除
`activation_content_json`，保留 hash 和 outcome。

现有 `agent_instruction_deliveries` 只提供 hash/claim/lease 原语，没有 payload、
attempt、outcome 和 uncertain 结果，**不是** activation 记录的等价物；它继续服务
active session 的普通后续消息。首发 activation 可以复用其 claim 规则，但必须由
lifecycle service 统一决定状态，不能在 route 中再并行维护第二套 claim。

---

## 7. 深模块接口

```ts
interface AgentSessionLifecycleService {
  start(input: StartAgentSessionInput): Promise<ActiveAgentSession>;
  prepare(input: PrepareAgentSessionInput): Promise<PreparedAgentSession>;
  activate(input: ActivateAgentSessionInput): Promise<ActivationResult>;
  cancel(input: CancelPreparedSessionInput): Promise<CancelResult>;
  getState(sessionId: string): Promise<SessionLifecycleView>;   // 服务内部 / owner 使用，不单独暴露 HTTP
  recover(): Promise<RecoverySummary>;
}
```

普通入口：

```ts
interface StartAgentSessionInput {
  operationId: string;       // 调用方生成，所有网络重试保持稳定
  sessionId: string;         // 可由 service 从 operationId 派生或由调用方预分配
  projectId: string;
  branch: string | null;
  permissionMode: "plan" | "edit";
  agentType: AgentType;
  model?: string | null;
  instruction: string | ContentPart[];
  purpose: "interactive" | "commander" | "project_chat";
  force?: boolean;
}
```

特殊入口：

```ts
interface PrepareAgentSessionInput {
  operationId: string;
  sessionId: string;
  projectId: string;
  branch: string | null;
  permissionMode: "plan" | "edit";
  agentType: AgentType;
  model?: string | null;
  purpose: "interactive_upload" | "workflow_review";
  owner?: SessionOwner;
  startSnapshot?: SnapshotState;
}

interface ActivateAgentSessionInput {
  sessionId: string;
  activationKey: string;
  instruction: string | ContentPart[];
  force?: boolean;
  origin?: "user" | "workflow";
  notificationDisposition?: NotificationDisposition;
}
```

模块内部依赖 ports：

- lifecycle/activation repositories；
- workspace binding 与 project authorization resolver；
- resident capacity gate；
- runtime factory（现有 `AgentSessionManager` 的拆分适配层）；
- remote lifecycle adapter；
- session/search/event/notification publisher。

依赖方向固定为：

```text
UI routes / Commander / Project Chat / WorkflowEngine
                         |
                         v
             AgentSessionLifecycleService
                         |
                         v
 repository + capacity + runtime + remote + projections
```

Lifecycle service 不依赖 WorkflowEngine；workflow 通过 owner 和返回值协调自己的 run。

---

## 8. Activation 协议

### 8.1 幂等 claim

1. 单条 UPDATE 内校验 session 仍为 `pending_first_turn` 且无存活 lease，写
   activation key、content hash、payload 和 lease；`lifecycle_state` 保持
   `pending_first_turn`（没有 `activating` 枚举，见 §5.1）。
2. 相同 key + 相同 hash：
   - 已 `active`：直接 replay 原成功结果（200）；
   - 已 `activation_uncertain`：**返回 uncertain 本身**（200 + uncertain 视图），
     禁止借 replay 自动重投；
   - lease 未过期：返回 `202`；
   - lease 已过期且能证明没有投递副作用（无 user entry）：允许新 owner 接管。
3. 相同 key + 不同 hash：`409 idempotency_conflict`。
4. 不同 key 激活同一个 pending：`409 activation_conflict`。
5. 已 expired（tombstone）：`410 preparation_expired`。
6. `prepare` 自身按 `prepare_operation_id` 幂等：同 operation 重放返回同一行；
   命中 tombstone 返回 410，**不得重新创建**——这是 tombstone 不能立即物理删除的原因。

lease 只防止两个服务请求并发拥有 activation；它不是 session TTL。长 spawn 期间需要续租。

**evidence 行的硬规则**（实现时的评审修正）：`activation_user_entry_index` 一旦写入，
该行只能走向 `active` 或 `activation_uncertain`——`claimActivation`、`expirePending`、
TTL sweep 都以 `activation_user_entry_index IS NULL` 为前提；对带 evidence 且 lease 已失效
的 pending 行，cancel 会把它标成 `activation_uncertain`（`lease_lost_after_entry`）而不是
tombstone。写 evidence 的 CAS 本身是 stdin 前的最后一道门：CAS 失败（lease 已被 cancel /
另一次 claim 拿走）→ 抛 `ActivationLeaseLostError`，runtime 中止发送并 drop，返回
expired / activation_conflict；发送前的检查也同时验证 lease 未过期。evidence CAS 本身
同时校验 owner **和** `activation_lease_expires_at > now`（lease 在 pushEntry 的 await 中
过期也会被拒）；TTL sweep 的最终 UPDATE 重复 `activation_user_entry_index IS NULL`
条件，封住 SELECT 与 UPDATE 之间写入 evidence 的窗口。evidence CAS 被拒时 user entry
已经在 transcript 里，不能当作"干净可重试"——行若仍 pending 就转 `activation_uncertain`
（`lease_lost_after_entry`，runtime 保留供检视，禁止重投；同 key 再 claim 会 hydrate 出
孤儿 entry 并重复首发），行已 expired 则维持 tombstone。该 uncertain CAS 的返回值必须
检查：读取与 CAS 之间 cancel / TTL 仍能把无 evidence 的行转 expired，此时以行的真实终态
为准并 drop runtime，不得报 uncertain；若是同 key 的并发 activation 先完成，按 §8.1 第 2 条
同一分类返回（同 key 同 content → replayed / uncertain，不同 key → activation_conflict，
同 key 不同 content → idempotency_conflict），不能把自己已成功的操作报成 409。

第七轮评审修正（2026-09-01，全部已落代码）：

- **model 透传**：`hydratePendingSession` 必须把行上的 `model` 传给 `createNewSession`，
  否则 identity CAS 把选了模型的 pending 行判为 "already in use"，首发永远 `spawn_failed`。
- **entry 落库必须严格**：`persistEntry` 原本吞掉存储错误；首发路径（设置了
  `onUserEntryPersisted` 的 send）现在 strict——upsert 失败向上抛，stdin 不写，
  行干净回 pending（无 evidence、无 entry），同 key 可重试。否则"entry durable, then
  stdin"的证据契约是空的：session 会带着空 transcript 变 active，重启后不被恢复。
- **TTL 在 activate 时执行**：pending 行 `pending_expires_at` 已过时，activate 先
  `expirePending(reason: "ttl")` 再按终态返回 410——不能等 maintenance（6 小时一跳），
  否则挂起标签页重连能把 10 分钟前的 submission 在几小时后执行。
- **announce 移到 commit 之后**：commander 的 `session:status running` 不再在 spawn 时
  发（`announceRunning` 不再进 hydrate），改由 service 在 `completeActivation` 成功后调
  `runtime.announceSessionRunning`。spawn 即发布会把空 pending session 推进打开的窗口——
  正是本设计要消灭的 race。
- **commander 幂等锚不可自毁**：spawn 前清理 dormant 分支 session 时，若该行的
  `prepare_operation_id` 等于本次 toolCallId（重启后重放场景），保留它让 `start` 重放，
  不删——删了就会创建并投递第二个 session。
- **uncertain 的持久化展示**：崩溃恢复后的 `activation_uncertain` 行通过普通 history/
  find-existing API 重新打开，adopt 时的 toast 覆盖不到。session DTO 现携带
  `lifecycleState` / `activationErrorCode`（active 行不带），会话窗口对 uncertain 渲染
  常驻告警条，禁止当普通 session 用。第八轮补充：worker 的 path 版 find-existing
  （`POST /api/path/agent-sessions`）同样携带这两个字段——hub 的远程 find-existing
  代理对 session 对象整体透传（`mapRemoteSendBackFields` 保留未知字段），远程
  uncertain session 无显式 id 重开时告警才有来源。
- **commander 锚检查先于 busy 拒绝**（第八轮）：分支上已有 session 时，先查其
  `prepare_operation_id` 是否等于本次 toolCallId。相等则无论 dormant 还是 RUNNING 都
  交给 `start` 重放（丢响应重试拿到 `replayed`），不删不拒；只有异源 session 才走
  "already active" 拒绝或 dormant 清理。否则同 key 的活重放会被 busy 检查挡掉，
  幂等契约只覆盖重启一半。

`cancel` 与 `activate` 的竞争由同一行上的 CAS 决定：cancel 只在“`pending_first_turn`
且无存活 lease”时成功；持有 lease 的 activation 在 active CAS 前发现行已变 expired，则
停掉刚起的 runtime 并返回 410。

### 8.2 外部副作用顺序

```text
claim activation
→ 按稳定 session ID hydrate runtime 槽位（见下）
→ activation 时检查 resident capacity
→ 创建 runtime / spawn provider
→ 持久化首条 user entry（写 activation_user_entry_index）并尝试 provider send
→ 发布 active session 投影和 session:process 事件
→ activation accepted
```

**hydrate 是必需步骤，不能省**：现有 `restoreSessionsFromDb` 对零 entry 行直接跳过
（“stale metadata”），而 `sendUserMessage` 对不在 manager map 里的 session 立即返回
false。一个 prepare 后经历过 worker/hub 重启的 pending 行，在 activate 时不会在内存中。
lifecycle service 必须在 spawn 前用 DB 行按 ID 重建 RunningSession；不能假设 pending
session 还“活在” manager 里。

在 active 发布前，sidebar/search/notification 不得观察到该 session。容量不足返回
`resident_limit_reached`，session 回到或保持 `pending_first_turn`；用户完成 eviction/force
确认后用同一个 activation key 重试。

### 8.3 崩溃恢复的诚实边界

SQLite 事务不能覆盖 spawn 和 CLI stdin。当前 provider 也没有携带 activation ID 的 ACK，
所以只能保证 HTTP/network replay 不重复，不能同时承诺崩溃后“绝不丢且绝不重复”。

启动恢复规则（按 `lifecycle_state` + lease + `activation_user_entry_index` 判定）：

- `pending_first_turn` 带 lease 且没有 user entry：停止可能残留的 runtime，清 lease，
  回到无 lease 的 pending，可安全重试；
- 已出现 assistant/native activity：证明 agent 已开始，补成 `active`；
- 只有 user entry（`activation_user_entry_index` 已写），崩溃点可能位于 stdin write
  前后：转 `activation_uncertain`，保留 session 和进程证据，绝不自动重发；
- `pending_first_turn` 无 lease：继续等待同 operation 重试或过期；
- `expired`：等待物理 GC。

未来 provider 若能 ACK activation ID，才把 uncertain 自动解析或安全重投。

---

## 9. HTTP 与远程协议

### 9.1 Hub/UI API

```http
POST   /api/projects/:projectId/agent-sessions/start
POST   /api/projects/:projectId/agent-sessions/prepare
POST   /api/agent-sessions/:sessionId/activate
DELETE /api/agent-sessions/:sessionId/preparation
```

原提案的 `GET /lifecycle` 被裁掉：调用方需要的“现在是什么状态”永远发生在一次
activate 重放之后，所以 `activate` 的每种响应都携带 `SessionLifecycleView`
（state、lease 是否存活、uncertain 证据、tombstone 原因）。`DELETE /preparation`
同样幂等：命中 tombstone 返回 `410` + 视图，而不是 404。

建议响应：

- `201`：本次刚创建/激活；
- `200`：同 key 成功 replay，**或** replay 命中 `activation_uncertain`（body 里的
  state 区分两者；客户端对 uncertain 必须展示告警而不是当成功）；
- `202`：activation 正在进行（lease 存活）；
- `409`：幂等内容冲突、另一个 activation 或 resident limit；
- `410`：prepared session 已取消/过期（tombstone）；
- `422`：workspace/configuration 永久不可用。

**现状事实**：UI 今天调用的 project-based `/api/projects/:projectId/agent-sessions/new`
Body 类型没有 `sessionId`，服务端自己 `randomUUID()`；带身份 CAS 和 dormant 恢复的
exact-ID 路径只存在于 worker 的 path-based `/api/path/agent-sessions/new`。因此
“稳定 ID 重试”对 UI 而言不是把现有字段透传一下，而是要在 project route（本地分支 +
remote 代理分支）都实现 exact-ID replay。

### 9.2 Worker capabilities

新增 worker protocol capability：

```text
POST /api/path/agent-sessions/start
POST /api/path/agent-sessions/prepare
POST /api/agent-sessions/:param/activate
DELETE /api/agent-sessions/:param/preparation
```

远程 worker 是 runtime lifecycle 的权威；Hub 保存 stable local ID、remote ID、operation
key 和 durable intent：

1. Hub 在代理前持久化稳定 IDs/operation key；
2. worker prepare 后建立 pending mapping，但不写普通 search/sidebar projection；
3. Hub 用同一 activation key 调用 worker；
4. 响应丢失后用同一 activation key replay（响应自带 lifecycle 视图，含 uncertain /
   tombstone），禁止生成新 ID；
5. worker active 后 Hub 才启动 stream、notification watch 和 search cache 投影。

必须显式 capability-gate，不能把 404 当作协议探测。发布顺序：worker capability → Hub
adapter → 调用方迁移 → 提升最低 worker 版本 → 删除 fallback。

旧 worker 暂时走现有 `/new → /message → 必要时 discard-if-empty`，因此旧 worker 上不能
获得完整的“pending 不 spawn”保证。评审修正：`/message` 被 worker **明确拒绝**（非
409、非网络）时，adapter 立即 `discard-if-empty` 并撤销 mapping / intent（返回
`retryable_failure` + `state: expired`）；网络结果未知时保留身份供 replay。

---

## 10. 各调用方迁移

### 10.1 普通 UI

无 paste/预处理需求的首发：

```text
用户点击发送
→ 创建稳定 submission/operation ID
→ POST start（服务端 prepare + activate）
→ active 后写 session cache、更新 URL、连接 stream
```

用户切换 workspace、刷新或响应丢失时，原 submission 继续使用相同 operation ID；不得
重新生成 session ID。当前 origin workspace 的 UI 隔离逻辑仍保留，但不再承担服务端清理。

**现状事实**：submission identity 今天是 `agent-conversation.tsx` 里的
`Symbol("agent-submission")` 加 `use-agent-session.ts` 的 in-flight ref，硬刷新即丢。
要兑现“刷新后同 ID 重试”，pending submission（operation ID、session ID、目标
workspace、首条指令或其 hash）必须写到 `sessionStorage` 一类跨刷新存储，并在页面
恢复时先查询/重放再决定是否新建。这一项需要专门的测试（刷新中断 → 恢复 → 同 ID）。

含 paste 的首发：

```text
prepare(hidden)
→ 在目标执行机器上传 paste
→ 需要时翻译并 materialize content
→ activate
```

翻译本身不需要 session ID，应尽可能移到 prepare 前；预处理明确失败时调用 cancel。
浏览器消失时，剩下的只是不可见、无进程的 pending 行。

UI 可见变化仅有两点：

- session 在 activation 成功后才出现在普通 sidebar；
- `activation_uncertain` 显示明确的“首次指令投递结果未知”，不显示普通蓝色
  `New Session`。

### 10.2 Commander

`spawnAgentSession` 改为调用 `start()`：

```text
commander tool operation ID → operationId / stable sessionId
start(... first instruction ...)
→ 仅 active 后返回 success 并注册 completion wakeup
```

不再直接组合 create/send，也不会在 send 返回 false 时向 commander 报假成功。

### 10.3 Project Chat

同样使用 `start()`，复用已有 project-chat operation ID。operation replay 返回同一 active
session；不同 payload 复用 key 返回 409。

### 10.4 Review

fresh reviewer 使用显式两阶段：

```text
创建 workflow run(status=preparing)
→ prepare reviewer(purpose=workflow_review, owner=run)
→ 生成 intent brief / 冻结 review context
→ activate(reviewer prompt, activationKey=run-scoped key)
→ active 后 run CAS 到 waiting_reviewer
```

pending reviewer 不进入普通 sidebar；review UI 继续从 workflow run 显示
“Preparing review…”。prepare timeout/cancel 只把 pending 标为 expired，不再停止/删除一个
已经 spawn 的 reviewer。

**现状事实**（说明为什么“把 reviewer 建成 dormant”这种捷径不成立）：

- `armPrepareTimeout` 只调 `failRun`；`failRun` 和 `cancelRun` 都只做 workflow run 的
  状态 CAS + `untrackRun`，整个 `workflow-engine.ts` 没有任何 `deleteSession` /
  `discardSessionIfEmpty` 调用——prepare 终止路径今天根本不清理 reviewer；
- `dormant` 只是 `RunningSession` 的内存字段，DB 里就是普通 `stopped` 行，history /
  search / latest 投影没有任何过滤；
- 零 entry 行不被 `restoreSessionsFromDb` 恢复，重启后 `runActivation` 里的
  `sendUserMessage` 会直接返回 false。

所以 reviewer 的 pending 必须是持久化的 `lifecycle_state`，activation 必须走 §8.2 的
hydrate，timeout/cancel 必须经 lifecycle `cancel` 写 tombstone。

复用已有 reviewer 的 re-review 是 active session 的后续消息，继续走普通 `/message`，不走
首次 activation。

现有只放在内存中的 pending review prompt/context 需要在迁移时持久化到 workflow run 或
activation payload，否则 worker 重启后仍无法恢复。

---

## 11. 过期与物理清理

pending correctness 不依赖 GC：它没有进程、不可见、不占 resident。因此不新增
`setInterval(..., 10min)` 一类专用 reconciler。

物理清理策略：

1. prepare 写 `pending_expires_at`；owner cancel / TTL 只把行 CAS 到 `expired` 并写
   `expired_at`、`expired_reason`——**不立即物理删除**。这一行是 tombstone：同
   `prepare_operation_id` 的迟到重放和 cancel 的重试都靠它返回 410，删掉就会重建
   session 或分不清“已取消”和“从未存在”（§8.1 第 6 条）；
2. `AgentSessionLifecycleService.recover()` 在启动时按 §8.3 修复带 lease 的 pending，并
   批量过期超期 pending；
3. 现有 `SessionRetentionSweeper` 的既有 tick 在处理用户 retention 设置前，顺带删除一小批
   `expired_at` 已超过 replay 窗口的 tombstone；复用同一个 scheduler、single-flight 和
   时间预算。注意 retention 本身默认 OFF（`session-retention-config.ts`），tombstone GC
   必须**不受**该开关控制——它清的是协议垃圾，不是用户历史；
4. 删除使用 exact ID + lifecycle CAS（`expired` 且 `expired_at < now - window`），不使用
   title/entry count/年龄猜测；
5. activation replay 窗口结束前保留 outcome/hash，之后再物理删除 payload/expired row。

即使 maintenance 长时间没有运行，影响也只是少量 SQLite 行，不会再出现蓝色
`New Session`、常驻 agent 进程或 resident capacity 泄漏。

---

## 12. 分阶段实施计划

每一阶段独立可发布、可回滚；迁移期间旧协议继续工作。

### Phase 0：合同测试与观测基线

- 固化当前 direct UI fix、Commander、Project Chat 和 review 的回归场景；
- 为 create/首发/discard 记录 operation ID、session ID、purpose 和结果（创建成功但
  首发未到、discard 成功/失败/未送达 worker）；
- 明确 active/sidebar/resident/search 的查询基线，并用合同测试把所有读
  `agent_sessions` 的投影列出来（§14.2 的前置）；
- 不改变生产行为。

退出条件：能从日志区分 prepare、activation、replay、conflict 和 uncertain。

**实现状态（2026-09-01，已落代码，未发版）**：

- 日志：`session-lifecycle-log.ts`，每条一行 `[SessionLifecycle] event=… key=value`。
  事件：`created`（sessionId/projectId/branch/purpose/operationId/recovered）、
  `first_instruction_accepted`（msSinceCreated）、`first_instruction_rejected`
  （provider_rejected | send_threw）、`discard`（discarded | retained_*）、
  `discard_remote`（ok | worker_404 | network_error | timeout | http_N）、
  `boot_zero_entry_rows`（启动基线）。一个 `created` 在几分钟内没有对应的
  `first_instruction_accepted` 就是本设计要消灭的窗口。
- purpose / operationId 来源：UI → `interactive`（operationId 目前 UI 不发，路由已
  接受可选字段）；Commander → `commander` + tool call id；Project Chat →
  `project_chat` + idempotencyKey；fresh review → `workflow_review` + run id。
  hub 通过 path `/new` 的可选 body 字段把 purpose/operationId 转给 worker
  （additive，旧 worker 忽略）。
- 投影基线：`agent-sessions-projection-baseline.test.ts` 快照所有生产代码里的
  `agentSessions.<method>(` 调用点和 repository 方法面；Phase 1 加 `lifecycle_state`
  时这份快照的 diff 就是要收口的投影清单（§14.2）。
- 回归场景：d4bc8197 / 9afde867 已带 UI 跨 workspace 首发、Commander / Project Chat
  discard、`deleteIfEmpty` 的测试；review prepare 超时在 `workflow-engine.test.ts`。
  日志契约在 `agent-session-manager.lifecycle-log.test.ts`。
- 观测方法：`grep '\[SessionLifecycle\]' <log>`，按 sessionId 关联 created ↔
  first_instruction_accepted，缺配对的按 purpose 计数；`discard_remote` 里的
  `network_error`/`worker_404` 就是 §14.5 说的"活进程可能残留在 worker"的样本。

**Phase 0 不是决策闸门**（2026-09-01 修订）。最初的想法是用两周观测数据决定
Phase 1+ 是否排期，这站不住：

- 严重度不需要观测——后果链从代码就能推出（§14.5）：首发前 `ensureResidentCapacity`
  在 pool 满时 hibernate 别人正在用的 session，然后 spawn；首发不来时进程空转占位，
  只有 LRU 或重启能回收。最坏后果是“用户正在用的 session 被无故挤下线”。
- 频率在单用户阶段测不出——三个窗口（关标签页、永久断线、discard 丢包）都是低概率
  事件，两周零发生和不会发生是两回事；而它们都随 session 创建数线性放大，resident
  驱逐那一条还依赖 pool 满，是多用户 worker 共享 pool 时才会出现的超线性项。

所以 Phase 1+ 做不做是排期问题，不是数据问题：单用户阶段风险由用户自己承担、成本
近零，可以不做；**开放多用户之前必须做完**。Phase 0 的日志留在代码里的用途是
（a）多用户之后看实际频率与出问题的 purpose 分布，（b）Phase 1 落地后验证
`created` 无配对的样本确实清零。

### Phase 1：Schema 与本地 LifecycleService

- 为旧 `agent_sessions` 行迁移 `lifecycle_state=active`；
- 新增 §6.1 的 lifecycle 与 activation 列（不建独立表）；
- 实现 prepare/activate/cancel/getState/recover，含 §8.2 的按 ID hydrate；
- 从 `AgentSessionManager.createNewSession` 拆出 runtime factory/capacity port；
- repository 提供 active-scoped 查询，普通投影只见 active；
- 此阶段没有调用方切换。

退出条件：本地 service 的故障注入测试通过，pending 不会 spawn 或进入投影。

**实现状态（2026-09-01，已落代码，未发版）**：

- Schema：`agent_sessions` 增 §6.1 全部 17 列（`sqlite.ts` 迁移，默认 `active`）；
  `prepare_operation_id` 上部分唯一索引作 prepare 幂等锚点；`lifecycle_state` 复合索引
  给 recover/sweep。Phase 7 的 FK 重建改为"新 DDL 含 lifecycle 列 + 按旧表实际列 ∩ 新表列
  动态拷贝"，否则新库上 ALTER 出来的列会被重建吞掉（测试覆盖）。
- Repository（`storage/repositories/agent-sessions.ts`）：`visibleLifecycle` 片段收口到
  getAll / getByProjectId / getProjectedByProjectId / listByProject / listRecentByProject /
  listRecentActivityByProject / listAttentionByProject / listAttentionActivityByProject /
  countRunning* / getByBranch / listByBranch / getLatestByBranch / listIdsByProject /
  retentionPredicate；`deleteIfEmpty` 限 `active`。exact-id 读（`getById`、
  `getActivityById`）保持不过滤——路由 authz 和 service 靠它们。新增 CAS 方法：
  `createPending`、`getLifecycleById/ByPrepareOperationId`、`claimActivation`（pending +
  无活 lease + key 未设或相同）、`renew/releaseActivationLease`、
  `setActivationUserEntryIndex`、`completeActivation`、`markActivationUncertain`、
  `expirePending`（返回 expired | already_expired | lease_held | not_pending | not_found）、
  `expirePendingOlderThan`、`listPendingWithLease`、`deleteExpiredTombstones`、
  `clearActivationPayloads`。
- Service（`agent-session-lifecycle.ts`）：`start / prepare / activate / cancel / getState /
  recover / maintain`。activate 两遍读 + CAS；lease 30s、每 10s 续；结果联合类型直接对应
  §9.1 的 HTTP 码（activated=201、replayed/uncertain=200、in_progress=202、
  idempotency_conflict/activation_conflict/resident_limit=409、expired=410、
  retryable_failure=503、permanent_failure=422）。首发失败按"user entry 是否已落库"分
  retryable（回 pending、清 lease、保留 key）与 uncertain（保留 runtime 供检视）。
- Manager 适配（`agent-session-manager.ts`）：`prepareSessionRow`（只建行 + snapshot，
  不 spawn）、`hydratePendingSession`（走 `createNewSession` 的 stored-row 路径，
  `allowPending` 内部开关；其它调用方对非 active 行一律拒绝，legacy `/new` 无法复活
  tombstone 或越过 service 起 pending）、`dropRuntime`（杀进程、出 map、不写 system
  entry——pending 行必须保持零 entry）、`sendUserMessage` 的 `onUserEntryPersisted` 钩子
  （entry 落库后、stdin 写前）。
- 接线（`plugins/shared-services.ts`）：`recover()` 在 `restoreSessionsFromDb()` **之前**
  跑（否则被 recover 提升为可见的行不在 manager map 里）；`maintain()` 挂在
  `SessionRetentionSweeper` 的 tick 上、位于 retention 开关检查之前；
  `fastify.agentSessionLifecycle` 装饰。
- 测试：`agent-session-lifecycle.test.ts`（真 manager + SQLite：不可见性、幂等、replay、
  tombstone、TTL/GC、legacy 路径拒绝、recover+restore 顺序）、
  `agent-session-lifecycle.faults.test.ts`（§13.2 各边界脚本化注入：容量、spawn 失败、
  workspace 失效、entry 前/后失败、并发同 key 202、lease 过期后 cancel 赢、recover 三分支）、
  `storage/agent-sessions-lifecycle.test.ts`（CAS 语义、投影过滤、FK 重建保列）。
  投影基线快照随新增调用点更新。
- 本阶段没有调用方切换、没有 HTTP 路由；`fastify.agentSessionLifecycle` 已可供 Phase 2+
  使用。

### Phase 2：Worker 协议与 Hub adapter

- 增加 start/prepare/activate/cancel worker routes 和 capability keys；
- Hub durable intent 保存稳定 local/remote IDs 与 operation key；
- 实现响应丢失后的同 key replay/query；
- active 后才发布 remote mapping 的普通投影；
- 保留旧 worker fallback。

退出条件：Hub/worker 任一侧在 prepare/activate 各边界重启，都不会产生第二个 session。

**实现状态（2026-09-01，已落代码，未发版；隧道契约 additive，`since: 0.3.33`）**：

- Worker 路由（`routes/agent-session-lifecycle-routes.ts`，`server.ts` 注册）：
  `POST /api/path/agent-sessions/prepare|start`（`requireRawAuth`，pseudo-project 解析与
  legacy `/new` 同规则）、`POST /api/agent-sessions/:id/activate`、
  `DELETE /api/agent-sessions/:id/preparation`（`requireAuth`，本地行经
  `getActivityById` → project 授权）。响应统一 `{ kind, lifecycle, ... }`，状态码由
  `lifecycleHttpStatus(kind)` 给出；`toLifecycleResponse` 把 `resident_limit` 的
  max/runningSessions 一并带出。同一文件也提供 hub 的 project-based
  `prepare|start`，以及 by-id 两条路由按 `remote-` 前缀分派到本地 service 或远程适配器。
  path 路由接受全部 purpose（hub 已校验），project 路由只接受
  `interactive | interactive_upload`。
- Capability 注册表：四个新 key，快照已更新；hub 只以
  `http:POST /api/path/agent-sessions/prepare` 一个 key 门控，不用 404 探测。
- Hub 适配器（`remote-session-lifecycle.ts`，`RemoteSessionLifecycleAdapter`）：
  - durable intent 复用 `remote_session_creation_intents`，新增
    `prepare_operation_id`（部分唯一索引）与 `prepared_at`；`ensureIntent` 在任何 worker
    调用之前落行，同 operation 重放拿回同一对 local/remote id，配置不同 → 409。
    这类 intent **不进** `listPending`（启动回放只重放 legacy `/new` intent），
    过期由 hub 的 maintenance tick 用 `discardStaleLifecycleIntents`（7 天）清掉。
  - `start` 是单次 worker 往返（worker `/start`）；`prepare` + `activate` 两段式给
    上传/review 用。activate 前预注册 `remoteSessionMap` 并按 local id 铸
    cross-remote token；worker 报 `activated | replayed | uncertain` 才发布投影
    （`bindRemoteSessionMapping(from_start)` → confirm intent → notification watch →
    `searchCache.noteSessionCreated(status=running, lastUserMessageAt)` → stream →
    branch activity → 标题生成）；其它结果撤销预注册，不写任何投影。网络/超时 →
    `remote_unreachable`（502），intent 记 error，同 key 重试复用 id。
  - 旧 worker 兜底：prepare = `createRemoteAgentSession`（`/new`，会 spawn），
    activate = `/message`（idempotencyKey = activationKey），cancel =
    `discard-if-empty`；视图带 `legacy: true`、state 直接是 `active`。
- 视图扩展：`SessionLifecycleView.remoteSessionId`、`legacy`。
- 测试：`remote-session-lifecycle.test.ts`（intent 先于调用、丢响应复用 id、activate 预注册/
  铸 token/只在 activated 后发布、拒绝时撤销、start 单往返、cancel、legacy 三段）、
  `routes/agent-session-lifecycle-routes.test.ts`（分派、purpose 白名单、状态码映射、
  跨用户 404）。
- 已知边界：worker `start` 路由的 purpose 白名单为 `interactive | commander |
  project_chat`（`workflow_review` / `interactive_upload` 只走两段式）。

### Phase 3：普通 UI

- project-based route（本地 + remote 代理）实现 exact-ID replay（§9.1 现状事实）；
- 文本首发改用单次 `start()`；
- paste 首发改用 prepare/upload/activate；
- submission ID 跨超时、workspace switch、硬刷新和明确 retry 保持稳定（§10.1 的
  跨刷新持久化）；
- active 后才 cache/connect/select；
- legacy worker 仍走当前补偿路径。

退出条件：关标签页、硬刷新、断网、切 workspace、paste/翻译失败均不产生可见/占容量孤儿。

**实现状态（2026-09-01，已落代码，未发版）**：

- `lib/api.ts`：`startAgentSession` / `prepareAgentSession` / `activateAgentSession` /
  `cancelPreparedAgentSession`，响应统一 `{ kind, lifecycle, session? }`，只在
  activated / replayed / uncertain 时带 `session` 摘要（路由侧 `sessionSummary`）。
- `lib/pending-submissions.ts`：pending submission（operationId、sessionId、workspace、
  content）写 `sessionStorage`，每 workspace 一条；硬刷新后 `startSession` 的空分支先
  replay 同 key 再决定是否显示 placeholder。
- `hooks/use-agent-session.ts`：`startConversation`（纯文本单次 start）、
  `prepareConversation` → `uploadPaste` → `activateConversation`（含 paste / 超长文本）、
  `cancelPreparedConversation`（预处理失败）；resident-limit 弹窗用同 key + force 重试；
  传输失败保留 key 供下次发送；只有服务端说"session 已真实"才 cache / connect / select。
- `agent-conversation.tsx` 两条首发路径都改到上述 API；`ensureSession` /
  `sendEnsuredMessage` / `discardEnsuredSessionIfEmpty` 暂留（Phase 6 删）。
- 测试：`hooks/use-agent-session.lifecycle.test.tsx`、`lib/pending-submissions.test.ts`，
  以及 pending-model / permission-mode 组件测试改到新契约。
- 评审修正：placeholder（localStorage 持久化）曾把 auto-start 整个跳过，pending replay
  只在 `startSession` 内 → 刷新后永远不重放。现在 `stayingInPlaceholder` / auto-start 的
  placeholder 门都排除"有 pending content"的情况，且 replay 移到 `startSession` 取
  latest 之前（replay 优先于分支上的旧 session）；replay 失败时留在 placeholder。
  测试覆盖 placeholder + pending 跨刷新的成功与失败两条。

### Phase 4：Commander 与 Project Chat

- 两者改为 `start()`；
- 只有 activation 成功才返回 success、注册 wakeup 或持久化关联；
- 使用各自已有 operation identity 作为稳定 key；
- 删除它们自己的 create-then-send 补偿分支（旧 worker fallback 除外）。

退出条件：并发或网络 replay 只创建一个 session、发送一条逻辑首指令。

**实现状态（2026-09-01，已落代码，未发版）**：

- Commander（`chat-session-manager.ts` `spawnAgentSession`）：本地走
  `AgentSessionLifecycleService.start`，远程走 `RemoteSessionLifecycleAdapter.start`，
  key = tool call id，owner = `commander_request:<chat session>`；两者由
  `setSessionLifecycle` 注入。只有 activated / replayed 返回 `success: true`；
  `uncertain` 返回 `success: false` + sessionId + "先检查再决定"的说明，但仍注册
  completion wakeup（若 agent 真跑了，完成事件是 commander 唯一的证据）；其余 kind
  按 `describeSpawnFailure` 给出可操作的文案。create-then-send + discard 分支已删。
- Project Chat（`plugins/shared-services.ts` `createAgentSession`）：本地
  `start(operationId = idempotencyKey, sessionId = workerSessionId)`；远程
  `RemoteSessionLifecycleAdapter.start(localSessionId = sessionId,
  remoteSessionId = workerSessionId)`（adapter 新增可预分配 remote id）。非
  activated / replayed 一律 throw（含 uncertain）——调用方看到行仍在就把 operation
  留在 pending，之后同 key replay；`createRemoteProjectChatSessionWithInstruction`
  及其测试已删。
- 测试：`chat-session-manager.spawn-agent.test.ts` 重写为 lifecycle 契约（activated /
  rejected / uncertain / resident_limit / remote）；project-chat 三份测试通过
  `mutationServices` 接口不变而保持有效。

### Phase 5：Review

- fresh reviewer 改为真正的 pending reviewer，不在 prepare 时 spawn；
- review context/prompt 持久化；
- workflow run 持有 pending owner/ID，active 后才写正常 reviewer session 投影；
- timeout/cancel 走 lifecycle cancel；
- re-review 复用 active reviewer 的路径不变。

退出条件：review prepare 超时、取消和 worker 重启均不留下 0-entry reviewer 进程。

**实现状态（2026-09-01，已落代码，未发版；远程 review 需发 worker 才生效）**：

- `AgentOps` 接口改为 `prepareReviewer` / `activateReviewer` / `cancelReviewer`
  （直接透传 lifecycle service 的输入/结果类型）+ 原有 `sendUserMessage` 等；
  `shared-services.ts` 用 manager + lifecycle service 组装 `reviewAgentOps`。
- `prepareAdhocReview`：fresh reviewer = `prepare(operationId = run.id,
  owner = workflow_run:<run>, permissionMode = plan, startSnapshot)`，不 spawn、不进
  sidebar；prompt 输入（scope / taskContext / originalIntent / authorSelfReport）除内存外
  还写入新列 `workflow_runs.prepared_context`。
- `runActivation`：`activate(activationKey = review:<run.id>, instruction = prompt,
  origin = workflow, milestone-managed)`；activated / replayed → CAS 到
  waiting_reviewer；`uncertain` → 也进 waiting_reviewer 但带"投递结果未知"的 error 注记，
  不重发；`in_progress` → 原样返回（另一次 activation 持有 lease）；其余 → `failRun`。
  重启后优先用 `prepared_context` 重建 prompt，不再从可能已前进的 source 重算。
- `failRun`（仅从 preparing 失败时）/ `cancelRun`（仅 preparing）/ prepare 超时 → 
  `cancelReviewer(reason = owner_failed | cancelled)` 写 tombstone；active reviewer 返回
  `not_pending` 被忽略，re-review 路径不变。
- 远程：hub → worker `/api/path/workflow-runs/prepare|activate` 协议不变；worker 侧引擎
  实现以上行为。旧 worker 仍在 prepare 时 spawn（§9.2 末段）。评审修正：hub 的
  two-phase 分支原来在 prepare 返回后就发布 reviewer（mapping / search cache running /
  notification watch / stream / `session:process`），会把无 runtime 的 pending reviewer
  推进 sidebar 与 alive 投影；现在抽成 `publishRemoteReviewer`，two-phase 只在
  `activateRemoteReview` 拿到 worker 的 `waiting_reviewer` 后调用，单次式仍内联。
  第二轮评审补充：`createRemoteWorkflowReviewer({ phase: "prepare" })` 自身也不再写
  handle / mapping / title slot / notification watch。第三轮：creation intent 在 prepare
  阶段**保持 pending**，由 `publishRemoteReviewer` 在 two-phase 发布全部落地后才
  `confirm`——否则 worker 激活成功、hub 在写 mapping 前崩溃会留下一个找不到的活
  reviewer。恢复路径复用既有单次式 intent 回放（同 runId / reviewerId），worker 返回已
  激活的 run，front 此时才绑 mapping。已知代价：worker 在 hub distill 期间重连会触发
  回放并以无 brief 激活（降级为 tier-2 上下文），不是正确性问题。第四轮：mapping 只是
  发布的第一步，恢复路径见到匹配 mapping 时不再直接 confirm，而是先幂等补齐
  notification watch / title slot / handle，再关闭 intent（覆盖"mapping 已写、watch 前
  崩溃"）。
- 测试：`workflow-engine.test.ts` 改到新契约并新增：重启后按持久化 context 激活、
  uncertain 注记、超时/取消 tombstone、活 reviewer 不被 cancel。

### Phase 6：收尾与删除过渡代码

满足以下条件后删除 legacy：

- 已支持新协议的 worker 覆盖达到发布要求，并提升最低兼容版本；
- UI、Commander、Project Chat、fresh review 不再调用 legacy `/new` 首发；
- 生产观测期内没有 legacy fallback；
- uncertain 与 recovery 告警已可操作。

随后删除：

- `/api/agent-sessions/:id/discard-if-empty`；
- `AgentSessionManager.discardSessionIfEmpty`；
- storage `deleteIfEmpty`；
- 仅为 empty-discard 竞态增加的 in-flight guard；
- 调用方中的 `discardEnsuredSessionIfEmpty` 和相关补偿分支；
- legacy worker capability/fallback。

---

## 13. 验证矩阵

### 13.1 状态与幂等

- 相同 prepare operation 并发/重放：同一行、同一 session ID；
- 相同 key 不同配置或内容：409；
- 相同 activation key 并发：一个 runtime、一个 user entry；
- cancel 与 activate 并发：CAS 只允许一个赢家；
- cancel 后 activate：410；active 后 cancel：不删除 active session。

### 13.2 故障注入

分别在以下边界中断：

- prepare row 提交前后；
- activation claim 前后；
- resident capacity check 前后；
- spawn 前后；
- user entry 持久化前后；
- provider stdin write 前后；
- active CAS 和 HTTP response 前后。

验证恢复结果只能是 pending、active 或显式 uncertain，不得出现未归属的 running 0-entry
session。

### 13.3 投影与容量

- pending/expired 不出现在 latest/history/alive/sidebar/search/notification；
- pending 不占 resident；resident 409 只发生在 activation；
- activation 成功后各投影只发布一次；
- 老数据迁移后仍全部可见。

### 13.4 调用方与远程

- UI workspace switch、switch-away-and-back、刷新、断网和 paste/translation failure；
- Commander/Project Chat operation replay；
- review prepare timeout、cancel、Hub restart、worker restart；
- remote prepare/activate response loss；
- 新 Hub + 旧 worker fallback，以及滚动升级兼容矩阵。

---

## 14. 风险与明确取舍

### 14.1 不能宣称严格 exactly-once

稳定 key 能消除 HTTP 重试导致的重复创建和重复逻辑投递，但 CLI stdin 没有业务 ACK。
只有 user entry、没有 assistant/native activity的崩溃窗口必须进入 uncertain，默认不自动重发。

### 14.2 `agent_sessions` 查询需要系统性收口

新增 lifecycle state 后，任何漏掉 active scope 的列表都可能再次显示 pending。应先下沉到
repository 语义方法，并用合同测试覆盖所有投影，再迁移调用方。

### 14.3 rollout 必须 worker-first

Hub/UI 不能假设 remote worker 已支持新协议。旧 worker fallback 期间
`discard-if-empty` 仍有价值，过早删除会重新打开已知窗口。

### 14.4 这是中等规模重构，不是紧急 hotfix

现有补偿修复应先保留并发布。Prepared lifecycle 的价值是把所有 producer 的规则收进
一个模块，并将无法避免的残留降级为不可见、无进程、无容量成本的持久化 intent；它不是
为了追求“数据库里一条废行也没有”。

### 14.5 Phase 0 期间明确接受的残留风险

在 Phase 1+ 落地之前，以下窗口仍然开着，且没有便宜的局部修法：

- 普通 UI 和 Commander 仍在首发前执行 `ensureResidentCapacity`（满员时会 hibernate
  别的正常 session）并 spawn；关标签页、永久断线这类调用方不会再重试的场景，会留下
  一个活的 CLI 进程和一行可见 session。
- 该进程的清理只有两条被动路径：resident pool 满员时被 LRU hibernate；worker 重启时
  `repairOrphanedRunningRows` 把行改成 stopped（不删行、不杀进程）。retention 默认
  OFF，不能算兜底。
- discard 请求本身没送达 worker 时，结果同上，不是“无进程的 stopped 行”。

按后果分级（均可从代码确定，不依赖观测）：

| 后果 | 触发条件 | 严重度 |
|---|---|---|
| 一行可见空 session | 每次首发前放弃 | 低：看着脏，不伤功能 |
| 一个空转 CLI 进程占 resident 槽 | 同上 | 中：占内存直到 LRU 或重启 |
| 建 session 时 hibernate 别人正在用的进程 | 首发前放弃 **且** pool 已满 | 高：用户在用的 session 被无故挤下线 |

单用户阶段接受的理由是第三条几乎不会触发（自己的 pool 很少满）、前两条由用户自己
承担；而任何真正封住这些窗口的改动都会收敛到 §6–§8 的核心，不存在绕开它们的捷径
（§14.6）。多用户后第三条会成为真实伤害，这是 Phase 1+ 必须排在开放多用户之前的
原因（§12）。

### 14.6 评审裁剪记录（2026-08-31）

两轮评审后对原提案的取舍，供后续实现时对照：

**否决过的“小方案”**——“UI 预生成 sessionId 透传 `/new`、fresh reviewer 建成 dormant、
只加日志”三项，被以下代码事实推翻：UI 走的 project route 忽略 `sessionId`，submission
identity 是内存 Symbol；零 entry 行不被启动恢复加载，dormant 只是内存字段且投影无
过滤；prepare 终止路径不删 reviewer。把这三项做真（跨重启、跨 remote、可清理、不可见）
需要的正是持久化 pending 状态、投影收口、按 ID hydrate/replay、终止路径精确清理——
即本文档的核心，因此方向保留。

**裁掉的**（表形与路由数，不涉及语义）：

- `activating` 持久化枚举 → 用 session 行上的 lease 字段表达；
- 独立 `agent_session_activations` 表 → 字段并入 `agent_sessions`；
- `GET /lifecycle` 路由 → 视图随 `activate` / `DELETE preparation` 响应返回；
- `activation_uncertain` 的专用投影分区 → active 投影 + 告警标记。

**明确不能裁的**（评审第二轮确认）：

- `activation_uncertain` 作为持久化结果，以及 replay 对它“返回本身、禁止重投”的
  规则——因为两条首发路径都是先落 user entry 再写 stdin，两态模型在这个窗口没有正确
  选择；
- `expired` tombstone 在 replay 窗口内不物理删除——否则同 operation 迟到重放会重建
  session，cancel 重试无法返回 410；
- activation 的 key / hash / payload / lease / user_entry_index 字段——
  `agent_instruction_deliveries` 只有其中的 claim 原语，不是等价物。

---

## 15. 完成定义

只有同时满足以下条件，才算完成长期迁移：

1. 所有新 session 的第一条指令都经 `AgentSessionLifecycleService`；
2. pending 不 spawn、不进普通投影、不占 resident；
3. 普通调用方只使用 `start()`，特殊调用方才显式 prepare/activate；
4. 本地与 remote 对相同 operation key 的 replay 返回同一身份和 outcome；
5. fresh review prepare 不再创建 0-entry reviewer process；
6. crash recovery 不自动重发 uncertain 指令；同 key replay 对 uncertain 返回其本身；
7. cancel/timeout 只写 tombstone；expired cleanup 复用现有 maintenance sweep、不受
   retention 开关控制、只清 replay 窗口之外的行，无独立周期 reconciler；
8. 最低 worker 版本完成迁移后，`discard-if-empty` 及其专用补偿代码被删除。
