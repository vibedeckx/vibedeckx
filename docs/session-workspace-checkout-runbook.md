# Session → Workspace Checkout 迁移发布 runbook

面向运维执行。设计背景见 [`session-workspace-checkout-migration.md`](./session-workspace-checkout-migration.md)，
阶段拆分与验收项见 [`../plans/session-workspace-checkout-migration.md`](../plans/session-workspace-checkout-migration.md)。

**适用范围：Phase 1–7 整体，一次升级。** 计划里的 phase 是开发阶段，不是发布批次——所有迁移都在数据库
打开时按序自动执行，因此从迁移前版本升级上来的实例一次就会跑完全部。已经跑过的阶段是幂等的，会直接跳过；
分批升级的部署只需关注尚未应用的那部分（见 §4 的验证项）。

## 0. 不可回滚点

**Phase 1 起，数据库格式单向前进。**

| 阶段 | 格式变化 | 旧二进制能否读 |
|---|---|---|
| Phase 1 | `workspace_checkouts` 重建：新增 `deleted_at` / `path_source`，去掉 `UNIQUE(workspace_id, target_id)`，改为活跃行部分唯一索引 | **否** —— 旧代码假定该唯一约束存在，同名 branch 重建后会写坏数据 |
| Phase 7 | `agent_sessions` / `remote_session_mappings` 重建：`workspace_checkout_id` 成为真实外键 | 可读（多一个约束），但降级后新写入不再受约束保护 |

因此：**升级前必须备份**，且不得在升级后回滚到不理解 incarnation schema 的旧版本。
每个数据库各自独立——hub 一个，每台 worker 一个。

## 1. 备份

```bash
# hub 与每台 worker 分别执行；WAL 模式下三个文件一起拷
DB=~/.vibedeckx/data.sqlite            # 用了 --data-dir 时改为 <data-dir>/data.sqlite
cp "$DB" "$DB.bak-$(date +%Y%m%d%H%M)"
[ -f "$DB-wal" ] && cp "$DB-wal" "$DB.bak-$(date +%Y%m%d%H%M)-wal"
[ -f "$DB-shm" ] && cp "$DB-shm" "$DB.bak-$(date +%Y%m%d%H%M)-shm"
```

## 2. Dry-run（可选但推荐）

在真实库的**副本**上先跑一次，确认迁移无损：

```bash
cp "$DB" /tmp/rehearse.sqlite
sqlite3 /tmp/rehearse.sqlite \
  "SELECT (SELECT count(*) FROM agent_sessions), (SELECT count(*) FROM remote_session_mappings);"
# 用新版本二进制打开该副本（迁移在打开时自动执行），例如：
vibedeckx start --data-dir /tmp/rehearse-dir --port 0   # 启动后立刻停止
sqlite3 /tmp/rehearse.sqlite "PRAGMA foreign_key_check;"   # 应为空
```

## 3. 升级顺序

**先 hub，后 worker。** 隧道契约是加法式的：新 hub 面对旧 worker 会退回 conventional 路径推导，
反之则不保证。

升级后自愈自动运行，无需人工干预：

- **启动时**：懒导入本地 worktree → 拉取在线 worker 的 worktree 列表 → 分批回填（5 秒预算，未完成的下次继续）
- **worker 重新上线时**：只同步该 worker 并回填它的 mapping

## 4. 验证

**① 自愈日志**

```bash
rg "WorkspaceBinding" <log-file> | tail
# [WorkspaceBinding] startup: bound N session(s). ...
# [WorkspaceBinding] remote <id> reconnect: bound N session(s). ...
```

**② 外键是否已启用**

```bash
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table'
  AND name IN ('agent_sessions','remote_session_mappings')
  AND sql LIKE '%REFERENCES workspace_checkouts%';"
# 期望两行都在
sqlite3 "$DB" "PRAGMA foreign_key_check;"   # 期望为空
```

**③ 运维诊断**

```bash
curl -s -H "x-vibedeckx-api-key: $VIBEDECKX_API_KEY" \
  https://<hub>/api/admin/workspace-binding-read-stats | jq '.database'
```

- `danglingLocal` / `danglingRemote` 必须为 **0**
- `unboundLocal` / `unboundRemote` 允许非零：这些是无法自动判定的隔离行，
  按 `reasons` 分类；外键允许 NULL，不阻塞收紧

**④ 功能烟测**

- 在**非 git 仓库**的项目目录里新建 session（回归保护点）
- 删除一个 worktree → 历史 session 仍可打开，但不能启动新 turn
- 删除一个项目 → 成功，且其 session 与 remote mapping 一并消失

## 5. 停止条件

出现任一情况，**停止推进并回到备份**：

| 现象 | 含义 |
|---|---|
| `PRAGMA foreign_key_check` 非空 | 重建产生了悬空引用，数据不一致 |
| 日志出现 `Refusing to add the workspace_checkout foreign key` | 存在悬空绑定；这是预期的保护行为，**不是**故障——先排查那些行，解决后重启即可完成收紧 |
| 迁移后 session/mapping 行数与备份不符 | 重建丢行 |
| 删除项目报外键错误 | 依赖删除顺序有遗漏 |

注意第二行：拒绝收紧**不影响可用性**——数据库停留在收紧前的 schema，所有读写照常，
未绑定行走 legacy 快照回退。这是设计上的安全网，不需要紧急处理。

## 6. 排查残留未绑定行

```bash
curl -s -H "x-vibedeckx-api-key: $VIBEDECKX_API_KEY" \
  https://<hub>/api/admin/workspace-binding-read-stats | jq '.database.reasons, .database.issues'
```

| 原因 | 处理 |
|---|---|
| `main_not_registered` / `checkout_missing` / `target_missing` | 让对应 worker 上线并列一次 worktree，下次自愈自动绑定 |
| `workspace_missing` | worktree 已删除，**按设计永久保持 NULL**，不要猜 |
| `multiple_incarnations` | 同名 branch 删后重建，旧表无从判定归属；人工比对时间区间后手动 UPDATE，或接受 NULL |
| `project_missing` | 孤儿行，可用 `scripts/cleanup-orphan-sessions.mjs`（默认 dry-run）清理，或保留 |
| `snapshot_mismatch` | 不影响读取（以 checkout 为准），仅提示历史快照写歪 |
