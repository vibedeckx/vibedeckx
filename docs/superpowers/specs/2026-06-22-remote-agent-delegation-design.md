# 远程 agent 委派（spawn/send 的 remote 路径）设计 spec

> 状态：**已确认设计**（2026-06-22）。承接
> [`2026-06-22-commander-spawn-send-primitives-design.md`](./2026-06-22-commander-spawn-send-primitives-design.md)：
> 那个 spec 让指挥官能在**本地**起/发 agent；本 spec 补上**远程**工作区
> （`project.agent_mode !== 'local'`）的路径，对齐本地语义、且**全程后台、不依赖前端**。

---

## 1. 背景与问题

`spawnAgentSession` / `sendToAgentSession` 当前只走本地 `createNewSession` / `sendUserMessage`，
依赖 `project.path`。在 remote-only 工作区里没有本地路径，于是 spawn 直接被
`if (!project?.path)` 挡掉并返回误导性的"请配置 project path"。

而 `getAgentConversation`（只读）已经支持远程（`findRemoteSessionForProject` +
`proxyToRemote`），所以现状是"远程 agent 读得到、却起不了"。按 SaaS 定位，
remote（reverse-connect 到远程 agent server）是头等路径，必须补齐。

---

## 2. 关键认知（设计的前提）

- **远程 session 的实体在远程**：真正的 agent session + agent 进程建在远程服务器上；
  本地不持有 `RunningSession`，只持有一个远程句柄 = `remoteSessionMap`（内存坐标）+
  `remoteSessionMappings`（sqlite 持久化）+ `remotePatchCache`（消息缓存）。
- **建 session 与 UI 创建完全同款**：UI 的创建路由
  `agent-session-routes.ts:583-641` 已经把"代理建远程 session + 本地登记"做全了。
  本 spec 复用同一套（抽成共享 helper），不另起一套。两条路径产出的 session 是
  **同一种东西、可互操作**。
- **唤醒链路已存在**：`connectPersistentRemoteWs`（`websocket-routes.ts:51`）是本地→远程
  session `/stream` 的常驻流（reverse-connect 下是隧道上的一条虚拟通道；直连下是真 WS；
  自带 ping 保活 + 指数退避重连）。它收到远程 `taskCompleted` 会在 `:145-163` 桥成本地
  `session:taskCompleted` 事件，`ChatSessionManager.handleSessionTaskCompleted`（`:283`）
  据此唤醒指挥官。**它收到 `taskCompleted` 并不关闭**，只在 session 真正 `finished`/删除时停，
  所以跨多轮常驻。
- **唯一缺口**：这条常驻流目前只由"前端打开 agent 窗口"或"reverse-connect 隧道上线"建立。
  指挥官无头 spawn 时没人开窗口、隧道也早已 online，所以**必须由后端自己把流建起来**。

---

## 3. 关键设计决策（及理由）

| 决策 | 选择 | 理由 |
|---|---|---|
| **入口分叉** | 两个工具开头按 `project.agent_mode` 分流；`local` 走现有逻辑、**完全不动** | 本地路径已上线且验证过；远程是新增分支，互不干扰。 |
| **建 session 复用 UI 同款** | 把路由的远程建 session 逻辑抽成共享 helper `createRemoteAgentSession`，路由 + chat 工具都调（DRY） | "建 session"这步两条路径必须产出一致、可互操作；避免复制粘贴漂移。 |
| **#3 唤醒** | **复用** `connectPersistentRemoteWs`（不新建 monitor），spawn/send 调 `ensureRemoteAgentStream`（幂等）把流建起来 | 该函数已是远程版"消费完成事件"的角色，且比 executor 的 monitor 更成熟（重连/保活/同步）；跨多轮常驻正合适。 |
| **spawn guard** | `findRemoteSessionForProject` 找到现有 session 时，**GET 远程 `session.status`** 判活跃：活跃 → 拒绝引导 send；非活跃/无 → 新建（替换 stale mapping） | 与本地"仅活跃才拒、stale 放行"对齐。GET 是权威来源、只在确有 mapping 时才查（本地缓存状态在窗口关闭后可能 stale，不可靠）。 |
| **send busy 判定** | 活跃中（running）→ 不发，返回"忙，完成会唤醒你" | 与本地一致（拒绝即返回，不排队）。 |
| **不依赖前端** | spawn/send 自己 `ensureRemoteAgentStream`，不依赖任何页面打开 | 用户明确要求：指挥官建/驱动 session 不该依赖前端。 |

**显式不在范围**：Req 2（指挥官建的 session 实时浮现到 UI——跨 local/remote 的前端反应链，
另开 spec）；plan-first；批准冒泡；跨 branch 并行。本地路径的现有行为不改。

---

## 4. 组件与数据流

### 4.1 共享 helper：`createRemoteAgentSession`（新模块 `remote-agent-sessions.ts`）

```
createRemoteAgentSession(deps, { projectId, agentMode, remoteConfig, branch, permissionMode, agentType })
  1. proxyAuto(agentMode, remoteConfig.server_url, remoteConfig.server_api_key,
       "POST", "/api/path/agent-sessions/new",
       { path: remoteConfig.remote_path, branch, permissionMode, agentType })
  2. localSessionId = `remote-${agentMode}-${projectId}-${remoteData.session.id}`
  3. remoteSessionMap.set(localSessionId, { remoteServerId: agentMode, remoteUrl, remoteApiKey, remoteSessionId, branch })
  4. remoteSessionMappings.upsert(localSessionId, projectId, agentMode, remoteData.session.id, branch)
  5. remotePatchCache 播种 remoteData.messages
  6. agentSessionManager.emitBranchActivityIfChanged(projectId, branch, { activity: "idle", since })
  → 返回 { localSessionId, remoteSession, messages }
```
- `deps` = `{ storage, remoteSessionMap, remoteSessionMappings, remotePatchCache, agentSessionManager, proxyAuto, reverseConnectManager }`。
- 路由 `agent-session-routes.ts:583-641` 改为调用它（行为不变；纯重构提取）。

### 4.2 `ensureRemoteAgentStream(localSessionId)`（同模块）

幂等地建/确保那条常驻流：查 `remotePatchCache.getRemoteWs(localSessionId)`——已连或正在重连则
no-op；否则调 **`connectPersistentRemoteWs`**（需从 `websocket-routes.ts` 移到共享模块 / 导出）。

### 4.3 远程 `spawnAgentSession`

1. `remoteConfig = storage.projectRemotes.getByProjectAndServer(projectId, agentMode)`；无 → `{ success:false, message }`。
2. guard：`existing = findRemoteSessionForProject(projectId, branch)`；
   - 有 → GET `/api/agent-sessions/:remoteId` 取 `session.status`：`running` → `{ success:false, message:"已有活跃远程 agent，请改用 sendToAgentSession" }`；非活跃 → 记下要替换的 stale `existing.localSessionId`。
3. `{ localSessionId } = await createRemoteAgentSession(...)`（permissionMode 固定 `"edit"`）。
   - 若有 stale：替换/丢弃旧 mapping（`remoteSessionMap.delete` + `remoteSessionMappings` 清理），保证该 branch 本地只映射这条新的。
4. 代理 `POST /api/path/agent-sessions/:remoteId/message` 投喂 `prompt`。
5. `ensureRemoteAgentStream(localSessionId)`。
6. `registerChatInitiatedAgentTask(localSessionId)` + `setEventListening(chatSessionId, true)`。
7. 返回 `{ success:true, agentSessionId: localSessionId, message: "...完成会唤醒你，别报成功" }`。

### 4.4 远程 `sendToAgentSession`

1. `target = findRemoteSessionForProject(projectId, branch)`；无 → `{ success:false, message:"先 spawnAgentSession" }`。
2. GET status（或已知）`running` → `{ success:false, message:"忙，完成会唤醒你" }`。
3. 代理 `/message` 投喂 `message`；失败 → `{ success:false }`。
4. `ensureRemoteAgentStream(target.localSessionId)` + `registerChatInitiatedAgentTask` + `setEventListening`。

### 4.5 唤醒回报（零新增逻辑）

远程 agent 完成 → `taskCompleted` 上隧道 → `connectPersistentRemoteWs` 收到 →
桥成本地 `session:taskCompleted` → `handleSessionTaskCompleted` 唤醒指挥官。
`chatInitiatedAgentTasks` 存的 `remote-` 前缀 id 与 `event.sessionId` 一致，provenance 正确。

---

## 5. 错误处理

- 远程未配置（无 `remoteConfig`）→ 明确返回。
- 远程隧道离线 / `proxyAuto` 失败 / 非 2xx → 工具返回明确失败（"远程服务器不可达，无法启动/投递"），不静默、不假装成功。
- `ensureRemoteAgentStream` 在 reverse-connect-only 且无直连 URL、隧道未连时无法建流——这种情况下 spawn 本身（依赖同一条隧道的 proxyAuto）也会先失败，因此不会出现"session 建了但永远收不到完成"的悬空态。

---

## 6. 受影响文件

- **新增** `packages/vibedeckx/src/remote-agent-sessions.ts`：`createRemoteAgentSession` + `ensureRemoteAgentStream`。
- `packages/vibedeckx/src/chat-session-manager.ts`：两个工具加 `agent_mode` 远程分支。
- `packages/vibedeckx/src/routes/agent-session-routes.ts`：create 路由改调共享 helper（行为不变）。
- `packages/vibedeckx/src/routes/websocket-routes.ts`：`connectPersistentRemoteWs`（及其依赖 `scheduleRemoteReconnect` 等）移到共享模块 / 导出，供 `ensureRemoteAgentStream` 复用。

无 schema 变更（复用现有 `remoteSessionMappings` 表）。

---

## 7. 验证

- 后端 type-check：`npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`（注意仓库已有两个无关预存报错：`@fastify/multipart`、`file-routes.ts`）。
- 端到端手测（remote-only 工作区，reverse-connect 在线）：
  1. 在 Main Chat 让指挥官 spawn 一个远程 agent 做小改动 → 确认远程起了 session 并执行。
  2. **关键：不打开任何 agent 窗口**，确认指挥官仍收到 `[Agent Event: Task Completed]` 并回报（验证无头建流 + 唤醒）。
  3. 再 `sendToAgentSession` 追发一条 → 远程收到并执行、完成再次唤醒。
  4. 边界：已有活跃远程 agent 时 spawn 被拒（引导 send）；无 session 时 send 报错；活跃中 send 返回"忙"。
  5. 远程隧道离线时 spawn/send 返回明确失败。
  6. 回归：本地工作区的 spawn/send 行为不变；UI 创建远程 session 行为不变（共享 helper 重构后）。
