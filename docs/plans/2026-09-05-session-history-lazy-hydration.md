# Plan: Session History Lazy Hydration —— 启动只装元数据，历史按需装载、有界卸载

**Status:** 被方案 B（`…-lazy-hydration-b.md`）取代，未实施（2026-09-05）。
B 沿用了本文的 §2.2 冷启动、§2.3 倒读 repair、§3 契约与 §8 验收，但用
「热态 ⇔ 进程存活」替换了本文的 cold/loading/hot 状态机与卸载 sweeper。
本文保留为那次取舍的记录。

止血半边（daemon readiness 超时可配）已在 `e3c51743` 落地：
`--readiness-timeout` / `VIBEDECKX_CONNECT_DAEMON_READY_TIMEOUT_MS`，默认仍 15s。
本文是根治半边。

**关联：**
- `docs/plans/2026-08-06-session-entries-to-files.md` —— entries 出库。本文的
  `ensureHydrated` 是出库后唯一的历史读取接缝（§7）。
- `docs/plans/2026-08-08-session-retention.md` —— 同一病根（历史太大）的另一把刀；
  本文 §2.6 的判空改法直接影响它的 §1.5 TOCTOU 守卫。
- `docs/plans/2026-08-13-hub-memory-governance.md` —— hub 侧 `RemotePatchCache`
  的内存治理。本文只管 worker 侧 `AgentSessionManager`，两者互不覆盖。

---

## 0. 一句话

worker 启动时不再把所有会话的全部 `agent_session_entries` 读进堆里；每个会话只装
一行元数据（条数、最大下标），历史在第一次被读或被写之前按需装载，长期无人用的会话
再卸回冷态。所有读历史、写历史、清历史的入口都必须经过同一个状态机。

## 1. 现状与问题

### 1.1 "懒加载"指的是什么数据

`agent_session_entries` 表：一行 = 一条 JSON 序列化的 `AgentMessage`
（`session_id, entry_index, data`）。类型有 user / assistant / thinking / tool_use /
tool_result / system / turn_end；体积主力是 tool_result（整段文件内容、命令输出）。

### 1.2 现在的路径

`shared-services.ts:39` 在插件初始化里 `await agentSessionManager.restoreSessionsFromDb()`；
readiness 排在它后面。`restoreSessionsFromDb`（`agent-session-manager.ts:3664`）对每个
`agent_sessions` 行：

1. `getEntries(sessionId)` —— 该会话全部行；
2. 状态为 `running` 的行先过 `repairInterruptedTurn`（整段 parse，找回合开头）；
3. `rebuildStoreFromRows` —— 逐条 `JSON.parse`，写入 `store.entries[idx]`，
   为每条生成一个 `addEntry` patch 推进 `store.patches`，重建 `toolTracker`，
   `indexProvider.setIndex(maxIndex + 1)`。

装完后永远留在堆里，没有任何卸载路径。常驻进程池（`ensureResidentCapacity`）只对
process 做 LRU 休眠，对历史数据不做。

### 1.3 内存里保存了什么

每个 `RunningSession.store`（`MessageStore`，`agent-session-manager.ts:116`）：

| 字段 | 内容 | 冷会话是否必要 |
|---|---|---|
| `entries` | 稀疏数组，解析后的消息对象 | 否 |
| `patches` | 每条 entry 一个 add patch；`value` 引用同一对象，不是双份，但每条多一层包装 | 否（可从 entries 现算） |
| `toolTracker` | toolUseId → 下标 | 否（只在流式期间用） |
| `indexProvider` | 下一个可用下标 | 是（一个整数） |
| `currentAssistantIndex` | 流式中的 assistant 下标 | 是（冷会话恒为 null） |

### 1.4 规模（标注来源，本文未复测）

| 来源 | 数字 |
|---|---|
| `2026-08-06-session-entries-to-files.md` §1.1，2026-08-06 `dbstat` 实测 | `agent_session_entries` 405.2 MiB / 284,498 行；加自索引 14.9 MiB 合计占库 99% |
| 2026-08-31 worker3 排查记录（记忆 `project_worker3_earlyoom_daemon_boot_timeout`） | 1311 sessions / 256,283 行 / 410 MB JSON → 堆 ≈750 MB，RSS 0.9–1.1 GB；空闲机 spawn→ready 7.4 s，其中 restore 6.2 s |

这些是"上次实测"，不是本次证实的现状。验收（§8）要在实施前重测一次基线。

### 1.5 真正的难点：整个代码库把"历史一定在内存"当不变式

读历史的入口全部是同步 API，没有地方能表达"还没装载"：

**读**

| 入口 | 位置 | 用途 |
|---|---|---|
| `subscribe()` | `agent-session-manager.ts:2497`，由 `websocket-routes.ts:494` 调用 | 回放 `store.patches` |
| `getMessages()` / `getRawMessages()` | `:2560` / `:2566` | `agent-session-routes.ts` 十余处（详情、history window、brief、branch 结果、recover）；`workflow-engine.ts:880/1131/1205`；`workflow-run-routes.ts:396`；`project-chat-tools.ts:1284`；`chat-session-manager.ts:1531` |
| `buildHistoryWindow()` | `session-history-window.ts:47` | 对内存稀疏数组倒扫 turn_end |
| `buildFullConversationContext(session.store.entries)` | `:3322`（switchMode）、`:3494`（wake） | 唤醒时把全文喂给新进程 |
| `extractLastAssistantText(session.store.entries)` | `:1573` | 完成通知摘要 |
| `findTurnOpeningUserEntry` / `findLatestUserEntry` on `store.entries` | `:2280`、`:1740` | 回合 disposition |
| `store.entries.some(Boolean)` 判空 | `:2931` discardSessionIfEmpty、`:3074` switchAgentType、`:3245` isModelChangeTooLate、`:1098` 日志 | "有内容" 判据 |

**写 / 清**

| 入口 | 位置 | 影响 |
|---|---|---|
| `stageEntry` → `pushEntry` | `:2087` / `:2095` | 追加到 `store.entries`、`store.patches`；`switchAgentType`（`:3114`）和 `hibernateSession`（`:2791`）会对 **dormant** 会话追加 system 消息 |
| stdout 解析路径 | `enqueueSessionWork` 链 | 流式写 `entries[currentAssistantIndex]`、toolTracker |
| `restartSessionInner` | `:3006-3018` | `deleteEntries` + `incrementHistoryEpoch` + 清空 store |
| `branchSession` | `:3827` | 从源会话读全量、向新会话写全量 |

如果只在 subscribe 时装载，其余入口读到空 store 会静默给出错误结果（history window
为空、wake 时上下文丢失、retention 把"没内容"的会话删掉）。写入不协调则出现两类竞态：
加载中追加被旧快照覆盖；restart 清空后在途加载把已删历史装回。

## 2. 关键决定与理由

### 2.1 状态模型：每个会话一个显式 hydration 状态

`RunningSession` 新增：

```ts
hydration: "cold" | "loading" | "hot";
/** 冷态也有效的元数据；hot 时与 store 同步维护 */
historyMeta: { entryCount: number; maxEntryIndex: number };
/** 每次清空 / 卸载 +1；在途 hydrate 完成时比对，不等则丢弃结果 */
hydrationGeneration: number;
hydrationPromise: Promise<void> | null;
lastHydratedAt: number;
```

不变式（必须由代码保证，测试覆盖）：

- **I1** `process !== null ⇒ hydration === "hot"`。有进程的会话永远是热的；
  stdout 解析路径因此可以保持同步，不需要在流式写入里 await。
- **I2** `skipDb === true ⇒ hydration === "hot"`，永不卸载。hub 上的远端镜像会话
  没有本地行，无处可装。
- **I3** `hydration === "hot" ⇒ store.entries` 与 DB 一致，限定为**已持久化的 entry**
  （同 epoch 内）。流式中的 assistant 文本在 `finalizeStreamingEntry` 之前只在内存里，
  `persistEntry` 失败被捕获后也会留下内存有、DB 无的行 —— 这两种今天就存在，本文不
  改变它们；它们只影响卸载后重装的等价性（§2.6），不影响装载正确性。

冷态 store 是一个空壳：`entries = []`、`patches = []`、`toolTracker` 空、
`indexProvider.setIndex(maxEntryIndex + 1)`。**indexProvider 在冷态也是正确的**，这
样 `stageEntry` 即使在冷态被调用也不会撞下标 —— 但我们仍然禁止冷态写（§2.4），
这条只是纵深防御。

### 2.2 启动：一条聚合查询，不读 `data`

把 `countEntries()`（已存在，`repositories/agent-sessions.ts:924`，被 search catalog
和两个路由用着）扩展一个兄弟方法：

```ts
getEntryMetaAll: () => Promise<Array<{ session_id: string; cnt: number; max_index: number }>>;
// SELECT session_id, count(*) cnt, max(entry_index) max_index
// FROM agent_session_entries GROUP BY session_id
```

`restoreSessionsFromDb` 改为：

1. `getAll()` + `getEntryMetaAll()` 各一次；
2. 无 meta 的行仍按现状跳过（`boot_zero_entry_rows` 日志保留）；
3. 每个有 meta 的行构造 **cold** `RunningSession`；
4. `status === "running"` 的行走 §2.3 的倒读式 crash repair，repair 写入的
   `turn_end` 让 `historyMeta.maxEntryIndex += 1`、`entryCount += 1`；
5. 其余（checkout 投影、`updateStatusPreservingTimestamp`、`repairOrphanedRunningRows`）
   不变。

启动开销从 O(全部 entries) 变为 O(会话数) 加一次全表聚合。SQLite 对
`(session_id, entry_index)` 自索引做 `count/max GROUP BY` 是索引扫描，不读 `data` 列。

### 2.3 Crash repair：从尾部分批向前读到上一条 `turn_end`，不能用固定尾窗

`repairInterruptedTurn` 需要两样东西：

- **落地类型** —— 跳过尾部 system 消息后，最后一条非 system 是不是 `turn_end`。
  只看尾部几行就够。
- **本轮开头的 user 消息** —— `findTurnOpeningUserEntry`（`notification-milestones.ts:44`）
  要求倒扫到上一条 `turn_end`，并取**最早**的 user（中途 steering 也是 user 类型）。
  找不到开头时 `resolveNotificationDisposition` 默认 `result`，会生成 `session_failed`
  通知。长工具回合的开头可能在几百条之外；固定尾窗会把内部 workflow / reviewer
  回合误判成 `result`，误发通知。

因此新增倒序分页读取：

```ts
getEntriesBefore: (sessionId: string, beforeIndex: number | null, limit: number)
  => Promise<Array<{ entry_index: number; data: string }>>;
// WHERE session_id = ? AND (? IS NULL OR entry_index < ?) ORDER BY entry_index DESC LIMIT ?
```

算法（批大小 64，无上界 —— 必须走到边界为止；只对 `running` 行执行，通常是个位数
到几十个会话，最坏情况等于今天的全量读，不会更差）：

```
cursor = null; landing = undefined; opening = undefined
loop:
  batch = getEntriesBefore(id, cursor, 64)        // 降序
  if batch 空: break
  for row in batch (降序):
    parse 失败 → 若 landing 未定则 landing = "unparsable"；继续（hole 不是边界）
    if landing 未定:
      if type == "system": continue              // 跳过尾部 hibernate 注记等
      landing = type
      if landing == "turn_end": return rows-unchanged   // 无需修复
      if type == "user": opening = msg           // 落地行本身可能就是开头
      continue
    if type == "turn_end": goto done             // 到达上一轮边界
    if type == "user": opening = msg             // 越早越覆盖，最终得到最早的 user
  cursor = batch.last.entry_index
  // 读到头（首轮崩溃、没有任何 turn_end）：带着已找到的 opening 落到 done
if landing 未定: return rows-unchanged       // 全是 system（或空）：与今天 landingType === null 同义，不修复
done:
  disposition = resolveNotificationDisposition(opening)
  repairIndex = historyMeta.maxEntryIndex + 1
  upsertTurnEndWithOutbox(...) + recordTurnSnapshot(...)   // 与今天相同
```

语义与现有实现逐点对齐：尾部 system 跳过；**只有 system 消息（或读到头仍无非 system
行）不修复**，否则会凭空写一条 `server_restart` 并按默认 `result` 误发失败通知；
unparsable 落地视为内容需修复；hole 跳过不当边界；先于 `turn_end` 遇到的最早 user
为开头。现有
`agent-session-manager.restore-repair.test.ts` 的全部用例迁移到新路径，并新增
"开头落在第一批之外"（回合长度 > 64 且开头是 `origin: "workflow"`）必须判 `internal`。

### 2.4 `ensureHydrated()`：唯一的装载入口，覆盖读与写

```ts
private async ensureHydrated(session: RunningSession): Promise<void> {
  // 每个调用者都跑同一个循环：等到 hot 为止。单飞只共享一次磁盘读，
  // 不共享"读完就算成功"的判断 —— 作废后的复查和重试对所有等待者都生效。
  for (let attempt = 0; session.hydration !== "hot"; attempt++) {
    if (attempt >= 3) throw new Error(`hydration of ${session.id} keeps being invalidated`);
    if (!session.hydrationPromise) session.hydrationPromise = this.hydrateOnce(session);
    await session.hydrationPromise;          // 内部吞掉作废，永不 reject 给等待者
  }
}

private hydrateOnce(session: RunningSession): Promise<void> {
  const generation = session.hydrationGeneration;
  const epoch = session.historyEpoch;
  session.hydration = "loading";
  return (async () => {
    const rows = await this.storage.agentSessions.getEntries(session.id);
    // 装载期间发生了 restart（epoch 变）或卸载/清空（generation 变）：结果作废
    if (session.hydrationGeneration !== generation || session.historyEpoch !== epoch) return;
    if (session.hydration === "hot") return;   // restart 已同步装好空壳，别覆盖
    const store = this.rebuildStoreFromRows(rows, session.id);
    // 冷态期间 indexProvider 可能已被推进（纵深防御），取大者
    store.indexProvider.setIndex(Math.max(store.indexProvider.current(), session.store.indexProvider.current()));
    session.store = store;
    session.historyMeta = metaFromStore(store);
    session.hydration = "hot";
    session.lastHydratedAt = Date.now();
  })().finally(() => {
    session.hydrationPromise = null;
    if (session.hydration === "loading") session.hydration = "cold";
  });
}
```

`attempt >= 3` 是防御性上界，不是设计路径：正常情况下一次作废最多来自一个 restart 或
一次卸载，第二次循环就会成功。

**写入协调规则：**

- 每个会写 store 的公开路径在**第一个写之前** `await ensureHydrated(session)`：
  `wakeDormantSessionInner`、`switchMode`、`switchAgentType`、`hibernateSession`
  （它只对有进程的会话调用，按 I1 已热，加一行防御即可）、`sendUserMessage` 的
  dormant 分支、`branchSession` 的目标会话、`spawnAgent` 之前。
  这样 `pushEntry` 只在热态执行，不需要在 `stageEntry` 里加 await。
- `restartSessionInner` 不装载。它在**第一个 `await` 之前同步**做三件事：
  `hydrationGeneration++`（让在途装载作废）、把 store 置为空壳、`hydration = "hot"`
  （meta 归零）；然后才 `deleteEntries` + `incrementHistoryEpoch`。顺序必须是这样：
  如果空壳装在 DB 删除之后，`ensureHydrated` 循环里的等待者会在删除进行中的窗口看到
  cold 并再起一次装载，读到半删的行。把 in-memory 清空提前到 DB 删除之前是安全的：
  进程在这之前已被 kill，`clearAll` 广播本来就在 DB 删除之后（`:3030`），前端看到的
  顺序不变。restart 后的会话没有历史可装，直接热。
- 卸载（§2.6）同样 `hydrationGeneration++`。

**为什么用 generation + epoch 双校验而不是串行锁：** 装载是纯读 + 一次赋值，
真正危险的只是"用旧快照覆盖新状态"。让写方递增版本、让读方在赋值前比对，比把
`getEntries` 塞进 `eventChain` 简单，且不会让 stdout 解析链等待一次磁盘读。

### 2.5 读入口的改法（逐个）

| 入口 | 改法 |
|---|---|
| `subscribe()` | 变 async：`await ensureHydrated` 后再回放；回放前后各检查一次 `ws.readyState`，socket 已关则不加入 `subscribers`、不回放、返回 null。**调用方 `websocket-routes.ts` 必须把 `close` 处理挪到 `await subscribe` 之前注册**：今天它在 subscribe 返回后才挂（`:517`），装载期间用户关页会漏掉 `stopHeartbeat`，装载完成后还会把死 socket 留在 `subscribers` 里，阻止 §2.6 卸载。改法：先 `let unsubscribe = null; socket.on("close", () => { stopHeartbeat(); unsubscribe?.(); })`，再 `unsubscribe = await subscribe(...)`；subscribe 内部在加入 `subscribers` 后若发现 socket 已关，自己立即移除。`HistorySync` / 后台任务快照 / 回放 / `Ready` 的顺序不变。 |
| `getMessages` / `getRawMessages` | 保留同步版本，**只允许热态调用**（冷态抛错，测试兜底）；新增 `async loadMessages(id)` / `loadRawMessages(id)` = `ensureHydrated` + 同步版。所有路由与 `workflow-engine`、`workflow-run-routes`、`project-chat-tools`、`chat-session-manager` 改调 async 版。`shared-services.ts:461` 注入给 workflow-engine 的 `agentOps.getRawMessages` 换成 async 签名。 |
| `buildHistoryWindow` | Phase A：调用方先 `loadRawMessages` 再切窗（正确优先）；Phase C 改为 DB 分页（§4）。 |
| `buildFullConversationContext` | 调用点在 wake / switchMode，前面已 `ensureHydrated`。 |
| `extractLastAssistantText`、`findTurnOpeningUserEntry`、`findLatestUserEntry` | 都在有进程的路径上（完成通知、endActiveTurn、turn 开始），按 I1 已热；加断言。 |
| `store.entries.some(Boolean)` 判空四处 | 改为 `session.historyMeta.entryCount > 0`。**retention 与 discard 绝不能因判空触发装载**（否则每次 sweep 把全库拉回堆里）。热态下 `historyMeta` 随 `stageEntry` / `finalizeStreamingEntry` 同步维护，所以两种状态下语义一致。 |
| `getSession()` 返回 `RunningSession` 的路由 | 只读元数据字段（status、agentType、model…），不碰 store；保持同步。审计所有 `getSession(...)` 调用点确认没有顺手读 `store`。 |

### 2.6 有界卸载

没有卸载，用户翻过的会话会慢慢把内存涨回来。卸载条件（全部满足）：

- `hydration === "hot"` 且 `!skipDb`
- `process === null`（I1 的逆向）且 `dormant === true`
- `subscribers.size === 0`
- `processStartsInFlight === 0` 且 `userMessagesInFlight.get(id) ?? 0 === 0`
- `currentAssistantIndex === null`、无 grace/park timer
- `Date.now() - max(lastActiveAt, lastHydratedAt) > idleMs`，**或** 热会话总数超过上限时按
  该时间 LRU 淘汰到上限以内

卸载动作：`hydrationGeneration++`；`historyMeta = metaFromStore(store)`；store 置冷态
空壳（indexProvider 保留当前值）；`hydration = "cold"`。重新装载得到的 store 与
今天 restore 的产物一致（indexProvider 由 maxIndex 重建，toolTracker 由 entries
重建）。这个等价性只对**已落库的 entry** 成立：卸载条件里的"无进程、无流式、无
inflight"就是为了保证没有未落库的内存态；`persistEntry` 失败留下的孤行会在卸载时
丢失，与今天 worker 重启后的结果相同，不是新损失。

触发：一个独立的 60 s 定时器（不复用 retention sweeper —— 那个默认关闭）。默认
`idleMs = 10 min`、`maxHot = 64`；两者进 `agent process settings`（与
`maxResidentAgentProcesses` 同一份配置），不新开配置面。

### 2.7 冷会话的 replay patches 不存，现算（可选，Phase D）

前端 `entries` 是 `Record<number, AgentMessage>`（`use-agent-session.ts:183`），
RFC 6902 `add` 作用在对象已有键上等价于 `replace`。因此回放时对每条 entry 生成一个
`addEntry` 与今天 restore 后的 `patches` 数组**逐帧相同**；只有流式尾部才存在多次
`replaceEntry`，而流式尾部的最终态就是 `entries[currentAssistantIndex]`，用一条 add
覆盖即可。结论：`store.patches` 可以整体去掉，`subscribe` 改为从 `entries` 现算。

保留为可选是因为 hub 侧 `RemotePatchCache` 用帧序列做前缀比对
（`remote-agent-sessions.ts:807` `isReplayPrefix` 一带）。今天每次 worker 重启后 restore 已经把序列压成
"每条一个 add"，所以形状没有新变化；但流式期间的 replace 帧消失会改变**同一进程
生命周期内**重连的前缀，需要单独验证一次全量重绘的代价再决定。

## 3. 契约与兼容

- 纯 worker 内部改动：没有新增或改动 `proxyToRemoteAuto` 路由、虚拟通道、帧字段。
  `reverse-connect-capabilities.ts` 不需要新条目；`classify-diff` 应归为 worker-only。
- hub 侧 `skipDb` 远端镜像会话按 I2 永远热，行为不变。
- 前端不感知：`subscribe` 回放的帧序列、`Ready`、`HistorySync` 顺序不变。
- DB schema 不变；只加两个只读查询（`getEntryMetaAll`、`getEntriesBefore`）。

## 4. 分期与交付边界

**Phase A（一个 PR，不可拆）**：§2.1 状态模型 + §2.2 冷启动 + §2.3 倒读 repair +
§2.4 `ensureHydrated` + §2.5 全部入口改造 + §5 测试。
理由：冷启动单独上线会让所有同步读入口读到空 store；`ensureHydrated` 单独上线没有
任何收益。审查意见明确要求两者同交付。

**Phase B**：§2.6 卸载 + `memory-stats` 新增字段
`agent_sessions.{total, hot, cold, hot_entries, hot_approx_bytes}`，进现有的 5 分钟
pino 行和 `/api/admin/memory-stats`。没有 B，A 只降低启动内存，不保证长期不再被
earlyoom 选中。

**Phase C**：history window 走 DB。`buildHistoryWindow` 的 head（最新下标、最后
turn_end）与窗口都可以用 `getEntriesBefore` 分页 + 一次 `turn_end` 计数查询完成，
这样打开一个冷会话的"详情 + 首屏"不需要装全量；`subscribe` 仍装全量（前端
`afterEntryIndex` 语义依赖完整回放）。可选，视 A+B 上线后打开旧会话的 P95 决定。

**Phase D**：§2.7。可选。

## 5. 测试面

新文件 `agent-session-manager.hydration.test.ts`（模式沿用 `restore-repair.test.ts`
的 in-memory storage harness）：

**启动**
- 1000 个会话 × 200 条：restore 后所有会话 `hydration === "cold"`，
  `getEntries` spy 调用次数为 0（repair 除外），`historyMeta` 与 DB 一致。
- 0 entry 行仍被跳过并计入 `boot_zero_entry_rows`。

**Crash repair（迁移 + 新增）**
- 现有 12 个用例全部迁移到倒读路径、结论不变。
- 新增：回合长度 130 条（> 两批）、开头 `origin: "workflow"` 无 disposition →
  `internal`，不产生 outbox；同样长度、开头普通 user → `result`，产生 outbox。
- 新增：无任何 `turn_end` 的会话（首轮崩溃）走到头，开头为第 0 条 user。
- 新增：`running` 行的历史**只有 system 消息**（跨两批以上）→ 不写 `turn_end`、不产生
  outbox，与今天 `landingType === null` 的结论一致。
- 新增：repair 后 `historyMeta.maxEntryIndex` 等于 repairIndex。

**装载**
- 单飞：并发 5 次 `ensureHydrated` 只触发一次 `getEntries`。
- 多个等待者 + 作废：3 个并发 `ensureHydrated` 挂在同一次 `getEntries` 上，期间
  `restartSession` 进入并停在 `deleteEntries` 未返回；放行 `getEntries`。期望：三个等待者
  全部在 `hydration === "hot"` 后才 resolve，store 是 restart 的空壳，`getEntries` 没有
  被第二次调用（空壳已同步装好，循环不再起新装载）。
- 冷会话 `subscribe` 回放帧序列与热会话逐帧相等（同一份 DB 数据）。
- 冷会话 `loadMessages` / history window / `branchSession` 源 / workflow
  `getRawMessages` 结果与热态一致。
- 冷会话 wake：喂给进程的 context 包含全部历史。
- `deleteDormantSessionIfExpired`、`discardSessionIfEmpty` 对冷会话**不触发**
  `getEntries`，且判空结论正确（有内容不删、无内容可删）。
- 同步版 `getMessages` 在冷态抛错（防回归）。

**写入 / 清空竞态（审查要求）**
- **加载中 switchAgentType**：`getEntries` 挂起 → 调 `switchAgentType` → 放行加载。
  期望：system 追加在装载**之后**（switch 内部 await 了 hydrate），store 含历史 +
  该追加，DB 一致。
- **加载中 restart**：`getEntries` 挂起 → `restartSession` → 放行加载。期望：store
  为空壳、`hydration === "hot"`、被删历史没有回流、epoch 递增。
- **加载中卸载 sweep**：sweep 不应选中 `loading` 会话；构造后放行加载，状态为 hot。
- **加载中 hibernate**：按 I1 不可能（hibernate 只作用于有进程会话），用断言测试守住。
- **加载中断连**（websocket 路由级测试）：`getEntries` 挂起时 `socket.close()`；放行后
  期望 `stopHeartbeat` 已调用、`subscribers.size === 0`、没有向已关 socket `send`、
  该会话满足卸载条件。

**卸载**
- 条件矩阵：有 subscriber / 有进程 / inflight > 0 / 未超时 各自阻止卸载。
- LRU：`maxHot = 3`，装 5 个，最旧两个被卸；再装载得到等价 store
  （`indexProvider.current()`、`toolTracker` 内容、`entries` 深比较）。
- 卸载后 `historyMeta` 与卸载前 store 一致。

**现有套件**：`pnpm --filter vibedeckx test` 全绿；`notification-recovery.integration.test.ts`
里两处 `restoreSessionsFromDb()` 之后若读历史需补 `ensureHydrated`。

## 6. 风险与边界（提前说清）

- **首次打开旧会话多一次磁盘读 + parse。** 单会话通常 < 1 MB，预计几十毫秒；超大
  会话（10 MB+）会有可感知延迟。Phase C 是为这一点准备的，不在 A 里做。
- **`getEntries` 并发峰值。** 用户批量打开多个会话时 I/O 从启动期搬到运行期。
  SQLite WAL 下读不互斥；如需限流，在 `ensureHydrated` 前加一个 8 并发的信号量即可，
  A 阶段先不加，靠 memory-stats 观察。
- **hub 前缀比对**：见 §2.7，只在 Phase D 有变化。
- **`getSession()` 的直接消费者**：Phase A 要人工审计所有 `.store` 访问点（§1.5 表
  已列全，`rg "\.store\." packages/vibedeckx/src --glob '!*.test.ts'` 复核）。任何漏网
  的同步读在冷态拿到空数组而不是报错 —— 这就是同步 `getMessages` 冷态抛错的原因，
  让漏网点在测试里炸而不是线上静默。

## 7. 与 entries 出库计划的关系

出库计划把源真相搬到 `sessions/<id>/entries.jsonl`。本文完成后，进程里读历史只剩
两个口：`ensureHydrated`（全量）和 `getEntriesBefore`（倒序分页）。出库时只需给这两个
口换后端，manager 层不再改动。反过来说，先做出库而不做本文，启动仍是 O(全部历史)，
只是从 SQLite 变成读文件 —— 本文是出库的前置，不是替代。

## 8. 验收（实施前先重测基线）

在 worker3 同一份数据上，`vibedeckx connect --daemon` 前后各测：

| 指标 | 基线（待重测） | 目标 |
|---|---|---|
| spawn → readiness | 上次 7.4 s | < 2 s |
| 启动后 5 分钟 RSS | 上次 0.9–1.1 GB | < 300 MB |
| 打开一个 1 MB 会话到 `Ready` | 未测 | P95 < 300 ms |
| Phase B 后连续运行 24 h 的 RSS 峰值 | — | 随 `maxHot` 有界，不随会话总数增长 |

达标后把 `VIBEDECKX_CONNECT_DAEMON_READY_TIMEOUT_MS` 的默认值留在 15 s 即可，不再需要
用户手工调大。
