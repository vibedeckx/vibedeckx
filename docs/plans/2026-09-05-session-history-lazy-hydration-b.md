# Plan B: Process-Bound Hydration —— 热态就是进程生命周期，其余一律读库

**Status:** **Phase 1 已实施**（见文末「实施记录」）。方案 A 与方案 C 未实施，
分别记为「被取代」与「后续演进」。与 `2026-09-05-session-history-lazy-hydration.md`
（下称**方案 A**）解决同一个问题，是它的替代而不是补充。两者共用 A 的 §1（问题
定义与入口清单）、§2.2（元数据启动）、§2.3（倒读式 crash repair）、§3（契约）和
§8（验收），本文不重复；只写不同的部分和取舍。

---

## 0. 一句话

历史只在**有进程**的那段时间住在内存里。进程一退出，store 就丢；没有进程的会话
（dormant 的、死掉的、刚启动恢复的）任何读历史都直接查 SQLite，任何写历史都直接
追加到 SQLite。没有 LRU、没有卸载定时器，因为"什么时候装、什么时候卸"不再是策略，而是进程的生死
本身。唯一保留的计数器是 `clearGeneration`，只有 restart 会递增它（§2.4）。

## 1. 与方案 A 的根本差异

| | 方案 A（按需装载 + 有界卸载） | 方案 B（进程绑定） |
|---|---|---|
| 热态定义 | 任何入口第一次碰到就装，装完留着，靠 sweeper 卸 | `hot ⇔ process !== null ∨ skipDb`，写在类型和断言里 |
| 冷会话的读 | 装成热再读（第一次慢，之后快） | 每次读库（每次一样慢，可预期） |
| 冷会话的写（stopSession / switchAgentType 的 system 注记） | 先装载再 pushEntry | `pushEntry` 冷分支：写库 + 更新 meta + 广播，不装载 |
| 卸载时机 | 定时器 + `maxHot` 上限 + 五个空闲条件 | 进程 close 处理链的末尾、stopSession / hibernate / switchAgentType 的末尾 |
| 需要防的竞态 | 装载中 restart、装载中卸载、多等待者复查 | 装载中 restart（wake / subscribe 两个观察者）、冷写与装载交错（§2.4、§3.3） |
| 内存上界 | `maxHot` × 平均会话大小 | 活进程数 × 平均会话大小，活进程数已由 `maxResidentAgentProcesses` 按 scope 限制 |
| 新增运行时配置 | `idleMs`、`maxHot` | 无 |
| 打开旧会话 P95 | 第一次读库，之后内存 | 每次读库 |
| 与 entries 出库计划的接缝 | `ensureHydrated` + `getEntriesBefore` | `SessionHistoryReader` 一个模块 |

一句话总结取舍：A 用一个缓存换"反复打开同一个旧会话更快"，代价是缓存必须有失效、
上界、并发三套规则；B 认为这个缓存没有被证明需要，先不建，需要时可以在
`SessionHistoryReader` 里面加而不动 manager。

## 2. 关键决定与理由

### 2.1 状态：两态，不是三态

`RunningSession` 新增：

```ts
/** 冷态也有效；热态由 stageEntry / finalizeStreamingEntry 同步维护 */
historyMeta: { entryCount: number; maxEntryIndex: number };
/** 热态：store 与已落库 entry 一致（同 epoch）。冷态：store 是空壳。 */
hot: boolean;
/** 装载单飞；只在 spawn 前的那一段存在 */
hydrating: Promise<void> | null;
/** restart 在第一个 await 之前同步 +1；装载与冷回放用它判断"我拿到的快照还算数吗" */
clearGeneration: number;
```

不变式（**在断言点成立**，不是任意时刻的等价式）：

- **B1** `process !== null ⇒ hot`。断言点：`spawnAgent` 入口、`stageEntry` 入口。
  装载完成到 spawn 之间会话是"热但无进程"，进程退出到卸载之间是"无进程但仍热"，
  这两个窗口都在持有 `processStartsInFlight` 或运行在 `eventChain` 上，外部观察不到
  半成品。所有流式写路径（stdout 解析链、`stageEntry`、`finalizeStreamingEntry`）
  保持同步，不加 await。
- **B2** `skipDb ⇒ hot`，永不卸。
- **B3** `hot ⇒ store` 与**已落库** entry 一致（同 epoch）。未 finalize 的流式文本和
  `persistEntry` 失败留下的孤行是今天就有的偏差，本文不改变。
- **B4** `!hot ⇒ store` 是空壳：`entries = []`、`patches = []`、toolTracker 空、
  `indexProvider.setIndex(historyMeta.maxEntryIndex + 1)`、`currentAssistantIndex = null`。

没有 "loading" 态：装载只发生在 spawn 之前，而 spawn 路径（wake / switchMode /
restart 的 respawn）本来就持有 `processStartsInFlight`，retention 和 hibernate 已经
把它当"有人在用"。`hydrating` 只是单飞句柄，不是状态。

### 2.2 装载：只在 spawn 之前，只为进程服务

```ts
/** 抛出即表示这次 spawn 操作（wake / switchMode）已被 restart 作废，调用方不得继续。 */
private async hydrateForSpawn(session: RunningSession): Promise<void> {
  const generation = session.clearGeneration;           // 操作有效性，独立于 hot
  if (!session.hot) {
    if (!session.hydrating) {
      session.hydrating = this.runSerialForResult(session, async () => {   // 与冷写串行，见 §3.3
        if (session.hot) return;
        const g = session.clearGeneration;
        const rows = await this.storage.agentSessions.getEntries(session.id);
        if (session.clearGeneration !== g || session.hot) return;          // restart 抢先清空了
        const store = this.rebuildStoreFromRows(rows, session.id);
        session.store = store;
        session.historyMeta = metaFromStore(store);
        session.hot = true;
      }).finally(() => { session.hydrating = null; });
    }
    await session.hydrating;
  }
  if (session.clearGeneration !== generation) {
    throw new SpawnSupersededError(session.id);          // 不看 hot：restart 后 hot 恰好为 true
  }
}
```

两个校验是两件事：内层的 `g` 决定**快照能不能装**；外层的 `generation` 决定**这次
操作还算不算数**。上一版用 `!hot` 兼任第二件事是错的 —— restart 同步装好热的空壳后
`hot === true`，旧 wake 会照常 spawn、追加 user entry，与 restart 的 respawn 抢同
一个会话。`SpawnSupersededError` 在 `wakeDormantSession` / `switchMode` 的 finally
释放 `processStartsInFlight` 后向上冒，路由层映射为 409。

装载跑在 `eventChain` 上不会拖慢流式：冷会话没有 stdout 事件，链是空的。

调用点只有两个，全在 `spawnAgent` 之前：`wakeDormantSessionInner`（`:3456` 之后，
`ensureResidentCapacity` 之前）、`switchMode`（`:3262` 之后）。`restartSessionInner`
不装载：它清库后直接装热的空壳（§2.4）。`branchSession` 的目标会话以冷态入表
（§3.3），首次 wake 才经过这里。

装载失败（DB 错误）让 spawn 失败，与今天 `resolveSessionWorktreePath` 失败同一条
错误路径；不会出现"进程起来了但上下文是空的"。

### 2.3 卸载：进程生命周期的四个出口

卸载 = `historyMeta = metaFromStore(store)`；store 置空壳；`hot = false`。前提断言：
`process === null`、`currentAssistantIndex === null`、无 grace / park timer。不检查
`subscribers`、不检查空闲时间：订阅者拿的是 patch 流，不是 store 引用，store 没了
他们不受影响（§3.1）。

| 出口 | 位置 | 卸载放在哪 |
|---|---|---|
| 进程自然退出 | `childProcess.on("close")` 链（`:1271`） | `endActiveTurn` 和状态广播之后、链的最后一步。链在 `eventChain` 上串行，stdout 的尾巴已经处理完 |
| `stopSession` | `:2648` | 现有收尾之后；对本来就冷的会话（恢复后 Stop、重复 Stop）卸载是 no-op |
| `hibernateSession` | `:2772` | 它 kill 后还 `pushEntry` 一条 system 注记（`:2791`），卸载放在那之后 |
| `switchAgentType`（有进程分支） | `:3069` | 同上，system 注记之后 |

`restartSession` 和 `switchMode` 杀旧进程后立刻 respawn，中间不卸（respawn 需要
store；restart 需要的是空壳）。

**死而不休眠的会话**（进程退出、`dormant === false`、status stopped/error）今天保留
store 但下次 `reuseExistingSession` 会 restart 并清空（`:1116-1118`）。B 下它是
冷的，restart 不需要 store，行为不变。这里**不**顺手把它改成 dormant —— 那是另一个
产品决定（"进程崩了要不要保留上下文继续"），不混进来。

### 2.4 竞态之一：装载中 restart（另一个是冷写与装载交错，见 §3.3）

`restartSessionInner` 在第一个 `await` 之前同步做四件事：`clearGeneration++`、
kill 进程、store 置空壳并 `hot = true`、`historyMeta` 归零；然后才 `deleteEntries` +
`incrementHistoryEpoch`。**不能用 `historyEpoch` 当失效信号**：它的内存值在
`await incrementHistoryEpoch()` 之后才更新，restart 同步部分结束到那之间有一个窗口，
装载和回放在窗口内完成会看到旧 epoch。`clearGeneration` 就是为了堵这个窗口才存在。

两个观察者各自处理：

- **wake / switchMode**（§2.2）：`hydrateForSpawn` 抛 `SpawnSupersededError`，操作
  终止，不 spawn、不写 user entry。今天两者交错时 wake 会继续 spawn 并与 restart 的
  respawn 抢 `session.process`，B 把这个既有竞态一并关掉。
- **cold subscribe**（§3.1）：读库前记 `clearGeneration`，读完不等就整段重放。

`beginProcessStart` 是计数不是互斥（`RunningSession.processStartsInFlight` 注释明说
"wake overlapping a restart"），所以这不是理论场景。

### 2.5 `SessionHistoryReader`：冷会话的所有读走这里

新模块 `session-history-reader.ts`，构造参数只有 `storage`，无状态：

```ts
readAll(sessionId): Promise<AgentMessage[]>              // 稀疏数组，index = entry_index
readWindow(sessionId, epoch, { before?, turns? }): Promise<SessionHistoryWindow>
readHead(sessionId, epoch): Promise<SessionHistoryHead>
readTail(sessionId, limit): Promise<AgentMessage[]>       // 倒读 crash repair 也用它
```

Phase 1 里 `readWindow` / `readHead` 的实现就是 `readAll` + 现有 `buildHistoryWindow`
/ `historyHead`（正确优先）；Phase 2 换成 `getEntriesBefore` 分页 + 一次
`count(type='turn_end')`，签名不变。

manager 提供统一门面，**调用方不关心冷热**：

```ts
async loadMessages(sessionId): Promise<AgentMessage[]>      // hot → store.entries.filter(Boolean)；cold → reader.readAll
async loadRawMessages(sessionId): Promise<AgentMessage[]>   // hot → store.entries；cold → reader.readAll
async loadHistoryWindow(sessionId, opts)                    // hot → buildHistoryWindow(store)；cold → reader.readWindow
```

同步的 `getMessages` / `getRawMessages` 保留，**冷态抛错**（漏网的同步读在测试里
炸，不在线上静默返回空数组）。

## 3. 入口改法（对照方案 A §1.5 的清单）

### 3.1 `subscribe()`：先登记，再回放

```ts
async subscribe(sessionId, ws, opts): Promise<(() => void) | null> {
  const session = this.sessions.get(sessionId); if (!session) return null;
  if (ws.readyState !== OPEN) return null;
  session.subscribers.add(ws);                                   // 先登记：期间的 live patch 不会漏
  const unsubscribe = () => session.subscribers.delete(ws);
  for (;;) {
    const generation = session.clearGeneration;
    ws.send(HistorySync...); ws.send(backgroundTasksMessage...);
    const patches = session.hot
      ? session.store.patches                                    // 同步，无 await，同今天
      : (await this.reader.readAll(sessionId)).flatMap((m, i) => m ? [ConversationPatch.addEntry(i, m)] : []);
    if (ws.readyState !== OPEN) { unsubscribe(); return null; }  // 读库期间关了页
    if (session.clearGeneration !== generation) continue;        // 读库期间 restart 了：快照作废，整段重来
    for (const patch of patches) { /* afterEntryIndex 过滤同今天 */ ws.send(...); }
    ws.send(Ready); ws.send(status patch);
    return unsubscribe;
  }
}
```

**先登记再读库为什么安全：** 冷会话在读库期间可能发生的写分三类。

- wake 追加的 user entry、冷态 `pushEntry` 的 system 注记（§3.3）：index 都是
  `maxIndex + 1`，在快照范围之外，live 帧与回放帧不会命中同一个 index。
- restart：客户端已经收到 restart 广播的 `HistorySync{reset}` + `clearAll`，再收到旧
  快照的 add 就会让已删历史复活。`clearGeneration` 变了就丢弃快照、重发
  `HistorySync` 并重读 —— 第二轮读到的是清空后的库（restart 的 `deleteEntries` 可能
  还没返回，但 `hot` 已同步为 true，第二轮走热分支拿到空壳，不会再碰库）。
- 上面两类以外没有别的冷写路径（§3.3 的表是穷举）。

热会话回放的是 `store.patches`，同今天，没有 await。

**路由侧**（`websocket-routes.ts:494-521`）：`close` 处理必须在 `await subscribe`
之前注册 —— `let unsubscribe = null; socket.on("close", () => { stopHeartbeat();
unsubscribe?.(); }); unsubscribe = await subscribe(...)`。今天它在 subscribe 返回后
才挂，读库期间关页会漏掉心跳清理、把死 socket 留在 `subscribers` 里。

远端镜像（`skipDb`）会话永远热，hub 侧 `RemotePatchCache` 看到的帧序列不变
（`remote-agent-sessions.ts:807` 的前缀比对不受影响）。

### 3.2 读入口

| 入口 | 改法 |
|---|---|
| `agent-session-routes.ts` 的 `getMessages` / `getRawMessages` / `buildHistoryWindow` 十余处 | 改 `await loadMessages` / `loadRawMessages` / `loadHistoryWindow` |
| `workflow-engine.ts:880/1131/1205`；`shared-services.ts:461` 的 `agentOps.getRawMessages` | 签名改 async；三处调用点本来就在 async 函数里 |
| `workflow-run-routes.ts:396`、`project-chat-tools.ts:1284`、`chat-session-manager.ts:1531` | 改 async 门面 |
| `buildFullConversationContext(session.store.entries)`（`:3322`、`:3494`） | 前面已 `hydrateForSpawn`，按 B1 热 |
| `extractLastAssistantText`、`findTurnOpeningUserEntry`、`findLatestUserEntry` | 都在有进程路径，按 B1 热，加 `assertHot` |
| 四处 `store.entries.some(Boolean)` 判空（`:2931`、`:3074`、`:3245`、`:1098`） | 改 `historyMeta.entryCount > 0`；retention / discard **永不触发读库** |

### 3.3 写入口

| 入口 | 改法 |
|---|---|
| `stageEntry` | 开头 `assertHot(session)`。它的直接调用者只有 stdout 流式路径和 `pushEntry` 的热分支 |
| `pushEntry` | **双模**：热 → 今天的 `stageEntry` + `persistEntry` + 广播；冷 → 走 `runSerialForResult(session, …)`：`index = indexProvider.next()`（B4 保证它等于 `historyMeta.maxEntryIndex + 1`）→ `upsertEntry` → `historyMeta` 前进 → `broadcastPatch(addEntry(index, msg))`。不建 store。调用方不感知冷热 —— 这比上一版"给 switchAgentType 单独一个 appendColdEntry"覆盖面更完整 |
| `stopSession`（`:2648`） | 今天允许停一个 dormant 会话，并无条件 `pushEntry` 一条 "Session stopped by user."（`:2676`），再 `endActiveTurn`。B 下 `pushEntry` 冷分支处理该注记；`endActiveTurn` 对冷会话 `turnOpenSince === null`（回合边界由 crash repair 落盘）所以不写 turn_end；`finalizeStreamingEntry` 在 `currentAssistantIndex === null` 时是 no-op。恢复后 Stop、重复 Stop 都不需要装载。测试见 §5 |
| `switchAgentType` 的 dormant 分支（`:3114`） | 同上，`pushEntry` 冷分支 |
| `hibernateSession`、`switchAgentType` 的有进程分支 | 先 `pushEntry`（此时仍热），再卸载（§2.3） |
| `restartSessionInner` | 见 §2.4；respawn 后热的空壳 |
| `branchSession`（`:3827`，目标构造在 `:3986-3998`） | 源会话 `loadRawMessages`（冷则读库）。目标会话今天 `process: null, dormant: true` 却带着 rebuild 出来的热 store —— 不 wake 就永远不经过四个卸载出口，复制的全文会常驻。B 下：把 rows 写库后目标会话以**冷态**入表（`historyMeta` 直接从 rows 算，store 空壳，`hot = false`），首次 wake 再装载。`agent-session-routes.ts:345` 紧接着 `getMessages(newSessionId)` 回给前端，改成用 branch 刚构建的 entries 数组返回，不读库、不装载 |

**冷写与装载的串行：** 冷 `pushEntry` 和 `hydrateForSpawn`（§2.2）都跑在同一个
会话的 `eventChain` 上。否则会出现：装载已经 `getEntries` 拿到快照 → 冷写追加一条
system 注记 → 装载安装旧快照，store 和从 store 重算的 `historyMeta` 都少了那条注记。
共享 index 分配器只能避免撞号，不能避免这种遗漏。串行之后，冷写要么排在装载之前
（快照包含它），要么排在之后（此时 `hot === true`，`pushEntry` 走热分支进 store）。
冷会话的 `eventChain` 没有 stdout 事件，这个串行不影响任何流式路径。

## 4. 分期

（本文的阶段用数字编号，避免与方案 A/B/C 的字母撞名。）

**Phase 1（一个 PR，不可拆）**：元数据启动（A §2.2）+ 倒读 repair（A §2.3）+
两态模型 + `hydrateForSpawn` + 四个卸载出口 + `SessionHistoryReader` +
`pushEntry` 双模 + 全部入口改造 + §5 测试。

与方案 A 不同，**B 没有单独的卸载阶段**（方案 A 的 Phase B）：卸载随 Phase 1 一起到位，长期运行的内存上界从第
一天就成立。

**Phase 2（可选，对应方案 A 的 Phase C）**：`readWindow` / `readHead` 走分页查询，不再 `readAll`。触发条件：
打开冷会话 P95 超过 A §8 的 300 ms。

**Phase 3（可选，对应方案 A 的 Phase D）**：热会话也从 `entries` 现算回放帧、删掉 `store.patches`。与
A §2.7 相同，前置条件也相同（验证 hub 前缀比对的重绘代价）。

`memory-stats` 新增 `agent_sessions.{total, hot, hot_entries, hot_approx_bytes}`，
随 Phase 1 一起进现有的 5 分钟 pino 行。

## 5. 测试面

启动与 crash repair 用例与方案 A §5 完全相同（含"只有 system 消息不修复"、
"开头落在第一批之外判 internal"）。以下是 B 特有的：

**不变式**
- 每次 `spawnAgent` 之后 `hot === true`；每个卸载出口之后 `hot === false` 且
  `store.entries.length === 0`，`historyMeta` 等于卸载前 store 的统计。
- 冷态调用同步 `getMessages` / `pushEntry` 抛错。

**冷会话读**
- `loadMessages` / `loadRawMessages` / `loadHistoryWindow` 对冷会话的结果与同一
  数据热态下逐项相等。
- retention / discard 对冷会话不触发 `getEntries`，判空结论正确。
- 冷会话 `subscribe` 回放帧序列与今天 restore 后的 `store.patches` 逐帧相等。

**冷会话写**
- dormant 会话 `switchAgentType`：DB 多一行、index 正确、广播了一帧、`hot` 仍为
  false、`historyMeta` 前进一格；随后 wake，第一条 user entry 的 index 紧接其后。
- 恢复后（冷）`stopSession`、以及连续两次 `stopSession`：不抛、不触发 `getEntries`，
  每次 DB 多一条 system 注记，status 为 stopped，`dormant === true`。
- `branchSession` 后**不** wake：目标会话 `hot === false`、store 为空壳、
  `historyMeta` 与写入的 rows 一致；路由返回的 messages 与源会话截断结果相等；随后
  wake 装载出的 store 与今天 rebuild 的产物逐项相等。

**竞态**
- **装载中 restart**：`getEntries` 挂起 → `restartSession` → 放行。期望 wake 抛
  `SpawnSupersededError`、**没有第二次 spawn、没有写入 user entry**（spy
  `spawnAgent` 和 `upsertEntry`）、`processStartsInFlight` 回到 0、store 为 restart
  的空壳、`getEntries` 未被第二次调用。断言必须落在 spawn / 写入上，不能只看
  `hot` —— restart 后 `hot` 恰好为 true。
- **订阅读库中 restart**：冷会话 `subscribe`，`readAll` 挂起 → `restartSession` →
  放行。期望客户端收到的帧序列是 `HistorySync` → （restart 的 `HistorySync{reset}` +
  `clearAll`）→ 第二轮 `HistorySync` → `Ready`，**没有任何旧 index 的 add 帧**。
- **冷写与装载交错**：wake 的 `getEntries` 挂起 → `switchAgentType`（冷写）→ 放行。
  期望冷写排在装载之后走热分支，最终 store 含该注记，`historyMeta` 与 DB 一致；
  反向顺序（冷写先完成）快照包含它。两种顺序都断言 DB 行数 = store 条数。
- **读库期间断连**（路由级）：`readAll` 挂起时 `socket.close()`；放行后心跳已停、
  `subscribers.size === 0`、没有向已关 socket `send`。
- **读库期间 wake**：subscribe 的 `readAll` 挂起时另一个客户端发消息触发 wake；
  放行后订阅者收到回放 + wake 的 user entry，且没有重复 index。
- **hibernate 后再 wake**：卸载 → 装载 → context 完整、`indexProvider` 续接。

**现有套件**：`pnpm --filter vibedeckx test` 全绿；`notification-recovery.integration.test.ts`
里 `restoreSessionsFromDb()` 之后的历史读改走 `loadMessages`。

## 6. 风险与边界

- **反复打开同一个旧会话每次都读库。** 这是 B 主动接受的代价。SQLite WAL 下一次
  1 MB 的 `getEntries` + parse 在几十毫秒量级；超过 A §8 的 300 ms 目标时上 Phase 2，
  而不是加缓存。如果数据证明缓存必要，加在 `SessionHistoryReader` 内部（带 TTL 的
  只读 LRU），manager 不感知。
- **workflow-engine 高频读源会话。** `:1205` 在每个 session 事件上读一次源会话。源
  会话产生事件说明它有进程，按 B1 是热的，不会打到库。用 `assertHot` 兜住。
- **热态内存上界是"活进程数"。** `maxResidentAgentProcesses` 按 (project, branch)
  scope 限制，不是全局上限；多个分支各自满员时热会话数 = scope 数 × 上限。这与今天
  进程本身的内存上界是同一个数，本文不新增全局上限。
- **`getSession()` 的直接消费者。** 路由只读 `status / agentType / model /
  permissionMode`（已核对），不碰 store。Phase 1 仍要用
  `rg "\.store\." packages/vibedeckx/src --glob '!*.test.ts'` 复核一遍。

## 7. 推荐

**推荐 B。** 理由按权重：

1. **不变式能写成一行断言。** `hot ⇔ process !== null ∨ skipDb` 可以在 `spawnAgent`
   出口和四个卸载出口各放一个 `assertHot` / `assertCold`，违反立刻炸。A 的
   "cold / loading / hot + generation + epoch" 需要靠测试矩阵守。
2. **长期内存上界第一天就成立。** 方案 A 要等它的 Phase B。
3. **没有新配置。** A 的 `idleMs` / `maxHot` 是两个要解释给操作者的旋钮。B 保留
   的 `clearGeneration` 是内部计数，只有 restart 递增，不暴露、不调参。
4. **缓存是可以后加的，状态机是很难后删的。** 如果 B 上线后数据说明"反复打开旧会
   话"真的慢，缓存加在 reader 里是纯优化；反过来 A 上线后想去掉 sweeper 要动
   manager。

选 A 的唯一理由是：已经有证据表明用户会在短时间内反复打开同一批旧会话、且每次读库
的延迟不可接受。目前没有这个证据（A §1.4 的数字都是启动和常驻内存，没有一个是
打开延迟）。


---

## 8. 实施记录（Phase 1）

Phase 1 已落地，实现与本文的差异如下（都是实现时才看得见的细节，不是设计变更）：

**新增 / 改动的文件**

| 文件 | 内容 |
|---|---|
| `storage/types.ts`、`storage/repositories/agent-sessions.ts` | 两个只读查询：`getEntryMetaAll`（全库一次 `count/max GROUP BY`，不读 `data`）、`getEntriesBefore`（倒序分页） |
| `session-history-reader.ts`（新） | `readAll` / `readDense` / `readWindow` / `readHead` / `readBefore`。无状态，Phase 2 只需换这一个文件的实现 |
| `agent-session-manager.ts` | 两态模型、`hydrateForSpawn`、`unloadHistory`、`pushEntry` 双模、倒读 repair、`load*` 门面、`hydrationStats` |
| `routes/websocket-routes.ts` | `close` 处理提前到 `await subscribe` 之前注册 |
| `routes/agent-session-routes.ts`、`routes/workflow-run-routes.ts`、`workflow-engine.ts`、`project-chat-tools.ts`、`chat-session-manager.ts`、`plugins/shared-services.ts` | 读历史改走 async 门面 |
| `memory-stats.ts` | `agent_sessions.{total, hot, cold, hot_entries}` |
| `agent-session-manager.hydration.test.ts`（新）、`__fixtures__/entry-meta-mock.ts`（新） | §5 测试面 + 各 harness 共用的两个派生查询 |

**与设计文本的偏差**

1. **判空不用 `historyMeta.entryCount`，而用 `hasHistory(session)`：** 热态读
   store，冷态读元数据。原因是热态下 `historyMeta` 要精确，就得在
   `toolTracker.getOrCreate` 等一批绕开 `stageEntry` 的流式分配点同步维护，
   等于新增一条散落十几处的不变式。热态 store 本来就是权威，`historyMeta`
   只需要在被读的时刻正确 —— 而那些时刻全是冷态。
2. **`pushTurnEnd` 也做了双模。** §3.3 假定冷会话不会写 turn_end
   （`turnOpenSince === null`），但 `hibernateSession` 不调用 `endActiveTurn`
   就卸载，于是「休眠后再 Stop」会在冷态走到 `stageEntry` 并触发 `assertHot`。
   `endActiveTurn` 的 disposition 兜底同样加了冷态分支（从库读开头的 user）。
3. **多了第五个卸载出口：`setModel` 退休空闲进程那一支。** 它和
   `switchAgentType` 形状相同，不卸载会让改过模型的会话一直钉住历史。
4. **`branchSession` 通过返回值把刚复制的 transcript 交给路由**
   （`BranchResult.messages`），而不是让路由回头读库。
5. **`subscribe` 的重试循环加了 5 次上界**，纯兜底：restart 之后第二轮走热态
   空壳、无 await，正常路径最多两轮。
6. **`memory-stats` 不报 `hot_approx_bytes`。** 估算字节意味着每 5 分钟把这套
   设计刚腾空的堆再序列化一遍；`hot_entries` 是同一条曲线的免费代理。
7. **`hydrateForSpawn` 到 `spawnAgent` 之间这段窗口要两头堵**（本文 §2.1 只把它
   描述成「外部观察不到半成品」，实现时发现两个方向都会漏）：
   - **别人卸载**：wake 在 `ensureResidentCapacity` 上挂起时，会话仍是
     dormant/stopped，`switchAgentType` 因此不判 busy，照常执行并在末尾卸载 ——
     wake 醒来后 spawn 出一个 `hot === false` 的进程，上下文回放为空、第一条流式
     entry 在 `stageEntry` 抛错。修法：`unloadHistory` 增加
     `processStartsInFlight > 0` 守卫。这个计数器本来就是「有人已承诺 spawn」的
     同步标记（`beginProcessStart`），只是原先没人在卸载侧读它。
   - **自己失败**：`ensureResidentCapacity` 在满员且无可休眠候选时会抛
     `ResidentProcessLimitError`，而 hydrate 已经完成。没有失败清理的话，每一次
     被拒绝的 send 都把一份历史永久留在堆里 —— 四个卸载点全都挂在「进程消失」上，
     而这里进程从未出现。修法：`unloadIfSpawnAbandoned`（无进程且无在途 start 才
     卸），放在 `wakeDormantSession` 的 finally 里 `release()` 之后；`switchMode`
     同样(它先杀进程再 respawn)，为此拆出 `switchModeInner`。
   - **两条 spawn 路径都要认领**：`switchMode` 原先不调 `beginProcessStart`，
     于是上面那个守卫对它无效 —— 暂停它的 `updatePermissionMode` 再插入
     `switchAgentType`，同样能 spawn 出 `hot === false` 的进程。现在它和 wake /
     restart 一样在第一个 await 之前认领，被 retention 占用时返回 `false`
     （两个调用方 —— 路由与 workflow-engine —— 本来就把 `false` 当失败处理）。
     顺带关掉了同一个 retention 竞态：sweep 不能在 switchMode 挂起时删掉行、
     让它随后 spawn 出孤儿进程。
   - **认领必须在第一个 `await` 之前，不是「在改状态之前」**：第一版把
     `beginProcessStart` 放在 `resolveSessionWorktreePath` 之后，于是 retention
     可以在这次 checkout 查询期间跑完 —— 删行、移出 map、清掉自己的
     `retentionDeleting` 标记 —— 之后认领照样成功，switchMode 便为一个已不在
     `sessions` 里的对象 spawn 进程。`processStartsInFlight` 的字段注释写的就是
     "SYNCHRONOUSLY before the operation's first `await`"，wake 与 restart 都是
     这么做的（checkout 解析放在 inner 里），只有 switchMode 是例外。现在认领在
     最前，checkout 解析挪进 `try` 的第一行 —— 「校验不通过就什么都没改」这条
     原意不变。
   三条都有回归测试，断言落在 spawn 时刻的 `hot` 和拒绝后的 `hot`/`historyMeta`
   上，且都走公开方法（`sendUserMessage` / `switchMode` / `switchAgentType`），
   不是直接调私有 hydrate。
8. **冷追加不能排在 `eventChain` 上 —— 会把会话永久锁死。** §3.3 给冷追加加了
   串行化，实现时挂在了会话的 `eventChain` 上，理由写的是「冷会话没有进程，因此
   链上没有 stdout 工作」。这个前提被卸载本身打破了：Stop / hibernate /
   切 agent / 切 model 都在链外执行，一个已经在链上跑到一半、正 `await` 落库的
   stdout 任务，恢复时会话已经冷了，它的追加于是走冷分支 —— 从链内往链上排队，
   等的正是自己。链就此永久卡死；而 `hydrateForSpawn` 当时也排在同一条链上，
   所以这个会话**再也无法被唤醒**。

   两处修法，缺一不可（各有回归测试，去掉任一条对应测试即挂）：
   - **冷追加与 hydration 改用独立的 `historyChain`。** 它们本来就只需要互斥
     （§3.3 要防的是「读快照 → 冷追加 → 装快照」丢写），不需要和 stdout 工作
     互斥，所以给它们一条自己的单槽队列即可，结构上不可能与事件链互等。
   - **卸载排到在途链上工作之后。** `unloadHistory` 发现 `chainPending > 0` 就把
     自己 `enqueueSessionWork` 到链尾（跑的是 `unloadHistoryNow`，否则会看见
     自己排的队而无限推迟），让已经在跑的任务用它开始时的那个 store 收尾。
     光有这条不够：Stop 之后进程仍可能吐出缓冲的 stdout，排在卸载任务**之后**
     的工作照样会在冷态下追加 —— 那一半靠上面的 `historyChain` 兜。

**验收（2026-09-05，本机 `~/.vibedeckx/data.sqlite` 的只读副本，1391 会话 /
275k entry / 474 MiB 正文；一次性 `--data-dir` 抛弃式服务，未碰线上 worker。
启动为 5 次冷启动，打开延迟为每档 12 次采样）**

| 指标 | 结果 | A §8 目标 | 判定 |
|---|---|---|---|
| 旧恢复循环（读 + parse + 建 store） | 5.54 s / 903 MB heap / 1059 MB RSS | — | 基线 |
| 启动 → 接受第一个请求 | 2.59 / 2.80 / **2.98** / 3.05 / 3.27 s（中位 2.98） | < 2 s | ❌ **未达标** |
| 启动后空闲 RSS | 232–233 MB（5/5 次） | < 300 MB | ✅ |
| 打开会话到 `Ready`（中位大小 100 KiB / 17 条） | 中位 8 ms（7–20） | P95 < 300 ms | ✅ |
| 打开会话到 `Ready`（p90 大小 830 KiB / 322 条） | 中位 29 ms（20–48） | P95 < 300 ms | ✅ |
| 打开**最大**会话（10.6 MiB / 1990 条） | 中位 **410 ms**（316–473） | P95 < 300 ms | ❌ 仅最大档超标 |
| history-window（最大会话，5 turns） | 中位 117 ms（100–177） | — | — |
| 连开 10 个最大会话后静置 RSS | 500 MB → 206 MB | 读不驻留 | ✅ |

**启动为什么没达标。**（这一段是 2026-09-05 第二次测的结果，直接给
`restoreSessionsFromDb` 打点，**推翻了第一版按查询耗时相加的估算**：那次算出
「懒加载只占 ~160 ms」，实际是 ~950 ms。）

| 阶段 | 耗时 | 在 `restoreSessionsFromDb` 里吗 |
|---|---|---|
| `node` 启动 + 解析 10 MB esbuild bundle（`--help` 实测，完全不碰 DB） | 1.05–1.20 s | 否 |
| **`restoreSessionsFromDb` 全程** | **833–1041 ms（三次）** | — |
| ├ 逐会话 `getActivityById(id, "runtime")` × 1391 | **≈ 500 ms** | 是 |
| ├ 逐会话 `updateStatusPreservingTimestamp` × 1391 | **≈ 155 ms** | 是 |
| ├ `getEntryMetaAll` + `getAll` 各一次 | ≈ 148 ms | 是 |
| └ 建 1391 个 `RunningSession` + checkout 查询 + repair | ≈ 150 ms | 是 |
| 迁移 + 其余插件 + 294 条路由注册 + listen | 余量 | 否 |

**修正结论：restore 占启动的 40–45%，不是 5%。** 但注意构成 —— 大头是**逐会话的
两次 DB 往返**（一次 activity 投影 JOIN、一次状态写，各 1391 次），这两件事本次
没有改动，只是在把 entries 读取拿掉之后，它们成了剩下的主要成本。真正属于懒加载
新增的只有 `getEntryMetaAll` 的 106 ms。

所以「继续做懒加载也没用」这句仍然成立，但理由变了：要把启动压到 2 s 以内，最直接
的一刀是**把这两个逐会话往返批量化**（一条 `id IN (...)` 的投影查询 + 一条批量
`UPDATE ... WHERE id IN (...)`），预计能省 ~650 ms；其次才是 bundle 解析那 1.1 s。
批量化会碰 `observeLocalActivity` 的逐行遥测和 dangling-binding 记录语义，属于
另一件有独立评审面的事，本次不做。

需要说清的是：这条目标没达成**不影响本改动要解决的问题**。原始故障是 15 s 的
daemon readiness 硬超时叠加 earlyoom 选杀，2.98 s 对 15 s 有 5 倍余量，而常驻内存
从 1.06 GB 降到 232 MB 正是让 worker 不再是 badness 最高进程的那一步。

**决定（用户，2026-09-05）：放宽本条验收，Phase 1 不因它阻塞。**

`< 2 s` 出自方案 A §8，是写方案时把整段启动都算在懒加载头上定的数字，从来不是产品
约束。真实约束是 daemon 的 15 s readiness 硬超时（且已可用 `--readiness-timeout`
调），2.98 s 对它有 5 倍余量。本改动要解决的两件事都达标：常驻 RSS 1.06 GB → 232 MB
（earlyoom 选杀的根因），启动不再读任何 transcript。

因此本条改判为 **⚠️ 已知未达原目标，不阻塞交付**，验收表首行的 ❌ 按此理解。

**留作后续（未排期）：** 把 restore 里的两个逐会话往返批量化（一条
`id IN (...)` 的 activity 投影 + 一条批量 `UPDATE`），预计 ≈650 ms；它们不是本次
引入的，只是拿掉 entries 读取后成了剩余成本的大头，且会碰 `observeLocalActivity`
的逐行遥测与 dangling-binding 记录语义，有独立评审面。再往下才是 bundle 解析的
≈1.1 s。

**最大会话打开超标**正好命中本文 §4 给 Phase 2 定义的触发条件（打开冷会话
P95 > 300 ms）。但只有体积分布的最尾端超标：p90 会话 29 ms，中位 8 ms。是否值得
为 1/1391 的会话上分页查询，留给实际使用数据决定。

「旧恢复循环」一行是在同一份副本上单独复算旧 `restoreSessionsFromDb` 内层循环的
结果（逐会话 `getEntries` → 逐条 `JSON.parse` → entries + patches），不是旧版服务
的端到端计时。`EXPLAIN QUERY PLAN` 确认两条新查询都走
`sqlite_autoindex_agent_session_entries_1`（聚合是 covering index scan，不读
`data` 列）。

**仍未做**:启动时间达标(见上表拆解,不属于懒加载);worker3 实机复测;
`--readiness-timeout` 默认值是否可以留在 15 s。
