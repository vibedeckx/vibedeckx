# Executor 日志多路复用（单连接）设计

**日期**：2026-05-25
**状态**：已确认，待实现

## 背景与问题

切换到某个 workspace 时，`executor-panel.tsx` 会无条件地把该 project 下所有 executor 都渲染成 `<ExecutorItem>`（与折叠/展开状态无关）。每个 `ExecutorItem` 在组件主体里调用 `useExecutorLogs(localProcessId, ...)`，而 `localProcessId` 的初始值为 `executor.currentProcessId ?? executor.lastProcessId`。

结果：只要一个 executor 跑过（有持久化的 `lastProcessId`），切入该 workspace 时就会立刻为它建立一条到 `/api/executor-processes/:processId/logs` 的 WebSocket。**N 个跑过的 executor = 切换瞬间并发 N 条连接**，每条各自回放历史。executor 一多就会撞上浏览器对同一 host 约 6 条并发连接的上限。

## 目标

把「浏览器 ↔ 后端」这一跳从「每进程一条」改为「每 workspace 一条」多路复用连接。

## 范围

- **本次只覆盖 Executor 面板的列表**（`executor-panel.tsx` 渲染的 executor 日志流）。
- 协议设计成**通用**形态，将来可平滑扩展到终端面板 / 全量 `/logs` 使用方。
- 旧的 per-process 端点 `/api/executor-processes/:processId/logs` **保留**（终端面板、将来迁移仍用）。
- **本地 + 远程进程都支持**：executor 列表在 remote 模式下 `processId` 为 `remote-` 前缀，新端点也要处理。

## 关键决策

| 维度 | 决策 |
|------|------|
| 覆盖范围 | 仅 Executor 列表，协议通用（C） |
| 连接生命周期 | 每个 workspace 一条，随面板容器挂载/卸载（A） |
| 订阅时机 | 渴望订阅：连接建立即订阅所有跑过的进程，保持「展开即见」（A） |
| 远程进程 | 本地 + 远程都支持（A） |

## 设计

### 1. 端点与线路协议

新端点（与旧端点并存）：

```
GET /api/executor-logs/stream?projectId=<id>   (websocket)
```

一个 workspace（project + 当前 worktree）一条连接，跟着 executor 面板容器挂载/卸载。

**上行（客户端 → 服务端）**——在现有 `InputMessage` 基础上加 `processId` 路由 + 订阅管理：

```ts
type MuxClientMsg =
  | { type: "subscribe";   processId: string }
  | { type: "unsubscribe"; processId: string }
  | { type: "input";  processId: string; data: string }
  | { type: "resize"; processId: string; cols: number; rows: number }
```

**下行（服务端 → 客户端）**——复用现有 `LogMessage` 全部 `type`，只在外层包一个 `processId`：

```ts
type MuxServerMsg = { processId: string } & LogMessage
// { processId, type:"init"|"stdout"|"stderr"|"pty"|"history_end"|"finished"|"error", ... }
```

要点：

- `LogMessage` / `InputMessage` 内部结构完全不变，只被 `processId` 包裹，因此 `ExecutorOutput`、历史回放、`muteInput` 等逻辑零改动。
- 每个 `subscribe` 触发该进程独立的 `init → 历史回放 → history_end → 实时流`，互不干扰。
- 协议通用，不假设只有 executor 使用。

### 2. 前端 Provider + 改写后的 hook

新增 `ExecutorLogsProvider`（挂在 executor 面板外层，按 `projectId` 建一条 WS）：

- 内部维护 `Map<processId, ProcessLogState>`：

  ```ts
  interface ProcessLogState {
    logs: LogMessage[];
    status: ConnectionStatus;   // 复用现有联合类型
    exitCode: number | null;
    isPty: boolean;
    replayingHistory: boolean;
  }
  ```

- 收到下行消息按 `processId` 路由到对应 state，套用**与现 `use-executor-logs.ts` 完全相同**的处理逻辑（init→设 isPty；history_end→关 replaying；finished→存 exitCode、status=closed；error→status=error；其他→push log）。
- 暴露命令式 API：`subscribe(processId)`、`unsubscribe(processId)`、`sendInput(processId, data)`、`sendResize(processId, cols, rows)`、`getState(processId)`。
- 重连/退避逻辑集中在此（见第 4 节）。

`useExecutorLogs` 改写成 selector hook——签名与返回值保持不变，`ExecutorItem` 几乎不改：

```ts
function useExecutorLogs(processId: string | null, resetKey?: string): UseExecutorLogsResult {
  const ctx = useContext(ExecutorLogsContext);
  useEffect(() => {
    if (!processId) return;
    ctx.subscribe(processId);
    return () => ctx.unsubscribe(processId);
  }, [processId, resetKey]);
  const state = ctx.getState(processId);   // 订阅 store 触发重渲染
  return {
    ...state,
    clearLogs,
    sendInput:  (d) => ctx.sendInput(processId, d),
    sendResize: (c, r) => ctx.sendResize(processId, c, r),
  };
}
```

细节：

- `ExecutorItem`、`ExecutorOutput` 代码基本不动（hook 签名兼容）。
- `resetKey`（即 `executorMode`）变化时重新订阅，保持「切 local/remote 模式重连」语义。
- `processId` 为空时「不清空、保留上次输出」语义保留：`unsubscribe` 不删除 `Map` 里的 state，只停止接收；收起/展开不丢历史。

### 3. 服务端多路复用 handler

新增路由 `GET /api/executor-logs/stream`，在 `websocket-routes.ts` 的 `fastify.after()` 里注册，与现有 `/logs` 并列。复用现有 WS 鉴权（dev 模式 `token` query、远程 `apiKey`）。

每条连接维护订阅表：

```ts
const subs = new Map<string, () => void>();  // processId → 清理函数
```

**收到 `subscribe { processId }`**——按前缀分两条路径，复用现有 per-process handler 逻辑，每条下发消息包成 `{ processId, ...msg }`：

- **本地进程**：
  1. `send({processId, type:"init", isPty})`
  2. `getLogs(processId)` 逐条回放 → `send({processId, type:"history_end"})`
  3. 「无日志且未运行」→ 发 `error` + `finished`（同现状）
  4. `processManager.subscribe(processId, cb)`，unsubscribe 存入 `subs`
- **远程进程**（`remote-` 前缀）：复用现有代理建连逻辑——reverse-connect 虚拟通道 / 直连 upstream WS、ping 保活、`finished` 时清理 `remoteExecutorMap` 并 emit `executor:stopped`、upstream 关闭时补发 `finished`——为该进程开一条上游 WS，转发时打 `processId` 标签。「关闭上游 + 清 interval」存入 `subs`。

**收到 `unsubscribe`**：调用并删除 `subs.get(processId)`。
**收到 `input`/`resize`**：本地 → `processManager.handleInput(processId, msg)`；远程 → 转发到该进程的上游 WS。
**连接 `close`**：遍历 `subs` 全部清理（本地 unsubscribe、远程关上游 + 清 interval）。

**重构方式**：把现有 `/logs` handler 的「本地分支」「远程分支」各抽成可复用函数（如 `attachLocalProcessStream(send, processId) → cleanup` / `attachRemoteProcessStream(send, processId, ...) → cleanup`），让旧端点与新多路复用端点共用同一套逻辑，避免两份代码漂移。旧 `/logs` 端点改成「单进程、消息不包 processId」的薄封装。

### 4. 错误处理、重连与边界

**重连（集中到 provider，连接级）**：

- 指数退避重连（现 `RECONNECT_MAX_ATTEMPTS` / `RECONNECT_BASE_DELAY_MS` / `RECONNECT_MAX_DELAY_MS`）上移到 provider，作用于**整条 WS**：连接断了才退避重连，重连成功后自动重发当前所有 `subscribe`。
- 单个进程收到 `finished`/`error` **不再关闭整条连接**（关键差异）——只更新该进程 state，其它订阅照常。

**每进程终止语义**：某进程 `finished`/`error` → 仅把对应 `ProcessLogState.status` 置 `closed`/`error`，并触发 `ExecutorItem` 的 `onProcessFinished`（逻辑不变）。

**边界**：

- **进程不存在**：服务端对该 `processId` 回 `error` + `finished`，provider 标记该进程 `error`，不影响连接。
- **重复 subscribe**：provider 去重（已在 `Map` 里则跳过），服务端对已存在的 `subs` key 幂等保护。
- **切 workspace**：provider 随容器卸载 → WS `close` → 服务端清理全部订阅。无泄漏。
- **auth**：复用现有 WS 鉴权，与 `/logs` 一致。

## 测试 / 验证

项目无测试框架，按现有方式靠类型检查 + 手动验证：

- 类型检查：
  - 后端 `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
  - 前端 `cd apps/vibedeckx-ui && npx tsc --noEmit`
- 手动验证：
  1. 本地 workspace 多个跑过的 executor → 切入只建 1 条 WS（Network 面板核对），各 executor 历史正确、互不串流。
  2. 远程 workspace 同上，远端进程历史/实时流正常。
  3. 某 executor 重新 Start → 新 processId 订阅、自动展开、旧历史不串。
  4. 进程结束后状态正确（Completed/Failed），不触发整条连接重连。

## 不在本次范围

- 终端面板（`terminal-panel.tsx`）与全量 `/logs` 使用方的迁移（协议已留好扩展空间）。
- 后端 ↔ 远端服务器这一跳的扇出优化（仍每进程一条上游 WS，无法在此消除）。
- 全局常驻连接（跨 workspace 复用）——本次为每 workspace 一条。
