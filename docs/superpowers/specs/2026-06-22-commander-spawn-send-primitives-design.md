# 指挥官调度原语：spawn + send（设计 spec）

> 状态：**已确认设计**（2026-06-22）。落地范围 = 多层级指挥官设计文档
> [`docs/multi-level-commander-design.md`](../../multi-level-commander-design.md)
> §3.6 的调度原语 **#1（新建 agent session + 派任务）** 与 **#2（向已有 agent
> session 发消息）**。原语 #3（读状态）已由现有 `getAgentConversation` 工具提供。

---

## 1. 目标与范围

让 Main Chat 指挥官能在**它自己所在的 workspace（project + branch）**上：

1. 新建一个 coding agent 并把子目标派给它；
2. 向本 workspace 已有的那个 agent 追加消息（纠偏、串下一步、回答提问）。

完成后复用现有的"完成事件唤醒指挥官回报"回路，指挥官被唤醒、读结果、再决定下一步。

### 不在本次范围（各留后续 spec）

- plan-first 计划确认与 subtask 作战图存储（§3.3 / §3.4）。
- 子 agent `approval_request` 的分级冒泡（§3.7）。
- 跨 branch / 跨 project 并行 fan-out 与 worktree 自动创建（§3.5 / §4.2）。
- 主动 mid-turn 打断 / steering（§3.6 注）。

---

## 2. 关键设计决策（及理由）

| 决策 | 选择 | 理由 |
|---|---|---|
| **派生 agent 跑在哪** | **指挥官自己所在的 branch**（当前 workspace 的"每 branch 一个 agent"槽位） | 完全绕开 worktree 创建；覆盖最常见的"在这儿帮我做这件事"。跨 branch 并行更偏 project 层职责，留待后续。 |
| **permission mode** | **固定 edit** | edit = `--dangerously-skip-permissions`，子 agent 不产生 `approval_request`，一路跑到完成发 `taskCompleted`，正好绕开"没人接批准"。plan/默认批准流随 scope B 再开。 |
| **agent 类型** | 默认跟随系统默认（`claude-code`），工具可选 `agentType` 覆盖 | 简单；保留 codex 等扩展口。 |
| **send 撞上忙碌目标** | **拒绝即返回**（`status==="running"` 不发） | 唤醒回路已把时序串好（指挥官正是在 agent 跑完那刻被唤醒），主流程不会撞忙；真排队是给 v1 不追求的 steering 镀金（YAGNI）。 |
| **spawn 时该 branch 已有 session** | **仅当它是 active（`!dormant`）才拒绝**，提示改用 send；若是 **dormant**（停掉/重启恢复的 stale 槽位）则先 `deleteSession` 清掉再新建 | 只避免误杀**正在用**的 session；停掉/休眠的旧会话不该挡新任务。**必须先删 dormant**：`createNewSession` 内部只 stop 非 dormant 的旧 session，不删 map 记录，留着会让同 branch 出现两条、`getSessionByBranch` 返回 stale 那条。`dormant` 判定可靠：`stopSession`/`restoreSessionsFromDb` 都把 session 置为 `dormant=true`，`dormant=false ⟺ 活着`。 |
| **send 时无 session** | **报错**，提示先 spawn | 同上：职责清晰，不自动新建。 |

---

## 3. 两个新工具

加在 `packages/vibedeckx/src/chat-session-manager.ts` 的 `createTools(projectId, branch, sessionId?)` 返回对象里。两者都可访问 `this.agentSessionManager`、`projectId`、`branch`，并能解析 `projectPath`（与现有工具同源）。

### 3.1 `spawnAgentSession({ prompt, agentType? })`

1. `existing = agentSessionManager.getSessionByBranch(projectId, branch)`。
   - `existing && !existing.dormant`（**有活着的 agent**）→ **拒绝**，返回："本工作区已有 active agent，请改用 `sendToAgentSession`。"
   - `existing && existing.dormant`（停掉/重启恢复的 stale 槽位）→ `agentSessionManager.deleteSession(existing.id)` 清掉它（否则下一步 `createNewSession` 不删 dormant，会让同 branch 留两条、`getSessionByBranch` 返回 stale 那条），然后继续新建。
2. `newSessionId = agentSessionManager.createNewSession(projectId, branch, projectPath, false, "edit", agentType ?? 默认)`。
3. `agentSessionManager.sendUserMessage(newSessionId, prompt, projectPath)` —— 注入首条任务。
4. `this.registerChatInitiatedAgentTask(newSessionId)` —— 闭合唤醒回路（完成事件 `isChatInitiated=true` → 圆点按工作流延续上色）。
5. `this.setEventListening(sessionId, true)` —— 确保指挥官 chat session 会被事件唤醒。
6. **返回**：已派出 + agent 完成时会自动回报；明确告知**不要**当场宣称已完成（沿用现有 kick-off 工具不报成功的约定）。

### 3.2 `sendToAgentSession({ message })`

1. `target = agentSessionManager.getSessionByBranch(projectId, branch)`。
   - 无 → **报错**："本工作区还没有 agent，请先 `spawnAgentSession`。"
   - `target.status === "running"` → **不发**，返回："agent 正忙，它完成时你会被唤醒，到时再发。"
   - （`target.dormant` 不算"忙"：走第 2 步，`sendUserMessage` 传入 `projectPath` 会自动唤醒它。）
2. 否则 `agentSessionManager.sendUserMessage(target.id, message, projectPath)`。
3. 确保 `registerChatInitiatedAgentTask(target.id)` 与 `setEventListening(sessionId, true)` 已就绪（幂等）。
4. **返回**：已送达；agent 完成会回报。

---

## 4. 唤醒回报（已现成，无需改动）

`chat-session-manager.ts:283` 的 `handleSessionTaskCompleted` 已完成全部工作：

- 监听 `session:taskCompleted` 事件；
- 按 `projectId:branch` 路由回派任务的指挥官 chat session（因为派生 agent 与指挥官**同 branch**，事件天然路由正确）；
- 拼 `[Agent Event: Task Completed]` 消息（含耗时 / cost / tokens），`enqueueOrSend` 注入指挥官 → 触发其回应；
- 用 `chatInitiatedAgentTasks.delete(sessionId)` 判定 provenance：本次设计让 `spawnAgentSession`/`sendToAgentSession` **真正填上**这个集合，于是 `isChatInitiated=true`、`eventDriven=false`，圆点按"工作流延续"上色而非"旁观总结"。

本次唯一新增的是工具侧的 `registerChatInitiatedAgentTask` + `setEventListening` 调用；事件处理逻辑零改动。

---

## 5. 系统提示词

在 `getSystemPrompt` 的工具说明中新增两条，并写清编排约定：

- **何时 spawn vs send**：本工作区没有 agent 用 `spawnAgentSession`，已有则用 `sendToAgentSession`。
- **edit 模式自主性**：派生 agent 在 edit 模式下自主跑完，**不会**逐步征求批准。
- **异步约定**：派任务 / 发消息只是"踢一脚"，agent 完成会作为后续 `[Agent Event: Task Completed]` 事件唤醒你；**不要**根据工具返回值就宣称任务已完成。
- **过渡护栏（scope B 之前）**：因为暂无 `approval_request` 冒泡，且子 agent 在 edit 模式下可执行破坏性操作，指挥官派任务时应在 `prompt` 里把不可逆 / 危险操作的边界明确写给子 agent。

---

## 6. 前端（极小）

`apps/vibedeckx-ui/components/conversation/main-conversation.tsx` 的 `getToolLabel` 各加一句状态文案：

- `spawnAgentSession` → "Starting a coding agent…"
- `sendToAgentSession` → "Sending a message to the agent…"

default 兜底（`Running ${tool}...`）已可用，**不做自定义卡片**。

---

## 7. 受影响文件

- `packages/vibedeckx/src/chat-session-manager.ts` —— 两个工具 + 系统提示词。
- `apps/vibedeckx-ui/components/conversation/main-conversation.tsx` —— 两条 `getToolLabel` 文案。

无 schema / 存储变更；无路由变更。

---

## 8. 验证

- 后端 type-check：`npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
- 前端 type-check：`cd apps/vibedeckx-ui && npx tsc --noEmit`
- 端到端手测：在一个 workspace 的 Main Chat 里让指挥官 spawn 一个 agent 做小改动 → 确认 agent 窗口出现 session 并执行 → 完成后指挥官被 `[Agent Event: Task Completed]` 唤醒并回报 → 再 `sendToAgentSession` 追加一条指令并确认送达 → 验证边界：已有 agent 时 spawn 被拒、无 agent 时 send 报错、agent 忙时 send 返回"忙"。
