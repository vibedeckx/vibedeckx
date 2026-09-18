# Phase 2 第一刀：Review 闭环（循环复审）

> 日期：2026-09-18 · 分支：dev1 · 状态：**设计稿 v1，待用户确认后出实施计划**
> 上游：主 spec [`2026-07-17-workflow-engine-review-loop-design.md`](./2026-07-17-workflow-engine-review-loop-design.md) §3.2b / §6；
> 前置（已实现）：[`2026-09-18-workflow-phase2-prereq-dispatch-identity-design.md`](./2026-09-18-workflow-phase2-prereq-dispatch-identity-design.md)。
> 所有 file:line 以 dev1 @ 2d2a20fb 为准。

---

## 0. 目标与范围

把今天的手摇循环——"review → 反馈回投 → source 修 → 再点一次 Continue last reviewer →
……"——变成引擎驱动的闭环：**source 完成反馈那一轮后，引擎自己把下一轮复审的闸门
摆出来**；reviewer 的结论被解析成三值，决定闸门的默认动作；轮次有上限，到顶升级给人。
**每一跳仍由用户确认，没有自动模式**（主 spec §1.3 信任基线不变）。

第一刀**只做闭环**。不做（留给第二刀）：
- 输入框 chip / 斜杠选择器、`commands.kind`、模板定义 JSON、参数表单；
- 草案里"循环从给 implementer 派任务开始"的形态——第一刀的循环**从一次 review 开始**
  （今天的发起入口），因为"从任务开始"属于唤起与模板化；
- reviewer 不可复用时自动换新 reviewer（§5.3）；
- 循环历史 / 轮次回放 UI。

## 1. 核心决定：一轮一个 run，闸门也是 run

两种形状：

| | A. 一轮一个 run + `loop_id` 串联（**采用**） | B. 一个 run 跨多轮 |
|---|---|---|
| 现有 run 生命周期 | 不变：每轮仍是 `… → waiting_feedback → sending_feedback → completed` | `completed` 的含义要改，"反馈已发送"不再是终点 |
| 依赖"completed = 一次完成的 review"的代码 | 不动（`getLatestCompletedBySource`、`listReviewedSourceSessions`、reviewer candidate、hub `remoteRunMap` 终态逐出、`reviewReadyId`） | 全部要重新审视 |
| 面板 / 传输 | 复用：`getActive` 列表、`workflow:run-updated`、远程 run 映射原样可用 | 需要新的轮次视图 |
| 讨论态 | 每轮 run 内部照旧 `waiting_feedback ⇄ discussing` | 要并进大状态机 |
| 代价 | 多一个"闸门态"的 run；轮次信息分散在多行 | 状态机重写 |

采用 A。**下一轮的闸门就是下一轮的 run**：引擎在领取 feedback 步骤时创建它，状态为新的
`waiting_rereview`（"source 已改完，是否发起第 N 轮复审"）。用户确认 → 走**现有的复用
reviewer 路径**（`rereview_prompt` 派发）→ 之后与今天的一轮 review 完全相同。
主 spec §3.2b 的五处必改项由此全部落到现成机制上：三值 verdict（§3）、两段式起点
（第 1 轮就是今天的发起流程，原样）、讨论进循环（每轮 run 内部已有）、reviewer 跨轮复用
（现成的 reuse 路径）、implementer 侧派发后自动 claim（前置里的 feedback 步骤领取）。

## 2. 数据模型（全部加法）

`workflow_runs` 新增四列：

```sql
loop_id     TEXT,                 -- 循环身份 = 第 1 轮 run 的 id；NULL = 单程 review（今天的行为）
round       INTEGER NOT NULL DEFAULT 1,   -- 循环轮次（注意：workflow_run_steps.round 是 run 内的派发轮次，两者无关）
max_rounds  INTEGER,              -- 仅循环 run 有值
verdict     TEXT                  -- 'ship' | 'needs-changes' | 'cannot-verify' | NULL(未识别/尚无结论)
```

新状态 `waiting_rereview` 加入 `WorkflowRunStatus` 与 `WORKFLOW_ACTIVE_STATUSES`
（`storage/workflow-run-status.ts:13`）。它是活跃态，所以 source 在闸门期间仍是该 run 的参与者（同一 source 不能再另起一次
review，须先结束循环——与"一个 session 同时只在一个活跃 run 里"的现有约束一致）。
闸门行的 `reviewer_session_id` 为空（§4），reviewer 在闸门期间**不是**参与者：可以照常
和它对话，其完成事件也不被抑制；它只会被同一 source 的复审再次占用，而那条路已被上面的
约束挡住。

迁移按 `storage/sqlite.ts:2056-2067` 的 `PRAGMA table_info` 幂等模式。旧行 `loop_id` 为空，
行为不变。

**先前列为前置的"意图简报 / context mode / reviewer agent 类型落到 run 行"——第一刀不做。**
它只在"换一个新 reviewer 重新开审"时才需要（新 reviewer 要重建 prompt）；第一刀的后续轮次
只走复用路径，reviewer 自带前几轮上下文，`buildRereviewerPrompt` 也不读简报。等做 §5.3 的
"换新 reviewer"时一并补。这是对我上一条消息说法的修正。

## 3. Verdict 解析

`VERDICT_INSTRUCTIONS`（`workflow-engine.ts:243-251`）要求 reviewer 以
"Verdict — exactly one of: ship / needs-changes / cannot-verify" 收尾。今天只是 prompt 措辞，
没有任何解析。真机样本（2026-09-18 e2e 与一次实际 review）：

```
1. **Verdict：** ship
1. **Verdict — needs-changes**
```

`parseVerdict(text): "ship" | "needs-changes" | "cannot-verify" | null`：
1. 自下而上找**最后一行**含 `verdict`（不分大小写）的行；
2. 去掉 markdown 标记后，在该行（该行没有则取其后第一个非空行）里找三个词；
3. **恰好命中一个**才算数；一个都没有、或同一处出现多个（reviewer 把选项原样抄了一遍）
   → `null`。

宁可 `null` 也不猜：`null` 与 `cannot-verify` 在流程上同等对待——**交给人**，闸门不给
任何 verdict 驱动的默认动作，只是显示"未识别结论"。

写入时机：reviewer 侧步骤被领取时（`claimStep`，`workflow-engine.ts` 的 reviewer 分支），
`verdict` 与 `feedback_snapshot` 同一个事务写入 run。讨论后的终稿会重新解析并覆盖。
**对所有 run 生效**（不只循环）：单程 review 也显示结论徽标，代价为零。

## 4. 状态机

```
第 1 轮（今天的发起流程，原样；仅多带 loop 参数）
  start(loop: { maxRounds })  → run{loop_id = id, round = 1, max_rounds}
  … → waiting_reviewer → [reviewer 完成：解析 verdict] → waiting_feedback
        ⇅ discussing（照旧）

waiting_feedback 的闸门（按 verdict）：
  needs-changes / cannot-verify / null
      approve（可编辑）→ sending_feedback → completed        ← 今天的行为
      cancel            → cancelled（循环结束）
  ship
      accept            → completed，不发送任何东西（循环结束）          ← 新动作
      approve           → 仍可把 non-blocking notes 发给 source → completed；**不再排下一轮**
      cancel            → cancelled

source 完成反馈那一轮（feedback 步骤被领取，前置 §2.6 / §7-10）：
  若 run.loop_id 非空 且 run.verdict !== 'ship'
      → 同一事务内创建下一轮 run：
          { loop_id, round: N+1, max_rounds, status: waiting_rereview,
            source_session_id, reviewer_session_id: NULL, review_focus, review_span: 'this_turn',
            source_turn_end_index: 该反馈 turn 的 turn_end }
        （意向 reviewer = 上一轮的 reviewer，从 loop 的上一轮 run 读，不落在闸门行上——
          `prepareAdhocReview` 把"已有 reviewer_session_id"解释为"已绑定，直接返回"）

waiting_rereview 的闸门：
  round <= max_rounds
      rereview          → 复用路径：switchMode(plan) 保障 → rereview_prompt 派发 → waiting_reviewer
      cancel            → cancelled（循环结束）
  round >  max_rounds   （升级：已达上限）
      rereview{extend:true} → max_rounds = round，其余同上
      cancel            → cancelled
```

要点：
- **创建下一轮与领取 feedback 步骤同事务**：`claimStepAndTransition` 增加可选的 `nextRun`
  插入。崩溃不会出现"步骤领了、下一轮闸门没出来"；重启对账的迟到领取走同一条路径，
  同样会把闸门补出来。
- `rereview` 时**重新取 source 最新的已完成 turn**作为被审对象（现有复用路径在未指定
  `sourceTurnEndIndex` 时就是这么做的）：用户在闸门期间又和 source 聊了几轮，审的应当是
  他现在看到的状态。source 正在运行 → 409 `source-running`（现有守卫）；reviewer 正在
  运行 → 409 `session-busy`（前置的空闲派发规则）。
- 复用路径的派发逻辑目前内联在 `prepareAdhocReview` 里（`workflow-engine.ts` reuse 分支）。
  抽成 `dispatchRereview(run, reviewerSessionId, project)`，发起入口与 `rereview` 闸门共用。
- 通知：**不新增里程碑种类**。反馈 turn 的处置是 `result`（`FEEDBACK_TURN`），source 完成
  时本来就会响一次 `session_result_ready`，点进去就是 source 会话，面板上正是下一轮闸门。

## 5. 边界情况

### 5.1 循环静默结束的情形（第一刀接受）

下一轮闸门只在 feedback 步骤**被领取**时出现，即 source 正常完成了由反馈开的那个 turn。
以下情形步骤不会被领取，循环就此停下，不报错：source 那一轮失败 / 被用户 Stop；服务在
那一轮中途重启（对账按 `server_restart` 作废）。用户的出路是今天就有的手动入口
"Continue last reviewer"。mid-turn 插话不影响（开 turn 的仍是反馈 entry）。

### 5.2 闸门期间的其他动作

| 情况 | 处理 |
|---|---|
| 用户给 source 发消息 | 无动作（同今天）；`rereview` 时取最新 turn |
| 用户给 reviewer 发消息 | 无动作：闸门期间 reviewer 不是参与者（§2）。若此时 reviewer 正在回复，`rereview` 得到 409 `session-busy`，等它完成再点 |
| 对 source 另起一次 review | 409 `session-busy`，须先结束循环 |
| 重启 | `waiting_rereview` 无在途派发，`init()` 只需重建参与者 |

### 5.3 reviewer 不可复用

`getReviewerCandidate` 的不可用原因（`deleted / project-mismatch / branch-mismatch /
unsupported-agent / running / busy / unavailable`）在闸门上原样展示。`running` 是暂时的
（稍后再点）；其余情况第一刀**只能结束循环**，再手动发起一次新的 review。
"换新 reviewer 继续循环"需要把简报 / context mode / agent 类型落到 run 行（§2），第二刀做。

### 5.4 blind 模式

blind 只对 fresh reviewer 有意义（现有约束：blind 不能与复用同用）。循环的第 1 轮可以是
blind；后续轮次走复用路径，而 `buildRereviewerPrompt` 会带上 author self-report——那正是
source 对反馈逐条交代的内容，复审需要它。**决定**：blind 只作用于第 1 轮，后续轮次照常带
self-report；发起弹窗里同时勾了 blind 与循环时注明这一点。

## 6. API（加法）

- `POST /api/workflow-runs` 与 `POST /api/path/workflow-runs/prepare` 的 body 增加
  `loop?: { maxRounds: number }`（1..10，默认 3；缺省 = 单程）。
- `POST /api/workflow-runs/:id/gate` 的 `action` 增加 `accept`、`rereview`（body 可带
  `extend?: boolean`）。
- run DTO 多出四个字段（§2）。`mapRemoteRun` 是展开拷贝，hub 无需改映射。

**兼容**：没有新路由、没有新虚拟通道 → capability 注册表无变化。
- 新 hub + 旧 worker：worker 忽略 `loop` → 得到单程 review。hub 从返回的 run 上
  `loop_id` 为空即可得知，UI 提示"该 worker 版本不支持循环复审"。
- 旧 hub + 新 worker：旧 hub 从不传 `loop`，循环 run 不会出现。
- worker 自发创建的下一轮 run：hub 经参与者会话流上的 `workflowRunUpdated` 帧得知
  （`remote-agent-sessions.ts:1038`，映射不依赖预先登记），面板随后刷新活跃列表时登记进
  `remoteRunMap`。**需在实施时实测**：闸门动作打到 hub 时该 run 已可解析（`resolveRemoteRun`）。

## 7. UI

- **发起弹窗**：开关"循环复审"+ 上限（默认 3）。reviewer 为"Continue last reviewer"时同样可开。
- **面板 `waiting_feedback`**：结论徽标（ship / needs-changes / cannot-verify / 未识别）；
  循环 run 显示"第 N / M 轮"。`ship` 时主按钮是"接受并结束"，"仍发送反馈"降为次要。
- **面板 `waiting_rereview`**："source 已按反馈完成修改" + 「发起第 N 轮复审」「结束循环」；
  超上限时改为"已达上限 M 轮" + 「再加一轮」「结束循环」；reviewer 不可用时显示原因并禁用复审。
- 过期点击解释（`review-run-panel.tsx` 的 `explain…`）补上新状态与新动作的文案。

## 8. 测试

- `parseVerdict`：两条真机样本、全角/半角冒号、破折号、粗体、选项被原样抄写 → null、
  正文中途提到 "verdict" 但结尾另有结论 → 取最后一处、无结论 → null。
- 引擎：循环 run 的 `needs-changes` → approve → source 完成 → 同事务出现第 2 轮闸门；
  `ship` → accept 完成且不派发；`ship` + approve 不排下一轮；非循环 run 永不产生闸门；
  `rereview` 走复用派发并记 `rereview_prompt` 步骤；上限 → 需 `extend`；reviewer 不可用各原因；
  闸门期间对 source 另起 review → 409；重启对账的迟到领取同样产出闸门；`cancel` 结束循环。
- 存储：`claimStepAndTransition` 带 `nextRun` 的原子性（任一 CAS 落空则不插入）。
- 路由：新 action 校验、`loop` 参数校验、远程代理透传。
- 前端：弹窗开关、徽标、ship 的主次按钮、`waiting_rereview` 三种形态。
- 真机 e2e（本地）：needs-changes → 修 → 复审 → ship → accept；上限升级；闸门态下重启。

## 9. 实施顺序

| # | 任务 | 范围 |
|---|---|---|
| L1 | 存储：四列 + `waiting_rereview` + `claimStepAndTransition.nextRun` + patch 支持 `verdict` | worker |
| L2 | `parseVerdict` + 领取时写入 | worker |
| L3 | 引擎：发起带 `loop`；feedback 领取时创建下一轮闸门；参与者与 `init()` | worker |
| L4 | 引擎：`accept` / `rereview(extend)`；抽出 `dispatchRereview`；reviewer 不可用的错误码 | worker |
| L5 | 路由 + hub 代理：`loop` 参数、新 action；旧 worker 降级提示 | hub + worker |
| L6 | 前端：弹窗、徽标、轮次、两种新闸门 | 前端 |
| L7 | 真机 e2e + 主 spec §3.2b / §4 / §5 / §6 同步 | — |

## 10. 需要拍板的点

1. **一轮一个 run + 闸门 run**（§1）——采用 A。
2. **`ship` 之后不再排下一轮**，即使用户选择把 notes 发给 source（§4）。
3. **后续轮次只走复用 reviewer**；reviewer 不可用时只能结束循环，"换新 reviewer"与
   "简报落 run 行"一起放第二刀（§2、§5.3）。
4. **上限默认 3、范围 1..10**；到顶后每次"再加一轮"只加 1。
5. **source 那一轮失败 / 被 Stop 时循环静默停下**，不另做提示（§5.1）。
