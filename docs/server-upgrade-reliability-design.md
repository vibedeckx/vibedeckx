# Server 可靠性与无感升级演进（设计备忘）

> 状态：**设计备忘**（2026-08-03）。未实施，无排期——本文的作用是把"何时该做什么"
> 的判断标准写死，避免将来凭感觉跳级。
> 姊妹文档：`server-worker-compat-design.md`（版本兼容契约；本文多处依赖其
> additive-only 纪律与 §4.3 金丝雀）。

## 0. 核心前提：session 不跑在 server 上

回答"升级 server 要不要等用户没有 session 在跑"——**不需要，因为 session 根本
不跑在 server 上**。agent 进程（claude/codex）是 worker 在用户自己机器上 spawn
的子进程；SaaS server 只是隧道枢纽 + 元数据存储 + 流转发。server 重启时：

- **正在跑的 agent turn 不死**：worker 上的子进程照常执行，输出持续写入 worker
  侧 MessageStore；
- **worker 自动重连**：reverse-connect client 自带重连循环（含 auth backoff）；
- **浏览器自动重连**：前端 hook 指数退避重连 + 历史回放，断线期间漏掉的 patch
  靠回放补齐；
- **错过的事件不丢**：持久化通知 outbox/inbox（durable milestones）本就为
  "订阅方不在线"设计。

所以单实例升级的真实代价不是杀 session，而是**几秒到几十秒的断流**：进行中的
代理请求 502 一次、流式输出停顿后回放追上、状态点闪灰。这远小于"等空闲窗口"
的代价——用户跨时区后，"没有 session 在跑"的窗口可能根本不存在。

**必须刻意保住的架构性质**：session 状态的权威副本在 worker 上，server 侧全部
是可重建的视图（`remoteSessionMap` 有持久化映射兜底，patch 缓存可从 worker 流
重放恢复）。这是无感升级便宜的根本原因；任何将来的重构若把权威状态挪进
server 进程内存，这份文档的全部结论作废。

## 1. 三档演进（按用户量，不跳级）

### 第一档：把重启做短、做验证（现在就够，成本≈0）

- 部署序列压缩：新镜像预拉取 → 停旧容器 → 起新容器，断流压到秒级；
- 建 **金丝雀 worker**（compat 设计 §4.3，一个容器连生产/staging）——它测的
  恰恰是"部署瞬间旧 worker 能否干净重连"，是本档唯一需要验证的东西，也是
  compat 设计里已画未建的件；
- 前端断流体验柔化：重连指示已有，可加"正在恢复"态替代报错。

### 第二档：状态下沉，为多实例铺路（用户明显多了）

- **SQLite → Postgres**：地基已铺好——storage 层已全异步 + 全 Kysely（当时
  即为 pg 预留，pg 刻意 deferred）；到这档时启用即可。
- 盘点内存态：`remoteSessionMap` 已有持久化映射；纯内存的（patch 缓存、
  `remoteExecutorMap` 等）要么补持久化，要么逐一确认重启后可从 worker 侧重建。

### 第三档：连接层与逻辑层分离（真正的无感）

长连接（隧道 WS、浏览器 WS/SSE）是无感升级的天敌——连接终结在业务进程里，
升级必断。标准解法是拆一层**常驻连接网关**：只持有 WebSocket 和转发、几乎
永不升级；业务逻辑在其后的 app 实例滚动更新，网关平滑切流量，用户与 worker
的连接全程不断（Slack/Discord 类长连接服务的通用形态）。这比"多实例 + 粘性
路由"更彻底。

到这档才出现混版并存（滚动部署期间新旧 server 同时在线），而 compat 设计的
additive-only 纪律已提前解决：

- 新 server ↔ 旧 worker：cross-version e2e 实测的方向；
- 旧 server ↔ 新 worker：additive-only 下自动安全——新 worker 的路由是旧
  worker 的超集，旧 server 的调用全接得住，多报的 capabilities 被忽略。

混合部署需要维护的"版本对应关系"不是矩阵，只有一条约束：**在跑实例中最老者
的 `MIN_WORKER_VERSION` ≤ 全体在线 worker 的版本**，加注册表的 `since` 表。
逐连接的能力判断（`remote_servers.worker_capabilities`）已就位，多实例只是把
同样的判断跑在多个进程里，模型不变。

## 2. 进档依据：观测，不是感觉

- **金丝雀告警频率**（第一档建成即有）→ 重启断流是否真的伤到用户；
- **版本分布页 + 用户量**（compat 设计 Phase 3）→ 何时值得付第二、三档的
  架构成本。

在没有这两项观测之前上多实例/灰度，是为想象中的规模付真实的复杂度。单实例
"蓝绿切换 + 秒级回滚"能拿到灰度九成的价值。
