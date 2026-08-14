# Schedule 提议工具（propose_schedule）设计

> 状态：**V1 已实现**（2026-08-14；设计同日评审后修订：提议幂等与状态恢复
> §3.2、字段映射表 §3、跨 Provider 工具名 §4 第 7 条、V1 非目标 §4.1；
> 实现记录见 §7）。本文记录"agent 主动提议创建定时检查"
> 功能的产品决策与架构设计。依赖已合并的 scheduled tasks 功能与
> cross-remote MCP gateway 的注入基建；不改动 reverse-connect tunnel 契约
> （见 [`server-worker-compat-design.md`](./server-worker-compat-design.md)）。

---

## 1. 问题与产品形态

Agent 会话经常以这样的结论收尾："修复已完成，但 X 需要后续定期观察。"
今天用户要落实这句话，得手动把检查内容拷进一个新 schedule——摩擦大到大多数
"需要观察"最终没人观察。

目标形态：agent 说出"需要定期观察"的同时，**在会话里出现一张确认卡片**，
预填好 name / cron / 检查 prompt / branch，用户一键确认即创建 schedule。

两个关键产品决策：

### 1.1 提示显示在 agent 窗口，不在 Main Chat

- **上下文就地**："需要观察"是 agent 在会话结尾说的，用户正在那个窗口读到它。
  卡片贴着结论出现，认知零跳转；放 Main Chat 等于把一件事拆到两个 surface。
- **预填信息全在会话里**：项目、branch、target（local/remote）、检查什么、
  怎么算回归——只有会话上下文能填好这些。
- **复用既有模式**：`AskUserQuestion` / `ExitPlanMode` 的交互卡片
  （`AgentConversationContext`）已经是"按 tool name 分发专属 UI"的家族，
  本工具是第三个成员。
- 次级 surface 是**完成通知**：bell 通知带"含 1 条 schedule 建议"标记，
  深链回卡片。**不在 V1**（见 §4.1）——它需要服务端从消息流提取提议、通知
  载荷加字段、remote 通知同步与前端导航，是独立一块工作；V1 里用户从既有的
  会话完成通知点进来，滚到会话底部自然看到卡片。Main Chat 如需同能力，把
  同一工具挂进它自己的工具注册表（`project-chat-tools.ts`）即可——工具跟着
  对话走，卡片出现在说这句话的地方。

### 1.2 用工具，不用事后检测

不做"turn 结束后 NLP 扫描最终消息"的检测式方案（误报多、预填质量差）。
给 agent 一个 MCP 工具 `propose_schedule`，由 agent 自己判断时机、自己把检查
prompt 写好——检测准确度与预填质量都由 agent 的语言能力兜底。

MCP 是唯一两家（Claude Code / Codex）通吃的自定义工具扩展面：Codex 只有 MCP；
Claude 的 SDK in-process tools 本质是 MCP over control protocol（我们直接
spawn CLI 讲 stream-json，走不了）；hooks 是拦截器不是工具。

---

## 2. 拓扑：端点永远在本机 loopback

工具语义：

```
propose_schedule { name, cron_expr, prompt | command, timezone? }
```

`prompt` 与 `command` **二选一**，对应 `ScheduledTask.run_type` 的两种取值：
`command` 是直接跑一条 shell 命令（跑测试、打健康检查、看磁盘这类机械检查，
更便宜且结果无歧义），`prompt` 是起一个全新 agent（需要判断力的检查）。
run_type 由"给了哪个字段"推导，而不是再要一个枚举参数——两个字段就不可能
互相矛盾；两个都给或都不给都是参数错误。command 型 schedule 没有 agent，
故 `prompt_provider` 置 null。

其余参数**只包含模型创造性内容**（叫什么、多久跑一次、检查什么）。项目、target、
branch 一律不从模型参数取——模型给的 branch 可能过期或幻觉。它们从**会话的
权威绑定**派生：卡片渲染在会话视图里，前端本来就持有该会话的 project /
branch / target（local 或 remote_server_id），直接预填；branch 在卡片上可改
（比如想把检查挂到 main），create 时 hub 按项目权威校验。`timezone` 是可选
建议，缺省时卡片取浏览器时区。

由 **spawn 该会话的 vibedeckx 进程**在本机 loopback 上提供 streamable-HTTP
MCP 端点。关键在于搞清 remote 会话里各组件跑在哪：

- Remote 会话的 CLI 进程不是 hub spawn 的，是 **worker 上的
  agent-session-manager** spawn 的（hub 只把创建请求经 tunnel proxy 过去）。
  Agent 进程与服务它的 MCP 端点**天然同机**。
- Worker 绑有真实的 loopback 监听：`vibedeckx connect` 启动时调
  `server.startLocal()`（`command.ts`，port 0 随机端口）；tunnel 的 WS 虚拟
  通道自己就在拨 `ws://127.0.0.1:<localPort>`（`reverse-connect-client.ts`）。

所以拓扑是同一份代码、同一个形状：

```
本地会话:  agent(hub 机器)    ──MCP──▶ 127.0.0.1(hub 的 Fastify)
remote:   agent(worker 机器) ──MCP──▶ 127.0.0.1(worker 的 Fastify)
```

Cross-remote gateway 需要 `VIBEDECKX_PUBLIC_URL` 是因为那个工具要**跨机器**
打到 hub；本工具不跨机器，不需要。

**鉴权**：spawn 进程本地签发 session-scoped bearer token、同进程校验
（模板：`cross-remote-mcp-config.ts` 的 `mintCrossRemoteMcpConfig`）。
Handler 从 token 解出 sessionId/userId，不信任工具参数里的身份信息。
不经 tunnel、不涉及 hub 身份体系。

**注入**（照抄 cross-remote 的两条既有路径）：

- Claude Code：扩展 `buildMcpConfigArg`（`protocol/claude-code/cli.ts`），
  `mcpServers` 加 `{ type: "http", url: "http://127.0.0.1:<port>/…",
  headers: { Authorization } }`；同时 `--allowedTools
  mcp__vibedeckx__propose_schedule`，避免非 skip-permissions 模式卡权限提示。
- Codex：照 `protocol/codex/cli.ts` 现有写法加
  `-c mcp_servers.vibedeckx={ url = …, bearer_token_env_var = …,
  default_tools_approval_mode = "approve" }`。生产已在用 Codex 的 HTTP MCP，
  兼容性无需赌。
- **Codex exec 模式（scheduled run 走的一次性路径）不注入**：定时检查任务
  自己不该再提议新 schedule，顺便杜绝自我繁殖。

**Plumbing**：spawn 路径目前不知道自己进程绑定的端口。把 `startLocal` /
`start` 返回的实际端口塞给 agentSessionManager（先例：`command.ts` 里
`suppressTitleGeneration` 的赋值），normal 与 connect 两种启动模式各一处。

---

## 3. 数据流：fire-and-forget，三个动作三条既有通道

把"提议"和"创建"拆开，每个动作走已存在的通道，**不新增任何 worker→hub 路径**：

```
agent ──MCP──▶ worker loopback(校验 cron 等,立即返回 "shown to user")
                    │
                    └─ tool_use 消息 ──既有会话流/tunnel──▶ hub UI 渲染卡片
                                                              │
                                          用户点确认 ──既有 REST──▶ hub 创建 schedule(target=worker)
```

1. **提议**（worker 本地）：handler 只校验参数，返回即结束。唯一产物是会话里
   的一条 `tool_use` + `tool_result` 消息。
2. **展示**（既有会话流）：remote 会话的每条消息本来就经 tunnel 虚拟通道流到
   hub，浏览器订阅的就是这条流。hub 不需要"被通知有提议"——和看到会话里任何
   其他消息是同一件事。
3. **创建**（浏览器→hub）：用户浏览器本来连的就是 hub，点确认调既有
   create-schedule REST。`ScheduledTask`（`storage/types.ts`）各字段的来源
   必须完整映射，不能只靠"调现有接口"带过：

   | ScheduledTask 字段 | 来源 |
   |---|---|
   | `name` / `cron_expr` | 工具参数（卡片可改） |
   | `content` | 工具参数 `prompt` 或 `command`（卡片可改） |
   | `run_type` | 由给了哪个内容字段推导：`prompt` → `'prompt'`，`command` → `'command'` |
   | `prompt_provider` | prompt 型：**当前会话的 agent 类型**（Codex 会话 → codex；不能省略，否则落到默认 provider）；command 型：null |
   | `cwd_mode` / `branch` | `'branch'` + 会话绑定的 branch（卡片可改；null = 主 worktree） |
   | `target` | 会话所在处：local 会话 → `'local'`，remote 会话 → 其 remote_server_id |
   | `project_id` | 会话所属项目（前端会话上下文持有） |
   | `timezone` | 工具参数，缺省取浏览器时区 |
   | `timeout_seconds` | 现有 create 表单的默认值 |

### 3.1 Turn 语义：不阻塞、不等用户

Agent 调用后立刻拿到 tool_result，把话说完，turn 正常结束。用户的确认**不是
对话输入**，发生在对话之外。与 `AskUserQuestion` 的对比：

| | AskUserQuestion | propose_schedule |
|---|---|---|
| tool_result 是什么 | 用户的回答本身 | "提议已展示"的确认 |
| turn 是否阻塞 | 阻塞等用户 | 立即返回 |
| agent 是否需要结果继续 | 需要 | 不需要（提议是终态动作） |

典型场景恰是**用户不在场**：会话跑完，用户几小时后从通知点进来。阻塞式会让
session 挂在 running 等一个可能永远不来的点击，状态机 / 超时 / worker 进程
生命周期全被拖下水。

推论：**agent 永远不知道用户是否确认了**。工具 description 必须约束措辞——
说"已建议创建"，不能说"已为你创建"。

### 3.2 提议身份、幂等创建与状态恢复

"已创建"不能是纯前端内存状态：刷新、换设备、从通知重新进入后，消息历史会
重放，卡片若恢复成可创建态，既丢失"已创建 → 链接"，又会诱发重复创建。

- **提议的稳定 ID = `toolUseId`**。它在消息流里持久存在，重放不变，local 与
  remote 会话统一（remote 会话用 hub 侧的 `remote-` 前缀 session id 定位）。
- **create 请求携带来源**：payload 加可选
  `source: { session_id, tool_use_id }`，hub 持久化到 `scheduled_tasks`
  （两个 nullable 列）。纯 hub 侧改动，worker 不参与。
- **幂等由数据库唯一约束保证，不靠应用层 check-then-insert**（后者在并发下
  有竞态窗口，"双标签页只创建一个"无法可靠成立）：
  `scheduled_tasks` 上建部分唯一索引
  `UNIQUE (source_session_id, source_tool_use_id) WHERE source_tool_use_id
  IS NOT NULL`——session_id 全局唯一且已蕴含项目归属，二元组即完备，无需
  project_id；partial 条件把"普通 schedule 两列为 NULL、不受约束"写成显式
  语义。create 路由捕获约束冲突（或 `ON CONFLICT DO NOTHING` 后回查），
  返回既有 schedule（先到者生效，第二次带不同编辑的提交也返回既有，行为
  确定）。
- **状态恢复**：卡片渲染时按 `source` 查 hub（该项目 schedules 列表带出
  source 字段即可，无需新端点），命中 → 显示"已创建 → 链接"；schedule 被
  删除后卡片自然回到可创建态，语义合理。

---

## 4. V1 范围（决策：fire-and-forget，无去重）

去重留给人：卡片上放"查看现有 schedules"链接，用户确认前顺手一瞥即完成人肉
去重。V1 不新增 tunnel 契约面、不建同步机制。清单七件事：

1. **MCP 端点**：Fastify 挂 streamable-HTTP 端点（可用
   `@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport` 桥接，或照
   cross-remote 服务端手写 initialize / tools/list / tools/call），只暴露
   `propose_schedule`；handler 校验 cron 合法性后返回。hub 与 worker 同一份代码。
2. **Token**：本地签发 + 校验 session-scoped bearer token。
3. **注入**：Claude `--mcp-config` + allowlist；Codex app-server 模式
   `-c mcp_servers.…`；exec 模式不注入。
4. **端口 plumbing**：实际绑定端口塞给 agent-session-manager（两种启动模式）。
5. **前端卡片**：`agent-message.tsx` 按规范化工具名分发（见第 7 条）；
   name/cron/prompt/branch 可编辑，project/target/branch 预填自会话绑定
   （§2）；确认 → create-schedule REST（字段映射见 §3，携带 `source`）；
   成功后变"已创建 → 链接"。**状态由 §3.2 的持久化关联恢复，不用
   messageIndex 失效逻辑**——对话继续、刷新、换设备后卡片状态一致，且必须
   依然可点（用户往往聊完整个话题才回头决定）。忽略即无副作用；可选加一个
   本地 dismissed 折叠态，不持久化要求。
6. **工具 description**：写清触发时机（"当你告知用户某修复需后续定期观察时
   调用"）+ 措辞约束（§3.1）。另外：**生成的 prompt 必须自包含**——scheduled
   run 是全新 agent，没有原会话上下文，检查什么、判定标准、异常时写什么进
   report，都要写进 `content`。
7. **跨 Provider 工具名规范化 + 契约测试**：两家 CLI 上报的 MCP 工具名形状
   不同——Claude 是 `mcp__vibedeckx__propose_schedule`；Codex provider 目前
   把 `mcpToolCall.tool` 原样透传（`codex-provider.ts` 的 `case "mcpToolCall"`，
   schema 只捕获裸 `tool` 字段），不规范化的话 Codex 的调用会落进普通 MCP
   工具渲染、不出卡片。做法：**在 provider 层把本工具归一成规范名**（Codex
   provider 识别自家 server 的该工具、映射为 canonical
   `mcp__vibedeckx__propose_schedule`），前端只匹配一个名字；两端各录一份
   真实 CLI fixture 进 `protocol/` 的契约测试，钉死实际上报形状（Codex 的
   `tool` 字段是裸名还是带 server 前缀，以 fixture 为准，不靠猜）。

**兼容性**：工具由 worker 侧代码提供，老 worker 不注入它 → agent 看不到工具
→ 不产生这类消息 → 前端无卡片。天然 additive-only 降级，不碰 capability
registry。`scheduled_tasks` 的 `source` 两列是 hub 侧 additive 迁移，与
worker 版本无关。

### 4.1 V1 非目标（明确移出，防止范围蔓延）

- 完成通知的"含 schedule 建议"标记与深链（§1.1）——独立工作块，见该节说明。
- 去重（§5 的全部三级）。
- Agent 得知用户是否确认（若将来要做，走 durable-milestone 消息注入，见 §6）。
- Main Chat 侧挂载同一工具。

### 4.2 验收要点

- **状态恢复**：确认创建后刷新页面 / 换设备 / 从通知重进，卡片显示
  "已创建 → 链接"；删除该 schedule 后卡片回到可创建态。
- **幂等**：双击确认、两个标签页各确认一次，只产生一个 schedule。
- **失败路径**：create REST 失败时卡片展示错误并可重试，不落入假"已创建"态。
- **双 Provider**：Claude 与 Codex 会话各跑一次，卡片均正确渲染（契约
  fixture + 手工各一遍）。
- **Remote**：remote 会话提议 → 确认，schedule 落 hub、`target` 为该 worker、
  `prompt_provider` 为该会话的 agent 类型；到点在 worker 上执行。
- **老 worker**：旧版本 worker 的会话无此工具、无卡片，其余功能不受影响。

---

## 5. 去重的升级梯子（暂缓，按序建）

只有当"重复提议"的噪音被实际观察到时才投入。Handler 从一开始就写成只读
"本地 schedule 视图"、不关心视图从哪来，三级升级对 handler / 工具语义 / 前端
零改动：

1. **B — 会话创建时快照**：hub 在 session-create payload 里附该项目现有
   schedules 摘要（name / cron / prompt 首行 / target），additive 字段，老
   worker 忽略。handler 同步查本地视图，tool_result 可带 `{ duplicate }`，
   agent 能在**同一个 turn** 内改口"已有相似，建议合并"。本地会话直查
   storage，天然新鲜。
2. **C — 确认时权威校验**：UI 预取 + hub create 路由做最终防线，卡片显示
   "已存在相似：X → 查看"。**任何时候建去重，这层都必须有**——快照 by design
   是旧的，确认时刻的检查才是权威。
3. **持续 state-sync（体验上限）**：hub→worker 推送（既有契约方向），worker
   侧内存视图（`Map<projectId, ScheduleSummary[]>`，重连全量 + 变更增量，
   不落库）。帧设计成可扩展的 `{ kind: "state-sync", type: "schedules", … }`
   ——这条管道一旦建立，worker 侧工具需要的其他 hub 权威数据（项目配置、
   通知偏好）都是再挂一种 type。需在 `reverse-connect-capabilities.ts` 注册，
   性质纯 additive。

判断快照够不够的观测点：会话实际时长分布——快照与持续同步的差别只在
"会话开了很久之后别人新建了相似 schedule"的窗口里显现。

---

## 6. 否掉的方案（及理由，防止重新发明）

- **事后 NLP 检测最终消息**：误报多、预填差；agent 自带判断力，用工具。
- **阻塞式工具（等用户确认）**：用户不在场是主场景，turn 会挂死（§3.1）。
- **Worker→hub RPC（handler 直接查 hub）**：tunnel 的 RPC 方向是 hub→worker；
  反向调用把版本矩阵翻倍（兼容体系是"新 hub 优雅对待老 worker"，反向要
  "新 worker 优雅对待老 hub"）。为 advisory 去重开这个口不值。若将来因别的
  功能建了通用 worker→hub RPC，此选项才变便宜。
- **Hub 经对话消息把查询结果"返回"给 agent**：机制可行（hub 在服务端消费
  remote 会话流——先例是 remote 标题生成；hub→worker send-message 是既有路径），
  但信息**晚到一整个 turn**：agent 已把提议说出口、卡片已渲染，只能事后自我
  纠正，还需引入提议撤回语义 + 与用户确认的竞态 + 自动唤醒 turn 的状态机副作用。
  一般化的判断标准：**调用时刻可确定的信息 → 同步 tool_result；真正异步的事件
  → 消息注入**（后者的正当场景是 durable-milestone 模式，比如将来若要把
  "用户已确认"回报给 agent）。
- **Hub 替 worker 回答 pending tool call**：不可能——CLI 阻塞等的是 worker
  loopback 上的 MCP HTTP 响应，tool_result 只能由拥有工具的 MCP server 返回。

---

## 7. 实现记录（2026-08-14）

§4 的七件事全部落地，落点如下（V1 非目标 §4.1 一件未做）：

| 清单项 | 落点 |
|---|---|
| MCP 端点 | `routes/session-mcp-routes.ts`（手写 initialize / ping / tools/list / tools/call） |
| 契约与工具语义 | `session-tools-mcp.ts`（路径、工具名、description、参数校验、mint）——不依赖 Fastify，故 provider 层可直接 import |
| Token | `utils/session-tools-token.ts`，独立 secret（`session_tools_token_secret`）与 cross-remote 完全隔离 |
| 注入 | Claude：`protocol/claude-code/cli.ts` 的 `buildClaudeMcpConfigArg`（多 server 合并）+ `--allowedTools`；Codex：`protocol/codex/cli.ts` 的 `mcp_servers.vibedeckx`；exec 模式未注入 |
| 端口 plumbing | `server.ts` 的 `start` / `startLocal` 绑定后写 `agentSessionManager.localApiOrigin`；spawn 时在 `startProcess` 内 mint（token 随进程生灭，不持久化） |
| 幂等与状态恢复 | `scheduled_tasks.source_session_id/source_tool_use_id` + 部分唯一索引 `idx_scheduled_tasks_source`；create 路由 replay 返回 200 |
| 前端卡片 | `components/agent/schedule-proposal.tsx` + `hooks/use-proposed-schedule.ts`（按 project 共享一次拉取，schedule:* 事件失效重取） |
| 跨 Provider 工具名 | provider 层归一 + 离线 fixture 契约测试 `protocol/session-mcp-tool-name.test.ts` |

三处与设计文本的偏离/补充，都是实现时才能确定的事实：

1. **Codex 的上报形状已实测钉死**：`{ server: "vibedeckx", tool: "propose_schedule" }`
   ——裸工具名 + 独立 server 字段（codex-cli 0.147.0）。因此归一函数
   `canonicalizeSessionToolName(tool, server?)` 在有 server 时以 server 为准，
   别家 server 的同名 `propose_schedule` 不会被冒认。Claude 侧实测即
   `mcp__vibedeckx__propose_schedule`（claude 2.1.231）。两端各录一份真实
   transcript 进 `__fixtures__/session-mcp-tool-call.jsonl`，另有 live 探针
   CC-7b / CX-SM1（`pnpm test:compat`）。
2. **本机 TLS 终止时不注入**：`--tls` 的 hub 上 loopback 只有 https，公网证书
   过不了 hostname 校验，故 `localApiOrigin` 置 null、工具不提供（该 hub 的
   remote 会话不受影响——worker 永远是明文 loopback）。这是 §2 "端点永远在本机
   loopback"的唯一例外。
3. **source 必须解析到本项目的会话，两种会话都要查**：source 二元组是**全局**
   幂等键，若不校验，A 项目可占用 B 项目会话的键位——真正的确认插入撞唯一索引、
   又查不到自己那行，提议永远无法被接受。local 会话是 `agent_sessions` 行；
   remote 会话在 hub 上**没有** `agent_sessions` 行，只有
   `remote_session_mappings`（按 `remote-` 前缀的 local id 存），所以要走
   `getAuthorizedByLocal(sessionId, projectId)`（它同时要求 project→remote
   关联仍在）。两处都解析不到即拒绝，不放行。仓储层的 source 查询也按 project
   收窄。

4. **创建必须广播**（实测补丁）：schedule 的增删改此前不发任何全局事件——只有
   run 的开始/结束发。侧边栏那份列表由 `useSchedules` 持有，卡片是从 agent
   窗口直接调 create REST 的，不经过它，所以新 schedule 要刷新页面才出现。
   现在 create / update / delete 各发一条
   `schedule:changed { projectId, scheduleId, change }`；前端两个消费者
   （`useSchedules`、`useProposedSchedule`）本来就按 `schedule:` 前缀 + projectId
   重取，无需前端改动，顺带让多标签页/多设备也同步。幂等 replay 什么都没改，
   不发事件。

5. **command 型提议**（后补）：v1 初版只能提 prompt 型，但 `ScheduledTask`
   本来就支持 command。工具改为 `prompt | command` 二选一（见 §2），卡片按
   kind 切换输入框（command 用等宽、占位文案不同）并在确认时带上对应的
   `run_type` / `prompt_provider`。若模型两个字段都给了，工具报错；而卡片仍会
   渲染（卡片来自 tool_use 消息，与校验结果无关），此时**回退到 prompt**——
   给一个含糊提议配一个"直接建 shell 命令"的确认按钮不合适。

验收（§4.2）覆盖情况：状态恢复、幂等（含并发）、失败重试、双 Provider、
老 worker 降级均有自动化测试；remote 端到端（提议 → 确认 → 到点在 worker 执行）
仍需一次人工验证。
