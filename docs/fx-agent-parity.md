# fx 接入对齐矩阵（0.0.16 真实 ACP 探针）

## 状态与验收规则

fx 状态含义：**已验证**＝固定版本真实实验有录制，仅证明注明的范围；**待实现**＝产品改动尚未完成，不代表协议已验证；**未验证**＝缺少真实实验；**明确不支持**＝有版本限定及原因的缺口；**延期**＝承诺范围内推迟的能力；**超出基线（不做）**＝现有 Claude Code / Codex 也没有的能力。

“明确不支持”“延期”是承诺范围内的缺口，收尾时须用户确认；“超出基线（不做）”无需确认。**写了差异说明不等于通过验收。** 源码阅读、协议声明、参数被接受均不等于功能端到端可用。未验证不得写成不支持。

## 当前权限决策更新（2026-11-16）

用户明确要求与现有 Claude Code / Codex 一样不等待人工工具审批，**edit 改为 full-access**，替代原任务的 auto 决策。启动使用进程级 `fx acp --permission-mode full-access`，握手必须确认 `currentModeId=full-access` 后才发送消息；auto、ask 或未知模式均明确报错。此模式关闭 fx 权限检查及自动模型审查，操作系统权限和 hub 远端授权仍生效。plan 继续禁用，不调用会持久化配置的 `session/set_mode`。

按用户要求删除 fx 专用审批 UI、审批状态和人工回传接线；正常 full-access 会话没有已知会触发审批的场景。协议解析仅保留直接回复 `outcome: cancelled` 并显示错误的分支，不创建卡片、不等待用户、不默认批准。下文任务 4/5 及原探针中的 auto 记录是历史验证结果，不代表当前 edit 映射。

本次变更验证：fx 协议、Provider、录制回放与管理器共 105 项测试通过，后端 `tsc --noEmit` 通过。真实 fx 0.0.17 生命周期测试通过，确认 full-access 启动、工具回合无审批请求、多轮/取消/重建换模型正常，用户 settings 文件逐字节未变。旧工具录制保持原样，仅测试回放时适配握手模式，不将历史 auto 录制冒充 full-access 实测。

删除审批 UI 后验证：后端相关测试 100/100、UI 工具卡片与权限入口测试 23/23、前后端 `tsc --noEmit` 均通过。

## 任务 6 产品接入（2026-11-16，fx 0.0.17）

**代码已接入，本机真实 hub 调用通过；线上 hub / 授权远端完整验收尚未通过。用户于 2026-11-16 明确要求提交并关闭任务，按此决定收尾；关闭不代表下述待验收项已通过。**

- 两个 HTTP MCP 经每次 spawn 的 `AgentInitializationContext` 传入 `session/new.mcpServers`，headers 使用 `{name,value}[]`。provider 不缓存共享 token；hub 每次 spawn 重签，worker 延用既有消息路由更新 hub token 的路径。管理器测试覆盖休眠后再次 mint 并注入新 token。非 HTTPS、非 loopback 的 HTTP 地址在启动前明确拒绝。
- MCP 名称优先采用 `_meta.fx.toolCall.mcp`，已知 hub 名称支持 `mcp_vibedeckx_*` / `mcp_cross-remote_*` 回退；不会按任意下划线拆分第三方服务名。任务与跨机工具卡片有 UI 组件验证。完整 MCP 结果封装可解包；0.0.17 实测部分 ACP `content.text` 仅为约 200 字符预览，长 JSON 截断时保留原文，不能宣称获得完整结果。
- 权限按用户最新决定使用进程级 `--permission-mode full-access` 和 `currentModeId=full-access` 校验，不调用持久化 `set_mode`。plan 除新建/切换外，在 `prepareSessionRow` 也提前拒绝，覆盖工作流 Reviewer / Commander 通过生命周期 prepare 派生会话的路径；不会静默改为 edit。
- 审批随 full-access 决策简化：移除 `requestType: tool` 扩展和 `ToolApprovalUI`，不再维护待审批状态或 `formatApprovalResponse`。协议收到权限请求时直接回复取消并记录错误；单测验证字符串/数字 RPC id 与管理器无人工介入收尾。Claude/Codex 原有审批类型及 UI 不变。

此前 auto/审批 UI 阶段验证（非当前删减后的测试数量）：后端 `tsc --noEmit`、前端 `tsc --noEmit` 均通过；后端全量 vitest **3594 通过 / 11 跳过**（246 文件通过 / 2 跳过）；审批、工具卡片与权限入口 UI **28/28** 通过。真实本地 hub 冒烟 **1/1**、真实审批选择 **3/3** 通过。

### 真实实验与待验收边界

1. **真实本地 hub + 真实 fx 成功**：`FX_LOCAL_HUB_SMOKE=1 pnpm --filter vibedeckx exec vitest run --config vitest.live.config.ts src/protocol/live/fx-hub.live.test.ts`。使用真实 `createServer`、隔离 SQLite、真实签名 token、loopback HTTP 和原始 fx 登录配置；两个工具均实际调用。测试只产生 proposal，不创建任务。不是同名合成 MCP 服务。远端列表为空不证明远端执行可用。
2. **线上 hub 实测发现握手阻塞**：当前 worker3 的 fx 访问 `https://vibedeckx.dev` 两个真实端点时，`toolbox` 报 MCP 不可用。两端固定回复 `2024-11-05`；fx 要求较新的协商版本。已在本分支修复为支持的请求版本（2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05），未知版本返回最新支持版本，并补两端路由测试。本地真实实验确认修复有效；**尚未部署线上 hub，因此不能声称远端端到端成功**。
3. **远端授权不足**：真实 hub 的 `list_accessible_remotes` 返回 `[]`，已请求用户授权可用 exec worker。没有绕过授权、修改生产授权或部署生产服务。现有网关回归覆盖撤销后下一调用拒绝（含已打开 MCP handle）；**真实 worker 上撤销授权后的下一次调用、完整浏览器卡片验收仍待完成**。
4. **历史审批实验**：此前通过进程级 ask 对固定 `printf FX_APPROVAL_SMOKE` 分别回应 allow_once / allow_always / reject_once，三种均收到 prompt 结束响应，原始 settings 逐字节未变。改用 full-access 并移除审批 UI 后，删除仅用于这些选项的 live 测试与响应构造器，不作为当前产品能力。
5. 可复验线上命令：设置 `FX_HUB_SMOKE_URL`，从会话环境提供 `VIBEDECKX_CROSS_REMOTE_MCP_TOKEN` 和 `VIBEDECKX_SESSION_MCP_TOKEN`，运行同一 live 文件。token 不进入命令参数、录制或仓库。

## 任务 4 产品接入（2026-11-15，fx 0.0.17 产品验证）

**任务 4 已完成基础会话及核心生命周期验收（fx 0.0.17）**：使用原始登录配置和凭据锁，彻底移除临时 HOME / 凭据复制。fx 0.0.17 的真实多轮、排队、取消后继续、thinking、工具结果和换模型重放测试已通过；浏览器验收记录见下文。

已接入 `FxProvider`、`protocol/fx/{cli,codec,schema}`、provider 注册表与模型建议。以下验证区分真实 fx、管理器集成和 UI 组件，不将协议探针直接视为 UI 端到端验收。

- **握手与排队**：initialize → new 逐个等待成功响应并核对 currentModeId=auto；此后才发送历史或消息。同一连接只允许一个 prompt，追加输入 FIFO 排队；每个 prompt response 先产生 result，再开启下一轮，空输出也保留 turn_end。
- **取消**：只有用户 Stop 路由显式传 `interruptOnly: true` 时，发送无 id 的 session/cancel 并保留进程；下一条消息等原 prompt 的 cancelled 响应。取消超过 5 秒或再次按 Stop 会终止进程，SIGTERM 不生效则升级 SIGKILL。取消计时器在轮次结束、进程重置或 shutdown 时清除，并与 stdout 串行校验，不能误杀后续轮次。result 明确区分 cancelled，记录 stopped 和用户停止说明，不写错误或失败通知；保活取消和普通 Stop 共用状态发布逻辑，将 stopped 分支活动镜像到会话 WebSocket，供远端 hub 更新工作区状态点；Stop 取消尚未发送的排队消息时显示数量及重发提示。默认 `stopSession` 仍会杀进程，不依赖 note 判断语义；强制容量回收使用 `stopSessionAndWait`，确认退出后才允许占用新名额，无法确认则拒绝新建。
- **恢复与模型**：沿用 buildFullConversationContext，休眠、退出、换模型后均重新 initialize/new；不发送 load/resume，不读取旧 native id 或旧模型配置。修复进程意外退出后未进入 dormant、导致下一条消息不能唤醒的问题；旧进程迟到输出不能污染新 provider 状态。历史只送 stdin，不新增可见 user 消息。
- **权限**：edit 映射 auto，plan 在创建、切换模式、切换 agent 时明确拒绝；UI 按 capabilities 禁用。启动前探测 `fx acp --help`，只有该子命令明确支持才传 `--permission-mode auto`；本机 0.0.17 已实测支持，参数位于子命令之后。new 返回值必须确认 currentModeId=auto 才发送历史/消息。0.0.16 不假定支持该 flag，只接受本来就是 auto 的原生模式，其他模式明确报错并提示升级；不把 ask 当 plan。
- **配置与认证边界**：不调用会持久化默认权限的 set_mode，不覆盖 HOME，不复制/链接 OAuth 凭据，继续使用原始认证文件及 fx 自己的刷新锁。真实测试确认用户 settings 文件逐字节未变。0.0.17 的进程级覆盖优先于保存值，源码佐证：[loadStartingMode](https://github.com/vercel-labs/fx/blob/72ee78cf235739960b827e4c0fe4f80df7e31312/src/acp/server.zig#L4399)。历史通过应用重放恢复，不恢复旧原生模式/模型。
- **工具与审批**：文本/thinking 按 delta 流式合并（文本保留完整输出，连续 thinking 只更新同一条记录，流结束时一次落库）；原始工具名、输入按 toolCallId 缓存，completed/failed 快照替换进度，不重复卡片或输出。完整审批任务接入前，permission request 返回 cancelled 并显示拒绝说明，不自动批准、不悬挂；双向同号 RPC 分开处理。
- **错误**：认证/JSON-RPC error、损坏的报文或必须字段、在途进程退出均显示错误并关闭当前轮次。初始化失败不继续发 new/prompt；协议损坏会退役进程，下次发送自动重建并重放历史；prompt 请求错误允许在同一连接重试，未知更新类型忽略。usage_update 为上下文占用，不写进本轮 token；只有 prompt usage 计入结果。
- **可用性（按用户后续决定调整）**：选择器列出所有支持的 Agent，不做安装探测、不展示安装提示、不因未安装而禁用。`/api/agent-providers` 仅返回元数据，移除 `available` 字段，前端同步移除对此字段的读取。新建/唤醒/重启实际构造 spawn 配置时重新检测 CLI，绕过旧路径缓存；fx 未安装时不提供 npx 回退，启动失败的安装说明写入 Agent 对话错误消息。远端 agentType 继续字符串透传，无新隧道路由。

验证入口：

- `src/protocol/fx/*.test.ts`：全部现有 ACP 录制经离线契约检查（包括未采用的 load/resume 录制的 envelope/update），以及参数、图片构造、ACP flag 探测与旧版拒绝策略测试。HTTP MCP 服务端录制由原探针负责，不冒充 ACP envelope。
- `src/providers/fx-provider.test.ts`：握手、初始化前多条积压、多轮队列、同号反向 RPC、取消后继续、工具快照去重、错误收尾、独立原生 id、禁用 plan。
- `src/agent-session-manager.fx.test.ts`：真实 stdio 子进程 + SQLite（模拟 ACP 服务端），验证多块文本不覆盖、thinking 合并、逐轮 turn_end、用户 Stop 保活、默认 Stop 终止、强制容量回收及退出确认失败拒绝、重复 Stop、取消超时/SIGKILL、旧取消计时器不影响下一轮、休眠唤醒不重复历史、换模型、异常退出后再唤醒、损坏报文退出 running、提前拒绝 plan。
- `src/protocol/live/fx.live.test.ts`：真实 fx **0.0.17** + 原始 OAuth 登录，2026-11-15 通过（初次约 23 秒，增量修复后复验约 19 秒）。验证两轮及运行中排队、取消后续问、thinking、成功工具结果、新原生会话重放标记、`spacexai/grok-4.7` → `openai/gpt-5.4-mini`，并校验原 settings 字节不变。通过 `pnpm --filter vibedeckx exec vitest run --config vitest.live.config.ts src/protocol/live/fx.live.test.ts --retry 0` 运行。
- **浏览器产品验证**：独立本地实例 + 临时项目 + 真实 OAuth/fx 0.0.17；已操作 fx 选择/新建、多轮、Stop 后续问，观察到文本、thinking 与通用 shell 工具卡片。重启测试后端后继续原会话，返回历史标记 UI731；工具 `printf FX_UI_STREAM_OK` 的结果和完整最终文本均落库。浏览器验收发现并修复了 ACP 增量被当成快照覆盖、thinking 每块新增卡片的问题，新增管理器回归断言。新版 UI 的 Plan 按钮禁用。UI 换模型后进程参数实际为 `fx acp --permission-mode auto --model openai/gpt-5.4-mini`，仍记得历史标记。截图及临时日志保存在本机 `/tmp/fx-task4-browser.png`、`/tmp/fx-ui-server3.log`，不作为跨机器运行依赖。
- UI provider 组件测试另验证动态选项与禁用 plan。图片端到端、工具专用映射、完整审批、HTTP MCP 业务接入仍由后续任务负责。
- 此前全量离线检查：`pnpm --filter vibedeckx test` 通过（3519 passed / 11 skipped），后端 `tsc --noEmit` 通过，UI provider 组件 3 项通过，UI 生产构建通过，离线契约与远端能力检查 32 项通过，reverse-connect-capabilities 快照无变化。

- 安装提示交互调整后回归：后端针对性测试 114 项、UI 相关测试 67 项通过；覆盖列表不探测安装/不返回 hint、启动缺少 fx 时把安装提示写入对话历史、安装与移除后的路径重探测。

## 任务 5 工具卡片与生命周期（2026-11-16，fx 0.0.17）

工具名和参数在 `protocol/fx/tool-mapping.ts` 归一，复用现有 UI：Read / Write 的 `path → file_path`，Read 的 `start_line/line_count → offset/limit`，Edit 使用 `old_string/new_string` 展示**局部替换**，不构造完整文件 diff；shell → Bash（interact/stop 没有 command 时保留原参数回退显示）；Glob、Grep（include → glob）、WebSearch、WebFetch、Agent、AskUserQuestion 均用现有卡片。subagent 的 agent/action/message 适配为描述和提示词；toolbox、vision、read_tool_result、install_skill 及未知工具保留通用 JSON 卡片。真实 OpenAI 模型的原生 web_search 可上报空 rawInput，此时保留空参数，不捏造 query。

MCP 优先使用 `_meta.fx.toolCall.mcp.{server,tool}` 调用共用 `qualifiedMcpToolName`，结果事件沿用缓存的 metadata；没有 metadata 时不拆单下划线名字。这里只完成命名，HTTP MCP 配置/业务接入仍属于任务 6。

真实录制见 `__fixtures__/task5-*.jsonl`，版本与复现说明见 fixtures README。四份录制既经过协议契约检查，也经 `fx-provider.recordings.test.ts` 回放到产品 provider。补测结论：

| 项目 | 0.0.17 真实观察 | 产品行为 / 差异 |
| --- | --- | --- |
| 提问 | ask_user_question 立即完成，输出 “only available in the interactive shell; ask the user freeform instead”；没有等待用户回答的 ACP 请求 | 明确不支持本版本 ACP 阻塞式提问。映射到现有问题卡片，补齐缺省 header；选择/自由输入通过现有 sendMessage 发送普通后续消息，若前一 prompt 尚未完成则 FIFO 排队。并非向悬挂工具返回答案。UI 测试验证提交路径。 |
| 子 agent 正常收尾 | message 工具先 completed（Sent to…），随后同一 toolCallId 再 completed（真实最终报告）；即便要求父 agent 不调用 wait，prompt response 仍在 CHILD_NOWAIT_DONE 报告之后 | 直接利用 prompt 响应收尾，不另建账本。修复旧 provider 丢弃第二个 completed 的问题，以同一结果 ID 替换卡片，重复快照不重复展示。 |
| 长驻 shell | run 在进程运行中即 completed；后续输出可能以原 ID 的 in_progress 到达；interact 有退出码/耗时 command_result；不等待的 run 回合未录到独立进程结束事件 | run 的 completed 不等价于进程结束。没有可配对的独立生命周期事件，不发 task_started/task_finished，不显示后台任务条。回合内、run 工具已 completed 后到达的输出更新原卡片；prompt 结束后不把迟到更新当作新回合。 |
| shell 正常/失败 | sleep 3 后输出 SHELL_DONE；另一次 sleep 2 后退出 7，interact status=failed，prompt 仍 end_turn | 工具失败不假装成协议失败；以真实 prompt 响应结束回合。管理器测试另覆盖在 shell/subagent 进行时发生 prompt JSON-RPC error，状态均回 stopped（非 running），下一轮可用。 |
| shell 取消 | 先由命令写 cancel.pid，确认已启动后发 session/cancel；返回 cancelled，下一轮 AFTER_CANCEL 成功。检查时 shell PID 仍存在，结束实验前清理 | **取消回合不保证杀死已 yield 的 shell**。UI 状态以 cancelled 正确结束；不宣称底层进程被终止。原有超时/重复 Stop 杀进程兜底保持不变。 |
| 子 agent 取消 | 子任务 shell 写出 cancel.pid 后发 cancel；prompt cancelled，后续 AFTER_CHILD_CANCEL 成功；实验结束检查 PID 已不存在，未产生取消后的标记文件 | 管理器与 provider 回归覆盖取消后的状态收尾；此样本不推广成所有派生进程的终止保证。 |
| 单任务停止 | shell action=stop / session_id / force 已实测调用成功 | 协议工具可停止 shell；没有后台条所需的可靠会话 ID 与生命周期配对，未暴露产品单任务 Stop 按钮，也不模拟 Claude task 事件。 |

验证分层：真实 fx 工具/生命周期录制；录制经 provider 回放；真实 stdio 模拟服务端 + SQLite 验证管理器正常、取消、错误收尾及下一轮；UI 组件直接消费归一结果，验证专用卡片、通用卡片和问题提交。此次未另做浏览器端到端验收，不将组件测试称为浏览器验收。

最终验证：前后端 `tsc --noEmit` 均通过；后端 `pnpm --filter vibedeckx test` 为 **3571 passed / 11 skipped**；前端 `pnpm --filter vibedeckx-ui exec vitest run --retry 1` 为 **1721 passed**。前端首轮有一个未改动的 Shiki `symbol-tokens` 用例在库内抛出 startIndex 异常，单独复跑及全量复跑均通过；未为此修改无关实现。后端首轮与映射增量修改交错导致两项读到旧转换缓存，固定最终代码后全量复跑通过。fx 专项 92 项及 UI 新增 15 项覆盖上述产品路径。

### 任务 5 review 修正

本轮验证：fx 相关 7 个测试文件、94 项测试通过，后端 `tsc --noEmit` 通过；本轮未重跑前后端全量套件。

- 录制 `task5-subagent-cancel-shell-stop` 中，被取消子任务的报告实际在下一次 prompt 内到达。工具缓存改为原生会话生命周期保留，避免发出无名 tool_use 覆盖旧 Agent/Bash 卡片；会话销毁时清理。空闲期间的更新仍不启动新回合。
- 空的非终态进度快照保留已有结果，不再将它替换成字面量 in_progress。补充真实录制断言、跨回合 shell 测试及取消后下一轮报告的 SQLite 持久化回归。
- 问题卡片的已回答判断仍要求紧邻 user 消息；fx 中间有 tool_result，因此旧问题仍可点击。这是现有共享 UI 的限制，不是“已回答后自动关闭”的承诺；本轮不改共享问题关联逻辑。UI 测试保留跨包导入，以直接验证实际归一函数与现有卡片的契约。

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

所有链接均在 [fixtures 目录](../packages/vibedeckx/src/protocol/fx/__fixtures__/)。这是协议探针通过，不是产品功能验收；探针完成时尚无 fx Provider；任务 4 的实现与验证见上节。

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
| result / turn_started | prompt 请求与响应驱动生命周期；stopReason end_turn 成功，cancelled 保留中断语义，记录 stopped 且不通知。后台任务收尾任务 5。 |
| native_session_id | new 的 sessionId；用于关联，不作为首版恢复入口。 |
| approval_request | command/fileChange 可由 shell/edit 映射；MCP kind other 无现有 union 对应项，需小范围扩展审批表达，或明确可见地拒绝，不能默认批准。 |
| formatApprovalResponse | 保留服务端 request id 与 optionId，发送 outcome.selected；allow_always 行为未测。 |
| formatInterrupt | session/cancel 通知，等待原 prompt 响应后进入下一轮；已验证。 |
| task_started / task_finished / task_list_changed / formatStopBackgroundTask | 任务 5 已补测：子 agent 利用 prompt 收尾；shell 无独立配对事件，不生成后台账本或停止按钮，不从 prompt 完成推断进程已结束。 |
| result 用量与成本 | response.usage.inputTokens/outputTokens 可映射；cacheReadTokens/reasoningTokens 额外字段，mini 另有 cacheWriteTokens；usage_update.used/size 是上下文占用，不能当本轮 token 用量。成本未出现，不填 0；任务 12。 |
| error | JSON-RPC error.code/message，包含认证 -32600、参数 -32602；要区分初始化/请求错误并停止失败初始化。 |
| onSessionCreated / onSessionDestroyed | 分配/清理 RPC、原生 id、工具/用量状态；不得跨会话泄漏。 |

明确需降级：禁用 plan、历史重放非无损、无原生 diff。明确的现有接口缺口：MCP 审批类型。它们不意味着要设计通用权限引擎。

## 功能对齐矩阵

Claude/Codex 列是当前仓库代码基线阅读结果，非本轮跨平台端到端验收；“共用路径”也不等于每种组合都测过。fx 的待实现项不表示协议实验已通过。

| 功能 | Claude Code 基线 | Codex 基线 | fx 状态（0.0.16 探针 / 0.0.17 产品） / 后续责任 |
| --- | --- | --- | --- |
| 会话与流式输出 | stream-json Provider | app-server Provider | 已实现；真实 Provider 与录制契约验证见任务 4 |
| thinking | thinking 事件 | reasoning 文本映射 | 已实现；真实 Provider 与录制契约验证见任务 4 |
| 工具卡片 | tool_use/result | item 事件映射 | 已实现；任务 5 归一到已有专用卡片，未知工具通用显示，真实录制回放与 UI 组件验证 |
| 审批 | edit 使用跳过权限；plan 原生模式 | 有 command/fileChange 映射；默认 approvalPolicy never | edit 使用 full-access，无人工审批 UI；权限请求仅直接取消并显示错误，见最新决策 |
| plan 与 ExitPlanMode | 原生 plan；产品接受计划后切 edit | plan 采用 read-only sandbox；非 Claude ExitPlanMode 协议 | 首版已禁用；UI capabilities 与后端显式拒绝，按已选决策执行 |
| AskUserQuestion | CLI 禁用该工具，退化为普通对话提问 | userInput request 映射 AskUserQuestion 工具事件；完整交互非本轮验收 | 0.0.17 ACP 明确不支持阻塞式提问；任务 5 复用问题卡片发送普通后续消息 |
| 后台任务显示 | 任务开始/结束/集合事件 | subagent 生命周期、outOfTurn 处理 | 子 agent 报告已验证先于 prompt response；shell 无可配对的独立生命周期事件，按任务 5 原则不显示后台条 |
| 后台任务单独停止 | stop_task | 无等价接口，退化为停止会话 | shell stop 工具调用已实测；产品没有后台条或单任务停止按钮，见任务 5 差异 |
| 中断 | 进程/管理器路径 | turn/interrupt | 已实现；真实 fx cancelled 后续问及管理器 Stop 保活测试通过 |
| 图片与文件附件 | 内容转换及工具读取路径 | image prompt / imageView 映射 | 未验证；任务 11；本任务只测普通文件读改 |
| 模型选择 | spawn --model | app-server -c model | 已实现；真实新进程切换模型 + 重放通过，不采用原生恢复 |
| 费用与用量 | result 成本字段 | tokenUsage 缓存到 result；不等同成本支持 | 已验证；token/上下文字段已录到；成本未验证 → 任务 12 |
| hub vibedeckx HTTP MCP | --mcp-config HTTP bearer | -c mcp_servers / token env | 已接入；本地真实 hub + fx 调用通过，线上需部署协议协商修复 |
| cross-remote HTTP MCP | 同上 | 同上 | 已接入；本地真实 hub 调用通过；线上握手修复待部署、授权远端与撤销完整验收未完成 |
| 休眠唤醒 | 管理器历史重放 | 共用管理器历史重放 | 已实现；管理器子进程 + SQLite 休眠唤醒回归通过；首版不用 load/resume |
| 切换 agent | 共用管理器迁移历史 | 共用管理器迁移历史 | 新 fx 会话 + 重放路径已接通；跨 agent 完整验收留任务 11 |
| 分支 / 截断分支 | 共用分支历史复制 | 共用分支历史复制 | 独立 fx id + 历史路径已接通；截断分支完整验收留任务 11 |
| 执行器 | prompt executor Claude CLI | codex exec CLI | 待实现；对应执行器接入任务；不能仅新增 Provider，routes 仍把非 codex 当 claude |
| 定时任务 | scheduler 调用执行器 | scheduler 传递 prompt_provider | 待实现；对应定时任务接入任务 |
| Reviewer | 现有产品入口，具体 agent 组合未复核 | 同左 | 未验证；对应 Reviewer 接入任务补齐，不在本探针实现 |
| Loop | workflow-repeat-loop 传 agentType | 同左 | 待实现；对应 Loop 接入任务 |
| Commander 派生 | 现有会话/MCP/执行器路径 | 现有共用路径，组合未复核 | 未验证；对应 Commander 接入任务补齐 |
| Windows | binary 检测有 win32 分支；本轮未实跑 | 同左 | 未验证；对应平台接入任务 |
| macOS | 现有非 win32 检测路径；本轮未实跑 | 同左 | 未验证；对应平台接入任务 |
| Linux | 现有 Provider；本轮未重跑 | 同左 | 已验证；Linux 基础会话产品验收见任务 4；MCP 为原探针证据，业务接入仍待后续任务 |
| 未登录错误 | 有启动错误路径 | 有启动错误路径 | 已实现初始化错误收尾；认证分类与其他登录场景留任务 10 |

未提供任务 5/10/11/12 之外的具体任务 id，表中按功能注明后续负责人任务，未杜撰编号或新建任务。暂无能力被擅自归为“超出基线”。

## 顺带项登记

- 长驻 shell、subagent 生命周期：**已补测 → 任务 5**，具体覆盖与差异见上节；取消 shell 回合不保证结束已 yield 的进程。
- ask_user_question：**已补测 → 任务 5**，0.0.17 ACP 不等待答案，复用问题卡片发送普通后续消息。
- 内联图片 prompt：**未验证 → 任务 11**。
- usage_update.used/size 及 prompt response.usage token 字段：**已验证**；未出现成本字段、跨模型统计细节 **未验证 → 任务 12**。
- 未登录错误：**已验证 → 任务 10**。错误发生在 initialize，不是仅退出进程。
- 版本不符/额度用尽：**未验证 → 任务 10**；未耗尽额度取样。
- stdio MCP：不属于本任务要求，未验证；此范围豁免不表示三方都没有该能力。

## 建议：继续做产品接入，首版按上述边界收敛

五个阻塞项都有真实录制，两个决策已定：禁用 plan，恢复只实现新会话加历史重放。无需因协议可行性放弃；优先补齐 Provider 状态机、MCP 命名规范化与审批类型缺口，再推进产品入口。

剩余产品验证按矩阵交后续任务。探针本身没有实现产品功能；任务 4 已实现基础接入代码并解决权限/OAuth 阻塞，验证范围见本文任务 4 小节，后续完整产品验收仍须覆盖其余矩阵项。

脚本/录制校验覆盖：双向 JSONL 可解析、RPC 对应、两轮记忆、取消后续问、工具状态、ask/auto 审批、两种恢复历史重播差别、MCP 服务端认证与调用、模型配置及参数错误。未跑无关产品全套测试；未改产品代码、未更新任务状态。

### Review 后的生命周期修正

- 未知 sessionUpdate 通知忽略，已知通知仍严格校验；prompt JSON-RPC error 仅结束当前轮次，连接仍可重试；握手失败或损坏协议结束轮次并退役进程，下次发送重建连接并重放历史。
- ACP help 能力探测按二进制路径和文件指纹缓存，升级后重新探测；首次探测仍使用有 5 秒上限的同步调用。
- 退出前必须收到结果由 provider 元数据声明，manager 不按 fx 名称分支，意外退出错误不再附加原始 stderr。Claude/Codex 同样在进程退出后进入可唤醒状态，并补充共享生命周期回归测试。
- 移除尚无调用来源的初始化 systemPrompt 参数；codec 保留经过探针验证的 append 构造支持。
- 本轮验证：`pnpm --filter vibedeckx test` 全量 3530 通过、11 跳过（含离线契约）；追加的取消竞态及 prompt 错误恢复测试所在 fx manager 套件 17/17 通过；后端 `tsc --noEmit` 通过。此次未重跑真实 fx/UI 验收。
