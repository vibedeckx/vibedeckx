/**
 * Registry of every worker-side capability the hub calls over the reverse-
 * connect tunnel — the application-layer half of the tunnel contract
 * (docs/server-worker-compat-design.md §3.1). The frame envelope alone can't
 * express compatibility: adding a proxied route changes no frame schema, yet
 * an old worker 404s on it.
 *
 * Keys:
 *   "http:<METHOD> <path>"  — HTTP request tunneled to the worker's Fastify API
 *   "ws:<path>"             — virtual WebSocket channel path
 *   "passthrough:<name>"    — raw tunnel use with caller-supplied path/port
 *
 * Path normalization (mirrored by the reconciliation test in
 * reverse-connect-capabilities.test.ts): template `${...}` segments become
 * `:param`; everything from the first `?` is dropped (query strings are not
 * part of route identity).
 *
 * Rules:
 * - Adding an entry is additive: old workers 404 the new route, so the calling
 *   server code must degrade (capability check / 404 tolerance) until the
 *   fleet catches up. Set `since` to the version that ships the worker route.
 * - Renaming/removing an entry is a breaking tunnel change: keep old and new
 *   side by side through a deprecation window, then bump MIN_WORKER_VERSION.
 *
 * Workers report `Object.keys` of this registry in their handshake frames, so
 * the hub can tell which routes a connected worker actually serves.
 */

export interface WorkerCapability {
  /**
   * Package version whose worker first served this. "0.2.0" = baseline: the
   * oldest release that speaks reverse-connect at all (0.1.x cannot connect),
   * verified by the cross-version e2e. The e2e tolerates a 404 from a worker
   * only when its version predates the capability's `since`.
   */
  since: string;
  summary: string;
}

export const WORKER_CAPABILITIES: Record<string, WorkerCapability> = {
  // --- Agent sessions ---
  "http:GET /api/path/agent-sessions": { since: "0.2.0", summary: "会话列表(按路径)" },
  // Additive: a worker below 0.3.22 404s it and the hub answers
  // `complete: false`, whereupon the UI falls back to the per-branch listing
  // above — i.e. exactly the behavior it had before this route existed.
  "http:GET /api/path/agent-sessions/alive": { since: "0.3.22", summary: "存活会话列表(全分支)" },
  "http:POST /api/path/agent-sessions": { since: "0.2.0", summary: "创建会话" },
  "http:POST /api/path/agent-sessions/new": { since: "0.2.0", summary: "创建会话(指定 ID)" },
  "http:GET /api/agent-sessions/:param": { since: "0.2.0", summary: "读会话详情/对话" },
  "http:GET /api/agent-sessions/:param/history-window": { since: "0.3.18", summary: "按 turn 边界读取会话窗口" },
  "http:GET /api/agent-sessions/:param/history-head": { since: "0.3.18", summary: "读取会话历史游标" },
  // Additive: a worker below 0.3.6 404s it and the hub's intent-brief
  // distillation degrades to the deterministic excerpt (tier 2).
  "http:GET /api/agent-sessions/:param/brief-source": { since: "0.3.6", summary: "读会话对话(仅蒸馏用文本)" },
  "http:POST /api/agent-sessions/:param/message": { since: "0.2.0", summary: "发消息给会话" },
  "http:POST /api/agent-sessions/:param/paste": { since: "0.2.0", summary: "粘贴图片/长文本" },
  "http:POST /api/agent-sessions/:param/stop": { since: "0.2.0", summary: "停止会话 turn" },
  "http:POST /api/agent-sessions/:param/restart": { since: "0.2.0", summary: "重启会话进程" },
  "http:POST /api/agent-sessions/:param/agent-type": { since: "0.2.0", summary: "切换 agent 类型" },
  "http:POST /api/agent-sessions/:param/model": { since: "0.2.0", summary: "切换会话模型" },
  // Additive: an older worker 404s it, and the UI degrades by hiding the
  // "keep running" button — that worker has no park deadline to defuse.
  "http:POST /api/agent-sessions/:param/background-tasks/:param/keep": { since: "0.3.28", summary: "为后台任务背书,免于超时收尾" },
  // Additive alongside /keep, and degrades the same way: an older worker 404s
  // and the UI hides the button.
  "http:POST /api/agent-sessions/:param/background-tasks/:param/stop": { since: "0.3.28", summary: "停止单个后台任务" },
  "http:POST /api/path/agent-sessions/:param/branch": { since: "0.2.0", summary: "从历史分叉会话" },
  "http:POST /api/agent-sessions/:param/switch-mode": { since: "0.2.0", summary: "权限模式切换" },
  "http:POST /api/agent-sessions/:param/accept-plan": { since: "0.2.0", summary: "接受计划(退出 plan 模式)" },
  "http:POST /api/agent-sessions/:param/approve": { since: "0.2.0", summary: "工具审批决定" },
  "http:DELETE /api/agent-sessions/:param": { since: "0.2.0", summary: "删除会话" },
  "http:PATCH /api/agent-sessions/:param/title": { since: "0.2.0", summary: "改会话标题" },
  "http:PATCH /api/agent-sessions/:param/favorite": { since: "0.2.0", summary: "收藏会话" },
  "ws:/api/agent-sessions/:param/stream": { since: "0.2.0", summary: "会话消息流(JSON Patch)" },

  // --- Executors / processes / terminals ---
  "http:POST /api/path/execute": { since: "0.2.0", summary: "启动 executor 进程" },
  "http:POST /api/execute-one-shot": { since: "0.2.0", summary: "一次性命令执行" },
  "http:POST /api/executor-processes/:param/stop": { since: "0.2.0", summary: "停止 executor 进程" },
  "http:GET /api/executor-processes/running": { since: "0.2.0", summary: "运行中进程列表" },
  "http:POST /api/path/terminals": { since: "0.2.0", summary: "开终端" },
  "http:POST /api/path/terminals/:param/send": { since: "0.2.0", summary: "终端输入" },
  "ws:/api/executor-processes/:param/logs": { since: "0.2.0", summary: "进程日志流" },

  // --- Workflow runs ---
  // Empirically bisected via cross-version e2e: 0.2.4 → 404, 0.2.5 → serves.
  "http:POST /api/path/workflow-runs": { since: "0.2.5", summary: "创建 workflow run" },
  "http:GET /api/path/workflow-runs": { since: "0.2.5", summary: "workflow run 列表" },
  "http:GET /api/path/workflow-runs/reviewer-candidate": { since: "0.2.5", summary: "reviewer 候选查询" },
  "http:GET /api/workflow-runs/:param": { since: "0.2.5", summary: "读 workflow run" },
  "http:POST /api/workflow-runs/:param/gate": { since: "0.2.5", summary: "workflow 用户闸门决定" },
  "http:POST /api/workflow-runs/:param/cancel": { since: "0.2.5", summary: "取消 workflow run" },

  // --- Git / worktrees / diff ---
  "http:GET /api/path/worktrees": { since: "0.2.0", summary: "worktree 列表/状态" },
  "http:POST /api/path/worktrees": { since: "0.2.0", summary: "建 worktree" },
  "http:DELETE /api/path/worktrees": { since: "0.2.0", summary: "删 worktree" },
  // Additive: a worker below 0.3.13 404s it and the hub answers 501 with an
  // "update the worker" message instead of proxying the failure through.
  "http:POST /api/path/worktrees/anchor": { since: "0.3.13", summary: "重锚主工作区分支" },
  // Additive: a worker below 0.3.21 404s it and the hub answers 501 with an
  // "update the worker" message. Deliberately not folded into /anchor, whose
  // live-branch guard would reject the very case this serves.
  "http:POST /api/path/worktrees/anchor-branch": { since: "0.3.21", summary: "改主工作区锚点到指定分支" },
  "http:GET /api/path/branches": { since: "0.2.0", summary: "分支列表" },
  "http:GET /api/path/branches/activity": { since: "0.2.0", summary: "分支活动概览" },
  "http:POST /api/path/branches/merge-status": { since: "0.2.0", summary: "分支合并状态检测" },
  "http:GET /api/path/diff": { since: "0.2.0", summary: "工作区/分支 diff" },
  "http:GET /api/path/commits": { since: "0.2.0", summary: "提交列表" },

  // --- Files ---
  "http:GET /api/browse": { since: "0.2.0", summary: "浏览远端目录(server 管理页)" },
  "http:POST /api/mkdir": { since: "0.2.0", summary: "远端建目录" },
  "http:GET /api/path/browse": { since: "0.2.0", summary: "浏览项目目录" },
  "http:GET /api/path/list-files": { since: "0.2.0", summary: "文件树列举" },
  "http:GET /api/path/file-content": { since: "0.2.0", summary: "读文件内容" },
  "http:GET /api/path/symbol-search": { since: "0.2.0", summary: "符号搜索" },
  "http:GET /api/path/file-download": { since: "0.2.0", summary: "文件下载(可二进制)" },
  "http:POST /api/path/upload": { since: "0.2.0", summary: "文件上传" },
  "http:DELETE /api/path/delete": { since: "0.2.0", summary: "删除文件" },

  // --- Session retention (docs/plans/2026-08-08-session-retention.md §3) ---
  // Both additive. A worker below 0.3.14 404s them; the hub reports the worker
  // as "needs upgrade" in the retention settings UI and — critically — the
  // reconciliation pass treats a 404 exactly like an offline worker and cleans
  // NOTHING, so an old worker can never look like it deleted its sessions.
  "http:PUT /api/settings/session-retention/apply": { since: "0.3.14", summary: "下发会话保留天数" },
  "http:GET /api/path/session-ids": { since: "0.3.14", summary: "会话 id 全量清单(对账用)" },

  // --- Search / notifications / cross-remote ---
  "http:GET /api/path/search-catalog": { since: "0.2.0", summary: "搜索目录快照" },
  // Empirically probed: 0.2.15 → 404, 0.2.16 → 400 (route exists).
  "http:POST /api/notification-outbox/query": { since: "0.2.16", summary: "拉取 worker 通知 outbox" },
  "http:POST /api/path/cross-remote/exec": { since: "0.2.0", summary: "跨远程网关:执行命令" },
  "http:POST /api/path/cross-remote/read-file": { since: "0.2.0", summary: "跨远程网关:读文件" },
  "http:POST /api/path/cross-remote/list-dir": { since: "0.2.0", summary: "跨远程网关:列目录" },
  "http:POST /api/path/cross-remote/stat": { since: "0.2.0", summary: "跨远程网关:stat" },
  "http:POST /api/path/cross-remote/process-list": { since: "0.2.0", summary: "跨远程网关:进程列表" },
  "http:POST /api/path/cross-remote/mcp/open": { since: "0.3.26", summary: "跨远程网关:打开 MCP 会话" },
  "http:POST /api/path/cross-remote/mcp/list-tools": { since: "0.3.26", summary: "跨远程网关:MCP 工具列表" },
  "http:POST /api/path/cross-remote/mcp/call": { since: "0.3.26", summary: "跨远程网关:调用 MCP 工具" },
  "http:POST /api/path/cross-remote/mcp/ping": { since: "0.3.26", summary: "跨远程网关:MCP 心跳" },
  "http:POST /api/path/cross-remote/mcp/close": { since: "0.3.26", summary: "跨远程网关:关闭 MCP 会话" },

  // --- Raw passthrough ---
  // Browser preview proxies caller-supplied paths (and localhost ports) through
  // the tunnel; the path set is unbounded by design, so it registers as one
  // passthrough capability instead of per-route entries.
  "passthrough:browser-proxy": { since: "0.2.0", summary: "浏览器预览透传(任意 path+port)" },
};

export const WORKER_CAPABILITY_KEYS = Object.keys(WORKER_CAPABILITIES);
