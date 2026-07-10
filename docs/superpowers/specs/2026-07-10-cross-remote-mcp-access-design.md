# 跨 Remote 访问（Cross-Remote MCP Gateway）设计

> 状态：**设计已确认，待实现**（2026-07-10，同日按外部评审吸收修订）。

## 背景与目标

Server 端部署为 SaaS 服务，用户的多台机器各自运行 vibedeckx remote 端（通过
reverse-connect 反连到 server）。目标场景：**remote B 上没有安装 agent（Claude
Code），需要让 remote A 上运行的 agent 能连到 remote B，检查/诊断 B 系统上的问
题**（看日志、查进程、读配置等）。

因为 B 上无法 spawn agent 会话，commander 的 spawn/send 原语不适用；A 的 agent
需要拿到能直接操作 B 的低级工具。

## 拓扑约束与总体方案

Remote 之间没有直接网络可达性（通常都在 NAT 后），所有跨 remote 流量必须经
SaaS server 中继。方案：**在 server 端实现一个跨 remote 的 MCP 网关**，A 上的
claude 进程作为 MCP client 直连它；网关鉴权后复用现有 reverse-connect 通道把调
用转发给 B 的 remote 端执行。

```
claude@A ──(新增: HTTPS streamable-HTTP MCP + scoped token)──▶ SaaS server 网关
                                                                   │
                                                                   ▼ (复用: 现有 reverse-connect WS，
                                                                      server→remote 方向，协议零改动)
                                                              remote端@B ──一次性 exec──▶ 结果原路返回
```

关键决策：

- **A→server 一段不走 A 的 reverse-connect WS**。现有反连协议是单向 RPC
  （`HttpRequestFrame` 只有 server→remote 方向），remote 主动发起请求需要新增
  帧类型，协议改动大且无必要——A 对 server 本来就有出站 HTTPS 可达性，且
  streamable HTTP 是 Claude Code `--mcp-config` 原生支持的 transport。
- **server→B 一段对 B 而言就是一次普通的 server 发起调用**，B 端感知不到请求
  最初来源是另一个 remote。传输层零改动。
- 所有跨机流量必经 server，租户隔离、审计、（未来的）审批都集中在 server 一处。

## 组件设计

### 1. Server 端 MCP 网关（新增 `routes/cross-remote-mcp-routes.ts`）

Streamable-HTTP MCP server，endpoint `POST /api/cross-remote-mcp`，鉴权用
Authorization header 中的会话级 scoped token（见下）。工具分两个能力层，对应
目标 remote 的访问级别开关：

| 工具 | 所需级别 | 参数 | 说明 |
|---|---|---|---|
| `list_accessible_remotes` | — | — | 返回同用户下访问级别 ≥ read、且不是发起方自身的 remote（id、name、在线状态、级别） |
| `remote_read_file` | read | `remoteId, path, offset?, limit?` | 读文件，输出截断 64KB |
| `remote_list_dir` | read | `remoteId, path` | 列目录（纯 fs 调用） |
| `remote_stat_path` | read | `remoteId, path` | 文件/目录元信息（纯 fs 调用） |
| `remote_process_list` | read | `remoteId` | 进程列表（remote 端跑 `ps`，输出截断）——诊断刚需，归入 read 层 |
| `remote_bash` | exec | `remoteId, command, cwd?, timeoutSec?` | 一次性执行（非 PTY），返回 stdout/stderr/exit code；默认超时 60s，stdout/stderr 各截断 64KB |

网关每次调用时**实时**校验（全部走同一查询路径）：

1. token 签名有效且未过期；
2. token 中的 sessionId 对应的 agent 会话**仍然存活**（会话结束即失效，见下）；
3. 目标 remote 属于同一 userId；
4. 目标的访问级别 ≥ 该工具所需级别；
5. 目标在线。

任一不满足统一返回 "remote not found or not accessible"（不泄露存在性）。校验
通过后经 `proxyToRemote` 转发到目标 remote 端的内部 exec/fs 路由。

**并发限制**：网关按 sessionId 维护并发上限（4 个 in-flight 调用），超出直接
返回 busy 错误——防止 agent 并行轰炸压垮目标机的反连通道。

### 2. 会话级 scoped token

- Server 在创建（或代理创建）agent 会话时签发：HMAC 签名的无状态 token，载荷
  `{ userId, sessionId, sourceRemoteServerId, iat }`，server 端密钥签名。
  `sourceRemoteServerId` 用于 `list_accessible_remotes` 的自我排除和审计标注。
- **不复用全局 `VIBEDECKX_API_KEY`，也不复用 reverse-connect token。**
- **有效期与会话生命周期一致**：网关每次调用实时校验会话仍存活，会话结束
  token 即失效；另设 24h exp 作为兜底。不用短 TTL——`--mcp-config` 的 headers
  在 spawn 时固定，claude 进程运行中无法刷新 token，短 TTL 会让长会话（resident
  /长任务）中途悄悄 401。
- 目标列表与访问级别不冻结进 token，每次调用按当前开关状态实时解析——用户调低
  /关闭级别立即生效。
- 已知边界：`sourceRemoteServerId` 是声明性标注，**不能防止 token 被搬到别的机
  器上使用**（网关是公网 HTTPS endpoint，无通道绑定）。防搬运需要 mTLS 或隧道
  进反连通道，v1 不做；泄露影响面由"实时校验会话存活 + 访问级别"收口。

### 3. Remote 端：内部 exec/fs 路由（唯一的 remote 端改动）

新增内部路由（如 `POST /api/internal/exec` 及配套的 fs 只读操作）：

- exec：spawn 子进程（复用 `process-manager.ts` 基础设施，非 PTY）、超时 kill、
  stdout/stderr 各截断 64KB 后返回。
- fs：read/list/stat 纯 Node fs 实现，不经 shell。

这些路由和其他 remote 路由一样受 remote 端自身 API key 保护，只有 server（经
反连通道，凭已存的 api key）能调用。升级 remote 端版本即获得此能力，**目标机
不需要安装 agent**。

（评审中讨论过给 exec 路由单加内部密钥：不采纳——同一把 remote API key 后面
已有 terminal/process 等等价 RCE 能力，单独加锁无效；整体收紧 remote 内部路由
是独立议题。）

### 4. 会话 spawn 注入（`providers/claude-code-provider.ts`）

- Server 创建远程会话时，若该用户存在至少一个（发起方之外的）访问级别 ≥ read
  的 remote，则在转发给 remote A 的 spawn 请求 payload 中附带
  `crossRemoteMcp: { url, token }`。
- Remote A 的 claude-code-provider 收到后追加
  `--mcp-config '{"mcpServers":{"cross-remote":{"type":"http","url":...,"headers":{"Authorization":"Bearer ..."}}}}'`
  （内联 JSON，加在现有 `--permission-mode` 参数旁）。
- 没有符合条件的目标时不注入，避免会话看到空工具面。

### 5. 存储与访问级别开关

- `remote_servers` 表新增列 `cross_remote_access`（text，取值
  `'off' | 'read' | 'exec'`，默认 `'off'`），随现有 schema 自动迁移；
  `RemoteServer` 接口与 `storage.remoteServers.update()` 支持该字段。
- 用三值枚举而非两个布尔：exec 蕴含 read，避免"允许 bash 但禁止读文件"的无意
  义组合。
- `PUT /api/remote-servers/:id`（现有路由）接受该字段，沿用现有的 userId 归属
  校验。

### 6. 审计表（新增 `cross_remote_audit`）

产品级可追溯记录，落库而非仅 pino（日志会轮转、不可按租户查询）：

| 列 | 说明 |
|---|---|
| `id, created_at` | — |
| `user_id, session_id` | 调用方身份 |
| `source_remote_id, target_remote_id` | 发起/目标机器 |
| `tool_name` | 调用的工具 |
| `args_summary` | 命令/路径，截断到 1KB |
| `exit_code, duration_ms, status` | 结果（ok / timeout / denied / offline） |

被拒绝的调用（denied）也记录。写入量为 agent 工具调用级别，无压力。pino 日志
照常打，用于运维排查；审计表是产品事实来源，将来可直接做成开关旁的"访问历史"
面板。

### 7. 前端开关（`components/settings/remote-servers-settings.tsx`）

每个 remote 条目上一个三档选择（默认"关闭"）：

- **关闭**（默认）
- **允许诊断读取**——其他 remote 的 agent 可读取本机文件、目录、进程列表。提示：
  读取权限也可能暴露日志/配置中的敏感信息。
- **允许执行命令**——含以上，且可在本机执行任意 shell 命令。提示：等同于授予同
  账号下其他机器上的 agent 在本机执行命令的能力。

## 安全设计

1. **默认关闭、逐机分级 opt-in**：被访问方必须显式选择 read 或 exec 级别，且只
   在同一 userId 租户内可见可达。read 层显著降低了"想让 agent 查日志但不想开放
   shell"用户的风险敞口。
2. **Scoped token**：仅能调用 MCP 网关；绑定 user/session/source remote；有效
   期与会话生命周期一致（实时校验存活），24h exp 兜底。
3. **审计落库**：见第 6 节，含 denied 调用。
4. **审批（已知限制，v1 不做）**：B 上没有 agent，因此没有 B 侧 permission
   mode 兜底；A 的会话若运行在 skip-permissions 模式，跨机调用无交互门槛。
   交互式会话可依赖 Claude Code 自身的 MCP 工具审批；事件驱动触发的会话应在
   [event-driven-outbound-approval](../../event-driven-outbound-approval-design.md)
   落地后把跨机调用（至少 exec 级）纳入审批面。v1 以"分级 opt-in + 审计"为边界。
5. **提示注入威胁**：A 上的 agent 读到不可信内容后可能被诱导操作 B。分级开关
   缩小了可打击面（read-only 目标不可被用于横向执行）；审批集成是后续主要缓解。

## 错误处理

- 目标 remote 离线（反连断开）：工具立即返回明确错误，不挂起。
- 命令超时：kill 进程，返回已捕获输出并标注 timed out。
- 跨租户 / 级别不足 / 不存在的 remoteId / 会话已结束：统一 "remote not found
  or not accessible"。
- 并发超限：返回 busy，提示 agent 串行重试。
- 输出超限：截断并标注 truncated。

## 测试

- 网关鉴权单测：无 token / 伪造 token / 跨租户目标 / 级别不足（read 目标调
  `remote_bash`）/ 开关中途调低 / 会话结束后调用 / 并发超限。
- exec/fs 路由单测：正常执行、超时 kill、输出截断、fs 只读操作。
- 审计单测：成功与 denied 调用均落库。
- 手动 e2e：两台 remote，B 设为 read——A 上 agent 能 `remote_read_file`/
  `remote_process_list`、`remote_bash` 被拒；B 升到 exec 后 bash 可用；关掉 B
  的开关后同一会话内调用立即失败。

## 实现偏差（2026-07-10 落地时确认）

落地实现与上文设计基本一致，以下几处按实现现实做了调整或澄清：

1. **不引入 MCP SDK 依赖**。网关是手写的无状态 JSON-RPC 处理器（`routes/
   cross-remote-mcp-routes.ts`），支持 `initialize`、`notifications/initialized`
   （及其它无 id 的 notification，一律回 202）、`ping`、`tools/list`、
   `tools/call`。streamable-HTTP 语义足够，省去 SDK 的会话状态与体积。

2. **`VIBEDECKX_PUBLIC_URL` 为必需项**：网关需要一个公网可达的 base URL 才能拼出
   注入给 claude 的 `--mcp-config` url。未设置时特性整体关闭
   （`crossRemoteMcpEnabled()` 返回 false，`mintCrossRemoteMcpConfig` 返回
   `undefined`），不注入任何 MCP server。

3. **远程会话的"存活"校验是"会话记录仍在"，而非进程真正存活**。进程跑在源
   remote A 上，server 端不持有它的 liveness 位，因此 `isSessionUsable` 对
   `remote-` 前缀的会话只校验 `remoteSessionMap.has(sessionId)`（boot 时从
   `remote_session_mappings` 表 rehydrate，删除会话时移除）。撤销手段是：删除会话、
   调低/关闭目标 tier（每次调用实时校验）、或等 24h token 过期。

4. **session id 改由 server 端生成并传入 `createNewSession`**。token 绑定
   `sessionId`，而该 id 必须随 spawn 请求一起下发给 remote，所以不能等 remote 回
   传后再确定。server 在调用 remote *之前* 先把条目写入 `remoteSessionMap`——因为
   remote 的 `createNewSession` 会在返回响应前就 spawn claude，而 claude 启动时即连
   接其 MCP servers，晚注册会让 agent 的第一次工具调用被 `isSessionUsable` 拒。若
   remote 回传了不一致的 session id（旧版 remote 忽略传入 id），fail closed：删除预
   注册条目并返回 409（提示升级 remote）。
   **注入范围**：`crossRemoteMcp` 对经 HTTP agent-session 路由创建的**远程会话与
   本地（server 端）会话都注入**（本地路径 `sourceRemoteServerId: null`）。但由
   chat 的 `spawnAgentSession` 工具创建的会话**不注入**——该工具走
   `chat-session-manager.ts`，本地分支不传 options bag、远程分支传
   `userId: undefined`，两者都使 `mintCrossRemoteMcpConfig` 返回 `undefined`。

5. **签发 token 需要已认证的 `userId`**。solo/无认证模式下 `requireAuth` 产出
   `undefined`，特性保持关闭：一个 scope 到 `""` 的 token 会让
   `remoteServers.getById(id, "")` 跳过 user_id 谓词、解析到任意租户的 remote。
   token 校验器也会拒绝空的 `userId`/`sessionId`（fail closed，不依赖每个调用方
   自查）。

## 非目标（YAGNI）

- B 上连 remote 端都没运行的机器（那需要 SSH 直连方案，完全不同的设计）。
- `remote_write_file` / 交互式 PTY / 文件传输——诊断场景用不到，需要时再加。
- 反连协议的 remote-initiated request 帧。
- 跨用户（跨租户）访问。
- token 通道绑定（mTLS / 隧道进反连通道）。
- exec 路由独立内部密钥（见第 3 节说明）。
