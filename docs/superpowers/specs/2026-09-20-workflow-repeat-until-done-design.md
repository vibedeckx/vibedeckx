# Workflow 模板二：Repeat-until-done（Ralph loop）

> 日期：2026-09-20 · 分支：dev1 · 状态：**v1.1 已确认并实现（2026-09-20，dev1，R1–R7）**，实现记录见 §11；原：v1.1 已确认——引擎留在 worker（团队自己干、干完上报；谁推进流程谁必须有可靠的完成信号）；
> **remote worker 是主要目标，不是后补的一刀**；§9 其余各点按推荐。实施计划：`../plans/2026-09-20-workflow-repeat-until-done.md`
> 上游：主 spec [`2026-07-17-workflow-engine-review-loop-design.md`](./2026-07-17-workflow-engine-review-loop-design.md)；
> 底座（已在 main、worker v0.3.41）：投递身份 [`2026-09-18-workflow-phase2-prereq-dispatch-identity-design.md`](./2026-09-18-workflow-phase2-prereq-dispatch-identity-design.md)、
> review 闭环 [`2026-09-18-workflow-phase2-review-loop-cut1-design.md`](./2026-09-18-workflow-phase2-review-loop-cut1-design.md)。
> 所有 file:line 以 main @ 141b798f 为准。

---

## 0. 要解决什么

"从一堆待办里一个个做完，每个新开一个 session，做完就停，直到全部完成"——Ralph loop。
用户已定的三点（2026-09-20）：

1. **任务来源要比仓库文件还灵活**：可能是调一个 API、取未处理项、处理掉，直到没有未处理项。
2. **完成判定用固定输出字段**，类似 review 的 verdict。
3. **迭代之间不经确认自动推进，出错才停。**

第 1 点决定了整个形态：**引擎不持有任务列表**。待办的真相在外部世界（API、文件、issue 列表、数据库），
每个 session 自己去查"下一个未处理项是什么"。引擎只负责：重复同一条指令、每次一个新 session、
读结尾的状态字段决定继续还是停、到刹车条件就停。这正是 Ralph 的原始形态，也是它的关键性质：

> **状态在世界里，不在 agent 的记忆里。** 每个 session 无状态，崩溃/中断后下一个 session 重新查询即可接上。

代价要写明：引擎不知道"共几项、还剩几项"（进度只能由 agent 自报，§3）；"处理了但没来得及标记"的项会被
下一个 session 重复处理——**处理动作的幂等性是 prompt 作者的责任**（例如先标记 in-progress 再处理），
引擎解决不了，发起弹窗里要有这句提示。

非目标：引擎持有的任务列表（`tasks` 表 / 贴进来的清单，逐项注入 `{{item}}`）——它是本模板的一个特例，
需要时再加一种"来源"，第一版不做；并行多 session；与 review 模板串联（§8）。

## 1. 形态：一次迭代一个 run，沿用 review 闭环的链式结构

与 review 闭环同构（该设计 §1 的论证原样适用）：**一次迭代 = 一个 run，`loop_id` 串联**；上一迭代的完成
被领取时，在**同一个事务**里创建下一迭代的 run。不引入独立的 loop 实体、任务队列或常驻调度器；
所有状态在数据库里，重启后由 `init()` 对账接上。

与 review 闭环的两处不同：
- **正常推进没有闸门。** `continue` 时下一迭代的 run 创建后立即派发，不等用户确认（用户已定第 3 点）；
  只有需要人介入时才出现闸门（§5.1）。
- **run 需要"种类"。** 今天 `workflow_runs` 的每一行都隐含是 review。新增 `kind` 列区分。

## 2. 数据模型（全部加法）

`workflow_runs` 新列：
- `kind TEXT NOT NULL DEFAULT 'review'`：`review | repeat`。引擎按 kind 分派处理函数，review 路径零改动。
- `params TEXT`（JSON，仅 `repeat`）：`{ prompt, agentType, model?, maxIterations, maxMinutes, checkCommand? }`。
  每个迭代的 run 都带一份（从上一行复制），这样任何一行都自足，不必回查第 1 行。
- `outcome_status TEXT`：本迭代解析出的状态字段（§3），与 review 的 `verdict` 平行。不复用 `verdict` 列——
  词汇不同，混在一列里会让每个读取方都要先看 kind。

复用已有列：`loop_id`（= 第 1 个迭代的 run id）、`round`（迭代序号）、`max_rounds`（= maxIterations，
面板的"第 N / M 次"直接可用）、`source_session_id`（本迭代的 session；对 `repeat` 来说"source"就是干活的
session）、`feedback_snapshot`（本迭代最后一段回复，面板展示用）、`error`。
`reviewer_session_id` / `review_*` 对 `repeat` 恒为空。

`repeat` run 的状态：复用 `preparing`（run 已建、session 未激活）与 `completed | cancelled | failed`，
**新增两个活跃态：`running_task`**（session 正在做这一迭代）**与 `waiting_resume`**（停下等人的闸门，§5.1）。不借用 `waiting_reviewer`——名字对 `repeat`
是误导，而且前端和对账代码里到处按这个状态名假定"有 reviewer"。
完整迁移：`[waiting_resume →] preparing → running_task → completed`；任一步 → `failed` / `cancelled`。

`workflow_run_steps` 新 kind：`task_prompt`（role 复用 `source`）。首条指令走 lifecycle 的 prepare/activate，
键 = activationKey，与 `reviewer_prompt` 完全同构（不造第二套 claim）。

`SessionPurpose` 新值 `workflow_task`；owner 复用 `{kind: "workflow_run", id}`。

## 3. 完成判定：结尾状态字段，完整匹配

引擎在用户 prompt 后面追加固定的收尾说明（同 `VERDICT_INSTRUCTIONS` 的做法）：

```
End your final message with these lines:
Status: <exactly one of: continue / done / blocked>
  continue — you completed one item and more remain (or may remain)
  done     — you checked, and there is nothing left to process
  blocked  — you could not complete an item and need a human
Item: <one short line identifying what you processed; omit for done>
Remaining: <number, if you know it; otherwise omit>
```

`parseTaskStatus` 复用 `utils/review-verdict.ts` 的规整 + **完整匹配**纪律（把 `parseVerdict` 的内核
抽成 `parseClosingField(text, label, values)`，两边共用）：最后一处 `Status` 行胜出；不是三个值之一 → `null`。

| 解析结果 | 引擎动作 |
|---|---|
| `continue` | 停掉本 session → 刹车检查（§5）→ 同事务创建下一迭代并立即派发 |
| `done` | 停掉本 session → 循环完成，发一条完成通知 |
| `blocked` | 建闸门停下等人（§5.1），**不停 session**（用户多半要进去看、接着聊） |
| `null`（没写/写错） | 同 `blocked`：宁可停下也不猜 |

**两种误判的代价不对称，决定了默认行为：**
- 误判为 `continue`：多开一个 session，它查一遍发现没事可做、报 `done`。自愈，代价是一次空转。
- 误判为 `done`：循环提前结束，剩下的项没人处理，**而且看起来是成功**。

所以 `done` 是要设防的那个。第一版的设防手段是完整匹配（`not done yet` → `null` → 停下等人）。
"`done` 由下一个新 session 复核一次"是更强的设防，代价是每个循环固定多一次空转；**作为可选参数
`confirmDone`，默认关**，试用后再看要不要默认开。

`Item` 与 `Remaining` 不参与控制流，只用于面板展示和 §5 的无进展检测；缺失不算错。

## 4. 一次迭代的生命周期

```
发起（POST /api/workflow-runs { kind: "repeat", … }）
  → create run(kind=repeat, round=1, loop_id=self, status=preparing)
  → steps.open(task_prompt) → lifecycle.prepare(purpose=workflow_task, owner=run, permissionMode=edit)
  → setFinalSessionTitle("<循环名> #1") → lifecycle.activate(key = task:<runId>, instruction = prompt + 收尾说明)
  → CAS preparing → running_task

session:taskCompleted（按投递身份归属到 task_prompt 步骤——现有 claim 规则原样适用）
  → status = parseTaskStatus(最后一段回复)
  → [可选] checkCommand 在 worktree 里跑一次；非零退出 → 视同 blocked，error 记下输出尾部
  → 同一事务：claim 步骤 + run → completed(outcome_status, feedback_snapshot)
               + INSERT 下一迭代 run(round+1, params 复制)：continue 且未触刹车 → preparing；
                 需要人 → waiting_resume + error；done → 不插入
  → stopSession(本迭代 session)                     ← 事务之后；失败只记日志（§6）
  → 有下一迭代 → 走上面"prepare → activate"那一段
```

要点：
- **session 以 edit 模式起**（无人值守必须；对应 `--dangerously-skip-permissions`）。发起弹窗要明示。
- **迭代 turn 的通知处置为 `milestone-managed`**：50 次迭代不能响 50 次铃。循环只在**完成或需要人时**发
  里程碑（`loop_done` / `workflow_failed`），id = `workflow:<loopId>:round:<round>:<reason>`，写在锚点 session 的
  outbox 上（§7）。
- **指挥官抑制**：`shouldSuppressAgentEvent` 今天只认 reviewer 角色；扩为"reviewer，或 kind=repeat 的 run 的
  source"。否则每次迭代完成都会唤醒 Main Chat 的模型。
- **占用**：同一 (project, branch) 同时只允许一个活跃的 `repeat` 循环（发起时查 `getActive`）。迭代的 session
  是引擎新建的，不存在与 review 抢 session 的问题；但用户可以对某个已停的迭代 session 手动发起 review，互不影响。

## 5. 停下来：刹车、停止语义、继续

### 5.1 "停下等人"也是一个 run（与 review 闭环同一手法）

循环需要人介入时，引擎在领取事务里照常插入下一迭代的 run，但状态不是 `preparing` 而是新的活跃态
**`waiting_resume`**，`error` 写明原因。它就是面板上的闸门：`resume` → 走 §4 的 prepare/activate；
`cancel` → 循环结束。好处同 review 闭环：面板、列表、远程映射、重启保留全部现成；"循环停在哪、为什么"
有一行可查，不会静默消失。

| 情形 | 结果 |
|---|---|
| `Status: continue`，未触刹车 | 下一迭代 `preparing`，立即派发 |
| `Status: done` | 不建下一迭代；循环完成；里程碑 `loop_done` |
| `blocked` / 解析不出 / `checkCommand` 失败 | 闸门 `waiting_resume`；**不停本 session**；里程碑 `workflow_failed`（"needs attention"） |
| 迭代上限 `round >= max_rounds`（默认 20，1..200） | 闸门；`resume` 时上限 += 原 `maxIterations` |
| 时长上限（自第 1 迭代起 `maxMinutes`，默认 240） | 闸门；`resume` 时时长窗口从此刻重算 |
| 无进展：连续两迭代 `Item` 非空且相同 | 闸门 |
| 软停：用户点了"做完这项后停" | 闸门（原因"已按要求暂停"），不发里程碑（人就在场） |
| turn 非正常结束（见 5.3） | 闸门 |
| 被重启打断（`reconcileOpenSteps`） | 闸门，**不自动重开**（处理动作的幂等性引擎无法保证） |

`resume` 的前提：上一迭代的 session 不在运行（否则 409 `session-busy`——两个 session 同时改一个工作树）；
满足则先 `stopSession` 它，再派发新迭代。

### 5.2 三种停法（≈ Ralph 脚本的 ctrl-c）

1. **面板"结束"**（硬停）：取消循环当前活跃的 run，并 `stopSession` 正在跑的迭代 session。循环终结，无闸门。
2. **直接 Stop 当前迭代的 session**：turn 以 `stopped` 结局 → 5.3 的路径 → 闸门，原因"已由用户停止"。
   留闸门而不是直接终结：用户常常只是想停下这一项去手动修点东西，然后继续。
3. **在 worker 机器上杀 agent 进程**：`process_exit` → 同 2。隧道断开、界面够不着 worker 时的最后手段；
   迭代与时长两个上限始终生效，是无人值守的死手开关。

**软停**"做完这项后停"：gate action `pause`，在当前 run 的 `params` 里置 `stopAfterCurrent`；完成时按刹车处理。
硬停可能让一项处理到一半，而幂等性由 prompt 保证、引擎帮不上——多数时候软停更安全，面板上它是主按钮。

**按循环寻址。** 任一时刻一个循环至多一个活跃 run，但面板手里的 run id 可能已过期（那次迭代刚完成、下一次
已创建）。gate 路由仍收 run id，引擎对 `repeat` run 先解析到"该 `loop_id` 当前活跃的那一个"再执行
`cancel / pause / resume`。派发路径在每个 await 之后复查 run 状态：`preparing` 期间被取消 → 作废预备中的
session（review 的"准备期间被取消"同款处理）。

### 5.3 turn 非正常结束——现有引擎的盲区，必须补

`session:taskCompleted` 只在 `completed` 结局发出；`failed` / `stopped` / `process_exit`
（`agent-session-manager.ts:1735, 2410, 3307`）什么事件都不发给引擎。review 闭环里这意味着"循环静默停下"
（用户已接受）；对无人值守的循环不可接受——用户以为它还在跑。做法：引擎订阅 `session:status`；某 session
转为非 `running` 且它有 open 的 `task_prompt` 步骤时，读 transcript 最后一个 `turn_end`：
- `completed` 系 → 什么都不做（`taskCompleted` 会来，或已来）；
- `stopped` → 步骤 abandon，run → `cancelled`（"已由用户停止"），建闸门，**不发里程碑**（人就在场）；
- `failed` / `process_exit` → 步骤 abandon，run → `failed`，建闸门，里程碑 `workflow_failed`。

"用户停止"与"失败"由此区分：前者是 `cancelled` + 无铃，后者是 `failed` + 响铃。

## 6. 失败窗口

| 窗口 | 结果 |
|---|---|
| 事务提交后、`stopSession` 前崩溃 | 旧 session 留着没停。`init()`：`repeat` 的 completed run 若其 session 仍 `running`/resident 则停掉。无害，只占一个 resident 槽 |
| 下一迭代 run 已插入、未 prepare 就崩溃 | `init()` 看到 `preparing` 且无 session 的 `repeat` run → 重新走 prepare/activate（`operationId = runId`，幂等） |
| prepare 后、activate 前崩溃 | 同 review：`prepared_context` 不需要（prompt 在 `params` 里），直接重放 activate，同键 |
| activate 结果未知 | 同 review 的 `activation_uncertain`：run 进 `running_task` + error 提示，**不重发**；真实完成仍会被归属 |
| `checkCommand` 挂住 | 超时 5 分钟，视同失败 |

## 7. 路由、远程、前端

- **路由**：`POST /api/workflow-runs` 增加 `kind: "repeat"` 分支（body：`prompt, agentType, model?, maxIterations?,
  maxMinutes?, checkCommand?, confirmDone?, name?`），不需要 `sourceSessionId`。`/api/path/workflow-runs` 同步。
  gate 增加 `resume`。**不新增路由** → 隧道契约无 registry 变化，只有 body 字段加法。
- **远程（主要目标）**：引擎在 worker 上，hub 只显示与转发（Phase 1.5 形态不变）。与 review 不同：
  **所有**迭代 session（含第 1 个）都由 worker 上的引擎创建，请求不经过 hub 的创建 saga。分两层解决：
  - **响铃必须可靠（无人值守 + hub 一天部署多次）→ 走锚点 session。** 发起请求的响应里带第 1 迭代的
    session；hub 当场发布它（map + 持久化 mapping `from_start` + 常驻流），并把它的通知窗口直接开到
    `now + maxMinutes + 30min`（`extendNotificationWatch` 收的是绝对时间）。**循环的所有里程碑都写在锚点
    session 的 outbox 上**（`session_id` = 锚点，`workflow_run_id` = 当时的 run）。hub 的 60s tick 与启动
    sweep 只依赖持久化的 mapping，不依赖任何流或浏览器——hub 重启、隧道断开都能补拉。`resume` 经过 hub 时
    再延一次窗口。
  - **显示尽力而为 → 见到就发布。** hub 在三处看到 `repeat` run 里不认识的 `source_session_id` 时按需发布
    （`publishRemoteReviewer` 抽出的通用部分）：发起响应、代理的 run 列表 / 单个 run、`workflowRunUpdated` 帧。
    为让帧到得了 hub，worker 把 `repeat` run 的更新同时镜像到**锚点 session 的流**上（hub 从发起起就连着它）。
    丢帧无害：面板有 5s 轮询，侧栏有 alive-sessions 发现。
  - **铃的落点**：通知点开时前端按 `workflow_run_id` 取 run，跳到该 run 的 `source_session_id`（blocked 的那个
    session），而不是锚点。此时人在场，走"见到就发布"即可。
  旧 worker：不认识 `kind` → 会把请求当成缺 `sourceSessionId` 的 review，返回 400。hub 用 worker 版本门控
  （`remote-executor-starts.ts` 的先例，`REPEAT_LOOP_MIN_WORKER_VERSION`），低于门槛直接 409 提示"该机器的 worker 不支持"。
- **前端**：
  - 发起入口：第一版放在 Main Chat 的 review 面板旁一个"New loop"按钮 + 弹窗（prompt 多行、agent、上限、
    可选检查命令）。chip / `commands.kind` 到第二刀统一做——届时这个弹窗的字段就是模板参数表单。
  - 面板卡片：`Loop — <name>` · 第 N / M 次 · 上一项 `Item` · `Remaining`（若有）· 当前 session 的跳转链接 ·
    `结束` / 停下后的 `继续循环`。
  - 侧栏：迭代 session 照常出现（用户要能点进去看），标题 `<name> #N`。几十个已停 session 的噪音靠现有
    retention（未加星超期删除）消化；第一版不做分组。

## 8. 与指挥官、与其他模板的关系（不在本轮）

- **与指挥官是分层，不是二选一。** 分界线是"下一步做什么"的规则是否固定：规则固定（同一条指令反复执行，
  `continue / done` 决定去留）→ 固化成 worker 上的流程，团队自己干、干完上报；需要判断（下一步取决于上一步的
  内容、跨 session / 跨机器协调、任务不同质）→ hub 上的指挥官现场决策。衔接：指挥官（或用户）**启动**一个循环
  （将来的 `runWorkflow` 工具）；循环结束或需要人时经**持久里程碑**上报；`blocked` 今天交给人，将来可先交给
  指挥官，由它决定换个做法重启还是升级给用户。与 `multi-level-commander-design.md` 一致：指令向下、事件向上、
  问题尽量在本层解决；指挥官的唤醒必须来自持久里程碑——本模板的上报正是这条通道。

- **每项之后接一轮 review**：`continue` 后先对本迭代 session 发起 review 闭环，`ship` 才进下一迭代。两个模板
  各自成立后再串，串联点就是 §4 事务里"创建下一迭代"那一步换成"创建 review run"。
- **引擎持有的列表来源**（`tasks` 表 / 清单）：加一种 `params.source`，引擎把第 N 项注入 prompt，`done` 由引擎
  判定而非 agent 自报。比本模板更可控、更不灵活。
- **第二刀的模板化**：`commands.kind = workflow` 的定义 JSON 里 `template: "repeat-until-done"`，`params` 即 §2 的 params。
  有了两个模板，才看得出哪些该抽象（目前看到的公共部分：链式 run、投递身份、收尾字段解析、刹车、终止里程碑）。

## 9. 已拍板（2026-09-20）

1. 状态词汇 `continue / done / blocked`，解析不出来按 `blocked` 处理。
2. `done` 复核默认关（`confirmDone` 第一版不做，留参数位）。
3. 默认刹车 20 次 / 240 分钟；`blocked` 时不停 session。
4. 被重启打断的迭代不自动重开，等人点"继续循环"。
5. ~~先本地、远程单独一刀~~ → **remote worker 是主要目标**：hub 代理、锚点响铃、见到就发布、版本门控、
   双服务器 e2e 都在主线里。引擎在 worker 与在单机上是同一份代码，单机 e2e 先行只是为了先验证引擎。
6. 引擎留在 worker；停止语义见 §5.2。

## 10. 任务（展开见实施计划）

| # | 内容 |
|---|---|
| R1 | 存储：`kind` / `params` / `outcome_status` 列；`running_task` / `waiting_resume` 状态；`task_prompt` 步骤 kind；`workflow_task` purpose；`nextRun` 支持指定初始状态与 `error`；`getActiveInLoop` |
| R2 | `parseClosingField` 抽取 + `parseTaskStatus`；收尾说明常量 |
| R3 | 引擎：发起、迭代派发、按 kind 分派的完成处理、刹车、`stopSession` 接入 AgentOps、`pause / resume / cancel` 按循环寻址 |
| R4 | 引擎：`session:status` 补"非正常结束"；`init()` 恢复窗口；锚点里程碑（`loop_done` + `workflow_failed`）；指挥官抑制扩展；锚点流镜像 |
| R5 | 路由：本地 + `/api/path` 镜像 + hub 代理（按项目绑定的 worker）；版本门控；hub 发布（锚点长窗口 + 见到就发布） |
| R6 | 前端：New loop 弹窗、面板卡片（软停 / 结束 / 继续）、状态序、通知按 run 跳转 |
| R7 | 真机 e2e：单机（引擎）→ 双服务器 hub + worker（主要目标），含 kill -9、blocked、上限、软停、Stop 按钮 |


---

## 11. 实现记录（2026-09-20，dev1）

R1–R7 已提交。后端与前端全量测试通过，两端 `tsc` 干净。`classify-diff`：**隧道契约有加法变化**
（新路由 `POST /api/path/workflow-loops`，注册表 `since: 0.3.42`）→ hub 可单独发，但功能要在 remote 上可用
**必须发 worker**；旧 worker 由 hub 按 capability 门控，返回 409 `worker_unsupported`，不探测。

**与设计稿的差异：**

1. **发起走新路由，不复用 `POST /api/workflow-runs`。** `POST /api/workflow-loops`（hub / 单机）+
   `POST /api/path/workflow-loops`（worker 镜像）。理由：新路由能进 capability 注册表，hub 用握手上报的
   capability 门控（与两段式 review 同一做法），比设计稿里的版本号常量更准；`pause / resume` 仍是既有 gate 路由
   的新 `action` 值。§7 的"不新增路由"以此为准作废。
2. **session id 预分配。** `workflow_runs.source_session_id` 非空，`repeat` run 创建时就带一个预分配的 uuid，
   lifecycle `prepare` 用它建 session；闸门 run 的 id 只是占位，`resume` 时换成新的（旧的可能是派发失败留下的
   tombstone）。activation key = `task:<runId>:<sessionId>`。
3. **派发不起来 ⇒ 同一行原地变闸门**（`preparing → waiting_resume` + 铃），不另建 run——它什么都没派出去，
   没有可结算的东西。
4. **`Status` 行必须以标签开头。** verdict 的"含 verdict 的最后一行"规则不适用：`status`、`item` 是日常词汇
   （"HTTP status 200"），散文里提到不算。`parseVerdict` 因此没有重构，两个解析器只共享纪律，不共享内核。
5. **hub 的"见到就发布"挂在 hub 总线上**（`workflow:run-updated` 订阅，`remote-loop-sessions.ts`），不改流处理
   函数：映射后的帧、发起 / gate 路由自己的 emit 都经过总线；run 列表与单 run 读取两处直接调用。
6. **检查命令的工作目录**优先取 session 实际 checkout 的路径（与 review target 抓取同一偏好）。
7. 迭代结束后的 `stopSession` 会让 session 转 idle 并再触发一次"非正常结束"检查——此时步骤已领取，检查为空操作；
   `cancel` 同理先 abandon 步骤再停 session。
8. `confirmDone` 未做（按 §9 第 2 点），参数位也未预留——需要时再加。

**真机 e2e（真实 claude CLI，一次性 `--data-dir`，按 PID 清理，未运行 `connect stop`）：**

- **单机**：3 项 todo.json → 4 个 session（`Todo #1..#4`，edit 模式，purpose `workflow_task`），逐个 `continue`、最后
  一个 `done`，每个 session 完成即停，`loop_done` 写在锚点 outbox，全程 43s。另测：同 workspace 第二个循环 409；
  blocked 项 → 闸门 + 铃，人工处理后**用过期的第 1 迭代 id** `resume` 成功；软停 → 做完当前项后闸门、无铃；
  对迭代 session 点 Stop → 该迭代 `cancelled` + 闸门、无铃；`resume` 越过上限自动追加；迭代途中 `kill -9` →
  重启后该迭代 `failed` + 闸门 + 铃，**没有自动重跑**；再 `resume` → 上限闸门；用过期 id `cancel` → 循环终结。
- **双服务器（hub + reverse-connect worker，主要目标）**：经 hub 发起 → 201，run / session / params 内的 id 全部是
  hub 空间；blocked 闸门与 `workflow_failed` 通知到达 hub 收件箱；锚点 mapping 的通知窗口 = 时长上限 + 30 分钟，
  后续迭代的 session 被 hub 逐个学到。**闸门期间 `kill -9` hub 并重启**：闸门仍可见，用过期 id 经 hub `resume`
  成功，循环跑完，`loop_done` 在重启后的 hub 收件箱里出现；通知 → run → 应打开的 session 可读（200）。

**Review 后的七处修正（同日，外部审阅，逐条在代码上复现后修）：**

9. **“结束”必须真的停住。** `cancel` 读到活跃 run 与 CAS 之间，迭代可能被结算、下一迭代被插入；丢 CAS 曾直接返回，
   循环继续跑。现在丢 CAS = 重新定位再试（结算是一个事务，任何时刻恰有一个活跃 run 可找）；`pause` 同理——
   标志若落在刚结算的行上，就补到接替它的 run 上。
10. **异常结束与正常结束同等原子。** “作废步骤 + run 结束（+ 铃）+ 插入闸门”改为一个事务
    （`claimStepAndTransition` 的 `abandonStep`）。三次写之间崩溃会留下没有 open 步骤的 `running_task`，而重启对账只
    遍历 open 步骤，永远没人再看它。
11. **`preparing` 也可以被结算。** 指令已送达、`preparing → running_task` 没落库（崩溃，或极快的 turn）时，按步骤的
    entry 索引归属的完成 / 中断就是证据：完成 → 正常结算，中断 → 闸门。此前会只领步骤，随后 boot 重放激活，
    把 run 推到一个永远等不到完成事件的 `running_task`。派发路径丢 CAS 时只有“已取消”才拆 session。
12. **单 workspace 单循环由数据库保证。** 部分唯一索引 `idx_workflow_runs_one_repeat_loop`
    （`project_id, ifnull(branch,'')`，`kind='repeat'` 且活跃态）；先查后插挡不住并发发起。
13. **`runId` 重放要核对归属**（project、branch、kind、prompt），否则能用发起接口读到别的项目的 run。
14. **时长上限是真正的死手开关。** 原先只在收到 `continue` 时看钟，挂住的迭代永远不触发。引擎每 60s 扫一次
    `running_task` 的循环：超时 → 同一个原子“结束迭代”（`failed` + 闸门 + 铃）→ 再停 session（先结算后停，
    这次停不会被读成“用户停止”）。用间隔而非每 run 定时器：重启、resume 后无需重新上弦。
15. **检查命令运行期间的软停不再丢。** 结算前重读 params。（只缩小了窗口，见第 17 条。）

**第二轮复核的两处（同日，交错测试复现后修）：**

16. **结算按“当前行”决定，并在提交时校验。** 与 turn 有关的量（Status、Item、检查命令）只算一次；与 run 行有关的
    决定放在重试循环里：run CAS 接受 `preparing | running_task` 任一——派发路径可能在结算途中才记下 `running_task`，
    第 11 条引入的快照 `from` 会因此丢 CAS，把一次有效的完成丢掉；并以 `expectParams` 要求决定所依据的 params 未变。
    守卫落空就重读重算（上限 5 次，仍不成则步骤保持 dispatched 并报错）。异常结束的 CAS 同样接受两种状态。
17. 软停落在“重读 params”与提交之间仍会丢：接口返回成功，下一迭代照常启动。由第 16 条的 `expectParams` 关闭。

**第三轮复核（同日）：**

18. **hub 的“已发布”以全部步骤成功为准。** `publishRemoteLoopSessions` 曾用 `remoteSessionMap.has()` 代表发布完成，
    而内存登记先于持久化 mapping：持久化一旦失败，之后每次调用都跳过，锚点的 mapping——循环铃声的基础——永远补不上。
    现在每步幂等、逐 session 隔离错误，全部成功后才记入进程内的 published 集合；重启后自然重新确保一次。
19. **原地变成的闸门带 `dispatchFailed`**（params 内），面板据此显示“第 N 次迭代没能启动”，不再回指上一轮、
    也不再提示一个不存在的 session。
20. “异常结束是一个事务”的测试此前在已不被调用的 `abandon()` 上注入崩溃，名不副实；改为钉住形态（一次
    `claimStepAndTransition`，不调用 `abandon / create`），原子性由存储层的回滚测试负责。

**最终版本上的 remote smoke（c5193c38 构建，hub + reverse-connect worker，真实 claude CLI，一次性 data-dir）：**
经 hub 发起 → worker 自行推进到第 2 次迭代 → **用过期的第 1 轮 id** 经 hub 软停 → 做完当前项后出现闸门、hub 无通知 →
**闸门期间 `kill -9` hub 并重启**（worker 4s 后重连）→ 重启后的 hub 列出闸门 → 经 hub `resume` → 跑完 4 项，
第 5 个 session 报 `done` → `loop_done` 出现在重启后的 hub 收件箱。另起一个循环，迭代进行中经 hub 硬停：
run `cancelled`、session `stopped`，45s 后 worker 库里没有新迭代，todo 一项未动。
本次 smoke 未覆盖 blocked → `workflow_failed` 到达 hub（修正前的 e2e 覆盖过；发布路径此后有改动，由单测覆盖）。

**未做 / 已知限制：**

- 维护性整理留待触及相关代码时：runner 借用 `prepareReviewer / activateReviewer` 这组名字创建 task session；
  `AgentOps.stopSession` 对 repeat 是必需的却声明为可选；本文正文（§5–§7）与本节有重复和被本节作废的旧描述。
- `scripts/cross-version-e2e.mjs` 没有循环的 smoke 步骤（它的桩 CLI 只会回固定字符串，跑不了"按约定收尾"的循环）；
  新 capability 登记在 `COVERED_BY`，指向路由测试。
- 面板卡片不提供 session 跳转链接（review 卡片同样没有），靠侧栏里的 `<name> #N`。
- 迭代 session 在侧栏不分组；几十个已停 session 的噪音靠 retention 消化。
- 被 hub 学到的迭代 session 只有默认 30 分钟通知窗口——无妨，循环的里程碑全在锚点上。
