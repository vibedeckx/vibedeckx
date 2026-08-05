# Plan: Session → Workspace Checkout 关系迁移

> Source PRD: [`docs/session-workspace-checkout-migration.md`](../docs/session-workspace-checkout-migration.md)
>
> 目标：让本地 session、worker 实际 session 与 hub remote session handle 都绑定到确定的
> `workspace_checkouts` 记录，不再依靠当前 Git branch 或约定路径推测运行位置。

## Implementation status

- Phase 1：完成。
- Phase 2：完成。核心写入、运行路径和 fallback/dangling/mismatch 指标均已接入。
- Phase 3：完成。新旧 hub/worker 的四种协议组合已有契约测试。
- Phase 4：完成。标准远程创建、conversation branch 与 workflow reviewer 均纳入持久化 saga，registry、
  mapping 双写和发现入口已完成；旧 worker 明确成功的 reviewer 响应保留非重放兼容路径。
- Phase 5：完成。Storage 运维接口支持分批/dry-run 回填、稳定原因码、计数和具体问题记录。
- Phase 6：代码实施完成。运行路径、session 列表/详情、Project Activity、全局 session 搜索、Project Chat、workflow reviewer
  和本地/远程通知归属已切到 checkout-first 投影；墓碑历史与 legacy/dangling 区分已有测试。branch activity、
  搜索目录构建和 worktree 兼容导入也已停止读取绑定行的快照 project/branch。逐消费者指标可通过 operator-only
  `/api/admin/workspace-binding-read-stats` 观察；生产样本窗口 fallback 清零仍待发布后验证。Phase 7 尚未开始，
  FK 收紧必须等待该外部门禁通过。

## User stories

- **US1 本地绑定**：新建本地 session 必须绑定唯一、可用的 local checkout。
- **US2 远程绑定**：hub mapping 和 worker session 分别绑定各自数据库里的正确 checkout。
- **US3 分支漂移安全**：agent 在 checkout 中切换 Git branch 后，session 仍属于创建时的 checkout。
- **US4 历史保留**：worktree 删除后，历史 session 仍能展示原 workspace、target 和路径。
- **US5 incarnation 隔离**：同名 branch 重建时创建新 checkout，新旧 session 不串联。
- **US6 target 隔离**：同一 branch 在多个 remote 上的 session 始终归属正确 target。
- **US7 安全回填**：历史数据回填可分批、幂等重跑，不确定数据不被静默误绑。
- **US8 滚动兼容**：新 hub 与未升级 worker 组合仍能创建和继续 session。
- **US9 可运维性**：系统能查询并报告未绑定、悬空、已删除和快照不一致的 session。

## Architectural decisions

以下决策跨越所有阶段，实施中不应由单个 migration 脚本隐式改变。

- **逻辑 workspace 身份**：继续以 `(project_id, branch)` 唯一标识。主 workspace 在数据库内统一使用
  `branch = ''`；API 边界可投影为 `null`。
- **Checkout incarnation**：物理 checkout 删除后保留原行并设置 `deleted_at`。同一
  workspace/target 重建时新建 checkout ID，不复用墓碑行。
- **活跃唯一性**：同一 `(workspace_id, target_id)` 最多有一条 `deleted_at IS NULL` 的 checkout；
  历史 incarnation 可并存。
- **Workspace 状态**：状态只由未删除 checkout 聚合。没有活跃 checkout 的逻辑 workspace 进入
  `archived`，默认列表不展示，历史查询可展示。
- **Registry 寻址**：按 project/branch/target 查询只解析当前活跃 checkout；状态变更、CAS 和墓碑操作
  必须按 checkout ID 寻址。
- **Session 身份**：`agent_sessions` 和 `remote_session_mappings` 增加 nullable
  `workspace_checkout_id`。新建数据以该字段为身份真值；`project_id`、`branch`、
  `remote_server_id` 保留为不可变兼容快照。
- **启动资格**：只有未删除且 `ready` 的 checkout 可创建 session 或启动新 turn。墓碑 checkout
  只支持历史展示。
- **分支漂移**：`expected_branch` 和 session 绑定在 checkout 创建后不随 Git HEAD 变更。
- **会话分支**：从历史会话创建 conversation branch 时，新 session 默认继承源 session 的
  checkout ID，而不是重新根据 branch 推测。
- **本地事务边界**：checkout 解析、可用性校验和 session/mapping 写入在同一 SQLite 事务中完成。
- **远程事务边界**：hub/worker 不追求跨库 ACID，使用预分配 session ID 和持久化
  pending/confirmed intent 实现幂等 saga。
- **远程路径权威**：新 worker 在 worktree 创建和查询响应中返回 `worktreePath`，hub 以它为准。
  字段缺失表示旧 worker，允许使用 conventional path 兼容快照，但不得覆盖已获得的权威路径。
- **外键语义**：普通 worktree 删除不删 checkout 行。最终 session 外键使用 restrict/no-action 语义；
  project 全量清理是独立、显式的依赖图删除操作。
- **滚动迁移**：在旧数据 fallback 归零前不增加 `NOT NULL`。不能回填的行保持 nullable 并报告，
  不根据 branch 静默猜测其 incarnation。
- **Schema 发布**：checkout incarnation 表重建是前向格式升级。发布前备份数据库；升级后不回滚到
  仍假定 `UNIQUE(workspace_id, target_id)` 的旧二进制。

---

## Phase 1: Checkout 墓碑与 incarnation

**User stories**: US4, US5

### What to build

将 workspace registry 升级为可保留历史 incarnation 的结构。从一条真实的本地 worktree 创建、删除、
重建走通端到端链路：删除只标记墓碑，重建产生新 checkout ID，普通列表和 reconcile 只处理
活跃 checkout，历史查询仍能读取旧路径与 target。同时将所有 registry mutation 改为按 checkout ID
寻址，避免多 incarnation 下的批量误更新。

### Acceptance criteria

- [x] 旧库可幂等升级，现有 checkout ID、路径、状态和时间戳保持不变。
- [x] 数据库允许同一 workspace/target 保留多个 incarnation，但拒绝第二个未删除 checkout。
- [x] 创建或采纳已存在活跃 checkout 仍幂等，不会复用或覆盖墓碑行。
- [x] 状态变更、CAS 和删除只能影响指定 checkout ID。
- [x] 删除 worktree 后 checkout 行仍存在且记录 `deleted_at`；最后一个 checkout 删除后 workspace 仍存在并为 archived。
- [x] 同名 branch 重建后获得新 checkout ID，旧 checkout 的路径和时间戳不变。
- [x] 默认 workspace 列表不返回墓碑，历史查询可返回墓碑。
- [x] 意外丢失物理路径的活跃 checkout 标记为 `error`，不会被误当成显式删除墓碑。
- [x] 已墓碑 checkout 不参与 workspace 状态聚合或 reconcile。
- [x] 替换现有“最后 checkout 被删除则 workspace 消失”的测试，增加删除/重建/CAS 竞态测试。

---

## Phase 2: 本地 Session 端到端绑定

**User stories**: US1, US3, US5, US9

### What to build

为本地 `agent_sessions` 建立 nullable checkout 关系，并让一条新本地会话从创建到后续 turn 始终使用
同一 checkout。创建时在单一事务内解析和校验活跃 local checkout，写入 session 及旧快照字段。恢复、
唤醒、restart、模式切换、conversation branch 和 turn snapshot 都从 session 的 checkout 取物理路径。
历史 NULL 行仍使用旧逻辑，但产生可聚合诊断。

### Acceptance criteria

- [x] 新库和旧库都获得 nullable `agent_sessions.workspace_checkout_id` 及兼容期索引。
- [x] 新建本地 session 在 checkout 不存在、已删除或非 ready 时失败，不留下半成品 session 行。
- [x] 主 workspace 在首次创建 session 前可幂等注册为 `branch = ''` 的 local checkout。
- [x] 新 session 同时写 checkout ID 和 project/branch 快照，两者不一致时记录诊断。
- [x] 正在运行和从数据库恢复的 session 都保留 checkout ID，不在内存中只保留 branch。
- [x] agent 在物理 checkout 中切换 Git branch 后，后续 turn、restart 和 snapshot 仍使用原 checkout 路径。
- [x] conversation branch 继承源 session 的 checkout ID，包括源 session 已发生 Git branch drift 的情况。
- [x] checkout 被删除后历史 session 仍可读，但启动新 turn 返回明确的 checkout-deleted 错误。
- [x] NULL 历史行仍能读取和执行旧 fallback，且指标能区分 fallback、悬空 FK 和快照不一致。

---

## Phase 3: Worker 绑定与远程路径协议

**User stories**: US2, US3, US8, US9

### What to build

让 worker 上的 path-based pseudo project 也完成 Phase 2 的本地 checkout 绑定，并扩展 worktree 创建与查询响应，
返回 worker 实际使用的 `worktreePath`。字段为可选的加法协议：新 hub 按字段是否存在判断 worker
能力，无需把响应字段伪装成新 route capability。

### Acceptance criteria

- [x] worker 在 path-based session 创建前幂等导入或注册 pseudo project 的 local checkout。
- [x] worker session 写入本机 checkout ID，不使用 hub 的 workspace/checkout UUID。
- [x] worker 恢复和后续 turn 使用已绑定的实际路径，Git branch drift 不改变绑定。
- [x] 新 worker 的 worktree 创建和查询响应包含实际 `worktreePath`。
- [x] 新 hub 遇到缺少 `worktreePath` 的旧 worker 时使用 conventional fallback，不中断现有 session。
- [x] 旧 hub 可忽略新 worker 的额外字段，响应形状保持向后兼容。
- [x] 已持久化权威路径不会被后续旧 worker 的推导路径覆盖。
- [x] 协议组合测试覆盖新/旧 hub 与新/旧 worker 的可支持组合。

---

## Phase 4: Hub 远程 Session 端到端绑定

**User stories**: US2, US5, US6, US8, US9

### What to build

在 hub 上为远程 workspace 建立可同步的 registry，包括 main checkout、旧 worker 上已存在的 worktree 和外部
创建的 worktree。为 `remote_session_mappings` 增加 nullable checkout 关系，并让新建、列表发现、搜索发现、
conversation branch 与 workflow reviewer 都绑定到对应 remote target 的 checkout。远程创建使用持久化
intent 记录跨 hub/worker 步骤，使任一步失败都可以使用同一预分配 ID 重试。

### Acceptance criteria

- [x] hub 能从 worker 创建/查询响应幂等同步 remote checkout，包括 `branch = ''` 的 main checkout。
- [x] remote registry 优先使用 worker 报告的路径，旧 worker 才使用标记为兼容快照的推导路径。
- [x] 新 `remote_session_mappings` 同时写 hub checkout ID 和 project/branch/remote 快照。
- [x] 同一 project/branch 在两个 remote 上创建 session 时，两个 mapping 指向不同 target checkout。
- [x] session 列表、搜索、打开旧 session、conversation branch 和 workflow reviewer 每个入口都可创建正确绑定。
- [x] 远程创建在 worker 调用前写 pending intent，成功后写 mapping 并 confirmed。
- [x] worker 创建成功但 hub 写 mapping 失败后，重启或重试不会创建第二个 worker session。
- [x] 不同的失败点（worker 拒绝、5xx、传输中断、hub DB 失败、hub 重启）都有可重跑测试。
- [x] 旧 worker 响应没有 checkout/path 扩展时，新 hub 仍能双写 mapping，并记录兼容 fallback 指标。
- [x] conversation branch 有可持久化、可重放的 intent，并以同一 source、cutoff 和预分配 session ID 恢复。
- [x] workflow reviewer 的派生远程创建有可持久化、可重放的 intent，并使用预分配 run/reviewer ID 在 worker 上幂等恢复。

---

## Phase 5: 历史数据回填与诊断

**User stories**: US4, US5, US6, US7, US9

### What to build

提供可分批、幂等的 registry 补齐和 session 回填作业。本地与 worker session 只匹配 local checkout；hub mapping
只匹配其 `remote_server_id` checkout。远程 branch 在匹配前显式将 `NULL` 规范化为 `''`。作业只填充
NULL，对歧义、缺失和悬空行记录稳定原因码，并提供运维查询查看数量和具体记录。

### Acceptance criteria

- [x] 回填作业支持批大小/游标，中断后可从任意已提交边界重跑。
- [x] 只更新 `workspace_checkout_id IS NULL` 的行，不覆盖新系统已写入的绑定。
- [x] local/worker 回填只选择 `target_id = 'local'` 的唯一候选。
- [x] hub 回填使用 `project_id + COALESCE(branch, '') + remote_server_id` 匹配唯一活跃或可证明的历史 checkout。
- [x] 所有 main remote mapping 都通过 `NULL → ''` 规范化参与匹配。
- [x] 无法判断同名 branch 属于哪个 incarnation 时保持 NULL，不绑定到当前 checkout。
- [x] 诊断结果至少区分：project 缺失、workspace 缺失、checkout 缺失、main 未注册、target 缺失、
  多 incarnation 歧义、外键悬空、快照不一致。
- [x] dry-run 与实际运行输出相同分类口径的计数，实际运行额外输出更新数。
- [x] 在包含 local main、local branch、remote main、多 remote、墓碑和重建 incarnation 的旧库样本上连续运行两次，
  第二次结果为零更新且分类不变。

---

## Phase 6: 读取投影切换与 fallback 清零

**User stories**: US1, US2, US3, US4, US6, US8, US9

### What to build

将用户可见与后台消费者统一切换为 checkout-first 读取：session 列表、恢复、发送消息、通知、搜索、
project activity、project chat 和 workflow 都通过 checkout/workspace join 获得 workspace、target、branch 和物理路径。
未回填行暂时使用旧快照 fallback，但每个消费者都上报使用量。墓碑绑定显示历史信息而禁止新执行。

### Acceptance criteria

- [x] 已绑定 session 的 project、branch、target 和路径来自 checkout/workspace join，不来自当前 Git branch。
- [x] 本地恢复、唤醒、restart、模式切换和 snapshot 对已绑定行不调用 branch-to-path 推导。
- [x] remote routing 仍由 mapping 的 remote session ID 完成，workspace/target 归属来自其 checkout 绑定。
- [x] 搜索、通知、project activity、project chat 和 workflow reviewer 对同一 session 投影出一致的 workspace/target。
- [x] 墓碑 checkout 的历史 session 显示原 branch、target 和路径快照，不被新 incarnation 的信息替换。
- [x] 尝试继续墓碑或非 ready checkout 上的 session 时，本地和远程入口返回等价错误。
- [x] 每一类读取消费者都有 checkout-hit、legacy-fallback、dangling 和 mismatch 指标。
- [x] 未回填旧行在兼容期仍可用，但不会被当作已绑定行。
- [x] 启动与 remote 重新上线时自动补 registry 并回填，终端用户无需执行任何数据操作。
- [ ] 自有部署样本窗口中 legacy fallback 降到只剩明确隔离行（孤儿/歧义），dangling 为 0。

---

## Phase 7: 外键收紧与发布收尾

**User stories**: US1, US2, US4, US7, US8, US9

### What to build

在新写入绑定率和读取 fallback 指标达标后，重建 session/mapping 表并加入正式 checkout 外键与最终索引。
验证 worktree 墓碑、project 显式清理、旧 worker fallback 和发布/备份流程。本阶段不默认删除兼容快照字段，
也不自动将新列改为 `NOT NULL`；两者需要基于隔离数据和 worker 升级情况单独决策。

### Acceptance criteria

- [ ] 收紧前预检查能报告并拒绝存在悬空 checkout ID 的数据库。
- [ ] 表重建保留所有 session/mapping 字段、行数、ID、时间戳和 NULL 隔离行。
- [ ] `workspace_checkout_id` 外键在运行时真正启用，不能写入不存在的 checkout ID。
- [ ] 建立 session 按 checkout+更新时间查询和 mapping 按 checkout 查询的最终索引，兼容期旧索引保留。
- [ ] 普通 worktree 删除仅写墓碑，不触发外键错误，历史 session 仍可查询。
- [ ] project 全量删除通过明确的依赖删除顺序成功，不依赖偶然的 cascade 执行顺序。
- [ ] 新 hub + 旧 worker 组合在外键收紧后仍可工作，其 fallback 绑定也必须先解析到真实 hub checkout ID。
- [ ] 发布 runbook 包含备份、dry-run、迁移、验证、指标观察和停止条件。
- [ ] 发布文档明确 Phase 1 后数据库不可回滚到不理解 incarnation schema 的旧版本。
- [ ] 何时停止旧 worker 兼容和何时清理快照字段被记录为独立后续决策。
- [ ] 过渡期代码在旧库退场后一并清理，且清理范围被明确区分：
  - 删除 `healWorkspaceBindings` / `runWorkspaceBindingBackfill` 及其启动与 remote-online 调用点。
  - 删除 `workspaceBindingMigration.backfill`；`diagnose` 是否保留单独决定。
  - 删除 `workspace-binding-metrics.ts` 与仓库层的 `recordWorkspaceBindingRead` 调用——它比回填更贵，
    每次投影查询都额外跑一条 dangling 计数。
  - 保留 `registerReportedWorktrees` 和 registry 同步函数：它们是常态功能（外部创建的 worktree 对账、
    worker 权威路径不被推导路径降级），与迁移无关。
  - 前提是自有部署的 `unbound*` 只剩已接受的隔离行；因为稳态下自愈已是空转（两条索引查询即返回），
    清理没有时间压力，不得为赶进度提前删除仍在服役的兼容路径。
- [x] `workspace_checkout_id` 保持永久 nullable：自托管用户的库无法保证可全绑，legacy 快照 fallback 是长期
  支持的行为而非临时代码，因此不追求 `NOT NULL`。

---

## Release order and gates

1. **Registry schema release**：先发布 Phase 1，确认墓碑和重建稳定。该版本是数据库格式前进门。
2. **Local dual-write release**：发布 Phase 2，保留 legacy read fallback，观察新本地 session 绑定率。
3. **Worker compatibility release**：先扩散 Phase 3 worker；无需等待全部 worker 升级。
4. **Hub remote dual-write release**：发布 Phase 4，新旧 worker 并存，观察 intent 恢复和路径 fallback。
5. **Backfill window**：运行 Phase 5 dry-run，先修复 registry 缺口，再分批回填；歧义行进入隔离列表。
6. **Checkout-first read release**：发布 Phase 6，按消费者观察 fallback，不在同一发布中紧接着加外键。
7. **Constraint gate**：只有当新写入绑定率为 100%、fallback 归零、剩余 NULL 行全部被明确隔离后，
   才执行 Phase 7。

## Final verification matrix

| Scenario | Local DB | Hub DB | Worker DB | Expected result |
| --- | --- | --- | --- | --- |
| 本地 main session | local checkout | — | — | 绑定 `branch=''` root checkout |
| 本地 branch drift | 原 checkout | — | — | 恢复/后续 turn 仍使用原路径 |
| 本地删除后重建 | 旧墓碑 + 新 checkout | — | — | 新旧 session 指向不同 ID |
| 远程 main session | — | remote checkout + mapping | worker local checkout + session | hub/worker 分别正确绑定 |
| 同 branch 多 remote | — | 每个 target 独立 checkout | 每个 worker 本地 checkout | mapping 不串 target |
| 新 hub + 旧 worker | — | 真实 checkout ID + 兼容路径 | legacy/nullable 视阶段而定 | 不中断 session，fallback 可观测 |
| worker 成功、hub DB 失败 | — | pending intent | 唯一 session | 重试后 confirmed，不重复创建 |
| 历史歧义 incarnation | nullable session | nullable mapping | nullable session | 报告并隔离，不静默误绑 |
