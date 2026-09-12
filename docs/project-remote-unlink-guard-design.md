# Project remote unlink guard — 设计

状态：已实现（dev3，2026-09-11，未提交）。hub 侧完整；worker 侧多了一个附加字段 `gitError`（见 §3 最后一条），旧 worker 不带它时退回到旧行为，要让这条守卫对某台机器生效需要它跑上带该字段的 worker。`syncRemoteWorktreeList` 已抽到 `workspace-binding-backfill.ts`。

## 1. 问题

Project Settings 里删除一个 remote（`DELETE /api/projects/:id/remotes/:rid`）目前没有任何占用检查，也没有确认弹窗。点一下就解除项目与这台机器的绑定，hub 侧随即失去对这台机器上的 workspace、会话、定时任务的引用，而这些东西在远端机器上原样留着。

全局 Settings → Remote Servers 的 Delete（`DELETE /api/remote-servers/:id`）是另一个问题：`project_remotes.remote_server_id` 有外键且无 CASCADE，`foreign_keys = ON`，路由是裸 DELETE。只要机器还挂在任何项目上就抛 `FOREIGN KEY constraint failed` → 500，UI 显示 "Failed to delete server"，而弹窗文案却说 "will also remove it from any projects that reference it"。

## 2. 术语

- **解绑（unlink）**：删除一行 `project_remotes`。不通知 worker，不删除远端任何东西。
- **占用（usage）**：hub 库中按 `(project_id, remote_server_id)` 挂在这台机器上、解绑后会失去引用的记录。定义见 §4。
- **可确认（reachable）**：解绑那一刻隧道在线，且现场重同步 worktree 列表成功。
- **无法确认（unreachable）**：隧道离线，或在线但重同步失败（超时、worker 异常）。

## 3. 判定规则

判定在解绑请求到达时现场做，依据是**当下连通性**，不是历史同步标记 `worktrees_synced_at`。

```
resolve rid → (project_id, remote_server_id, remote_path, worktrees_synced_at)
│
├─ reverseConnectManager.isConnected(remote_server_id) == false
│     → unreachable
│
├─ 在线 → snapshotLiveCheckouts → GET /api/path/worktrees（10s 上限）
│         → syncRemoteWorktreeList(data, snapshot)（含 reconcileReportedWorktrees）
│     ├─ 失败 → unreachable（reason = sync-failed；登记表未被改动）
│     └─ 成功 → 登记表已对账（新登记 + tombstone 远端不再上报的分支）
│               → 事务内统计占用
│                   ├─ 有占用 → 409 remote-in-use（硬拦，force 无效）
│                   └─ 无占用 → 删除，200
│
└─ unreachable
      ├─ 无 force → 409 remote-unreachable（附上次已知占用）
      └─ force   → 删除，200
```

要点：

- **已确认有占用时没有 force**。出路都存在：在远端删掉 worktree 后重试（重同步会 tombstone）、改定时任务 target。
- **unreachable 态才有 force**。hub 无法区分「周末关机」和「机器报废」，只有用户知道。force 的唯一存在理由是永远回不来的机器：没有它，这条绑定永远解不掉，全局 Remote Servers 也因项目引用删不掉。
- `worktrees_synced_at` 不参与拦/放决定。它只影响 unreachable 弹窗里「上次已知占用」那段的措辞（§7）。
- **重同步必须走对账路径，不能复用 link 时的 `syncLinkedRemoteWorktrees`**。后者调用的是只增不删的 `registerReportedWorktrees`，远端已手动删掉的 worktree 仍会留在登记表里导致 409，「在远端删掉 worktree 后重试」这条出路就是假的。正确做法是 `worktree-routes.ts` 里 machine-check 已有的模式：请求前 `snapshotLiveCheckouts(storage, projectId, serverId)`，拿到列表后 `syncRemoteWorktreeList(fastify, projectId, remote, data, snapshot)`，它内部走 `reconcileReportedWorktrees`（tombstone 未上报的 ready 行，主 workspace 除外）并 `markWorktreesSynced`。需要把 `syncRemoteWorktreeList` 从 `worktree-routes.ts` 导出或抽到共享模块。
- `GET /api/path/worktrees` since 0.2.0，重同步不引入新的 tunnel 调用，capabilities 注册表不变。
- **worker 端 Git 读取失败不能被当成「确认无占用」**。worker 列表走 `readWorktreeListTolerant`，Git 报错（dubious ownership、权限、HEAD 损坏）时静默退回「只有主 workspace」的列表；hub 若照单对账，会 tombstone 这台机器上所有非主 checkout，随后无需 force 即可解绑。因此 worker 的 `GET /api/path/worktrees` 在 Git 读不出、且不能确认目录是「可见的非仓库目录」（路径不存在、不可遍历、或 `.git` 存在）时附加 `gitError: string`（响应字段，附加式，旧 hub 忽略），hub 的 `syncRemoteWorktreeList` 见到它即视为「不是真实列表」→ unreachable（reason = sync-failed），登记表不动。旧 worker 不发这个字段，hub 无法区分，维持旧行为。

## 4. 占用的定义

全部限定 `project_id = 当前项目`。同一 server 可挂多个项目，其他项目的占用不阻止本项目解绑。

| # | 来源 | 查询条件 | 计入理由 |
|---|------|---------|---------|
| 1 | `workspace_checkouts` | join `workspaces` 取 `project_id`，`target_id = serverId`，`deleted_at IS NULL`，再排除 `branch = ''` | 远端 worktree。任何未删状态都计入（ready / creating / error），creating 是在途创建，error 保守计入 |
| 2 | `scheduled_tasks` | `project_id` + `target = serverId` | 不挂在任何 worktree 上；解绑后每次到点失败，错误只写进 run 记录 |

**会话、创建中的会话、运行中的执行器不计入**（2026-09-12 定案，替换早先把它们都算占用的版本）。理由：它们都跑在某个 worktree 里，worktree 还在就已经被第 1 项拦住；删 worktree 的路径本身会先停掉或拒绝有活进程的会话和执行器，「正在运行」是删 worktree 时的拦截问题，不是解绑的。已结束的会话解绑后只是失去 hub 侧入口（§8），重新绑定即恢复。把全部历史会话算占用会让一台用了很久的机器在线时永远解不了绑（实例：653 个历史会话），而「删掉这些会话」不是现实的出路。

**主 workspace 豁免**：`branch === ""` 的 checkout 不计入。理由写进代码注释：它是仓库本身，`workspace-binding-backfill.ts` 的对账循环明确不 tombstone 它，列表接口也不给它 `machines`（按定义在每台机器上都在）；它不是解绑会遗留的、被创建出来的 worktree。没有这条豁免，任何正常同步过的 remote 永远解不了绑。

**有意留下的缝隙**：正跑在主分支上的会话或执行器。主 workspace 删不掉，所以没有任何一道 worktree 闸门会碰到它。解绑后 worker 上那个进程继续跑，hub 只是丢了指针，那个会话页面会断掉，重新绑定同一台机器后恢复。这是用户自己点解绑时才会发生、且可恢复的事，不为它多加一次隧道调用（曾考虑只对主分支查 worker 的 alive 接口，放弃）。

## 5. API 契约

### 5.1 `DELETE /api/projects/:id/remotes/:rid[?force=1]`

- 200 `{ success: true }`
- 404 项目或 project_remote 不存在（不变）
- 409 `remote-in-use`（force 被忽略）：

```json
{
  "error": "<server_name> still has 2 workspaces and 1 schedule in this project.",
  "errorCode": "remote-in-use",
  "serverId": "…",
  "name": "<server_name>",
  "usage": {
    "workspaces": ["dev3", "feat-x"],
    "schedules": ["nightly-build"]
  }
}
```

- 409 `remote-unreachable`：

```json
{
  "error": "<server_name> is offline; its workspaces cannot be confirmed.",
  "errorCode": "remote-unreachable",
  "serverId": "…",
  "name": "<server_name>",
  "reason": "offline" | "sync-failed",
  "lastConnectedAt": "2026-09-01T12:00:00Z" | null,
  "lastSyncedAt": "2026-08-30T08:00:00Z" | null,
  "tokenRevoked": false,
  "lastKnownUsage": { …同上… } | null
}
```

- `reason`：`offline` = 隧道不在线；`sync-failed` = 在线但 10 秒内没拿到合法的 worktree 列表（超时、network_error、worker 返回异常形状）。
- `lastSyncedAt` = `project_remotes.worktrees_synced_at`，上次成功对账的时间，是 `lastKnownUsage` 的时间戳。`lastConnectedAt` 是机器最后在线时间，两者不能互相替代。
- `lastKnownUsage` 为 null 当且仅当 `lastSyncedAt` 为 null（从未成功读取过，登记表没有「上次已知」的价值）。
- `tokenRevoked` 为 true 时这台机器不可能再上线。repository 把数据库 null 映射成 `undefined`（`connect_token ?? undefined`，`last_connected_at ?? undefined`），路由用 `== null` 判缺失，并把缺失的 `lastConnectedAt` / `lastSyncedAt` 规范化为契约里的 `null`。

### 5.2 `DELETE /api/remote-servers/:id`

保留外键，不加 CASCADE。路由先查引用：

- 有项目引用 → 409 `{ error: "Still attached to N project(s): …", errorCode: "remote-server-in-use", projects: [{id,name}] }`
- 无引用 → 照旧删除

## 6. 后端实现

### 6.1 storage

`projectRemotes` 新增一个方法，把统计和删除放进同一个 `kdb.transaction()`，在 SQLite 写锁下原子：

```ts
removeGuarded(id, projectId, opts: { force: boolean; reachable: boolean }):
  Promise<
    | { outcome: "removed" }
    | { outcome: "not-found" }
    | { outcome: "in-use"; usage: RemoteUsage }
  >
```

- `reachable && !force`：统计 §4 两项，非空则 `in-use`，否则删除 + 重排 sort_order（复用现有 `remove` 的逻辑）。
- `!reachable && !force`：统计后**总是**返回 `in-use` 形态的数据作 `lastKnownUsage`，不删除（路由据此组装 `remote-unreachable`）。
- `force`：只在 `!reachable` 时由路由传入，直接删除。

两项统计各自是一条按 `(project_id, remote_server_id)` 的 select。

### 6.2 路由顺序

1. `requireAuth`，`projects.getById(id, userId)`。
2. `projectRemotes.getByProject(id)` 找到 `rid` 对应行，取 `remote_server_id` / `remote_path` / `worktrees_synced_at`。
3. `reverseConnectManager.isConnected(serverId)`。不在线 → `reachable = false, reason = "offline"`。在线 → `snapshot = snapshotLiveCheckouts(storage, project.id, serverId)` → `proxyToRemoteAuto(serverId, "GET", "/api/path/worktrees?path=…", undefined, { reverseConnectManager: fastify.reverseConnectManager, timeoutMs: 10_000 })`（`reverseConnectManager` 必传：`remote-proxy.ts:48` 没有它就直接返回 network_error，在线机器会被误判成 unreachable，从而放开 force） → `reachable = result.ok && await syncRemoteWorktreeList(fastify, project.id, { serverId, remotePath }, result.data, snapshot)`，不成立则 `reason = "sync-failed"`。同步失败时登记表不得被改动（snapshot 之后没有写入）。
4. `removeGuarded(rid, project.id, { force: query.force === "1" && !reachable, reachable })`。
5. 按 outcome 组装 200 / 404 / 409。`remote-unreachable` 额外读 `remoteServers.getById` 取 `last_connected_at`、`connect_token`，加上第 2 步已拿到的 `worktrees_synced_at` 作 `lastSyncedAt`。

### 6.3 并发

- 新建类路径的顺序是「读 association → `intents.begin` → 调 worker」。解绑事务可以插在前两步之间，产生一条随后对账时被标为 "association no longer exists" 的 intent。窗口极小、有明确错误、重新绑定后可恢复，**容忍**，不加锁。
- 解绑之后发起的新建，在 `shared-services.ts` chat start、`agent-session-lifecycle-routes.ts`、`schedule-routes.ts` 的 association 检查处被拒。

## 7. 前端

### 7.1 `lib/api.ts`

`removeProjectRemote` 目前只 `throw new Error(error.error)`，丢掉 errorCode 和明细。改为照 `resident_limit_reached` 的先例把 409 body 整体抛出（`ApiError` 带 `errorCode` 与 body）。签名增加 `opts?: { force?: boolean }`。

### 7.2 `project-settings-form.tsx`

点击垃圾桶 → 直接调 DELETE（无预检，一次往返）：

- 200 → 刷新列表。
- `remote-in-use` → 弹窗「无法解绑」，列出 `usage`：workspace 分支名、定时任务名。给出出路文案：在那台机器上删掉 workspace 后重试；把定时任务改到别的 target。只有「知道了」按钮。
- `remote-unreachable` → 弹窗「无法确认」，标题行按 `reason` 分开写，因为这是用户决定要不要点 Unlink anyway 的依据：
  - `reason = "offline"`：「`<name>` 离线，最后在线 `lastConnectedAt`」（null 显示「从未连接」）；`tokenRevoked` 为 true 时改为「`<name>` 的连接令牌已吊销，不会再上线」。
  - `reason = "sync-failed"`：「`<name>` 在线，但读取它的 workspace 列表失败（超时或 worker 异常）。可以稍后重试。」不显示离线字样。
  - 占用段：`lastKnownUsage` 非 null 显示「截至 `lastSyncedAt` 的上次同步，它有：…（可能已过期）」；为 null 显示「从未成功读取过这台机器的 workspace」。
  - 后果段三句：不会删除那台机器上的任何东西；hub 会失去对它上面 workspace、会话（含历史）、定时任务的引用；重新绑定同一台机器可恢复大部分。
  - 按钮：取消 / **Unlink anyway**（带 `force`）。

### 7.3 `remote-servers-settings.tsx`

删机器的确认弹窗文案改为「必须先从所有引用它的项目里解绑」；收到 `remote-server-in-use` 时把项目名列出来。

## 8. 解绑后的遗留（有意不清理）

- `workspace_checkouts` 行留着，不显示（机器列表来自 `project_remotes`）；重新绑定后重新出现并对账。
- `remote_session_mappings` 行留着（在线解绑时不提示，见 §4）；重启后被跳过，重新绑定再重启即恢复。
- pending intents 留着，对账时记错；重新绑定后可再试。
- `remote_executor_processes` running 行留着；worker 上的进程继续跑。
- 远端机器上的 worktree、会话、进程全部原样。

不清理是为了让 force 可逆。

## 9. 测试

后端（vitest，`project-remote-routes` + storage）：

1. 在线、无占用 → 200，行已删。
2. 在线、只有主 workspace checkout → 200。
3. 在线、有非主 checkout → 409 in-use，`usage.workspaces` 含分支名。
4. 在线、有会话映射 / pending intent / running 执行器进程但无非主 checkout → 200，这些行原样留下。
5. 在线、定时任务 target 指向该 server → 409 in-use，`schedules` 含名字。
6. 在线、creating / error 状态的非主 checkout → 409 in-use（对账不动它们）。
7. 在线、其他项目有占用、本项目无 → 200。
8. 在线、登记表有 ready checkout `feat-x`、远端列表不再上报它 → 该 checkout 被 tombstone → 200（出路可行；这条同时是「必须走 reconcile 而非 register」的回归）。
9. 离线、`worktrees_synced_at` 非 null、有旧占用 → 409 unreachable，`reason = "offline"`，`lastKnownUsage` 非 null，`lastSyncedAt` 等于该值。
10. 离线、`worktrees_synced_at` 为 null → 409 unreachable，`lastKnownUsage` 与 `lastSyncedAt` 均为 null。
11. 离线 + `force=1` → 200。
12. 在线、有占用 + `force=1` → 仍 409 in-use。
13. 在线、worker 10 秒超时（或返回 network_error / 非数组 body）→ 409 unreachable，`reason = "sync-failed"`，`lastKnownUsage` 来自旧登记表，且登记表与请求前完全一致（无新增、无 tombstone、`worktrees_synced_at` 未更新）。
14. 同 13 + `force=1` → 200。
15. 离线、`connect_token` 已吊销 → `tokenRevoked = true`。
16. 全局删除：有项目引用 → 409 `remote-server-in-use`；无引用 → 200；不再出现 FK 500。

前端（vitest）：`removeProjectRemote` 抛出带 errorCode 的错误；两种弹窗按 body 渲染。

## 10. 明确不做

- 按台删除 checkout（既定决策）。
- 离线超过 N 天自动视为无占用。
- 解绑时通知 worker 或删除远端任何东西。
- 给 `project_remotes` 外键加 CASCADE。
- 解绑时清理 §8 列出的遗留行。
