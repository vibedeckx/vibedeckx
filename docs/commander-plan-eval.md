# Commander 计划行为评测

Evalite 入口：`packages/vibedeckx/evals/commander-plan.eval.ts`。
场景和评分规则：`packages/vibedeckx/evals/commander-plan-scenarios.ts`。
使用真实模型、生产 Commander 提示词、`setPlan` schema、聊天状态和确认恢复流程。
外部工具的执行反馈是固定测试数据；不会启动终端、浏览器或 coding agent，也不会修改项目。
因此它评估计划行为，不评估编码质量或真正的执行结果。

## 运行

在仓库根目录运行。离线机制测试仍使用 Vitest，不需要 API：

```bash
pnpm --filter vibedeckx test evals/commander-plan-rubric.test.ts evals/commander-plan-harness.test.ts
```

真实模型场景使用项目已有的 Evalite 入口。需要显式设置 `COMMANDER_PLAN_EVAL=1`，否则全部场景都会跳过。以下命令假设对应 API key 已配置：

```bash
COMMANDER_PLAN_EVAL=1 COMMANDER_PLAN_EVAL_PROVIDER=deepseek \
  pnpm --filter vibedeckx eval evals/commander-plan.eval.ts

COMMANDER_PLAN_EVAL=1 COMMANDER_PLAN_EVAL_PROVIDER=openrouter \
COMMANDER_PLAN_EVAL_MODEL=deepseek/deepseek-chat-v3-0324 \
  pnpm --filter vibedeckx eval evals/commander-plan.eval.ts
```

对应 key 为 `DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY` 或 `AI_GATEWAY_API_KEY`。
不指定 provider 时按生产注册表顺序选择第一个配置了环境变量的 provider。
不指定 model 时使用该 provider 的生产默认模型。
评测不读取本地数据库中的用户密钥；只读取环境变量。

可选参数：

- `COMMANDER_PLAN_EVAL_SCENARIOS=clarify-deployment,clarify-optimization,clarify-unspecified-bug,single-action`：只运行澄清场景和明确请求对照；省略则运行全部 11 个场景。
- `COMMANDER_PLAN_EVAL_REPS=3`：使用 Evalite 的 `trialCount`，每个场景独立调用模型三次。模型调用不使用缓存。

查看交互界面：

```bash
COMMANDER_PLAN_EVAL=1 COMMANDER_PLAN_EVAL_PROVIDER=deepseek \
  pnpm --filter vibedeckx eval:dev evals/commander-plan.eval.ts
```

打开终端显示的本地地址。每个场景会显示输入、完整聊天记录、独立检查分数和模型调用 traces。原来的 `COMMANDER_PLAN_EVAL_VERBOSE` 已移除，直接在 Evalite 界面查看记录。

启用后会产生真实 API 调用费用。每个场景有多个模型调用；确认、拒绝和修改场景会跨轮运行。
直接传 `.eval.ts` 文件路径可只运行 Commander 场景；不传路径会同时运行现有标题 eval。
Evalite 配置将单例场景超时设为 400 秒，逐个运行，以容纳多轮确认和修改。

## 覆盖范围

| 场景 | 检查内容 |
| --- | --- |
| 模糊部署：「部署一下」 | 询问目标环境或平台，等待补充信息 |
| 模糊优化：「帮我优化一下」 | 询问优化方向或范围，等待补充信息 |
| 未描述的问题：「修一下这个问题」 | 询问现象、报错或复现信息，等待补充信息 |
| 普通问答 | 不生成计划、不执行，回答问题 |
| 单一动作 | 不强行拆分，调用指定 executor |
| 明确 Command | 顺序和失败条件保留，不添加部署，执行前生成计划 |
| 宽泛目标 | 有完成条件和验证步骤，等待用户确认 |
| 确认计划 | 记录用户批准，应用计划并开始执行 |
| 拒绝计划 | 不执行、不立即重新提交，询问修改意见 |
| 修改被拒绝的计划 | 从邮箱密码改为 GitHub，重新请求确认 |
| 修改已批准范围 | 使用同一个 planId，保留 GitHub、加入邮箱需求，重新确认 |

澄清场景输入没有提示模型“请先问我”，测试它是否主动发现缺失信息。
评分要求问题与目标环境、优化方向或问题现象相关，不将一般性的“还有什么需要帮忙”算作澄清。
还检查澄清前没有执行操作、没有凭空生成计划、没有将未解决任务标记完成。
当前生产提示词仍有每轮必须调用工具的限制；此评测会暴露该限制是否干扰“提问后等待用户”。
这些场景测试现状，并不代表已经实现澄清策略。明确请求继续使用已有 single-action 和 explicit-command 场景作为对照。

只跑澄清场景及对照：

```bash
COMMANDER_PLAN_EVAL=1 \
COMMANDER_PLAN_EVAL_SCENARIOS=clarify-deployment,clarify-optimization,clarify-unspecified-bug,single-action \
  pnpm --filter vibedeckx eval evals/commander-plan.eval.ts
```

## 阅读结果

每条检查作为独立的 Evalite scorer，返回 1（通过）或 0（失败）。场景只包含适用于自己的检查，不用无关检查抬高分数。
界面提供每个 scorer 的结果、失败检查列表、用户输入、完整聊天记录及真实模型调用 traces。
API 错误和未到达预期确认节点会让任务失败，不算行为通过。需要低分导致非零退出码时，给命令追加 `--threshold 100`。不要只凭退出码 0 判断行为通过，应检查实际 scorer 分数。

不要求计划文字完全一致。规则检查工具调用、确认记录和计划字段，并用中英文关键词检查顺序、条件及特定需求。
关键词只是小规模回归信号，不能证明任意任务的拆分都合理；通过后仍应抽查生成计划。
重复运行出现间歇性失败时，比较具体检查和原始输出，不只比较一次总分。

离线评分测试验证错误顺序、遗漏条件、额外部署、模糊完成条件和缺失真实确认，并检查全部场景都注册了独立评分项。
另外有一个模拟模型的评测入口测试，检查生产提示词、确认恢复和安全的外部反馈替换。
离线测试通过不代表真实模型评测通过。
