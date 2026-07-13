# Subagent 完成语义：Claude Code 与 Codex 的两种模型

> 状态：**已实现**（2026-07-13）。本文记录两家 CLI 在"主 agent + 后台子代理"场景下
> 截然不同的协议模型，以及 vibedeckx 的统一完成状态机（`packages/vibedeckx/src/turn-completion.ts`）
> 如何同时正确服务两者。所有协议事实均来自对真实 CLI 的带时间戳探测
> （Claude Code 2.1.205、Codex 0.144.3），录制夹具见
> `packages/vibedeckx/src/protocol/claude-code/__fixtures__/` 与
> `packages/vibedeckx/src/protocol/codex/__fixtures__/subagent-session.jsonl`。

---

## 要解决的问题

会话的"已完成"（工作区绿点 + 完成提示音 + `markCompleted` + 任务自动标 done）应当在
**整次交互的全部产出——包括子代理的——都落地之后**恰好触发一次。两家 CLI 的原始实现都会
在子代理仍在运行时提前完成，且可能重复响铃；但两者的病因不同，因为它们的子代理抽象不同。

## Claude Code：父子任务模型

`Agent(run_in_background: true)` 在语义上是**父 agent 拥有的一个后台任务**，结果归属父 agent。
因此 harness 会替父 agent 做主：任务结束时注入一条合成的 task-notification 用户消息、
**自动开启唤醒轮**，让父 agent 消费结果并收尾。"轮次"的边界为此被弄软了——一次用户请求
可以产生多条 `result`，只有最后一条才是真正的收尾。

实测的关键协议事实（详见 `turn-completion.ts` 头注）：

- 子代理生命周期通过 `system/task_started` / `task_notification` 事件广播；快任务的通知
  可以**先于**当前轮的 `result` 到达（账本此时已空 → 原实现提前完成的根因）。
- 每个轮次（含自动唤醒轮）开头都有 `system/init`，在上一条 `result` 后 **~15–20ms** 到达；
  而唤醒轮的第一条 assistant 事件要等完整 LLM 往返（实测 4.5–4.8 秒）。因此 `init` 是唯一
  来得及取消宽限提交的信号。
- 通知也可能在**轮内**被消费（主 agent 仍在干活时任务结束）——此时没有独立唤醒轮、没有
  额外 `result`。
- 子代理自己启动的嵌套任务，其生命周期事件混在主流里且**无法与主层任务区分**；它们的通知
  唤醒的是子代理而非主 agent。任何"欠账/消账"式的轮次计数因此必然卡死，这是选择
  宽限提交而非计数的原因。

## Codex：对等代理 + 显式消息传递模型

Codex 的 collab 工具集（`spawn_agent` / `send_message` / `wait` / `close_agent`）把子代理
建模为**平级的兄弟线程**：它在同一 app-server 进程里拥有自己完整的 `thread/started`、
独立的 `threadId`，其 `turn/*`、`item/*`、token 事件全部复用主会话 stdout，仅靠
`params.threadId` 区分。通信必须显式发生：

- 主 agent 需要结果 → 在**本轮内**调 `wait` 阻塞等待。主线程的 turn 不会结束，拿到结果后
  由主 agent 给最终结论（对应 Claude 的"轮内消费"路径，完成语义天然正确）。
- 主 agent 选择 fire-and-forget → 意味着"本轮不消费这个结果"。实测确认：子代理完成后
  **codex 不会自动唤醒主线程**（探测中静默 219 秒）。结果留在子代理线程里，等下一次用户
  输入开启新轮时主 agent 才可能去取。

这个"不自动唤醒"是自洽的设计：Codex 保持严格的轮次语义——**turn 只由显式输入开启**
（用户消息或 wait 的返回），不存在"没人说话 agent 自己动起来"。计费、权限、可预测性都更
简单；代价是 fire-and-forget 的结果没有收尾轮。在这种模式下，这次交互的最后产出
**事实上就是子代理的输出**（Codex 自家 TUI 会带标签展示子代理活动）。

> 注：以上是从协议行为的推断，collab 在 Codex 中仍是较新特性，不排除上游未来加入自动唤醒。
> 下文的状态机已为此留好路径（主线程 `turn/started` 映射为取消信号），真加了也能正确工作。

## 统一状态机如何同时服务两者

`TurnCompletionLedger`（纯状态机，manager 通过 per-session 串行队列驱动副作用）：

- **活跃任务集合**：Claude 由 `task_started`/`task_notification`（及 `background_tasks_changed`
  快照校准）喂入；Codex 由 `subAgentActivity(kind:"started")` + 外部线程的 `turn/started`
  双信号喂入（Set 幂等去重），外部线程的 `turn/completed` 清除。
- **停驻（park）而非丢弃**：`result` 到达时若任务集合非空，候选连同其 duration/tokens/cost
  被**保留**、不设计时器。这是两模型分歧的交汇点——Claude 有唤醒轮，停驻候选会被唤醒轮的
  `init`（`turn_started` 事件）在 ~20ms 内取消、由真正的最终 `result` 接管；Codex 没有唤醒轮，
  **最后一个子代理结束（任务集合清空）是提交这条主 result 的唯一机会**，此时安排宽限提交。
  若像最初 Claude-only 设计那样丢弃被延迟的 result，Codex 会永久卡在 running。
- **宽限窗口（1.5s）+ 零延迟快路径**：本轮没出现过任何后台任务活动的 result 立即提交
  （绝大多数轮次无延迟）；出现过的持有宽限，由 `turn_started`（Claude 的 `system/init` /
  Codex 主线程的 `turn/started`）及时取消误判候选。
- **线程过滤（Codex 特有）**：外部 `threadId` 的事件绝不当作主会话活动——否则子代理的
  `turn/completed` 会伪造主 `result`（多余响铃）、子代理消息会混入主对话、其 turnId 会污染
  中断目标与 token 统计。

验证：离线全量测试（状态机 + 真实录制的 manager 回放，断言各副作用恰好一次）+
`pnpm test:compat` 下的 live 探测 MGR-1（claude）/ MGR-2（codex），均对真实 CLI 通过。

## 已知后续

- **子代理活动的 UI 渲染**：线程过滤修正了"子代理输出冒充主 agent 消息"的 bug，但代价是
  Codex 子代理的输出目前在界面上不可见（仅 `collabAgentToolCall` 的 Agent tool_use 显示
  spawn）。理想形态是像 Codex TUI 那样带标签的嵌套渲染。
- 上游若为 fire-and-forget 增加自动唤醒，现有取消信号路径可直接吸收，无需改动状态机。
