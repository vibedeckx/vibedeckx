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
ORDER BY activity_at ASC                -- 最老的先删
LIMIT 20
```

- `activity_at` 是现成的语义最大值列（四个活跃时间源的 max，专为此类查询回填过），
  不用新造。半年前创建但上周还在用的 session 不会被删。
- `status != 'running'` 在 N 天门槛下几乎不可能命中，仍要守——防御性谓词的成本是零。
- 加星是唯一的用户侧豁免。想保留的会话，加星即可，不另设「保留标记」。

### 1.3 执行：谓词驱动的有界批，不需要 watermark

比 entries 计划 §7.4 的搬迁涓流还简单：删除按谓词幂等，每次 tick 重新 SELECT 即是
进度本身，删完自然查不到。**不需要任何状态表。**

```
tick:
  loop:
    候选 = 上面那条 SELECT (LIMIT 20)
    没有候选 → 结束     ← 稳态下 99% 的 tick 到这一步就返回，近乎免费
    逐个删除（见 §1.4）
    批间让出事件循环（setImmediate），不阻塞正在服务的 WS
    本 tick 已用时 > 30s → 结束，剩余留给下个 tick
```

「循环批 + 时间预算」而不是固定单批，是为**首次启用**设计的：一台跑了一年的机器
第一次开 90 天保留，可能一次性上千个过期 session；固定 20 个/tick 要拖十几天，
循环批在一两个 tick 内清完，同时把持续负载封在 30s/6h 以内。

### 1.4 删除路径：走 manager，不直删 storage

老 session 启动时被 restore 进内存 map（dormant 态），只删 DB 会留幽灵。所以：

- 优先 `manager.deleteSession(id)`——清内存 map、广播 `finished` 让开着的 UI 刷新、
  然后删 DB 行（CASCADE）。
- 不在 map 里的兜底走 `storage.agentSessions.delete(id)`。
- `skipDb`（hub 上的 remote 镜像会话）**天然不在候选里**——它们没有本地 DB 行；
  远端会话的清理由 worker 自己的 sweep 负责（见 §3 Phase 2）。

边界情况：用户此刻正打开着一个第 91 天的老会话在看 → 收到 `finished` 广播、
界面提示会话已删除。与手动删除行为一致，不新增状态。

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
| **Phase 2** | retention 配置读/写下发到远端 worker 的 capability（**加法**，老 worker 404 → UI 显示「需升级 worker」；按隧道契约在 `src/reverse-connect-capabilities.ts` 登记，快照测试会强制） | SaaS 部署下的远端 worker——**主场景** | 半天 |

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
- 最老优先 + 批次封顶 + 时间预算提前退出。
- 内存一致性：map 里的 dormant session 被删后不留幽灵、订阅者收到 `finished`。
- 幂等：连续两次 tick，第二次零动作。
- CASCADE 完整性：entries / turn_snapshots / native_ids / deliveries 全部随行消失
  （复用 FK 守卫测试的断言风格）。
- hub 无害：没有本地 session 的机器上 tick 是一次空 SELECT（对齐 entries 计划
  §0.1.0 的「自然空操作」约束——不出现 `if (isHub)`）。

## 6. 与 entries 出库计划的关系

- 本方案让「控制体积增长」彻底退出第 3 步的动机列表（那边 §7.0 本就写明
  「单纯控体积不构成触发条件」——本方案就是那条里说的「成本低两个数量级」的路）。
- 第 3 步将来若做，本方案的删除动作从 CASCADE 变成 `rm -rf sessions/<id>/`
  （立即还盘），判据、调度、豁免全部原样保留。
- 「真正意义上的删除」（隐私：`DELETE` 后数据仍在 freelist 页里可被 `strings`
  捞出）**不是**本方案的承诺——那仍是第 3 步的最强触发条件，别混淆。

## 7. 待定项

- 建议默认天数（界面预填值，倾向 90）——待拍板。
- Phase 2 里 per-worker 还是全局统一天数（倾向全局一个值，per-worker 是过度设计）。
