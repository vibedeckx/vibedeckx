# 指挥官建的 session 实时浮现到当前 agent 窗口（Req 2）设计 spec

> 状态：**已确认设计**（2026-06-23）。承接
> [`2026-06-22-commander-spawn-send-primitives-design.md`](./2026-06-22-commander-spawn-send-primitives-design.md)
> 与 [`2026-06-22-remote-agent-delegation-design.md`](./2026-06-22-remote-agent-delegation-design.md)：
> 那两个 spec 让指挥官能在**本地 / 远程**起/发 agent 且后端完成回报不依赖前端；
> 本 spec 补上当初**显式拆出去**的最后一块 —— 用户正开着某工作区时，指挥官在后台
> 建出来的 agent session 要**自动浮现**到那个已打开的 agent 窗口（之前只有工作区圆点会亮，
> 窗口本身不动，得切走再切回才能看到）。

---

## 1. 背景与问题

agent 窗口当前显示哪条 session，完全由 `use-agent-session.ts` 的 `startSession()` 决定，
而它只在依赖数组 `[projectId, branch, agentMode, explicitSessionId]` 变化时触发
（挂载 / 切项目 / 切 branch / 切模式 / 手动从 history 选具体 session）。

全局 SSE（`/api/events`）的 `session:status` / `branch:activity` 事件在前端**唯一**的消费者是
`hooks/use-branch-activity.ts`，它只驱动工作区圆点；`session:*` 事件在 `use-global-events.ts` 里被
显式忽略。因此缺一条反应链：**"后端冒出一个新 session（SSE）→ 把它加载进已打开的 agent 窗口"**。

后果：用户正开着工作区 → 指挥官 `spawnAgentSession` 建了 session → 圆点亮、但窗口仍显示
原来的空态 / placeholder / 旧 session。

---

## 2. 关键认知（设计前提，均已验证）

- **事件载荷够用**：`session:status` 事件带 `{ projectId, branch, sessionId, status, agentType }`
  —— 有 branch、有 sessionId，足够定位。（`event-bus.ts`）
- **订阅管道现成**：共享 `/api/events` 流由 `GlobalEventStreamProvider` 暴露，任何组件可用
  `useGlobalEventStream((data) => {...})` 挂回调订阅（`use-global-events.ts` 已这么用，只处理 `task:*`）。
- **加载哪条由现有机制解析**：把 `explicitSessionId` 设上（`setSessionUrlParam`）即触发既有
  reset+load effect；`getSessionById` / `loadExistingSession` 的路由已按 `agent_mode` 分流，
  **local / remote 的 session 都能解析**（`POST /api/projects/:id/agent-sessions` 远程时代理取最新；
  `GET /api/agent-sessions/:id` 处理 `remote-` 前缀 id）。
- **远程事件 id 是本地可解析形式**：远程的 `session:status` 由 `statusEventFromRemotePatch` 桥接，
  其 `sessionId` 即本地 `remote-{mode}-{project}-{remoteId}` 形式（`projectIdFromRemoteSessionId`
  正按此格式解析）。所以前端可直接拿 `event.sessionId` 去导航，**两种模式同一套**。
- **触发态有限**：`spawnAgentSession` 只在本 branch **无活跃 session** 时才建新的（有活跃的被挡、改走
  send）。所以"新 session 凭空出现"只发生在窗口处于空态 / placeholder / 旧 stopped 这几种**非活跃**态。

---

## 3. 产品语义决策（及理由）

| 决策 | 选择 | 理由 |
|---|---|---|
| **新 session 出现时的表现** | **自动切入**（一收到本工作区相关事件就把新 session 加载进窗口，替换当前显示） | 用户要的"在页面也该看到"；零点击、所见即最新。非侵入提示条（备选）暂不做。 |
| **是否覆盖 placeholder（刚点 New Conversation 的空态）** | **覆盖**（一律切入） | 选了"自动浮现"就一致地浮现；设 `explicitSessionId` 会自动清掉 placeholder。 |
| **是否覆盖 history 钉住的旧 session** | **覆盖（暂时）** | 本次求一致 + 最简实现（反应链不看 `explicitSessionId`）。"尊重钉住"留作后续（见 §6 取向 B）。 |
| **触发后如何加载** | **导航到 `event.sessionId`**（approach ①）：`setSessionUrlParam(event.sessionId)`，其余交给既有 effect | 几乎零新机制；远程事件 id 也本地可解析，故 local/remote 通吃；自然覆盖 placeholder & history（都被新 id 顶掉）。取向 ②（强制重载到"最新"）要给 hook 新增绕过 cache 的强制入口、且"跟随最新且当前为空"时 URL 没变需专门强制——多写代码，否决。 |

---

## 4. 架构与反应逻辑

**纯前端、单一职责**的反应链。不动后端（事件已发、已在线、已按租户过滤）、不动 `use-agent-session.ts` 内部。

### 4.1 新增 hook：`apps/vibedeckx-ui/hooks/use-surface-commander-session.ts`

订阅共享事件流，命中条件时回调一个 sessionId。签名形如：

```ts
useSurfaceCommanderSession(
  projectId: string | null,
  branch: string | null,
  currentSessionId: string | null,   // 当前已加载 session 的 id（用 ref 持最新，防闭包旧值）
  onSurface: (sessionId: string) => void,
): void
```

内部 `useGlobalEventStream((data) => {...})`，命中**全部**下列条件才调 `onSurface(data.sessionId)`：

1. `data.type === "session:status"`（带 `sessionId`+`branch`；指挥官 spawn 后投喂 prompt → agent 跑起来必发 `running`，是最早最可靠的触发点）
2. `data.projectId === projectId` 且 `data.branch === branch`（null 归一化后比较）—— 只认当前工作区
3. `data.sessionId !== currentSessionId` —— **去重防回环**：面板已加载的那条 session 自己后续的 status 事件 sessionId 相同，不再触发；只有"冒出一条与当前不同的 session"才动
4. （可选）`data.sessionId !== 已钉的 URL 目标` —— 避免重复设同值

`currentSessionId` 用 `useRef` 持最新值，回调内读 ref，避免订阅闭包捕获旧 id。

### 4.2 `agent-conversation.tsx` 接线

组件手上已有 `projectId / branch / sessionId(=URL explicitSessionId) / setSessionUrlParam`，以及 hook 返回的当前 `session`。调用：

```ts
useSurfaceCommanderSession(projectId, branch, session?.id ?? null, setSessionUrlParam);
```

命中 → `setSessionUrlParam(newId)` → `explicitSessionId` 变 → 既有 reset effect → `getSessionById(newId)` 加载（local/remote 自动解析）→ WS 接上 → 窗口显示新 session。

放成独立 hook（而非塞进本就臃肿的 agent-conversation）是为单一职责、可单测、不让大组件继续膨胀。

---

## 5. 边界情况

- **placeholder（刚点 New Conversation）**：命中即 `setSessionUrlParam(newId)`，reset effect 里
  `if (explicitSessionId) removePlaceholder(...)` 自动清掉 placeholder → 新 session 顶入。✅（A：覆盖 placeholder）
- **history 钉住旧 session**：改 URL param 到新 id，直接切走。✅（A：暂不做 B 例外）
- **面板正显示活跃 running session**：spawn 在有活跃 session 时被挡、不会建新的；指挥官只会 send 投到这同一条，
  WS 就地更新，sessionId 相同 → 去重天然不触发。✅
- **不在该工作区**（用户在别的 project/branch/视图）：事件 projectId/branch 不匹配 → 不动；圆点照常亮（既有机制），
  用户切回时 `startSession` 本就加载最新。✅ 自然落在范围外。
- **回环防护**：`sessionId !== currentSessionId` 覆盖；ref 持最新 id 防闭包旧值。

---

## 6. 不在本次范围

- **取向 B**：尊重 history 钉住 / 用户正在忙时不抢（非侵入提示条 / 按当前态分流）。明确暂缓，本次一律 A。
- **后端任何改动**：事件已具备，零改动。
- **`use-agent-session.ts` 内部改动**：零改动，纯靠现有 `explicitSessionId` 输入驱动。
- **executor / task 等其它实时浮现**：只做 agent session。

---

## 7. 测试

无测试框架（CLAUDE.md）。验证 = 前端 type-check（`cd apps/vibedeckx-ui && npx tsc --noEmit`，只许保留预存的
`rehype-slug` 无关报错）+ 手动 e2e：在一个工作区开着 agent 窗口（分别试空态 / placeholder / 旧 stopped 三态），
让指挥官 `spawnAgentSession`，观察新 session 是否自动浮现到窗口；local 与 remote 各跑一遍。

---

## 8. 受影响文件（预估）

- 新增 `apps/vibedeckx-ui/hooks/use-surface-commander-session.ts`（订阅 + 命中判定 + 回调）。
- `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`：调该 hook，回调接 `setSessionUrlParam`。
