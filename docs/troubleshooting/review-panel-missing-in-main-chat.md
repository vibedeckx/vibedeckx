# Review 跑完了，Main Chat 顶部却没有 review 面板

> 状态：**根因未定论**。本文给出的是如何在下一次复现时一次定位到底是哪一段断了，
> 以及 2026-08-18 那次事故已经排除了什么。

## 症状

Reviewer session 正常跑完（会话里能看到完整的 review 正文，通知铃也响了），
但 Main Chat 顶部始终没有出现 `ReviewRunPanel` —— 也就是那块显示
「等你确认反馈」和编辑/发送按钮的面板。用户侧的表现是 review 结果无处可点，
看起来就像 review 从来没跑过。

关键特征：面板**不会自己恢复**。不切工作区、不刷新页面的话，可以一直空着。

## 先确认引擎侧是不是好的

面板不出现≠review 失败。先去 run 所在的机器（远程项目是 worker）查库：

```bash
sqlite3 -header -line 'file:~/.vibedeckx/data.sqlite?mode=ro' \
  "select id, quote(branch), status, source_session_id, reviewer_session_id,
          substr(feedback_snapshot,1,120), created_at, updated_at
     from workflow_runs order by created_at desc limit 5;"
```

`status` 落在 `waiting_feedback` 且 `feedback_snapshot` 有正文，就说明
WorkflowEngine 这一侧完全正常，问题纯粹在「这条 run 有没有送达 UI」。

再直接问一次 worker 的读取接口，把 branch 作用域也一起验掉：

```bash
# 不带 branch：应当返回这条 run
curl -s "http://127.0.0.1:<worker-port>/api/path/workflow-runs?path=<remote_path>"
# 带上某个 worktree 的 branch：预期为空
curl -s "http://127.0.0.1:<worker-port>/api/path/workflow-runs?path=<remote_path>&branch=main"
```

`getActive` 用的是精确匹配（`where("branch", "is", branch)`），run 的 branch 取自
**源 session**。源 session 在根工作区时 run 的 branch 是 `NULL`，此时 UI 只要停在
任何一个 worktree 工作区就永远看不到它 —— 这是设计如此，不是 bug，但很容易被
误认成丢数据。

## 判别实验（不用发版）

只要那条 run 还在 `waiting_feedback`，就还是活体样本。切到该项目的**根工作区**
并刷新页面。根工作区就是侧边栏工作区列表里通常标着 `main` 的那一行：它没有
branch 身份（`wt.branch === null`，`main` 只是占位标签，服务端报了 anchored branch
时会改显示那个名字），checkout 路径是仓库本体而不是 `worktrees/` 下的副本。



- **面板出现** → 拉取（REST）这一侧是好的，问题在推送侧：帧发出时 Main Chat 的
  socket 不在，或该 project+branch 的 chat session 不在 `sessionIndex` 里。
- **面板不出现** → 问题在拉取侧，去查 hub 的远程代理和 branch 取值。

## 两条送达路径

面板的数据只有两个来源，任何一条断了都表现为「面板空着」：

1. **推送**：worker 的 WorkflowEngine 把 run 迁移镜像到参与者 session 流 →
   hub 的 `remote-agent-sessions.ts` 收到 `workflowRunUpdated` 后 re-emit 到
   eventBus → `ChatSessionManager.handleWorkflowRunUpdated` 按
   `projectId:branch` 找到 Main Chat 的 chat session → 推 `WorkflowRunUpdated` 帧。
2. **拉取**：`ReviewRunPanel` 的 `GET /api/workflow-runs?projectId&branch`。

**结构性缺口（尚未修）**：拉取只发生在面板 mount、props 变化、收到推送帧、
以及 *runs 非空时* 的 5s 轮询。面板当前为空时**不轮询**，WS 重连后也**不对账**。
所以只要那一帧丢了，就没有任何东西会再去拉第二次。

## 日志判读

以下三条日志是 2026-08-18 之后补的（`chore: log review-run delivery on push and pull paths`），
在 hub 侧按 info 输出，正是当时缺失的那三段证据：

| 日志 | 含义 |
|---|---|
| `[ChatSession] WorkflowRunUpdated dropped: no chat session for run=… key="<project>:<branch>", indexed=[…]` | 推送到达了，但这个 project+branch 没有 Main Chat 会话。对比 `indexed` 里的 key 就能看出是不是 branch 对不上 |
| `[ChatSession] WorkflowRunUpdated dropped: … live=0/N` | 找到了会话，但没有活着的 socket（典型是 WS 正在重连）。帧就是在这里丢的 |
| `[ChatSession] WorkflowRunUpdated sent: … live=N/M` | 推送成功送到浏览器。此时问题在前端 |
| `[ChatSession] subscribe/unsubscribe chat=… project=… branch=… subscribers=N` | 回答「某时刻 Main Chat 的 socket 在不在、绑在哪个工作区」。原生的 `[WS] Upgrade` 只有不透明的 chat session id |
| `[workflow-runs] read project=… branch=… source=local\|remote:<id> active=N` | 客户端到底问没问、带的哪个 branch、拿回几条 |

有了这三条，症状可以直接三选一：**客户端没问 / 问错了 branch / 问对了但推送丢了**。

> 注意通用访问日志帮不上忙：2xx 走 `debug`（生产跑在 `info`），而且按设计只记
> route pattern 不记 query string（WS/SSE 的 token 走在 query 里）。所以关键字段
> 必须在业务处显式打点，这也是上面几条日志存在的理由。

## 2026-08-18 那次已经排除了什么

- 引擎侧正常：run `69d36fa5…` 停在 `waiting_feedback`，review 正文完整落库。
- hub 两帧都收到了（`14:13:55` 创建、`14:15:56` 迁移），并且都 re-emit 了。
- `review_ready` 通知同步到 hub 后 **736ms** 就被标记已读；唯一能这么快自动已读的
  路径是 `use-completion-notifications.ts` 的 `onScreen`
  （`notification.session_id === activeSessionId`）。该通知挂在 reviewer session 上，
  说明当时用户屏幕上开着的正是那个 reviewer session，UI 停在根工作区
  —— 由此基本排除「停在别的 worktree 导致 branch 不匹配」。
- 剩下的嫌疑是推送帧没落到 Main Chat：日志显示迁移帧发出后 **1.05s** 才有一次
  chat-session stream 的 WS upgrade。但 chat session 是纯内存 `Map`，事后无法重建，
  所以这条只是吻合，不是定论。

## 修复顺序（重要）

给面板加「WS 重连即 force 刷新」的兜底是最终修，但**先别加** —— 它会把现象盖掉，
等于放弃拿到定论。建议顺序：

1. 部署上面的日志（hub 侧即可，worker 不用先发版）；
2. 复现一次，用日志判读表定位；
3. 再上兜底（对账逻辑可参考 `use-reviewer-run.ts` 里 `streamEpoch` 的 Ready 对账）。
