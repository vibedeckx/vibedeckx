# Workflow Phase 3 — 跨 Remote 编排（讨论记录，未排期）

> 状态：**讨论记录，不排期、不实现**。本文的价值是固化 2026-07-18 的一轮架构
> 讨论——包括达成共识的部分、被有意推迟的部分、以及一个悬而未决的核心分歧。
> 未来第一个真实的跨 remote workflow 需求出现时，从本文的"决策触发条件"
> （§6）重新进入讨论，而不是从零开始。
> 前置：[`2026-07-17-workflow-engine-review-loop-design.md`](./2026-07-17-workflow-engine-review-loop-design.md)
> （Phase 1/1.5/2；本文不改变其任何结论）。
> 关联：[`multi-level-commander-design.md`](../../multi-level-commander-design.md)（§5 的分歧另一极）、
> [`event-driven-outbound-approval-design.md`](../../event-driven-outbound-approval-design.md)
> （child-step 审批的既有先例）。

---

## 1. 触发问题

Phase 1.5 把 workflow 引擎定死在 worker 端（理由见主文档 §6：git 物理约束、
二进制复用、代理模式复用）。由此引出的问题：

> 引擎在 worker 端，是否意味着整个 workflow 及其所有 agent session 只能跑在
> 同一个 worker 上？如果想做跨多个 remote 的调度（非 design-review 流程）怎么办？

答案：**对当前引擎，是；对未来架构，不必**。关键是把三个被"WorkflowEngine"
一个词混住的概念拆开：

```
编排权归属   谁决定下一步做什么      （orchestration ownership）
步骤执行位置 这一步在哪台机器执行    （step execution locality）
Session 驻留 agent session 活在哪里 （session locality）
```

三者不必相同。一个 workflow 可以由 SaaS server 编排，而各步骤分别在不同
remote 执行。Phase 1/1.5/2 的引擎只是三者恰好重合的特例——因为 design-review
的 source、reviewer、worktree 存在物理共址约束。

## 2. 三种候选模型

### 2.1 Worker 拥有整个 workflow，跨 remote 时充当调度者

发起 workflow 的 worker A 经 SaaS gateway 调用 worker B/C 上的 agent。
技术上可行（cross-remote MCP gateway 已是这个形状的雏形），但作为平台级
基础有明显问题：

- A 下线 = 跨 remote workflow 失去协调者；
- A（可能是用户自带的 reverse-connect 机器）获得调度其他 remote、消耗额度的能力，
  消费决策离开受信任层；
- "为什么 A 是 coordinator"通常只由"workflow 从哪启动"偶然决定；
- workflow 状态散落在用户机器上，SaaS 无法统一审计、限额、恢复。

**结论：只适合短暂的 agent-to-agent 委派（现有 MCP gateway 的定位），
不作为 workflow 基础。**

### 2.2 所有 workflow 由 SaaS server 编排

Server 持有全部状态机，每步远程指挥 worker。跨 remote 自然，但会毁掉
Phase 1.5 已验证的形状：同 worktree 的 source/reviewer 事件也要绕 server、
git 快照与 server 状态之间凭空多出分布式一致性问题、server 被迫理解
worker-local 细节。**结论：放弃。**

### 2.3 分层：Global Orchestrator + Local Workflow Runtime（共识方向）

```
SaaS Global Orchestrator        —— 跨 remote 的 DAG/依赖、选 worker、
  │                                预算/配额/审计、跨机数据传递、全局取消
  ├─ step/subworkflow → Worker A Local Runtime ── session A1, A2
  ├─ step/subworkflow → Worker B Local Runtime ── session B1
  └─ step/subworkflow → Worker C Local Runtime ── session C1
```

现有 `WorkflowEngine` 原样降级为 **Local Workflow Runtime**：在本机创建/控制
session、worktree/git 操作、本地事件、局部循环（design-review loop 整体就是
一个 local subworkflow），向上只汇报 step 结果。这就是 Temporal/Cadence 的
成熟形状（server 持 DAG、worker 领 task 本地执行），不是新发明。

**Design-review 不升级为全局 workflow**——共址是物理约束，它永远是 worker
本地的一块。

## 3. 达成共识的设计原则

1. **跨机传数据，不传 session。** Session 保持 worker-local，不迁移。跨 remote
   传递的是结构化 StepOutput：task spec、上一步结果、artifact/commit 指针、
   蒸馏后的 context。这与主文档 §3.3"传指针不传序列化成果"同源，只是跨机时
   指针必须升级为自包含数据（对方读不到你的文件系统）。
2. **Agent 临时委派 = 经 server 审批的动态 child step。** Agent A 执行中需要
   Worker B 时，走"A 请求 → server 校验权限/预算 → 在 B 创建 child step →
   结果返回 A"，而不是 A 直连 B。这与 `event-driven-outbound-approval-design.md`
   的受控外呼是同一思想。
3. **两级 run 身份，非双主状态机。** GlobalWorkflowRun（server 权威）与
   LocalRun（worker 权威）持有不同层级的状态；server 不介入 LocalRun 内部
   细粒度变化，worker 不能自行决定全局下一步。
4. **断线边界诚实声明。** server 失联时 worker 可继续已领取的本地 step；
   依赖其结果的全局下一步必然停摆——跨 remote workflow 在 server 完全失联时
   无法可靠协调，这个限制明确接受、不对抗。

## 4. 对 §2.3 的自我批判（同样是结论的一部分）

1. **YAGNI——现在建全局层是纯成本。** 目前没有任何真实的跨 remote workflow
   需求，只有假想例子。GlobalWorkflowRun/StepRun 三层 ID、选址逻辑、跨机
   传递协议，在需求形状明确前全是投机设计。本文是"方向约束"，不是施工图。
2. **"worker 离线自治"的价值被高估。** v1 workflow 是 every-relay 用户门控的
   ——用户在 SaaS UI 上。server 一断线，subworkflow 跑到下一个用户门就停。
   离线继续的实际收益只覆盖"进行中的单个 agent turn"，不值得为它投入设计。
3. **本文默认了"步骤式流水线"世界观，而产品既有方向偏 agent 驱动**——
   见 §5，这是真正未决的问题。

## 5. 悬而未决：全局层是 DAG 引擎，还是 commander 脚下的受控原语？

这是本讨论**有意不回答**的问题。两种竞争哲学：

| | 确定性 DAG 编排 | Commander（LLM 驱动）编排 |
|---|---|---|
| 下一步由谁定 | 代码（build-time 固化的依赖图） | 模型（run-time 即兴决策） |
| 对应已有设计 | 本文 §2.3 | `multi-level-commander-design.md` |
| 适合 | 已被手动跑出稳定形状的流程 | 探索性、形状未知的任务 |
| 失败模式 | 模板僵硬、盖不住长尾 | 目标漂移、自激循环、不可审计 |

主文档 §1.1 的判断（"agent 发现，workflow 固化"）暗示两者是演化关系而非
竞争：commander 即兴跑出稳定形状的流程，逐步固化为确定性 workflow。若如此，
全局层的形态可能是：**SaaS 侧把 spawn/send 原语 + child-step 审批协议做扎实，
commander 在受控原语之上自由编排；确定性引擎（含 design-review loop）作为
commander 可调用的"局部可靠执行块"存在**——即全局层根本不是 DAG 引擎，
而是一组带审批/预算闸门的原语。

但也可能第一个真实跨 remote 需求就是纯流水线（如"A 分析 → B 改移动端 →
C 跑测试"的定时任务），那 DAG 引擎更直接。**按第一个落地的真实场景选，
不预先押注。**

## 6. 当下唯一的行动项：边界纪律（"不做什么"清单）

Phase 3 排期之前，守住以下纪律即可，全部是零成本的"不做"：

1. **Worker 引擎不长出跨 remote 能力**——它只依赖本地 session manager、
   本地 git、本地 EventBus。任何"调用别的 remote"的诱惑都应走 server 侧。
2. **Server 不长出第二个状态机**——`workflow-run-routes.ts` 对 remote 项目
   保持纯代理/gateway 角色，不在 front 侧缓存或推演 run 状态。
3. **Prompt 组装权完整留在 worker**——server 未来提供的增强（如 tier 1
   intent brief）只能是不透明数据字段，不能是 prompt 片段拼接。
4. **概念命名上把现有引擎理解为 Local Workflow Runtime**——文档与讨论中
   避免把它说成"THE workflow engine"，防止全局职责被顺手塞进来。

### 决策触发条件（何时重开本讨论）

- 出现第一个真实的跨 remote workflow 需求 → 按其形状在 §5 两极间选型；
- commander 的 spawn/send 原语进入跨 remote 场景 → 先做 child-step 审批
  协议（§3.2），再谈编排；
- 有人提议在 server 侧持久化 run 状态镜像 → 对照 §6.2 重新论证。
