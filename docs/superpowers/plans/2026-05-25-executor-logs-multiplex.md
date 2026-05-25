# Executor 日志多路复用（单连接）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Executor 面板「每进程一条 WebSocket」改成「每 workspace 一条多路复用连接」，消除切换 workspace 时的连接风暴。

**Architecture:** 新增多路复用端点 `/api/executor-logs/stream`，所有下行消息用 `{ processId, ...LogMessage }` 包裹、上行用带 `processId` 的 subscribe/unsubscribe/input/resize。后端把现有 per-process handler 的本地/远程逻辑抽成可复用函数，新旧端点共用。前端新增 `ExecutorLogsProvider`（每 workspace 一条 WS + 进程级 store），`useExecutorLogs` 改写成 selector hook，签名不变。

**Tech Stack:** Fastify + `@fastify/websocket`（后端，ESM/NodeNext，本地 import 需 `.js` 后缀）、Next.js 16 / React 19（前端，`useSyncExternalStore`）、TypeScript。

> **注意：本仓库没有测试框架。** 每个任务的验证手段是类型检查（后端 `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`，前端 `cd apps/vibedeckx-ui && npx tsc --noEmit`），最终 Task 8 做一次手动端到端验证。

---

## File Structure

**后端（`packages/vibedeckx/src/routes/`）**
- 新建 `executor-stream-handlers.ts` — 抽取出的可复用流处理函数（本地 / 远程），新旧端点共用。职责：把单个 `processId` 的 init/历史/实时流接到一个 `send` 回调上，返回 `{ cleanup, handleInput }`。
- 修改 `websocket-routes.ts` — ① 旧 `/logs` 端点改成调用抽取出的函数（行为不变）；② 新增 `/api/executor-logs/stream` 多路复用端点。

**前端（`apps/vibedeckx-ui/`）**
- 修改 `lib/api.ts` — 新增 `MuxClientMessage` / `MuxServerMessage` 类型。
- 新建 `hooks/executor-logs-context.tsx` — `ExecutorLogsProvider` + context + 进程级 store + 连接/重连管理。
- 修改 `hooks/use-executor-logs.ts` — 改写成消费 context 的 selector hook（保持 `UseExecutorLogsResult` 签名）。
- 修改 `components/executor/executor-panel.tsx` — 用 `ExecutorLogsProvider` 包裹列表。

---

## Task 1：后端抽取本地流处理函数

把现有 `/logs` 本地分支逻辑抽成可复用函数，先不接线（下个任务才用），保证编译通过。

**Files:**
- Create: `packages/vibedeckx/src/routes/executor-stream-handlers.ts`

**参考现状**：`packages/vibedeckx/src/routes/websocket-routes.ts:575-630`（本地分支），消息类型见 `apps/vibedeckx-ui/lib/api.ts:229-240`（`LogMessage` / `InputMessage`）。

- [ ] **Step 1：创建文件，写本地流处理函数**

```ts
// packages/vibedeckx/src/routes/executor-stream-handlers.ts
import type { FastifyInstance } from "fastify";

// 与前端 lib/api.ts 的 LogMessage / InputMessage 对应（后端无共享类型包，此处本地声明）
export type LogMessage =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "pty"; data: string }
  | { type: "finished"; exitCode: number | null }
  | { type: "init"; isPty: boolean }
  | { type: "error"; message: string }
  | { type: "history_end" };

export type InputMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export interface ProcessStreamHandle {
  /** 停止该进程的流（取消订阅 / 关闭上游）。可安全多次调用。 */
  cleanup: () => void;
  /** 把 input/resize 路由到该进程。 */
  handleInput: (msg: InputMessage) => void;
}

/**
 * 把单个本地进程的 init → 历史回放 → history_end → 实时流接到 send 回调。
 * - send：投递一条 LogMessage（调用方决定是否包 processId / 是否在 finished 时关 socket）。
 * - onTerminal：该进程流终止时恰好调用一次（无更多数据可来）。
 */
export function attachLocalProcessStream(
  fastify: FastifyInstance,
  processId: string,
  send: (msg: LogMessage) => void,
  onTerminal: () => void,
): ProcessStreamHandle {
  const noop: ProcessStreamHandle = { cleanup: () => {}, handleInput: () => {} };

  const isPty = fastify.processManager.isPtyProcess(processId);
  send({ type: "init", isPty });

  const logs = fastify.processManager.getLogs(processId) as LogMessage[];
  for (const log of logs) send(log);
  send({ type: "history_end" });

  const isRunning = fastify.processManager.isRunning(processId);

  if (logs.length === 0 && !isRunning) {
    send({ type: "error", message: "Process not found" });
    send({ type: "finished", exitCode: null });
    onTerminal();
    return noop;
  }

  const lastLog = logs[logs.length - 1];
  if (lastLog?.type === "finished") {
    onTerminal();
    return noop;
  }

  const unsubscribe = fastify.processManager.subscribe(processId, (msg: LogMessage) => {
    send(msg);
    if (msg.type === "finished") onTerminal();
  });

  return {
    cleanup: () => unsubscribe?.(),
    handleInput: (msg) => fastify.processManager.handleInput(processId, msg),
  };
}
```

- [ ] **Step 2：类型检查**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS（无错误；文件已被项目 include，未被引用也应通过）

- [ ] **Step 3：Commit**

```bash
git add packages/vibedeckx/src/routes/executor-stream-handlers.ts
git commit -m "refactor(server): extract local executor stream handler"
```

---

## Task 2：后端抽取远程流处理函数

把现有 `/logs` 远程分支逻辑抽进同一文件。

**Files:**
- Modify: `packages/vibedeckx/src/routes/executor-stream-handlers.ts`

**参考现状**：`packages/vibedeckx/src/routes/websocket-routes.ts:407-572`（远程分支，含 reverse-connect 虚拟通道、直连上游、ping 保活、finished 清理 `remoteExecutorMap` + emit `executor:stopped`、上游关闭补发 finished）。注意 `websocket-routes.ts` 顶部已 import `WebSocket`、`randomUUID`、`VirtualWsAdapter` —— 新文件需各自 import。

- [ ] **Step 1：在 websocket-routes.ts 顶部确认这些 import 的来源**

Run: `grep -nE "import .*(VirtualWsAdapter|randomUUID|from \"ws\"|from \"crypto\")" packages/vibedeckx/src/routes/websocket-routes.ts`
Expected: 显示 `VirtualWsAdapter`、`randomUUID`（来自 `crypto`/`node:crypto`）、`WebSocket`（来自 `ws`）的 import 行，记下确切路径供 Step 2 复用。

- [ ] **Step 2：追加远程流处理函数（用 Step 1 查到的 import 路径）**

```ts
// 文件顶部追加 import（路径以 Step 1 查到的为准）：
import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import { VirtualWsAdapter } from "../utils/remote-proxy.js";

// ...文件末尾追加：

/**
 * 把单个远程进程（remote- 前缀）的流通过后端代理接到 send 回调。
 * 复用现有代理逻辑：reverse-connect 虚拟通道 / 直连上游 WS、ping 保活、
 * finished 时清理 remoteExecutorMap + markFinished + emit executor:stopped、
 * 上游关闭无终止信号时补发 finished。
 */
export function attachRemoteProcessStream(
  fastify: FastifyInstance,
  processId: string,
  send: (msg: LogMessage) => void,
  onTerminal: () => void,
): ProcessStreamHandle {
  const noop: ProcessStreamHandle = { cleanup: () => {}, handleInput: () => {} };

  let remoteInfo = fastify.remoteExecutorMap.get(processId);
  if (!remoteInfo) {
    const row = fastify.storage.remoteExecutorProcesses.getById(processId);
    if (row) {
      remoteInfo = {
        remoteServerId: row.remote_server_id,
        remoteUrl: row.remote_url,
        remoteApiKey: row.remote_api_key,
        remoteProcessId: row.remote_process_id,
        executorId: row.executor_id,
        projectId: row.project_id ?? undefined,
        branch: row.branch,
        stoppedEmitted: row.status !== "running",
      };
    }
  }
  if (!remoteInfo) {
    send({ type: "error", message: "Remote process not found" });
    send({ type: "finished", exitCode: null });
    onTerminal();
    return noop;
  }
  const info = remoteInfo;

  const useVirtualExec = fastify.reverseConnectManager.isConnected(info.remoteServerId);
  let remoteWs: WebSocket | VirtualWsAdapter;

  if (useVirtualExec) {
    const channelId = randomUUID();
    const wsPath = `/api/executor-processes/${info.remoteProcessId}/logs`;
    const wsQuery = `apiKey=${encodeURIComponent(info.remoteApiKey)}`;
    const adapter = new VirtualWsAdapter(
      (data) => fastify.reverseConnectManager.sendChannelData(info.remoteServerId, channelId, data),
      () => fastify.reverseConnectManager.closeChannel(info.remoteServerId, channelId),
    );
    fastify.reverseConnectManager.setChannelAdapter(info.remoteServerId, channelId, adapter);
    fastify.reverseConnectManager.openVirtualChannel(info.remoteServerId, channelId, wsPath, wsQuery);
    remoteWs = adapter;
    setTimeout(() => adapter.emit("open"), 0);
  } else {
    if (!info.remoteUrl) {
      send({ type: "error", message: "Remote server not reachable (reverse-connect offline)" });
      send({ type: "finished", exitCode: null });
      onTerminal();
      return noop;
    }
    const cleanRemoteUrl = info.remoteUrl.replace(/\/+$/, "");
    const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
    const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
    const remoteWsUrl = `${wsUrl}/api/executor-processes/${info.remoteProcessId}/logs?apiKey=${encodeURIComponent(info.remoteApiKey)}`;
    remoteWs = new WebSocket(remoteWsUrl, undefined, fastify.proxyManager.getWsOptions());
  }

  const pingInterval = setInterval(() => {
    if (remoteWs.readyState === WebSocket.OPEN) remoteWs.ping();
  }, 30000);

  let terminalSignalSent = false;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(pingInterval);
    try { remoteWs.close(); } catch { /* ignore */ }
  };

  remoteWs.on("message", (data: Buffer | string) => {
    try {
      const raw = data.toString();
      let parsed: LogMessage | null = null;
      try { parsed = JSON.parse(raw) as LogMessage; } catch { /* non-JSON, ignore */ }
      if (!parsed) return;
      send(parsed);

      if (parsed.type === "finished" || parsed.type === "error") terminalSignalSent = true;
      if (parsed.type === "finished") {
        const live = fastify.remoteExecutorMap.get(processId);
        if (live && !live.stoppedEmitted) {
          live.stoppedEmitted = true;
          fastify.eventBus.emit({
            type: "executor:stopped",
            projectId: live.projectId ?? "",
            executorId: live.executorId,
            processId,
            exitCode: parsed.exitCode ?? 0,
            target: live.remoteServerId,
          });
        }
        if (live) {
          fastify.remoteExecutorMap.delete(processId);
          fastify.storage.remoteExecutorProcesses.markFinished(
            processId,
            typeof parsed.exitCode === "number" ? parsed.exitCode : 0,
          );
        }
        onTerminal();
      }
      if (parsed.type === "error") onTerminal();
    } catch (error) {
      console.error("[ExecutorStream] Failed to forward remote message:", error);
    }
  });

  remoteWs.on("error", (error: unknown) => {
    console.error(`[ExecutorStream] Remote connection error:`, error);
    if (!terminalSignalSent) {
      send({ type: "error", message: "Remote connection error" });
      terminalSignalSent = true;
    }
    onTerminal();
  });

  remoteWs.on("close", () => {
    if (!terminalSignalSent) {
      const row = fastify.storage.remoteExecutorProcesses.getById(processId);
      send({ type: "finished", exitCode: row?.exit_code ?? 0 });
      terminalSignalSent = true;
    }
    onTerminal();
  });

  return {
    cleanup,
    handleInput: (msg) => {
      try {
        if (remoteWs.readyState === WebSocket.OPEN) remoteWs.send(JSON.stringify(msg));
      } catch (error) {
        console.error("[ExecutorStream] Failed to forward input to remote:", error);
      }
    },
  };
}
```

- [ ] **Step 3：类型检查**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS。若报 `RemoteExecutorInfo` 字段或 `eventBus.emit` 形参不符，对照 `websocket-routes.ts:419-519` 的现有用法修正字段名（以现有代码为准）。

- [ ] **Step 4：Commit**

```bash
git add packages/vibedeckx/src/routes/executor-stream-handlers.ts
git commit -m "refactor(server): extract remote executor stream handler"
```

---

## Task 3：旧 /logs 端点改用抽取函数（行为不变）

把现有端点替换成薄封装，验证不回归。

**Files:**
- Modify: `packages/vibedeckx/src/routes/websocket-routes.ts:402-631`

- [ ] **Step 1：替换端点 handler 主体**

把 `fastify.get<...>("/api/executor-processes/:processId/logs", { websocket: true }, (socket, req) => { ... })` 的整段回调体（约 403-631 行）替换为：

```ts
(socket, req) => {
  const { processId } = req.params;
  console.log(`[WebSocket] Client connected for process ${processId}`);

  // send 包装器：旧端点不包 processId；onTerminal 关闭 socket
  const send = (msg: LogMessage) => {
    try { socket.send(JSON.stringify(msg)); } catch { /* socket closed */ }
  };
  const onTerminal = () => { try { socket.close(); } catch { /* already closed */ } };

  const handle = processId.startsWith("remote-")
    ? attachRemoteProcessStream(fastify, processId, send, onTerminal)
    : attachLocalProcessStream(fastify, processId, send, onTerminal);

  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const message = JSON.parse(data.toString()) as InputMessage;
      if (message.type === "input" || message.type === "resize") {
        handle.handleInput(message);
      }
    } catch (error) {
      console.error("[WebSocket] Failed to parse input message:", error);
    }
  });

  socket.on("close", () => {
    console.log(`[WebSocket] Client disconnected from process ${processId}`);
    handle.cleanup();
  });
}
```

- [ ] **Step 2：在 websocket-routes.ts 顶部追加 import**

```ts
import {
  attachLocalProcessStream,
  attachRemoteProcessStream,
  type LogMessage,
  type InputMessage,
} from "./executor-stream-handlers.js";
```

若文件已从别处 import 了 `LogMessage` / `InputMessage`，去掉重复，统一用本文件来源（避免类型冲突）。

- [ ] **Step 3：类型检查**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS

- [ ] **Step 4：手动回归（旧路径仍可用）**

```bash
pnpm dev:all
```
- 打开 http://localhost:3000，进入一个本地 workspace，Start 一个 executor，确认日志实时显示、结束后状态为 Completed/Failed。
- 终端面板（terminal-panel）打开一个终端，确认输入/输出/resize 正常（仍走旧端点）。
- Expected：与改动前行为一致。

- [ ] **Step 5：Commit**

```bash
git add packages/vibedeckx/src/routes/websocket-routes.ts
git commit -m "refactor(server): route /logs endpoint through extracted handlers"
```

---

## Task 4：后端新增多路复用端点

**Files:**
- Modify: `packages/vibedeckx/src/routes/websocket-routes.ts`（在旧 `/logs` 端点之后、`fastify.after()` 内追加）

- [ ] **Step 1：注册多路复用端点**

在旧 `/logs` 端点的 `fastify.get(...)` 之后追加：

```ts
// 多路复用 executor 日志端点：一个 workspace 一条连接，按 processId 订阅
fastify.get<{ Querystring: { projectId?: string; apiKey?: string; token?: string } }>(
  "/api/executor-logs/stream",
  { websocket: true },
  (socket) => {
    console.log(`[ExecutorMux] Client connected`);
    const subs = new Map<string, () => void>(); // processId → cleanup

    const subscribeProcess = (processId: string) => {
      if (subs.has(processId)) return; // 幂等：已订阅则跳过

      const send = (msg: LogMessage) => {
        try { socket.send(JSON.stringify({ processId, ...msg })); } catch { /* closed */ }
      };
      let terminated = false;
      const onTerminal = () => {
        terminated = true;
        const c = subs.get(processId);
        if (c) { c(); subs.delete(processId); }
      };

      const handle = processId.startsWith("remote-")
        ? attachRemoteProcessStream(fastify, processId, send, onTerminal)
        : attachLocalProcessStream(fastify, processId, send, onTerminal);

      // 仅当流尚未同步终止时登记 cleanup（避免给已终止进程留下陈旧条目）
      if (!terminated) subs.set(processId, handle.cleanup);
      // 把 handleInput 暂存到 cleanup 闭包之外，供 input/resize 路由使用
      handleInputMap.set(processId, handle.handleInput);
    };

    const handleInputMap = new Map<string, (msg: InputMessage) => void>();

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(data.toString()) as
          | { type: "subscribe" | "unsubscribe"; processId: string }
          | { type: "input"; processId: string; data: string }
          | { type: "resize"; processId: string; cols: number; rows: number };

        if (msg.type === "subscribe") {
          subscribeProcess(msg.processId);
        } else if (msg.type === "unsubscribe") {
          subs.get(msg.processId)?.();
          subs.delete(msg.processId);
          handleInputMap.delete(msg.processId);
        } else if (msg.type === "input") {
          handleInputMap.get(msg.processId)?.({ type: "input", data: msg.data });
        } else if (msg.type === "resize") {
          handleInputMap.get(msg.processId)?.({ type: "resize", cols: msg.cols, rows: msg.rows });
        }
      } catch (error) {
        console.error("[ExecutorMux] Failed to parse client message:", error);
      }
    });

    socket.on("close", () => {
      console.log(`[ExecutorMux] Client disconnected; cleaning ${subs.size} subscriptions`);
      for (const cleanup of subs.values()) cleanup();
      subs.clear();
      handleInputMap.clear();
    });
  },
);
```

> 注意：`handleInputMap` 在回调内被 `subscribeProcess` 引用，但声明在其后——JS 函数声明/`const` 提升下，`subscribeProcess` 是箭头函数赋给 `const`，运行时调用发生在 message 事件中（晚于同步执行完毕），此时 `handleInputMap` 已初始化。若类型检查器报 “used before declaration”，把 `const handleInputMap = ...` 这一行移到 `subscribeProcess` 定义之前。

- [ ] **Step 2：类型检查**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS（若报 used-before-declaration，按 Step 1 注释把 `handleInputMap` 上移）

- [ ] **Step 3：Commit**

```bash
git add packages/vibedeckx/src/routes/websocket-routes.ts
git commit -m "feat(server): add multiplexed executor-logs stream endpoint"
```

---

## Task 5：前端新增多路复用消息类型

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts:236`（紧接 `InputMessage` 定义之后）

- [ ] **Step 1：追加类型**

在 `apps/vibedeckx-ui/lib/api.ts` 的 `InputMessage` 定义（约 238-240 行）之后追加：

```ts
// 多路复用 executor 日志通道
export type MuxClientMessage =
  | { type: "subscribe"; processId: string }
  | { type: "unsubscribe"; processId: string }
  | { type: "input"; processId: string; data: string }
  | { type: "resize"; processId: string; cols: number; rows: number };

export type MuxServerMessage = { processId: string } & LogMessage;
```

- [ ] **Step 2：类型检查**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3：Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts
git commit -m "feat(ui): add multiplexed executor-logs message types"
```

---

## Task 6：前端新增 ExecutorLogsProvider + store

每 workspace 一条 WS，按 processId 维护状态，含连接级重连。

**Files:**
- Create: `apps/vibedeckx-ui/hooks/executor-logs-context.tsx`

**参考现状**：`apps/vibedeckx-ui/hooks/use-executor-logs.ts`（现有单进程逻辑、重连常量、`ConnectionStatus`、`getWebSocketUrl`）。

- [ ] **Step 1：创建 provider 文件**

```tsx
// apps/vibedeckx-ui/hooks/executor-logs-context.tsx
"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { getWebSocketUrl, type LogMessage, type MuxClientMessage, type MuxServerMessage } from "@/lib/api";
import type { ConnectionStatus } from "./use-executor-logs";

const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

export interface ProcessLogState {
  logs: LogMessage[];
  status: ConnectionStatus;
  exitCode: number | null;
  isPty: boolean;
  replayingHistory: boolean;
}

const EMPTY_STATE: ProcessLogState = {
  logs: [],
  status: "connecting",
  exitCode: null,
  isPty: false,
  replayingHistory: true,
};

export interface ExecutorLogsStore {
  subscribeProcess: (processId: string) => void;
  unsubscribeProcess: (processId: string) => void;
  sendInput: (processId: string, data: string) => void;
  sendResize: (processId: string, cols: number, rows: number) => void;
  /** useSyncExternalStore: 订阅某进程状态变化 */
  onProcessChange: (processId: string, cb: () => void) => () => void;
  /** useSyncExternalStore: 读取某进程当前状态（引用稳定，变更时换新对象） */
  getProcessState: (processId: string) => ProcessLogState;
}

const ExecutorLogsContext = createContext<ExecutorLogsStore | null>(null);

export function useExecutorLogsStore(): ExecutorLogsStore {
  const ctx = useContext(ExecutorLogsContext);
  if (!ctx) throw new Error("useExecutorLogsStore must be used within ExecutorLogsProvider");
  return ctx;
}

export function ExecutorLogsProvider({
  projectId,
  children,
}: {
  projectId: string | null;
  children: ReactNode;
}) {
  // 进程状态与监听器
  const statesRef = useRef(new Map<string, ProcessLogState>());
  const listenersRef = useRef(new Map<string, Set<() => void>>());
  // 当前希望订阅的进程集合（重连后据此重新 subscribe）
  const desiredRef = useRef(new Set<string>());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = (processId: string) => {
    listenersRef.current.get(processId)?.forEach((cb) => cb());
  };

  // 不可变更新：换新对象，保证 useSyncExternalStore 引用稳定
  const update = (processId: string, patch: Partial<ProcessLogState>) => {
    const prev = statesRef.current.get(processId) ?? EMPTY_STATE;
    statesRef.current.set(processId, { ...prev, ...patch });
    notify(processId);
  };

  const applyServerMessage = (m: MuxServerMessage) => {
    const { processId } = m;
    if (m.type === "init") {
      update(processId, { isPty: m.isPty, replayingHistory: true, logs: [], status: "connected" });
    } else if (m.type === "history_end") {
      update(processId, { replayingHistory: false });
    } else if (m.type === "finished") {
      update(processId, { exitCode: m.exitCode, status: "closed" });
    } else if (m.type === "error") {
      update(processId, { status: "error" });
    } else {
      // stdout / stderr / pty —— 追加日志
      const prev = statesRef.current.get(processId) ?? EMPTY_STATE;
      const { processId: _omit, ...logMsg } = m;
      update(processId, { logs: [...prev.logs, logMsg as LogMessage] });
    }
  };

  const sendRaw = (msg: MuxClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  };

  // 建立连接（projectId 变化时重连，整段在 effect 内）
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    reconnectAttemptRef.current = 0;

    const connect = () => {
      if (cancelled) return;
      const wsUrl = getWebSocketUrl(`/api/executor-logs/stream?projectId=${encodeURIComponent(projectId)}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        reconnectAttemptRef.current = 0;
        // 重连后重新订阅所有期望进程
        for (const pid of desiredRef.current) {
          sendRaw({ type: "subscribe", processId: pid });
        }
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          applyServerMessage(JSON.parse(event.data) as MuxServerMessage);
        } catch (error) {
          console.error("[ExecutorLogs] parse error:", error);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (cancelled) return;
        if (reconnectAttemptRef.current < RECONNECT_MAX_ATTEMPTS) {
          const attempt = reconnectAttemptRef.current++;
          const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
          const totalDelay = delay + delay * Math.random() * 0.25;
          // 标记所有期望进程为 connecting
          for (const pid of desiredRef.current) update(pid, { status: "connecting" });
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!cancelled) connect();
          }, totalDelay);
        } else {
          for (const pid of desiredRef.current) update(pid, { status: "error" });
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [projectId]);

  const store: ExecutorLogsStore = {
    subscribeProcess: (processId) => {
      if (desiredRef.current.has(processId)) return; // 幂等
      desiredRef.current.add(processId);
      // 新订阅前重置该进程状态
      statesRef.current.set(processId, { ...EMPTY_STATE });
      notify(processId);
      sendRaw({ type: "subscribe", processId });
    },
    unsubscribeProcess: (processId) => {
      if (!desiredRef.current.has(processId)) return;
      desiredRef.current.delete(processId);
      sendRaw({ type: "unsubscribe", processId });
      // 保留 state（收起/展开不丢历史），只停止接收
    },
    sendInput: (processId, data) => sendRaw({ type: "input", processId, data }),
    sendResize: (processId, cols, rows) => sendRaw({ type: "resize", processId, cols, rows }),
    onProcessChange: (processId, cb) => {
      let set = listenersRef.current.get(processId);
      if (!set) { set = new Set(); listenersRef.current.set(processId, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    },
    getProcessState: (processId) => statesRef.current.get(processId) ?? EMPTY_STATE,
  };
  const storeRef = useRef(store);
  storeRef.current = store;

  return (
    <ExecutorLogsContext.Provider value={storeRef.current}>
      {children}
    </ExecutorLogsContext.Provider>
  );
}
```

- [ ] **Step 2：类型检查**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS（`use-executor-logs.ts` 仍是旧版，导出 `ConnectionStatus` 已存在，可被 import）

- [ ] **Step 3：Commit**

```bash
git add apps/vibedeckx-ui/hooks/executor-logs-context.tsx
git commit -m "feat(ui): add ExecutorLogsProvider with per-process store"
```

---

## Task 7：改写 useExecutorLogs 为 selector hook + 接线面板

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-executor-logs.ts`
- Modify: `apps/vibedeckx-ui/components/executor/executor-panel.tsx`

- [ ] **Step 1：改写 use-executor-logs.ts**

整文件替换为（保留 `ConnectionStatus` / `UseExecutorLogsResult` 导出，签名不变）：

```ts
"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useExecutorLogsStore } from "./executor-logs-context";
import type { LogMessage } from "@/lib/api";

export type ConnectionStatus = "connecting" | "connected" | "closed" | "error";

export interface UseExecutorLogsResult {
  logs: LogMessage[];
  status: ConnectionStatus;
  exitCode: number | null;
  isPty: boolean;
  replayingHistory: boolean;
  clearLogs: () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

export function useExecutorLogs(processId: string | null, resetKey?: string): UseExecutorLogsResult {
  const store = useExecutorLogsStore();

  // 订阅 / 注销：processId 或 resetKey（executorMode）变化时重订阅
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!processId) return () => {};
      store.subscribeProcess(processId);
      const off = store.onProcessChange(processId, cb);
      return () => {
        off();
        store.unsubscribeProcess(processId);
      };
    },
    // resetKey 进入依赖，使其变化时 useSyncExternalStore 重新订阅
    [processId, resetKey, store],
  );

  const getSnapshot = useCallback(
    () => (processId ? store.getProcessState(processId) : null),
    [processId, store],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const clearLogs = useCallback(() => {}, []); // store 在重订阅时已重置 logs，无需手动清

  const sendInput = useCallback(
    (data: string) => { if (processId) store.sendInput(processId, data); },
    [processId, store],
  );
  const sendResize = useCallback(
    (cols: number, rows: number) => { if (processId) store.sendResize(processId, cols, rows); },
    [processId, store],
  );

  return {
    logs: state?.logs ?? [],
    status: state?.status ?? "closed",
    exitCode: state?.exitCode ?? null,
    isPty: state?.isPty ?? false,
    replayingHistory: state?.replayingHistory ?? true,
    clearLogs,
    sendInput,
    sendResize,
  };
}
```

> 说明：原 hook 在 `processId` 为空时「保留上次输出」。这里 `processId` 为空返回默认值；`ExecutorItem` 仅在 `localProcessId` 非空时才有意义，且 store 保留了 state，展开/收起不丢历史。

- [ ] **Step 2：用 Provider 包裹 executor 列表**

在 `apps/vibedeckx-ui/components/executor/executor-panel.tsx`：

import 追加：
```ts
import { ExecutorLogsProvider } from "@/hooks/executor-logs-context";
```

找到组件 `return (` 的最外层包裹元素，在其内部把渲染内容包进 Provider。最稳妥做法：在 `ExecutorPanel` 函数体 `return` 的最外层包一层：

```tsx
return (
  <ExecutorLogsProvider key={`${projectId ?? "none"}-${project?.executor_mode ?? "local"}`} projectId={projectId}>
    {/* ……原有的最外层 JSX 整体放这里…… */}
  </ExecutorLogsProvider>
);
```

`key` 含 `executor_mode`：切换 local/remote 模式时整条连接重建，与 `ExecutorItem` 的 `key` 语义一致。

- [ ] **Step 3：类型检查**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4：lint**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: PASS（无新增错误）

- [ ] **Step 5：Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-executor-logs.ts apps/vibedeckx-ui/components/executor/executor-panel.tsx
git commit -m "feat(ui): consume multiplexed executor-logs via single connection"
```

---

## Task 8：端到端手动验证

**Files:** 无（验证任务）

- [ ] **Step 1：启动**

Run: `pnpm dev:all`

- [ ] **Step 2：本地 workspace 单连接验证**

- 打开 http://localhost:3000，打开浏览器 DevTools → Network → WS。
- 进入一个有「多个跑过的 executor」的本地 workspace。
- Expected：只出现 **1 条** `/api/executor-logs/stream` WebSocket（而非每进程一条 `/logs`）。
- 逐个展开各 executor：历史日志正确、互不串流。

- [ ] **Step 3：实时与重启验证**

- Start 一个 executor：自动展开，实时日志流入；结束后状态 Completed/Failed 正确。
- 对已结束的 executor 再次 Start：新 processId 订阅，旧历史不串入新输出。

- [ ] **Step 4：远程 workspace 验证（若有远程配置）**

- 切到 remote 模式 / 远程 workspace，重复 Step 2-3。
- Expected：浏览器侧仍只 1 条 stream 连接；远端进程历史/实时流正常；进程结束状态正确。

- [ ] **Step 5：切换 / 清理验证**

- 在多个 workspace 间来回切换。
- Expected：切走时旧 stream 连接关闭（Network WS 显示 closed），切入新 workspace 建新连接；无连接泄漏、无残留串流。

- [ ] **Step 6：回归终端面板**

- 打开终端面板，确认终端输入/输出/resize 仍正常（走旧 `/logs` 端点，未受影响）。

---

## Self-Review 备注

- **Spec 覆盖**：协议（Task 5）、provider+store（Task 6）、selector hook（Task 7）、服务端本地+远程 handler（Task 1/2）、新端点（Task 4）、旧端点复用同逻辑（Task 3）、错误/重连/边界（Task 6 重连 + Task 4 幂等/清理）、验证（Task 8）。均有对应任务。
- **每进程终止不关整条连接**：Task 4 的 `onTerminal` 只 `subs.delete` 单进程；Task 6 重连作用于整条 WS。符合 spec 第 4 节关键差异。
- **类型一致**：`ProcessStreamHandle`、`attachLocalProcessStream`/`attachRemoteProcessStream`、`ProcessLogState`、`MuxClientMessage`/`MuxServerMessage`、`ExecutorLogsStore` 跨任务命名一致。
- **无测试框架**：以类型检查 + lint + 手动验证替代单测，已在标题与各任务注明。
