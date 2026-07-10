# 跨 Remote 访问（Cross-Remote MCP Gateway）设计

> 状态：**设计已确认，待实现**（2026-07-10）。

## 背景与目标

Server 端部署为 SaaS 服务，用户的多台机器各自运行 vibedeckx remote 端（通过
reverse-connect 反连到 server）。目标场景：**remote B 上没有安装 agent（Claude
Code），需要让 remote A 上运行的 agent 能连到 remote B，检查/诊断 B 系统上的问
题**（看日志、查进程、读配置等）。

因为 B 上无法 spawn agent 会话，commander 的 spawn/send 原语不适用；A 的 agent
需要拿到能直接操作 B 的低级工具（bash、读文件）。

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
Authorization header 中的会话级 scoped token（见下）。v1 暴露三个工具：

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_accessible_remotes` | — | 返回同用户下开启了跨机访问、且不是发起方自身的 remote（id、name、在线状态） |
| `remote_bash` | `remoteId, command, cwd?, timeoutSec?` | 一次性执行（非 PTY），返回 stdout/stderr/exit code；默认超时 60s，输出截断 64KB |
| `remote_read_file` | `remoteId, path, offset?, limit?` | 读目标机文件，同样有大小上限 |

网关每次调用时**实时**校验：token 有效 → 目标 remote 属于同一 userId → 目标的
`allow_cross_remote_access` 开关为开 → 目标在线。任一不满足统一返回
"remote not found or not accessible"（不泄露存在性）。校验通过后经
`proxyToRemote` 转发到目标 remote 端的内部 exec 路由。

### 2. 会话级 scoped token

- Server 在创建（或代理创建）agent 会话时签发：HMAC 签名的无状态 token，载荷
  `{ userId, sessionId, iat }`，server 端密钥签名。
- **不复用全局 `VIBEDECKX_API_KEY`，也不复用 reverse-connect token。**
- 有效期 24h；撤销依赖实时校验——用户关掉目标 remote 的开关立即生效，不需要
  等 token 过期。
- 目标列表不冻结进 token，每次调用按当前开关状态实时解析。

### 3. Remote 端：内部 exec 路由（唯一的 remote 端改动）

新增一个一次性执行路由（如 `POST /api/internal/exec`）：spawn 子进程（复用
`process-manager.ts` 基础设施，非 PTY）、带超时 kill、stdout/stderr 各截断
64KB 后返回。该路由和其他 remote 路由一样受 remote 端自身 API key 保护，只有
server（经反连通道，凭已存的 api key）能调用。升级 remote 端版本即获得此能力，
**目标机不需要安装 agent**。

### 4. 会话 spawn 注入（`providers/claude-code-provider.ts`）

- Server 创建远程会话时，若该用户存在至少一个（发起方之外的）已开启跨机访问的
  remote，则在转发给 remote A 的 spawn 请求 payload 中附带
  `crossRemoteMcp: { url, token }`。
- Remote A 的 claude-code-provider 收到后追加
  `--mcp-config '{"mcpServers":{"cross-remote":{"type":"http","url":...,"headers":{"Authorization":"Bearer ..."}}}}'`
  （内联 JSON，加在现有 `--permission-mode` 参数旁）。
- 用户没有任何开启开关的 remote 时不注入，避免所有会话平白多一个 MCP server。

### 5. 存储与开关

- `remote_servers` 表新增列 `allow_cross_remote_access`（integer 0/1，默认
  0），随现有 schema 自动迁移；`RemoteServer` 接口与
  `storage.remoteServers.update()` 支持该字段。
- `PUT /api/remote-servers/:id`（现有路由）接受该字段，沿用现有的 userId 归属
  校验。

### 6. 前端开关（`components/settings/remote-servers-settings.tsx`）

每个 remote 条目上加一个 Switch："允许其他 remote 的 agent 访问此机器"，默认
关。打开时给一句风险提示（等同于授予同账号下其他机器上的 agent 在本机执行命令
的能力）。

## 安全设计

1. **默认关闭、逐机 opt-in**：被访问方必须显式打开开关，且只在同一 userId 租户
   内可见可达。
2. **Scoped token**：仅能调用 MCP 网关，无法访问其他 API；绑定 session 与
   user；泄露后影响面被开关实时校验兜底。
3. **审计日志**：每次 `remote_bash` / `remote_read_file` 在 server 端用现有
   pino logger 记录 `(sessionId, userId, 目标 remoteId, 命令/路径, exit code,
   耗时)`。
4. **审批（已知限制，v1 不做）**：B 上没有 agent，因此没有 B 侧 permission
   mode 兜底；A 的会话若运行在 skip-permissions 模式，跨机 bash 无交互门槛。
   交互式会话可依赖 Claude Code 自身的 MCP 工具审批；事件驱动触发的会话应在
   [event-driven-outbound-approval](../../event-driven-outbound-approval-design.md)
   落地后把跨机调用纳入审批面。v1 以"用户显式 opt-in + 审计日志"为边界。
5. **提示注入威胁**：A 上的 agent 读到不可信内容后可能被诱导操作 B。上一条的
   审批集成是主要缓解；opt-in 缩小了可打击面。

## 错误处理

- 目标 remote 离线（反连断开）：工具立即返回明确错误，不挂起。
- 命令超时：kill 进程，返回已捕获输出并标注 timed out。
- 跨租户 / 未开启开关 / 不存在的 remoteId：统一 "remote not found or not
  accessible"。
- 输出超限：截断并标注 truncated。

## 测试

- 网关鉴权单测：无 token / 伪造 token / 跨租户目标 / 开关关闭 / 开关中途关闭。
- exec 路由单测：正常执行、超时 kill、输出截断。
- 手动 e2e：两台 remote，A 上 agent 通过 `list_accessible_remotes` 发现 B 并
  `remote_bash` 读取 B 的系统信息；关掉 B 的开关后同一会话内调用立即失败。

## 非目标（YAGNI）

- B 上连 remote 端都没运行的机器（那需要 SSH 直连方案，完全不同的设计）。
- `remote_write_file` / 交互式 PTY / 文件传输——诊断场景用不到，需要时再加。
- 反连协议的 remote-initiated request 帧。
- 跨用户（跨租户）访问。
