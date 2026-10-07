# Task 描述中的文件引用 — 设计

状态：待实现（设计定稿 2026-10-07）。渲染、跳转和 Task chip 提示（§7.3a）都只改前端；`propose_task` 工具描述（§7.3b）需要发 worker。

## 1. 目标

Task 描述里可以引用 workspace 中的文件，比如设计文档或源码。点击引用后，跳到对应 workspace 的 Files tab，打开这个文件，并定位到指定行（如果写了行号）。

非目标（v1 不做）：
- 悬停预览
- 失效链接的检测或修复（文件改名、删除）
- 仓库外的绝对路径产物（`/tmp/shot.png`）
- 可分享的 URL 深链（见 §6）

## 2. 现状

| 部件 | 位置 | 能否复用 |
|---|---|---|
| href 解析（`path:line`、`#L42`，拒绝 URI scheme / `//` / `#`） | `lib/file-ref/parse-file-ref.ts` 中的 `parseFileHref` | ✅ 复用；Task 侧另加相对路径限制（§5.2） |
| rehype 插件：链接转换（`transformAnchor`）+ 裸路径扫描（`expandText`） | `lib/file-ref/rehype-file-refs.ts` | ⚠️ 只复用链接转换，不启用裸路径扫描 |
| 渲染端：按索引解析、点击调 `openFile` | `components/agent/file-ref-link.tsx` 中的 `FileRefLink` | ❌ 不复用：相对路径要在索引里找到才变链接，Task 不拉索引 |
| `openFile` → 切 Files tab + `navRequest` | `components/right-panel/right-panel.tsx:214` | ⚠️ 只在 workspace 视图内有效 |
| Files tab 消费 `navRequest` | `components/files/files-view.tsx:92` | ✅ |
| Task 描述渲染 | `components/task/markdown-field.tsx:79`，纯 `<Streamdown mode="static">` | ❌ 普通 markdown 链接能渲染，但没接 workspace 文件导航 |

缺口有两个：
1. Tasks 页在 workspace 视图外，跨视图没有"打开文件"的通道；而且按 `agent-markdown.tsx` 的注释，`harden` 会改写或拦截相对路径的 href，Task 里写的文件链接即使渲染出来也跳不到 workspace。
2. Task 不知道该用哪个 workspace（分支）的文件。

## 3. 写法

Task 描述只认**显式的 Markdown 链接**，路径相对于仓库根目录：

```markdown
参考 [设计文档](docs/task-file-references-design.md) 第 3 节，
实现位置见 [markdown-field](apps/vibedeckx-ui/components/task/markdown-field.tsx:79)，
构建入口在 [Makefile](Makefile)。
```

- 行号写成 `path:42` 或 `path#L42`（也接受 `#L42-L50`，跳到起始行）。
- 不要求有扩展名：`Makefile`、`Dockerfile`、`bin/vibedeckx` 都可以。因为链接是用户或 agent 显式写的，不存在把普通文字误认成路径的问题。
- **裸路径保留为普通文本**。描述里直接写 `foo/bar.ts:79` 不会变成链接。这样没有索引也不会误判，也不用为 Task 维护一套"哪些看起来像路径"的启发式规则。
- 以下 href 不当文件处理，按普通链接渲染：带 URI scheme 的（`https:`、`mailto:` 等）、`//` 开头、`#` 锚点。
- 以下 href 渲染成不可点的文本：绝对路径（`/…`）、`~/` 开头、含 `..` 段的。仓库外的文件不在 v1 范围内（§1）。开头的 `./` 会去掉。
- 写在反引号里的 `` `[x](path)` `` 是代码，不会转换。

### 显式指定分支：v1 不支持（§7.1）

v1 不支持在链接里写 `?branch=`。如果以后要加，做法是解析时先把 `?branch=` 剥掉，再交给 `parseFileHref`，现有链接不受影响。

## 4. workspace 解析规则

引用要解析到**写出这个引用的那个 workspace**，而不是执行 task 的分支。点击时按以下规则选目标分支（v1 不支持在链接里显式指定分支，见 §7.1）：

1. `task.source_session.branch`：提议这个 task 的会话所在的 workspace（`null` 表示主 workspace，保留这个语义）
2. 没有来源会话（手建的 task）时，用主 workspace（`branch = null`）

`assigned_branch` 不参与解析。它表示 task 交给哪个分支去做，和描述里的文件出自哪个分支没有关系。如果拿它来解析，会出两个问题：
- 未分配的 task 会落到主 workspace。feature workspace 里提议的 task 就会打开 main 上的同名旧文件，或者报找不到文件。
- 之后改分配，引用的目标也会跟着变。

`source_session.branch` 是 task 列表接口实时富化出来的（`routes/source-sessions.ts`），不是存在 task 上的值。来源会话被删除后（`exists: false`）分支查不到，会返回 `null`，引用就退回主 workspace。创建 task 时已经给来源会话挂了 retention 保留锁，所以只有用户手动删除会话才会碰到这种情况。v1 接受这个限制，见 §7.4。

Remote 项目的跳转不需要特殊处理：Files tab 本来就按 `(projectId, branch, target)` 读文件，切过去后自然走对应机器。

## 5. 实现

### 5.1 页面级打开文件请求

沿用 `terminalRequest` 的 nonce 请求模式（`app/page.tsx:114` 到 `right-panel.tsx:133`）：

```ts
// app/page.tsx
const [fileOpenRequest, setFileOpenRequest] =
  useState<{ branch: string | null; path: string; line: number | null; nonce: number } | null>(null);

const openFileInWorkspace = useCallback((branch, path, line) => {
  setActiveView("workspace");
  selectWorkspace(branch);           // 现有的切 workspace（app/page.tsx:101），会清掉会话 pin
  setFileOpenRequest({ branch, path, line, nonce: ++n });
}, ...);
```

`RightPanel` 新增 `fileOpenRequest` prop，处理方式和 `terminalRequest` 一样：
- nonce 变化时转成内部的 `openFile(path, line)`。
- 必须等 `selectedBranch === request.branch` 后再触发，否则会在切分支前的旧 workspace 里打开文件。可以把请求挂起，等分支对上了再消费。

### 5.2 Tasks 页渲染

只转换显式 Markdown 链接，不启用现有插件的裸路径扫描。会话里的识别行为保持不变。

**为什么不能只换一个 `a` 组件**：Streamdown 的 `harden` 插件会改写或拦截相对路径的 href（见 `agent-markdown.tsx:11` 的注释）。所以必须在 `harden` 之前，用 rehype 插件把文件链接改写成站内锚点。这一步和会话的做法一样。

1. **插件**：把 `rehypeFileRefs` 里的 `transformAnchor` 单独抽出来，做成 `rehypeFileLinks`，只处理 `<a>` 元素，不扫描文本节点。产出的锚点和现在一样：`href="#file-ref"`、`dataFileRaw`、`dataFileLine`。插件链的顺序照抄 `agent-markdown.tsx`：sanitize → `rehypeFileLinks` → harden。`rehypeFileRefs` 本身不改，会话继续用它。
2. **相对路径过滤**：在 `parseFileHref` 的结果上再加一层 Task 专用的判断（§3）：拒绝 `/` 和 `~/` 开头、拒绝含 `..` 段、去掉开头的 `./`。不合格的链接渲染成纯文本，不留一个点了没反应的链接。
3. **渲染组件**：新写一个 `TaskFileLink` 作为 `components.a`。有 `dataFileRaw` 时渲染成可点链接，点击调 `openFileInWorkspace(resolveBranch(task), path, line)`；否则按普通外链渲染。不复用 `FileRefLink`，因为它的规则是"相对路径要在索引里找到才变成链接"，而 Task 不拉索引。这样也完全不用改 `FileRefLink` 和 `FileNavigationProvider`，会话的行为不受影响。
4. **`resolveBranch`**：按 §4 的规则，返回 `task.source_session?.branch ?? null`，不读 `assigned_branch`。
5. **不做文件索引，也不检查文件是否存在**。点击后由 Files tab 显示文件；文件不存在时，Files tab 现有的预览区显示 "Failed to load file."（`file-preview.tsx:666`），没有 toast。v1 接受这个提示。

### 5.3 列表行的描述摘要

Tasks 列表每一行显示描述的前 80 个字符（`task-row.tsx:67`），是原始文本，不渲染 Markdown。v1 只做显示清理：截断前把 `[标签](href)` 替换成 `标签`，不渲染成链接，也不可点。同样的清理也用在 `task-row.tsx:225` 待确认提议行的描述上。这样列表里不会露出 `[x](path)` 语法，也不会出现被截断成一半的链接。点击行仍然是打开详情面板，可点的链接在详情面板里。

### 5.4 点击和编辑的冲突

`markdown-field.tsx:66` 已经有 `closest("a, button")` 判断，点击链接不会进入编辑。`TaskFileLink` 渲染的是 `<a>`，不用额外处理。点击时要 `preventDefault`，避免 `#file-ref` 改掉地址栏的 hash。

## 6. 以后：URL 深链

给 `lib/url-state.ts` 加 `?file=path&line=N`，可以得到 `/p/:id/workspace?branch=dev1&file=docs/x.md` 这种可分享的链接。代价是每次在 Files tab 里切换文件都要同步 URL（或者只在首次进入时读取），而且会触及 `url-state.test`。v1 用页面内请求就够了，这块等有分享需求再做。

## 7. 决定

1. **显式分支 `?branch=`：v1 不做。** 来源分支已经覆盖了 agent 提议的场景，只有手建 task 引用 feature 分支上的文件时才需要。手写分支名很脆弱：分支合并或删掉后链接反而失效。以后要加，现有链接不受影响。
2. **列表行的链接：v1 不可点，只做显示清理（§5.3）。** 列表是用来扫一眼和选 task 的，想打开文件就点进详情面板。在列表行渲染 Markdown 的成本更高，80 字截断还会切断链接，链接点击和行点击也会冲突。
3. **agent 提示：要做**：agent 不知道 Task 描述支持文件链接，就会继续写裸路径，而裸路径不可点（§3）。所以从两个入口告诉它链接格式，覆盖面不同：
   - **a. 输入框 Task chip 的隐式 prompt**：`apps/vibedeckx-ui/lib/task-intent.ts` 中的 `TASK_INTENT_BLOCK`。在"description 要自包含"那条后面加一条建议，只说"引用仓库文件时给链接，不要把文件内容抄进描述"，不写具体链接格式：
     ```
     - When a description relies on a file in the repository (a design doc, the source to change), link to the file
       instead of copying its contents into the description.
     ```
     链接格式只写在 b 的工具描述里：agent 只要调用 `propose_task` 就会看到它，不管是不是从 chip 进来的，chip 里不再重复。这个 block 是前端拼进消息的，不用发 worker。
   - **b. `propose_task` 的工具描述**：`packages/vibedeckx/src/session-tools-mcp.ts`，包括 `description` 字段的说明和 :206 一带的工具说明。写明链接格式（仓库根相对路径的 Markdown 链接，可带 `:42` 行号），覆盖所有调用 `propose_task` 的场景，包括不经过 chip 的。这个描述由 worker 下发，所以**这一项需要发 worker**。链接格式只有这里写，所以旧 worker 上的 agent 仍然会产出裸路径，显示为纯文本，功能不受影响。
   - **发布顺序**：a 要和 §5 的渲染改动一起上线。如果先上 a，agent 写出的链接会被 `harden` 拦掉，点了也跳不过去。b 可以晚于 a 发布。
4. **`source_branch` 列：v1 不做，等真遇到问题再做。** 来源会话有保留锁，只有用户手动删除会话才会退回主 workspace（§4）。补这一列要改 hub：加迁移、改创建接口、老数据回退到实时查询。以后补加只影响新建的 task，不会破坏现有链接。

## 8. 测试与验收

单测或渲染测试：
- **普通文件链接**：`[设计](docs/x.md)` 渲染成可点链接，点击调用 `openFileInWorkspace`，传入 `path = "docs/x.md"`、`line = null`，并且不进入编辑。
- **行号**：`path:42`、`path#L42`、`path#L42-L50` 都传 `line = 42`。
- **无扩展名文件**：`[Makefile](Makefile)`、`[cli](bin/vibedeckx)` 可点。
- **裸路径不可点**：描述里的 `docs/x.md:42` 以及反引号里的 `` `[x](docs/x.md)` `` 都保持纯文本，不产生锚点。
- **排除的 href**：`https://…` 按普通外链渲染；`/etc/x`、`~/x`、`../x` 渲染成纯文本。
- **`resolveBranch`**：有来源会话时用来源分支（包括 `null` 表示主 workspace）；没有来源会话时用主 workspace；不管 `assigned_branch` 是什么，结果都不变。
- **`right-panel`**：`fileOpenRequest` 在分支对上之前挂起，对上后切到 Files tab 并发出 `navRequest`。
- **回归**：会话消息里的裸路径识别和索引判定行为不变，现有 `rehype-file-refs` 测试全部通过。
- `task-intent.test.ts`：`TASK_INTENT_BLOCK` 包含"给链接而不是抄内容"的建议；`takeTaskMarker` 照常把整个 block 剥掉。
- **列表行清理**：描述 `参考 [设计文档](docs/x.md) 第 3 节` 在列表行显示为 `参考 设计文档 第 3 节`，没有锚点；先清理再截断 80 字。

真机验收（本地项目和 remote 项目各做一遍）：
- 点普通文件链接、带行号的链接、无扩展名文件的链接，都能在正确机器和正确分支上打开，并定位到对应行。
- **文件不存在**：链接照常可点，点击后 Files tab 预览区显示 "Failed to load file."，页面不崩溃也不卡住。
- **Task chip 端到端**：在会话里选 Task chip，让 agent 记录一个涉及设计文档的 task。确认生成的描述里文件是 Markdown 链接，点击能打开。
- **更换执行分支**：在 feature workspace 里提议一个 task，保持未分配，点击引用，打开的是来源 workspace 里的文件；再给它分配或更换执行分支，引用仍然打开来源 workspace。
