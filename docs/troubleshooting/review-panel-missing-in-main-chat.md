# Review 跑完了，Main Chat 顶部却没有 review 面板

> 状态：**根因已确认、已修复**（2026-08-18）。推送帧落在 Main Chat WebSocket 的
> 一段断线空窗里被丢弃，而 `ReviewRunPanel` 没有任何补偿路径。两处修复见文末。

## 症状

Reviewer session 正常跑完（会话里能看到完整的 review 正文，通知铃也响了），
但 Main Chat 顶部始终没有出现 `ReviewRunPanel` —— 也就是那块显示
「等你确认反馈」和编辑/发送按钮的面板。用户侧的表现是 review 结果无处可点，
看起来就像 review 从来没跑过。

关键特征：面板**不会自己恢复**。不切工作区、不刷新页面的话，可以一直空着。

## 根因

面板的数据只有两个来源：

1. **推送**：worker 的 WorkflowEngine 把 run 迁移镜像到参与者 session 流 →
   hub 的 `remote-agent-sessions.ts` 收到 `workflowRunUpdated` 后 re-emit 到
   eventBus → `ChatSessionManager.handleWorkflowRunUpdated` 按 `projectId:branch`
   找到 Main Chat 的 chat session → 推 `WorkflowRunUpdated` 帧。
2. **拉取**：`ReviewRunPanel` 的 `GET /api/workflow-runs?projectId&branch`，
   只在面板 mount、props 变化、收到推送帧、以及 **runs 非空时**的 5s 轮询时发生。

**推送是 fire-and-forget，没有重放；而面板为空时不轮询、WS 重连后也不对账。**
于是只要那一帧发出时 Main Chat 的 socket 不在，面板就永久空白 —— 没有任何东西
会去拉第二次。

2026-08-18 的实测时间线（hub 日志 + 浏览器 HAR）：

```
~14:04    浏览器整体停止回 pong
14:05:04  服务端心跳回收 AgentWS
14:05:15  服务端心跳回收 ChatWS 0fe6014b 和 ExecutorMux
          [WsHeartbeat] ChatWS session=0fe6014b…: no pong within 60000ms — terminating dead socket
          ↓  ← 断线 641 秒
14:13:55  run 创建 → WorkflowRunUpdated 推送 → 丢弃（0 个活订阅者）
14:15:56  run → waiting_feedback → WorkflowRunUpdated 推送 → 丢弃
14:15:57  页面恢复，Main Chat WS 重连（比第二帧晚 1.05 秒）
```

重连会重放 686 条聊天历史 patch，**但 `WorkflowRunUpdated` 不在重放范围内**，
面板也不会因为重连去补一次 REST。HAR 佐证：随后 15 分钟里，尽管那条 run 一直
活着，浏览器**一次 `GET /api/workflow-runs` 都没发过**。

### 为什么 WS 会断这么久

**不是服务端漏了防护。** Main Chat 的 WS 一样挂了 `attachWsHeartbeat`，14:05:15 正是
它按设计终止了这条 socket（ping 连续两个 30s 周期无 pong）。同一时刻该浏览器的
AgentWS 和 ExecutorMux 也被一起回收 —— 是这个页面在网络层整体不再回 pong。

**掉线不奇怪，躺 641 秒才是缺陷。** 同一个页面的 agent session WS 提供了现成的对照：

```
14:05:04  [WsHeartbeat] AgentWS …89f9efa6…: no pong within 60000ms   ← 一起被回收
14:05:42  [AgentWS] Client connected …89f9efa6…                       ← 38 秒后自愈
14:13:56  [AgentWS] Client connected …9ac6e3b6…                       ← 还跟着 review 切了会话
```

页面一直在跑 JS。差别只在于 hook：

| | Agent session WS | Main Chat (chat session) WS（修复前） |
|---|---|---|
| 服务端心跳 ping/pong | 有 | 有 |
| 服务端 `{keepalive}` 应用帧 | 有（30s） | **无** |
| 客户端静默看门狗 | 有（`SILENCE_TIMEOUT_MS = 95s`） | **无** |
| 恢复时机 | ≤95 秒 | 只有 `visibilitychange`（这次是 641 秒） |

浏览器不向 JS 暴露 pong，所以客户端只能靠应用层帧判断活性；而这条 socket 空闲时
本来就一条帧都不收，**「死了」和「闲着」在浏览器看来完全一样**。时序也对得上：
pong 约在 14:04:04 停止 → 服务端 60s 后回收 → agent 客户端 95s 静默超时（约
14:05:39）触发重连 → 14:05:42 连上；chat hook 没有这个计时器，一直等到 14:15:57
`visibilitychange` 才恢复。

另外，这条 socket 日常每 1–5 分钟就重连一次（HAR 里 15 分钟内 4 次），每次 1–3 秒
空窗 —— 即便没有这次的长断线，review 恰好在空窗里完成的概率也并不低。这就是为什么
面板的重连对账（修复 1）无论如何都要做。

## 复现与确认

先确认引擎侧是好的（面板不出现≠review 失败）。去 run 所在的机器查库：

```bash
sqlite3 -header -line 'file:~/.vibedeckx/data.sqlite?mode=ro' \
  "select id, quote(branch), status, source_session_id, reviewer_session_id,
          substr(feedback_snapshot,1,120), created_at, updated_at
     from workflow_runs order by created_at desc limit 5;"
```

`status = waiting_feedback` 且 `feedback_snapshot` 有正文 → WorkflowEngine 正常，
问题在送达。再核对 Main Chat WS 在那一刻在不在：

```bash
grep -F '[ChatWS]' <hub-log> | grep <chat-session-id>   # connected / disconnected 成对出现
```

把 run 的 `updated_at` 落到某个 `disconnected → connected` 的空窗里，就坐实了。

### 排除项：branch 作用域

`getActive` 用精确匹配（`where("branch", "is", branch)`），run 的 branch 取自
**源 session**。源 session 在根工作区时 run 的 branch 是 `NULL`，此时 UI 停在任何
worktree 工作区都看不到它 —— 这是设计如此，但容易被误认成本文的故障。判别方法：

```bash
curl -s "http://127.0.0.1:<worker-port>/api/path/workflow-runs?path=<remote_path>"
curl -s "http://127.0.0.1:<worker-port>/api/path/workflow-runs?path=<remote_path>&branch=main"
```

根工作区就是侧边栏工作区列表里通常标着 `main` 的那一行：它没有 branch 身份
（`wt.branch === null`，`main` 只是占位标签，服务端报了 anchored branch 时会改显示
那个名字），checkout 路径是仓库本体而不是 `worktrees/` 下的副本。

## 日志判读

以下日志是 2026-08-18 补的（`chore: log review-run delivery on push and pull paths`），
在 hub 侧按 info 输出：

| 日志 | 含义 |
|---|---|
| `[ChatSession] WorkflowRunUpdated dropped: no chat session for run=… key="<project>:<branch>", indexed=[…]` | 推送到达了，但这个 project+branch 没有 Main Chat 会话。对比 `indexed` 的 key 可看出是否 branch 对不上 |
| `[ChatSession] WorkflowRunUpdated dropped: … live=0/N` | 找到了会话但没有一个 socket 处于 `OPEN` —— **本文故障的特征行** |
| `[ChatSession] WorkflowRunUpdated sent: … live=N/M` | 服务端向 N 个自认为 `OPEN` 的 socket 调了 `send()`。**这不是送达确认**：没有浏览器 ACK，尚未被心跳回收的僵尸 socket 也会计入 `live`。要确认真的收到，得配合浏览器侧（HAR / DevTools 的 WS Messages） |
| `[ChatSession] subscribe/unsubscribe chat=… project=… branch=… subscribers=N` | 某时刻 Main Chat 的 socket 在不在、绑在哪个工作区 |
| `[workflow-runs] read project=… branch=… source=local\|remote:<id> active=N` | 客户端到底问没问、带的哪个 branch、拿回几条 |

> 通用访问日志帮不上忙：2xx 走 `debug`（生产跑在 `info`），且按设计只记 route
> pattern 不记 query string（WS/SSE 的 token 走在 query 里）。关键字段必须在业务处
> 显式打点。

## 临时绕过

切到别的工作区再切回 **run 所属的那个工作区**（run 的 branch 见上面的 SQL；源
session 在根工作区时就是标着 `main` 的那一行），或者直接在正确的工作区刷新页面 ——
面板会因 remount 重新拉一次 REST 而出现。run 仍在 `waiting_feedback`，review 正文和
发送按钮都还在，没有数据丢失。

## 修复

1. **面板对账（主因）**：`ReviewRunPanel` 在 chat WS 每次 `Ready`（含重连、
   visibility recovery）时做一次 `refresh({ force: true })` —— `useChatSession`
   新导出的 `streamEpoch` 就是这个信号，形状照搬 `use-reviewer-run.ts` 里早已存在
   的同名对账（reviewer 的终稿按钮一直有这层兜底，面板漏了）。
   断线本身无法避免，能改的只有「重连后要自己补一次」，所以这一条无论如何都要做。
   回归测试见 `review-run-panel.test.tsx` 的 “WS reconnect reconciliation”。

2. **Main Chat WS 的僵尸连接感知（本次 641 秒的成因）**：`websocket-routes.ts` 的
   `attachWsHeartbeat` 补上 `keepalive: true`，`use-chat-session.ts` 补上与
   `use-agent-session.ts` 同款的 95s silence watchdog。
   这一条不是可有可无的纵深防御：页面当时**一直在跑**（同一浏览器的 agent WS 在
   14:05:42 就自愈重连了，14:13:56 还跟着 review 切了会话），只是 chat hook 没有
   任何能发现死 socket 的代码，才躺了 641 秒。装上后同样的掉线约 14:06:40 就该恢复，
   早于 14:13:55 的第一帧。

## 修好之后怎么验证还没坏

`[ChatSession] WorkflowRunUpdated dropped: … live=0/N` 这一行的语义从「查根因」变成
了回归信号：正常情况下它应该几乎不出现。如果它又频繁出现，说明 socket 又在长时间
掉线而没被 watchdog 发现，或者对账没跑起来。
