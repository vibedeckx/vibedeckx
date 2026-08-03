---
name: compat-check
description: 本地预跑 server/worker 兼容检测（对账测试 + classify-diff + 可选跨版本 e2e），按 docs/server-worker-compat-design.md §6.5 的流程图做分支判断，告诉用户下一步该做什么（补注册表 / 走弃用流程 / 打 tag / 直接部署）。在 push 前想知道 CI 会不会红、要不要发 worker 时使用。
---

# 本地兼容检测（worker-compat 预跑）

按 `docs/server-worker-compat-design.md` §6.5 的流程图执行。目标输出：一句明确的
结论——落在流程图哪个节点、下一步做什么。不要只贴测试输出让用户自己判断。

## 环境注意（必须遵守）

- 跑 vitest 必须 `PATH=/usr/bin:$PATH`（fnm Node 22 与 better-sqlite3 ABI 不兼容）。
- 跨版本 e2e 前必须先 `pnpm build:main`（server 从 `dist/bin.js` 起）。
- 本机可能就是在线 worker：**绝不运行 `connect stop`**；e2e 脚本自带隔离
  `--data-dir`，不要绕过它手动起 worker。
- 端口冲突时用 `XVER_SERVER_PORT` / `XVER_WORKER_PORT` 换端口重跑。

## 执行步骤

### 第 1 步：对账 + snapshot 测试（≈10 秒）

```bash
cd packages/vibedeckx && PATH=/usr/bin:$PATH npx vitest run src/reverse-connect-capabilities.test.ts
```

**绿 → 进第 2 步。红 → 按失败的 `it()` 用例名分支**（断言消息里带具体 key 和
file:line，引用给用户看）：

| 红的用例名 | 分支 | 提示用户做什么 |
|---|---|---|
| `every tunnel call site is registered` / `harvested dynamic paths are registered` | ① 登记 | 在 `reverse-connect-capabilities.ts` 补条目，`since` 填**下一个要发布的版本号**；同时提醒：调用方代码必须容忍老 worker 404（降级分支，CI 测不了，见 §6.3） |
| `every registry entry has a live call site (no stale entries)` | ② stale | 先问用户：是**故意删除**这个调用，还是重构后提取器没认出来？故意删 → breaking 方向，代码要恢复新旧并存走弃用流程（**不是打 tag**）；没删 → 归③修提取配置 |
| `wrapper list is sound and complete` / `dynamic-path call sites are explicitly allowlisted` / `extraction self-check` | ③ 提取器维护 | 修测试配置（`HTTP_SENDER_NAMES` / `HARVEST_FUNCTIONS` / `PASSTHROUGH_FILES`），与发布无关 |
| `registry snapshot (...)` | 申报关 | 更新 snapshot（`npx vitest run -u`），并明确告诉用户这次是 **additive 还是 breaking**（对照 diff：只新增条目=additive；有删改=breaking→②流程） |

红修完后重新从第 1 步跑，直到绿。

### 第 2 步：classify-diff（秒级，跑两个 base）

```bash
# 本次改动视角：这个分支相对 main 改了什么
node scripts/classify-diff.mjs origin/main
# 欠账视角：自上一个发布 tag 以来积累了哪些 worker 可达改动（打 tag 决策看这个）
node scripts/classify-diff.mjs "$(git describe --tags --abbrev=0 --match 'v*')"
```

（在 main 上跑时第一个 diff 为空是正常的，只看第二个。）读 verdict：

- **只有 `server-only` / `non-runtime`** → 结论直接给出：「server 直接部署
  （Docker），与 worker 无关，不用打 tag」，**结束，不用跑第 3 步**。
- **命中 `wire-contract` 或 `gray`** → 进第 3 步。

### 第 3 步：跨版本 e2e（每档约 2–4 分钟，先征求用户同意再跑）

告知用户耗时后运行（两档可并行，用不同端口）：

```bash
pnpm build:main
# latest 档（打 tag 信号看这档）
PATH=/usr/bin:$PATH node scripts/cross-version-e2e.mjs "$(npm view vibedeckx version)"
# floor 档（兼容下限，可选；CI 矩阵里有，本地时间紧可跳过）
PATH=/usr/bin:$PATH XVER_SERVER_PORT=4631 XVER_WORKER_PORT=4632 node scripts/cross-version-e2e.mjs 0.2.0
```

读输出分支：

- 任何 `[xver] smoke X: FAILED` / 结尾 `FAIL` → **breaking，server 不能部署**。
  指出是哪个 capability 坏了，提示改成新旧并存，回第 1 步。
- **latest 档**出现 `404 — ... (expected gap)` / `missing on this version` →
  「server 可部署；这些 capability 要到达用户需要**打 tag 发 npm**（不打不会
  坏，只是新功能不可用）」。floor 档的 gap 是常态，忽略，不要当成信号报给用户。
- 两档全绿零 missing → 进第 4 步。

### 第 4 步：灰区判断（唯一需要问用户的一步）

走到这里说明：协议面没变、老 worker 不会坏，但 `gray` 文件改了 worker 侧行为
（典型：bug fix）。机器判断不了急不急——列出 gray 文件清单和各自改了什么
（读 diff 概括），然后**问用户**：这些修复对用户急不急？

- 急 → 建议：部署 server + 打 tag + 催升级。
- 不急 → 建议：部署 server，修复攒着随下次 tag 一起发。

## 最终输出格式

结论先行，一句话给出流程图落点和动作，例如：

> **结论：注册表新增 2 个条目（additive）→ server 可部署；新功能需打 tag 发
> npm 才对用户可用（不急）。**

然后附各步骤的关键证据行（红的用例名/verdict 行/expected gap 行），不要全量
粘贴测试输出。
