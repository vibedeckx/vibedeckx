# Workspace 覆盖度：部分创建的可见性与补建（remote-only）

> 状态：**Phase A + Phase B 已实现**（2026-09-09，dev3 未提交）。
> 实现偏离/补充（Phase B）：
> - §5.2 对账落在 `reconcileReportedWorktrees`（`workspace-binding-backfill.ts`）：先 `snapshotLiveCheckouts` 再问 worker，error→ready 走 `setCheckoutStatusIfCurrent`，ready→墓碑走新增的 `markCheckoutDeletedIfCurrent`（单次条件写入，无「先认领再删」窗口），creating/deleting 不动，根 workspace 永不落墓碑。列表路由（当前 remote）、`?target=`、重连同步都对账；状态查询接口与链接时同步仍只增。
> - §5.1 注册表为准的列表：根行 + 当前 remote 的报告顺序（带其 git 事实）+ 其余按名排序；只透传 `branch/currentBranch/expectedBranch`，worker 的 `worktreePath` 不再进列表；离线回 200 + `stale: { serverId, name }`；`agent_mode` 未链接回 `activeRemoteInvalid: true`。侧栏在列表上方各显示一行提示。
> - 409 兜底放在**三条**创建路径：`/agent-sessions/new`、`/agent-sessions/prepare`、`/agent-sessions/start`（UI 首发走后两条，只拦 `/new` 拦不住）。响应体 `error` 是可读句子，机器码放 `errorCode: "workspace-missing-on-remote"`（与文中 `error` 放码不同，为了 toast 直接可读）。逻辑在 `workspace-presence.ts`。
> - `targets` / `unfinishedDelete` 服务端已停发（`findUnhealthyWorkspaces` 删除）；`present` 状态保留 ready 行上的 `error`（删除被拒的原因），半删 tooltip 仍显示它；前端琥珀 ⚠ 改从 `machines` 推导（`workspaceContradiction`），旧服务端的 `targets` 经 `machinesFromTargets` 兜底，前端字段留一版。
> 实现偏离/补充（Phase A）：
> - `machines` 里有本地路径的项目也带 `local` 一项（`serverId: "local"`，恒 synced），与 `targets` 处理一致；纯 SaaS 项目不受影响。
> - §10 里「全部 present → 不下发 `machines`」与「全部 present 也返回完整数组」互相矛盾，按 §4.1 取后者。
> - 现有 `registerReportedWorktrees` 对 `path_source = conventional` 的 error 行、在 worker 报告了该路径时会 `registerReadyCheckout` 回 ready——这是既有行为，`?target=`、状态查询接口、链接时同步都走它；状态查询接口的**响应**按同步前的注册表快照保留 `error`，但注册表本身可能已回正。§5.2 对账上线时统一处理。
> - `getRemoteConfig`（anchor 两条路由的 `target: "local"` 回退）也改为 `agent_mode`，与列表一致。
> - 状态查询接口对 `local` 机器直接读本机 git；单台 `timeoutMs` 15s；链接时同步 10s。
> 前置：Create New Workspace 弹窗已改为按机器勾选（`569ef180` 起），
> `POST /api/projects/:id/worktrees` 的 `targets` 接受 remote server id。
> 本文只考虑 SaaS 形态：项目没有本地路径，机器 = 已链接的 remote。
> `"local"` 目标在代码里保留，但不再是设计对象。

## 1. 问题

弹窗允许用户只在部分 remote 上创建 workspace。创建之后，这个「只在部分 remote 上存在」
的状态在产品里**完全不可见**，也没有入口在其余 remote 上补建。

核实到的现状（文件位置以 dev3 为准）：

| 事实 | 位置 |
|---|---|
| 侧栏列表 = `sort_order = 0` 那台 remote 的 git，前端不传 `target` | `worktree-routes.ts:622-635`、`use-worktrees.ts:185` |
| 会话跑在 `project.agent_mode` 指定的 remote 上，可在会话页头部切换 | `agent-session-routes.ts:980-1010`、`agent-conversation.tsx:1381` |
| 前端按 `projectId::agent_mode` 缓存列表，注释以为服务端也按它取，实际不是 | `use-worktrees.ts:96-101` |
| 只有「机器之间矛盾」的 workspace 才带 `targets`：半删、或某台 checkout 为 error | `workspace-health.ts:84-86` |
| 只在主 remote 之外存在的 workspace，不矛盾 → 不追加 → 侧栏没有这一行 | `worktree-routes.ts:155-167` |
| 注册表对非列表 remote 的行只在创建、删除、`?target=` 列出时刷新；重连同步只在有未绑定会话时跑 | `workspace-binding-backfill.ts:185-200` |
| 注册表同步只增不删（`registerReportedWorktrees`），手工删掉的 worktree 会一直「present」 | `workspace-binding-backfill.ts:48-78` |
| 覆盖度从注册表推导，不问远端，离线 remote 不会被算成「未创建」 | `withWorkspaceHealth` |

所以问题有两层：

1. **数据源**：列表由「某一台 remote 的 git」决定，那台是链接顺序上的偶然。只勾了 B
   创建的 workspace 在侧栏根本不出现，不是缺徽标，是看不见。
2. **状态表达**：「故意只建两台」和「操作失败」共用不了一个信号。前者是正常状态，
   塞进琥珀 ⚠ 会稀释真故障。

## 2. 目标与非目标

目标：

- 只要 workspace 在任一已链接 remote 上有活的 checkout，侧栏就有它。
- 每个 workspace 在每台 remote 上的状态（已建 / 未建 / 失败）有一份数据，徽标、
  tooltip、补建弹窗都吃这一份。
- 用户能从侧栏一步进入「在其余 remote 上补建」，缺的默认勾上，失败的可重试，
  已建的不可点。
- 「当前 remote」只有一个概念：`agent_mode`。列表、会话、diff 都跟它。

非目标：

- 不自动把 workspace 补齐到所有 remote。用户是有意选的，静默扩散会在别的机器上
  凭空建分支、占磁盘。
- 不在创建时强制「要么全建、要么别建」。
- 不做跨 remote 的工作进度同步。补建出来的 checkout 从 base branch 切，别的
  remote 上的提交不会过来（§6.4 有文案要求）。
- 不改 worker。所有改动在 hub 侧，不新增 server→worker 调用。

## 3. 术语

- **已链接 remote**：`project_remotes` 里该项目的每一行。集合记作 `linked`。
- **当前 remote**：`project.agent_mode`（一个 remote server id）。会话在这台上跑。
  `sort_order = 0` 的「主 remote」概念退居为「`agent_mode` 无效时的回退」。
- **覆盖度**：workspace 在 `linked` 中有活的 ready checkout 的 remote 数 / `linked` 大小。
- **活的 checkout**：注册表里 `deleted_at IS NULL` 的行。

## 4. 数据模型

### 4.1 列表项新增 `machines`

```ts
interface WorkspaceMachineState {
  serverId: string;
  name: string;                       // remote 名字，直接显示，不加 "Remote ·" 前缀
  state: "present" | "creating" | "deleting" | "error" | "absent" | "unknown";
  /** state = error 时：那台机器记下的原因（创建失败 / 删除失败后的恢复原因）。 */
  error?: string | null;
  /** state = absent 且有墓碑：这里删过。用于区分「删掉了」和「从没建过」。 */
  deleted?: true;
}

interface Worktree {
  branch: string | null;
  /**
   * 新服务端对每个 workspace 总是返回完整数组（每台已链接 remote 一项）。
   * 缺省只表示旧服务端没提供，前端不显示徽标、不推断任何状态。
   * 不设「省略 = 全覆盖」的特殊规则。
   */
  machines?: WorkspaceMachineState[];
  // Phase B 起服务端不再下发这两个字段；前端类型保留一版，只为读旧服务端的响应：
  targets?: WorkspaceTargetState[];
  unfinishedDelete?: boolean;
}
```

状态判定（对 `linked` 中每台 remote）：

| 注册表里这台的行 | state |
|---|---|
| 有活行且 `status = ready` | `present` |
| 有活行且 `status = error` | `error`（保留 `error` 文本） |
| 有活行且 `status = creating / deleting` | `creating` / `deleting`：显示进行中，不计入覆盖度分子，补建弹窗里置灰禁止重复操作 |
| 只有墓碑 | `absent` + `deleted: true` |
| 无这个 workspace 的行，且这台 remote 有完整同步证据 | `absent` |
| 无这个 workspace 的行，且**没有**完整同步证据 | `unknown`：hub 没确认过这台上没有 |

「完整同步证据」不能从现有行推导。单独创建、绑定远端会话（`remote-agent-sessions.ts:124`，
根 workspace 也会写行）都会留下行而不代表列过全量。所以加一列：
`project_remotes.worktrees_synced_at TEXT NULL`。三处写它：列表路由的
`syncRemoteWorktreeList`、重连的 `syncRemoteWorkspaceRegistry`、§5.4 的链接时同步。
只有拿到 worker 的完整列表并登记完才写。这是一列、一个 helper，不是同步体系。
不加这列的替代是「所有非当前 remote 一律 unknown、开管理弹窗时再查」，代价是多 remote
项目里每个 workspace 都常年挂着「n 台未确认」的徽标，信号被噪声淹没。

链接 remote 时今天不同步（`project-remote-routes.ts:65` 只写 `project_remotes`），
所以新链接的 remote 在 §5.4 跑完前是 `unknown`。离线的 remote 保留上次已知状态，
不退化成 `unknown`。

覆盖度 = present 数 / linked 数；`unknown` 在分母里，在 tooltip 里写 `Not checked yet`。
`unknown` 的确认入口在管理弹窗（§6.3）：打开时调一次状态查询接口，由服务端并行问各台。

`machines` 按 `project_remotes.sort_order` 排序，和弹窗里机器列表顺序一致。
根 workspace（`branch === null`）也给 `machines`：它在每台链接的 remote 上天然存在，
永远不下发（缺省 = 全在）。

### 4.2 与现有 `targets` 的关系

Phase A 里 `findUnhealthyWorkspaces` 继续只做「矛盾检测」，驱动琥珀 ⚠（半删、error），
`machines` 是它的超集。Phase B 起服务端只发 `machines`，⚠ 由前端从 `machines` 推导
（`workspaceContradiction`）；前端读 `machines ?? machinesFromTargets(targets)`，
`targets` 的读取兼容留一版后删掉。

### 4.3 不新增表、不加列

覆盖度全部由现有 `workspace_checkouts` 推导。注册表已经是「唯一知道所有机器」的地方。

## 5. 列表数据源

### 5.1 目标模型：注册表为准，当前 remote 的 git 做校正

`GET /api/projects/:id/worktrees`（不带 `target`）：

1. 取 `linked`；当前 remote = `agent_mode` 若在 `linked` 内，否则 `sort_order = 0`。
2. 向当前 remote 请求 `/api/path/worktrees`（已有调用，capability 已登记）。
   - 在线：用返回的列表**对账**这台 remote 的注册表行（§5.2），然后进入第 3 步。
   - 离线 / 超时：跳过对账，直接第 3 步，响应带 `stale: { serverId }`，
     前端在侧栏顶部显示「<name> 离线，列表可能不是最新」。今天离线是整个列表 5xx。
3. 列表 = 注册表里在 `linked` 任一台上有活行的 workspace 的并集，附 `machines`。
   根 workspace 恒在。

这样「当前 remote」的行每次列出都对账；其它 remote 的行在它成为当前 remote、
或被创建/删除操作触碰时对账。

### 5.2 对账规则（新增，替换只增不删的同步）

对一台 remote 的注册表活行 vs 它报告的 worktree 列表：

- 报告里有、注册表没有 → `registerReadyCheckout`（今天已如此）。
- 报告里有、注册表 `status = error` → 改回 `ready`，清 `error`。
  这台机器实际有它，之前的失败已经不成立。
- 注册表有活行且 `status = ready`、报告里没有 → 落墓碑。
  这是「手工删掉」的收敛路径，解决 `workspace-health.ts` 注释里担心的「复活且永不消失」。
  **必须防旧结果覆盖新操作**：列表请求发出后用户创建成功，较早发出的列表回来时没有这条，
  不能因此删它。做法：向 remote 发请求**之前**先快照这台的活行
  `{ id, status, updated_at }`，只对快照里就是 `ready` 的行、且用
  `setCheckoutStatusIfCurrent(id, { status: "ready", updatedAt })` 条件写入落墓碑；
  快照之后新建或状态变过的行，条件不满足，自动跳过。
- 注册表 `status = creating / deleting` 的行**不动**：操作进行中，报告可能落后于操作。
- 报告本身不是数组（旧 worker 或异常）→ 整段跳过，不对账。

### 5.3 过渡：先放宽追加规则（Phase A）

一次到位改列表数据源风险不小（前端跳转校验、缓存、merge status 都吃这个列表）。
先做一步小的、可逆的：

- `withWorkspaceHealth` 的追加条件从「矛盾」放宽到「在 `linked` 任一台有活行、
  且列表里没有」。
- 列表 remote 从 `sort_order = 0` 改为 `agent_mode`（前端注释已经这么假设）。
- 给每个 workspace 算 `machines`。

Phase A 不做自动落墓碑，也不做 `error → ready` 的自动回正（后者由用户在弹窗里重试解决：
重试 → adopt → ready）。「手工删掉的 worktree 变鬼行」在这一步存在。缓解：
行上的 Delete 对「已经不在」按成功处理并落墓碑。已核实 worker 的
`DELETE /api/path/worktrees`（`worktree-routes.ts:450` 起）走的就是
`removeWorktreeIfPresent`：`git worktree remove` 失败后**再查一次** `worktreeRecordExists`
确认真的不在才吞掉错误，然后 `markCheckoutDeleted`。不是凭 `not a working tree` 一句话认定。
hub 侧不需要另加判定。鬼行一次点击即清，不是「永不消失」。Phase B 再上 §5.1 + §5.2。

### 5.4 链接 remote 时同步一次

`POST /api/projects/:id/remotes` 成功后，对这台 remote 跑一次 `/api/path/worktrees` +
`registerReportedWorktrees`（现有函数、已登记的调用）。在线则立刻把 `unknown` 变成
真实状态；离线则保持 `unknown`，等它下一次成为当前 remote。同步失败不影响链接本身。

## 6. 界面

### 6.1 侧栏行

- **覆盖徽标**：`machines` 存在且有 `absent` 时，行尾显示中性的 `2/4`
  （present 数 / linked 数），`text-muted-foreground`，等宽小字。完整时不渲染、不占位。
- **琥珀 ⚠**：保持现状，只在 `unfinishedDelete` 或有 `error` 时出现。两者可同时出现
  （比如 4 台里 2 台有、1 台失败）：⚠ 在左，覆盖徽标在右。
- **tooltip**（两者共用一份 `machines`）：每台一行，`name: Present / Missing /
  Deleted here / Failed — <error>`。第一行说明：「Exists on 2 of 4 remotes.
  Click to create it on the others.」
- **点击徽标** → 补建弹窗（§6.3）。
- **行菜单**（`workspace-row-menu.tsx`）新增 `Manage remotes…`，多 remote 项目上总是出现，
  进管理弹窗（§6.3）。它同时是补建、重试失败、确认 unknown 的入口。徽标是快捷入口。
- 不再为「当前 remote 上缺失」单加第三种标记。覆盖徽标的 tooltip 第一行点名当前 remote
  的状态即可；打开时的处理见 §6.5。两种标记（⚠ 与 `2/4`）够用。

### 6.2 弹窗（新建模式）的 remote-only 简化

- 机器行标签直接显示 remote 名，去掉 `Remote ·` 前缀。
- 页脚点名文案同样去前缀：`Creates a worktree on worker3 and ubuntu`。
- 默认勾选：全部 remote（现状）。可选改进：默认只勾当前 remote，其余不勾，
  用一行说明「其它 remote 可稍后补建」。**建议先不改**，等有用户反馈；改动一行。

### 6.3 弹窗（管理模式）

同一个组件，由 `initialTargets` 升级为 `initialMachines: WorkspaceMachineState[]`，同时带
`initialBranchName`。它是这个 workspace 的 remote 管理面：每台一行，显示已建 / 未建 /
未确认 / 进行中 / 失败，能补建缺失的、重试失败的、确认未知的。

**打开时现场确认**：前端只发一次
`GET /api/projects/:id/worktrees/machines?branch=<branch>`（新接口，见下），
由服务端并行问各台 worker，返回这个 workspace 在每台 remote 上的现场状态。
弹窗在结果回来前把各行标 `Checking…`，回来后按结果更新；弹窗内提供 `Check again`
重新查一次。只在弹窗打开和手动刷新时查各台，侧栏刷新不查。

不用现有的 `?target=<serverId>` 列表接口逐台查，原因有二：
- 它的返回不是那台的纯列表。`withWorkspaceHealth` 会把只在别台上的 workspace 追加进来
  （§5.3 放宽追加规则后更是如此），「返回里有这个分支」不等于「这台有」，按它判会把本该
  可补建的行错误置灰。
- 逐台请求、失败处理、状态合并都落在前端，而服务端本来就掌握 `linked` 和注册表。

**状态查询接口**（hub 侧，加性）：

```ts
GET /api/projects/:id/worktrees/machines?branch=<branch>
// 200
{ branch: string; machines: WorkspaceMachineCheck[] }

interface WorkspaceMachineCheck extends WorkspaceMachineState {
  /** 这次真的问到了 worker。false = 结果是注册表里的上次已知状态。 */
  checked: boolean;
  /** checked = false 时的原因：network_error / timeout / worker 报错文本。 */
  checkError?: string;
}
```

- `branch` 必填，根 workspace 不可管理，缺省 400。
- 对 `linked` 中每台 remote 并行 `GET /api/path/worktrees?path=<remote_path>`
  （`Promise.allSettled`，`timeoutMs` 单台上限，参照创建/删除路由的多台扇出）。
  这条 server→worker 调用已在 capability 注册表，不改隧道契约。
- **单台成功**：先做和 `?target=` 一样的副作用（`syncRemoteWorktreeList` 只增登记、写
  `worktrees_synced_at`），再按 worker 原始列表判：
  - 注册表活行为 `creating` / `deleting` / `error` → 保留该操作状态（`error` 保留，重试仍走
    「再创建一次 → adopt → ready」；不在这里自动回正）。
  - 否则列表里有这个分支 → `present`；没有 → `absent`（有墓碑时带 `deleted: true`）。
  - `checked: true`。
- **单台失败**（离线、超时、worker 报错）：状态 = 注册表推出的上次已知状态（与列表的
  `machines` 同一函数），`checked: false`、`checkError`。没有历史状态（`unknown`）的仍是
  `unknown`，**不得**当作 `absent`。
- 单台失败不影响其它台。全部失败也 200，靠 `checked` 表达。
- 不写墓碑、不改 `status`：现场结果只回给弹窗，注册表只做只增登记。
- 旧服务端没有这个接口（404）：弹窗退回用列表带来的 `initialMachines`，`unknown` 行标
  `Could not check`。

与现有修复模式的差异：

| 项 | 现状（修复模式） | 补建模式 |
|---|---|---|
| 标题 | Create where it is missing | Manage remotes for `<branch>` |
| 副标题 | 通用 | `<branch> exists on 2 of 4 remotes.` |
| `present` 行 | 可勾，勾了会 adopt | **置灰不可点**，标签 `Has it` |
| `absent` 行 | 默认勾 | 默认勾，标签 `Missing`；`deleted` 时标签 `Deleted here` |
| `error` 行 | 默认勾，标签 `Failed` | 同现状；tooltip 是那台的 error；重试 = 再创建一次（adopt 后回 ready） |
| `unknown` 行 | 无 | 打开时由状态查询接口确认；`checked = false` 则 `Could not check`，不可勾 |
| `creating` / `deleting` 行 | 无 | 置灰，标签 `Creating…` / `Deleting…` |
| 分支名 | 可改，改了退回普通新建 | **锁定**（只读，见下） |
| Base branch | 通用说明 | 说明改为 §6.4 的文案 |
| 主按钮 | Create | Create on N remotes |

`present` 行为什么不锁死成不可勾而是置灰：今天勾它只会 adopt，没有任何效果，
显示为可选项只会让用户以为要「重新建一遍」。

分支名锁定的理由：补建是对**一个已存在 workspace** 的行级操作（从它的徽标或行菜单进来），
分支名是这个操作的对象，不是输入。改名等于换了一个操作，而现有修复模式里「改名即退回
普通新建」是一次隐式的模式切换，用户看不出来。要新建另一个名字的 workspace，走 `+` 入口。
现有 `drops the repair framing once the name is typed over` 测试随之改为「补建模式下分支名只读」。
「Create where it is missing」的失败修复流也统一走补建模式，因为它同样是对已存在 workspace 的操作。

**部分成功后的弹窗更新**（现状只是显示警告、不关窗，`selected` 不变，重试会把成功的也再发一遍）：
- 用 207 的 `results` 就地更新弹窗内的机器状态：成功项 → `present`、置灰、取消勾选；
  `adopted` 的成功项同样置灰，并在行内标 `Reused`。
- 失败项保持勾选，行内显示原因（`targetFailureReason`），主按钮变成 `Retry on N remotes`。
- 重试只提交仍勾选的 remote。全部成功才关窗。
- 弹窗内这份状态在关窗时丢弃，列表刷新后以服务端 `machines` 为准。

### 6.4 Base branch 文案（必须）

补建模式下 Base Branch 说明改为：

> New checkouts start from this branch. Work done on other remotes is not copied.
> If `<branch>` already exists in a remote's repository it is reused as-is.

两句对应两种情况：分支在那台的仓库里不存在 → 从 base branch 切新分支，另一台的提交
不在里面；已存在（push/fetch 过）→ adopt，base branch 不生效。现有 toast 已说明
后者，这里把前者也说出来。

### 6.5 打开一个在当前 remote 上缺失的 workspace

前端在跳转前看 `machines`：当前 remote 是 `absent` 时，**不把查看意图直接变成补建**。
显示一个三选项的提示：

- `Switch to <name>`：把 `agent_mode` 切到一台 `present` 的 remote（多台时列出），
  然后正常打开。
- `Create on <current>`：打开管理弹窗，只预勾当前 remote。
- `Open anyway`：照常打开。hub 的记录可能陈旧，用户有权无视它。

`unknown` 时不拦，照常打开：hub 没记录不等于远端没有。`creating` 时提示「正在创建」，不拦。
这是软提示，不是拦截；第一版不做服务端硬拦。

服务端兜底（Phase B，可选）放在**真正创建**的路径：`POST /api/projects/:id/agent-sessions/new`
（`agent-session-routes.ts:1168`，remote 分支走 `createRemoteAgentSession`）。
在代理到 worker 之前，若注册表里该 branch 在 `agent_mode` 上是 `absent`，返回 409
`{ error: "workspace-missing-on-remote", serverId, name }`；`unknown` 不拦。
是否值得做取决于 §5.2 对账上线后 hub 记录的可信度；对账之前不用 hub 的陈旧记录硬拦会话。
不带 `/new` 的 `POST /api/projects/:id/agent-sessions` 是**查找已有会话**
（worker 没有时回 `200 { session: null }`），不能在这里拦：远端可能有 hub 还没记录的会话。

已核实 worker 行为：`/api/path/agent-sessions/new` 最终调 `agentSessions.createBound`
（`storage/repositories/agent-sessions.ts:550`），它要求该分支在本机有
`deleted_at IS NULL AND status = 'ready'` 的 checkout，没有就抛错。worker **不会**自建
worktree，所以今天的表现是一条含义模糊的 500，hub 侧的 409 只是把它说清楚并接到弹窗，
不与任何隐式流程冲突。

### 6.6 创建完成后

现有行为保留：207 部分失败不关窗、逐台显示结果、失败项保持勾选可重试。
成功后 `onWorktreeCreated` 已触发列表刷新，`machines` 随之更新，徽标消失或数字变化。

## 7. 边界情况

- **remote 离线**：覆盖度来自注册表，离线不影响 `present/absent`。补建时勾了离线的
  remote → 那台 `network_error`，逐台结果里说明，行保持勾选。
- **取消链接 remote**：`linked` 缩小，它的行被过滤（现有逻辑），覆盖度分母随之减小。
  重新链接同一台：行还在，直接算 `present`；对账（§5.2）会校正。
- **同名分支被 rename 成另一个 workspace**（checkout 身份跟目录走）：注册表以
  `workspace.branch` 为身份，`currentBranch` 另算，覆盖度不受影响。
- **旧 UI 对新服务端**：`machines` 是新增字段，旧 UI 忽略；Phase B 起 `targets` 不再下发，
  旧 UI 失去琥珀 ⚠（UI 与服务端同版部署，靠版本偏差刷新收敛）。**新 UI 对旧服务端**：
  `targets` 经 `machinesFromTargets` 兜底，留一版。
- **legacy `targets: ["remote"]`**：创建路由继续接受（= 全部 remote）。
- **根 workspace**：不下发 `machines`，不显示徽标，不可补建。
- **弹窗现场状态与侧栏注册表状态不一致**：worker 上手删了、注册表还是 ready →
  侧栏 `present`、弹窗 `absent` 可勾。Phase A 不据此落墓碑，勾了就重建；差异由 §5.2
  对账在 Phase B 收敛。反过来（注册表无行、worker 有）→ 弹窗 `present` 置灰，
  且只增登记后侧栏下次刷新也变 `present`。
- **`agent_mode` 指向已取消链接的 remote**：列表回退到 `sort_order = 0`，
  并在响应里带 `activeRemoteInvalid: true`，前端提示切换。今天这种情况会话创建直接 400。

## 8. 接口变更清单（全部 hub 侧、加性）

| 接口 | 变更 |
|---|---|
| `GET /api/projects/:id/worktrees` | 列表项总带 `machines`；追加规则放宽；列表 remote 改为 `agent_mode`；`?target=` 分支写 `worktrees_synced_at`；响应可带 `stale` / `activeRemoteInvalid`（Phase B） |
| `GET /api/projects/:id/worktrees/machines?branch=` | **新增**：并行问各台 worker，返回该 workspace 每台的现场状态 + `checked`（§6.3）；成功台做只增登记并写 `worktrees_synced_at` |
| `POST /api/projects/:id/worktrees` | 不变（补建照旧提交勾选的 remote id） |
| `POST /api/projects/:id/agent-sessions/new` | Phase B 可选：当前 remote 上该 workspace 为 `absent` 时 409；查找路由不变 |
| `project_remotes` | 加列 `worktrees_synced_at TEXT NULL`（migration，默认 NULL = 未确认） |
| `POST /api/projects/:id/remotes` | 成功后对该 remote 同步一次 worktree 列表（§5.4） |
| server→worker | 无新增调用；新接口复用 `GET /api/path/worktrees`，已在 capability 注册表 |

不需要发 worker。`reverse-connect-capabilities.test.ts` 的 snapshot 不应有 diff。

## 9. 实施分期

**Phase A（先做，可逆）**
0. migration：`project_remotes.worktrees_synced_at`；`syncRemoteWorktreeList` /
   `syncRemoteWorkspaceRegistry` 成功后写入。
1. `workspace-health.ts`：新增 `computeWorkspaceMachines(rows, linked, syncedAt, names)`，
   与 `findUnhealthyWorkspaces` 共用分组逻辑。
2. `withWorkspaceHealth`：追加规则放宽；每项挂 `machines`；去掉 `unhealthy.length === 0` 早退。
3. 列表路由：列表 remote 用 `agent_mode`（在 `linked` 内时）。
3b. 状态查询接口 `GET /api/projects/:id/worktrees/machines`（§6.3）：并行扇出、
   `checked` 标记、成功台只增登记 + 写 `worktrees_synced_at`。
4. 前端：`Worktree.machines` 类型；侧栏徽标 + tooltip + 行菜单 `Manage remotes…`。
5. 弹窗：`initialMachines`，管理模式（锁名、置灰、打开时调状态查询接口 + `Check again`、
   207 就地更新，§6.3、§6.4），去 `Remote ·` 前缀。
6. `page.tsx`：徽标/菜单 → 弹窗接线；§6.5 的三选项软提示。
7. §5.4 链接时同步。

**Phase B**
8. §5.2 对账（含 `error → ready` 回正、`ready → 墓碑`，快照 + 条件写入）。
9. §5.1 注册表为准的列表；离线 `stale`。
10. `/agent-sessions/new` 的 409 兜底（§6.5，可选，视对账后记录可信度）。
11. 删除 `targets` / `unfinishedDelete` 的下发（UI 切到 `machines` 一版之后）。

## 10. 测试

后端（`worktree-registry-routes.test.ts`）：
- 三台 remote 只在 B 建 → 列表里有这一行，`machines` = A absent / B present / C absent。
- 四台里两台 present、一台 error → `machines` 四项，`targets` 仍只含矛盾项。
- 全部 present → 不下发 `machines`。
- `agent_mode = B` 时列表向 B 发 `/api/path/worktrees`，不是 `sort_order = 0` 的 A。
- 新链接、从未同步的 remote → 该台 `unknown`，不是 `absent`；链接时同步成功后变真实状态。
- 只有单独创建 / 会话绑定写过行、没列过全量的 remote → 其它 workspace 在它上面仍是 `unknown`。
- 全部 present 也返回完整 `machines` 数组。
- `creating` 行 → `creating`，不计入分子。
- 状态查询接口：三台里 B 离线 → A/C `checked: true` 且为现场状态，B `checked: false` 并保留
  注册表状态；B 从未同步 → 仍 `unknown`，不是 `absent`。
- 状态查询接口：注册表 `error` 行、worker 报告有 → 仍 `error`；注册表 ready、worker 报告没有 →
  `absent` 但注册表不落墓碑；注册表无行、worker 有 → `present` 且登记为 ready 行。
- 状态查询接口：只在别台上的 workspace 不会因 `withWorkspaceHealth` 的追加而在 A 上误判 `present`。
- Phase B：报告里没有的 ready 行落墓碑；`creating` 行不动；error 行回正；
  快照之后新建的行不被较早的报告删掉（条件写入生效）。
- `/agent-sessions/new` 在当前 remote `absent` 时 409，`unknown` 时放行；查找路由不拦。

前端（`create-worktree-dialog.machines.test.tsx` + 侧栏测试）：
- 补建模式：present 行 disabled 且不在提交的 `targets` 里；absent 默认勾；error 默认勾；
  `creating` / `unknown` 行不可勾。
- 补建模式分支名只读（替换现有「改名退回普通新建」测试）。
- 207 后：成功项置灰取消勾选，失败项保持勾选并显示原因，重试只提交失败项。
- 徽标只在有 absent 时渲染；tooltip 每台一行。
- 当前 remote absent → 点行出现「Switch / Create on / Open anyway」三个入口；
  `unknown` 时照常打开。
- 管理弹窗打开时只调一次状态查询接口；回来前各行 `Checking…`；`checked: false` 的 `unknown`
  行标 `Could not check` 且不可勾；`Check again` 重新调；接口 404 时退回 `initialMachines`。

## 11. 未决

- §6.2 新建默认勾全部还是只勾当前 remote。建议先全部。
- `worktrees_synced_at` 只记「同步过一次」，不记多久前。若之后要表达「陈旧」，同一列可以直接比时间。
- 是否需要一个项目级「在所有 remote 上补齐」批量入口。建议不做，等需求。
