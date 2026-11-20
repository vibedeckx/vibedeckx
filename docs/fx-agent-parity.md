# fx 接入对齐矩阵（0.0.16 探针 / 0.0.17 产品验证）

## 状态与验收规则

fx 状态含义：**已验证**＝固定版本真实实验有录制，仅证明注明的范围；**待实现**＝产品改动尚未完成，不代表协议已验证；**未验证**＝缺少真实实验；**明确不支持**＝有版本限定及原因的缺口；**延期**＝承诺范围内推迟的能力；**超出基线（不做）**＝现有 Claude Code / Codex 也没有的能力。

“明确不支持”“延期”是承诺范围内的缺口，收尾时须用户确认；“超出基线（不做）”无需确认。**写了差异说明不等于通过验收。** 源码阅读、协议声明、参数被接受均不等于功能端到端可用。未验证不得写成不支持。

## 任务 7 最终收尾（2026-11-18）

本节和功能对齐矩阵描述当前状态；下文按日期保留历史实验，历史权限选择或验收缺口以较新的记录为准。任务关闭不自动等于所有验收条件通过。实测版本为 fx **0.0.17 / Linux x86_64、macOS arm64**，0.0.16 录制继续作为历史协议样本保留；不把这两个版本作为用户可用版本白名单。

### 已交付及证据

- 实际 CLI 版本沿用公共日志记录；ACP、ask、help 和版本探测均设置 `FX_AUTO_UPGRADE=0`。实际缺少能力、握手失败或协议损坏时明确报错；不增加未验证版本提示、安装器或升级机制。
- 会话、执行器和定时任务均使用 `full-access`。Plan 通过每条提示词的只读约束实现，不提供技术只读保证；2026-11-18 决策替代历史 auto / 禁用 Plan 策略。
- 服务 PATH 检查从 `AGENT_CLI_COMMANDS` 包含 fx，缺失只报告。worker Dockerfile 固定安装 v0.0.17，沿用 home volume 保存 `.fx`；此前独立安装阶段通过，不等于完整镜像已经发布。
- 正式 `fx.live.test.ts` 与 pinned/latest protocol-compat CI 已接入；录制离线 schema / codec / Provider 回放及 HTTP 日志格式检查已存在。按用户 2026-11-18 确认，本轮不配置 GitHub 付费凭据、不要求 CI 实跑；记录为“本机实测通过，GitHub CI 未实跑”，不作为验收阻碍。workflow 保留手动触发。本轮增加 `agent` 可选筛选，默认 `all`，选择 `fx` 仅跑该 agent 的 pinned/latest；不需要另外两家的凭据。
- 任务 9 的 siggst hub → ubuntu worker 真实 Review、Loop、Commander 及浏览器路径通过；任务 10 的认证 / 模型、任务 11 的附件 / 切换 / 分支 / 项目指令 / UI 生命周期均有记录。见各节及已提交的结果摘录。
- 原 Python 检查由 `protocol/fx/recordings.test.ts` 和正式 Provider / live 测试接管。本工作区再次检查没有 `.dev/scripts/fx-acp-*.py` 或 `verify-fx-recordings.py`，无需删除；矩阵、fixtures 和 README 保留，正式复验不依赖 `.dev`。

### 平台验收范围

| 项目 | 当前证据 / 后续动作 |
| --- | --- |
| macOS / arm64 | fx 0.0.17 的真实 Provider 生命周期、执行器输出 / 停止、cron 报告落库通过，详见下节。未在 Mac 重跑浏览器 / Reviewer / Loop / Commander；这些入口的真实远端验收见 Ubuntu 记录。Linux arm64 和 macOS x86_64 不在本轮实机覆盖内，不据此声称全平台验收。 |

### 功能差异与确认状态

| 差异 | 当前处理 / 确认状态 |
| --- | --- |
| Plan 无技术只读隔离 | 用户 2026-11-18 已选择提示词约束方案；不再请求重复确认。 |
| Windows 无 fx 原生版本 | 任务 12 已确认明确不支持；仅文档说明。 |
| 无后台任务条和单任务 Stop | 任务 12 已确认单任务停止不支持；停止回合不保证结束已 yield 的 shell，公开文档保留说明。 |
| 提问与答案提交 | fx ACP 工具立即返回仅交互 shell 可用，卡片答案作为普通后续消息。Claude Code 在产品中禁用 AskUserQuestion、改用文本问答；Codex 映射请求为同一问题卡片，但当前答案提交也是 sendMessage，未接 requestUserInput 的专用响应。因此不能将阻塞式工具回填当作现有产品已交付基线，不再作为 fx 独有差异请求确认。 |
| 历史恢复 | 三种 agent 共用产品历史重放到新会话；工具内容截断、thinking 和复合消息限制见任务 11。属于共有行为，不是 fx 对齐缺口，不请求额外确认。 |
| 编辑卡片 | fx 与 Claude Code 的 Edit 共用 old_string/new_string 局部替换卡片，已对齐该基线。Codex FileChange 则展示上游提供的 diff（若有）；这是卡片数据格式 / 展示差异，不能称 Codex 保证整个文件的完整前后差异。无需为“完整文件 diff”新增基线承诺。 |

无新增“延期”决定。动态模型发现、原地换模型、执行器 ACP 流式工具展示、原生磁盘清理等“超出基线（不做）”继续按既定范围，不逐项请求确认。

### 2026-11-18 本轮回归与发布影响

- 实测 CLI：fx **0.0.17**、Claude Code **2.1.325**、Codex **0.159.2**，Linux x86_64；沿用原登录，不升级 CLI 或复制 OAuth 凭据。最新版 CI 尚未执行。
- 前后端 `tsc --noEmit`、`pnpm build:main`、`pnpm build:docs` 通过；修正 Codex live 测试后后端 tsc 再次通过。生成 HTML 的 fx 锚点、登录 / 诊断命令及执行器链接已检查。
- 两端全量 Vitest（`--maxWorkers=2`，未开启重试）：后端 **249 文件 / 3652 tests passed**、2 文件 / 11 tests 按既有配置跳过；前端 **187 文件 / 1729 tests passed**。后端包含兼容注册表 **7/7**、正式 fx Provider / codec / schema / 录制回放。
- fx 真实生命周期 **1/1**，本机执行器 live **3/3** 通过（包括历史 auto 失败、full-access 显式规则、真实模型输出 / 停止 / cron 报告）。这些结果不替代远端验收。
- Claude 基础对话、工具、多轮、一次性执行 **4/4** 通过；Codex 握手、usage、命令、编辑、取消、一次性执行及两项 MCP **8/8** 通过。扩大回归时原有两个 Codex 审批测试首次失败：`on-request` 下普通 echo 不会要求审批，accept 测试未收到请求，decline 测试也未实际回复过拒绝。已将提示词明确为请求提权，并为 decline 补“确实收到审批请求”和协议校验断言，为 accept 补实际输出断言；这是测试前提修正，没有修改产品权限。修正后两项真实测试 **2/2** 通过（`--retry 0`）；保留首次失败，不称整个 live 套件首次全绿。
- `actionlint` 通过；从 workflow 提取 matrix 生成代码执行，`all` 为 6 cells，三个单 agent 筛选各为 pinned/latest 2 cells。GitHub Actions 未实跑；按用户决定不作为本轮完成条件，未来需要时再配置专用凭据并手动运行。
- `classify-diff` 对 origin/main、v0.3.58 均为 **gray**；本轮相对 HEAD 的文档 / workflow / live 测试为 **non-runtime**；追加结果 JSON 被分类器保守标为 **gray**，人工核对仅为验收证据，不作为产品运行输入。本轮不改变隧道方法、payload 或能力注册表，不单独要求 worker 发布。
- 已构建当前源码，并用隔离 hub / worker 对 npm 最新 **0.3.58** 运行跨版本验收：**49 passed / 0 missing / 0 failed**。未操作现有 worker 服务。
- **整个 fx 分支仍需要发布 npm 并升级 worker**：旧 worker 不会因只部署 server 获得 fx Provider、ask 执行器及 Verdict 解析修复。Docker 预装也需要新镜像发布。旧 worker 既有能力兼容通过不代表旧 worker 已支持 fx；发布说明应保留这一区别。本轮未发布或部署。
- 已再次核对[官方安装说明](https://fx.sh/docs/getting-started/installation)和[认证说明](https://fx.sh/docs/getting-started/authentication)，公开文档补充 worker 同用户登录、认证后重发、status/doctor 与模型权限；保留平台实测边界。

### 任务 7 追加：Ubuntu 跨机器最终验收（2026-11-18）

用户授权 Mac / ubuntu 远程测试。Mac 为 Darwin arm64；经用户授权安装 fx 0.0.17 并由用户完成登录；后续平台测试结果见 macOS 追加记录。Ubuntu 为 Linux x86_64，已有 fx **0.0.17 / revision d1d4a883382d** 和原始 Gateway 登录。Mac 到 Ubuntu 直连超时；改用当前开发机 **worker3 运行隔离 hub，ubuntu 运行隔离 worker**，经 Ubuntu 已有 SSH 连接的回环转发承载产品 reverse-connect WebSocket。两端只监听回环，不开放无鉴权公网服务。两端 bundle SHA-256 同为 `6beb7fd7d22a46f5a412b0fb3aaff53a7b13474b743ddf1b5fe1f6eb0adcc726`。

| 场景 | 实际断言与结果 |
| --- | --- |
| 执行器成功 | hub 创建 fx prompt executor 并指定 Ubuntu；返回 remote process ID，hub WebSocket 收到 stdout `FX_REMOTE_EXEC_OK`、finished exitCode 0 和同样的 finalResult。 |
| 执行器停止 | 真实 fx 调用 sleep 30 后，由 hub Stop 路由停止；WebSocket 收到非零退出，结束时确认临时工作区无遗留进程。 |
| 执行器失败 | 仅重启临时 worker，使用无凭据的隔离 HOME / XDG / FX_HOME；真实 fx ask 报 Gateway 登录错误，hub 收到原始 stderr 和 exitCode 1。未读取、复制或更改用户凭据。 |
| 定时任务成功 | hub 的真实 cron 自动触发（未调用 run-now），target 为 Ubuntu；run 的 remote process ID、completed、exit_code 0、output/report `FX_REMOTE_CRON_OK` 均通过详情 API 核对。触发后禁用测试 schedule，只有一次运行。 |
| 定时任务超时 | 独立 cron 的 timeout_seconds=3；实际远端任务被停止，run.status 为 `timeout`，没有误报 completed；测试 schedule 已禁用。 |
| fx 与 hub MCP | 实际产品管理器启动本机 fx 0.0.17，会话调用 remote list / remote_bash（Ubuntu 实际输出 `FX_MCP_REMOTE_OK`）及 propose_task。提议未接受，未创建任务。 |
| MCP 授权撤销 | 在真实 worker 打开并 ping 临时 stdio MCP broker；通过产品消息路由将测试会话 grantedRemoteIds 清空。随后 HTTP MCP 客户端使用同 token 调用 remote_bash 及已有 handle，均返回 isError / not granted，列表为空。此处是直接客户端验证拒绝，不声称模型在撤权后继续调用。 |

临时 hub 的 canonical `local` tenant、会话、签名 token 和授权均为隔离测试 fixture；MCP liveness 使用真实产品会话，没有 mock `getSessionProcessAlive`。测试使用真实 Provider、网关和 worker；broker 的 stdio 服务是最小测试 fixture，不是模型替身。

保留首次脚本失败：cron 查询变量遮蔽导致驱动报 ReferenceError；修正后只读核对原两次 run，不重复付费执行。MCP 第一次激活因 fixture owner 与 canonical local 不匹配被 400 拒绝，修正测试 fixture 后成功；没有修改产品鉴权。原失败及后续实测摘录见 [task7-remote-results.json](fx-acceptance/task7-remote-results.json)。它是产品验收证据，不是 ACP 原始录制，也不作为运行时输入。

结束后停止测试 source 会话、hub、worker、SSH 转发与 broker，确认远端临时工作区无剩余进程；轮换并删除临时连接令牌、删除本轮远端临时目录。生产 worker 未发布、升级或重启。本轮不修改产品运行时代码，沿用上节已通过的全量回归；追加证据后正式 recordings / Provider 回放 **14/14** 通过，JSON 证据及 gateway audit 一致性检查、`git diff --check` 通过。公开生产部署仍是发布动作，不能把隔离验收写成已经上线。

复验：两台机器使用同一待验收 bundle 和各自兼容的 Node/native modules，以隔离 data-dir 启动 hub / worker；确认 reverse-connect online，创建绑定远端目录的项目，通过 hub 创建 fx executor / schedule，并按上表核对 WebSocket 和 schedule run 详情。失败场景只对临时 worker 隔离认证环境。MCP 使用真实产品源会话和测试授权，先实际成功调用，再撤销授权核对同 token 与已有 handle；不要操作生产授权或复制个人 OAuth 凭据。正式本机用例仍见 `fx-executor.live.test.ts` / `fx-hub.live.test.ts`；本轮临时驱动不是正式测试的运行依赖。

### 任务 7 追加：macOS arm64 验收（2026-11-18）

用户授权安装后，使用官方安装脚本安装 fx **0.0.17 / revision d1d4a883382d**，确认 Mach-O arm64；用户自行完成 Gateway 登录。Node **22.16.0**，所有 fx 子进程仍设置 `FX_AUTO_UPGRADE=0`，没有复制凭据或修改默认模型。

复用正式 `fx.live.test.ts` 与 `fx-executor.live.test.ts` 的测试体和生产模块，在本地 esbuild 打包后传至 Mac 临时目录。Mac 使用临时串行 Node runner，以 `node:assert` 适配测试注册、断言和 waitFor；原生 SQLite / node-pty 复用已安装 worker 的模块。**这是实际产品模块测试，不声称在 Mac 执行了 Vitest 全量套件**；没有改动生产 worker 或安装额外依赖。四项首次通过，无重试：

- 真实 ACP：排队的两轮记忆、thinking、工具执行、取消与后续继续；重启切换 grok-4.7 → gpt-5.4-mini，确认新会话 ID、选定模型和历史标记；每条消息校验协议契约，用户 settings 字节不变。
- 历史 auto 非交互权限失败：真实 CLI + 本地合成模型，明确返回 `NonInteractivePermissionRequired`。
- 产品 full-access argv：真实 CLI + 本地合成模型，即使显式 ask 规则也完成测试文件写入；只发生在隔离目录。
- 真实 ProcessManager / Scheduler / SQLite：沿用用户默认 `zai/glm-5.3-flashx-legal`，收到 `FX_PRODUCT_OK`、exitCode 0 与 finalResult；启动 sleep 后 Stop 收到非零退出且不再运行；真实 cron 自动触发，completed / exit_code 0 / `FX_CRON_OK` 报告落库。

测试 hooks 完成后，显式停止仍保留事件循环的临时 runner，确认其无子进程，并删除该测试目录。未发布、升级或重启生产 worker。Mac 未重复浏览器及 Reviewer / Loop / Commander 验收；这些入口沿用已记录的 Ubuntu 跨机器证据，Linux arm64 / macOS x86_64 不作实测声明。

结果见 `docs/fx-acceptance/task7-remote-results.json` 的 `macInspection`；真实 ACP 录制为 `task7-macos-fx-lifecycle-{1,2}.jsonl` 及相邻版本 metadata，HOME / 工作区路径已脱敏。正式 schema 自动纳入新录制，Provider 回放参数化覆盖 Linux 与 Mac，**8 文件 / 86 tests passed**；后端 `tsc --noEmit`、证据脱敏 / JSON 校验及 `git diff --check` 通过。再次运行 `classify-diff HEAD`：测试和文档为 non-runtime，新 fixtures 为保守 gray；均非运行时输入，无隧道契约变化，本次 Mac 验证不新增 worker 发布要求。临时适配 runner 不作为长期第二套测试；复验使用仓库正式 live 用例（`FX_EXECUTOR_LIVE=1`），不依赖 `.dev` 或本次临时脚本。

### 2026-11-16 历史回归记录

- 前后端 `tsc --noEmit`、`pnpm build:docs` 通过；生成页面的 fx 锚点与安装命令已检查。
- 后端全量 Vitest：247 文件通过、2 文件跳过，**3602 passed / 11 skipped**。前端全量首次 **1722 passed / 1 failed**，失败为此前已记录的 Shiki `startIndex` 异常（未改动的 `symbol-tokens.test.ts`）；单文件允许一次重试后 8/8 通过，随后全量 `vitest run --retry 1` **187 文件 / 1723 项通过**，该次全量未发生重试。未修改 UI 或 Shiki 实现。
- fx 真实生命周期和本地真实 hub 两项通过；生命周期增加逐轮记忆断言后再跑通过。新录制经离线 schema 与 Provider 回放通过。
- Claude Code 基础对话、工具、多轮 3 项，Codex 握手、命令、编辑、取消、一次性执行 5 项真实回归通过。Codex 编辑用例首轮选择 shell 而未产生 fileChange；仅将测试提示词明确为使用 apply_patch 后，该项复验通过，没有修改 Codex 产品代码。
- `actionlint`、workflow 内 shell 语法与 worker build.sh 语法检查通过；固定版本 Docker 安装阶段通过。
- `node scripts/classify-diff.mjs`（默认 origin/main）与 `node scripts/classify-diff.mjs HEAD` 均为 gray / non-runtime，无 wire-contract 变更。公共版本探测继承 spawn 环境属于 worker 可达代码，需要 worker npm 发布才在已安装 worker 生效；Docker 预装需发布新镜像。隧道方法、payload、能力注册表均未修改，不新增隧道版本门槛；fixtures 只是测试数据。


## 历史权限决策（2026-11-16；Plan 已由 11-18 决策替代）

用户明确要求与现有 Claude Code / Codex 一样不等待人工工具审批，**edit 改为 full-access**，替代原任务的 auto 决策。启动使用进程级 `fx acp --permission-mode full-access`，握手必须确认 `currentModeId=full-access` 后才发送消息；auto、ask 或未知模式均明确报错。此模式关闭 fx 权限检查及自动模型审查，操作系统权限和 hub 远端授权仍生效。当时 plan 禁用，11-18 已改为提示词约束支持；仍不调用会持久化配置的 `session/set_mode`。

按用户要求删除 fx 专用审批 UI、审批状态和人工回传接线；正常 full-access 会话没有已知会触发审批的场景。协议解析仅保留直接回复 `outcome: cancelled` 并显示错误的分支，不创建卡片、不等待用户、不默认批准。下文任务 4/5 及原探针中的 auto 记录是历史验证结果，不代表当前 edit 映射。

本次变更验证：fx 协议、Provider、录制回放与管理器共 105 项测试通过，后端 `tsc --noEmit` 通过。真实 fx 0.0.17 生命周期测试通过，确认 full-access 启动、工具回合无审批请求、多轮/取消/重建换模型正常，用户 settings 文件逐字节未变。旧工具录制保持原样，仅测试回放时适配握手模式，不将历史 auto 录制冒充 full-access 实测。

删除审批 UI 后验证：后端相关测试 100/100、UI 工具卡片与权限入口测试 23/23、前后端 `tsc --noEmit` 均通过。

## 任务 12：限制处理结论（2026-11-18，fx 0.0.17，Linux x86_64）

A 部分六项汇总。第 2、3 项“明确不支持”已于 2026-11-18 经用户确认。

| 项 | 状态 | 当前限制 | 本次处理 / 用户看到什么 | 证据 |
| --- | --- | --- | --- | --- |
| 1. Plan | **已支持，弱于基线** | fx 只有 ask / auto / full-access，plan 返回 Unknown mode；无沙箱，无技术只读手段 | UI 与其他 agent 相同可切 Plan；plan 期间每条 prompt 前加只读约束（不入库），进程仍 full-access；切回 edit 靠 UI 切换（同 Codex），无 ExitPlanMode。fx 可作 Reviewer。公开文档注明“仅提示词约束” | 0.0.16 探针（Unknown mode）；0.0.17 真实 live：plan 中拒绝写文件/改 README/`git add`，切 edit 后正常写入。单次样本。见“Plan 决策更新” |
| 2. Windows worker | **明确不支持**（上游无发布） | fx 官方只发布 macOS / Linux（x86_64、arm64） | 按用户决定只写文档；不做平台检测或 UI 禁用，命令缺失走现有“未安装”启动错误。macOS / arm64 已补 Provider / 执行器 / cron 实测（见任务 7）；不扩大为全部架构已验证 | 官方发布范围；本机 Linux x86_64 |
| 3. 停止单个后台任务 | **明确不支持**（与 Codex 一致） | `shell action=stop` 工具可停 shell，但 ACP 无可配对的后台任务 ID / 生命周期事件；取消回合不保证结束已 yield 的 shell | 不显示后台任务条和单任务 Stop（现有逻辑按 provider 是否实现 `formatStopBackgroundTask`）；只能停整个回合 / 会话 | 0.0.17 任务 5 录制 |
| 4. 费用 / 用量 | **已对齐基线** | ACP 无成本字段；有 input/output/cacheRead/reasoning(/cacheWrite) token 与上下文占用 | 完成提示显示 token 数，同 Codex；无成本不显示 $0；其余字段不展示（现有 agent 无对应 UI，超出基线）。这只是提示信息，不是计费 | 0.0.16 探针 + 0.0.17 Provider |
| 5. 稳定性 / 版本 | **已处理**（按用户决定与 Claude/Codex 对齐） | fx 0.0.x、默认自动升级 | 所有 fx 进程设 `FX_AUTO_UPGRADE=0`；只记录实际版本，不设白名单、不提示“未验证版本”。新版验证：protocol-compat workflow 的 fx pinned/latest live 契约测试（手动触发）。本机实测通过，GitHub CI 未实跑；用户已确认本轮无需配置该 secret 或实跑 CI，不作为缺口 | 任务 7 |
| 6. 执行隔离与自动审查 | **已核实** | fx 无沙箱：0.0.17 设置 schema 中 `sandbox` 为 “No longer used; fx ignores it”；full-access 关闭 fx 权限规则与 auto 模型审查 | 会话与执行器 / 定时任务均 full-access，与 Codex edit 的 `danger-full-access` 同级；agent 以运行 Vibedeckx 的用户权限执行，hub 远端授权仍生效。公开文档（quickstart、connect-a-machine）已说明 | 0.0.17 `fx config schema`；执行器 live 用例 |

B 部分（替代方案研究：真正只读的 Plan、Windows 可行性、上游停止后台任务计划）按用户决定（2026-11-18）不做；有实际需求时再另行评估。

## Plan 决策更新（2026-11-18，fx 0.0.17）

用户决定以提示词约束支持 fx 的 Plan，使各 agent 在 UI 上无差别；替代下文“首版禁用”。实现：

- `FxProvider` 不再声明 `planMode: false`，创建 / 切换 / 切 agent / Commander / Reviewer 的 plan 均放行（通用 capability 判断保留给未来 provider）。两种模式启动参数完全相同（`full-access`）。
- plan 模式下 `flush` 在每条 `session/prompt` 前插入独立文本块 `FX_PLAN_MODE_INSTRUCTIONS`（`protocol/fx/codec.ts`）：禁止任何方式写文件；禁止有副作用的命令（格式化、`--fix`、代码生成、依赖安装、向工作区写产物的构建/测试、git 写操作）；允许只读检查。该块只在 wire 上，不写入 transcript；切到 edit 时进程重建、历史重放不带该块。
- 用户确认不做事后 `git status` 检测（第 4 项）。

验证：provider 单测（文本/图片前缀、edit 不加、plan 与 edit 启动参数一致）；管理器子进程 + SQLite（plan 会话 wire 含约束、存储不含、switchMode 到 edit 后不再发送、Reviewer `prepareSessionRow` plan 放行）；真实 fx 0.0.17 live（`fx-parity.live.test.ts` “plan mode”）：plan 中明确要求建文件、改 README、`git add -A`，三者均未发生、`git status` 不变；切 edit 后同类请求正常建文件。单次样本，不代表所有模型都必然遵守。

## 执行器权限决策更新（2026-11-18，fx 0.0.17）

用户决定一次性执行器与定时任务和交互会话保持一致，`fx ask` 由 `--permission-mode auto` 改为 `full-access`（仍为单次请求参数，不改全局设置）。原因：auto 下用户配置里的显式 ask 规则会让无人值守运行以 `NonInteractivePermissionRequired` 失败（`docs/fx-acceptance/task8-auto-explicit-ask.json`）。新增 live 用例：真实 fx 0.0.17 + 合成模型 + `permission.bash["*"]="ask"`，按产品 argv 运行，shell 调用实际执行、exit_code 0；原 auto 用例保留为历史证据。真实模型的执行器 / 停止 / cron 用例复跑通过。fx 0.0.17 设置 schema 中 `sandbox` 标为 “No longer used; fx ignores it”，即 fx 无自带沙箱；公开文档 quickstart 已同步说明。

## Stop 决策更新（2026-11-20）

用户决定 fx 的 Stop 与 Claude Code / Codex 一致：发送 `session/cancel` 后直接终止进程，会话进入休眠，下一条消息重新握手并重放历史。原因：保活取消需要取消超时、二次 Stop 强杀、与 stdout 串行的计时器校验和独立的 `cancelled` 结果分支，只服务于 fx 一个场景，维护成本高于省下的一次重启与重放。

已删除 `keepAliveOnInterrupt`、`interruptOnly`、`cancelGraceMs`、取消计时器、`cancelled` 结果子类型和“Stop 取消了 N 条排队消息”提示（排队消息已在历史中，随重放送达）。provider 若仍收到 `stopReason: cancelled`，按普通非 `end_turn` 结果处理。下文任务 4/5 中关于保活取消、同进程续问和取消后迟到报告沿用原卡片的记录是历史验证结果，不代表当前行为。

## 权限参数探测移除（2026-11-20）

用户决定删除启动前的 `fx acp --help` 能力探测及其指纹缓存，`fx acp` 始终携带 `--permission-mode full-access`。原因：探测只为 0.0.16 服务，而安装提示、worker 镜像和 CI 均已要求 0.0.17 及以上；探测是同步子进程，首次或升级后最长阻塞事件循环 5 秒。握手阶段对 `currentModeId` 的校验保留。0.0.16 上 fx 会因不认识该参数而退出，对话中显示的是 fx 自身的 stderr（未在 0.0.16 上实测其文案）。下文关于按 help 探测决定是否传参的记录是历史行为。

## MCP 地址校验移除（2026-11-20）

用户决定删除 fx 专有的 MCP 地址校验（非 HTTPS、非 loopback 的 HTTP 地址在启动前拒绝）。原因：Claude Code / Codex 对同样的地址和 token 不做此检查，校验只让 fx 在内网 HTTP 部署下无法启动，并不能阻止 token 明文传输；且与“工具缺失不阻塞会话”的原则相反。若将来要禁止明文传 token，应在铸造 token 处对三个 agent 统一处理。下文“非 HTTPS、非 loopback 的 HTTP 地址在启动前明确拒绝”是历史行为。

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

- `src/protocol/fx/*.test.ts`：全部现有 ACP 录制经离线契约检查（包括未采用的 load/resume 录制的 envelope/update），以及参数、图片构造、ACP flag 探测与旧版拒绝策略测试。HTTP MCP 服务端录制现由 `recordings.test.ts` 单独校验，不冒充 ACP envelope。
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
- [真实未登录录制](../packages/vibedeckx/src/protocol/fx/__fixtures__/unauthenticated.jsonl)；历史录制由正式 `protocol/fx/recordings.test.ts` 校验；临时 Python 探针已清理，不作为交付依赖。
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

### Plan：首版禁用（已被 2026-11-18 “Plan 决策更新”替代）

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
| detectBinary / buildSpawnConfig | fx acp，env FX_AUTO_UPGRADE=0，传 --model；plan 与 edit 启动参数相同（2026-11-18 起 plan 靠提示词约束，原为后端拒绝）。注意 set_mode 持久化默认值的副作用。 |
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
| result 用量与成本 | response.usage.inputTokens/outputTokens 可映射；cacheReadTokens/reasoningTokens 额外字段，mini 另有 cacheWriteTokens；usage_update.used/size 是上下文占用，不能当本轮 token 用量。成本未出现，不填 0；任务 12 结论：已对齐 Codex 基线。 |
| error | JSON-RPC error.code/message，包含认证 -32600、参数 -32602；要区分初始化/请求错误并停止失败初始化。 |
| onSessionCreated / onSessionDestroyed | 分配/清理 RPC、原生 id、工具/用量状态；不得跨会话泄漏。 |

明确需降级：禁用 plan、历史重放非无损、无原生 diff。明确的现有接口缺口：MCP 审批类型。它们不意味着要设计通用权限引擎。

## 功能对齐矩阵

Claude/Codex 列是当前仓库代码基线阅读结果，非本轮跨平台端到端验收；“共用路径”也不等于每种组合都测过。协议实验、产品验收和上游平台支持分别列明，不互相替代。

| 功能 | Claude Code 基线 | Codex 基线 | fx 状态（0.0.16 探针 / 0.0.17 产品） / 后续责任 |
| --- | --- | --- | --- |
| 会话与流式输出 | stream-json Provider | app-server Provider | 已实现；真实 Provider 与录制契约验证见任务 4 |
| thinking | thinking 事件 | reasoning 文本映射 | 已实现；真实 Provider 与录制契约验证见任务 4 |
| 工具卡片 | tool_use/result | item 事件映射 | 已实现；任务 5 归一到已有专用卡片，未知工具通用显示，真实录制回放与 UI 组件验证 |
| 审批 | edit 使用跳过权限；plan 原生模式 | 有 command/fileChange 映射；默认 approvalPolicy never | edit 使用 full-access，无人工审批 UI；权限请求仅直接取消并显示错误，见最新决策 |
| plan 与 ExitPlanMode | 原生 plan；产品接受计划后切 edit | plan 采用 read-only sandbox；非 Claude ExitPlanMode 协议 | **已支持，弱于基线**（2026-11-18，fx 0.0.17）：UI 与其他 agent 相同可切 Plan；进程仍为 full-access，plan 期间每条 prompt 前加只读约束块（不入库）。无技术只读保证；与 Codex 一样通过 UI 切换退出 plan，无 ExitPlanMode。真实 fx 实测遵守，见“Plan 决策更新” |
| AskUserQuestion | CLI 禁用该工具，退化为普通对话提问 | userInput request 映射 AskUserQuestion 工具事件；完整交互非本轮验收 | 0.0.17 ACP 明确不支持阻塞式提问；任务 5 复用问题卡片发送普通后续消息 |
| 后台任务显示 | 任务开始/结束/集合事件 | subagent 生命周期、outOfTurn 处理 | 子 agent 报告已验证先于 prompt response；shell 无可配对的独立生命周期事件，按任务 5 原则不显示后台条 |
| 后台任务单独停止 | stop_task | 无等价接口，退化为停止会话 | shell stop 工具调用已实测；产品没有后台条或单任务停止按钮，见任务 5 差异 |
| 中断 | 进程/管理器路径 | turn/interrupt | 已实现；真实 fx cancelled 后续问及管理器 Stop 保活测试通过 |
| 图片与文件附件 | 内容转换及工具读取路径 | image prompt / imageView 映射 | 已验证：页面上传普通文件、内联 PNG、超过 5 MiB PNG 的文件路径降级；见任务 11 |
| 模型选择 | spawn --model | app-server -c model | 已实现；任务 10 验证默认配置、静态建议与手输、回合间新进程换模型；busy 拒绝、切 agent 清空模型有回归 |
| 费用与用量 | result 成本字段 | tokenUsage 缓存到 result；不等同成本支持 | **已对齐基线**：完成提示显示 input+output token 数（同 Codex），无成本时不显示 $0；cache/reasoning/上下文占用不展示（超出基线）。Claude 实际也不显示成本（读 `cost_usd`，CLI 输出 `total_cost_usd`，Claude 侧既有缺陷）。见任务 12 |
| hub vibedeckx HTTP MCP | --mcp-config HTTP bearer | -c mcp_servers / token env | 已验证；本地及隔离跨机器真实 hub + fx 调用通过，见任务 7；生产上线仍需部署协议协商修复 |
| cross-remote HTTP MCP | 同上 | 同上 | 已验证；真实 fx 调用 Ubuntu 远端命令；撤销测试会话授权后，同 token 的下一次远端调用及已有 MCP handle 均被拒绝，见任务 7；未部署生产 |
| 休眠唤醒 | 管理器历史重放 | 共用管理器历史重放 | 已实现；管理器子进程 + SQLite 休眠唤醒回归通过；首版不用 load/resume |
| 切换 agent | 共用管理器迁移历史 | 共用管理器迁移历史 | 已验证：Claude/Codex ↔ fx 四向真实切换、历史继续使用、模型清空；见任务 11 |
| 分支 / 截断分支 | 共用分支历史复制 | 共用分支历史复制 | 已验证：Codex ↔ fx、fx → fx 截断分支、独立原生 id，页面双向回传；见任务 11 |
| 执行器 | prompt executor Claude CLI | codex exec CLI | `fx ask --permission-mode full-access --json`（2026-11-18 按用户决定与会话一致，原为 auto）；stdout 最终 Markdown、stderr 进度，退出码判定，进程树停止；本机及 worker3 hub → ubuntu worker 跨机器实测通过，见任务 7 追加记录 |
| 定时任务 | scheduler 调用执行器 | scheduler 传递 prompt_provider | 同一 ProcessManager 路径，cron 触发、output/report/exit_code 落库；本机及 worker3 hub → ubuntu worker 跨机器实测通过，见任务 7 追加记录 |
| 执行器 ACP 流式工具调用展示 | stream-json | 最终结果基线 | 超出基线（不做）；不创建另一套 ACP 生命周期 |
| Reviewer | 现有产品入口，具体 agent 组合未复核 | 同左 | 本机 Claude ↔ fx 两个方向均已有两阶段启动、讨论、修复 / 复审及自动修复通过记录（2026-11-18）；fx Plan 为提示词约束，无技术只读保证；模型漏写结论等失败记录见任务 9。siggst hub → ubuntu worker 的双向真实 Review 及浏览器 fx reviewer 验收通过，详见任务 9 追加记录 |
| Loop | workflow-repeat-loop 传 agentType | 同左 | 本机 fx 0.0.17 产品路径已验证：多项、新会话、done 与校验失败即停；ubuntu 隔离 hub/worker 及 siggst hub → ubuntu worker 跨机器路径通过；浏览器创建 / Done / 失败门已核对，见任务 9 |
| Commander 派生 | 现有会话/MCP/执行器路径 | 现有共用路径，组合未复核 | 本机真实 Main Chat → fx spawn、续发、两次结果回传、单一 turn 收尾通过；ubuntu 隔离 hub/worker 及 siggst hub → ubuntu worker 跨机器路径通过；页面派生 / 审批续发 / 回传 / 单一 turn 收尾通过，见任务 9 |
| Windows | binary 检测有 win32 分支；本轮未实跑 | 同左 | fx 官方无 Windows 原生版本；按用户决定仅文档说明，沿用命令缺失错误，不做平台专用检测或 UI 禁用 |
| macOS / arm64 | 现有非 win32 检测路径；本轮未实跑 | 同左 | fx 0.0.17 实机 Provider 生命周期、执行器 / 停止和 cron 报告通过；Reviewer / Loop / Commander 与浏览器未在 Mac 重跑，见任务 7 平台范围 |
| Linux | 现有 Provider；本轮未重跑 | 同左 | 已验证 Linux x86_64；会话、执行器、模型及附件见任务 4/8/10/11，跨机器工作流见任务 9；HTTP MCP 授权边界单列 |
| 未登录错误 | 有启动错误路径 | 有启动错误路径 | 任务 10 已实现握手阶段认证分类、登录命令及原始错误；真实隔离 HOME 验证失败收尾，见下节 |
| 未安装 / 模型错误 | 安装提示 / 原始错误 | 安装提示 / 原始错误 | 未安装提示已有管理器回归；无效模型原始 HTTP 错误保持可见，失败结束等待 |
| 动态发现可用模型 | 无 | 无 | 超出基线（不做） |
| 不重启进程换模型 | 无 | 无 | 超出基线（不做）；不使用 session/set_config_option |
| provider / effort / fast UI | 本任务无对应基线 | 本任务无对应基线 | 超出基线（不做） |
| 额度等细分诊断 | 本任务无对应基线 | 本任务无对应基线 | 超出基线（不做）；保留原始错误 |

未提供任务 5/10/11/12 之外的具体任务 id，表中按功能注明后续负责人任务，未杜撰编号或新建任务。“超出基线（不做）”按任务明确范围登记，不作为延期验收项。

## 顺带项登记

- 长驻 shell、subagent 生命周期：**已补测 → 任务 5**，具体覆盖与差异见上节；取消 shell 回合不保证结束已 yield 的进程。
- ask_user_question：**已补测 → 任务 5**，0.0.17 ACP 不等待答案，复用问题卡片发送普通后续消息。
- 内联图片 prompt：**已验证，任务 11**；页面内联 PNG 与超过 5 MiB 的文件路径降级均有证据。
- usage_update.used/size 及 prompt response.usage token 字段：**已验证**；未出现成本字段；任务 12 判定已对齐 Codex 基线，不再补测跨模型成本。
- 未登录错误：**任务 10 已补认证分类与真实管理器验证**。错误发生在 initialize，不是仅退出进程。
- 额度用尽细分诊断：**超出基线（不做）**，保留原始错误；未耗尽真实额度取样，不称其为实测。版本只记录供排查。
- stdio MCP：不属于本任务要求，未验证；此范围豁免不表示三方都没有该能力。

## 历史探针建议（产品接入已完成，当前验收见顶部）

五个阻塞项都有真实录制，两个决策已定：禁用 plan，恢复只实现新会话加历史重放。无需因协议可行性放弃；优先补齐 Provider 状态机、MCP 命名规范化与审批类型缺口，再推进产品入口。

剩余产品验证按矩阵交后续任务。探针本身没有实现产品功能；任务 4 已实现基础接入代码并解决权限/OAuth 阻塞，验证范围见本文任务 4 小节，后续完整产品验收仍须覆盖其余矩阵项。

脚本/录制校验覆盖：双向 JSONL 可解析、RPC 对应、两轮记忆、取消后续问、工具状态、ask/auto 审批、两种恢复历史重播差别、MCP 服务端认证与调用、模型配置及参数错误。未跑无关产品全套测试；未改产品代码、未更新任务状态。

### Review 后的生命周期修正

- 未知 sessionUpdate 通知忽略，已知通知仍严格校验；prompt JSON-RPC error 仅结束当前轮次，连接仍可重试；握手失败或损坏协议结束轮次并退役进程，下次发送重建连接并重放历史。
- ACP help 能力探测按二进制路径和文件指纹缓存，升级后重新探测；首次探测仍使用有 5 秒上限的同步调用。
- 退出前必须收到结果由 provider 元数据声明，manager 不按 fx 名称分支，意外退出错误不再附加原始 stderr。Claude/Codex 同样在进程退出后进入可唤醒状态，并补充共享生命周期回归测试。
- 移除尚无调用来源的初始化 systemPrompt 参数；codec 保留经过探针验证的 append 构造支持。
- 本轮验证：`pnpm --filter vibedeckx test` 全量 3530 通过、11 跳过（含离线契约）；追加的取消竞态及 prompt 错误恢复测试所在 fx manager 套件 17/17 通过；后端 `tsc --noEmit` 通过。此次未重跑真实 fx/UI 验收。


## 任务 8：一次性执行器与定时任务

- 协议构造和最终 JSON 解析位于 `protocol/fx/cli.ts`。使用 argv 直传（无 shell/PTY），`FX_AUTO_UPGRADE=0`，关闭 stdin；stderr 实时显示进度，stdout 在完成后解析 `output` 和 `final_output`。原生退出码和 JSON `exit_code` 任一非零都视为失败；非法 JSON 不能算成功。停止复用进程树终止，信号退出不能算成功或继续列为运行中。
- 当前产品权限策略：2026-11-18 按用户决定固定 `full-access`，与会话一致，不改用户全局设置。下列 auto 录制是历史实验；真实 full-access + 显式 ask 规则及真实模型复验见“执行器权限决策更新”。
- 本机 fx **0.0.17**（不是原始任务中的 0.0.16）实测 `ask --help` 支持上述 flag。真实 `auto --json` 文本请求退出 0；`ask --json` 的 shell 审批请求在 1.84 秒退出 1，JSON error 为 `NonInteractivePermissionRequired`，stderr 含 `noninteractive_permission_prompt_unavailable`。非法 `--config permission.bash.*=ask` 退出 2 / `InvalidAskArgs`，因此没有用它声称验证 auto 的显式 ask 规则。未修改用户设置或复制凭据。
- 真实 CLI 记录：`protocol/fx/__fixtures__/task8-ask.json`。产品测试：`FX_EXECUTOR_LIVE=1 PATH=/usr/bin:$PATH pnpm --filter vibedeckx test:compat src/protocol/live/fx-executor.live.test.ts --retry 0`，覆盖输出/最终结果、停止、真正 cron 定时触发及 SQLite 详细结果里的 report。第一次探针误从不含 report 的列表接口读取报告，改为 getById 后通过；不将该首次失败称为产品失败。
- 远端仍走 worker 的同一 `POST /api/path/execute` 与 ProcessManager；worker 现在原样接受 `prompt_provider: "fx"`（未知值 400）。不做旧 worker 兼容：旧 worker 会把 fx 强转为 Claude，所以必须在使用前统一升级所有 worker。日志、停止、finished/finalResult 帧不变。
- `/compat-check` 注册表对账通过；origin/main 与 v0.3.58 两个 classify-diff 均为 wire-contract + gray（也包含分支已有的改动）；当前 server 对已发布 worker **0.3.58**：49 smokes passed，0 missing，0 failed。未新增 tunnel 入口，注册表快照不变。**需要发布 npm 并升级 worker** 才能在远端使用此功能。
- 使用隔离 FX_HOME、无认证的本地合成模型服务，再以真实 fx 0.0.17 执行 auto + `permission.bash["*"] = "ask"`：0.04 秒退出 1，`NonInteractivePermissionRequired`，stderr 明确 `permission required by configured rule`。记录为 `docs/fx-acceptance/task8-auto-explicit-ask.json`，live 测试可复现。这验证真实 ask 的权限执行，不是 ACP 推论，也不是外部模型验收；原用户设置/凭据未改动。
- 检查结果：前后端 `tsc --noEmit` 通过；后端全量 248 个文件 / 3619 tests 通过（11 skipped），后续受影响用例复跑通过；前端全量 `--maxWorkers=2` 187 个文件 / 1729 tests 通过。首轮高负载下 Shiki symbol-tokens 出错，独立复跑和降低并发后的完整套件均通过，未修改该模块。真实 fx live 两项通过；`git diff --check` 通过。
- 此处原保留的外部远端真实模型 / 停止 / 定时验收已由 2026-11-18 任务 7 的 worker3 hub → ubuntu worker 实测补齐，见下列追加记录；不是以本机或合成模型结果替代。

协议参考：[fx ask 官方说明](https://fx.sh/docs/using-fx/fx-ask)。

## 任务 9：Reviewer、Loop、Commander 派生（2026-11-17）

**以下为 2026-11-17 阶段记录；剩余验收已在 11-18 跨机器及浏览器追加记录中补齐。** 本机 Linux x86_64、fx 0.0.17；以下是实际运行的产品服务集成测试，不代表浏览器交互或外部远端 worker 已验收。所有测试使用隔离临时仓库和 SQLite、真实 `createServer` 与原始登录凭据，不修改线上配置。

- Loop：真实 fx 连续处理 alpha / beta，两项使用不同会话，第二项 `Status: done` 后不创建第三项；另一次运行的校验命令退出 7 后停在 `waiting_resume`，不派发下一项。离线回归另覆盖失败回合即使含 `Status: done` 也不能成功、fx/model 逐轮保留。
- Commander：真实 Main Chat 模型（DeepSeek）派生 fx，收到第一轮完成事件，再发送固定第二条消息，收到第二轮完成事件；断言 fx 两个 `turn_end`、Commander 一个 `turn_end` 且 turn 清空。事件唤醒后的 send 沿用 Main Chat 审批卡，测试只通过正常审批入口批准固定的无工具消息；没有关闭审批或伪造完成事件。首次测试遗漏这一步，停在审批卡而超时，补齐用户动作后通过。
- 单次 Review / 讨论：Claude 审 fx 作者，prepare 阶段确认 reviewer 尚无进程，activate 传入 brief，真实产生 `needs-changes`；讨论轮次进入 `discussing`，显式请求终稿后回到反馈门，fx 根据反馈修复，继续同一 reviewer 复审得到 `ship`。测试标记 `FX_REVIEW_AUTHOR_PASS`。这里验证 brief 的传递和使用，未调用浏览器侧蒸馏模型。首次测试指令“先不要改文件”缺少后续授权，作者拒绝修改；明确分阶段授权后修复成功。另一轮测试误把成功 verdict 写成 `pass`（实际协议为 `ship`），修正测试断言后完整通过；均未为测试改变产品判断。
- 自动 Review：Claude Code 2.1.325 审 fx 作者，真实 `needs-changes` 自动回传、fx 修改 `sum.cjs` 并使 `sum(2,3) = 5`、同一 reviewer 第二轮 `ship` 均通过。测试标记 `FX_AUTO_REVIEW_PASS`；没有手工插入 verdict 或完成事件。
- Project Chat：`create_agent_session` 在创建操作记录 / 要求选择工作区前检查 plan 能力，当时 fx plan 明确报错并提示 edit；2026-11-18 已按 Plan 提示词约束决策解除拒绝。本地 / 远端 Commander spawn 的 fx 透传有回归覆盖。spawn 工具描述从 `DEFAULT_AGENT_TYPE` 和 `AGENT_TYPES` 生成默认值与可用列表。
- 提示词核对：Loop 的 plan preset 指“按计划文件工作”，会话始终是 edit；默认文件为 `docs/implementation-plan.md`，没有 `.claude/plans/` 或专属工具名假设。Review 使用通用文本 Verdict 协议，新建和复审均使用 plan。2026-11-18 用户已确认 fx Plan 使用提示词约束，底层仍为 full-access，无技术只读保证；原阻塞已解除，真实验收记录见下。
- ubuntu 安装（2026-11-17 追加）：用户明确授权安装 fx。该机原无 fx，已安装官方 fx **0.0.17** 到 `~/.local/bin/fx`，用用户提供的 Gateway key 配置 `~/.fx/api-key`（0600，key 不写入仓库）。真实 `fx ask --provider gateway --model openai/gpt-5.4-mini --no-save` 返回 `FX_UBUNTU_READY`，退出 0。该机 Claude Code **2.1.81** 已登录；原有 worker **0.3.53** 未替换或重启。
- ubuntu 隔离测试：本分支 bundle 传入 `/tmp/fx9-acceptance`，SHA-256 与本地构建一致；复用已有运行时及原生依赖，独立 hub/worker、端口、SQLite 和测试仓库。测试通过 hub REST API 和真实 reverse-connect 隧道驱动 worker，模型调用及完成事件均真实。**hub 和 worker 同在 ubuntu；不是跨机器网络验收。** ubuntu 连接开发机临时 TLS 端口超时，期间远端短暂掉线后恢复；未改防火墙或线上 worker 配置。
- ubuntu Loop / Commander：Loop 两项会话 id 不同，第二项 done，校验命令退出 7 停在 waiting_resume；`REMOTE_PATH_LOOP_PASS`。Main Chat 使用 Gateway `openai/gpt-5.4-mini` 派生 fx、收到第一轮完成后续发、收到第二轮结果、一个 turn_end；`REMOTE_PATH_COMMANDER_PASS`。首次 Commander 测试与 Review 共用工作区，触发已有活动 agent 的保护；拆分独立工作区后通过，没有绕过该保护。
- ubuntu Review：Claude 审 fx 作者，经 prepare/activate、讨论、finalize、批准反馈、fx 实际修改 `sum.cjs`、复用 reviewer 复审得到 ship；`REMOTE_PATH_REVIEW_PASS`。首次测试缩短了 reviewFocus，reviewer 按分析回合而非缺失实现评审；恢复本机用例的明确验收范围后重跑。
- ubuntu 自动 Review：真实 needs-changes 自动回传、fx 将测试函数修为加法、同一 Claude reviewer 第二轮 ship；`REMOTE_PATH_AUTO_REVIEW_PASS`。日志在 ubuntu `/tmp/fx9-acceptance/{check,commander-check,review3,auto}.log`。测试后关闭隔离会话和 hub/worker，保留 fx 安装与用户授权的鉴权配置。
- 实机发现并修复：`**1. Verdict — ship**` 这种加粗包含编号的合法输出未被识别，现先去 Markdown 强调再去编号，保留精确匹配和否定拒绝，新增回归。另有 reviewer 最终回复只引用计划文件而缺少结论，通用 verdict 提示词现明确要求最终回复完整输出，不创建计划文件、不要求开始实现、不以文件/前文引用代替结论。两个修复均已在 ubuntu 隔离构建中应用并重跑 Review；没有复制或修改线上 worker 程序。


可复验入口：`packages/vibedeckx/src/protocol/live/fx-orchestration.live.test.ts`。设置 `FX_ORCHESTRATION_LIVE=1`，按现有 live config 运行；Main Chat 用例还需要正常的 `DEEPSEEK_API_KEY`（不写入仓库）。例如：

```bash
FX_ORCHESTRATION_LIVE=1 PATH=/usr/bin:$PATH pnpm --filter vibedeckx exec vitest run --config vitest.live.config.ts src/protocol/live/fx-orchestration.live.test.ts --retry 0
```

兼容性：按 `.claude/skills/compat-check/SKILL.md` 执行注册表对账（7/7）、origin/main 与 v0.3.58 两个 base 的 classify-diff（gray）、build 与已发布 worker 0.3.58 的跨版本检查（49 passed，0 missing，0 failed）。未修改隧道 payload、路由或注册表；本分支累计包含 worker 可达变更，远端必须发布 npm / 升级 worker 才能获得相应行为，不能仅部署 server。

本轮前后端 `tsc --noEmit` 通过；前端全量 Vitest（`--maxWorkers=2`）187 文件 / 1729 tests 通过。ubuntu 实机修复后，后端全量 Vitest（`--maxWorkers=2`）248 文件 / 3630 tests 通过，2 文件 / 11 tests 按既有配置跳过。四项新增 live 场景各自实跑通过（Loop、Commander、讨论/复审、自动修复）；不会把未运行的 fx reviewer 或跨机器网络组合计入通过数量；后续 ubuntu 实测记录见上。

任务 9 追加检查：两个 verdict 修复后的前后端 tsc 通过；后端全量中的注册表对账 7/7 通过；再次执行 origin/main、v0.3.58 classify-diff 和跨版本检查，49 passed、0 missing、0 failed。前端无改动，沿用本轮已通过的 1729 项结果。仍需后续发布并升级 worker 才能让正式入口使用这些修复；当前 ubuntu 的生产 worker 保持 0.3.53。该轮剩余验收为 fx reviewer 与真正跨机器 hub/worker；Plan 权限策略已于 2026-11-18 确认，后续本机验收记录见下。


### 任务 9 追加：fx reviewer 本机验收（2026-11-18）

用户已确认 Plan 采用提示词约束并授权真实模型调用。本轮使用 Linux、fx 0.0.17、Claude Code 2.1.325、隔离服务与 SQLite；fx reviewer 使用产品默认模型配置，fx 作者使用 `openai/gpt-5.4-mini`。

- 将现有两类 Review live 用例参数化为双向组合：Claude → fx 与 fx → Claude。检查 prepare 时 reviewer 未启动、会话类型与 plan 模式、activate、讨论、终稿、批准反馈、作者实际修复、继续同一个 reviewer 复审，以及自动反馈 / 修复 / 第二轮复审。等待回合结束时同时断言 `turn_end.outcome = completed`。
- 手动 Review 在首次评审及讨论终稿后检查仓库无改动、无新增未跟踪文件；复审前后比较 `sum.cjs` 内容、Git diff 与 status。测试数据库移到仓库外，避免 reviewer 把平台 SQLite/WAL 当成被审文件。这些断言只证明该样例在检查点保持不变，不构成 fx 技术只读保证。
- 首次真实 fx reviewer 复审输出 `## 1. Verdict`、下一非空行为 `**ship**`，原解析器只去掉一层 Markdown 前缀，导致 verdict 为 null；讨论终稿的同类 `needs-changes` 也受影响。修复为去掉连续前缀，仍要求值精确匹配，新增真实格式及否定 / 附带条件 / 多选拒绝回归。未把无法解析的结果默认为通过。
- 补测原有 Claude → fx 自动修复时，一轮 fx 作者仅描述修改方案，复审正确保持 `needs-changes`，因此该次失败。测试授权进一步明确“收到反馈后直接实施，不重复询问、不只提出方案”后，单独实跑通过；没有改写反馈或伪造 verdict。
- fx reviewer 自动用例另有一轮最终回复漏写 `Verdict`，原始会话确认未丢失输出；产品以 null 停在反馈门，没有自动继续。后续一轮把“首轮解释正确”作为 ship，未触发修复；自动用例 reviewFocus 因此补齐与手动用例一致的范围：验收实际工作区结果，解释 / 计划不算完成，覆盖首轮只解释的限制。两次均记为未通过，不以重试抹去记录。

- 最终本机结果：双向手动 Review / 讨论 / 复审均通过；双向自动修复分别单独复跑通过，fx reviewer → Claude 作者的最终自动用例约 32 秒。**这是各场景分别取得通过记录，不是四项首次整批全绿。** 首次整批的自动用例失败按上述原因保留。通过均来自真实模型与真实产品状态流转，没有手动补发 final verdict 来替代自动路径。
- 验证：前后端 `tsc --noEmit` 通过；后端全量 249 文件 / 3651 tests 通过、2 文件 / 11 tests 跳过；前端全量 187 文件 / 1729 tests 通过；`git diff --check` 通过。`compat-check` 注册表 7/7；origin/main 与 v0.3.58 classify-diff 仍为 gray / worker 可达变更；构建后对已发布 worker 0.3.58 的跨版本检查 49 passed、0 missing、0 failed。
- 临时运行日志：`/tmp/fx9-reviewer-live.log`（初次发现解析问题）、`/tmp/fx9-reviewer-fixed.log`（双向手动通过、自动首次失败）、`/tmp/fx9-author-auto-retry.log`（Claude → fx 自动通过）、`/tmp/fx9-reviewer-auto-retry.log`（评审范围歧义）、`/tmp/fx9-reviewer-auto-final.log`（fx → Claude 自动通过）；日志为本机临时证据，不是仓库交付物。
- 此次本机验收结束时尚缺 fx reviewer 远端、真正跨机器 hub → worker、浏览器交互和浏览器侧蒸馏；后续补测见下。正式 worker 需要发布并升级才能获得解析修复；本轮未发布、未改生产 worker。

复验 Review 两个方向（不运行 Loop / Commander）：

```bash
FX_ORCHESTRATION_LIVE=1 PATH=/usr/bin:$PATH pnpm --filter vibedeckx exec vitest run --config vitest.live.config.ts src/protocol/live/fx-orchestration.live.test.ts -t 'reviews|automatically relays' --retry 0
```


### 任务 9 追加：siggst → ubuntu 跨机器及浏览器验收（2026-11-18）

用户授权使用两台机器测试。本轮以 **siggst 运行临时 hub、ubuntu 运行临时 worker**，走 SSH 回环端口转发及产品 reverse-connect WebSocket。与之前两进程都在 ubuntu 的记录不同，这次请求确实跨机器。未开放开发服务的无鉴权公网入口：浏览器使用本机当前源码构建的静态 UI，经临时双向 TLS 网关连接 siggst；匿名 TLS 请求被拒绝。未修改防火墙或生产服务配置。

ubuntu 使用 fx 0.0.17、Claude Code 2.1.81；Main Chat 和 intent brief 使用 Gateway `openai/gpt-5.4-mini`。初始 hub/worker 构建 SHA256 为 `15ada8ed54c6b6b4ac6c4c75582f66cc77f81b2192116c9427e6926aa82a9628`；修复下述 Commander 问题后仅重启临时 hub，构建 SHA256 为 `6beb7fd7d22a46f5a412b0fb3aaff53a7b13474b743ddf1b5fe1f6eb0adcc726`。worker 保持原测试构建并自动重连。

| 场景 | 本轮证据 |
| --- | --- |
| 双向 Review | Claude 作者 / fx reviewer，以及 fx 作者 / Claude reviewer，均完成首次 needs-changes、讨论、终稿、反馈、实际修改、复用同一 reviewer 得到 ship；reviewer 四个正常结束回合，plan 模式。首次评审及讨论后仓库无变化，复审前后内容 / diff / status 不变。两种组合的自动修复均完成第二轮 ship，作者与 reviewer 各两个正常结束回合；实际 `sum(2,3)` 为 5。 |
| Loop | 跨机器两轮使用不同 fx 会话，done 后不生成第三轮；校验命令退出 7 后停在 wait_resume。浏览器从 New loop 选择 fx / 自定义项目来源创建循环，观察两个会话及 Done；也核对失败门。样例第二轮发 done，按既有契约只记录第一轮 alpha，UI 为 1 item done，不声称记录了两个完成项。 |
| 浏览器 Review | 从 Claude 来源会话打开 Review，选择 fx、With context；真实调用 `/api/workflow-runs/intent-brief` 并生成包含来源用户意图的 brief。页面发送讨论、Finalize review、Send feedback、等待作者修复、Continue last reviewer，最终 ship；刷新保留状态。独立项目从页面选择 Auto loop / 2 rounds，自动反馈、实际修改和第二轮 ship 全部完成。没有通过 API 填入替代 brief 或伪造 verdict。 |
| 浏览器 Commander | 在 Main Chat 提交测试指令，派生 ubuntu 上的 fx；收到 FIRST 完成事件后，在正常审批卡批准固定 SECOND 消息；同一 fx 会话完成第二回合、回传第二个事件，`complete_task` 成功，Commander 恰好一个 turn_end。 |

本轮发现并修复共用 Commander 计划 ID 问题：模型给新计划传 `planId: ""`，`ChatPlanState.apply` 用空值合并保留了空串；后续进度更新被当成新计划，completed 步骤无法通过新计划校验，最终不能 complete_task。改为对空 ID 生成 UUID，新增回归验证创建、更新同一 ID、清空未完成步骤。部署到临时 hub 后，页面 Commander 完整通过；另经真实模型明确传入空 ID，取得非空 UUID，再以该 UUID 更新为 completed 并正常结束。该额外回合独立于上表 Commander 的单回合断言。

保留原始失败记录，不把补核对伪装为首次整批全绿：

- 临时远端驱动的四项 Review 已完成工作流、文件不变及实际求和断言，最后误用 HTTP 会话对象的 `agent_type` / `permission_mode`，报 KeyError。修正为 `agentType` / `permissionMode` 后，对同四个已完成 run 做只读核对，确认 agent、plan 和 completed 回合数量；没有重复付费运行整个 Review 或改写原始失败结果。
- 原始 Commander 收到两次结果，但受上述空 ID 问题影响超时；修复后通过的是独立页面场景。额外空 ID 真实回归里，模型先发了不合法的新计划 in_progress，校验拒绝，随后自行改成 pending 并成功继续。
- 浏览器首次在作者仍运行时点复审得到 409；等作者真正结束再启动成功。临时 hub 重启后旧 Main Chat ID 的首次提交得到 404，页面重新取得会话后重发成功。这些尝试不计入成功回合。期间本机磁盘不足影响截图 / 审计文件写入，清理本轮可再生成的构建中间文件后重写并核验了证据。

实测摘录：[task9-cross-machine-results.json](fx-acceptance/task9-cross-machine-results.json)，包含原始失败结果、四项 Review 补核对、页面 run、Commander 两次事件和单回合结束、空 ID 真实工具调用。它是验收证据，不是运行时输入或原始 ACP 录制。临时原始日志在两机 `/tmp/fx9-cross-20261118/`，本机截图 / 审计在 `/tmp/fx9-cross-browser/`；这些临时路径不构成产品依赖。

收尾验证：后端全量 **249 文件 / 3652 tests 通过，2 文件 / 11 tests 跳过**；后端 tsc、构建、diff check 通过。前端本轮未改代码，当前源码 UI 构建通过，沿用前一轮前端 tsc 和 1729 tests 通过记录。按 compat-check 再次检查两 base，仍为 gray；全量测试含注册表 7/7，已发布 worker 0.3.58 跨版本检查 **49 passed / 0 missing / 0 failed**。

已关闭两机临时 hub / worker / SSH / TLS 网关及本机代理、浏览器，检查测试 worker 的 17 个子进程均已退出；轮换临时连接令牌并删除临时私钥。原生产 worker 未发布、未升级、未重启。本轮补齐任务 9 的剩余远端、跨机器和浏览器关键路径验收；未修改任务状态。fx Plan 仍只有提示词约束，以上样例不提供技术只读保证。正式环境获得 worker 侧 Verdict 修复仍需后续发布并升级 worker。

复验方式：使用两台机器分别运行相同待验收构建的隔离 hub / worker，先确认 reverse-connect online，再以任务 9 live 用例的固定缺陷项目执行双向手动 / 自动 Review、Loop 和 Commander；浏览器连接该 hub，按上表逐项操作并核对实际文件、run/session ID、turn_end 和 brief 请求。避免直接替换生产 worker，不能用同机 hub/worker 结果代替跨机器记录。


## 任务 10：模型选择与启动诊断（2026-11-17，fx 0.0.17）

- 保留静态建议 `spacexai/grok-4.7`、`openai/gpt-5.4-mini` 与自由输入，不校验模型白名单。不选模型时省略 `--model`；真实管理器完成默认模型请求，再切到 `openai/gpt-5.4-mini` 并完成请求。仍为退役旧进程、下一次 spawn/new 与历史重放，不依赖 ACP 原地换模型或 `--provider`。
- 认证分类位于 `protocol/fx/diagnostics.ts`：只在 initialize/session/new 的明确认证信息上增加未登录解释；不依据 `-32600` 单独分类。提示在 worker 所在机器、以 worker 用户运行 `fx login vercel` / `fx login codex` / `fx login grok`，登录后重发消息；保留原始错误，提供 `fx status --json` / `fx doctor --json`。
- 真实未登录测试使用临时 HOME/XDG 目录并覆盖继承认证环境变量，不复制或修改用户凭据。真实 ACP 初始化失败后管理器关闭连接并结束 running；离线真实 stdio 子进程回归另覆盖错误后不退出、修正配置后重连成功。
- 无效模型 `vibedeckx/invalid-model-task10` 的真实响应为 assistant 文本中的 `HTTP 404` / `model_not_found`，随后 prompt 返回错误 stopReason。原始错误作为正文保留，回合结束；不能假定所有模型错误都是 JSON-RPC error。来源无权限的 JSON-RPC 错误有离线透传回归，未使用无权限真实账户补测。
- 自动回归覆盖默认参数省略、模型自由输入、busy 拒绝、切 agent 清空模型、缺失可执行文件、认证与普通协议错误区分、原始模型错误与失败重试。真实集成测试：`pnpm --filter vibedeckx exec vitest run --config vitest.live.config.ts src/protocol/live/fx-diagnostics.live.test.ts`（会使用当前登录并产生少量模型请求）。
- 给任务 7 的公开文档要点：必须在 worker 机器以相同用户提前登录；ACP 不弹登录窗口；按配置来源选上述登录命令，Gateway 也可使用 `AI_GATEWAY_API_KEY`；登录后重发消息；status/doctor JSON 可辅助排查。模型建议不保证当前账户有权限，不选模型沿用 fx 默认配置。公开文档由任务 7 统一维护。
- 验证结果：前后端 `tsc --noEmit` 通过；后端完整 Vitest 249 文件 / 3647 测试通过（2 文件 / 11 测试按既有配置跳过），前端 187 文件 / 1729 测试通过；任务相关最终回归 4 文件 / 72 测试通过；真实 fx 集成 2 测试通过。
- 浏览器产品验收：当前源码 UI + 独立本地后端 + 临时项目，在隔离 HOME 下新建 fx 会话，界面显示未登录、三种登录命令与原始 `-32600`，Stop 禁用且输入框可继续使用。切回已有登录后同一会话默认模型返回 `FX_DEFAULT_UI_OK`；选择建议模型后实际进程为 `fx acp --permission-mode full-access --model openai/gpt-5.4-mini` 并返回 `FX_SELECTED_UI_OK`。手输无效模型显示原始 HTTP 404 / model_not_found 并结束等待；切换到 Codex 后模型恢复 Default。截图 `/tmp/fx10-unauth-ui.png`、`/tmp/fx10-model-ui.png` 仅作本机验收留档，不作为运行依赖。
- UI 构建：默认构建中止，webpack 重试遇到本机磁盘不足；仅为本次验收临时关闭 webpack 缓存后构建成功，构建配置已恢复，没有交付构建方式变更。


## 任务 11：剩余会话生命周期（2026-11-17）

本轮使用 Linux x86_64、fx **0.0.17**、Codex **0.159.2**、Claude Code **2.1.325**，真实 CLI 登录、隔离 Git 项目和 SQLite。未修改登录配置，未部署服务或升级 worker。没有发现需要新增 fx 专用运行时机制的缺口，本次交付为回归测试及验收记录。历史重放仍有工具内容截断、忽略 thinking、复合用户消息只重放文本等限制，不能称为无损恢复。

| 项目 | 状态与证据 |
| --- | --- |
| 切换 agent | **已验证**。真实 Claude → fx → Codex → fx → Claude，每次切换前设置旧 agent 的模型标记，切换后数据库 model 为 null、下一轮正确回忆 `ORCHID731`；5 次启动产生 5 个不同原生 ID。离线子进程测试另验证来自 Claude/Codex 的产品历史可直接重放到 fx，不要求来源有 fx 原生 ID。 |
| 分支、截断、回传 | **已验证**。真实 Codex → fx、fx → Codex、fx → fx；第一轮记录 FIRST_KEY，第二轮记录 SECOND_KEY，从第一轮 turn_end 截断，新会话只知道 FIRST_KEY，SECOND_KEY 为 UNKNOWN；数据库及实际 stdin 回归都排除截止点后的内容。新原生 ID 与父会话不同，父会话保留第二轮。页面分别操作 fx → Codex 和 Codex → fx 的分支、生成回答、Send back；父会话收到带 agent 来源说明的回答并继续完成回合。 |
| 项目指令 | **已验证，与 Codex 基线一致**。仅有 `CLAUDE.md` 时，Codex 和 fx 均回复 UNKNOWN；添加 `AGENTS.md` 后均回复只写在文件中的 `BIRCH492`。提示词要求不读文件、不调用工具，验证自动加载而非按路径临时读取。只读 CLAUDE.md 的兼容机制属于超出基线，不新增。 |
| 普通文件 | **已验证**。页面上传 `fx11-note.txt`，产品保存 `<vfile/>` 路径，真实 fx 调用 Read，回复文件内的 `FERN853`。 |
| 内联图片 | **已验证**。页面上传 64×64 红色 PNG，数据库用户消息包含 image 内容块，真实 fx 不调用工具即回复 Red。 |
| 大图片 | **已验证**。同样从页面上传有效 PNG（5,243,068 字节，64×64，含大 tEXt 元数据块），共用 composer 的 `MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024` 将其变成 `<vfile/>`，不发送内联 image 块；fx 用 shell 读取文件，准确报告字节数和尺寸。此证据证明路径降级及文件可读，不声称大图仍被内联视觉理解。 |
| 会话文件清理 | **已验证，与现有基线一致**。`deleteDormantSessionIfExpired` → repository `deleteIfExpired` 只删除产品数据库父行，entries/native_ids 等通过 FK 级联删除；三个 Provider 的 onSessionDestroyed 均只清理内存。真实 fx 测试删除自建分支，确认产品行及原生 ID 映射消失，而 `~/.fx/sessions/v2/<id>/log.jsonl` 逐字节保留。磁盘原生文件清理属于超出基线，不新增。 |
| 搜索、加星 | **已验证**。页面搜索 `IRIS516` 找到 fx 会话，选择结果打开对应 session 深链；加星后菜单变为 Unfavorite，数据库 favorited_at 已写入。 |
| 标题 | **已验证当前未配置标题模型的行为**：首条消息自动产生截断标题，分支标题加 `Branch -`；与其他 agent 共用生成器。测试实例未配置标题 API key，因此没有把这次回退标题冒充真实 AI 标题生成；真实 AI 标题服务调用不在本次实测证据内。标题服务不依赖 fx，该服务的独立实测不构成本任务缺口或收尾阻碍。 |
| 通知、深链 | **已验证**。真实完成回合产生 Task completed toast 和通知中心 Session result is ready；点击通知进入正确的 `?session=` 会话，搜索深链及直接刷新链接也能恢复历史。此处验收应用内通知，不涉及操作系统推送。 |
| 侧栏状态点 | **已验证**。真实 fx 执行 `sleep 12` 时，resident 行显示蓝色脉动状态点；回答完成后变为 lime 状态点。存在 resident 行时工作区主行按通用设计显示 idle，不能把该灰点误判为 fx 状态丢失。 |

### 可重复验证

- 离线：`pnpm --filter vibedeckx exec vitest run src/agent-session-manager.fx.test.ts`。新增 3 项覆盖跨 agent 产品历史、模型清空以及真正写入新 fx stdin 的截断分支，使用真实 SQLite/stdio 子进程、模拟 ACP。
- 真实 CLI：`FX_PARITY_RECORD_FILE=/tmp/fx11-results.jsonl pnpm --filter vibedeckx exec vitest run --config vitest.live.config.ts src/protocol/live/fx-parity.live.test.ts --retry 0`。需三种 CLI 已登录，会产生模型调用；只删除测试创建的临时项目和数据库，原生文件沿用产品保留策略。输出文件为追加模式，每次使用新文件名可避免混入旧记录。
- 实测结果摘录：[task11-product-results.json](fx-acceptance/task11-product-results.json)。它保存真实管理器的 assistant 文本、回合结果及原生 ID 数量，是产品结果摘录，**不是原始 ACP 录制**。删除分支的断言在 live 测试中，摘录只含删除后仍存在的父会话。
- 浏览器复验：在独立实例创建空 Git 项目，新建 fx 会话写入 `UI_KEY=IRIS516`；上传普通文本、小 PNG 和 >5 MiB PNG，检查消息及真实回答；从第一轮分隔线选择 Codex 分支，确认后续附件历史未复制；发送回答并点 Send back；再从 Codex 分支选择 fx 并回传。切换 agent 前选择模型，切换后确认 Default，再提问历史标记。通过搜索和通知入口打开同一会话并刷新，检查历史、加星和侧栏状态。
- 页面驱动的数据库摘录：[task11-browser-results.json](fx-acceptance/task11-browser-results.json)，保留附件标记、内联图片字节数（省略图像内容）、回答、回传来源说明、分支指针、加星和模型清空结果。
- 本机页面截图：`/tmp/fx11-attachments.png`、`/tmp/fx11-running.png`；临时服务日志 `/tmp/fx11-server.log`。这些路径仅作本机留档，不是跨机器运行依赖。

### 本轮检查结果

- 前后端 `tsc --noEmit` 均通过；后端全量 Vitest **249 文件 / 3650 tests passed**，2 文件 / 11 tests 按既有配置跳过；前端 **187 文件 / 1729 tests passed**。两边使用 `--maxWorkers=2`，未开启重试。
- 真实 CLI 最终复验 **6/6 passed**（`--retry 0`），包括 fx 原生文件保留断言；离线 fx 管理器 **33/33 passed**。本轮没有修改产品运行时代码。
- `git diff --check` 通过；`node scripts/classify-diff.mjs HEAD` 对测试/文档判 non-runtime，对 JSON 证据文件保守判 gray。证据文件不是运行时输入，不修改 server/worker 线协议，也不需要为本次测试及文档发布 npm/升级 worker。
- 本轮仅本机隔离实例，没有将结果外推为真实跨机器 worker、其他平台或操作系统通知验收。标题服务没有可用 API key，明确保留上述回退验证边界；没有新增“不支持”结论或改变既有产品策略。

最终复核补强：离线切换测试显式禁止首次握手，保证来源确实没有原生 ID；项目指令 live 测试新增 UNKNOWN 及无 tool_use 断言。补强后相关离线 3/3、真实指令 2/2 通过，后端 tsc 再次通过；未更改产品实现。
