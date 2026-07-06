# Resident Agent Processes — 多会话常驻进程设计

状态：设计稿（未实现）
日期：2026-07-06
分支：dev3

## 1. 背景与现状

当前实现（已核实，dev3 HEAD）：

- stream-json 模式下（Claude Code / Codex），一轮任务结束后 CLI 进程**不退出**：
  result 事件把 `session.status` 置为 `"stopped"`，进程继续挂在 stdin 上等下一条消息
  （`agent-session-manager.ts` result 处理分支，约 :629）。
- 用户继续发消息时，`sendUserMessage`（:1044）发现非 dormant 且 stdin 可用，直接把
  status 翻回 `"running"` 并写 stdin —— **复用原进程的内部上下文，无损**。
- `stopSession`（:1217）kill 整个进程组（负 PID），置 `dormant = true`、status `"stopped"`。
- 前端 New Conversation（`use-agent-session.ts` `startNewConversation`，:973）**无条件**
  先调 stop API 再清空面板；后端 `createNewSession`（:264）另有防泄漏 sweep（:282-287）：
  停掉同 project+branch 所有非 dormant 会话后才 spawn 新进程。
- 切回 dormant 会话 → `wakeDormantSession`（:1592）：spawn 新进程 +
  `buildFullConversationContext` 文本回放全部历史。**有损**（丢失原进程内部状态）。

关键观察：`AgentSessionManager.sessions` 是 `Map<sessionId, RunningSession>`，每个
RunningSession 自带独立 process / MessageStore / subscribers。**多进程并存在数据结构上
已经成立**，"每分支最多一个活进程"只由两处人为收口保证：

1. 前端 New Conversation 先 stop；
2. 后端 `createNewSession` 的同分支 sweep。

本设计把这两处收口替换为一个**全局常驻进程池**（resident pool）+ LRU eviction。

## 2. 目标

- New Conversation 不再默认杀旧进程：旧会话若已完成本轮（between-turn idle、进程活着），
  保留为 resident；新会话 spawn 新进程。
- 可配置上限 `maxResidentAgentProcesses`（默认 3，范围 1–10），存放在 settings。
- 超限时按优先级 eviction：
  1. 只考虑 **idle resident**（status ≠ running、进程活着）；
  2. 按 `lastActiveAt` 最久未使用（LRU）先杀；
  3. **绝不自动杀 running 会话**；全部 running 时拒绝启动 + 前端弹确认。
- 被 evict 的会话进入 dormant（进程杀掉、历史与 DB row 保留），下次消息走
  `wakeDormantSession` 回放。
- 侧栏：每个 workspace 下一级缩进展示"进程活着"的会话（`└ 会话标题`），状态点移到
  会话行。

## 3. 术语

| 术语 | 定义 |
|---|---|
| resident | `process != null && process.exitCode === null` 的本地会话（进程活着） |
| idle resident | resident 且 `status !== "running"` 且 `backgroundTasks.size === 0`（between-turn，可安全 evict） |
| running resident | resident 且正在跑一轮（或有后台任务 pending）——不可自动 evict |
| dormant | 进程已死/被杀，历史在内存+DB，唤醒需回放（现有概念，不变） |

注意后台任务 ledger（task_started/task_notification）：有 pending 后台任务的会话
status 保持 running，天然被"idle"过滤排除，不会被误杀。

## 4. 后端设计

### 4.1 RunningSession 扩展

```ts
interface RunningSession {
  // ...现有字段
  /** 最近一次用户消息或 agent 输出的时间戳（内存态，不落库）。
   *  spawn 时初始化为 Date.now()；sendUserMessage、handleStdout 每次事件更新。 */
  lastActiveAt: number;
}
```

不需要 DB 迁移：eviction 只对内存中的活进程排序，`lastActiveAt` 内存态即可；
重启后所有进程死亡、会话恢复为 dormant（`restoreSessionsFromDb` 现状不变）。

### 4.2 设置

- settings 表新 key `"agentProcesses"`，JSON：`{ "maxResidentAgentProcesses": 3 }`。
- 路由（settings-routes.ts，仿 conversation settings 模式）：
  - `GET /api/settings/agent-processes` → 返回（缺省填 3）；
  - `PUT /api/settings/agent-processes` → 校验整数 1–10，requireAuth。
- AgentSessionManager 通过注入的 `getMaxResidentProcesses(): Promise<number>` 读取
  （每次 spawn 前读，改设置即时生效，不需要重启；读 settings 是一次 sqlite get，可接受）。
- 上限降低时**不主动杀**已有 resident：只在下一次需要 spawn 时按新上限 evict 到位。

### 4.3 容量守卫（核心新逻辑）

新增私有方法，放在**每一处会 spawn 新进程**的入口前：

```
ensureResidentCapacity(opts: { force?: boolean; excludeSessionId?: string })
  : Promise<{ ok: true } | { ok: false; runningSessions: SessionSummary[] }>
```

算法：

1. `residents = sessions.values() 中 process 活着且 id !== excludeSessionId 的本地会话`
   （`skipDb`/`remote-` 前缀的远程代理会话不计入——它们不在本机跑进程）。
2. 若 `residents.length < max` → ok。
3. 否则筛 `idle = residents.filter(不在 running 且无 backgroundTasks)`，按
   `lastActiveAt` 升序，依次 `hibernateSession(id)`（见 4.4）直到腾出名额 → ok。
4. idle 不够（其余全 running）：
   - `force !== true` → 返回 `{ ok: false, runningSessions }`，调用方回 **409**；
   - `force === true`（用户在前端确认过）→ 按 `lastActiveAt` 升序对 running 会话调
     现有 `stopSession()`（保留"Session stopped by user."语义，用户明确批准过），
     腾出名额 → ok。

**并发保护**：capacity 检查 + spawn 必须原子。给 manager 加一个简单的 promise 链
互斥（`spawnMutex = this.spawnMutex.then(...)`），把 `ensureResidentCapacity → spawnAgent`
包在临界区里，防止两个并发 create 同时通过检查导致超限。

需要接入守卫的 spawn 入口（全量清单）：

| 入口 | excludeSessionId | 说明 |
|---|---|---|
| `createNewSession`（REST /new、commander spawnAgentSession） | — | 主路径，替换掉现有 sweep |
| `wakeDormantSession` | — | **容易漏**：唤醒 dormant 也是 +1 进程 |
| `restartSession` | 自身 id | 杀旧 spawn 新，净数不变，excl 自身即可 |
| `switchMode` / exit-plan-mode 重启 | 自身 id | 同上 |
| `switchAgentType` 后的 wake | — | 走 wakeDormantSession，自然覆盖 |

### 4.4 hibernateSession（eviction 专用的"安静版 stopSession"）

不能直接复用 `stopSession`：它会 push "Session stopped by user." 系统消息、走
stopped 分支的 branch-activity 逻辑。eviction 语义不同（不是用户打断，回合早已完成），
需要独立方法：

```
private async hibernateSession(sessionId): Promise<void>
```

1. `session.process = null` 后 `killProcess(proc)`（同 stopSession 的顺序，让 close
   handler 跳过清理）；
2. `finalizeStreamingEntry`（理论上 idle 时无 in-flight 流，防御性保留）；
3. push 一条**低调的系统 entry**：
   `{ type: "system", content: "Agent process released to free a slot; context will be replayed on your next message." }`
   —— 回放有损，用户应当知情（这也是与"无损续聊"的可见差异点）；
4. `dormant = true`；status **保持 "stopped" 不变、不重复写库/广播 status**
   （idle resident 的 status 本来就是 stopped，派生 branch activity 仍是 completed，
   workspace 点保持绿色——现有 `computeBranchActivity` 语义天然兼容）；
5. `provider.onSessionDestroyed?.(id)`（对齐 wakeDormantSession 的 reset 期望，
   避免 Codex "Not initialized" 一类残留状态）；
6. 发事件 `session:process { sessionId, projectId, branch, alive: false, reason: "evicted" }`
   （见 4.6），侧栏据此把该会话行从"活着"列表移除。

### 4.5 createNewSession 的改动

- **删除** :282-287 的同分支 sweep（其存在理由——防进程泄漏——由 resident pool +
  eviction 承接；泄漏上界 = maxResidentAgentProcesses）。
- 入参加 `force?: boolean`（REST body 透传）。
- spawn 前走 `ensureResidentCapacity({ force })`；失败时向路由层抛/返回结构化错误，
  `POST /agent-sessions/new` 回：

```json
409 {
  "error": "resident_limit_reached",
  "max": 3,
  "runningSessions": [ { "id", "title", "branch", "agentType", "lastActiveAt" } ]
}
```

### 4.6 事件与 REST 暴露

侧栏需要知道"哪些会话进程活着"。两条通道：

- **快照**：`GET /api/projects/:projectId/agent-sessions`（现有列表路由）每行增加
  `processAlive: boolean`（manager 内存态 join；dormant/无内存对象 → false）。
- **增量**：EventBus 新事件类型 `session:process { sessionId, projectId, branch, alive }`，
  emit 时机：spawnAgent 成功后（alive: true）、进程 exit/error handler、stopSession、
  hibernateSession（alive: false）。经现有 `/api/events` SSE 下发（沿用该通道已有的
  per-tenant 过滤：projects.getById(event.projectId, userId)）。

现有 `session:status`（running/stopped）继续负责"跑没跑"，`session:process` 负责
"进程在不在"。两者正交：`alive && status=running` → 蓝，`alive && status=stopped` →
绿（idle resident），`!alive` → 从侧栏子级消失。

### 4.7 需要审计的"每分支单会话"隐含假设

放开约束后，以下按 branch 取会话的调用点需要逐一确认语义（设计阶段结论）：

| 位置 | 现状 | 处理 |
|---|---|---|
| `getSessionByBranch`（:1181，取第一个匹配） | 多会话下"第一个"≈最老，错 | 改为返回 `lastActiveAt` 最新的匹配；或调用方全部改用明确 sessionId |
| `chat-session-manager.ts` 三处 getSessionByBranch（:1451/:1597/:1663） | commander 找"这个分支的 agent"| 已有 `lastAgentSessionId` 身份追踪优先；fallback 改"最新"后风险可接受 |
| `computeBranchActivity`（branch-activity.ts:56，每分支取 latest） | workspace 点只反映最新会话 | 保留（作为 workspace 行的聚合 fallback，见 §5.3）；会话级状态由 `session:status`+`session:process` 按 sessionId 驱动，不经过它 |
| `findExistingSession` / 面板自动加载 | 按 branch 找最新 | 不变：打开 workspace 默认落在 updated_at 最新的会话 |
| `useSurfaceCommanderSession` | 按 branch surface | 事件本身带 sessionId，不受影响 |

### 4.8 远程会话：同一机制，在远端执行

功能对 local 和 remote **同等生效**——容量守卫/eviction/hibernate 全部实现在
`AgentSessionManager` 内部，而远端 server 跑的是同一套代码，所以远程会话天然被远端
自己的守卫覆盖，enforcement 侧无需任何额外实现。

**计数是 per-machine 的**：上限保护的是跑进程那台机器的资源。本地池只数本地进程
（`skipDb`/`remote-` 前缀的代理会话不占本地名额——它们在本机没有子进程）；远端池
只数远端进程。本地 3 个 + 远端 2 个 = 本地 3/3、远端 2/3，互不挤占。

**Proxy 透传（需要实现的部分）**：

1. `POST /agent-sessions/new` 的远程分支：把 `force` 字段随 body 转发；远端返回的
   409 `resident_limit_reached`（含 runningSessions 列表）按现有 proxy 错误透传路径
   原样回给前端 —— 前端对本地/远程项目走**同一个**确认对话框流程，无感知差异。
2. 远端列表路由（`/api/path/agent-sessions`）同样带上 `processAlive` 字段，
   本地列表 proxy 分支透传 —— 侧栏子级 local + remote 会话都展示。
3. `session:process` 事件走现有 remote→local 事件桥（与 session:status/branchActivity
   的 broadcastRaw 桥接同一通道）re-emit 到本地 EventBus，驱动侧栏增量更新。

**设置作用域**：`maxResidentAgentProcesses` 是 per-server 设置——远端读远端自己的
settings（默认 3）。第一期不做本地 UI 配置远端上限；如需要，follow-up 走现有
proxy 到远端的 settings 路由（受 VIBEDECKX_API_KEY 门控）按 remote server 逐台配置。

## 5. 前端设计

### 5.1 New Conversation 流程改动

`use-agent-session.ts` `startNewConversation`（:973）：

- **删除** `stopSessionApi(session.id)` 调用（连同其注释）。仅做本地清理：关 WS、清
  cache、进入 placeholder 模式（现有逻辑保留）。旧会话进程继续作为 resident 活着。
- `agent-conversation.tsx` New Conversation 按钮（:721-733）上"正在运行→confirm 停止"
  的弹窗**删除**：running 会话现在合法地留在后台继续跑。

首次发消息 `ensureSession` → `POST /agent-sessions/new`：

- 收到 **409 resident_limit_reached** 时弹确认对话框：
  > 已达到常驻 agent 进程上限（3），且全部在运行中：
  > `feat-a · 修复登录` （运行 12 分钟）
  > `dev2 · 重构存储层` （运行 3 分钟）
  > [停止最久未活动的会话并继续] [取消]
- 确认 → 带 `force: true` 重发；取消 → 恢复输入框内容（沿用现有失败恢复逻辑 :448-451）。

### 5.2 侧栏结构（app-sidebar.tsx Workspace 区）

现状：每个 worktree 一行，`StatusDot(workspaceStatuses.get(branch))` + 分支名。

新结构（仅当该 workspace 存在进程活着的会话时展开子级）：

```
Workspace
  ● main
  ○ dev2
    └ ● 重构存储层为 Kysely        ← running（蓝，脉冲）
    └ ● 修复迁移脚本               ← idle resident（绿）
  ○ dev3
    └ ● Symbol 点击导航
```

- 子级行：缩进 + `└`（或 `└─` 用 mono 字体对齐现有树形风格），显示会话标题
  （`title` 列，无标题时回退 snippet/“Untitled”，truncate + tooltip）。
- **状态点移到会话行**：蓝脉冲 = running；绿 = idle resident；红 = error。
- workspace 行自身的点退化为两类信号：
  - orchestrator/main-chat 状态（`main-running` / `main-completed`，来自
    BranchActivityDedupe 的 main-* 覆盖层）——继续显示在 workspace 行；
  - 该分支**没有任何活进程**时，回退显示现有 `computeBranchActivity` 派生点
    （completed 绿 / stopped 琥珀 / idle 无点），保持旧行为不回归。
  - 有活进程子级时，agent 状态由子级行表达，workspace 行不再重复画 agent 点
    （避免双点歧义）。
- 点击子级行 → `onBranchChange(branch)` + 设置 `?session=<id>`（复用
  SessionHistoryDropdown onSwitch 的同一机制），面板切到该会话；因为进程活着且非
  dormant，继续对话走无损的 stdin 直写路径。

### 5.3 数据流

新 hook `useResidentSessions(projectId)`：

- 初始：`GET /api/projects/:id/agent-sessions`（现有路由 + `processAlive` 字段），
  过滤 `processAlive` 构建 `Map<branch, ResidentSessionRow[]>`；
- 订阅现有 `/api/events` SSE：
  - `session:process` → 增/删行；
  - `session:status` → 更新行内点颜色（running/stopped）；
  - 现有 `titleUpdated` 广播路径 → 更新行标题（复用 SessionHistoryDropdown 的
    self-heal refetch 思路：收到未知 sessionId 的事件时整体 refetch 一次兜底）。
- app-sidebar 通过 props 接收（与现有 `workspaceStatuses` 并列）。

### 5.4 设置 UI

settings-view.tsx 增加一项（放在 Conversation/Terminal 同级的 "Agent" 区）：

> Max resident agent processes — [ 3 ] （1–10）
> 说明文案：完成任务的会话会保留进程以便无损继续；超过上限时最久未使用的空闲会话
> 将被休眠（下次唤醒时回放历史）。

## 6. 边界情况

1. **服务重启**：所有 resident 进程随之死亡；`restoreSessionsFromDb` 恢复为 dormant，
   行为与现状一致，无需额外处理。侧栏子级自然为空。
2. **commander spawn**（spawnAgentSession 工具 → createNewSession(announceRunning)）：
   同样过容量守卫。全 running 且无 force 通道时对工具返回结构化错误，由 commander
   决定重试/汇报（工具层不弹 UI confirm；`force` 仅暴露给人类 REST 路径）。
3. **同一分支多个 resident**：允许（New Conversation 两次即产生）。面板同时只显示一个，
   其余在侧栏子级/history dropdown 可切换。
4. **Stop 按钮语义不变**：显式 Stop 仍走 stopSession（kill + dormant + 系统消息），
   即用户主动释放名额的手段。
5. **进程自然退出**（CLI crash / claude 自己 exit）：现有 close handler 置 error/stopped,
   补一个 `session:process alive:false` emit 即可，名额自动释放。
6. **上限=1**：行为近似现状，但语义更好——New Conversation 会先 hibernate（安静休眠）
   而非 stop（打断语义），且 running 时会弹确认而非静默杀。
7. **evict 与用户消息竞争**：hibernate 在 spawn 互斥锁内执行；若用户消息恰好先到，
   会话翻回 running，随后的容量筛选自然跳过它（按锁序一致）。

## 7. 实施拆分（建议顺序）

1. **后端池化**：lastActiveAt、ensureResidentCapacity + spawn 互斥、hibernateSession、
   createNewSession 去 sweep + force 参数 + 409、settings key/路由。
   单测：eviction 选择器做成纯函数（输入 [{id, status, lastActiveAt, backgroundTasks,
   processAlive}]，输出 victims | rejection），仿 branch-activity.test.ts 风格。
2. **暴露层**：列表路由 processAlive 字段、`session:process` 事件 + SSE 过滤；
   远程透传三件套（force/409 转发、列表字段透传、事件桥 re-emit，见 §4.8）——
   远端 server 升级到含守卫的版本后即获得同等 enforcement。
3. **前端**：startNewConversation 去 stop、409 confirm 对话框（local/remote 同一流程）、
   useResidentSessions、侧栏子级 + 点迁移、设置 UI。
4. **follow-up（不阻塞）**：本地 UI 按 remote server 配置远端上限；getSessionByBranch
   语义改"最新匹配"并复核 chat-session-manager 三个调用点。

## 8. 明确不做

- 不做进程级挂起（SIGSTOP）/内存换出——只有 kill+回放一种降级。
- 不做跨重启的 resident 恢复。
- 不改 wakeDormantSession 的回放格式（有损回放的质量优化是另一个课题）。
- 不为 eviction 增加 DB 字段。
