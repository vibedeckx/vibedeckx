# Plan: 会话记录出库 —— entries → 文件 + worker 存储分层

> 状态：设计完成，**未实施**。2026-08-06。
>
> 判据与背景见 [`../state-storage-and-migration.md`](../state-storage-and-migration.md)（下称「存储经验文」），
> 本文不重复其中的论证，只给路线、落地方式和判据。
>
> 一句话：把 worker 库里挤在一起的三层数据分开——**源真相进文件、关系型头留库、派生态进可换代的独立库**。

## 0. 目标与非目标

**目标**

- 让 `agent_session_entries`（实测 282,113 行）离开主库，成为 append-only 文件。
- 让新增的派生数据有一个「可以丢弃」的去处，从而在需要重建表时能换代而不是写重建迁移。
- 收敛旧格式处理面：读路径的新旧兼容收在**一个投影函数**后面（存储经验文 §4.3）。

**非目标**

- **不删除主库。** `data.sqlite` 继续承载 `agent_sessions`、projects、notifications、executors、
  workspace checkouts 等关系型状态——那些本来就该是库。
- **不给主库换代。** 它含有不可重建的用户意图（`favorited_at`、手改的 `title`），换代 = 数据事故。
- **不做 retention。** 自动删除历史会话是独立的产品决策，见 §9。
- **不做批量停机迁移。** 搬迁是有界、可续、随时可停的涓流，见 §7.4。

## 0.1 适用范围

**本计划适用于「跑 agent session 的进程」，不是「worker 这个角色」。**

| 部署形态 | 有 entries 吗 | 本计划 |
|---|---|---|
| worker | 是（实测 405 MiB） | ✅ 全部适用 |
| solo（一个二进制两个角色） | 是 | ✅ 全部适用 |
| hosted hub（`--auth` 前置服务器） | ≈ 0 行 | ❌ 无事可做 |

依据：entries 的写入只有两个调用点，都在 `agent-session-manager.ts`
（`persistEntry:1699`、branch 拷贝 `:3021`）——即真正 spawn CLI 进程的那一侧。
`routes/agent-session-routes.ts:1052` 的注释确认「a hosted front runs no local agent sessions」，
同段还记录了实测：hub 做 intent-brief 蒸馏时需要**通过隧道从 worker 拉**历史，
"6.3MB of entries carry 91KB of conversation"。**会话字节在 worker，不在 hub。**

### 0.1.1 与 hub Postgres 移植的关系

两条线互补，不竞争。三层里只有一层会进 Postgres：

| 层 | 进 hub Postgres？ | 说明 |
|---|---|---|
| 源真相（entries 文件） | **否** | 本地文件假设有持久本地盘；hosted hub 存储易失、可能多实例。hub 侧的等价物是**对象存储**，不是 Postgres 的大字段。今天 hub 没有 entries，此条为将来「服务端历史留存」预留结论。 |
| 关系型头 | **是** | hub 库现在装的就是这一层——几千行、全关系型、无大 blob，正是 Postgres 的理想输入 |
| 派生态（代号库） | **否** | 换代是「SQLite + 用户控制部署」的组合答案。Postgres 有真正的在线 DDL（`ADD COLUMN` 带默认值 O(1)，多数变更不重建表），"需要重建表" 这个触发条件本身消失；且存储经验文 §3.1 早已判定 hub 可做 eager 全量转换。**hub 走版本化迁移即可，不要引入代号。** |

顺序上的含义：**entries 若留在库里，任何 Postgres 移植都要面对「把一张 400 MiB 的
纯追加 blob 表搬进 Postgres」——那恰是最不该做的事。** 出库之后
`getEntries` / `upsertEntry` 变成文件操作、藏在同一个 Storage 接口后面，
pg 移植要处理的表直接少一张，且是最难的那张。

worker 侧不上 Postgres：它就该是 SQLite（关系型头）+ 文件（源真相）+ 代号库（派生态）。

## 1. 终局

| 层 | 内容 | 存储 | 迁移策略 |
|---|---|---|---|
| 源真相 | 会话记录（`AgentMessage` 流） | `sessions/<id>/entries.jsonl` | **无 schema**，append-only，读端容忍未知字段，永不换代 |
| 关系型头 | `agent_sessions`、projects、notifications、workspace checkouts | `data.sqlite` | 正常版本化迁移；列少行少，真能 `ALTER` |
| 派生 / 缓存 / 日志 | 搜索索引、executor 日志 | `<name>_N.sqlite`（独立文件） | 版本化迁移；**需要重建表就换代丢弃** |

对照存储经验文 §5.3：这正是 Claude Code 与 Codex 所在的那一格——源真相在文件、库里只装丢得起的东西。

### 1.1 现状实测：成本 99% 由一张表贡献

2026-08-06 实测本机 `~/.vibedeckx/data.sqlite`（423.6 MiB，`dbstat` 分表统计）：

```
agent_session_entries                        405.2 MiB   284,498 行
sqlite_autoindex_agent_session_entries_1      14.9 MiB
                                            ─────────
                                             420.1 MiB   =  99%

其余全部合计(含索引与空闲页)                  ≈ 3.5 MiB   ≈ 5,800 行
  workflow_runs 0.6 / turn_snapshots 0.5 / agent_sessions 0.4 /
  notifications 0.3 / notification_outbox 0.2 / ...
```

三条推论，直接决定本计划的取舍：

1. **第 3 步是全部价值所在。** 迁移痛苦的 99% 来自一张表。
2. **关系型头那一层不需要独立文件，也不需要换代能力。** entries 一走，
   `data.sqlite` 剩下约 5,800 行 / 3.5 MiB——在这个量级上「建新表 → 拷贝 → 删旧表 → 改名」
   是毫秒级操作。存储经验文 §2 那两个 SQLite 陷阱仍要注意，但它们是**正确性**问题
   （靠真实库副本演练解决，§2 ⑤），不是**代价**问题。
3. **`data.sqlite` 不改名、不加代号。** 见 §1.2。

### 1.2 命名即声明

文件名里有没有代号，就是「这个库能不能扔」的声明：

```
data.sqlite        无代号  →  含不可重建的用户意图,永不丢弃,只能迁移
search_1.sqlite    有代号  →  纯派生,允许丢弃,需要重建表就 bump
```

因此**不要**把核心库改名成 `core_1.sqlite` 之类：那会让后来的人（或 agent）按约定
推断它可以 bump，是个陷阱；而且重命名 `data.sqlite` 本身就是一次对所有用户生效的
迁移，纯成本零收益。关系型头留在原路径，靠减法自然成为「那一层」。

## 2. 约束

三条长期成立，路线是从它们推出来的：

1. **worker 由用户随机升级**（存储经验文 §3.1）。任何原地迁移都是一扇开在你不运维的机器上的单向门。
2. **solo 模式下 worker 就是 hub**（§3.3），所以 worker 上的库删不掉，只能分层。
3. **entries 含有别处反查不出的语义**。`AgentMessage`（`src/agent-types.ts:37`）里的
   `turn_end` / `notificationDisposition` / `origin: 'workflow'` 是 vibedeckx 自己的领域模型，
   两家 CLI 的日志里都没有。因此 entries **是源真相**，不是可丢弃的派生态。

### 2.1 换代天然是版本倾斜安全的

这是本项目采用「代号」方案最强的理由：

```
原地迁移  v0.3.11 改了 data.sqlite → 用户回滚到 v0.3.10 → 读不了/读错
换代      v0.3.11 开 search_2.sqlite,v0.3.10 开 search_1.sqlite → 互不干扰,回滚就是回滚
```

与 `reverse-connect-capabilities.ts` 那套「加东西可以、改语义要走弃用窗口」是同一思路，
只是从**协议面**延伸到**存储面**。目前存储面没有对应纪律。

## 3. 路线总览

| 步 | 内容 | 成本 | 何时做 |
|---|---|---|---|
| 0 | 判据入库（文档 + review 检查点） | 零代码 | 立刻 |
| 1 | 立一个可换代库的样板 | 低 | 跟着 worker FTS5 搜索走 |
| 2 | 记录 `native_session_id` | 极低 | 立刻，独立有价值 |
| 3 | entries 出库 + 搬迁 | 高 | **有触发条件才做**，见 §7.0 |

第 0、2 步做完，增量的债就止住了。存量债可以一直欠着，只要它不再长。

**关于各步的实际收益，别被顺序误导**（依据 §1.1）：

- 第 1 步的三张表**实测 0 行**，收益是**纯样板**——建立约定、跑通一次 bump，
  没有任何即时的体积或性能收益。它排在前面是因为便宜且有独立动机（FTS5），不是因为重要。
- 第 3 步是 99% 的价值所在，也是唯一昂贵的一步。
- 第 0、2 步的价值是止损与保留选项，不是修复。

---

## 4. 第 0 步：判据入库

在存储经验文 §6 之后补两条可执行规则：

1. **新增持久化数据默认走独立文件 + 代号**：命名 `<name>_1.sqlite`，
   打开逻辑统一写成「文件不存在 → 建空文件 → 从 migration 1 跑起」，
   并在文件顶部注明**本库允许被丢弃**。
2. **加一个 review 检查点**：任何需要「建新表 → 拷贝 → 删旧表 → 改名」的变更，
   先问「这个库能不能换代」。能，就换代，不写重建逻辑。
3. **按增长率决定去处，不是按当前大小**：

   > 任何**跟着每条消息 / 每次事件增长**的表，在建它之前就要决定它是文件还是可换代库。
   > 跟着 **session 或用户配置**增长的，留在 `data.sqlite` 里没问题。

   `agent_session_entries` 当年是按「一张普通表」加进来的，五个列从没变过，
   单看 schema 完全无害——问题全部来自增长率。这条规则就是为了不再造出第二张。
   现有表按此判据（2026-08-06 实测）：

   | 表 | 行数 | 跟着什么增长 | 判断 |
   |---|---|---|---|
   | `agent_session_entries` | 284,498 | **每条消息** | 本计划处理 |
   | `turn_snapshots` | 1,631 | 每个 session（≈1:1） | 可接受 |
   | `notifications` | 1,125 | 每个里程碑 | 可接受 |
   | `notification_outbox` | 1,125 | 每个里程碑 | 与 `notifications` **完全相等**，疑似投递后未排空，待查（与本计划无关） |
   | `workflow_runs` | 157 | 每次 workflow | 单行最大（≈4 KB/行），留意 |
   | 其余 | < 50 | 用户配置 | 无 |

判据本身（存储经验文 §6 的 Q1/Q2/Q3）不变，补一条 Q4，见 §10。

---

## 5. 第 1 步：第一个可换代库

**对象**：`session_search_cache` / `workspace_search_cache` / `search_catalog_sync_state`
——名字里就写着 cache，纯派生，丢了能重建。**三张表 2026-08-06 实测均为 0 行。**

**动作**：挪到 `search_1.sqlite`，独立 migration 链，独立代号。

**先说清楚收益**：因为是空表，这一步**没有任何即时收益**——不减体积、不提性能、
不解决任何现存问题。它的全部价值是**样板**。如果读到这里觉得「那为什么要做」，
答案是：它便宜，且 FTS5 那边本来就要动这块；如果 FTS5 不做了，这一步可以直接跳过，
把 §4 的约定留给下一个真正新增的派生库即可。

**为什么选它**：不是「最该挪」，而是它本来就有事要做——worker 侧 FTS5 联邦搜索会需要
重划索引结构，那正好是一次真实的「重建表 vs 换代」选择。与其为它写一个跑在用户
282k 行库上的重建迁移，不如让它落在一个从一开始就能 bump 的文件里。

**买到的是样板**：第一个可换代库、一套 open/migrate 约定、一次 bump 的实操。后面每个新库照抄。

### 5.1 换代的机械判据

（实测依据见附录）

```
要改 schema
 ├─ ADD COLUMN / CREATE TABLE / CREATE INDEX / DROP TABLE 能搞定?  → 写迁移
 ├─ 需要重建表(改主键/改列类型/加 NOT NULL/改表名/改语义)?
 │    ├─ 库里有不可重建的用户意图 且 表小 → 咬牙重建(注意存储经验文 §2 两个 SQLite 陷阱)
 │    └─ 否则                            → 换代
 ├─ 表很大(百 MB 级)?                     → 换代,别想迁移
 └─ 只是想清理攒了半年的平行列?            → 换代
```

**换代的落地方式**：文件名里的数字是代码常量。改掉它 → 新版本 open 时文件不存在 →
建空文件 → 从 migration 1 跑到最新 → 重建逻辑（本来新装用户就要跑的那套）把数据灌回来。
**为换代写的代码是 0 行。** 老文件没人再 open，留着或下版顺手 `unlink` 都行。

**换代的前提**：库里只能有可重建的数据。只存在于该库、且重建不出来的用户意图必须足够小、
丢了足够不心疼——否则该把那部分挪到不换代的层去。

---

## 6. 第 2 步：`native_session_id`

**动作**：`agent_sessions` 加一列 `native_session_id TEXT`（可空），记录 CLI 侧的 session id。

**可行性**：claude 的 stream-json 里 `session_id` 协议层**已经在解析**
（`src/protocol/claude-code/schema.ts` 多处）；codex 的 rollout 头 `session_meta` 也带 `session_id`，
但**需要确认它是否出现在 stdout 流里**——只在磁盘日志里的话这条对 codex 不成立，
届时留空即可，不阻塞。

**性质**：纯 expand。老 worker 无感，写入点一行。

**买到**：

- 调试时能从 vibedeckx session 直接跳到 `~/.claude/projects/<slug>/<id>.jsonl` 或
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- 两份记录可交叉验证
- 第 3 步的前置条件

**不做第 3 步也值得做。**

---

## 7. 第 3 步：entries 出库

### 7.0 触发条件

不要为了「架构干净」做。等下面任一条出现：

- worker 库体积或损坏出过一次事故
- 需要按时间裁剪历史（现状做不到：SQLite `DELETE` 不还盘，`VACUUM` 锁全库，
  在用户机器上基本不能跑）
- FTS5 联邦搜索需要直接扫记录

### 7.1 文件布局与格式

```
<dataDir>/sessions/<sessionId>/entries.jsonl
```

- 一行一个 `JSON.stringify(AgentMessage)`——**与现在 `data` 列里的内容逐字节相同**
  （`agent-session-manager.ts:1699`）。
- 行序即 `entry_index`。同 index 后写覆盖前写，回放时 last-wins。
- **永不换代、永不 ALTER**（它没有 schema 可以 ALTER）。
- 格式演进继续靠现有机制：`AgentMessage` 里那一批 optional 字段
  （`origin?` / `notificationDisposition?` / `event?` / `outcome?` / `durationMs?` / `resolved?`）
  就是读端容忍，实测已支撑 282k 行、多轮格式演进、零次内容迁移。

**归一化代码一行不用改**：协议层、`AgentMessage` 定义、provider 解析全部原样保留。
出库改的只是「归一化结果落到哪」。

### 7.2 写路径

唯一写入点是 `persistEntry`（`agent-session-manager.ts:1691`），把
`storage.agentSessions.upsertEntry(...)` 换成 append。

两个已确认的事实让这件事比看上去简单：

- **流式 partial 不落盘**。`addEntry` 明确跳过 `type === "assistant"`
  （`agent-session-manager.ts:1596`），assistant 文本只在 `finalizeStreamingEntry` 时落一次。
  不存在逐 token 写放大。
- **`upsertEntry` 的 update 语义实际只用于幂等重写**（同 index 再写一次），
  不是就地更新。append-only + last-wins 回放是它的原生等价物。

**必须保持的不变量**：`entry_index` 稠密无洞。
`agent-session-manager.ts:962` 附近的注释写得明确——branch-cutoff 协议假设索引稠密，
有洞会静默切错位置。`finalizeStreamingEntry` 存在就是为了补这个洞，出库后同样要保留。

### 7.3 读路径

```
读 session 的 entries:
  sessions/<id>/entries.jsonl 存在?  → 读文件
                                     → 否则读 agent_session_entries
```

**这个 fallback 必须收在一个投影函数后面**，不要散到读点上（存储经验文 §4.3：
杠杆在于旧格式处理是收在一个边界后面还是散在每个读点上）。
`getEntries(sessionId)` 是天然的收敛点——现有调用方本来就走它。

一个 session 要么整个属于「文件时代」要么整个属于「DB 时代」，**不会混**：
entries 按 session 追加，不存在跨时代的半截会话。所以判断只需要做一次。

### 7.4 搬迁涓流

不做批量迁移。两条路并行：

**① Lazy relocation（读时搬家）**

从 DB 读到了 entries → 顺手写成文件 → 删掉这些行。

**② 后台涓流**

每次启动搬最老的 N 个 session，带 watermark，可中断可续。

```sql
CREATE TABLE entries_relocation_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL,          -- pending | running | complete
    last_watermark TEXT,           -- 最后处理完的 session_id
    last_success_at INTEGER,
    updated_at INTEGER NOT NULL
);
```

这是 Codex `backfill_state` 的形状（附录），它用同一套扫完了 1393 个 rollout。

**每一步都幂等**：写文件 → 校验条数与稠密性 → 才删行。中断在任何一刻，那个 session
要么在文件里要么在库里，读路径两边都认，系统自洽。

**触发点**：参照存储经验文 §2 ④——挂在「前置条件产生的那一刻」，
不要只挂启动。对本任务而言启动即可（本地库随时可读），但 remote 场景下
worker 重连时也要跑一次。

### 7.5 校验判据

搬迁完成的定义（本机可验）：

- watermark `status = complete`
- 逐 session：文件条数 ≥ DB 条数，且 `entry_index` **连续无洞**
- `SELECT COUNT(*) FROM agent_session_entries` = 0

### 7.6 `DROP TABLE` 的两道门

**① 数据门**：§7.5 全部通过。

**② 版本门**：worker 归用户升级。若在**同一个版本**里既搬迁又 DROP，
用户降级回上一版 → 老代码读一张不存在的表 → 历史全空。

所以 DROP 要卡在 `MIN_WORKER_VERSION`（`src/constants.ts`）已经越过
「引入文件读路径的那个版本」之后。这就是 CLAUDE.md 里隧道契约那套弃用窗口，原样搬到存储面。

```
R1   新 session 写文件;读路径 文件→DB fallback;涓流搬迁跑起来
     表原封不动,可随意降级
       ↓  各机器陆续搬完(watermark complete)
R2+  MIN_WORKER_VERSION 推过 R1
       ↓
Rn   DROP TABLE agent_session_entries     ← 合法迁移,不需要重建表
```

**别急着 DROP。** 行搬空之后那张空表零成本：不占空间、不影响查询、不参与迁移
（五个列从没变过）。而且 DROP 也不会让文件变小（同 `DELETE`，页进 freelist 不还盘）。
搬迁做完、校验通过，收益已经全部拿到，DROP 随便哪版顺手带上。

### 7.7 受影响面清单

| 位置 | 现状 | 出库后 |
|---|---|---|
| `storage/types.ts:1046` `upsertEntry` | 写 DB | 改 append 文件 |
| `storage/types.ts:1065` `getEntries` | 查 DB | **收敛点**：文件优先，DB fallback |
| `storage/types.ts:1066` `deleteEntries` | `DELETE` | 删目录 + 孤儿清扫器 |
| `storage/types.ts:1067` `countEntries` | 聚合查询 | 数行 / 维护计数列 |
| `agent-session-manager.ts:3021` branch-from-history | 逐行 `upsertEntry(newId, ...)` | 文件整体拷贝 |
| `repositories/search-cache.ts:615` `EXISTS` 子查询 | 判「该 session 有无 entry」 | 改为 `agent_sessions` 上的计数列 |
| `sqlite.ts:1118` `ON DELETE CASCADE` | 级联删 entries | 显式删目录；孤儿目录需清扫 |
| remote 同步 | 走 mapping | 需重新走查一遍 |
| `session.skipDb` 分支 | 跳过持久化 | 语义不变，跳过写文件 |

**不受影响**：协议层、`AgentMessage` 定义、provider 解析、WS patch 广播、前端。

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 搬迁中断留下半搬状态 | 每 session 原子（写完校验才删行）；watermark 可续 |
| 文件写失败导致丢 entry | 写失败**不删 DB 行**；下次重试 |
| `entry_index` 出洞 → branch-cutoff 切错 | 校验稠密性作为删行前置；保留 `finalizeStreamingEntry` |
| 用户降级到无文件读路径的版本 | DROP 卡 `MIN_WORKER_VERSION`；在此之前 DB 行还在 |
| 孤儿目录堆积 | 启动时对照 `agent_sessions` 清扫 |
| 磁盘不回收 | 见 §9；DROP 与 `DELETE` 都不还盘，需显式 compact |

**回滚**：R1 阶段全程可回滚——文件是新增的，DB 行在搬迁前原样存在。
真正的单向门只有 `DROP TABLE`，而它被两道门挡在最后。

## 9. 独立事项：retention 与 VACUUM

这两件事**不属于本计划**，但会被顺带问到，先记清楚：

**Retention（超期自动清理会话）** 是产品决策，不是存储优化。两个参考数据点（2026-08-05 实测本机）：

```
~/.codex/sessions/   1393 个 rollout,最早 2025-12-19,8.5 个月一个没删
~/.claude/           2082 个 .jsonl,同样没有自动清理
```

两家都不删用户对话历史。要做的话：用户可见设置、默认关闭、删前提示，
且**放到 entries 已是文件之后**——那时它就是 `rm -rf sessions/<id>/`，一行，还盘立刻生效。

**不要把「排空老表」押在 retention 上**：万一决定不删，排空就永远做不完。
§7.4 的搬迁不删任何数据，与 retention 无关。

**VACUUM**：SQLite `DELETE`/`DROP` 都不还盘。搬空之后主库会「逻辑上空了、物理上还是几百 MB」，
且因为新 entries 都去了文件，**没有新插入来复用那些空页**。两个选择：

- 接受（体积不再增长）
- 提供显式 `vibedeckx maintenance compact` 命令，用户自己决定何时忍受几十秒锁库

**不要把 VACUUM 挂在启动上。**

## 10. 判据补充

存储经验文 §6 的三问之后补第四问：

> **Q4：旧格式的处理有没有终点？**
> - 信息完整（旧数据自身可读出、可转换）→ **有终点**。写搬迁，收敛后删兼容分支。
> - 信息不完整（无法自证，如 worktree 已删的归属）→ **没有终点**。
>   按存储经验文 §2 ② 处理：承认它是永久支持状态，不要当待办。

对照：`workspace_checkout_id IS NULL` 属于后者（旧表只有 `(project, branch)` 约定，
无法证明属于哪一次 incarnation）；entries 属于前者（行就在那儿，读出来就能写文件）。
**能否收敛取决于信息是否完整，不取决于它是不是「老数据」。**

---

## 附录：换代机制实测（Codex，2026-08-06 本机 `~/.codex`）

用于支撑 §5.1 的判据。存储经验文 §5.2 把「换代」标注为推断，以下为实测结果。

**时间线**

```
2025-12-19   最早的 rollout JSONL
2026-02-27   state_5.sqlite 诞生;migration 1..22 全部在同一秒安装(13:29:10)
2026-04-15   migration 23 "drop logs"    14:56:33
   ↕ 同一秒   logs_2.sqlite 诞生         14:56:33
2026-05-27   migration 34 "drop thread goals"  09:46:50
   ↕ 同一秒   goals_1.sqlite 诞生              09:46:50
2026-06-04   migration 35 "drop memory tables"
2026-07-26   migration 42 "drop agent jobs"
```

**结论**

1. **42 条迁移全部落在 `ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX` / `DROP TABLE`**，
   其中 5 条是 `DROP`。`threads` 表的 schema 尾部是 `ALTER TABLE ADD COLUMN` 追加的一长行，
   证明**从没重建过表**。→ 需要重建表时他们换代，不写重建迁移。
2. **换代 = 从零建库 + 从源真相重建**。`backfill_state` 单行表记录
   `status=complete` 与 watermark；`threads` 有 1394 行、最早 2025-12-19，
   其中 **452 行早于 `state_5.sqlite` 文件本身**——只可能来自扫 rollout JSONL 重建。
   `threads.rollout_path` 列直接存着回指源文件的指针。
3. **换代不是无损的**。`threads.archived` / `name` / `agent_nickname` 是用户操作，
   rollout 里没有，重建不出来。他们接受这个代价，因为量小。
4. **换代是清 expand-only 债的地方**。`threads` 现有
   `created_at` + `created_at_ms`、`updated_at` + `updated_at_ms`、
   `recency_at` + `recency_at_ms`、`source` + `thread_source`、
   `history_mode DEFAULT 'legacy'`——都是「不敢改语义于是加平行列」的产物，
   与本仓库 §4.2 的 inert 列同类。下一次换代时新库从零定义，债自然清零。

**证据边界**：无法区分「2026-02-27 从 `state_4` 换代过来」与「那天首次引入 state 库、
一上来就叫第 5 代」。两种解释下 `_5` 都说明 1~4 代曾存在并被放弃、rollout 都完好，
结论不变，但这一环是推的。
