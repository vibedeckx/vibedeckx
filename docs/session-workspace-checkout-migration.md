# Session → Workspace Checkout 关系迁移说明

> 状态：待单独实施
>
> 本文只记录迁移背景、目标模型和实施边界，不包含本次 workspace registry
> 改动的实现。正式施工前仍需确认删除语义、远程版本兼容和发布顺序。

## 1. 背景

一个 agent session 实际运行在某个确定的 checkout 上。这个 checkout 同时确定：

- 所属逻辑 workspace；
- 执行目标是本机还是某个 remote；
- worktree 的物理路径；
- workspace 创建时的稳定 branch；
- 当前 checkout 是否仍然存在、是否发生分支漂移。

当前已引入两层 workspace registry：

```text
projects
  └─ workspaces                         逻辑 workspace
       └─ workspace_checkouts           某台机器上的实际 checkout
```

其中：

- `workspaces` 以 `(project_id, branch)` 唯一标识逻辑 workspace；
- `workspace_checkouts` 以 `(workspace_id, target_id)` 唯一标识一个实际 checkout；
- `target_id = 'local'` 表示本机；其他值为 hub 数据库中的
  `remote_server_id`；
- `expected_branch` 是稳定身份，Git 当前分支只是运行时状态。

但是 session 目前还没有通过外键连接到这套 registry。

## 2. 当前数据库关系

### 2.1 本地 session

`agent_sessions` 当前保存：

```text
id, project_id, branch, ...
```

它通过 `(project_id, branch)` 与 `workspaces` 进行约定式关联，target 隐含为
`local`。数据库没有外键保证对应 workspace/checkout 一定存在。

### 2.2 远程 session

hub 上的远程 session 主要由 `remote_session_mappings` 表示：

```text
local_session_id
project_id
remote_server_id
remote_session_id
branch
```

它可以通过 `(project_id, branch, remote_server_id)` 推导出
`workspace_checkouts`，但同样没有正式外键。

worker 数据库中还存在真正执行进程的 `agent_sessions` 行。该行属于 worker
上的 path-based pseudo project，并应关联 worker 本地 registry 中
`target_id = 'local'` 的 checkout。hub 与 worker 的两条 session 记录继续通过
`remote_session_mappings.remote_session_id` 路由，不要求两边共享 workspace UUID。

## 3. 目标模型

推荐让 session 直接引用 `workspace_checkouts`，因为 checkout 已经同时表达
workspace 和 target：

```text
projects
  └─ workspaces
       └─ workspace_checkouts
            ├─ agent_sessions                 本机/worker 实际 session
            └─ remote_session_mappings        hub 上的远程 session handle
```

建议新增 nullable 字段作为过渡：

```sql
ALTER TABLE agent_sessions
  ADD COLUMN workspace_checkout_id TEXT;

ALTER TABLE remote_session_mappings
  ADD COLUMN workspace_checkout_id TEXT;
```

目标约束为：

```sql
FOREIGN KEY (workspace_checkout_id)
  REFERENCES workspace_checkouts(id)
```

迁移完成后：

- session 的 workspace/target 身份以 `workspace_checkout_id` 为准；
- `project_id`、`branch`、`remote_server_id` 可暂时保留为兼容字段或查询投影；
- agent 切换 Git 分支时绝不更新 session 关联；
- 新建 session 必须先解析并验证 checkout，再写 session；
- 发送后续 turn 时应复用 session 已绑定的 checkout，而不是重新按当前 Git
  branch 猜测。

## 4. 必须先解决的生命周期问题

当前删除 worktree 会硬删除 `workspace_checkouts`；最后一个 checkout 删除后还会
硬删除 `workspaces`。这与“历史 session 长期保留”冲突：一旦加入外键，删除
checkout 会让历史 session 失去引用目标。

推荐在正式绑定 session 前，把 workspace registry 改为保留墓碑：

- 为 `workspace_checkouts` 增加 `deleted_at`，或增加 `deleted`/`archived` 状态；
- worktree 删除成功后保留 checkout 行，只标记已删除；
- `workspaces` 只在明确清理全部历史数据时删除；
- 默认 workspace 列表过滤已删除 checkout；
- 历史 session 页面仍可显示原 workspace、target 和路径快照；
- 同名 branch 重新创建时，需要决定复用原 workspace/checkout，还是创建新的
  incarnation。推荐为 checkout 增加独立生命周期并创建新行，避免新旧 session
  混在同一物理实例上。

如果暂时不采用墓碑，备选方案是外键 `ON DELETE SET NULL`，同时在 session 上保留
branch/target 快照。但这样只能保留展示信息，无法保持完整关系，不作为首选。

## 5. 建议迁移步骤

### Phase 1：加字段，继续旧读法

1. 给 `agent_sessions` 和 `remote_session_mappings` 增加 nullable
   `workspace_checkout_id`。
2. repository 开始双写新字段和现有 branch/remote 字段。
3. 读取仍以旧字段为准，但对新旧关系不一致记录诊断日志。
4. 老 worker 不认识新字段时，hub 必须继续兼容旧的远程 session 创建响应。

### Phase 2：回填

本地 session：

```text
agent_sessions(project_id, branch)
  → workspaces(project_id, branch)
  → workspace_checkouts(workspace_id, 'local')
```

hub 远程 mapping：

```text
remote_session_mappings(project_id, branch, remote_server_id)
  → workspaces(project_id, branch)
  → workspace_checkouts(workspace_id, remote_server_id)
```

回填要求：

- 分批、幂等，可安全重跑；
- 只填充 NULL，不覆盖已经绑定的 checkout；
- 找不到 registry 行时先记录异常，不凭 branch 静默绑定到其他 checkout；
- 对旧的 path-based worker 数据，可复用现有 registry 懒导入逻辑；
- 输出无法回填的 session 数量和具体原因，不能在迁移中静默丢弃。

### Phase 3：切换读取源

1. session 列表、恢复、发送消息、通知、搜索索引优先使用
   `workspace_checkout_id`。
2. branch 和 target 从 checkout/workspace join 得到。
3. 对尚未回填的旧行保留旧字段 fallback，并增加指标。
4. 当 fallback 使用率归零后，再考虑把新字段变成 `NOT NULL`。

### Phase 4：收紧约束

1. 验证所有活跃和历史 session 都已回填或被明确隔离。
2. 重建 SQLite 表，正式加入外键和必要索引。
3. 停止使用 `(project_id, branch, target)` 作为 session 身份。
4. 是否删除重复字段另行决定；保留它们作为不可变快照通常比立即删除更安全。

## 6. 事务与失败恢复

session 写入和 registry 写入都在同一个 SQLite 数据库时，应使用一个数据库事务：

```text
解析 checkout → 校验 ready/可用 → 创建 session → 创建 remote mapping
```

但远程 worker 创建涉及网络和另一份数据库，无法做跨机器 ACID 事务。应继续采用
saga/idempotency：

```text
hub 预分配 session id
  → hub 记录 pending intent
  → worker 幂等创建 session 并绑定 worker checkout
  → hub 写 remote mapping 并绑定 hub checkout
  → confirmed
```

任何一步失败都必须可重试，并使用预分配 session id 防止重复创建。不能通过分布式
锁假装获得跨数据库事务。

checkout 状态描述的是物理 checkout 的健康状态，不是最近一次 API 操作的结果：

- 已有 `ready` checkout 的重复创建被 worker 拒绝时，仍保持 `ready`；
- 删除因未提交修改等安全条件被拒绝时，从 `deleting` 恢复为 `ready`；
- 只有能够证明 checkout 本身不可用的失败才写成 `error`；
- reconcile 写状态必须使用 compare-and-set，不能用旧 Git/数据库快照覆盖已经完成的
  创建或删除。

远程 checkout 的物理路径必须最终以 worker 为权威。新版 worker 的创建/查询响应应
附带实际 `worktreePath`，hub 持久化该值；旧 worker 缺少该字段时可以暂时退回
conventional path 推导，但推导结果只能视作兼容快照，不能在未来的 session 绑定中
覆盖 worker 已报告的真实路径。

## 7. 索引建议

至少增加：

```sql
CREATE INDEX idx_agent_sessions_workspace_checkout
  ON agent_sessions(workspace_checkout_id, updated_at DESC);

CREATE INDEX idx_remote_session_mappings_workspace_checkout
  ON remote_session_mappings(workspace_checkout_id);
```

现有按 `(project_id, branch)` 的索引在兼容期继续保留。

## 8. 验收标准

- 新建本地 session 必须绑定唯一的 local checkout；
- 新建远程 session 的 hub mapping 和 worker session 各自绑定正确 checkout；
- agent 在 session 中切换 Git branch 后，session 仍归属原 checkout；
- workspace 删除后，历史 session 仍能展示原 workspace 和 target；
- 同一个 branch 在多个 remote 上的 session 不会串到其他 target；
- 回填可重复运行且结果一致；
- hub 新版本与旧 worker 组合有明确 fallback，不中断现有 session；
- 数据库能够查询并报告所有未绑定或绑定失效的 session。

## 9. 本文不决定的事项

- workspace/checkouts 的墓碑保留期限；
- 同名 branch 重建时是否视为同一个逻辑 workspace；
- 历史 session 删除是否触发墓碑清理；
- 何时将 `workspace_checkout_id` 改为 `NOT NULL`；
- 何时停止兼容未升级 worker；
- 是否最终合并本地 `agent_sessions` 与 hub `remote_session_mappings` 模型。
- 何时要求所有 worker 在 worktree 响应中返回权威物理路径。

这些事项需要在正式迁移设计中单独确认，不能由数据库迁移脚本隐式决定。
