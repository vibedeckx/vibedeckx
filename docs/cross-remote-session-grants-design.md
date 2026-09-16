# Cross-remote 会话级授权 — 设计与实施计划

状态：**步骤 1–5 已实现（dev3，2026-09-16），未提交**。步骤 6（撤销时关闭 broker 句柄）未做，步骤 7 的能力注册表快照已确认无变化。全部改动在 hub 与前端，worker 不需要发版。

实现与本文的四处出入：

- `POST /api/projects/:id/agent-sessions/new`（§7 最后一条）没有接 `grantedRemoteIds`：前端 `createNewAgentSession` 已无调用方，加了就是死代码。首条消息一律走 start 或 prepare→activate。
- 上下文块的开标签带上了 `names` 属性（`<vremotes names="ubuntu-1, mac-mini">`），块内散文不变。前端据此渲染 chip，不必反解给 agent 看的句子。
- 前端 prepare 时带 `grantedRemoteIds`；prepare 一拿到 id，hook 就从草稿态切到会话态，之后每次勾选直接 PUT，发送前 `flush()` 等它落地。（早先那次「发送前再 PUT 一遍草稿」已经删掉：切到会话态后草稿恒为空，那段代码到不了。）
- 上下文块与 chip 里的机器**按名字排序**。一次 `replace` 写进去的行共用同一个 `granted_at`，仓储的次级排序键是随机的 server id，不排序的话同一份授权在两轮之间顺序会乱跳。

审阅后补的几条规则（都在代码里）：

- **授权先于身份落库**。本地 `prepare()` 在 `prepareSessionRow` 之前写授权，远程 `ensureIntent` 在 `intents.begin()` 之前写；否则同一 operation 的并发重放可能先找到行并激活，agent 就带着空名单起来了。身份没建成时回删（caller 自带 sessionId 的竞态例外，那种情况两边写的是同一行）。
- **授权写失败不再吞掉**：远程侧直接抛，什么都没创建也什么都没发。
- **首轮块冻结失败不再退回原文**。退回会让下一次成功的尝试发出不同字节，在同一 activation key 下被 worker 判成冲突。改为不发，返回 `remote_unreachable`（本地存储故障，但调用方契约一致：没投递、同 key 可重试）。
- **前端**：保存响应带序号，过期响应不再回写 chip（否则刚撤销的机器会被旧响应放回来，下一次勾选又把它存回去）；`flush()` 会把最近一次保存失败抛给调用方，消息不再在授权没落地的情况下发出；重试首条消息时以当前草稿为准，且身份已存在时先走 PUT（创建请求体在重放时是被忽略的）；加号菜单不再列出会话自己所在的机器。


## 0.1 显示状态与授权状态是两件事（已实施）

早先的设计把「输入框 chip」和「服务端授权状态」混成了一件事，由此长出双模、PUT 协议、`ready` 闸门、同步标记等一整套机制——**第 4、5、7、8 轮的 blocking finding 全部落在那套机制内部**。现在分开：

| | 表示什么 | 存在哪 | 谁写 |
|---|---|---|---|
| 输入框 chip | **下一个 turn** 允许访问哪些机器（声明） | 客户端 localStorage | 用户勾选 |
| 气泡 chip | **那个 turn 实际**跑在什么名单下 | transcript 里的 `<vremotes>` 块 | 服务端生成 |
| `agent_session_remote_grants` | 网关执行的依据 | 服务端 | 发消息时整表替换 |

由此得到的性质：

- **turn 跑起来之后取消 chip，不影响正在跑的 turn**，只表示再下一个 turn 怎么跑。
- **客户端从不读服务端的授权状态。** 想知道当前授权了什么，看最后一条消息的气泡 chip。
- **所见即所得**：消息断言的就是 chip 上显示的，空列表是一个真实答案（下一个 turn 没有远程），不是「没意见」。
- 到另一台机器打开同一 session，chip 是空的；在那里发消息会把授权撤销到空。这是刻意的——失败方向是权限变少，而且用户看到的就是他将得到的。跨设备同步属于显示体验问题，不做。

接口：

- **写**：`POST /api/agent-sessions/:id/message` 的可选 `grantedRemoteIds`。给了就整表替换、**再**生成 `<vremotes>` 块（块描述的是刚生效的名单）；不给表示「无意见」，表保持不动——commander / workflow / project-chat 这些非输入框发送方都不给。创建类路由（start / prepare）照旧带这个字段。
- **读**：没有。`GET/PUT /api/agent-sessions/:id/remote-grants` 与整个 `cross-remote-grant-routes.ts` 已删除。

客户端剩下的（`use-session-remote-grants.ts`，68 行、1 个状态位）：读/写 localStorage 声明、会话创建时把 workspace 级声明移交给它（否则第一条消息之后 chip 会清空，第二条消息就会断言空名单、把刚授予的撤销掉）。声明为空与不存在等价，所以只存非空的，没有需要回收的垃圾。

一个边界：网关是**每次工具调用**查表，不是每个 turn 查一次。所以用户在一个 turn 运行期间又发消息（消息会排队），那条消息带的名单会立刻写表，影响**当前 turn 后续的**工具调用。这被认为是对的——发了新消息就是在表达新意图。

## 0. 已知残留

上线时带着走，不打算在这一轮修：

- **首条消息响应丢失后，第一个 turn 可能按旧名单跑。** 场景：勾了 A → 发首条消息 → HTTP 响应在回程丢了（服务端其实已建会话、已按 `[A]` 投递）→ 用户取消勾选 A → 重发。服务端认出同一个 operationId，走重放分支，**忽略请求体里的授权名单**（这条规则本身是防过期客户端把撤销写回去的），于是 agent 继续带着 A。
  重发成功后客户端接管会话，hook 丢掉草稿、重读服务端，chip 如实显示 A 仍开着，用户点叉即撤销。三条路径（刷新 / 直接重发 / 改了再重发）界面都不撒谎。
  曾经为此加过一套恢复机制（`grantsSynced` 标记 + 用 `prepare` 问出 id + PUT 回退），后来整套摘掉，理由：① 用户的两种自然反应（刷新、直接重发）根本不触发这个场景；② 响应丢失多数意味着服务端已处理完，agent 从那一刻就在跑了，机制能做的只是在一个已开跑的 turn 中途撤权限，差几秒；③ 这套机制自己出过两轮 bug，其中一条还是在「刷新自动重放」这条高频路径上。

- **远程会话「普通消息」的重试幂等缝隙。** 消息路由本地分支按用户原文求哈希，远程分支是 hub 拼好块再代理，worker 对收到的完整内容求哈希。同一 idempotencyKey 的两次重试之间用户改了授权，worker 会判 `idempotency_conflict`。目前没有调用方在远程会话的消息上带 idempotencyKey（UI 不带；project-chat / commander 会话没有授权，块为空），修它要给隧道加字段，§6 已决定不加。
- **Branch 出来的会话会继承父会话历史里的 `<vremotes>` 块。** 新会话授权为空，agent 却在回放的历史里读到「已授权 ubuntu-1」。网关按新会话的授权表拒掉并回 `not_granted`，能自纠，代价是多碰一次壁。
- **首轮块冻结失败报成 `remote_unreachable`。** kind 是为了复用「没投递、同 key 可重试」这条契约；`detail` 传字符串，所以用户看到的文案是真实原因（存储写不进去），不是「远程不可达」。

## 1. 问题

现在 cross-remote 的授权只有一层：每台机器一个 `cross_remote_access` 档位（off / read / exec）。会话启动时只要用户有任意一台非 off 的机器，就把一个 7 天有效的 session token 烧进 `--mcp-config`，此后这个会话里的 agent 可以碰**所有**非 off 的机器。

三个后果：

- agent 的访问面等于用户全部开过档位的机器，而不是这次对话真正需要的那一两台。
- MCP instructions 只在进程启动时被读一次，模型不一定记得用；用户往往要在每条消息里明说"去 ubuntu 机器上看"。
- 新用户从界面上看不到这个能力存在。

## 2. 术语

- **档位（tier）**：机器级 `cross_remote_access`，是**上限**。不变。
- **授权（grant）**：会话级的机器名单。agent 实际能碰的机器 = 授权名单 ∩ 档位非 off ∩ 在线。
- **草稿（draft）**：会话尚未创建时，输入框里暂存的授权名单。
- **上下文块（context block）**：hub 在每条用户消息末尾追加的 `<vremotes>…</vremotes>` 文本，告诉 agent 当前授权了谁。它只是引导，**不是授权依据**。

## 3. 授权规则

1. 默认不授权任何机器。会话运行所在的机器沿用原有权限，不在此讨论范围。
2. 授权可多选，持续到用户修改为止。离线不取消授权。
3. 网关逐次校验：`list_accessible_remotes` 只返回已授权的机器；任何目标机器的调用先查授权，再查档位与在线。已打开的 MCP broker 句柄在下一次调用时同样重查授权，撤销后失效。
4. 授权只约束 agent 的 cross-remote 操作。用户本人打开历史截图、文件链接、浏览机器的路径（`artifact-read-targets.ts` → `canReachRemote`）**不挂**会话授权，撤销后依然可用。
5. 已有会话（上线前创建的）授权为空，不做迁移，也不用审计表反推补授权。
6. 分支会话、独立新会话不继承授权。commander 派生的子会话（`owner_kind = commander_request`）暂时为空；现有数据里没有父会话指针，"按父会话当前授权实时推导"留到有指针之后再做。

## 4. 数据模型

新表，不改 `agent_sessions`。原因：`remote-` 前缀的远程会话在 hub 上没有 `agent_sessions` 行，只有 `remote_session_mappings`，放列会漏掉一半会话。

```sql
CREATE TABLE IF NOT EXISTS agent_session_remote_grants (
  session_id       TEXT NOT NULL,          -- 本地会话 id，含 remote- 前缀的
  remote_server_id TEXT NOT NULL REFERENCES remote_servers(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  granted_at       TEXT NOT NULL,
  PRIMARY KEY (session_id, remote_server_id)
);
CREATE INDEX IF NOT EXISTS idx_session_remote_grants_session ON agent_session_remote_grants(session_id);
```

`session_id` 不加外键（同上原因）。会话删除、远程映射删除时在仓储层顺手 `deleteBySession`。

另外 `remote_session_creation_intents` 加一列 `first_turn_grant_context TEXT DEFAULT NULL`，存远程首条指令用过的上下文块快照（用途见 §6）。仓储加 `setFirstTurnGrantContext(localSessionId, text)`，只在列为 NULL 时写入（`WHERE first_turn_grant_context IS NULL`），保证首次写入后不被覆盖。

仓储 `storage.sessionRemoteGrants`：

- `list(sessionId, userId): Promise<string[]>`
- `replace(sessionId, userId, remoteServerIds): Promise<void>`（事务：删旧插新）
- `deleteBySession(sessionId): Promise<void>`

## 5. 网关判定

改动集中在 `cross-remote-access.ts`，`canReachRemote` **不动**。

```
resolveTarget(payload, targetRemoteId, tier)
│
├─ targetRemoteId == payload.sourceRemoteServerId → not_accessible（原有）
├─ targetRemoteId ∉ grants(payload.sessionId)     → not_granted（新增）
└─ canReachRemote(userId, targetRemoteId, tier)    → 原有档位 + 在线判定
```

- `listAccessibleRemotes`：先取 `grants(sessionId)`，再对 `getAll(userId)` 过滤：档位非 off、不是源机器、在授权名单内。
- `ResolveResult.reason` 增加 `"not_granted"`。路由层文案："remote not granted to this session; ask the user to allow it from the composer's + menu"。审计照旧记 denied。
- 句柄路径（`cross-remote-mcp-routes.ts` 里 verifyRemoteMcpHandle 之后）本来就会走 `resolveTarget`，所以撤销后旧句柄自动失效，不需要额外改动。
- `mintCrossRemoteMcpConfig` 的 `hasTarget` 仍按机器档位判断，不看授权。这样只要用户有任何一台开档位的机器，token 就在进程里，中途授权不需要重启。

**MCP instructions 改两句**（`CROSS_REMOTE_MCP_INSTRUCTIONS`）：

- `list_accessible_remotes` 描述改为"the remotes the user has granted to this session"。
- "If no remote matches, say so instead of silently falling back to local" 改为："The user grants remotes to this session from the composer's + menu (Allow remote access). If the list is empty or the named machine is missing, tell the user to grant it there; do not fall back to the local workspace."

## 6. 上下文块

由 hub 按数据库里的真实授权生成，每条用户消息都带，包在可识别标签里供前端渲染成 chip：

```
<vremotes>
Cross-remote access granted for this session: ubuntu-1 (id: 2f…, exec), mac-mini (id: 9a…, read).
Use the cross-remote MCP tools when a request concerns one of these machines. Being granted does not mean every command should run there; the local workspace remains the default target.
</vremotes>
```

授权为空时不追加。字符串内容直接追加在末尾（在客户端已附的 `<vfile/>`、`<vpaste/>` 之后）；`ContentPart[]` 追加一个 text part。

**注入点**（新建 `cross-remote-grant-context.ts` 提供 `appendRemoteGrantContext(storage, sessionId, userId, content)`，一律读库；前提是 §7 规定的落库时机，授权在任何首条指令投递之前就已经在库里）：

| 路径 | 位置 | 说明 |
|---|---|---|
| `POST /api/agent-sessions/:id/message` 本地分支 | `agent-session-routes.ts` `deliver()` 之前 | 路由层 |
| 同上，远程分支 | `proxyAuto` 之前 | 路由层，hub 拼好再代理给 worker |
| 本地 start / activate | `AgentSessionLifecycleService.runActivation`，`runtime.sendUserMessage` 之前 | **不在路由层**：本地 `start()` 在服务内部就完成 prepare + activate 并投递首条指令，路由拿到结果时已经发出去了。放在 `hashInstruction` / `claimActivation` 之后，`activation_content_hash` 与 `activation_content_json` 只覆盖用户原文；`sendUserMessage` 持久化的 entry 带上下文块，UI 和 `--resume` 回放都能看到 |
| 远程 start | `RemoteSessionLifecycle.start()`，`ensureIntent` + 授权落库之后、`proxyToRemoteAuto` 之前 | 首条指令由 worker 投递，hub 只能在代理前拼；**块文本取自 intent 上的快照**，见下 |
| 远程 activate | `RemoteSessionLifecycle.activate()`，代理之前 | 同上，用快照 |

**幂等与首条指令的快照。** 本地路径的哈希不含上下文块，重试不受影响。远程路径不同：worker 上的 `claimActivation` 把收到的完整 instruction 的哈希写进行里，`releaseActivationLease` 失败时只清租约不清哈希，同 key 重试拿新哈希和旧哈希比。所以远程首条指令的块文本在同一次激活的各次重试之间**必须逐字相同**，否则 `resident_limit` 或 `spawn_failed` 之后用户改了授权再重试，会被 worker 判成 `idempotency_conflict`，而这是 §7 明确要支持的流程。

做法：`remote_session_creation_intents` 加一列 `first_turn_grant_context TEXT`（可空）。hub 第一次代理 start / activate 时按当时授权生成块文本，先写进这一列，再拼进 instruction 代理出去；之后同一会话的每次 start / activate 一律取这一列，不再重新生成。授权为空时写空串，同样固定。网关判定始终按授权表里的最新状态，与快照无关。于是首轮 agent 看到的名单可能比实际授权略旧，下一条消息路由重新生成时即自动纠正。intent 行现在只有未确认的陈旧行会被 `discardStaleLifecycleIntents` 回收，已激活的行照旧保留；快照是一小段文本，跟着行走，不单独回收。不给隧道加字段。

commander 的 `sendToAgentSession`、workflow 内部投递不注入。

**需要剥掉标签的地方**：`utils/session-title.ts`（标题生成的提示词）、`user-input-markers.tsx#getMessagePreview`（右侧 minimap）。

## 7. API

- `GET /api/config` 增加 `crossRemoteSessionGrants: boolean` = `crossRemoteMcpEnabled() && authEnabled`。为 false 时前端隐藏菜单入口（solo 无鉴权模式本来就不铸 token）。
- `GET /api/agent-sessions/:id/remote-grants` → `{ grants: [{ id, name, access, online }], requiresRestart: boolean | null }`
- `PUT /api/agent-sessions/:id/remote-grants`，body `{ remoteServerIds: string[] }` → 同上返回。
  - 会话归属校验**复用 lifecycle 路由的 `authorizeLocal` / `authorizeRemote`**（抽到共享模块导出）。远程会话在 prepare 之后、activate 之前只有 creation intent、没有 mapping，`remoteSessionMappings.getAuthorizedByLocal` 会 404；`authorizeRemote` 是 intent 或 mapping 二选一，正好覆盖这段窗口。前端 prepare → activate 流程里首轮授权就是在这个窗口改的。
  - 每个 id 必须 `remoteServers.getById(id, userId)` 命中、档位非 off、不是该会话自己所在的机器（`mapping?.remote_server_id ?? intent?.remote_server_id`）；否则 400，整单不落。
  - `requiresRestart`：本地会话若运行时存在、进程活着、`crossRemoteMcp` 为空 → true（进程里没有 token，授权要重启才生效）；远程会话 hub 不知道，返回 null。
- 创建类路由请求体增加可选 `grantedRemoteIds?: string[]`（路由层校验规则同 PUT，校验通过后透传给 lifecycle 输入）。**落库必须早于首条指令投递**，所以落库点在 lifecycle 服务内、会话 id 刚确定的那一刻，而不是路由拿到结果之后：
  - 本地 `prepare()` / `start()`：在 `runtime.prepareSessionRow` **之前**写 `sessionRemoteGrants.replace`——行一旦可见就可能被同 operation 的并发重放捡去激活，所以不能先建行后写授权；行没建成时按 §0 上方的规则回删。`start()` 内部先 prepare 再 activate，所以自然早于投递。
  - 远程 `prepare()` / `start()`：`ensureIntent` 里在 `intents.begin()` **之前**落库，理由同上，也早于任何 worker 调用。legacy worker 路径也经过 `ensureIntent`，同样覆盖。写失败直接抛，不吞。
  - **重放不覆盖**：`replayPrepare` 分支、`ensureIntent` 命中 `existing` 的分支都不碰授权表。用户在两次重试之间改过的授权以库里为准。远程 start 返回 `remote_unreachable` 时授权已经在库里，重试走 `existing` 分支不会重复写。
  - `POST /api/path/agent-sessions/new`、`POST /api/projects/:projectId/agent-sessions/new`：没有首条指令，创建成功后在路由层落库即可；远程会话等 worker 返回 id、映射写入之后再落。
- 消息路由**不接受**授权字段，避免旧列表覆盖服务端。

## 8. 前端

- `lib/api.ts`：`AppConfig.crossRemoteSessionGrants`；`getSessionRemoteGrants(sessionId)`、`setSessionRemoteGrants(sessionId, ids)`；创建 / prepare / start 请求类型加 `grantedRemoteIds`。
- 新 hook `useSessionRemoteGrants(sessionId | null)`：
  - `sessionId` 为空 → 草稿态，存在组件状态里，随创建请求体发出。
  - `sessionId` 存在 → 打开会话时 GET；切换勾选立即 PUT，成功前 chip 显示 pending，失败回滚并显示错误，不允许界面呈现为已生效。
  - 用户改完立刻发送：发送前等待 PUT 完成。
- 加号菜单（`agent-conversation.tsx:1725` 处的 `PromptInputActionMenu`）：新增 `PromptInputActionMenuItem` "Allow remote access"，展开子菜单列出档位非 off 的机器，每行复选框 + 机器名 + 档位徽标（Read / Exec）+ 在线点。没有可选机器时保留入口，说明"先在 Settings → Remote Servers 打开某台机器的 cross-remote 档位"并给链接。
- chip 行：与 Translate 徽标同一行（`agent-conversation.tsx:1710-1721`），每台已授权机器一个 chip，叉号撤销。`requiresRestart` 为 true 时 chip 旁提示"restart session to take effect"。
- 用户气泡：`agent-message.tsx#renderTextWithVPaste` 增加 `<vremotes>` 匹配，渲染成一枚"Remote access: ubuntu-1, mac-mini"小 chip。
- 首次授权时在会话里不额外插系统消息，上下文块本身留下了审计痕迹。

## 9. 撤销时关闭 broker 句柄（可后置）

hub 侧现在没有句柄登记，句柄是无状态签名 token，撤销后只能靠下次调用被拒。补一个 hub 内存登记：`open` 成功时记 `(sessionId, remoteId) → Set<workerHandle>`，`close` 时移除；`PUT remote-grants` 移除某台机器时，对该机器的每个句柄调用现有 `POST /api/path/cross-remote/mcp/close`（已在能力注册表里，不新增条目），尽力而为，失败只记日志。hub 重启丢登记可接受，worker 端有空闲回收。

## 10. 实施步骤

按提交顺序；步骤 1–5 必须在同一次发布里上线，否则中间态是"网关拦了、界面没法授权"。

1. **存储**：建表 + 迁移 + 仓储 + 会话删除路径的 `deleteBySession` + 仓储测试。
2. **网关**：`cross-remote-access.ts` 加授权判定与 `not_granted`；路由文案；instructions 改文；`cross-remote-access.test.ts` 与 `cross-remote-mcp-routes.test.ts` 补：过滤、拒绝、句柄撤销后失效、源机器排除顺序不变。
3. **授权 API**：抽出 `authorizeLocal` / `authorizeRemote`；GET/PUT 路由 + 校验 + `requiresRestart` + `/api/config` 标志；创建类路由接 `grantedRemoteIds` 并透传到 lifecycle，lifecycle 在 id 确定处落库。路由测试：他人会话 404、off 档位 400、自身机器 400、**prepared 但未 activate 的远程会话可 GET/PUT，其他用户 404**、本地 start 后网关在首条指令处理时已能读到授权、远程 start 返回 `remote_unreachable` 后重试不重复写也不覆盖用户中途的修改、`replayPrepare` 不碰授权。
4. **上下文注入**：helper + 五个注入点（消息路由两处、本地 `runActivation`、远程 start / activate）+ intent 快照列与只写一次的仓储方法 + 标题 / minimap 剥标签。测试：本地与代理分支都带块；本地 activate 的 `activation_content_hash` 不含块；授权为空不带块；**远程首次 activate 失败（`resident_limit`）→ 用 PUT 改授权 → 同 key 重试，代理出去的 instruction 与首次逐字相同、worker 侧返回 activated 而非 `idempotency_conflict`，且随后网关按改过的授权判定**；两次代理之间机器改名同样不改变 instruction。
5. **前端**：api + hook + 菜单 + chip 行 + 气泡 chip + 配置标志隐藏；vitest 覆盖标签解析、草稿进创建体、勾选触发 PUT、撤销移除 chip、保存失败态。
6. **句柄关闭**（§9），可单独跟进。
7. 跑 `/compat-check` 确认能力注册表快照无变化；更新 CLAUDE.md 里 cross-remote 那段和 memory。

## 11. 兼容性

- 全部判定在 hub 进程内，`POST /api/cross-remote-mcp` 是 hub 路由，worker 不参与。
- `grantedRemoteIds` 只在 hub 侧路由消费，不透传给 worker；`crossRemoteMcp` 字段照旧。
- `<vremotes>` 块对旧 worker 只是普通文本。
- 不新增 `WORKER_CAPABILITIES` 条目，`reverse-connect-capabilities.test.ts` 快照应无变化。

## 12. 验收

- 新会话不授权时，`list_accessible_remotes` 返回 `[]`，`remote_bash` 被拒且文案指向加号菜单。
- 新会话在输入框里先授权再发首条消息，agent 处理这条消息时的第一次 cross-remote 调用就能通过（本地与远程 start 都要验）。
- 授权一台后，同一会话不重启，下一次调用即可访问；撤销后下一次调用被拒，已打开的 MCP 句柄同样被拒。
- 撤销后用户仍能打开该机器上的历史截图链接。
- 刷新页面、会话休眠唤醒后 chip 与网关判定一致。
- 远程会话（agent 跑在 worker A 上访问 worker B）全流程与本地会话一致。
