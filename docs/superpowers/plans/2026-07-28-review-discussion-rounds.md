# Review 讨论轮次(discussing 状态 + finalize gate)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户与 reviewer 多轮讨论后,通过显式"生成 review 终稿"动作让 reviewer 输出定稿,定稿照常进入既有确认/编辑 gate 再发回 source session。

**Architecture:** 新增 `discussing` 状态:给 reviewer 发消息不再取消 run 而是进入讨论态;"生成终稿"动作(gate 路由新 action `finalize`)注入固定 prompt 并把 run CAS 回 `waiting_reviewer`,复用既有 `handleTaskCompleted` → `waiting_feedback` 通路开 gate。通知 id 改为按轮次编码 turn index。给 source 发消息仍取消 run。

**Tech Stack:** Fastify + Kysely/SQLite(后端),Next.js 16 + React 19(前端),vitest。

**Spec:** `docs/superpowers/specs/2026-07-28-review-discussion-rounds-design.md`

## Global Constraints

- 后端 ESM + NodeNext:本地 import 一律带 `.js` 扩展名。
- 后端测试:`pnpm --filter vibedeckx test`(可加 ` -- <file>` 跑单文件);前端测试:`pnpm --filter vibedeckx-ui test`。
- 类型检查:后端 `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`;前端 `cd apps/vibedeckx-ui && npx tsc --noEmit`。
- UI 文案与后端面向用户的 error 字符串用中文,与现存文案风格一致(全角冒号/逗号见现有字符串)。
- TDD:每个任务先写失败测试再实现;每个任务单独 commit。
- 不做 schema 迁移:`workflow_runs.status` 是文本列,新增枚举值无需迁移。

---

### Task 1: storage — `discussing` 进入状态类型与活跃集合

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts:235-241`(`WorkflowRunStatus` 联合)
- Modify: `packages/vibedeckx/src/storage/repositories/workflow-runs.ts:7`(`ACTIVE` 数组)
- Test: `packages/vibedeckx/src/storage/workflow-runs.test.ts`

**Interfaces:**
- Produces: `WorkflowRunStatus` 含 `"discussing"`;`getActive`/`getAllActive`/`getActiveBySession` 把 discussing run 视为活跃(后续 engine/前端任务依赖)。

- [ ] **Step 1: 写失败测试**(加在 `workflowRuns repository` describe 内,沿用文件顶部的 `baseRun` fixture)

```ts
it("discussing runs count as active in all three active queries", async () => {
  await storage.workflowRuns.create(baseRun);
  await storage.workflowRuns.update("r1", { reviewer_session_id: "s-rev", status: "discussing" });
  expect((await storage.workflowRuns.getActive("p1", "dev")).map((r) => r.id)).toEqual(["r1"]);
  expect((await storage.workflowRuns.getAllActive()).map((r) => r.id)).toEqual(["r1"]);
  expect((await storage.workflowRuns.getActiveBySession("s-rev"))?.id).toBe("r1");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter vibedeckx test -- src/storage/workflow-runs.test.ts`
Expected: 新测试 FAIL(三个查询都返回空——`ACTIVE` 不含 discussing)。

- [ ] **Step 3: 实现**

`types.ts` 联合类型加一行(放在 `"waiting_feedback"` 之后):

```ts
export type WorkflowRunStatus =
  | "waiting_reviewer"
  | "waiting_feedback"
  | "discussing"
  | "sending_feedback"
  | "completed"
  | "cancelled"
  | "failed";
```

`repositories/workflow-runs.ts:7`:

```ts
const ACTIVE: WorkflowRunStatus[] = ["waiting_reviewer", "waiting_feedback", "discussing", "sending_feedback"];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter vibedeckx test -- src/storage/workflow-runs.test.ts`
Expected: PASS(全文件)。

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/storage/types.ts packages/vibedeckx/src/storage/repositories/workflow-runs.ts packages/vibedeckx/src/storage/workflow-runs.test.ts
git commit -m "feat(review): add discussing workflow-run status to storage"
```

---

### Task 2: 通知 id 按轮次 — `reviewReadyId(runId, turnEndEntryIndex)`

**Files:**
- Modify: `packages/vibedeckx/src/notification-milestones.ts:17-18`
- Modify: `packages/vibedeckx/src/workflow-engine.ts:746`(唯一调用点,`handleTaskCompleted` 内)
- Test: `packages/vibedeckx/src/workflow-engine.test.ts:844`(既有断言改格式)

**Interfaces:**
- Produces: `reviewReadyId(workflowRunId: string, turnEndEntryIndex: number): string`,格式 `workflow:<runId>:turn:<idx>:review-ready`。Task 4 的多轮测试断言两轮 id 不同。

- [ ] **Step 1: 改既有断言为新格式(先红)**

`workflow-engine.test.ts:844` 改为(该测试的 emit 用 `turnEndEntryIndex: 1`):

```ts
expect(rows[0].id).toBe(`workflow:${run.id}:turn:1:review-ready`);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter vibedeckx test -- src/workflow-engine.test.ts`
Expected: 该测试 FAIL(实际 id 仍是旧格式 `workflow:<runId>:review-ready`)。

- [ ] **Step 3: 实现**

`notification-milestones.ts:17-18` 改为(注释一并更新;`stateVersion` 注释块指 `workflowFailedId`,不动):

```ts
/**
 * Per-round: one review run can open the gate multiple times (initial review,
 * then each "final verdict" after a discussion round). The turn boundary index
 * of the reviewer turn that produced the verdict distinguishes rounds; a
 * replayed taskCompleted for the same turn must still collapse onto one id.
 */
export const reviewReadyId = (workflowRunId: string, turnEndEntryIndex: number): string =>
  `workflow:${workflowRunId}:turn:${turnEndEntryIndex}:review-ready`;
```

`workflow-engine.ts:746`(`handleTaskCompleted` 里 `boundary` 已在作用域):

```ts
id: reviewReadyId(run.id, boundary),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter vibedeckx test -- src/workflow-engine.test.ts src/notification-recovery.integration.test.ts`
Expected: PASS。(recovery 集成测试插入的是手写原始行,id 是自由文本,不受影响——跑它只为确认。)

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/notification-milestones.ts packages/vibedeckx/src/workflow-engine.ts packages/vibedeckx/src/workflow-engine.test.ts
git commit -m "feat(review): make review-ready milestone id per-round"
```

---

### Task 3: engine — reviewer 消息进入 discussing;source 仍取消;cancelRun 覆盖 discussing

**Files:**
- Modify: `packages/vibedeckx/src/workflow-engine.ts:800-830`(`cancelRun`)、`:832-863`(`handleExternalUserMessage`)
- Test: `packages/vibedeckx/src/workflow-engine.test.ts`(改 :786 的既有测试 + 新增 4 个)

**Interfaces:**
- Consumes: Task 1 的 `"discussing"` 状态。
- Produces: `handleExternalUserMessage(sessionId)` 语义——reviewer 参与者 → CAS 进 `discussing`(never-throws 不变);source 参与者 → 取消。`cancelRun` 接受 `discussing` 起点。Task 4/7/8 依赖此语义。

- [ ] **Step 1: 写失败测试**

改 `workflow-engine.test.ts:786` 的既有测试(takeover 语义现在只属于 source):

```ts
it("handleExternalUserMessage on the SOURCE ends the run (human takeover)", async () => {
  const run = await start();
  await engine.handleExternalUserMessage("s-src");
  expect((await storage.workflowRuns.getById(run.id))?.status).toBe("cancelled");
  expect(engine.shouldSuppressAgentEvent("s-rev")).toBe(false);
});
```

新增(同一 describe 内;`start()`/`bus`/`agentOps` 用既有 harness):

```ts
it("a user message to the reviewer moves waiting_feedback → discussing instead of cancelling", async () => {
  const run = await start();
  bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
  await vi.waitFor(async () => {
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
  });
  await engine.handleExternalUserMessage("s-rev");
  expect((await storage.workflowRuns.getById(run.id))?.status).toBe("discussing");
  // Run 仍活跃:参与者保留,后续 finalize/cancel 都要用。
  expect(engine.isSessionInActiveRun("s-rev")).toBe(true);
});

it("interrupting the reviewer mid-review (waiting_reviewer) also moves the run to discussing", async () => {
  const run = await start();
  await engine.handleExternalUserMessage("s-rev");
  expect((await storage.workflowRuns.getById(run.id))?.status).toBe("discussing");
});

it("reviewer taskCompleted during discussing neither reopens the gate nor creates a milestone", async () => {
  const run = await start();
  await engine.handleExternalUserMessage("s-rev"); // → discussing
  bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
  await new Promise((r) => setTimeout(r, 20));
  expect((await storage.workflowRuns.getById(run.id))?.status).toBe("discussing");
  expect(await storage.notificationOutbox.listAfter(0, 10)).toHaveLength(0);
});

it("cancelRun cancels a discussing run", async () => {
  const run = await start();
  await engine.handleExternalUserMessage("s-rev"); // → discussing
  const cancelled = await engine.cancelRun(run.id, "user cancelled");
  expect(cancelled?.status).toBe("cancelled");
  expect(engine.isSessionInActiveRun("s-src")).toBe(false);
});

it("handleExternalUserMessage never throws when storage rejects during the reviewer transition", async () => {
  // 本方法在 /message 路由投递前内联调用:异常冒出会阻断用户消息的投递,
  // 所以 reviewer 分支的 storage 失败也必须吞掉(同 source 分支的契约)。
  const run = await start();
  vi.spyOn(storage.workflowRuns, "transition").mockRejectedValueOnce(new Error("db locked"));
  await expect(engine.handleExternalUserMessage("s-rev")).resolves.toBeUndefined();
  expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_reviewer"); // 原状态未动
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter vibedeckx test -- src/workflow-engine.test.ts`
Expected: 上述 5 个测试 FAIL(reviewer 消息仍触发 cancel;discussing 无法 cancel)。
注意 :793 的 never-throws 测试(`s-rev` mid-send)应保持 PASS——新实现里 reviewer 路径两次 CAS 都失败后静默返回,同样不抛。

- [ ] **Step 3: 实现**

`cancelRun` 的 CAS 链(:810-812)加一条,并把上方注释里"only the two states below"改为"only the three states below":

```ts
const cancelled =
  (await this.storage.workflowRuns.transition(runId, "waiting_reviewer", "cancelled", patch)) ||
  (await this.storage.workflowRuns.transition(runId, "waiting_feedback", "cancelled", patch)) ||
  (await this.storage.workflowRuns.transition(runId, "discussing", "cancelled", patch));
```

`handleExternalUserMessage` 整体替换为(方法 doc 注释在原有基础上补一段"reviewer 分流"说明;never-throws 契约不变):

```ts
async handleExternalUserMessage(sessionId: string): Promise<void> {
  const p = this.participants.get(sessionId);
  if (!p) return;
  if (p.role === "reviewer") {
    // 讨论不是接管:用户给 reviewer 发消息 → run 进入 discussing,gate 收起,
    // 等待显式的 requestFinalVerdict 重新出稿。两个 from 状态各试一次(同
    // cancelRun 的写法);都失败说明 run 处于 sending_feedback 或已终态——
    // 静默不动。清掉 error:上一轮的 drift/发送警告对讨论态是陈旧信息,
    // 下一轮终稿会重新计算。整段包 try/catch:never-throws 契约覆盖 storage
    // 异常本身,不止 CAS 落败——异常冒出会阻断 /message 路由的消息投递。
    try {
      const moved =
        (await this.storage.workflowRuns.transition(p.runId, "waiting_feedback", "discussing", { error: null })) ||
        (await this.storage.workflowRuns.transition(p.runId, "waiting_reviewer", "discussing", { error: null }));
      if (moved) {
        const updated = await this.storage.workflowRuns.getById(p.runId);
        if (updated) this.emitRunUpdated(updated);
      }
    } catch (err) {
      console.error(
        `[WorkflowEngine] handleExternalUserMessage: failed moving run ${p.runId} to discussing; swallowed to honor never-throws contract`,
        err,
      );
    }
    return;
  }
  try {
    await this.cancelRun(p.runId, "用户接管：直接向 source session 发送了消息，review 已结束。");
  } catch (err) {
    if (err instanceof WorkflowError && err.code === "bad-state") {
      console.warn(
        `[WorkflowEngine] handleExternalUserMessage: run ${p.runId} is mid-send (sending_feedback); skipping takeover cancel`,
      );
    } else {
      console.error(
        `[WorkflowEngine] handleExternalUserMessage: unexpected error cancelling run ${p.runId}; swallowed to honor never-throws contract`,
        err,
      );
    }
  }
}
```

已有行为核对(不改代码,只确认):`handleTaskCompleted` 开头 `run.status !== "waiting_reviewer"` 即 return——discussing 期间讨论 turn 完成天然 no-op;`init` 对 discussing 不需特殊处理(稳定态,`getAllActive` 经 Task 1 已包含它,participants 正常重建);`shouldSuppressAgentEvent` 按参与者判定,讨论回复不产生通用会话通知——终稿轮经 review_ready 通知,符合"run 拥有注意力事件"的既有设计。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter vibedeckx test -- src/workflow-engine.test.ts`
Expected: PASS(全文件,含 :793 never-throws)。

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/workflow-engine.ts packages/vibedeckx/src/workflow-engine.test.ts
git commit -m "feat(review): reviewer messages enter discussing instead of cancelling the run"
```

---

### Task 4: engine — `FINAL_VERDICT_PROMPT` + `requestFinalVerdict`

**Files:**
- Modify: `packages/vibedeckx/src/workflow-engine.ts`(prompt 常量放在 `buildFeedbackMessage` 之后;方法放在 `approveFeedback` 之后)
- Test: `packages/vibedeckx/src/workflow-engine.test.ts`

**Interfaces:**
- Consumes: Task 3 的 discussing 转移;既有 `VERDICT_INSTRUCTIONS`(模块内常量)、`REVIEWER_TURN`、`WorkflowError`、`emitRunUpdated`。
- Produces: `requestFinalVerdict(runId: string): Promise<WorkflowRun>`(Task 5 路由调用);导出 `FINAL_VERDICT_PROMPT: string`(测试用)。

- [ ] **Step 1: 写失败测试**(describe 内加 helper + 4 个测试)

```ts
async function startDiscussion() {
  const run = await start();
  bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
  await vi.waitFor(async () => {
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
  });
  await engine.handleExternalUserMessage("s-rev");
  return run;
}

it("requestFinalVerdict sends the verdict prompt to the reviewer and returns to waiting_reviewer", async () => {
  const run = await startDiscussion();
  const updated = await engine.requestFinalVerdict(run.id);
  expect(updated.status).toBe("waiting_reviewer");
  const sent = agentOps.sendUserMessage.mock.calls.at(-1)!;
  expect(sent[0]).toBe("s-rev");
  expect(sent[1]).toBe(FINAL_VERDICT_PROMPT);
  // 终稿 turn 与初审/复审同处置:run 拥有注意力事件,不另发通用会话通知。
  expect(sent[4]).toEqual({ origin: "workflow", notificationDisposition: "milestone-managed" });
});

it("full loop: v1 gate → discussion → final verdict → v2 gate, distinct milestone ids", async () => {
  const run = await startDiscussion();
  await engine.requestFinalVerdict(run.id);
  reviewerEntries[2] = { type: "assistant", content: "Final: only rename X", timestamp: 3 };
  reviewerEntries[3] = { type: "turn_end", timestamp: 4 };
  bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 3 });
  await vi.waitFor(async () => {
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
  });
  expect((await storage.workflowRuns.getById(run.id))?.feedback_snapshot).toBe("Final: only rename X");
  const ids = (await storage.notificationOutbox.listAfter(0, 100)).map((r) => r.id);
  expect(ids).toContain(`workflow:${run.id}:turn:1:review-ready`);
  expect(ids).toContain(`workflow:${run.id}:turn:3:review-ready`);
});

it("requestFinalVerdict send failure rolls back to discussing with an error", async () => {
  const run = await startDiscussion();
  agentOps.sendUserMessage.mockResolvedValueOnce(false);
  await expect(engine.requestFinalVerdict(run.id)).rejects.toMatchObject({ code: "send-failed" });
  const after = await storage.workflowRuns.getById(run.id);
  expect(after?.status).toBe("discussing");
  expect(after?.error).toContain("发送失败");
});

it("requestFinalVerdict outside discussing rejects with bad-state", async () => {
  const run = await start(); // waiting_reviewer
  await expect(engine.requestFinalVerdict(run.id)).rejects.toMatchObject({ code: "bad-state" });
});
```

测试文件顶部 import 加 `FINAL_VERDICT_PROMPT`(与 `WorkflowEngine` 同一 import)。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter vibedeckx test -- src/workflow-engine.test.ts`
Expected: FAIL(`FINAL_VERDICT_PROMPT`/`requestFinalVerdict` 不存在)。

- [ ] **Step 3: 实现**

`buildFeedbackMessage` 之后加(`VERDICT_INSTRUCTIONS` 同模块可直接展开):

```ts
/**
 * Injected when the user finishes a discussion round and asks for a clean
 * final verdict. The reviewer's discussion replies are conversational and
 * unsuitable as feedback payloads; this prompt forces one turn whose output
 * IS the payload, which handleTaskCompleted then snapshots verbatim.
 */
export const FINAL_VERDICT_PROMPT = [
  "[Final verdict request]",
  "请把讨论后的最终 review 意见完整输出为面向作者的定稿。这段输出将原样发送给作者——不要包含对话性内容：不要引用讨论过程本身，不要向我提问。",
  "- 吸收讨论中达成一致的修正：撤回的条目不再出现，修订过的条目以修订后的形式给出。",
  "- 保持具体：每条指明文件/位置与问题，以及期望的修复方向。",
  ...VERDICT_INSTRUCTIONS,
].join("\n");
```

`approveFeedback` 之后加方法:

```ts
/**
 * Discussion → verdict: CAS the run back onto the reviewer track and inject
 * the final-verdict prompt. From waiting_reviewer the existing
 * handleTaskCompleted path reopens the gate with the new turn's output.
 * Send failure rolls the claim back so the finalize button stays actionable —
 * mirror of approveFeedback's no-auto-retry contract.
 */
async requestFinalVerdict(runId: string): Promise<WorkflowRun> {
  const run = await this.storage.workflowRuns.getById(runId);
  if (!run || run.status !== "discussing" || !run.reviewer_session_id) {
    throw new WorkflowError("bad-state", "run 不在讨论状态");
  }
  const claimed = await this.storage.workflowRuns.transition(runId, "discussing", "waiting_reviewer", { error: null });
  if (!claimed) throw new WorkflowError("bad-state", "run 状态已变化（可能已被处理）");

  const project = await this.storage.projects.getById(run.project_id);
  const sent = await this.agentOps
    .sendUserMessage(run.reviewer_session_id, FINAL_VERDICT_PROMPT, project?.path ?? undefined, undefined, REVIEWER_TURN)
    .catch(() => false);
  if (!sent) {
    await this.storage.workflowRuns.transition(runId, "waiting_reviewer", "discussing", {
      error: "发送失败：reviewer session 可能未运行。请在其窗口中唤醒后重试，或结束本次 review。",
    });
    const rolled = await this.storage.workflowRuns.getById(runId);
    if (rolled) this.emitRunUpdated(rolled);
    throw new WorkflowError("send-failed", "向 reviewer 发送终稿请求失败");
  }
  const updated = (await this.storage.workflowRuns.getById(runId))!;
  this.emitRunUpdated(updated);
  return updated;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter vibedeckx test -- src/workflow-engine.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/workflow-engine.ts packages/vibedeckx/src/workflow-engine.test.ts
git commit -m "feat(review): requestFinalVerdict turns a discussion round into a gated verdict"
```

---

### Task 5: gate 路由 — action `finalize`

**Files:**
- Modify: `packages/vibedeckx/src/routes/workflow-run-routes.ts:496-524`
- Test: `packages/vibedeckx/src/routes/workflow-run-routes.test.ts`(gate 测试旁)

**Interfaces:**
- Consumes: Task 4 的 `requestFinalVerdict(runId)`。
- Produces: `POST /api/workflow-runs/:id/gate` 接受 `{ action: "finalize" }`(Task 6 前端调用)。remote run 无需改动——`proxyAuto` 原样转发 body(:503),worker 侧引擎处理。

- [ ] **Step 1: 写失败测试**(放在 "gate maps bad-state to 409" 之后,沿用 `makeApp`/`workflowRunRoutes`/`run` fixture)

```ts
it("gate finalize calls requestFinalVerdict and returns the run", async () => {
  const requestFinalVerdict = vi.fn(async () => ({ ...run, status: "waiting_reviewer" }));
  const app = makeApp({ engine: { requestFinalVerdict } });
  await app.register(workflowRunRoutes);
  const res = await app.inject({
    method: "POST", url: "/api/workflow-runs/r1/gate",
    payload: { action: "finalize" },
  });
  expect(res.statusCode).toBe(200);
  expect(requestFinalVerdict).toHaveBeenCalledWith("r1");
  expect(res.json().run.status).toBe("waiting_reviewer");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter vibedeckx test -- src/routes/workflow-run-routes.test.ts`
Expected: FAIL(400 "action must be approve or cancel")。

- [ ] **Step 3: 实现**

路由泛型的 Body 类型改为 `{ action: "approve" | "cancel" | "finalize"; editedPayload?: string }`;`action === "cancel"` 分支后加:

```ts
if (action === "finalize") {
  const run = await fastify.workflowEngine.requestFinalVerdict(req.params.id);
  return reply.send({ run });
}
return reply.code(400).send({ error: "action must be approve, cancel or finalize" });
```

(`WorkflowError` → HTTP 状态映射沿用该路由既有的 catch,`bad-state` → 409、`send-failed` → 502/500 以现有映射为准,不新增分支。)

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter vibedeckx test -- src/routes/workflow-run-routes.test.ts src/routes/workflow-run-remote-routes.test.ts`
Expected: PASS(remote 测试不改——gate 代理对 body 是透传,行为不因新 action 变化)。

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/workflow-run-routes.ts packages/vibedeckx/src/routes/workflow-run-routes.test.ts
git commit -m "feat(review): gate route accepts finalize action"
```

---

### Task 6: 前端 API 层 — 类型与 finalize action

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts:1011`(status 联合)、`:2477`(`workflowRunGate` action 类型)

**Interfaces:**
- Produces: `WorkflowRun["status"]` 含 `"discussing"`;`api.workflowRunGate(runId, "finalize")` 可用(Task 7/8 调用)。

- [ ] **Step 1: 实现**(纯类型/联合扩展,无行为可测——由 Task 7/8 的组件测试和 tsc 覆盖)

`:1011`:

```ts
status: "waiting_reviewer" | "waiting_feedback" | "discussing" | "sending_feedback" | "completed" | "cancelled" | "failed";
```

`:2477` 签名:

```ts
async workflowRunGate(runId: string, action: "approve" | "cancel" | "finalize", editedPayload?: string): Promise<WorkflowRun> {
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts
git commit -m "feat(review): frontend api types for discussing status and finalize"
```

---

### Task 7: gate 面板 — discussing 分支(提示 + 镜像终稿按钮)

**Files:**
- Modify: `apps/vibedeckx-ui/components/conversation/review-run-panel.tsx`
- Create: `apps/vibedeckx-ui/components/conversation/review-run-panel.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `api.workflowRunGate(runId, "finalize")`、status 类型。
- Produces: 面板对 `discussing` run 显示"讨论中"提示 + "生成 review 终稿"按钮。

- [ ] **Step 1: 写失败测试**(新文件,harness 仿 `completion-notifications-menu.test.tsx`;mock 掉 api 与重量级 markdown 渲染)

```tsx
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runFixture = {
  id: "r1", project_id: "p1", branch: "dev",
  source_session_id: "s-src", source_turn_end_index: 4,
  reviewer_session_id: "s-rev", review_focus: null, review_target: null,
  review_span: "this_turn", feedback_snapshot: "old feedback",
  status: "discussing", error: null, created_at: "", updated_at: "",
};

vi.mock("@/lib/api", () => ({
  api: {
    getActiveWorkflowRuns: vi.fn(async () => [runFixture]),
    workflowRunGate: vi.fn(async () => runFixture),
    cancelWorkflowRun: vi.fn(async () => runFixture),
  },
}));
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

import { ReviewRunPanel } from "./review-run-panel";
import { api } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReviewRunPanel discussing state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the discussing hint and a mirrored finalize button", async () => {
    expect(container.textContent).toContain("讨论中");
    expect(container.textContent).toContain("生成 review 终稿");
    // 讨论态不显示发送/编辑(那是 waiting_feedback 的控件)。
    expect(container.textContent).not.toContain("发送反馈给原 session");
  });

  it("clicking finalize calls the gate with the finalize action", async () => {
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("生成 review 终稿"),
    )!;
    await act(async () => { btn.click(); });
    expect(api.workflowRunGate).toHaveBeenCalledWith("r1", "finalize");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter vibedeckx-ui test -- components/conversation/review-run-panel.test.tsx`
Expected: FAIL(`ACTIVE` 不含 discussing → 面板整体不渲染,textContent 为空)。

- [ ] **Step 3: 实现**

`review-run-panel.tsx`:

`:10` 活跃集合:

```ts
const ACTIVE = new Set(["waiting_reviewer", "waiting_feedback", "discussing", "sending_feedback"]);
```

头部状态文案(:71-73 的兄弟行)加:

```tsx
{run.status === "discussing" && "讨论中"}
```

`waiting_reviewer` 分支(:82-86)之后加 discussing 分支:

```tsx
{run.status === "discussing" && (
  <div className="flex items-center gap-2">
    <span className="text-xs text-muted-foreground">
      与 reviewer 讨论后，生成终稿再发送
    </span>
    <Button size="sm" variant="outline" disabled={busy === run.id}
      onClick={() => act(() => api.workflowRunGate(run.id, "finalize"), run.id)}>
      <FileCheck className="h-3 w-3 mr-1" />生成 review 终稿
    </Button>
  </div>
)}
```

`lucide-react` import 行加 `FileCheck`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter vibedeckx-ui test -- components/conversation/review-run-panel.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/conversation/review-run-panel.tsx apps/vibedeckx-ui/components/conversation/review-run-panel.test.tsx
git commit -m "feat(review): gate panel discussing state with mirrored finalize button"
```

---

### Task 8: reviewer 会话内 — WS 帧接入 + turn_end 终稿按钮

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-agent-session.ts`(帧类型 :71-75 一带、onmessage 处理 :560-585 一带、hook 返回值)
- Modify: `apps/vibedeckx-ui/components/agent/turn-end-divider.tsx`
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`(:209 hook 解构、:393 lastTurnEndIndex 附近加状态、:911 divider props)
- Create: `apps/vibedeckx-ui/components/agent/turn-end-divider.test.tsx`
- Modify: `packages/vibedeckx/src/routes/remote-status-bridge.ts`(新导出 `runUpdatedFrameForSubscribers`)
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts:282-291`(`workflowRunUpdated` 分支补 agent-stream 广播)
- Test: `packages/vibedeckx/src/routes/remote-status-bridge.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `WorkflowRun` 类型与 `workflowRunGate(…, "finalize")`;后端既有 `{ workflowRunUpdated: run }` 会话流帧(`conversation-patch.ts:49`)。注意:该帧目前**只有本地会话**收得到(`broadcastRawToSession` 推流);remote 路径在 `remote-agent-sessions.ts:282-291` 明确只转发 EventBus、不广播给 agent-stream subscribers——本任务补上这条广播,否则远程 reviewer 的终稿按钮不会实时出现(要刷新靠 REST 兜底)。
- Produces: `useAgentSession` 返回值新增 `workflowRunUpdate: WorkflowRun | null`;`TurnEndDivider` 新增可选 props `showFinalize?: boolean; finalizeBusy?: boolean; onFinalize?: () => void`;`runUpdatedFrameForSubscribers(evt): string`(映射后 id 的帧序列化)。

- [ ] **Step 1: 写失败测试**(新文件 `turn-end-divider.test.tsx`,harness 同 Task 7 风格)

```tsx
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnEndDivider } from "./turn-end-divider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps = {
  durationMs: 1000,
  emphasis: "normal" as const,
  agentType: "claude-code" as const,
  currentAgentName: "Claude Code",
  alternateProviders: [],
  onBranch: vi.fn(),
};

describe("TurnEndDivider finalize affordance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the finalize button only when showFinalize is set, and clicking calls onFinalize", () => {
    const onFinalize = vi.fn();
    act(() => {
      root.render(<TurnEndDivider {...baseProps} showFinalize onFinalize={onFinalize} />);
    });
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("生成 review 终稿"),
    )!;
    expect(btn).toBeTruthy();
    act(() => { btn.click(); });
    expect(onFinalize).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(<TurnEndDivider {...baseProps} />);
    });
    expect(container.textContent).not.toContain("生成 review 终稿");
  });

  it("disables the button while finalizeBusy", () => {
    act(() => {
      root.render(<TurnEndDivider {...baseProps} showFinalize finalizeBusy onFinalize={vi.fn()} />);
    });
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("生成 review 终稿"),
    )!;
    expect(btn.disabled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/turn-end-divider.test.tsx`
Expected: FAIL(props 不存在,按钮不渲染)。

- [ ] **Step 3: 实现 `turn-end-divider.tsx`**

Props 接口加三个可选项(注释说明用途):

```ts
/** Reviewer-of-an-active-run affordance: "生成 review 终稿" (spec: review discussion rounds). */
showFinalize?: boolean;
finalizeBusy?: boolean;
onFinalize?: () => void;
```

组件签名解构加 `showFinalize, finalizeBusy, onFinalize`;在时长 label 与 `BranchMenu` 之间渲染:

```tsx
{showFinalize && (
  <Button
    variant="outline"
    size="sm"
    className="h-6 px-2 text-xs shrink-0"
    onClick={onFinalize}
    disabled={disabled || finalizeBusy}
  >
    {finalizeBusy
      ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
      : <FileCheck className="h-3 w-3 mr-1" />}
    生成 review 终稿
  </Button>
)}
```

imports 加 `import { Button } from "@/components/ui/button";` 与 `import { FileCheck, Loader2 } from "lucide-react";`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/turn-end-divider.test.tsx`
Expected: PASS。

- [ ] **Step 5: 实现 `use-agent-session.ts` 帧接入**

帧类型联合(:71-75 一带)加 `| { workflowRunUpdated: WorkflowRun }`。`WorkflowRun` 从 `@/lib/api` type import——若该文件尚无来自 `@/lib/api` 的 import 行,则新增 `import type { WorkflowRun } from "@/lib/api";`。

State(与既有 state 声明并列):

```ts
const [workflowRunUpdate, setWorkflowRunUpdate] = useState<WorkflowRun | null>(null);
```

onmessage 链(`titleUpdated` 处理块之后,沿用同款 `"X" in msg` 判定):

```ts
if ("workflowRunUpdated" in msg) {
  setWorkflowRunUpdate(msg.workflowRunUpdated);
}
```

hook 返回对象加 `workflowRunUpdate`。

- [ ] **Step 6: 实现 `agent-conversation.tsx` 接线**

:209 解构加 `workflowRunUpdate`。`lastTurnEndIndex`(:393)附近加:

```ts
// 本 session 是否为某活跃 review run 的 reviewer(讨论态才显示终稿按钮)。
// 初始状态靠 REST 查询(刷新页面时 WS 帧还没来),此后由 workflowRunUpdated
// 帧驱动;终态帧清空。远程会话两侧 id 均已按 remote- 前缀映射,直接比对。
const RUN_ACTIVE = new Set(["waiting_reviewer", "waiting_feedback", "discussing", "sending_feedback"]);
const [reviewerRun, setReviewerRun] = useState<WorkflowRun | null>(null);
const [isFinalizing, setIsFinalizing] = useState(false);
// 复用组件既有的 `activeSessionId`(agent-conversation.tsx:236 已声明,
// 勿重复声明)——本段代码放在其声明之后。

useEffect(() => {
  if (!projectId || !activeSessionId) { setReviewerRun(null); return; }
  let stale = false;
  void api.getActiveWorkflowRuns(projectId, branch)
    .then((runs) => {
      if (!stale) setReviewerRun(runs.find((r) => r.reviewer_session_id === activeSessionId) ?? null);
    })
    .catch(() => { /* transient — WS 帧仍会驱动 */ });
  return () => { stale = true; };
}, [projectId, branch, activeSessionId]);

useEffect(() => {
  if (!workflowRunUpdate || workflowRunUpdate.reviewer_session_id !== activeSessionId) return;
  setReviewerRun(RUN_ACTIVE.has(workflowRunUpdate.status) ? workflowRunUpdate : null);
}, [workflowRunUpdate, activeSessionId]);

const handleFinalize = useCallback(async () => {
  if (!reviewerRun) return;
  setIsFinalizing(true);
  try {
    const run = await api.workflowRunGate(reviewerRun.id, "finalize");
    setReviewerRun(run);
  } catch {
    // 失败(如 reviewer 未唤醒)保持 discussing,按钮可重试;错误详情在 gate 面板。
  } finally {
    setIsFinalizing(false);
  }
}, [reviewerRun]);
```

(`RUN_ACTIVE` 放模块顶层常量区,不放组件体内。注意 `agent-conversation.tsx:57` 现有 import 是 `{ getAgentProviders, translateText, branchAgentSession }`——把 `api` 与 `type WorkflowRun` 追加进这一行。)

:911 的 `TurnEndDivider` props 加:

```tsx
showFinalize={index === lastTurnEndIndex && reviewerRun?.status === "discussing"}
finalizeBusy={isFinalizing}
onFinalize={handleFinalize}
```

- [ ] **Step 7: remote 帧广播 —— 先写失败测试**

`remote-status-bridge.test.ts` 的 `runUpdatedEventFromRemoteFrame` describe 内加(沿用其 `bare`/`localId`/`remoteInfo` fixture;import 行加 `runUpdatedFrameForSubscribers`):

```ts
it("runUpdatedFrameForSubscribers serializes the MAPPED run for agent-stream broadcast", () => {
  const evt = runUpdatedEventFromRemoteFrame({ workflowRunUpdated: bare }, localId, remoteInfo)!;
  const frame = JSON.parse(runUpdatedFrameForSubscribers(evt)) as { workflowRunUpdated: typeof evt.run };
  // 广播的必须是映射后的 run:裸 id 会让前端 reviewer_session_id 比对静默失败。
  expect(frame.workflowRunUpdated.id).toBe("remote-srv1-p1-run1");
  expect(frame.workflowRunUpdated.reviewer_session_id).toBe("remote-srv1-p1-rev1");
});
```

Run: `pnpm --filter vibedeckx test -- src/routes/remote-status-bridge.test.ts`
Expected: FAIL(`runUpdatedFrameForSubscribers` 不存在)。

- [ ] **Step 8: remote 帧广播 —— 实现**

`remote-status-bridge.ts`(`runUpdatedEventFromRemoteFrame` 之后):

```ts
/**
 * The same mapped run, re-serialized as the agent-stream frame. Local sessions
 * get `{ workflowRunUpdated }` on their stream via broadcastRawToSession; this
 * is the remote-side mirror of that contract — the frame must carry MAPPED
 * (remote- prefixed) ids or the frontend reviewer matcher silently fails.
 */
export function runUpdatedFrameForSubscribers(
  evt: Extract<GlobalEvent, { type: "workflow:run-updated" }>,
): string {
  return JSON.stringify({ workflowRunUpdated: evt.run });
}
```

`remote-agent-sessions.ts` 的 `workflowRunUpdated` 分支改为(原注释"Not broadcast to agent-stream subscribers"随之删除,替换为新语义;`runUpdatedFrameForSubscribers` 并入既有的 remote-status-bridge import 行):

```ts
} else if ("workflowRunUpdated" in parsed) {
  // Worker-side WorkflowEngine mirrors run transitions onto participant
  // session streams. Re-emit on the front bus (ChatSessionManager pushes
  // it to the Main Chat WS) AND mirror the mapped frame to this session's
  // agent-stream subscribers — the reviewer-side finalize button consumes
  // it live (local sessions get the same frame via broadcastRawToSession).
  // Duplicate delivery across both participant streams is harmless.
  const evt = runUpdatedEventFromRemoteFrame(parsed, sessionId, remoteInfo);
  if (evt) {
    eventBus?.emit(evt);
    cache.broadcast(sessionId, runUpdatedFrameForSubscribers(evt));
  }
}
```

Run: `pnpm --filter vibedeckx test -- src/routes/remote-status-bridge.test.ts src/remote-agent-sessions.test.ts`
Expected: PASS。
(说明:`handleLiveMessage` 是连接闭包、无测试缝,`cache.broadcast` 这一行的接线不做单测——帧内容(映射 id)已被上面的单测钉住,接线本身由 Task 9 的远程冒烟覆盖。)

- [ ] **Step 9: 类型检查 + 全量测试(双端)**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test && cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../.. && pnpm --filter vibedeckx-ui test`
Expected: 0 type errors;测试 PASS。

- [ ] **Step 10: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-agent-session.ts apps/vibedeckx-ui/components/agent/turn-end-divider.tsx apps/vibedeckx-ui/components/agent/turn-end-divider.test.tsx apps/vibedeckx-ui/components/agent/agent-conversation.tsx packages/vibedeckx/src/routes/remote-status-bridge.ts packages/vibedeckx/src/routes/remote-status-bridge.test.ts packages/vibedeckx/src/remote-agent-sessions.ts
git commit -m "feat(review): finalize-verdict button at reviewer turn ends (local + remote streams)"
```

---

### Task 9: 全量验证

**Files:** 无新改动(只验证;发现问题就地修复并归入对应模块的 commit)。

- [ ] **Step 1: 后端类型检查 + 全量测试**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: 0 errors,全部 PASS。

- [ ] **Step 2: 前端类型检查 + lint + 全量测试**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../.. && pnpm --filter vibedeckx-ui lint && pnpm --filter vibedeckx-ui test`
Expected: 全绿。

- [ ] **Step 3: 手工冒烟(可选,需真实 CLI)**

启动 `pnpm dev:all` → 发起一次 review → gate 出现后向 reviewer 会话发一条讨论消息 → 确认面板转为"讨论中"、turn_end 出现"生成 review 终稿" → 点击 → 新 gate 出现且内容为终稿 → 发送 → source 收到。远程 worker 场景照做一遍(gate 走代理)。

- [ ] **Step 4: 如有修复,按模块补 commit**

```bash
git status   # 应为 clean;有修复则归入对应模块提交
```
