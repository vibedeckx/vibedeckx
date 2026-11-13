# fx 接入对齐矩阵（0.0.16 真实 ACP 探针）

## 状态与验收规则

fx 状态含义：**已验证**＝固定版本真实实验有录制，仅证明注明的范围；**待实现**＝产品改动尚未完成，不代表协议已验证；**未验证**＝缺少真实实验；**明确不支持**＝有版本限定及原因的缺口；**延期**＝承诺范围内推迟的能力；**超出基线（不做）**＝现有 Claude Code / Codex 也没有的能力。

“明确不支持”“延期”是承诺范围内的缺口，收尾时须用户确认；“超出基线（不做）”无需确认。**写了差异说明不等于通过验收。** 源码阅读、协议声明、参数被接受均不等于功能端到端可用。未验证不得写成不支持。

## 环境与证据

- fx **0.0.16**，build revision `481104fdbc24`，Linux x86_64。
- 用户已有 `/home/ubuntu/.local/bin/fx`；复制到隔离目录 `/tmp/fx-acp-probe-0.0.16/fx` 固定实验二进制，没有重新安装或升级系统版本。
- SHA-256：`b8670dcc121b4289e2bdcd2a3e226fd64e3def53c976c42b42de72ee69f66cae`。
- 所有 fx 命令设置 `FX_AUTO_UPGRADE=0`。未登录实验另用临时 HOME、XDG 目录和空工作区，并移除子进程中的认证环境变量；不修改用户认证文件。
- 产品代码基线：`f0d51819defa94e9db5faf5def4e00ce61796521`。
- 首轮用户环境未登录；用户登录后，2026-11-13 完成真实 Gateway 模型实验，主模型 `spacexai/grok-4.7`，模型优先级实验使用 `openai/gpt-5.4-mini`。未使用假的模型服务。
- 权限规则实验使用临时 HOME、本地复制的认证文件和合成 settings，权限为目录 0700、文件 0600；退出后删除。认证内容不进入录制。普通实验只操作临时工作区；MCP 使用本地合成工具及固定无效于外部的测试 token。
- 发现 `session/set_mode` 会持久化默认模式；实验后恢复用户原来的 auto，脚本也加入 finally 恢复逻辑。未修改用户模型默认值。
- [真实未登录录制](../packages/vibedeckx/src/protocol/fx/__fixtures__/unauthenticated.jsonl)；临时复现脚本位于本机 `.dev/scripts/`（Git 忽略，不作为交付依赖）。
- 辅助源码固定到 [481104fdbc24](https://github.com/vercel-labs/fx/tree/481104fdbc24/src/acp)，不把最新文档或源码测试当作当前二进制实测。

## 阻塞项结论与录制

所有链接均在 [fixtures 目录](../packages/vibedeckx/src/protocol/fx/__fixtures__/)。这是协议探针通过，不是产品功能验收；当前尚无 fx Provider。

| 项目 | 实测结论 | 录制 |
| --- | --- | --- |
| 会话协议 | initialize/new/prompt 成功；文本、thinking、读/改文件、shell 均有真实事件；prompt 响应是回合结束信号 | initialize-session、session-tools-permissions、session-parameters-model |
| 多轮与取消 | 连续两轮保留 COBALT731；执行中 prompt 发 cancel 后返回 cancelled，同一会话下一轮返回 AFTER_CANCEL_OK COBALT731 | session-tools-permissions |
| 恢复 | 退出进程后 load/resume 均成功、原 id `a7R28241KBaq` 不变，均能继续回忆 COBALT731；load 重播历史，resume 不重播 | restart-load、restart-resume |
| 权限 | ask 下文件修改/shell/MCP 请求审批并在 allow_once 后完成；auto 普通修改/shell 无审批；显式 bash ask 规则下 auto 仍请求审批 | session-tools-permissions、http-mcp-session、auto-explicit-ask |
| HTTP MCP | 两个 HTTP server 名均成功调用 probe_echo，服务端确认每次 tools/call 认证头匹配，返回 HUB731/REMOTE731 | http-mcp-session、http-mcp-server |

文件名均加 `.jsonl`。MCP 使用合成端点，证明与产品同形状的 HTTP bearer 注入和工具命名；没有调用真实 hub 的业务工具，业务完整性留给后续实现任务。

### 请求形状与参数边界

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"vibedeckx-fx-probe","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/absolute/workspace","systemPrompt":[{"type":"text","text":"Protocol probe."}],"systemPromptMode":"append","mcpServers":[{"type":"http","name":"vibedeckx","url":"http://127.0.0.1:PORT/vibedeckx","headers":[{"name":"Authorization","value":"Bearer LOCAL-ONLY-PROBE"}]}]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<fx-session-id>","prompt":[{"type":"text","text":"hello"}]}}
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<fx-session-id>"}}
```

以上是便于阅读的形状示例，真实值以录制为准。

- initialize 成功返回 protocolVersion 1、agentInfo.version 0.0.16；声明 loadSession、resume、HTTP MCP、图片支持。图片声明不代替图片实测。
- `session/new {}` 被接受，cwd 默认进程目录，mcpServers 可省略或 `[]`；相对 cwd 被 `-32602` 拒绝。
- systemPrompt 可省略；提供时必须是**非空文本内容块数组**，字符串、空数组、image 块均被拒绝。systemPromptMode 可省略或为 append，override 被拒绝。真实模型按注入指令返回 SYSTEM_PROMPT_OK，验证了效果而非仅解析成功。
- mcpServers 必须为数组；HTTP 项完整测试形状如上，headers 是 `{name,value}` 数组，不能用 Claude 的对象形状。本任务不验证 stdio/SSE。
- new 返回 sessionId、configOptions（provider/model/mode/effort 等）、modes。`session/set_mode` 的参数为 sessionId/modeId；plan 返回 `-32602 Unknown mode`。`session/set_config_option` 使用 sessionId/configId/value，model 修改成功。

### 流式输出、工具与回合结束

- 通知方法 `session/update`，payload 为 `params.sessionId` + `params.update`。
- 文本/thinking：`sessionUpdate: agent_message_chunk | agent_thought_chunk`，内容在 `content: {type:"text",text:...}`，文本另有 messageId。
- 工具开始：`sessionUpdate: tool_call`，字段 `toolCallId`、**name**、title、kind、status、**rawInput**、`_meta.fx.toolCall.internal`。实测 name 为 read_file/edit_file/shell。
- 工具更新：`sessionUpdate: tool_call_update`，以 toolCallId 关联；status 实测 pending → in_progress → completed，取消为 failed。更新不重复工具名和输入，Provider 必须缓存。
- 输出是 `content: [{type:"content",content:{type:"text",text:...}}]`。shell 中间输出和 completed 完整输出可能重复，不能直接拼接导致重复展示；完成事件有 command_result（command/cwd/exit_code/signal/timed_out/duration_ms/stdout_bytes/stderr_bytes/truncated/output_file/stdout_file/stderr_file）。
- **本版本录到的 edit_file 没有 diff 字段**，编辑输入为 path/old_string/new_string，完成只有文字结果。首版展示输入及文字结果；不能假称 fx 给了完整文件 diff。用 old/new 生成局部对照属于产品实现，不等价于完整文件 diff。
- 回合结束是对应 prompt request 的 response：`result.stopReason: end_turn | cancelled`。不靠最后一个 chunk 或工具完成猜测。取消是无 id 的通知；本次在 shell 的 pending 事件处取消真实在途 prompt，未证明已启动长驻进程的终止能力（任务 5）。
- available_commands_update、session_info_update 为额外通知，不应误当新回合。notice 本轮未触发。

### 审批应答与 auto

服务端方法 `session/request_permission`，独立 JSON-RPC id；params 含 sessionId、toolCall、options。实测选项：allow_once / allow_always / reject_once，kind 同名。回应同一 id：

```json
{"jsonrpc":"2.0","id":1,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}
```

本轮真实执行的是 allow_once；没有验证 allow_always 的持续授权语义。普通 auto 回合修改文件/执行 printf 成功且没有审批。**auto + 显式 `permission.bash["*"] = "ask"` 仍产生同样的权限请求，必须应答**。因此不能把 auto 当成无交互运行保证，也不能静默自动批准未知请求。测试客户端只允许固定的合成文件/命令/MCP 工具，其余拒绝。

MCP 的审批 kind 是 other，超出现有 approval_request 的 command/fileChange 两类。这是后续实现必须处理的具体接口缺口；不能把 MCP 审批伪装成 shell 命令。

### HTTP MCP 与命名

成功工具名：`mcp_vibedeckx_probe_echo`、`mcp_cross-remote_probe_echo`。`_meta.fx.toolCall.mcp` 还包含 `{server,tool}`，应优先取这两个字段做规范化，不能粗暴按下划线拆分名字。完成内容是文本 JSON，里面封装 server/tool/result/content/isError。

第一次合成服务错误地回应 MCP 2024-11-05，被 fx 拒绝（原始主录制保留这一失败，避免隐去过程）。修正服务按客户端请求回应协议版本，并给未知 server/discover 返回 -32601 后，两次真实 tools/call 均成功。此失败不是 fx 不支持 HTTP MCP 的证据。成功的握手使用 2025-11-25。

### 恢复与模型

load 和 resume 请求都使用 `{sessionId,cwd,mcpServers}`。主实验进程结束后分别启动新进程：load 在响应前输出已有 user_message_chunk、agent_message_chunk、tool_call/update；resume 不重播，仅会话信息。两者续问均正确回忆原标记。不要把 load 的历史重播再次追加成产品新消息。

额外用 `fx acp --model openai/gpt-5.4-mini` 启动后分别 load/resume 原 Grok 会话，两者 configOptions.currentValue 均为新模型；新建会话也为新模型，并实际完成了 SYSTEM_PROMPT_OK 回合。这里只对新建会话验证了模型请求成功，load/resume 的新模型优先级证据是返回配置。

## 首版边界决策

### Plan：首版禁用

实测 modes 只有 auto/ask/full-access，plan 返回 Unknown mode；ask 能批准修改，不具备只读规划语义，故按任务要求确定首版禁用 fx plan；后续实现必须 UI 隐藏/置灰且后端拒绝 `permissionMode: "plan"`，不能将 ask 当 plan，也不引入通用权限引擎。此处是产品范围决定，**不是证明 fx 绝对无法支持只读**。本任务不改 UI/后端，不伪造 ExitPlanMode。

### 恢复：首版只用新会话 + 历史上下文重放

选择现有 `agent-session-manager.ts` 的 `buildFullConversationContext` 路径；不同时实现 load/resume 回退。其理由是用同一条路径覆盖休眠、分支和跨 agent 历史转移，而不依赖来源存在 fx 原生会话。load/resume 已实测，但它们都继续写原生同一会话，不能直接解决跨 agent 和截断分支；选重放可避免双路径及 load 历史重复。

- **历史分支**：新建独立 fx session，输入分支自身的历史；`upToEntryIndex` 使用现有包含截止点的截断语义，不附带后续消息，不复用源会话原生 id。
- **切换 agent**：Claude/Codex 的已保存消息通过同一历史格式送给新 fx session，无需原 fx id。
- **换模型**：退役旧进程，以用户所选模型启动新 fx 进程并新建会话，不 load 旧会话，从而不被旧会话模型设置覆盖。`fx acp --model` 新会话已实测生效，load/resume 也返回新模型配置；首版仍不依赖原生恢复。
- **限制**：现有重放截断每条工具输入/输出到 2000 字符，忽略 thinking；用户复合内容只取文本，图片工具结果转成说明。不是原生无损恢复，图片历史交任务 11 补齐。历史增长的上下文容量仍须后续实现处理。
- **握手时序**：后续实现应在 initialize/new 成功后发送重放内容，不以固定延时假定 ACP 已就绪。历史不得重复追加到用户可见消息。

## AgentProvider / ParsedAgentEvent 对照

接口来源：`packages/vibedeckx/src/agent-provider.ts`。本任务仅确定映射，不新增 Provider 或通用权限引擎。

| 接口或事件 | 映射结论与实现边界 |
| --- | --- |
| detectBinary / buildSpawnConfig | fx acp，env FX_AUTO_UPGRADE=0，传 --model；plan 后端拒绝。注意 set_mode 持久化默认值的副作用。 |
| getInitializationMessages / stdin_write | initialize 成功后再 new，new 成功后才发送积压 prompt。维护双向 RPC id 和应用 id → fx id；不得靠固定延时。 |
| formatUserInput | 文本 → session/prompt.prompt 文本块；图片任务 11。 |
| text / thinking | agent_message_chunk / agent_thought_chunk 的 content.text 可直接映射。 |
| system | session_info/available_commands 可选择忽略或系统展示；notice 未实测。 |
| tool_use | tool_call 的 name/rawInput/toolCallId；缓存名字/输入/kind，避免 pending 重复建卡。 |
| tool_result | completed/failed 的文本 content，shell command_result 可补充退出码；需要增量合并/去重，不能把 in_progress 当完成。 |
| 文件 diff | 未获原生 diff，降级为输入 old/new 和文字结果；不能宣称完整 diff。 |
| result / turn_started | prompt 请求与响应驱动生命周期；stopReason end_turn 成功，cancelled 必须保留中断语义（当前 result 仅 success/error，需要明确降级）。后台任务收尾任务 5。 |
| native_session_id | new 的 sessionId；用于关联，不作为首版恢复入口。 |
| approval_request | command/fileChange 可由 shell/edit 映射；MCP kind other 无现有 union 对应项，需小范围扩展审批表达，或明确可见地拒绝，不能默认批准。 |
| formatApprovalResponse | 保留服务端 request id 与 optionId，发送 outcome.selected；allow_always 行为未测。 |
| formatInterrupt | session/cancel 通知，等待原 prompt 响应后进入下一轮；已验证。 |
| task_started / task_finished / task_list_changed / formatStopBackgroundTask | 未验证，任务 5；不从 prompt 完成推断所有后台任务结束。 |
| result 用量与成本 | response.usage.inputTokens/outputTokens 可映射；cacheReadTokens/reasoningTokens 额外字段，mini 另有 cacheWriteTokens；usage_update.used/size 是上下文占用，不能当本轮 token 用量。成本未出现，不填 0；任务 12。 |
| error | JSON-RPC error.code/message，包含认证 -32600、参数 -32602；要区分初始化/请求错误并停止失败初始化。 |
| onSessionCreated / onSessionDestroyed | 分配/清理 RPC、原生 id、工具/用量状态；不得跨会话泄漏。 |

明确需降级：禁用 plan、历史重放非无损、无原生 diff。明确的现有接口缺口：MCP 审批类型、取消结果的表达。它们不意味着要设计通用权限引擎。

## 功能对齐矩阵

Claude/Codex 列是当前仓库代码基线阅读结果，非本轮跨平台端到端验收；“共用路径”也不等于每种组合都测过。fx 的待实现项不表示协议实验已通过。

| 功能 | Claude Code 基线 | Codex 基线 | fx 0.0.16 状态 / 后续责任 |
| --- | --- | --- | --- |
| 会话与流式输出 | stream-json Provider | app-server Provider | 已验证；会话/文本/thinking/工具报文见主录制，产品待实现 |
| thinking | thinking 事件 | reasoning 文本映射 | 已验证；会话/文本/thinking/工具报文见主录制，产品待实现 |
| 工具卡片 | tool_use/result | item 事件映射 | 已验证；会话/文本/thinking/工具报文见主录制，产品待实现 |
| 审批 | edit 使用跳过权限；plan 原生模式 | 有 command/fileChange 映射；默认 approvalPolicy never | 已验证；ask 审批及 auto 显式规则审批，产品待实现 |
| plan 与 ExitPlanMode | 原生 plan；产品接受计划后切 edit | plan 采用 read-only sandbox；非 Claude ExitPlanMode 协议 | 待实现；首版禁用 plan、UI 与后端均限制；范围缺口须收尾确认 |
| AskUserQuestion | CLI 禁用该工具，退化为普通对话提问 | userInput request 映射 AskUserQuestion 工具事件；完整交互非本轮验收 | 未验证；任务 5 |
| 后台任务显示 | 任务开始/结束/集合事件 | subagent 生命周期、outOfTurn 处理 | 未验证；任务 5 |
| 后台任务单独停止 | stop_task | 无等价接口，退化为停止会话 | 未验证；任务 5 |
| 中断 | 进程/管理器路径 | turn/interrupt | 已验证；cancelled 后可续问，产品待实现 |
| 图片与文件附件 | 内容转换及工具读取路径 | image prompt / imageView 映射 | 未验证；任务 11；本任务只测普通文件读改 |
| 模型选择 | spawn --model | app-server -c model | 已验证；新会话 --model 生效、恢复返回新模型配置，产品待实现 |
| 费用与用量 | result 成本字段 | tokenUsage 缓存到 result；不等同成本支持 | 已验证；token/上下文字段已录到；成本未验证 → 任务 12 |
| hub vibedeckx HTTP MCP | --mcp-config HTTP bearer | -c mcp_servers / token env | 已验证；同名合成 HTTP MCP + Authorization + 工具调用，产品待实现 |
| cross-remote HTTP MCP | 同上 | 同上 | 已验证；同名合成 HTTP MCP + Authorization + 工具调用，产品待实现；网关完整业务由对应实现任务补齐 |
| 休眠唤醒 | 管理器历史重放 | 共用管理器历史重放 | 待实现；已选历史重放，load/resume 已验证但首版不用 |
| 切换 agent | 共用管理器迁移历史 | 共用管理器迁移历史 | 待实现；新 fx 会话 + 重放 |
| 分支 / 截断分支 | 共用分支历史复制 | 共用分支历史复制 | 待实现；独立 fx id + 截断历史 |
| 执行器 | prompt executor Claude CLI | codex exec CLI | 待实现；对应执行器接入任务；不能仅新增 Provider，routes 仍把非 codex 当 claude |
| 定时任务 | scheduler 调用执行器 | scheduler 传递 prompt_provider | 待实现；对应定时任务接入任务 |
| Reviewer | 现有产品入口，具体 agent 组合未复核 | 同左 | 未验证；对应 Reviewer 接入任务补齐，不在本探针实现 |
| Loop | workflow-repeat-loop 传 agentType | 同左 | 待实现；对应 Loop 接入任务 |
| Commander 派生 | 现有会话/MCP/执行器路径 | 现有共用路径，组合未复核 | 未验证；对应 Commander 接入任务补齐 |
| Windows | binary 检测有 win32 分支；本轮未实跑 | 同左 | 未验证；对应平台接入任务 |
| macOS | 现有非 win32 检测路径；本轮未实跑 | 同左 | 未验证；对应平台接入任务 |
| Linux | 现有 Provider；本轮未重跑 | 同左 | 已验证；本轮 Linux 会话、工具、权限、MCP；产品集成待实现 |
| 未登录错误 | 有启动错误路径 | 有启动错误路径 | 已验证；任务 10 接入，见 fixture |

未提供任务 5/10/11/12 之外的具体任务 id，表中按功能注明后续负责人任务，未杜撰编号或新建任务。暂无能力被擅自归为“超出基线”。

## 顺带项登记

- 长驻 shell、subagent 事件，以及 prompt 完成是否覆盖收尾：**未验证 → 任务 5**。
- ask_user_question：**未验证 → 任务 5**。
- 内联图片 prompt：**未验证 → 任务 11**。
- usage_update.used/size 及 prompt response.usage token 字段：**已验证**；未出现成本字段、跨模型统计细节 **未验证 → 任务 12**。
- 未登录错误：**已验证 → 任务 10**。错误发生在 initialize，不是仅退出进程。
- 版本不符/额度用尽：**未验证 → 任务 10**；未耗尽额度取样。
- stdio MCP：不属于本任务要求，未验证；此范围豁免不表示三方都没有该能力。

## 建议：继续做产品接入，首版按上述边界收敛

五个阻塞项都有真实录制，两个决策已定：禁用 plan，恢复只实现新会话加历史重放。无需因协议可行性放弃；优先补齐 Provider 状态机、MCP 命名规范化与审批类型缺口，再推进产品入口。

剩余产品验证按矩阵交后续任务。本任务没有实现产品功能；plan 等降级在最终产品收尾仍须用户确认，不能把本探针结论当作这些缺口已获验收。

脚本/录制校验覆盖：双向 JSONL 可解析、RPC 对应、两轮记忆、取消后续问、工具状态、ask/auto 审批、两种恢复历史重播差别、MCP 服务端认证与调用、模型配置及参数错误。未跑无关产品全套测试；未改产品代码、未更新任务状态。
