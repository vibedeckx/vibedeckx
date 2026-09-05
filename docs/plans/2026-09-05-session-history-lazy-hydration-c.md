# Plan C: Tail-Only Store —— 内存只留活跃尾部，完整历史任何时候只在库里

**Status:** 后续演进，未实施（2026-09-05）。触发条件是「单会话正文体积失控」，
而 2026-09-05 实测本机 1385 会话中最大单会话仅 10.6 MiB（top10 都在 6–11 MiB），
所以病根是会话**数量**而非单会话大小 —— 已上线的方案 B Phase 1 覆盖了它。
B 的 `SessionHistoryReader`、`clearGeneration`、元数据启动与倒读 repair 都可被
本文直接复用；从 B 走到 C 只剩三件事（回放改「库行 + 尾部覆盖」、`endActiveTurn`
后 trim、spawn 前三步准备替代全量装载）。

与方案 A（`…-lazy-hydration.md`）、方案 B
（`…-lazy-hydration-b.md`）解决同一个问题，是第三种取舍。共用 A 的 §1（问题定义
与入口清单）、§2.2（元数据启动）、§2.3（倒读式 crash repair）、§3（契约）、§8
（验收），以及 B 的 §2.5（`SessionHistoryReader`）、§3.1 的路由侧 close 先注册、
`clearGeneration` 的定义。本文只写不同的部分。

---

## 0. 一句话

A 和 B 都保留"某些时候某些会话的完整历史在内存里"这个前提，只是争论什么时候装、
什么时候卸。C 取消这个前提：**任何会话、任何时候**，内存里只有它的活跃尾部
（正在进行的回合，外加一个 `lastUserEntry` 标量），完整历史只在 SQLite。没有冷热，没有装载，
没有卸载。收益要说准：**历史消息正文**的常驻量从 O(会话全长) 降到 O(活跃回合)；
仍随会话增长的是 `toolTracker`（每个工具调用一个短串加整数）和 reader 里 workflow
用的单条只读缓存（§2.5，最多一份完整历史）。

## 1. 三案对比

| | A 按需装载 + 卸载 | B 进程绑定 | C 尾部 store |
|---|---|---|---|
| 内存里有什么 | 被碰过且未卸载的会话的全文 | 有进程的会话的全文 | 每个会话的活跃回合 + 一个 `lastUserEntry` 标量 + 全量 tracker |
| 内存上界（消息正文） | `maxHot` × 平均会话大小 | 活进程数 × 平均会话大小 | 会话数 × 活跃回合大小（dormant 会话尾部通常只有一条 turn_end） |
| 单个超大会话（50 MB）有进程时 | 全在堆里 | 全在堆里 | 只有活跃回合在堆里 |
| 状态机 | cold / loading / hot + generation | hot 布尔 + `clearGeneration` | 无；只有 `clearGeneration` |
| 热会话打开（subscribe 回放） | 内存 | 内存 | 读库 + 尾部覆盖 |
| 热会话的其它读（brief、workflow、branch） | 内存 | 内存 | 读库 + 尾部覆盖 |
| `store.patches` | 保留（D 阶段可删） | 保留（D 阶段可删） | 不存在 |
| 流式路径改动 | 无 | 无 | **有**：所有 `store.entries[...]` 访问必须尾部安全 |
| 新增运行时配置 | 2 | 0 | 0 |
| 改动面 | 中 | 中 | 大 |

## 2. 关键决定与理由

### 2.1 `MessageStore` 变成尾部 store

```ts
interface MessageStore {
  /** 稀疏数组，但只含 tailStartIndex 之后的条目；之前的下标永远是 hole */
  entries: AgentMessage[];
  /** 尾部起点：当前回合的第一条。trim 只会让它变大 */
  tailStartIndex: number;
  /** 全量、轻量：toolUseId → entry_index，两个整数一个短串。spawn 前用 json_extract 重建（§2.2） */
  toolTracker: EntryTracker;
  indexProvider: EntryIndexProvider;
  currentAssistantIndex: number | null;
}
// 没有 patches。回放从库 + 尾部现算（§2.3）。
```

`RunningSession` 新增：

```ts
historyMeta: { entryCount; maxEntryIndex };   // 同 A/B
clearGeneration: number;                       // 同 B
/** 最近一条 user entry（含 origin / notificationDisposition），与尾部无关地保留 */
lastUserEntry: AgentMessage | undefined;
/** 每次 entries 表写入 +1（persistEntry、pushTurnEnd、restart 清空）；reader 缓存的失效键 */
writeSeq: number;
```

**没有 `hot` / `hydration`**：所有会话在结构上完全一样，dormant 会话的尾部就是它
停下时的尾部（通常只剩一条 turn_end，或 crash repair 落的那条）。

**为什么需要 `lastUserEntry` 标量，而不是靠尾部：** 回合开始时的
`findLatestUserEntry(session.store.entries)`（`:1740`）要找**最近一条 user**，穿过
`turn_end` 边界 —— 它服务两种情况：排队消息（持久化在上一条 `turn_end` 之前）和
后台任务触发的自动续跑（整个回合没有新 user，落回上一个开头）。第二种可以连续发生：
两个自动续跑回合之后，最初那条 user 早已在任何"保留 N 个回合"的尾部之外，disposition
就会默认成 `result`，reviewer 回合误发通知。任何有限尾部都堵不住这个，所以把它做成
标量：每次 `pushEntry` 一条 `user` 时更新；spawn 前从库取一次
（`… WHERE session_id=? AND json_extract(data,'$.type')='user' ORDER BY entry_index
DESC LIMIT 1`）；`:1740` 改为读这个标量。有了它，尾部只需要**当前回合**：
`findTurnOpeningUserEntry`（`:2280`，回退到本回合开头）和 `extractLastAssistantText`
（`:1573`，本回合最后一段文本）的扫描范围都在当前回合之内。

**trim 时机：** `endActiveTurn` 写完 `turn_end` 之后（`:2282` 之后），先
`await finalizeStreamingEntry(session)`，再把 `tailStartIndex` 前移到**这条**
`turn_end` 的下一格，并把之前的下标 `delete`。finalize 由 trim 自己调用，不依赖四个
调用方（`:1327`、`:1569`、`:1955`、`:2684`）各自是否已经 finalize 过 —— stop 和
process-exit 路径有（`:2672`、`:1321`），`commitCompletion` 路径（`:1569`）不能从
代码上直接看出，所以不把"尾部无未落库条目"当前提，而是由 trim 保证。重复 finalize
是幂等的（`currentAssistantIndex === null` 即 no-op）。dormant 会话的 `pushEntry`
（Stop 注记、切换 agent 注记）不 trim，也不需要：它们不开回合。

### 2.2 spawn 前的准备：三样东西，都不是全量装载

`wakeDormantSessionInner` / `switchMode` / `restartSessionInner` 的 respawn 之前：

| 需要什么 | 从哪来 | 复杂度 |
|---|---|---|
| 尾部 | 不需要装：wake / switchMode 时上一回合已结束，尾部就是空的（crash repair 已把未闭合回合落盘）。只需 `tailStartIndex = maxEntryIndex + 1` | O(1) |
| `lastUserEntry` | 一条 `json_extract(type)='user' ORDER BY entry_index DESC LIMIT 1` | O(1) 行 |
| `toolTracker` 全量 | 一条不读 `data` 全文的查询：`SELECT entry_index, json_extract(data,'$.type') t, json_extract(data,'$.toolUseId') id FROM agent_session_entries WHERE session_id=? AND t IN ('tool_use','tool_result') AND id IS NOT NULL`。SQLite 的 `json_extract` 在库内完成，Node 只收到整数和短串 | O(工具调用数)，字节数很小 |
| 喂给新进程的上下文（`buildFullConversationContext`） | `SessionHistoryReader.readAll` 一次性读、拼成字符串、发给 stdin 后丢弃。这个字符串今天就存在，是瞬时的 | O(全文)，瞬时 |

**tracker 的语义（`:1791-1840`）：** `tool_use:<id>` 和 `tool_result:<id>` 是两个
独立的 key。一条 tool_result **首次**到达时总是分配新下标（`isNew`，add），无论对应
的 tool_use 在哪个回合；只有**同一个 id 的 result 再次到达**（流式重放、重复事件）
才 replace 已有的 result 下标。result 永远不会覆盖 tool_use 的条目。

**为什么 tracker 仍要全量：** 重复事件的去重依赖 key 已登记。如果 tracker 只覆盖
尾部，一个首次到达落在已 trim 回合里的 id 再次出现时会被当成新条目，产生重复行；
tool_use 的二次 emit（`:1805`）同理。今天 restore 后 tracker 是全量的
（`:3540-3542`），C 必须保持 —— 代价只是每个工具调用一个短串加一个整数。

restart 不需要前两样（清空后没有历史），只需要 `clearGeneration++` + 尾部清空 +
meta 归零，同 B §2.4。

### 2.3 回放 = 库里的行 + 尾部覆盖

```ts
async subscribe(sessionId, ws, opts): Promise<(() => void) | null> {
  const session = this.sessions.get(sessionId); if (!session) return null;
  if (ws.readyState !== OPEN) return null;
  session.subscribers.add(ws);
  const unsubscribe = () => { session.subscribers.delete(ws); session.replaying.delete(ws); };
  for (;;) {
    const generation = session.clearGeneration;
    const held: Patch[] = [];
    session.replaying.set(ws, held);                 // 回放期间 broadcastPatch 对这个 ws 只入队，不发
    ws.send(HistorySync...); ws.send(backgroundTasksMessage...);
    const persisted = await this.reader.readAll(sessionId);          // 稀疏数组
    if (ws.readyState !== OPEN) { unsubscribe(); return null; }
    if (session.clearGeneration !== generation) { held.length = 0; continue; }   // 读库期间 restart：整段重来
    for (const [i, m] of sparseEntries(persisted)) send(addEntry(i, m));        // afterEntryIndex 过滤同今天
    for (const [i, m] of sparseEntries(session.store.entries)) send(addEntry(i, m));   // 尾部覆盖
    session.replaying.delete(ws);
    for (const p of held) send(p);                   // 回放期间的增量，按到达顺序，最后发
    ws.send(Ready); ws.send(status patch);
    return unsubscribe;
  }
}
```

`broadcastPatch` 对 `session.replaying.has(ws)` 的订阅者把帧 push 进它的 `held`
而不是 `send`。`broadcastRaw`（`HistorySync`、`finished`、`titleUpdated` 等非 patch
帧）不经过这个队列，照发。

**正确性论证（前端 `entries` 是 `Record<number, AgentMessage>`，同下标的 add 等价
replace，最后一帧赢）：** 客户端收到的顺序固定为 库行 → 尾部覆盖 → 回放期间的增量。

- 库行是读库那一刻已落库的值；尾部是内存里最新的值，覆盖同下标的库行 —— 流式中
  的 assistant 文本需要这个顺序。
- 读库期间发生的每一次写（无论落在尾部内还是尾部外，无论之后有没有被 trim）都
  作为增量帧排在最后，所以它一定赢过快照里的旧值。上一版"live 帧一定会被尾部覆盖
  修正"的论证是错的：迟到的工具结果可以更新尾部起点之前的下标（§2.4），随后被 trim
  掉，尾部里就没有东西能修正快照 —— 增量队列不依赖尾部，堵住了这个洞。
- restart 用 `clearGeneration` 处理，同 B §3.1；队列随之清空重来。

远端镜像（`skipDb`）会话没有库，`readAll` 对它返回空，回放只有尾部 —— 这是**行为
变化**：hub 上远端会话的完整回放依赖 `RemotePatchCache`（hub 侧已经缓存了全部帧），
worker 侧 skipDb 会话本来就不是回放源。需要在 `remote-agent-sessions.ts:807` 的前缀
比对测试里确认 hub 不会向 worker 请求 skipDb 会话的全量回放。

### 2.4 写路径：一条，没有分支

`pushEntry` 永远 = `indexProvider.next()` → 写尾部 → `persistEntry` → 广播。
没有冷热分支（对比 B 的双模），dormant 会话的 Stop 注记、切换 agent 注记、
hibernate 注记都走同一条路。`stageEntry` 不变。流式路径的
`session.store.entries[tuIndex] = tuMessage`（`:1801-1835`）不变 —— 这些下标来自
全量 tracker，可能落在尾部起点之前（迟到的后台结果）；写入一个 `tailStartIndex`
之前的下标是允许的，它只是让尾部多一个孤立条目，下次 trim 会清掉，而库里的更新
是持久的。正在回放的订阅者靠 §2.3 的增量队列拿到这次更新，不靠尾部。

### 2.5 读入口：全部读库，再叠尾部

`SessionHistoryReader`（B §2.5）之上加一层叠加：

```ts
async loadRawMessages(id): Promise<AgentMessage[]> {
  const rows = await this.reader.readAll(id);                 // 稀疏
  const s = this.sessions.get(id);
  if (s) for (const [i, m] of sparseEntries(s.store.entries)) rows[i] = m;
  return rows;
}
loadMessages = loadRawMessages 后 filter(Boolean)
loadHistoryWindow = loadRawMessages 后 buildHistoryWindow（Phase C 换分页 + 只叠窗口内的尾部）
```

**热会话也读库。** 这是 C 与 A/B 最大的行为差异：workflow-engine 在源会话每个事件
上读一次（`:1205`）、review brief、branch 源，都会打到库。SQLite WAL 读不阻塞写，
一次 1 MB 读 + parse 在几十毫秒量级；但 workflow 那条是高频路径，Phase A 要给它
加一个单条只读缓存，放在 reader 内部，失效键是 `(sessionId, clearGeneration, writeSeq)`。
**不能用 `maxEntryIndex`**：同一下标的更新（流式 assistant 的 finalize、重复
tool_result 的 replace）不改变它，restart 后长度相同的两段历史也区分不开；而这些更新
的旧值一旦被缓存、又被 trim 出尾部，叠加就修不回来。`writeSeq` 在 entries 表的每一
次写入处 +1：`persistEntry`（`:2203`，流式与 pushEntry 的唯一落库点）、
`upsertTurnEndWithOutbox`、branch 复制、restart 清空。

四处 `store.entries.some(Boolean)` 判空改 `historyMeta.entryCount > 0`（同 A/B）。
`extractLastAssistantText`（`:1573`）、`findTurnOpeningUserEntry`（`:2280`）只看
当前回合，尾部按 §2.1 的定义正好覆盖 —— 不需要改。`findLatestUserEntry`（`:1740`）
改为读 `session.lastUserEntry`（§2.1），它是唯一一处需要穿过回合边界的读。

同步的 `getMessages` / `getRawMessages` **删除**，不是保留抛错：C 下没有任何状态能
让它们返回完整历史，留着就是陷阱。

### 2.6 启动

同 A §2.2：一条聚合查询建 meta，所有会话 `tailStartIndex = maxEntryIndex + 1`、
尾部为空。`running` 行走倒读 crash repair（A §2.3），repair 写的 `turn_end` 进 meta，
不进尾部。dormant 会话的尾部为空是安全的：它的下一次写要么是不开回合的注记，要么
是 wake（wake 前按 §2.2 装尾部）。

## 3. 入口改法（相对 B 的增量）

| 入口 | C 的改法 |
|---|---|
| `subscribe` | §2.3：库 + 尾部覆盖，无论有没有进程 |
| `getMessages` / `getRawMessages` 及全部调用点 | 删同步版；调用点改 `loadMessages` / `loadRawMessages` / `loadHistoryWindow`（同 B，但热会话也走这里） |
| `rebuildStoreFromRows` | 拆成两个：`buildTail(rows)`（只收尾部）和 `buildToolTracker(ids)`（json_extract 结果） |
| `endActiveTurn` | turn_end 落库后 trim（§2.1） |
| `restartSessionInner` | 同 B §2.4，少了 `hot = true` |
| `branchSession` | 源 `loadRawMessages`；目标会话写库后只建 meta + 空尾部，与启动恢复的会话一模一样 |
| `switchAgentType` / `stopSession` / `hibernateSession` | 不改：`pushEntry` 单一路径 |
| `wakeDormantSessionInner` / `switchMode` | spawn 前 §2.2 的准备（tracker、`lastUserEntry`、context 字符串），替代 `buildFullConversationContext(session.store.entries)` |
| `broadcastPatch` | 对 `replaying` 中的订阅者入队而不发（§2.3） |
| `persistEntry` / `pushTurnEnd` / branch 复制 / restart 清空 | `writeSeq++` |
| `deleteDormantSessionIfExpired` / `discardSessionIfEmpty` / `isModelChangeTooLate` / `switchAgentType` 的 busy 判定 | `historyMeta.entryCount` |

## 4. 分期

**Phase A（一个 PR，比 B 的 Phase A 大）**：元数据启动 + 倒读 repair + 尾部 store +
trim + spawn 前三步 + 库 + 尾部回放 + reader 与叠加门面 + workflow 单条缓存 +
全部入口改造 + §5 测试。不能拆：删掉 `patches` 和同步读的那一刻，回放和所有读就必须
走库。

**Phase C（可选）**：`loadHistoryWindow` 分页 + 只叠窗口内尾部。

没有 Phase B（卸载随结构消失）、没有 Phase D（`patches` 一开始就不存在）。

`memory-stats` 新增 `agent_sessions.{total, tail_entries, tail_approx_bytes,
tracker_keys}`。

## 5. 测试面（相对 A/B 的增量）

启动与 crash repair 同 A §5；restart / 断连 / 读库中 restart 的竞态同 B §5。C 特有：

**尾部边界与 disposition**
- 回合 N 结束后，尾部为空（`tailStartIndex = turn_end 下标 + 1`）；回合 N+1 的第一
  条写入后尾部只含它；`historyMeta` 不变。
- 排队消息：user 消息持久化在回合 N 的 `turn_end` 之前，回合 N+1 的 `turn_started`
  到达 → disposition 取自它（`lastUserEntry`）。
- **连续自动续跑**：`origin: "workflow"` 的 user 开回合 N；N 结束后后台任务触发续跑
  N+1（无新 user），再触发 N+2 → N+1 和 N+2 的 `turnDisposition` 都是 `internal`，
  不产生 outbox。这个用例在"保留上一回合"的尾部模型下会失败，是改成标量的直接依据。
- wake 后 `lastUserEntry` 等于库里最后一条 user；restart 后为 undefined。
- 迟到的后台 tool_result（首次）：tool_use 在回合 N，result 在回合 N+1 → **分配新
  下标**，tool_use 的条目不变；同一 id 的 result 再次到达 → replace 首次分配的那个
  下标。两种都断言库里的行与广播下标一致。
- 尾部之前的下标被迟到写入后，下次 trim 清掉，库里保留更新值。

**回放**
- 流式中的会话 subscribe：库里 assistant 行是旧快照、尾部是新文本 → 客户端最终
  值是新文本；帧顺序为库行 → 尾部覆盖 → Ready。
- 回放期间收到 live 帧：客户端帧序为 库行 → 尾部 → 增量 → Ready；最终 Record 与
  无并发时相同。
- **读库中更新旧工具条目并 trim**：`readAll` 挂起 → 迟到 result 写到尾部之前的下标
  并广播 → 回合结束 trim → 放行。期望客户端该下标的终值是更新后的值（来自增量队列），
  不是快照里的旧值。
- 回放期间 `broadcastRaw` 帧（`titleUpdated`）不被队列延迟。
- dormant 会话 subscribe：帧序列与今天 restore 后回放 `store.patches` 逐帧相等。

**spawn 前准备**
- wake 后 tracker 含全部历史工具 id；尾部含上一个完成回合的全部条目且不含更早的；
  喂给 stdin 的 context 与今天 `buildFullConversationContext` 的输出逐字节相等。

**读**
- 热会话 `loadRawMessages` 与库行 + 尾部叠加一致。
- workflow 单条缓存：同一下标 replace（重复 tool_result、finalize）后失效；restart 后
  重新写到相同 `maxEntryIndex` 时失效（`clearGeneration` 不同）；无写入时命中。
- 同步 `getMessages` 已不存在（类型层面）。

## 6. 风险与边界

- **改动面最大。** 流式路径、回合结束、spawn 前准备、回放四块核心都动。A/B 不碰
  流式路径。
- **热会话每次读都打库。** 对 workflow 高频读靠单条缓存；对其它读接受几十毫秒。
- **回放正确性依赖"最后一帧赢"。** 前端 `Record` 语义今天成立；如果将来前端改成
  数组或按帧序号去重，§2.3 的论证失效。要在 `use-agent-session.ts` 加一条注释和
  测试钉住。
- **skipDb 会话的回放来源变化**（§2.3 末尾）。Phase A 必须先跑
  `remote-agent-sessions` 的前缀比对测试确认 hub 不依赖 worker 侧 skipDb 会话回放。
- **json_extract 依赖 SQLite JSON1。** `better-sqlite3` 自带的 SQLite 默认启用；
  出库计划（entries 到 jsonl 文件）落地后这条查询要换成扫文件建索引，是 reader
  内部的事。

## 7. 三案怎么选

三份方案不是三选一的平行选项，而是一条演进线：

```
B（进程绑定）  ──►  C（尾部 store）
      ▲
      │ 如果反复打开旧会话的延迟被证明不可接受，再在 reader 里加只读缓存
      │（这就是 A 的缓存部分，但不需要 A 的状态机）
      A
```

**推荐先上 B**，理由同 B §7：不变式可断言、上界第一天成立、不碰流式路径、没有
新配置。B 的 `SessionHistoryReader`、`clearGeneration`、路由侧 close 先注册、
元数据启动、倒读 repair 全部被 C 复用；从 B 到 C 只剩三件事 —— 热会话回放改成
库 + 尾部、`endActiveTurn` 后 trim、spawn 前用三步准备替代全量装载。

**什么时候直接上 C**：有证据表明单个会话的**消息正文**体积失控 —— 例如某个有进程
的 50 MB 会话本身就把 worker 顶到 earlyoom 阈值（tracker 和 reader 缓存不在 C 的
收益范围内，见 §0）。目前 A §1.4 的数字是 1311 个会话合计
410 MB，平均 300 KB，最大值未测；测出最大会话体积是决定 B 还是 C 的那个数字。

**什么时候需要 A 的缓存**：B 或 C 上线后，打开旧会话的 P95 超过 300 ms 且分页
（Phase C）救不回来。缓存加在 reader 内部，A 的三态状态机永远不需要。
