# 客户端状态存储与迁移经验

> 状态：经验总结，2026-08-05。素材来自 Session → Workspace Checkout 迁移
> （设计 [`session-workspace-checkout-migration.md`](./session-workspace-checkout-migration.md)、
> 阶段拆分 [`../plans/session-workspace-checkout-migration.md`](../plans/session-workspace-checkout-migration.md)、
> 运维步骤 [`session-workspace-checkout-runbook.md`](./session-workspace-checkout-runbook.md)）。
>
> 本文回答两个反复出现的问题：**下次做数据迁移要注意什么**，以及
> **在 server/worker 这种"一端连续部署、另一端由用户随机升级"的结构下，状态该放在哪、用什么存**。
>
> **本文是经验素材。** 从中抽象出的通用决策模型（退路矩阵、代号机制、三道门）见
> [`storage-tiering-decision-model.md`](./storage-tiering-decision-model.md)；
> 要判断一份新数据放哪里，先看那篇。

## 0. 为什么值得单独成文

那次迁移的功能面只有两个可空列：

```
agent_sessions.workspace_checkout_id
remote_session_mappings.workspace_checkout_id
```

单机、可停机、客户端同版本的话，这是一个下午的 migration script。实际做成 7 个阶段，
全部成本来自三个约束——**不能停机、worker 版本任意老、历史数据无法自证归属**。
这三条在这个产品里是长期成立的，所以经验可复用。

## 1. 骨架：expand → migrate → contract

在线迁移只有这一条路径，跳过任何一步都会让某个版本组合读到不认识的数据：

| 步骤 | 做什么 | 对应阶段 |
|---|---|---|
| **expand** | 加可空列，新旧路径同时写。旧代码完全不受影响 | Phase 2 / 3 / 4 |
| **migrate** | 回填历史行。只填 NULL，不覆盖新写入，因此幂等 | Phase 5 |
| **contract** | 收紧约束（外键、索引）。必须先证明没有悬空引用 | Phase 7 |

七个阶段本质就是这三步，只是"expand"被三个执行面（本地 / worker / hub）撑开，
读路径切换与观测（Phase 6）单独拎出来做了发布门禁。

顺序依赖是真实的，不是流程包装：

```
Phase 1 身份模型（墓碑 + incarnation）   ← 没有稳定 ID，后面绑什么都不稳
   ↓
Phase 2/3/4 双写（三个执行面各有入口和失败模式）
   ↓
Phase 5 回填（只填 NULL ⇒ 必须在双写之后）
   ↓
Phase 6 读切换 + 指标
   ↓
Phase 7 加外键（必须先证明 dangling = 0）
```

## 2. 七条实践启示

每条都注明来源，避免退化成空泛箴言。

**① 身份模型必须单独一步先落地。**
Phase 1 只做"checkout 有墓碑、有代次"，一行 session 都没绑，当时看着像空转。
但如果和双写混在一起，绑上去的 ID 语义还在变，后面全得返工。

**② 开工前就决定"哪些数据永远迁不了"，并把它做成受支持的状态。**
worktree 已删除的 session 无法自证归属——旧表里只有 `(project, branch)` 约定，
没有任何信息能证明它属于哪一次 incarnation。承认这点之后，
`workspace_checkout_id` 的 fallback 从"待清理的临时代码"变成"永久行为"，
`NOT NULL` 从目标变成明确的非目标。这个决定让残留行从"待办"变成"正常"。

**③ 软件跑在你不运维的机器上时，自愈 > runbook。**
最初方案是提供一个 operator-gated 的 admin 回填端点。这对自有部署可用，
对终端用户不成立——不能要求用户跑 SQL 或调管理接口。
最终改成启动 + worker 重连时自动回填，用户升级后无需任何操作。

**④ 迁移触发点要挂在"前置条件产生的那一刻"，而不是只挂启动。**
实测日志：hub 启动时回填 **0 行**（那一刻没有 worker 在线，registry 里没有远程 checkout），
三个 worker 依次重连后回填 **1613 / 2 / 1 行**。只挂启动的方案会永远绑不上。

**⑤ 在真实数据副本上演练迁移。**
表重建的索引清单最初是硬编码的，漏掉了后续迁移新增的 `idx_agent_sessions_project_updated_id`。
单元测试没抓到（测试库里那张表没有这个索引），真实库副本演练抓到了。
修法是从 `sqlite_master` 捕获索引 DDL 后重放，而不是维护清单。

**⑥ 往热路径插入新前置条件时，先枚举"以前靠什么满足旧的宽松条件"。**
`createNewSession` 新增了"必须有已注册 checkout"，导致**非 git 目录的项目新建 session 直接 500**。
旧路径能工作是因为 `resolveWorktreePath` 内部有 catch 兜底，新路径 `getRegisteredWorktreeBranches`
没有。这是整个迁移中唯一有用户可见影响的回归。

**⑦ 兼容代码的质量取决于是否收敛，不取决于它有多少。**
详见 §4.3。

两条 SQLite 具体教训：

- **`ALTER TABLE ... RENAME` 会改写其他表的 `REFERENCES` 子句。**
  把 `agent_sessions` 改名挪走，会静默地把 `agent_session_entries` / `turn_snapshots` /
  `agent_instruction_deliveries` 三张子表指向临时表。必须"先建新表 → 拷贝 → 删旧表 → 改名回去"。
- **父表删除若沿两条路径级联，需要 `DEFERRABLE INITIALLY DEFERRED` 或显式排序。**
  删 project 同时级联到 sessions 和 workspaces → checkouts；即时检查的结果取决于
  SQLite 恰好先跑哪条，延迟到 COMMIT 后只取决于事务终态。

## 3. server / worker 结构下，状态该放哪

### 3.1 迁移成本的真正来源是"谁控制部署"

| | 部署节奏 | 迁移成本 |
|---|---|---|
| hub | 你连续部署 | 低。可以做 eager 全量转换，之后代码只处理最新状态 |
| worker | 用户随机时间升级 | 高。**同时需要迁移和永久兼容层** |

所以设计原则是：**把有约束的关系型状态，放在你能控制部署节奏的那一侧。**

### 3.2 worker 无状态化能省掉多少

假设 worker 不持有自己的 `agent_sessions`：

| 阶段 | 会怎样 |
|---|---|
| Phase 3 worker 绑定 | **消失**（无状态可绑） |
| Phase 5 回填 | **减半**（不用在每台 worker 上跑） |
| Phase 7 收紧 | **减半**（一个库） |
| Phase 3 的 `worktreePath` 上报 | **不会消失**——那是协议变更，不是存储变更 |
| Phase 4 跨机器 saga | **不会消失**——分布式创建的不确定性与存储无关 |

结论：能省掉约三分之一，省不掉跨版本协议兼容和分布式事务。

**但"改用数据目录"不等于无状态。** 一个目录也是数据库，只是查询能力差；
它同样有格式版本、同样需要迁移，只是迁移方式从 `ALTER TABLE` 变成"读端容忍未知字段"。
真正有效的是下一节的分层，而不是换存储介质。

### 3.3 本仓库的现状对照

worker 侧一个明显的错配：`agent_session_entries` 实测 **282,113 行**，
纯追加、从不跨记录查询、只整段读回——**这本来就该是文件**。
它是 worker 库里最大的一块，也是最不需要关系型能力的一块。

按判据量一遍：

| 数据 | 现状 | 更合适的位置 |
|---|---|---|
| `agent_session_entries`（会话记录） | worker DB | 文件（丢了心疼，但纯追加） |
| session 元数据（状态/模型/权限） | worker DB | hub，或可重建的派生 DB |
| workspace registry | worker DB | 可重建（是 git 状态的投影）⇒ 可换代 |
| executor_processes / 日志 | worker DB | 可换代 |

vibedeckx 的 worker 之所以有完整数据库，是因为**一个二进制两个角色**：
solo 模式下 worker 自己就是 hub。这是合理的设计选择，但那次迁移多出来的三分之一工作量
就是它的代价，值得明确记账。

**不建议现在改**（代价大于收益，且 solo 模式依赖它）。
但下次要在 worker 上新增持久化数据时，先过一遍 §6 的判据。

## 4. 文件 vs 数据库

### 4.1 常见论断与它的前提

> 文件灵活但要在代码里兼容旧格式，代码质量随时间下降；
> 数据库可以迁移到最新状态，代码只处理最新状态。

机制是对的：**数据库迁移是一次性、eager、全量的转换；文件容忍是惰性、逐次读、永久的转换。**
前者把复杂度压缩到只跑一次的地方，后者摊到每个读点并且永远摊着。

但"代码只处理最新状态"的前提是**你能保证所有实例都迁移过了**。worker 不满足，
所以那一侧会同时付两份成本。那次迁移就是活例子：有数据库、做了完整迁移，
最后仍然得承认 `workspace_checkout_id IS NULL` 是永久支持状态。

### 4.2 数据库同样积压兼容债

```
schema.ts:29  // Inert columns kept to describe the on-disk shape of existing DBs.
              // No code reads or writes them: remote_url/remote_api_key are
              // leftovers from the removed direct-URL transport...
```

本仓库有两处这样的注释。这些列删不掉——删了要重建表、老库读不了。
这和"代码里留着旧格式分支"是同一种债，只是从 `.ts` 挪进了 `.sql`。

成本可量化：`sqlite.ts` 共 1976 行，其中约 **134 行是迁移逻辑（7%）**，
且只增不减——你不知道用户从哪个版本升上来。

另一个反方向的代价：**迁移不可回滚，文件容忍优雅降级。**
容忍代码写错，一条记录读出来是错的，能修能回滚；迁移写错，整张表毁了，版本回退也救不回来。
runbook §0 整节讲的就是这件事。

### 4.3 决定代码质量的是收敛，不是介质

实测：**14 个非测试文件**引用 `workspace_checkout_id`，其中 6 个直接判 null。
有数据库也没能避免弥散。

Phase 6 做的事情本质上就是**把弥散收敛**——原来 8 类消费者各自处理 null，
改成全部走 `getActivityById` / `projectedRemoteMappingBase` / `projectedSessionByBranchBase`
这几个投影函数。剩下的 null 判断基本都是"能不能启动新 turn"的业务门禁，不是格式兼容。

> **杠杆在于：旧格式处理是收在一个边界后面，还是散在每个读点上。**
> 这个变量与文件/数据库的选择基本正交。
> 一个 `parseEntry()` 里包含五代格式分支是好代码；五代分支散在二十个调用点是烂代码。

### 4.4 三种策略

二分法漏了第三条路：

| 策略 | 做法 | 适用条件 |
|---|---|---|
| **migrate** | 把旧数据改成新形状 | 你控制部署；接受不可回滚 |
| **tolerate** | 读的时候认旧形状 | 永久成本，但优雅降级；必须收敛到单一边界 |
| **discard** | 换个文件名/代号，旧的不要了 | 仅限可重建的派生数据 |

## 5. 同类产品实测

> 实测于 2026-08-05，本机 `~/.claude` 与 `~/.codex` 的真实数据。
> 两者都在快速演进，结论会随版本漂移，重点看**策略分层**而非具体文件名。

### 5.1 Claude Code：核心全是文件

```
~/.claude   2082 × .jsonl    1225 × .json    706 × .md
```

会话记录是 JSONL，配置是 JSON，记忆/指令是 Markdown。没有核心数据库。

`projects/*/.claude-conversations-memory.db` **判断为第三方插件所有**（推断，非确证）：
只出现在 120 个 project 目录中的 10 个、时间戳停留在八个月前、
schema 含 `message_embeddings` / `decision_embeddings` / FTS5 / `query_cache`
——核心 CLI 不需要这些。

### 5.2 Codex：混合，且策略分层清晰

真相层是文件：

```
~/.codex/sessions/2026/04/20/rollout-<ts>-<uuid>.jsonl     实测 1393 个
```

同时**确实带客户端 SQLite**，四个：

```
state_5.sqlite     131 MB   threads, thread_dynamic_tools, backfill_state, thread_spawn_edges, ...
logs_2.sqlite      576 MB   logs
goals_1.sqlite      32 KB   thread_goals, ...
memories_1.sqlite   40 KB   stage1_outputs, jobs
```

最值得借鉴的是**两套迁移策略并用**：

1. 每个库内都有 `_sqlx_migrations` 表 ⇒ 兼容改动走版本化迁移（migrate）
2. **文件名带代号**：`state_5` / `logs_2` / `goals_1` / `memories_1`，数字各不相同，
   且**没有任何低代号残留文件** ⇒ 迁移写不动就换代、丢弃旧文件（discard）

`state` 已经是第 5 代。敢这么做的前提是：**这些库装的是可重建的派生数据
（日志、线程缓存状态），不是用户的源真相。** 源真相在 JSONL rollouts 里，
那部分不换代、不迁移，靠格式容忍（tolerate）。

（附带一提，`state_5.sqlite` 里有一张表就叫 `backfill_state`——同样的问题。）

### 5.3 对照总结

| | 用户源真相 | 派生 / 缓存 / 日志 | 迁移策略 |
|---|---|---|---|
| Claude Code | JSONL / MD 文件 | 文件 | tolerate |
| Codex | JSONL rollouts | SQLite ×4 | 真相 tolerate；派生 migrate + discard |
| vibedeckx worker | **SQLite**（entries 282k 行） | SQLite（同一个库） | 全部 migrate |

差异一目了然：另外两家都把**用户的源真相放在文件里、且不迁移**，
把数据库限定在"丢了能重建"的范围内——于是数据库可以随便换代。
vibedeckx 把两者放进了同一个库，所以每次 schema 变更都要在用户机器上做不可回滚的迁移。

## 6. 判据速查

新增持久化数据时，依次问四个问题。**Q1 和 Q2 必须联合看**——单独任何一个都推不出结论。

**Q1：这份数据丢了，用户会不会心疼？**（可重建 / 不可重建）
- 不会（派生 / 缓存 / 日志 / 索引）→ 数据库，且**明确允许"迁移太难就换代丢弃"**
- 会（用户的源真相）→ 还要看 Q2

**Q2：谁控制这台机器的部署节奏？**
- 你（hub）→ 可以做 eager 迁移，代码维持只处理最新状态
- 用户（worker / solo）→ 假设永远有旧版本在跑，**把兼容层设计成永久的**，别当成待清理项

**Q1 × Q2 决定「加法改不动的变更来临时，你还剩几张牌」：**

|  | 你控制部署（hub） | 用户控制部署（worker / solo） |
|---|---|---|
| **可重建** | `migrate` ✓ | **`discard` ✓**（换代，见下） |
| **不可重建（源真相）** | `migrate` ✓ | **两张牌都没有** ⚠ → **文件** |

只有右下那一格被困：迁移要在你不运维的机器上做不可回滚的重建表，丢弃则直接丢用户数据。
文件是第三条路，有效的原因是**它没有 schema，所以既不需要迁移也不需要换代**。

⚠️ **别把 Q1 单独当判据。** 源真相在 hub 侧照样该留库——`project_chat_messages`
（Main Chat 记录）与 `agent_session_entries` schema 几乎同构，但它跑在 hub、你连续部署、
且被 `project_chat_work_items` 直接引用，结论是留库随 Postgres 走。
完整推导见 [`storage-tiering-decision-model.md`](./storage-tiering-decision-model.md)。

**Q3：旧格式的处理会散在几个地方？**
- 一个解析/投影函数 → 可接受，数量再多也是好代码
- 多个读点 → 先收敛再继续，否则质量债按读点数量增长

**Q4：旧格式的处理有没有终点？**
- 信息完整（旧数据自身可读出、可转换）→ **有终点**。写搬迁，收敛后删兼容分支。
- 信息不完整（无法自证，如 worktree 已删的归属）→ **没有终点**。
  按 §2 ② 处理：承认它是永久支持状态，不要当待办。

对照：`workspace_checkout_id IS NULL` 属于后者（旧表只有 `(project, branch)` 约定，
无法证明属于哪一次 incarnation）；`agent_session_entries` 属于前者（行就在那儿，
读出来就能写文件）。**能否收敛取决于信息是否完整，不取决于它是不是"老数据"。**

对应到策略表：

| 数据 | 谁控制部署 | 策略 |
|---|---|---|
| hub 的关系型状态 | 你 | migrate |
| worker 的关系型状态 | 用户 | migrate + **必然还要** tolerate |
| 用户的源真相（会话记录，worker 侧） | 用户 | **文件**：append-only + tolerate，收在单一解析边界 |
| 用户的源真相（hub 侧） | 你 | migrate（留库） |
| 派生 / 缓存 / 日志 | — | discard（换代），别写迁移 |

### 6.1 四条可执行规则

判据之外，下面四条是能在 review 里直接引用的：

1. **新增持久化数据默认走独立文件 + 代号。** 命名 `<name>_1.sqlite`，打开逻辑统一写成
   「文件不存在 → 建空文件 → 从 migration 1 跑起」，并在文件顶部注明**本库允许被丢弃**。
   反过来，**无代号的文件名（如 `data.sqlite`）就是"永不丢弃"的声明**——命名即声明，
   别给不可丢弃的库加代号，也别给可丢弃的库省掉代号。

2. **review 检查点：任何需要「建新表 → 拷贝 → 删旧表 → 改名」的变更，先问"这个库能不能换代"。**
   能，就换代，不写重建逻辑。§2 那两条 SQLite 陷阱（`RENAME` 静默改写 `REFERENCES`、
   索引清单要从 `sqlite_master` 重放）**都只在重建表时才踩得到**——Codex 一次没踩过，
   不是更小心，是每次要重建表时都换代了。

3. **增长率是"重新问一遍"的触发器，不是结论。**

   > 任何**跟着每条消息 / 每次输出 / 每次事件增长**的表，在建它之前必须停下来
   > 重跑一遍 Q1 + Q2 再决定去处。增长率只说明"这张表值得单独想"，**不说明答案**。

   `agent_session_entries` 当年就是按"一张普通表"加进来的，五个列至今没变过，
   单看 schema 完全无害——它今天占 `data.sqlite` 的 99%（2026-08-06 实测
   405 MiB / 284,498 行，其余全部约 3.5 MiB / 5,800 行），问题全部来自增长率。
   这条规则的唯一目的是不再造出第二张。

   **前瞻**：executor / PTY 输出目前不在库里（`executor_processes` 只存
   `pid / status / exit_code`，无日志内容）。若将来要持久化它，它是最可能成为
   "下一个 entries"的东西——必须一开始就是文件或代号库，不能进 `data.sqlite`。

4. **entries 接口纪律（钉住存储形态的切换成本）。**
   新代码访问会话记录只准走 `storage.agentSessions` 的
   `getEntries` / `upsertEntry` / `deleteEntries` 接口；
   **禁止新增直接引用 `agent_session_entries` 表名的 SQL**（含把 FTS5 索引写成
   `content=agent_session_entries` 的 external-content 绑定——索引输入应是抽取文本的
   派生投影，不绑介质）。理由：截至 2026-08-08，全部消费调用点都在接口后面
   （`agent-session-manager.ts` 9 处）+ 仅一处历史遗留的直接 SQL（search-cache 的
   `EXISTS`）。守住这条，entries 将来是留库还是出文件就只是 repository 层的实现细节，
   「先想清楚再做」不产生隐性利息。

本仓库把上述判据落到 `agent_session_entries` 的具体路线，见
[`plans/2026-08-06-session-entries-to-files.md`](./plans/2026-08-06-session-entries-to-files.md)。
