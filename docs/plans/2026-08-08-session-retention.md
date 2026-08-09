# Plan: Session Retention —— 过期会话自动删除

> 状态：设计完成，**未实施**。2026-08-08。
>
> 决策背景见 [`2026-08-06-session-entries-to-files.md`](./2026-08-06-session-entries-to-files.md) §9
> （retention 与 VACUUM 为什么是独立事项）。本方案**不依赖** entries 出库（第 3 步），
> 在当前的 DB 形态下即可完整生效；将来 entries 真出了文件，删除动作从「CASCADE 删行」
> 变成「rm 目录」，本方案的判据与调度原样保留。
>
> 产品决定（2026-08-08，用户拍板）：历史 session 除加星收藏外**没有必要永久保留**，
> 超过一定天数的删掉。
>
> **Review 修订（2026-08-08）**：初版经审查发现 4 个正确性缺口，均已核实并修订——
> ① active workflow 参与者豁免（§1.2）；② SELECT→DELETE 的 TOCTOU 竞态（§1.5）；
> ③ 现有 `deleteSession` 两段式删除不原子，列为前置任务（§1.6）；
> ④ 远端 worker 删除后 hub 侧 mapping 的收敛契约（§3 Phase 2）。
>
> **二审修订（2026-08-08，第二轮 review）**：4 处均核实成立并已修订，其中第 1 处
> 推翻了初审修订里的一个错误断言——
> ① wake 竞态：`sendUserMessage`/`wakeDormantSession` **不走** `eventChain` 串行队列
> （初审版 §1.5 声称由它封闭窗口，勘误），改用 `wakeInProgress` 标志 + retention 专用
> 无 stop 删除路径（§1.4/§1.5）；② sweep 每批重读配置（§1.3）；③ 轮内 keyset 游标
> 防饥饿（§1.3）；④ 对账先捕获 mapping 集合再拉清单、worker 端点契约、
> 禁用 search catalog 当存活清单（§3.1）。

## 0. 一句话

worker 每 6 小时扫一次自己库里的 session：**最后活跃超过 N 天、未加星、不在运行中**
的整个删掉（CASCADE 带走全部子表行），谓词驱动、有界批、幂等，无需 watermark。

## 1. 关键决定与理由

### 1.1 删除单位：整个 session，不做墓碑

早期讨论过「只清正文、留头行」的墓碑方案（头行仅 ~0.4 MiB，侧边栏/搜索仍可见）。
**否掉**：既然产品判断是「不需要永久保留」，90 天前一个没加星的 session 连标题都
不再有价值，留头行只会让列表无限变长。整行删除的工程红利：

- `ON DELETE CASCADE` 自动带走 `agent_session_entries` / `turn_snapshots` /
  `agent_session_native_ids` / `agent_instruction_deliveries`——全部复用现有路径，
  不引入任何新状态、新列、新 UI 语义。
- 与手动删除行为完全一致，用户已理解这个操作。

### 1.2 判据：一条 SQL 说完

```sql
activity_at < :now - :days * 86400000   -- 按最后活跃算，不是创建时间
AND favorited_at IS NULL                -- 加星豁免（产品要求）
AND status != 'running'                 -- 正在跑的不碰
AND NOT EXISTS (                        -- active workflow 参与者豁免（review 发现①）
  SELECT 1 FROM workflow_runs wr
  WHERE wr.status IN ('waiting_reviewer', 'waiting_feedback', 'discussing', 'sending_feedback')
    AND (wr.source_session_id = agent_sessions.id
         OR wr.reviewer_session_id = agent_sessions.id)
)
ORDER BY activity_at ASC                -- 最老的先删
LIMIT 20
```

- `activity_at` 是现成的语义最大值列（四个活跃时间源的 max，专为此类查询回填过），
  不用新造。半年前创建但上周还在用的 session 不会被删。
- `status != 'running'` 在 N 天门槛下几乎不可能命中，仍要守——防御性谓词的成本是零。
- 加星是唯一的用户侧豁免。想保留的会话，加星即可，不另设「保留标记」。
- **workflow 豁免为什么必须有**（2026-08-08 核实）：active review workflow 的参与者
  session 完全可能是 `stopped`（等 reviewer / 等反馈 / discussing 期间），而
  `workflow_runs.source_session_id` / `reviewer_session_id` **没有外键**（该表只
  FK 到 projects），CASCADE 不会清理，WorkflowEngine 还在内存里持续追踪并会向这些
  session 投递反馈——删掉会留下悬空参与者，后续投递直接失败。豁免只针对
  active 状态；`completed` / `failed` 的 run 不阻止删除（run 行自身的保留独立处理）。
- 谓词参数校验：`session_retention_days` 只接受**有限范围的正整数**（如 1..3650），
  0 / 负数 / 非数值一律视为关闭——防止配置错误变成一次全库删除。

### 1.3 执行：谓词驱动的有界批，不需要 watermark

比 entries 计划 §7.4 的搬迁涓流还简单：删除按谓词幂等，每次 tick 重新 SELECT 即是
进度本身，删完自然查不到。**不需要任何状态表。**

```
tick:
  cursor = (-∞, "")                      ← 本轮 sweep 内的 keyset 游标，不持久化
  loop:
    重读 retention 配置（二审②）：已关闭 → 立即结束本轮；天数变了 → 用新 cutoff
    候选 = SELECT ... AND (activity_at, id) > cursor
           ORDER BY activity_at ASC, id ASC LIMIT 20
    没有候选 → 结束     ← 稳态下 99% 的 tick 到这一步就返回，近乎免费
    逐个删除（每个删除前重新验证谓词，见 §1.5）
    cursor = 本批最后一个候选的 (activity_at, id)   ← 删没删成都推进（二审③）
    批间让出事件循环（setImmediate），减小对正在服务的 WS 的干扰
    本 tick 已用时 > 30s → 结束，剩余留给下个 tick
```

两处是二审补上的正确性修正：

- **每批重读配置**：sweep 可能跑几十秒，期间用户把 30 天改成 365 天、或直接关闭
  ——旧 sweep 若继续用启动时捕获的 cutoff，就是在按用户已经撤回的意愿永久删数据。
  批边界重读即可；已同步进入条件 DELETE 的单条删除是线性化边界，无需撤回。
- **keyset 游标防饥饿**：固定「取最老 20 条」时，若这 20 条全被跳过（wake 进行中 /
  重验失败），下一次 SELECT 还是同一批——本轮 sweep 空转到时间预算耗尽，排在后面
  的可删 session 永远轮不到。游标无论删除还是跳过都推进，一轮内每条至多被考虑一次。
  游标只活在单轮 sweep 内（跳过的候选下一轮重新参选），**仍然不需要持久化 watermark**
  ——§1.3 标题里那句承诺不变。

「循环批 + 时间预算」而不是固定单批，是为**首次启用**设计的：一台跑了一年的机器
第一次开 90 天保留，可能一次性上千个过期 session；固定 20 个/tick 要拖十几天，
循环批在一两个 tick 内清完。

**30s 是软预算**（review 修订）：只在批边界检查，单个超大 session 的同步 SQLite
删除本身可能超过预算——预算封的是"批的数量"，不是硬上限。实施时对大 session
（数千 entries）做一次删除耗时压测，若单删可能秒级，考虑对 entries 特别多的
session 先分批 `DELETE ... LIMIT` 正文再删父行。

### 1.4 删除路径：retention 专用的无 stop 删除，不复用 `deleteSession`

老 session 启动时被 restore 进内存 map（dormant 态），只删 DB 会留幽灵，所以删除
必须经过 manager。但**不能复用现有 `deleteSession()`**（二审发现①的一半）：它是
stop-first 的——第一步就 `stopSession()`，与 §1.5 「条件 DELETE 未命中则什么都不做」
存在顺序冲突：一个候选查出后刚被唤醒的 session，会先被 sweep 停掉，即使随后的
条件 DELETE 未命中、行没删，用户也已经被打断了。

retention 走专用路径 `deleteDormantSessionIfExpired(id)`，只允许删除同时满足：

1. 内存态：`process === null` 且 `wakeInProgress === false`（§1.5）——
   retention 只删无进程的 dormant session，**永远不 stop 任何东西**。
   有活进程的 session 一律跳过：常驻池的 LRU 迟早把它休眠成 dormant，下轮再删。
2. 条件 DELETE（附带完整谓词）命中 1 行。

**顺序是先条件 DELETE、命中后才做副作用**：广播 `finished`、清内存 map、
重算 branch activity。DELETE 未命中（期间被救活）→ 什么都不碰。
不在 map 里的兜底仍走同一条件 DELETE。

- `skipDb`（hub 上的 remote 镜像会话）**天然不在候选里**——它们没有本地 DB 行；
  远端会话的清理由 worker 自己的 sweep 负责（见 §3 Phase 2）。

边界情况：用户此刻正打开着一个第 91 天的老会话在看 → 收到 `finished` 广播、
界面提示会话已删除。与手动删除行为一致，不新增状态。

### 1.5 TOCTOU：候选查出后、删除前，session 可能被唤醒或加星

**这是 review 发现的真问题，「谓词幂等」解决不了它**：候选 SELECT 之后，用户可能
加星、发消息把 session 唤醒、或改标题使 `activity_at` 变新；而 `deleteSession()`
不会重验谓词，反而会主动 `stopSession()`——一个刚被唤醒的 session 会被 sweep
停掉并删除。防线三层：

1. **single-flight**：三个触发点（启动 / 定时 / 设置变更）汇入同一个 runner，
   同一时刻至多一个 sweep 在跑；触发时若已有 sweep 在跑则合并（coalesce），不排队。
2. **删除前逐个重验**：对每个候选，在执行破坏动作**之前**重新读取——DB 行
   （`favorited_at` / `activity_at` / workflow 豁免）+ 内存态（RunningSession 的
   `status` / 是否有进程）——任一不再满足即跳过，本轮不删。
3. **最终删除带谓词**：父行 DELETE 附带完整谓词（`WHERE id = ? AND favorited_at
   IS NULL AND activity_at < ? ...`）并检查 affected rows；0 行 = 期间被救活，
   跳过后续清理。

> ⚠️ **二审勘误（2026-08-08）**：初版声称「残余窗口由 per-session 串行工作队列封闭」
> ——**不成立**。核实代码：`eventChain`（`enqueueSessionWork`）只包着 stdout 处理
> 和内部探针（agent-session-manager.ts:911/926/1063），`sendUserMessage` 和
> `wakeDormantSession` **都不走这条队列**。真实竞态在 dormant 唤醒的异步准备段：
>
> ```
> sendUserMessage → 发现 dormant → wake 开始，停在某个前置 await
> → sweep 重验看到 process=null、status=stopped（谓词全过）
> → sweep 删 DB 行、清内存 map
> → wake 恢复，起进程 → 孤儿进程 + 内存/DB 不一致 + 后续写入失败
> ```
>
> **封闭方式（二审建议，采纳）**：`RunningSession` 加 `wakeInProgress` 标志——
> `wakeDormantSession` 在**第一个 `await` 之前同步**置 `true`，`finally` 中复位；
> sweep 重验时见 `wakeInProgress === true` 即跳过。配合 §1.4 的
> `deleteDormantSessionIfExpired`（只删 `process === null && !wakeInProgress`、
> 条件 DELETE 命中后才做副作用），窗口即被封死：flag 的置位是同步的，sweep 与
> wake 之间不存在两者都看不见对方的时刻。
> **不做**统一 lifecycle gate（把 send/rename/favorite/restart 全改造进闸门）——
> rename/favorite 只改 DB 行，条件 DELETE 的谓词已经挡住它们，过度工程。

### 1.6 前置任务：先把 `deleteSession` 改成原子删除

现有 `deleteSession()` 是两段式：先 `deleteEntries(sessionId)`、再 `delete(sessionId)`
（agent-session-manager.ts 的 step 2-3）。第二步失败会留下**头行还在、正文已永久
丢失**的状态——与"删除整个 session"的语义矛盾，而且没有必要：entries 本就有
`ON DELETE CASCADE`，运行时 `foreign_keys = ON`，单条父行 DELETE 即可级联。

**Phase 1 的第一个 commit 应当是**：把 manager 删除路径改成单条父行 DELETE（或把
两步包进同一事务），并配测试。这是对现有手动删除路径的独立修复，retention 不得
复用两段式路径。

## 2. 什么时候跑

三个触发点，全部在 **worker 进程内部**——session 在哪台机器，删除就在哪台机器跑，
hub 不参与：

| 触发点 | 说明 | 主要覆盖 |
|---|---|---|
| 启动后延迟（+1~2 分钟） | 不抢启动路径的 restore/备份/迁移 I/O | 经常重启的笔记本型 worker |
| 每 6h 定时 tick | 与头备份同类的内部定时器：`unref()`、`close()` 清除 | 数周不重启的长驻守护进程 |
| 设置变更时立即一次 | 用户改天数后几秒内可见效果，否则会以为设置没生效 | 首次启用 |

**不用 `scheduled_tasks`**——那是面向用户的 cron 执行器；这是内部维护作业
（与搬迁涓流、头备份同一档，见 entries 计划 §9 的既有结论）。

## 3. 配置与分期

**设置项**：`session_retention_days`，空 = 关闭（**默认关**）。两家 CLI
（Claude Code 8.5 个月 2082 个 jsonl、Codex 1393 个 rollout）都永久保留，
默认开启会吓到人；操作者按需开启（界面预填建议值 90，待定）。

retention 必须跑在 session 所在的机器上，于是配置下发分两期：

| | 内容 | 覆盖 | 量级 |
|---|---|---|---|
| **Phase 1** | 清理引擎（判据 + 循环批 + 三触发点）+ worker 本地 settings 字段 + 设置页 UI | solo / 本地 session | 一天以内 |
| **Phase 2** | 配置下发 capability **+ hub 侧收敛机制**（见 §3.1；均为**加法**，老 worker 404 → UI 显示「需升级 worker」；按隧道契约在 `src/reverse-connect-capabilities.ts` 登记，快照测试会强制） | SaaS 部署下的远端 worker——**主场景** | 一天 |

### 3.1 Phase 2 的收敛契约（review 发现④）

手动删除远端 session 时，hub 会显式清理四样东西：`remoteSessionMap` 路由、
`remote_session_mappings` 行、`remotePatchCache`、搜索缓存
（agent-session-routes.ts:1801-1803 及搜索缓存清理）。worker 内自动 retention
**没有这条通路**——只下发配置的话，hub 会积累指向已删 session 的 mapping：
点开报错的死 handle、旧路由、幽灵搜索结果。

**选型：快照对账（reconcile），不用删除事件/墓碑。** 理由：删除发生在 worker 上，
而 worker 常年可能断线、hub 会重启、事件会重复——逐事件通知要处理丢失/重放/去重
三件事；对账是幂等的、自愈的，天然覆盖「断线期间删除」「hub 重启」「重复通知」
全部场景，不需要额外协议状态：

```
hub 对账一轮：
  1. 先捕获本轮待检查的 mapping 集合          ← 顺序是关键（二审④）
  2. 再向 worker 拉该项目的存活 session-id 清单（新增 capability，加法）
  3. 只对第 1 步捕获的、且不在清单里的 mapping → 清理四件套
     （请求期间新建的 mapping 不参与本轮，下轮再查）
worker 不可达 / 结果不完整 → 本轮跳过，什么都不清（缺勤 ≠ 已删除）
```

1→2 的顺序封掉一个竞态（二审发现④）：若先发请求再捕获集合，请求飞行期间新建的
远端 session 不在 worker 生成快照时的清单里，会被旧快照误判为「已删」而清掉——
一个刚创建的会话立刻变成死 handle。先捕获、只清捕获集，飞行期间的新 mapping
天然免疫，不需要给 mapping 加 generation 或时间戳比对。

**worker 端点的契约**（实现时按此写，不达标不许清理）：

- 返回该项目**全部数据库 session id**，不做侧边栏可见性等任何 UI 过滤；
- 结果必须完整，不可静默截断——若分页，全部页拉完才允许执行清理，
  半途失败 = 本轮作废；
- **不能拿联邦搜索的 catalog 当存活清单**：已核实它用
  `EXISTS agent_session_entries` 过滤（search-cache.ts:591-617），
  一个还没有任何 entry 的新 session 不在 catalog 里，会被误判为已删。
  形状可以参考，数据源必须是专用端点。

清理动作收敛到**一个幂等函数**（持久化 mapping、内存 map、patch cache、搜索缓存
四件套一起），手动删除、对账、兜底三条路径共用——避免三处各清一部分的漂移。

**兜底（belt）**：用户打开一个死 handle、worker 返回 session 不存在时，就地调用
同一个清理函数并提示「会话已被清理」。对账没跑到之前，死 handle 至多存在
一个对账周期，且点开即自愈。

## 4. 三条边界（提前说清，避免被当成 bug 报回来）

1. **磁盘不缩，只封顶。** `DELETE` 的页进 freelist 被后续写入复用，`data.sqlite`
   停在「保留期内数据量的历史峰值」，不再增长——这正是本功能的目标。**不自动
   VACUUM**（锁全库 + 2× 空闲空间，用户机器上不能跑）；**不在界面上显示磁盘数字**
   （一显示，"删了但文件没小"就从实现细节变成"功能坏了"，见 entries 计划 §7.0.1）。
   真要还盘，将来提供显式 `maintenance compact` 命令，独立事项。
2. **不碰 CLI 自己的 transcript。** `~/.claude/projects/`、`~/.codex/sessions/`
   是 CLI 的地盘。删掉我们的 session 行后它们成为孤儿但仍在磁盘上——这是好事：
   删除后还剩最后一层兜底（尽管 `native_session_id` 关联已随行删除）。
3. **通知死链容忍。** 指向已删 session 的旧通知深链点开后提示「会话已清理」。
   通知的时效远短于保留期，v1 不做级联清理。

## 5. 测试面

- 豁免谓词：加星 / running / 未到期各自不被删；到期未加星的被删。
- **workflow 豁免**：source 与 reviewer 两种身份、四个 active 状态各自挡住删除；
  run 到 `completed` 后同一 session 恢复可删。
- **TOCTOU 竞态**：主动制造「候选 SELECT 后、删除前」加星 / 唤醒的时序，断言跳过；
  条件删除 affected rows = 0 时不执行后续清理。
- **wake 竞态**（二审①）：dormant wake 停在前置 await 时 sweep 到达，断言
  `wakeInProgress` 挡住删除、wake 正常完成、无孤儿进程；有活进程的 session 永不被
  retention 停掉（sweep 全程零 `stopSession` 调用）。
- **并发触发**：设置变更与定时 tick 同时到达，断言 single-flight（同一批候选只被
  处理一次）。
- **sweep 中途改配置**（二审②）：批处理进行中关闭 retention → 后续批次零删除；
  改天数 → 下一批用新 cutoff。
- **防饥饿**（二审③）：前 20 个候选全被跳过时，游标推进、后面的候选仍在本轮被处理；
  同一候选一轮内至多被考虑一次。
- 最老优先 + 批次封顶 + 软时间预算提前退出。
- 内存一致性：map 里的 dormant session 被删后不留幽灵、订阅者收到 `finished`。
- 幂等：连续两次 tick，第二次零动作。
- **删除中途失败**：父行 DELETE 失败不留「头行在、正文没了」的半截状态（依赖 §1.6
  的原子化前置）。
- CASCADE 完整性：entries / turn_snapshots / native_ids / deliveries 全部随行消失
  （复用 FK 守卫测试的断言风格）。
- 配置校验：0 / 负数 / 非数值 / 超上限一律等同关闭，零删除。
- hub 无害：没有本地 session 的机器上 tick 是一次空 SELECT（对齐 entries 计划
  §0.1.0 的「自然空操作」约束——不出现 `if (isHub)`）。
- Phase 2：对账清掉 worker 已删的 mapping；worker 断线时不清；死 handle 点开即自愈；
  **对账飞行期间新建的 mapping 存活**（先捕获集合、只清捕获集，二审④）；
  清单分页半途失败 → 本轮零清理。

## 6. 与 entries 出库计划的关系

- 本方案让「控制体积增长」彻底退出第 3 步的动机列表（那边 §7.0 本就写明
  「单纯控体积不构成触发条件」——本方案就是那条里说的「成本低两个数量级」的路）。
- 第 3 步将来若做，本方案的删除动作从 CASCADE 变成 `rm -rf sessions/<id>/`
  （立即还盘），判据、调度、豁免全部原样保留。
- 「真正意义上的删除」（隐私：`DELETE` 后数据仍在 freelist 页里可被 `strings`
  捞出）**不是**本方案的承诺——那仍是第 3 步的最强触发条件，别混淆。

## 7. 待定项与实施注记

- 建议默认天数（界面预填值，倾向 90）——待拍板。
- Phase 2 里 per-worker 还是全局统一天数（倾向全局一个值，per-worker 是过度设计）。
- 候选扫描的索引：现有索引以 `project_id` / `updated_at` 开头，没有正好覆盖
  `activity_at ASC + favorited_at IS NULL` 的组合。千行量级全扫无所谓，实施时用
  `EXPLAIN QUERY PLAN` 验证一次；确有必要再加
  `CREATE INDEX ... ON agent_sessions(activity_at) WHERE favorited_at IS NULL`
  之类的部分索引——先测再加，别预防性建索引。
- workflow 豁免的四个 active 状态抽成共享常量，retention 与 WorkflowEngine 引同一份，
  防定义漂移（二审非阻断建议；「排除所有非终态」的写法留给将来真加了新状态再说）。
- 启用前预估删除数量 / 二次确认属产品增强，非 v1 正确性要求，不做。
- **明确不引入**（两轮 review 一致）：通用任务取消框架、全局删除状态机、持久化扫描
  进度、mapping generation——四个正确性问题都有局部解，别扩大成基础设施。
