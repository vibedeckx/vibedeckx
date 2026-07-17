# Ad-hoc Review Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Phase 1 minimal closed loop from `docs/superpowers/specs/2026-07-17-workflow-engine-review-loop-design.md`: 完成 → Review → reviewer 完成 → 用户确认（可编辑）→ Feedback 回投 source session。

**Architecture:** A deterministic `WorkflowEngine` (new backend module) owns the control flow; it creates a dedicated reviewer session per run, claims the reviewer's `session:taskCompleted` event (suppressing the Main Chat model wake), snapshots the full feedback text, and relays it back only after user confirmation via an editable pinned panel in Main Chat. No dispatchId / no loop state machine / no auto-relay in Phase 1.

**Tech Stack:** Fastify + better-sqlite3/Kysely (backend), Next.js 16 + React 19 (frontend), vitest.

## Global Constraints

- Backend is ESM with NodeNext resolution — **all local imports need `.js` extensions**.
- Backend typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`. Frontend lint: `pnpm --filter vibedeckx-ui lint`.
- Tests: vitest, colocated `*.test.ts`, run with `pnpm --filter vibedeckx test` (or `npx vitest run <file>` inside `packages/vibedeckx`).
- Every relay requires explicit user confirmation (spec §1.3). Send semantics are at-most-once + manual retry — **never auto-resend** (spec §3.2).
- Run statuses: `waiting_reviewer | waiting_feedback | sending_feedback | completed | cancelled | failed`. No `paused`.
- Remote sessions (`remote-` prefix) are out of scope — reject with 400.
- Frontend has no test infra; frontend tasks are verified by tsc + lint.
- Commit after every task (small, frequent commits).

---

### Task 1: turn_end-first event ordering + `turnEndEntryIndex`

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` (`endActiveTurn` ~:1387, `commitCompletion` ~:851-908)
- Modify: `packages/vibedeckx/src/event-bus.ts:9`

**Interfaces:**
- Produces: `session:taskCompleted` GlobalEvent gains `turnEndEntryIndex?: number`. `endActiveTurn` returns `Promise<number | null>` (index of the turn_end entry, `null` if no turn was in flight).

Rationale (spec §3.1): today the event is emitted before the `turn_end` entry exists, so consumers can neither locate the turn boundary nor branch at it.

- [ ] **Step 1: Change `endActiveTurn` to return the turn_end entry index**

In `agent-session-manager.ts` replace the method (~:1387):

```ts
private async endActiveTurn(
  session: RunningSession,
  outcome: Exclude<TurnOutcome, "server_restart">,
): Promise<number | null> {
  if (session.turnOpenSince === null) return null; // no turn in flight
  const endedAt = Date.now();
  const durationMs = endedAt - session.turnOpenSince;
  const index = await this.pushEntry(
    session.id,
    { type: "turn_end", timestamp: endedAt, durationMs, outcome },
    true,
  );
  session.turnOpenSince = null;
  return index >= 0 ? index : null;
}
```

(`pushEntry` already returns the index; other call sites of `endActiveTurn` ignore the return value and need no change.)

- [ ] **Step 2: Reorder `commitCompletion` — persist turn_end BEFORE emitting the event, and carry the index**

In `commitCompletion` (~:851-885), move the `endActiveTurn` call **above** `broadcastRaw`/`eventBus.emit`, and thread the index into the event. The region becomes:

```ts
const completedAt = Date.now();
if (!session.skipDb) {
  await this.storage.agentSessions.markCompleted(sessionId, completedAt);
}
// Stop point: persist the turn_end marker BEFORE the completion event goes
// out, so event consumers can use its index as a turn boundary / branch cutoff.
const turnEndEntryIndex = await this.endActiveTurn(session, "completed");
const summaryText = extractLastAssistantText(session.store.entries);
this.broadcastRaw(sessionId, {
  taskCompleted: {
    duration_ms: payload.duration_ms,
    cost_usd: payload.cost_usd,
    input_tokens: payload.input_tokens,
    output_tokens: payload.output_tokens,
    summaryText,
  },
});
this.eventBus?.emit({
  type: "session:taskCompleted",
  projectId: session.projectId,
  branch: session.branch,
  sessionId,
  duration_ms: payload.duration_ms,
  cost_usd: payload.cost_usd,
  input_tokens: payload.input_tokens,
  output_tokens: payload.output_tokens,
  summaryText,
  turnEndEntryIndex: turnEndEntryIndex ?? undefined,
});
await this.emitDerivedBranchActivity(session.projectId, session.branch);
```

Delete the old `await this.endActiveTurn(session, "completed");` line (and its comment) that previously sat below the emit. The rest of `commitCompletion` (status flip, task auto-complete) is unchanged.

- [ ] **Step 3: Extend the event type**

In `event-bus.ts:9` change the variant to:

```ts
| { type: "session:taskCompleted"; projectId: string; branch: string | null; sessionId: string; duration_ms?: number; cost_usd?: number; input_tokens?: number; output_tokens?: number; summaryText?: string; turnEndEntryIndex?: number }
```

- [ ] **Step 4: Typecheck + existing tests**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` → no errors.
Run: `pnpm --filter vibedeckx test` → all existing tests pass.
(No direct unit-test seam: `commitCompletion` is private inside the process-spawning manager. The ordering is exercised end-to-end by the engine tests in Task 4 via the event contract, and by e2e later.)

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/event-bus.ts
git commit -m "feat(events): persist turn_end before taskCompleted and carry turnEndEntryIndex"
```

---

### Task 2: `workflow_runs` storage (schema + repo + types)

**Files:**
- Modify: `packages/vibedeckx/src/storage/schema.ts` (add table interface + DB map entry)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (CREATE TABLE + repo wiring)
- Modify: `packages/vibedeckx/src/storage/types.ts` (WorkflowRun type + Storage sub-interface)
- Create: `packages/vibedeckx/src/storage/repositories/workflow-runs.ts`
- Test: `packages/vibedeckx/src/storage/workflow-runs.test.ts`

**Interfaces:**
- Produces:
  - `type WorkflowRunStatus = "waiting_reviewer" | "waiting_feedback" | "sending_feedback" | "completed" | "cancelled" | "failed"`
  - `interface WorkflowRun { id: string; project_id: string; branch: string | null; source_session_id: string; source_turn_end_index: number; reviewer_session_id: string | null; review_focus: string | null; review_target: string | null; feedback_snapshot: string | null; status: WorkflowRunStatus; error: string | null; created_at: string; updated_at: string }`
  - `storage.workflowRuns.create(opts: { id: string; project_id: string; branch: string | null; source_session_id: string; source_turn_end_index: number; review_focus: string | null; review_target: string | null }): Promise<WorkflowRun>`
  - `storage.workflowRuns.getById(id: string): Promise<WorkflowRun | undefined>`
  - `storage.workflowRuns.getActive(projectId: string, branch: string | null): Promise<WorkflowRun[]>` (status in the three non-terminal values)
  - `storage.workflowRuns.getAllActive(): Promise<WorkflowRun[]>` (for boot recovery)
  - `storage.workflowRuns.getActiveBySession(sessionId: string): Promise<WorkflowRun | undefined>` (matches source OR reviewer id)
  - `storage.workflowRuns.update(id: string, patch: Partial<Pick<WorkflowRun, "reviewer_session_id" | "review_target" | "feedback_snapshot" | "status" | "error">>): Promise<WorkflowRun | undefined>`
  - `storage.workflowRuns.transition(id: string, from: WorkflowRunStatus, to: WorkflowRunStatus, patch?: Partial<Pick<WorkflowRun, "feedback_snapshot" | "error">>): Promise<boolean>` — atomic CAS (`UPDATE … WHERE id = ? AND status = ?`), returns whether a row changed.

- [ ] **Step 1: Write the failing test**

`packages/vibedeckx/src/storage/workflow-runs.test.ts` (follow `storage/workspace.test.ts` pattern):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("workflowRuns repository", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-wfr-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseRun = {
    id: "r1",
    project_id: "p1",
    branch: "dev",
    source_session_id: "s-src",
    source_turn_end_index: 42,
    review_focus: null,
    review_target: JSON.stringify({ baseHead: "abc", diffDigest: "d", capturedAt: 1 }),
  };

  it("creates a run with waiting_reviewer status", async () => {
    const run = await storage.workflowRuns.create(baseRun);
    expect(run.status).toBe("waiting_reviewer");
    expect(run.source_turn_end_index).toBe(42);
    expect(run.reviewer_session_id).toBeNull();
  });

  it("getActive filters by workspace and non-terminal status", async () => {
    await storage.workflowRuns.create(baseRun);
    await storage.workflowRuns.create({ ...baseRun, id: "r2", branch: "other" });
    const active = await storage.workflowRuns.getActive("p1", "dev");
    expect(active.map((r) => r.id)).toEqual(["r1"]);
    await storage.workflowRuns.update("r1", { status: "completed" });
    expect(await storage.workflowRuns.getActive("p1", "dev")).toEqual([]);
  });

  it("getActiveBySession matches source and reviewer ids", async () => {
    await storage.workflowRuns.create(baseRun);
    await storage.workflowRuns.update("r1", { reviewer_session_id: "s-rev" });
    expect((await storage.workflowRuns.getActiveBySession("s-src"))?.id).toBe("r1");
    expect((await storage.workflowRuns.getActiveBySession("s-rev"))?.id).toBe("r1");
    expect(await storage.workflowRuns.getActiveBySession("nope")).toBeUndefined();
  });

  it("transition is an atomic CAS", async () => {
    await storage.workflowRuns.create(baseRun);
    const ok = await storage.workflowRuns.transition("r1", "waiting_reviewer", "waiting_feedback", {
      feedback_snapshot: "looks wrong",
    });
    expect(ok).toBe(true);
    const again = await storage.workflowRuns.transition("r1", "waiting_reviewer", "waiting_feedback");
    expect(again).toBe(false); // status no longer waiting_reviewer
    const run = await storage.workflowRuns.getById("r1");
    expect(run?.status).toBe("waiting_feedback");
    expect(run?.feedback_snapshot).toBe("looks wrong");
  });

  it("getAllActive returns non-terminal runs across workspaces", async () => {
    await storage.workflowRuns.create(baseRun);
    await storage.workflowRuns.create({ ...baseRun, id: "r2", branch: "other" });
    await storage.workflowRuns.update("r2", { status: "cancelled" });
    expect((await storage.workflowRuns.getAllActive()).map((r) => r.id)).toEqual(["r1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/storage/workflow-runs.test.ts`
Expected: FAIL — `storage.workflowRuns` is undefined / table missing.

- [ ] **Step 3: Implement schema + table + repo**

**`storage/schema.ts`** — add near the other table interfaces:

```ts
export interface WorkflowRunsTable {
  id: string;
  project_id: string;
  branch: string | null;
  source_session_id: string;
  source_turn_end_index: number;
  reviewer_session_id: string | null;
  review_focus: string | null;
  review_target: string | null;
  feedback_snapshot: string | null;
  status: string;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}
```

and in `interface DB` add: `workflow_runs: WorkflowRunsTable;`

**`storage/sqlite.ts`** — inside the big `db.exec(...)` schema block add:

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  branch TEXT,
  source_session_id TEXT NOT NULL,
  source_turn_end_index INTEGER NOT NULL,
  reviewer_session_id TEXT,
  review_focus TEXT,
  review_target TEXT,
  feedback_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'waiting_reviewer',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

**`storage/types.ts`** — add:

```ts
export type WorkflowRunStatus =
  | "waiting_reviewer"
  | "waiting_feedback"
  | "sending_feedback"
  | "completed"
  | "cancelled"
  | "failed";

export interface WorkflowRun {
  id: string;
  project_id: string;
  branch: string | null;
  source_session_id: string;
  source_turn_end_index: number;
  reviewer_session_id: string | null;
  review_focus: string | null;
  review_target: string | null;
  feedback_snapshot: string | null;
  status: WorkflowRunStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}
```

and in `interface Storage` add the sub-interface (mirror the `commands` style):

```ts
workflowRuns: {
  create(opts: {
    id: string;
    project_id: string;
    branch: string | null;
    source_session_id: string;
    source_turn_end_index: number;
    review_focus: string | null;
    review_target: string | null;
  }): Promise<WorkflowRun>;
  getById(id: string): Promise<WorkflowRun | undefined>;
  getActive(projectId: string, branch: string | null): Promise<WorkflowRun[]>;
  getAllActive(): Promise<WorkflowRun[]>;
  getActiveBySession(sessionId: string): Promise<WorkflowRun | undefined>;
  update(
    id: string,
    patch: Partial<Pick<WorkflowRun, "reviewer_session_id" | "review_target" | "feedback_snapshot" | "status" | "error">>,
  ): Promise<WorkflowRun | undefined>;
  transition(
    id: string,
    from: WorkflowRunStatus,
    to: WorkflowRunStatus,
    patch?: Partial<Pick<WorkflowRun, "feedback_snapshot" | "error">>,
  ): Promise<boolean>;
};
```

**`storage/repositories/workflow-runs.ts`** (new file, mirror `workspace.ts` factory style):

```ts
import { sql, type Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage, WorkflowRun, WorkflowRunStatus } from "../types.js";

const ACTIVE: WorkflowRunStatus[] = ["waiting_reviewer", "waiting_feedback", "sending_feedback"];

const asRun = (row: unknown): WorkflowRun => row as WorkflowRun;

export const createWorkflowRunRepos = (kdb: Kysely<DB>): Pick<Storage, "workflowRuns"> => ({
  workflowRuns: {
    create: async (opts) => {
      await kdb.insertInto("workflow_runs").values({ ...opts, status: "waiting_reviewer" }).execute();
      const row = await kdb
        .selectFrom("workflow_runs").selectAll().where("id", "=", opts.id)
        .executeTakeFirstOrThrow();
      return asRun(row);
    },
    getById: async (id) => {
      const row = await kdb.selectFrom("workflow_runs").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? asRun(row) : undefined;
    },
    getActive: async (projectId, branch) => {
      const rows = await kdb
        .selectFrom("workflow_runs").selectAll()
        .where("project_id", "=", projectId)
        .where("branch", "is", branch)
        .where("status", "in", ACTIVE)
        .orderBy("created_at", "asc")
        .execute();
      return rows.map(asRun);
    },
    getAllActive: async () => {
      const rows = await kdb
        .selectFrom("workflow_runs").selectAll().where("status", "in", ACTIVE)
        .orderBy("created_at", "asc").execute();
      return rows.map(asRun);
    },
    getActiveBySession: async (sessionId) => {
      const row = await kdb
        .selectFrom("workflow_runs").selectAll()
        .where("status", "in", ACTIVE)
        .where((eb) => eb.or([
          eb("source_session_id", "=", sessionId),
          eb("reviewer_session_id", "=", sessionId),
        ]))
        .executeTakeFirst();
      return row ? asRun(row) : undefined;
    },
    update: async (id, patch) => {
      if (Object.keys(patch).length > 0) {
        await kdb.updateTable("workflow_runs")
          .set({ ...patch, updated_at: sql`datetime('now')` })
          .where("id", "=", id).execute();
      }
      const row = await kdb.selectFrom("workflow_runs").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? asRun(row) : undefined;
    },
    transition: async (id, from, to, patch) => {
      const result = await kdb.updateTable("workflow_runs")
        .set({ ...(patch ?? {}), status: to, updated_at: sql`datetime('now')` })
        .where("id", "=", id)
        .where("status", "=", from)
        .executeTakeFirst();
      return (result.numUpdatedRows ?? 0n) > 0n;
    },
  },
});
```

**Wire in** `createSqliteStorage` (`storage/sqlite.ts` ~:825-853): import `createWorkflowRunRepos` from `./repositories/workflow-runs.js` and spread `...createWorkflowRunRepos(kdb),` alongside the other repos.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/vibedeckx && npx vitest run src/storage/workflow-runs.test.ts`
Expected: PASS (5 tests).
Also run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/storage
git commit -m "feat(storage): workflow_runs table + repository"
```

---

### Task 3: Review-target capture util (`baseHead` + `diffDigest`)

**Files:**
- Create: `packages/vibedeckx/src/utils/review-target.ts`
- Test: `packages/vibedeckx/src/utils/review-target.test.ts`

**Interfaces:**
- Produces:
  - `interface ReviewTarget { baseHead: string | null; diffDigest: string | null; diffStat: string | null; capturedAt: number }`
  - `captureReviewTarget(worktreePath: string): ReviewTarget` (never throws; nulls on non-git dir)
  - `hasDrifted(worktreePath: string, target: ReviewTarget): boolean`

- [ ] **Step 1: Write the failing test**

`packages/vibedeckx/src/utils/review-target.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { captureReviewTarget, hasDrifted } from "./review-target.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" });

describe("review-target", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-rt-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "init"]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("captures HEAD and a stable digest", () => {
    const t1 = captureReviewTarget(dir);
    expect(t1.baseHead).toMatch(/^[0-9a-f]{40}$/);
    const t2 = captureReviewTarget(dir);
    expect(t2.diffDigest).toBe(t1.diffDigest);
    expect(hasDrifted(dir, t1)).toBe(false);
  });

  it("detects uncommitted working-tree drift (no HEAD change)", () => {
    const t = captureReviewTarget(dir);
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    expect(hasDrifted(dir, t)).toBe(true);
  });

  it("detects untracked-file drift", () => {
    const t = captureReviewTarget(dir);
    writeFileSync(path.join(dir, "new.txt"), "x\n");
    expect(hasDrifted(dir, t)).toBe(true);
  });

  it("returns nulls (not throws) outside a git repo", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "vdx-plain-"));
    try {
      const t = captureReviewTarget(plain);
      expect(t.baseHead).toBeNull();
      expect(hasDrifted(plain, t)).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-target.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/vibedeckx/src/utils/review-target.ts` (follow the `merge-status.ts` `git()` wrapper style):

```ts
import { execFileSync } from "child_process";
import { createHash } from "crypto";

const MAX_BUFFER = 10 * 1024 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Lightweight capture of the workspace state at review time (spec §3.3).
 * We store a digest, never the patch text itself (size / binary / sensitive
 * content concerns). The digest covers uncommitted changes and untracked
 * files, which a bare HEAD comparison would miss.
 */
export interface ReviewTarget {
  baseHead: string | null;
  diffDigest: string | null;
  diffStat: string | null;
  capturedAt: number;
}

export function captureReviewTarget(worktreePath: string): ReviewTarget {
  try {
    const baseHead = git(worktreePath, ["rev-parse", "HEAD"]).trim();
    const diff = git(worktreePath, ["diff"]);
    const status = git(worktreePath, ["status", "--porcelain"]);
    const diffDigest = createHash("sha256").update(diff).update("\0").update(status).digest("hex");
    const diffStat = git(worktreePath, ["diff", "--shortstat"]).trim() || null;
    return { baseHead, diffDigest, diffStat, capturedAt: Date.now() };
  } catch {
    return { baseHead: null, diffDigest: null, diffStat: null, capturedAt: Date.now() };
  }
}

export function hasDrifted(worktreePath: string, target: ReviewTarget): boolean {
  if (!target.baseHead || !target.diffDigest) return false;
  const current = captureReviewTarget(worktreePath);
  if (!current.baseHead || !current.diffDigest) return false;
  return current.baseHead !== target.baseHead || current.diffDigest !== target.diffDigest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-target.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/utils/review-target.ts packages/vibedeckx/src/utils/review-target.test.ts
git commit -m "feat(workflow): review-target capture with drift-detecting digest"
```

---

### Task 4: WorkflowEngine

**Files:**
- Create: `packages/vibedeckx/src/workflow-engine.ts`
- Test: `packages/vibedeckx/src/workflow-engine.test.ts`

**Interfaces:**
- Consumes: Task 2 `storage.workflowRuns`, Task 3 `captureReviewTarget`/`hasDrifted`, Task 1 event shape.
- Produces (used by Tasks 5-6):
  - `interface AgentOps { createNewSession(projectId: string, branch: string | null, projectPath: string, skipDb?: boolean, permissionMode?: "plan" | "edit", agentType?: string, announceRunning?: boolean): Promise<string>; sendUserMessage(sessionId: string, content: string, projectPath?: string): Promise<boolean>; getMessages(sessionId: string): AgentMessage[] }` (structurally satisfied by `AgentSessionManager`)
  - `class WorkflowEngine`:
    - `constructor(storage: Storage, agentOps: AgentOps)`
    - `setEventBus(bus: EventBus): void` — subscribes to `session:taskCompleted`
    - `init(): Promise<void>` — boot recovery (rebuild locks; `sending_feedback` → `waiting_feedback` + "发送状态未知" error; `waiting_reviewer` → advisory error note)
    - `shouldSuppressAgentEvent(sessionId: string): boolean` — **synchronous**; true only for active runs' reviewer sessions
    - `isSessionInActiveRun(sessionId: string): boolean` — synchronous, source or reviewer
    - `startAdhocReview(opts: { project: { id: string; path: string }; branch: string | null; sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number }): Promise<WorkflowRun>` — throws `WorkflowError` with `code: "session-busy" | "no-completed-turn" | "spawn-failed"`
    - `approveFeedback(runId: string, editedPayload?: string): Promise<WorkflowRun>` — throws `WorkflowError` `code: "bad-state"`
    - `cancelRun(runId: string, reason?: string): Promise<WorkflowRun | undefined>`
    - `handleExternalUserMessage(sessionId: string): Promise<void>` — human takeover: ends the run
  - `class WorkflowError extends Error { code: string }`
  - Exported pure helpers (unit-tested): `extractLatestTurnEndIndex(entries: AgentMessage[]): number | null`, `extractLastAssistantBefore(entries: AgentMessage[], beforeIndex: number): string | null`, `extractTaskContextBefore(entries: AgentMessage[], turnEndIndex: number): string | null`, `buildReviewerPrompt(opts)`, `buildFeedbackMessage(feedback: string)`
  - New GlobalEvent variant: `{ type: "workflow:run-updated"; projectId: string; branch: string | null; run: WorkflowRun }` (add to `event-bus.ts`, import `type { WorkflowRun } from "./storage/types.js"`)

- [ ] **Step 1: Add the `workflow:run-updated` event variant**

In `event-bus.ts`, add to the `GlobalEvent` union:

```ts
| { type: "workflow:run-updated"; projectId: string; branch: string | null; run: import("./storage/types.js").WorkflowRun }
```

- [ ] **Step 2: Write the failing tests**

`packages/vibedeckx/src/workflow-engine.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { EventBus } from "./event-bus.js";
import {
  WorkflowEngine,
  WorkflowError,
  extractLatestTurnEndIndex,
  extractLastAssistantBefore,
  extractTaskContextBefore,
} from "./workflow-engine.js";
import type { AgentMessage } from "./agent-types.js";

const entries: AgentMessage[] = [];
entries[0] = { type: "user", content: "please fix the bug", timestamp: 1 };
entries[1] = { type: "assistant", content: "working on it", timestamp: 2 };
entries[3] = { type: "assistant", content: "done — fixed in foo.ts", timestamp: 3 };
entries[4] = { type: "turn_end", timestamp: 4 };

describe("pure helpers", () => {
  it("extractLatestTurnEndIndex finds the last turn_end in a sparse array", () => {
    expect(extractLatestTurnEndIndex(entries)).toBe(4);
    expect(extractLatestTurnEndIndex([])).toBeNull();
  });

  it("extractLastAssistantBefore walks down past holes", () => {
    expect(extractLastAssistantBefore(entries, 4)).toBe("done — fixed in foo.ts");
    expect(extractLastAssistantBefore(entries, 3)).toBe("working on it");
    expect(extractLastAssistantBefore(entries, 0)).toBeNull();
  });

  it("extractTaskContextBefore finds the turn's user message", () => {
    expect(extractTaskContextBefore(entries, 4)).toBe("please fix the bug");
  });
});

describe("WorkflowEngine", () => {
  let dir: string;
  let storage: Storage;
  let engine: WorkflowEngine;
  let bus: EventBus;
  const reviewerEntries: AgentMessage[] = [];
  const agentOps = {
    createNewSession: vi.fn(async () => "s-rev"),
    sendUserMessage: vi.fn(async () => true),
    getMessages: vi.fn((sessionId: string) => (sessionId === "s-rev" ? reviewerEntries : entries)),
  };
  const project = { id: "p1", path: "/tmp/does-not-exist-vdx" }; // non-git → null review target, still fine

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-eng-"));
    storage = await createSqliteStorage(path.join(dir, "t.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: project.path });
    bus = new EventBus();
    engine = new WorkflowEngine(storage, agentOps);
    engine.setEventBus(bus);
    await engine.init();
    reviewerEntries.length = 0;
    reviewerEntries[0] = { type: "assistant", content: "Feedback: rename X; add test for Y", timestamp: 1 };
    reviewerEntries[1] = { type: "turn_end", timestamp: 2 };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    return engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src", reviewFocus: "focus on tests",
    });
  }

  it("startAdhocReview creates run, spawns reviewer, sends prompt", async () => {
    const run = await start();
    expect(run.status).toBe("waiting_reviewer");
    expect(run.reviewer_session_id).toBe("s-rev");
    expect(run.source_turn_end_index).toBe(4); // derived from entries
    expect(agentOps.createNewSession).toHaveBeenCalledWith("p1", "dev", project.path, false, "edit", "claude-code", true);
    const prompt = agentOps.sendUserMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("please fix the bug");   // task context
    expect(prompt).toContain("focus on tests");        // review focus
  });

  it("rejects when a participant session is already in an active run", async () => {
    await start();
    await expect(start()).rejects.toMatchObject({ code: "session-busy" });
  });

  it("rejects a source session with no completed turn", async () => {
    agentOps.getMessages.mockReturnValueOnce([]);
    await expect(start()).rejects.toMatchObject({ code: "no-completed-turn" });
  });

  it("claims reviewer completion: suppresses, snapshots full feedback, waits for gate", async () => {
    const run = await start();
    expect(engine.shouldSuppressAgentEvent("s-rev")).toBe(true);
    expect(engine.shouldSuppressAgentEvent("s-src")).toBe(false);
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    const updated = await storage.workflowRuns.getById(run.id);
    expect(updated?.feedback_snapshot).toBe("Feedback: rename X; add test for Y");
  });

  it("approveFeedback CAS-sends edited payload back to source and completes", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    const done = await engine.approveFeedback(run.id, "edited feedback");
    expect(done.status).toBe("completed");
    const sent = agentOps.sendUserMessage.mock.calls.at(-1)!;
    expect(sent[0]).toBe("s-src");
    expect(sent[1]).toContain("edited feedback");
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
  });

  it("failed send returns run to waiting_feedback with error, no auto-retry", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    agentOps.sendUserMessage.mockResolvedValueOnce(false);
    await expect(engine.approveFeedback(run.id)).rejects.toMatchObject({ code: "send-failed" });
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("waiting_feedback");
    expect(after?.error).toContain("未运行");
  });

  it("handleExternalUserMessage ends the run (human takeover)", async () => {
    const run = await start();
    await engine.handleExternalUserMessage("s-rev");
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("cancelled");
    expect(engine.shouldSuppressAgentEvent("s-rev")).toBe(false);
  });

  it("boot recovery: sending_feedback → waiting_feedback with unknown-send warning", async () => {
    const run = await start();
    await storage.workflowRuns.update(run.id, { status: "sending_feedback", feedback_snapshot: "fb" });
    const engine2 = new WorkflowEngine(storage, agentOps);
    await engine2.init();
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("waiting_feedback");
    expect(after?.error).toContain("发送状态未知");
    expect(engine2.isSessionInActiveRun("s-src")).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/vibedeckx && npx vitest run src/workflow-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `workflow-engine.ts`**

```ts
import { randomUUID } from "crypto";
import type { Storage, WorkflowRun } from "./storage/types.js";
import type { EventBus, GlobalEvent } from "./event-bus.js";
import type { AgentMessage } from "./agent-types.js";
import { captureReviewTarget, hasDrifted, type ReviewTarget } from "./utils/review-target.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";

/** Minimal surface the engine needs from AgentSessionManager (structural). */
export interface AgentOps {
  createNewSession(
    projectId: string,
    branch: string | null,
    projectPath: string,
    skipDb?: boolean,
    permissionMode?: "plan" | "edit",
    agentType?: string,
    announceRunning?: boolean,
  ): Promise<string>;
  sendUserMessage(sessionId: string, content: string, projectPath?: string): Promise<boolean>;
  getMessages(sessionId: string): AgentMessage[];
}

export class WorkflowError extends Error {
  constructor(public code: "session-busy" | "no-completed-turn" | "spawn-failed" | "bad-state" | "send-failed", message: string) {
    super(message);
  }
}

// ---------- pure helpers (exported for tests / reuse) ----------

export function extractLatestTurnEndIndex(entries: AgentMessage[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "turn_end") return i;
  }
  return null;
}

export function extractLastAssistantBefore(entries: AgentMessage[], beforeIndex: number): string | null {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "assistant" && typeof e.content === "string" && e.content.trim()) return e.content;
  }
  return null;
}

export function extractTaskContextBefore(entries: AgentMessage[], turnEndIndex: number): string | null {
  for (let i = turnEndIndex - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "user" && typeof e.content === "string" && e.content.trim()) {
      return e.content.length > 2000 ? e.content.slice(0, 2000) + "…" : e.content;
    }
  }
  return null;
}

export function buildReviewerPrompt(opts: {
  taskContext: string | null;
  reviewFocus: string | null;
  target: ReviewTarget;
}): string {
  return [
    "You are a code reviewer agent. Another agent just completed work in this workspace; review it critically and independently.",
    opts.taskContext ? `\n## Original task\n${opts.taskContext}` : null,
    opts.reviewFocus ? `\n## Review focus (from the user)\n${opts.reviewFocus}` : null,
    "\n## How to review",
    "- Inspect the actual workspace state yourself: read the relevant files, run `git diff`, `git status` and `git log`.",
    opts.target.baseHead
      ? `- The work was captured at commit ${opts.target.baseHead}${opts.target.diffStat ? ` with uncommitted changes (${opts.target.diffStat})` : " with no uncommitted changes"}.`
      : null,
    "- Judge correctness, completeness against the task, and code quality. Be specific: reference files and lines.",
    "\nEnd your final message with a clear, actionable list of feedback items — or state explicitly that the work looks good.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export function buildFeedbackMessage(feedback: string): string {
  return [
    "[Review Feedback]",
    "A reviewer agent examined your last completed work. Please address the following feedback:",
    "",
    feedback,
  ].join("\n");
}

// ---------- engine ----------

interface Participant {
  runId: string;
  role: "source" | "reviewer";
}

export class WorkflowEngine {
  private eventBus?: EventBus;
  /** sessionId → participation in an active run (rebuilt on boot). */
  private participants = new Map<string, Participant>();

  constructor(
    private storage: Storage,
    private agentOps: AgentOps,
  ) {}

  setEventBus(bus: EventBus): void {
    this.eventBus = bus;
    bus.subscribe((event: GlobalEvent) => {
      if (event.type === "session:taskCompleted") {
        void this.handleTaskCompleted(event).catch((err) =>
          console.error("[WorkflowEngine] handleTaskCompleted failed:", err),
        );
      }
    });
  }

  /** Boot recovery (spec §3.4). Call once after storage is ready. */
  async init(): Promise<void> {
    const active = await this.storage.workflowRuns.getAllActive();
    for (const run of active) {
      if (run.status === "sending_feedback") {
        // Crash mid-send: honest at-most-once — never auto-resend.
        await this.storage.workflowRuns.update(run.id, {
          status: "waiting_feedback",
          error:
            "发送状态未知：服务在发送反馈期间重启。请检查 source session 是否已收到反馈，再决定重发或结束。",
        });
        run.status = "waiting_feedback";
      } else if (run.status === "waiting_reviewer") {
        await this.storage.workflowRuns.update(run.id, {
          error: "服务重启，可能错过 reviewer 完成事件。若 reviewer 已完成，请打开其窗口查看，或结束本次 review。",
        });
      }
      this.trackParticipants(run);
    }
  }

  private trackParticipants(run: WorkflowRun): void {
    this.participants.set(run.source_session_id, { runId: run.id, role: "source" });
    if (run.reviewer_session_id) {
      this.participants.set(run.reviewer_session_id, { runId: run.id, role: "reviewer" });
    }
  }

  private untrackRun(run: WorkflowRun): void {
    for (const [sid, p] of this.participants) {
      if (p.runId === run.id) this.participants.delete(sid);
    }
  }

  /** Sync check used by ChatSessionManager before waking the commander model. */
  shouldSuppressAgentEvent(sessionId: string): boolean {
    return this.participants.get(sessionId)?.role === "reviewer";
  }

  isSessionInActiveRun(sessionId: string): boolean {
    return this.participants.has(sessionId);
  }

  async startAdhocReview(opts: {
    project: { id: string; path: string };
    branch: string | null;
    sourceSessionId: string;
    reviewFocus?: string;
    sourceTurnEndIndex?: number;
  }): Promise<WorkflowRun> {
    if (this.participants.has(opts.sourceSessionId)) {
      throw new WorkflowError("session-busy", "该 session 已在一个进行中的 review 里");
    }
    const busy = await this.storage.workflowRuns.getActiveBySession(opts.sourceSessionId);
    if (busy) throw new WorkflowError("session-busy", "该 session 已在一个进行中的 review 里");

    const entries = this.agentOps.getMessages(opts.sourceSessionId);
    const turnEndIndex = opts.sourceTurnEndIndex ?? extractLatestTurnEndIndex(entries);
    if (turnEndIndex === null) {
      throw new WorkflowError("no-completed-turn", "source session 还没有已完成的 turn 可供 review");
    }

    const worktreePath = resolveWorktreePath(opts.project.path, opts.branch);
    const target = captureReviewTarget(worktreePath);

    const run = await this.storage.workflowRuns.create({
      id: randomUUID(),
      project_id: opts.project.id,
      branch: opts.branch,
      source_session_id: opts.sourceSessionId,
      source_turn_end_index: turnEndIndex,
      review_focus: opts.reviewFocus ?? null,
      review_target: JSON.stringify(target),
    });
    this.trackParticipants(run);

    try {
      const reviewerId = await this.agentOps.createNewSession(
        opts.project.id, opts.branch, opts.project.path, false, "edit", "claude-code", true,
      );
      const prompt = buildReviewerPrompt({
        taskContext: extractTaskContextBefore(entries, turnEndIndex),
        reviewFocus: opts.reviewFocus ?? null,
        target,
      });
      await this.agentOps.sendUserMessage(reviewerId, prompt, opts.project.path);
      const updated = await this.storage.workflowRuns.update(run.id, { reviewer_session_id: reviewerId });
      this.trackParticipants(updated!);
      this.emitRunUpdated(updated!);
      return updated!;
    } catch (err) {
      const failed = await this.storage.workflowRuns.update(run.id, {
        status: "failed",
        error: `创建 reviewer 失败：${err instanceof Error ? err.message : String(err)}`,
      });
      if (failed) this.untrackRun(failed);
      throw new WorkflowError("spawn-failed", "创建 reviewer session 失败");
    }
  }

  private async handleTaskCompleted(event: Extract<GlobalEvent, { type: "session:taskCompleted" }>): Promise<void> {
    const p = this.participants.get(event.sessionId);
    if (!p || p.role !== "reviewer") return;
    const run = await this.storage.workflowRuns.getById(p.runId);
    if (!run || run.status !== "waiting_reviewer") return;

    const entries = this.agentOps.getMessages(event.sessionId);
    const boundary = event.turnEndEntryIndex ?? extractLatestTurnEndIndex(entries) ?? entries.length;
    const feedback = extractLastAssistantBefore(entries, boundary) ?? "(reviewer 没有输出可用的反馈文本)";

    let driftNote: string | null = null;
    try {
      const target = run.review_target ? (JSON.parse(run.review_target) as ReviewTarget) : null;
      const project = await this.storage.projects.getById(run.project_id);
      if (target && project && hasDrifted(resolveWorktreePath(project.path, run.branch), target)) {
        driftNote = "注意：workspace 在 review 期间发生了变化，部分反馈可能针对的不是被审工作。";
      }
    } catch { /* drift check is best-effort */ }

    const ok = await this.storage.workflowRuns.transition(run.id, "waiting_reviewer", "waiting_feedback", {
      feedback_snapshot: feedback,
      ...(driftNote ? { error: driftNote } : {}),
    });
    if (!ok) return;
    const updated = await this.storage.workflowRuns.getById(run.id);
    if (updated) this.emitRunUpdated(updated);
  }

  async approveFeedback(runId: string, editedPayload?: string): Promise<WorkflowRun> {
    const run = await this.storage.workflowRuns.getById(runId);
    if (!run || run.status !== "waiting_feedback") {
      throw new WorkflowError("bad-state", "run 不在等待反馈确认的状态");
    }
    const claimed = await this.storage.workflowRuns.transition(runId, "waiting_feedback", "sending_feedback", {
      ...(editedPayload !== undefined ? { feedback_snapshot: editedPayload } : {}),
      error: null, // clear stale warnings (error column is nullable)
    });
    if (!claimed) throw new WorkflowError("bad-state", "run 状态已变化（可能已被处理）");

    const feedback = editedPayload ?? run.feedback_snapshot ?? "";
    const project = await this.storage.projects.getById(run.project_id);
    const ok = await this.agentOps
      .sendUserMessage(run.source_session_id, buildFeedbackMessage(feedback), project?.path)
      .catch(() => false);

    if (!ok) {
      await this.storage.workflowRuns.transition(runId, "sending_feedback", "waiting_feedback", {
        error: "发送失败：目标 session 可能未运行。请在其窗口中唤醒后重试，或结束本次 review。",
      });
      throw new WorkflowError("send-failed", "发送反馈失败");
    }
    await this.storage.workflowRuns.transition(runId, "sending_feedback", "completed");
    const done = (await this.storage.workflowRuns.getById(runId))!;
    this.untrackRun(done);
    this.emitRunUpdated(done);
    return done;
  }

  async cancelRun(runId: string, reason?: string): Promise<WorkflowRun | undefined> {
    const run = await this.storage.workflowRuns.getById(runId);
    if (!run) return undefined;
    if (["completed", "cancelled", "failed"].includes(run.status)) return run;
    const updated = await this.storage.workflowRuns.update(runId, {
      status: "cancelled",
      ...(reason ? { error: reason } : {}),
    });
    if (updated) {
      this.untrackRun(updated);
      this.emitRunUpdated(updated);
    }
    return updated;
  }

  /** Human takeover (spec §3.4): user sent a message directly to a run session. */
  async handleExternalUserMessage(sessionId: string): Promise<void> {
    const p = this.participants.get(sessionId);
    if (!p) return;
    await this.cancelRun(p.runId, "用户接管：直接向 run 内的 session 发送了消息，review 已结束。");
  }

  private emitRunUpdated(run: WorkflowRun): void {
    this.eventBus?.emit({ type: "workflow:run-updated", projectId: run.project_id, branch: run.branch, run });
  }
}
```

Note: the `transition`/`update` patch types come from `Partial<Pick<WorkflowRun, …>>`, and `WorkflowRun.error` is `string | null`, so `error: null` is valid as-is.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/workflow-engine.test.ts`
Expected: PASS (all tests).
Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/workflow-engine.ts packages/vibedeckx/src/workflow-engine.test.ts packages/vibedeckx/src/event-bus.ts
git commit -m "feat(workflow): WorkflowEngine — ad-hoc review run lifecycle"
```

---

### Task 5: Wiring — shared-services, chat suppression + entry metadata, takeover hook

**Files:**
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts`
- Modify: `packages/vibedeckx/src/server-types.ts`
- Modify: `packages/vibedeckx/src/agent-types.ts` (user variant metadata)
- Modify: `packages/vibedeckx/src/chat-session-manager.ts`
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts` (~:777 `/message` route)

**Interfaces:**
- Consumes: Task 4 `WorkflowEngine`.
- Produces: `fastify.workflowEngine: WorkflowEngine`; `AgentMessage` user variant gains `event?: { kind: "agent_task_completed"; sessionId: string; turnEndEntryIndex: number }`; chat WS frame `{ WorkflowRunUpdated: WorkflowRun }`.

- [ ] **Step 1: Extend the user entry type**

In `agent-types.ts`, change the user variant of `AgentMessage`:

```ts
| { type: 'user'; content: string | ContentPart[]; timestamp: number; event?: { kind: "agent_task_completed"; sessionId: string; turnEndEntryIndex: number } }
```

- [ ] **Step 2: Instantiate + decorate the engine in `shared-services.ts`**

After `agentSessionManager` is constructed and **before** `chatSessionManager.setEventBus(eventBus)` (order matters — see step 3 comment):

```ts
import { WorkflowEngine } from "../workflow-engine.js";
// ...
const workflowEngine = new WorkflowEngine(opts.storage, agentSessionManager);
workflowEngine.setEventBus(eventBus);   // subscribe BEFORE chatSessionManager so ordering is explicit
await workflowEngine.init();
fastify.decorate("workflowEngine", workflowEngine);
chatSessionManager.setWorkflowEngine(workflowEngine);
```

(Keep the existing `agentSessionManager.setEventBus(eventBus)` / `chatSessionManager.setEventBus(eventBus)` lines where they are; just insert the engine block between them.)

In `server-types.ts` add to the `FastifyInstance` declaration:

```ts
workflowEngine: import("./workflow-engine.js").WorkflowEngine;
```

- [ ] **Step 3: ChatSessionManager — suppression, metadata, rebroadcast**

In `chat-session-manager.ts`:

(a) Add field + setter near `setEventBus` (~:285):

```ts
private workflowEngine: { shouldSuppressAgentEvent(sessionId: string): boolean } | null = null;

setWorkflowEngine(engine: { shouldSuppressAgentEvent(sessionId: string): boolean }): void {
  this.workflowEngine = engine;
}
```

(b) In `handleSessionTaskCompleted` (~:343), insert **at the very top** (before the sessionIndex lookup):

```ts
// Reviewer sessions belong to the workflow engine: it snapshots the feedback
// and drives the gate. Waking the commander model too would double-handle
// the same event (and let the model respond/dispatch on its own).
if (this.workflowEngine?.shouldSuppressAgentEvent(event.sessionId)) return;
```

(c) Thread event metadata to the chat entry. `handleSessionTaskCompleted` currently ends with `this.enqueueOrSend(sessionId, message, !isChatInitiated);`. Change to:

```ts
const eventMeta = event.turnEndEntryIndex !== undefined
  ? { kind: "agent_task_completed" as const, sessionId: event.sessionId, turnEndEntryIndex: event.turnEndEntryIndex }
  : undefined;
this.enqueueOrSend(sessionId, message, !isChatInitiated, eventMeta);
```

Extend the plumbing signatures:
- `enqueueOrSend(sessionId: string, content: string, eventDriven?: boolean, eventMeta?: { kind: "agent_task_completed"; sessionId: string; turnEndEntryIndex: number }): void` — queue items become `{ content, eventDriven, eventMeta }`; pass through to `sendMessage`.
- `sendMessage(sessionId, content, eventDriven?, eventMeta?)` — where it pushes the user `AgentMessage`, include `...(eventMeta ? { event: eventMeta } : {})` in the entry object.
- Update the queue-drain call site(s) that construct/consume `messageQueue` items to carry `eventMeta`.

(d) Rebroadcast run updates over the chat WS. In `setupEventListeners` (~:329) add a branch:

```ts
} else if (event.type === "workflow:run-updated") {
  this.handleWorkflowRunUpdated(event);
}
```

and add the handler (near `handleSessionTaskCompleted`):

```ts
private handleWorkflowRunUpdated(event: Extract<GlobalEvent, { type: "workflow:run-updated" }>): void {
  const key = `${event.projectId}:${event.branch ?? ""}`;
  const sessionId = this.sessionIndex.get(key);
  if (!sessionId) return;
  const session = this.sessions.get(sessionId);
  if (!session) return;
  const frame = JSON.stringify({ WorkflowRunUpdated: event.run });
  for (const ws of session.subscribers) {
    if (ws.readyState === 1) ws.send(frame);
  }
}
```

- [ ] **Step 4: Human-takeover hook in the `/message` route**

In `routes/agent-session-routes.ts`, in the **local** branch of `POST /api/agent-sessions/:sessionId/message` (immediately before the `fastify.agentSessionManager.sendUserMessage(...)` call at ~:862):

```ts
// Human takeover (workflow spec §3.4): a user message into a session that
// belongs to an active review run ends that run. The engine's own feedback
// relay calls sendUserMessage directly on the manager, not this route, so
// it never self-triggers.
await fastify.workflowEngine.handleExternalUserMessage(req.params.sessionId);
```

- [ ] **Step 5: Typecheck + full test suite**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` → clean.
Run: `pnpm --filter vibedeckx test` → all pass. Note: existing route tests that build a fake app and register `agent-session-routes` will now need `app.decorate("workflowEngine", { handleExternalUserMessage: async () => {} })` — add that to their `makeApp()` helpers if they fail.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src
git commit -m "feat(workflow): wire engine — event claim suppression, entry metadata, takeover hook"
```

---

### Task 6: Workflow-run routes

**Files:**
- Create: `packages/vibedeckx/src/routes/workflow-run-routes.ts`
- Modify: `packages/vibedeckx/src/server.ts` (import + register)
- Test: `packages/vibedeckx/src/routes/workflow-run-routes.test.ts`

**Interfaces:**
- Consumes: Task 4 engine methods, Task 2 repo.
- Produces (consumed by frontend Task 7):
  - `POST /api/workflow-runs` body `{ projectId, branch?, sourceSessionId, reviewFocus?, sourceTurnEndIndex? }` → 201 `{ run }` | 400 | 404 | 409
  - `GET /api/workflow-runs?projectId=&branch=` → `{ runs }` (active only)
  - `GET /api/workflow-runs/:id` → `{ run }`
  - `POST /api/workflow-runs/:id/gate` body `{ action: "approve" | "cancel", editedPayload? }` → `{ run }` | 409 on state conflict
  - `POST /api/workflow-runs/:id/cancel` → `{ run }`

- [ ] **Step 1: Write the failing tests**

`packages/vibedeckx/src/routes/workflow-run-routes.test.ts` (follow the `agent-session-branch-routes.test.ts` fake-app pattern):

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import workflowRunRoutes from "./workflow-run-routes.js";
import { WorkflowError } from "../workflow-engine.js";

const project = { id: "p1", name: "p", path: "/tmp/p" };
const run = { id: "r1", project_id: "p1", branch: "dev", status: "waiting_feedback" };

let app: FastifyInstance;

function makeApp(overrides: { engine?: Record<string, unknown>; runs?: Record<string, unknown> } = {}) {
  app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    projects: { getById: async (id: string) => (id === "p1" ? project : undefined) },
    workflowRuns: {
      getActive: async () => [run],
      getById: async (id: string) => (id === "r1" ? run : undefined),
      ...(overrides.runs ?? {}),
    },
  } as never);
  app.decorate("workflowEngine", {
    startAdhocReview: vi.fn(async () => run),
    approveFeedback: vi.fn(async () => ({ ...run, status: "completed" })),
    cancelRun: vi.fn(async () => ({ ...run, status: "cancelled" })),
    ...(overrides.engine ?? {}),
  } as never);
  return app;
}

afterEach(async () => { if (app) await app.close(); });

describe("workflow-run-routes", () => {
  it("POST creates an ad-hoc run", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", branch: "dev", sourceSessionId: "s-src", reviewFocus: "tests" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().run.id).toBe("r1");
  });

  it("POST rejects remote sessions and unknown projects", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const remote = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "p1", sourceSessionId: "remote-x" } });
    expect(remote.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "nope", sourceSessionId: "s" } });
    expect(missing.statusCode).toBe(404);
  });

  it("POST maps WorkflowError codes to HTTP", async () => {
    const app = makeApp({
      engine: { startAdhocReview: vi.fn(async () => { throw new WorkflowError("session-busy", "busy"); }) },
    });
    await app.register(workflowRunRoutes);
    const res = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "p1", sourceSessionId: "s" } });
    expect(res.statusCode).toBe(409);
  });

  it("GET lists active runs for a workspace", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const res = await app.inject({ method: "GET", url: "/api/workflow-runs?projectId=p1&branch=dev" });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toHaveLength(1);
  });

  it("gate approve calls engine and returns the run", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs/r1/gate",
      payload: { action: "approve", editedPayload: "edited" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.status).toBe("completed");
  });

  it("gate maps bad-state to 409", async () => {
    const app = makeApp({
      engine: { approveFeedback: vi.fn(async () => { throw new WorkflowError("bad-state", "no"); }) },
    });
    await app.register(workflowRunRoutes);
    const res = await app.inject({ method: "POST", url: "/api/workflow-runs/r1/gate", payload: { action: "approve" } });
    expect(res.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vibedeckx && npx vitest run src/routes/workflow-run-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes**

`packages/vibedeckx/src/routes/workflow-run-routes.ts` (mirror `command-routes.ts` structure/auth):

```ts
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import { WorkflowError } from "../workflow-engine.js";

function errStatus(err: unknown): number | null {
  if (!(err instanceof WorkflowError)) return null;
  switch (err.code) {
    case "session-busy": return 409;
    case "bad-state": return 409;
    case "no-completed-turn": return 400;
    case "send-failed": return 502;
    case "spawn-failed": return 500;
    default: return 500;
  }
}

async function routes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { projectId: string; branch?: string | null; sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number };
  }>("/api/workflow-runs", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { projectId, branch, sourceSessionId, reviewFocus, sourceTurnEndIndex } = req.body ?? {};
    if (!projectId || !sourceSessionId) return reply.code(400).send({ error: "projectId and sourceSessionId are required" });
    if (sourceSessionId.startsWith("remote-")) return reply.code(400).send({ error: "Remote sessions are not supported in ad-hoc review yet" });
    const project = await fastify.storage.projects.getById(projectId, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    try {
      const run = await fastify.workflowEngine.startAdhocReview({
        project: { id: project.id, path: project.path },
        branch: branch ?? null,
        sourceSessionId,
        reviewFocus,
        sourceTurnEndIndex,
      });
      return reply.code(201).send({ run });
    } catch (err) {
      const status = errStatus(err);
      if (status) return reply.code(status).send({ error: (err as Error).message });
      throw err;
    }
  });

  fastify.get<{ Querystring: { projectId: string; branch?: string } }>(
    "/api/workflow-runs", async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const { projectId, branch } = req.query;
      if (!projectId) return reply.code(400).send({ error: "projectId is required" });
      const project = await fastify.storage.projects.getById(projectId, userId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const runs = await fastify.storage.workflowRuns.getActive(projectId, branch ?? null);
      return reply.send({ runs });
    });

  fastify.get<{ Params: { id: string } }>("/api/workflow-runs/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const run = await fastify.storage.workflowRuns.getById(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const project = await fastify.storage.projects.getById(run.project_id, userId);
    if (!project) return reply.code(404).send({ error: "Run not found" });
    return reply.send({ run });
  });

  fastify.post<{ Params: { id: string }; Body: { action: "approve" | "cancel"; editedPayload?: string } }>(
    "/api/workflow-runs/:id/gate", async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = await fastify.storage.workflowRuns.getById(req.params.id);
      if (!existing) return reply.code(404).send({ error: "Run not found" });
      const project = await fastify.storage.projects.getById(existing.project_id, userId);
      if (!project) return reply.code(404).send({ error: "Run not found" });
      const { action, editedPayload } = req.body ?? {};
      try {
        if (action === "approve") {
          const run = await fastify.workflowEngine.approveFeedback(req.params.id, editedPayload);
          return reply.send({ run });
        }
        if (action === "cancel") {
          const run = await fastify.workflowEngine.cancelRun(req.params.id);
          return reply.send({ run });
        }
        return reply.code(400).send({ error: "action must be approve or cancel" });
      } catch (err) {
        const status = errStatus(err);
        if (status) return reply.code(status).send({ error: (err as Error).message });
        throw err;
      }
    });

  fastify.post<{ Params: { id: string } }>("/api/workflow-runs/:id/cancel", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = await fastify.storage.workflowRuns.getById(req.params.id);
    if (!existing) return reply.code(404).send({ error: "Run not found" });
    const project = await fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) return reply.code(404).send({ error: "Run not found" });
    const run = await fastify.workflowEngine.cancelRun(req.params.id);
    return reply.send({ run });
  });
}

export default fp(routes, { name: "workflow-run-routes" });
```

Register in `server.ts`: `import workflowRunRoutes from "./routes/workflow-run-routes.js";` and `server.register(workflowRunRoutes);` next to `server.register(commandRoutes);` (~:338).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/routes/workflow-run-routes.test.ts`
Expected: PASS (6 tests). Then `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/workflow-run-routes.ts packages/vibedeckx/src/routes/workflow-run-routes.test.ts packages/vibedeckx/src/server.ts
git commit -m "feat(workflow): workflow-run REST routes"
```

---

### Task 7: Frontend — API client + WS/types plumbing

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts`
- Modify: `apps/vibedeckx-ui/hooks/use-chat-session.ts`

**Interfaces:**
- Produces (consumed by Tasks 8-9):
  - `interface WorkflowRun` (mirror of backend type, in `lib/api.ts`)
  - `api.createWorkflowRun(opts: { projectId: string; branch: string | null; sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number }): Promise<WorkflowRun>`
  - `api.getActiveWorkflowRuns(projectId: string, branch: string | null): Promise<WorkflowRun[]>`
  - `api.workflowRunGate(runId: string, action: "approve" | "cancel", editedPayload?: string): Promise<WorkflowRun>`
  - `api.cancelWorkflowRun(runId: string): Promise<WorkflowRun>`
  - `useChatSession` additionally returns `workflowRunUpdate: WorkflowRun | null` (last WS-pushed run), and its local `AgentMessage` user variant gains `event?: { kind: string; sessionId: string; turnEndEntryIndex: number }`.

- [ ] **Step 1: Add types + methods to `lib/api.ts`**

Add the interface near the other shared interfaces:

```ts
export interface WorkflowRun {
  id: string;
  project_id: string;
  branch: string | null;
  source_session_id: string;
  source_turn_end_index: number;
  reviewer_session_id: string | null;
  review_focus: string | null;
  review_target: string | null;
  feedback_snapshot: string | null;
  status: "waiting_reviewer" | "waiting_feedback" | "sending_feedback" | "completed" | "cancelled" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
}
```

Add to the `api` object (follow the `createProject` / `getProjects` patterns):

```ts
async createWorkflowRun(opts: {
  projectId: string; branch: string | null; sourceSessionId: string;
  reviewFocus?: string; sourceTurnEndIndex?: number;
}): Promise<WorkflowRun> {
  const res = await authFetch(`${getApiBase()}/api/workflow-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to start review: ${res.status}`);
  }
  return (await res.json()).run;
},

async getActiveWorkflowRuns(projectId: string, branch: string | null): Promise<WorkflowRun[]> {
  const params = new URLSearchParams({ projectId });
  if (branch) params.set("branch", branch);
  const res = await authFetch(`${getApiBase()}/api/workflow-runs?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch workflow runs: ${res.status}`);
  return (await res.json()).runs;
},

async workflowRunGate(runId: string, action: "approve" | "cancel", editedPayload?: string): Promise<WorkflowRun> {
  const res = await authFetch(`${getApiBase()}/api/workflow-runs/${runId}/gate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, editedPayload }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Gate action failed: ${res.status}`);
  }
  return (await res.json()).run;
},

async cancelWorkflowRun(runId: string): Promise<WorkflowRun> {
  const res = await authFetch(`${getApiBase()}/api/workflow-runs/${runId}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to cancel run: ${res.status}`);
  return (await res.json()).run;
},
```

- [ ] **Step 2: Extend `use-chat-session.ts`**

(a) The local `AgentMessage` user variant (~:11-19): add `event?: { kind: string; sessionId: string; turnEndEntryIndex: number }`.

(b) The `AgentWsMessage` union (~:57-63): add `| { WorkflowRunUpdated: import("@/lib/api").WorkflowRun }`.

(c) Add state + frame handling in `ws.onmessage` (~:253):

```ts
const [workflowRunUpdate, setWorkflowRunUpdate] = useState<WorkflowRun | null>(null);
// in onmessage, after the JsonPatch/Ready branches:
} else if ("WorkflowRunUpdated" in msg) {
  setWorkflowRunUpdate(msg.WorkflowRunUpdated);
}
```

(d) Return `workflowRunUpdate` from the hook.

- [ ] **Step 3: Typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/hooks/use-chat-session.ts
git commit -m "feat(ui): workflow-run API client + WS plumbing"
```

---

### Task 8: Frontend — pinned panel + event-card Review button (Main Chat)

**Files:**
- Create: `apps/vibedeckx-ui/components/conversation/review-run-panel.tsx`
- Modify: `apps/vibedeckx-ui/components/conversation/main-conversation.tsx`

**Interfaces:**
- Consumes: Task 7 API + `workflowRunUpdate` from `useChatSession`.
- Produces: `<ReviewRunPanel projectId branch runUpdate onRunsChange />` mounted under the Main Chat header; Review button on user entries carrying `event.kind === "agent_task_completed"`.

- [ ] **Step 1: Implement `ReviewRunPanel`**

`apps/vibedeckx-ui/components/conversation/review-run-panel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type WorkflowRun } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, X } from "lucide-react";

const ACTIVE = new Set(["waiting_reviewer", "waiting_feedback", "sending_feedback"]);

export function ReviewRunPanel({
  projectId,
  branch,
  runUpdate,
  onRunsChange,
}: {
  projectId: string | null;
  branch: string | null;
  runUpdate: WorkflowRun | null;
  onRunsChange?: (runs: WorkflowRun[]) => void;
}) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const active = await api.getActiveWorkflowRuns(projectId, branch);
      setRuns(active);
      onRunsChange?.(active);
    } catch {
      /* transient */
    }
  }, [projectId, branch, onRunsChange]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (runUpdate) void refresh(); }, [runUpdate, refresh]);
  // Polling fallback while a run is active (WS push is best-effort).
  useEffect(() => {
    if (runs.length === 0) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [runs.length, refresh]);

  const act = async (fn: () => Promise<unknown>, runId: string) => {
    setBusy(runId);
    setActionError(null);
    try { await fn(); } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); await refresh(); }
  };

  const activeRuns = runs.filter((r) => ACTIVE.has(r.status));
  if (activeRuns.length === 0) return null;

  return (
    <div className="border-b bg-muted/30 px-4 py-2 space-y-2">
      {activeRuns.map((run) => (
        <div key={run.id} className="text-sm space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium">
              Review{run.review_focus ? ` — ${run.review_focus}` : ""}
              <span className="ml-2 text-muted-foreground">
                {run.status === "waiting_reviewer" && "reviewer 审查中…"}
                {run.status === "waiting_feedback" && "等你确认反馈"}
                {run.status === "sending_feedback" && "发送中…"}
              </span>
            </span>
            <Button variant="ghost" size="sm" disabled={busy === run.id}
              onClick={() => act(() => api.cancelWorkflowRun(run.id), run.id)}>
              <X className="h-3 w-3 mr-1" />结束
            </Button>
          </div>
          {run.error && <div className="text-xs text-amber-600">{run.error}</div>}
          {run.status === "waiting_reviewer" && (
            <div className="flex items-center text-muted-foreground text-xs">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> reviewer session 正在工作
            </div>
          )}
          {run.status === "waiting_feedback" && (
            <>
              <Textarea
                className="text-xs font-mono min-h-28"
                value={draft[run.id] ?? run.feedback_snapshot ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [run.id]: e.target.value }))}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={busy === run.id}
                  onClick={() => act(() => api.workflowRunGate(run.id, "approve", draft[run.id] ?? undefined), run.id)}>
                  发送反馈给原 session
                </Button>
              </div>
            </>
          )}
          {actionError && <div className="text-xs text-destructive">{actionError}</div>}
        </div>
      ))}
    </div>
  );
}
```

(If `components/ui/textarea` does not exist, use the shadcn Textarea already present in the repo — check `components/ui/`; `command-dialog.tsx` uses form inputs and shows which primitives exist. Fall back to a styled `<textarea>` if needed.)

- [ ] **Step 2: Mount in `main-conversation.tsx`**

- Import `ReviewRunPanel` and `type WorkflowRun` + `api`.
- Get `workflowRunUpdate` from the `useChatSession(...)` destructuring (~:87-97).
- Add state `const [activeRuns, setActiveRuns] = useState<WorkflowRun[]>([]);`
- Mount directly below the header bar (after the `div` at ~:150 closes, before `<Conversation>` ~:192):

```tsx
<ReviewRunPanel
  projectId={projectId}
  branch={branch}
  runUpdate={workflowRunUpdate}
  onRunsChange={setActiveRuns}
/>
```

- [ ] **Step 3: Review button on agent-completion event entries**

In the `messages.map(...)` user-message branch (~:254-262): when the entry has `msg.event?.kind === "agent_task_completed"`, render the bubble plus a compact action row:

```tsx
{msg.event?.kind === "agent_task_completed" && (
  <div className="mt-1 flex justify-end">
    <Button
      variant="outline"
      size="sm"
      disabled={activeRuns.some(
        (r) => r.source_session_id === msg.event!.sessionId || r.reviewer_session_id === msg.event!.sessionId,
      )}
      title={activeRuns.length > 0 ? "该 session 已在一个进行中的 review 里" : undefined}
      onClick={async () => {
        if (!projectId) return;
        try {
          await api.createWorkflowRun({
            projectId,
            branch,
            sourceSessionId: msg.event!.sessionId,
            sourceTurnEndIndex: msg.event!.turnEndEntryIndex,
          });
        } catch (e) {
          alert(e instanceof Error ? e.message : String(e));
        }
      }}
    >
      Review
    </Button>
  </div>
)}
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit` → clean.
Run: `pnpm --filter vibedeckx-ui lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/conversation
git commit -m "feat(ui): review pinned panel + event-card Review button in Main Chat"
```

---

### Task 9: Frontend — stable Review entry in the agent session header

**Files:**
- Create: `apps/vibedeckx-ui/components/agent/review-dialog.tsx`
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` (right header cluster ~:717)

**Interfaces:**
- Consumes: Task 7 `api.createWorkflowRun`.
- Produces: `<ReviewDialog projectId branch sessionId />` — a header button + dialog with optional "Review focus" input.

- [ ] **Step 1: Implement `ReviewDialog`**

`apps/vibedeckx-ui/components/agent/review-dialog.tsx` (use the same Dialog primitives as `components/commands/command-dialog.tsx` — copy its imports):

```tsx
"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { SearchCheck } from "lucide-react";

export function ReviewDialog({
  projectId,
  branch,
  sessionId,
}: {
  projectId: string;
  branch: string | null;
  sessionId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sessionId || sessionId.startsWith("remote-")) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createWorkflowRun({
        projectId,
        branch,
        sourceSessionId: sessionId,
        reviewFocus: focus.trim() || undefined,
      });
      setOpen(false);
      setFocus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="让另一个 agent review 这个 session 的最新成果">
          <SearchCheck className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>发起 Review</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          将创建一个 reviewer session 审查本 session 最近完成的工作。反馈会先经你确认，再发回本 session。
        </p>
        <input
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="Review focus（可选）：本次审查重点…"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button onClick={start} disabled={busy}>开始 Review</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Wire into the agent session header**

In `agent-conversation.tsx`, add `import { ReviewDialog } from "./review-dialog";` and render inside the right cluster `<div className="flex items-center gap-1">` (~:717), before `<SessionHistoryDropdown …>`:

```tsx
<ReviewDialog projectId={projectId} branch={branch} sessionId={currentSessionId} />
```

Use the component's existing in-scope variables for the current project id, branch, and active session id (the same values passed to `SessionHistoryDropdown` / used by the session-creation calls in this file — match the local names, e.g. `projectId` / `branch` / the state holding the active session's id).

- [ ] **Step 3: Typecheck + lint**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit` → clean.
Run: `pnpm --filter vibedeckx-ui lint` → clean.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/components/agent
git commit -m "feat(ui): stable Review entry in agent session header"
```

---

### Task 10: Final verification + spec status update

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-workflow-engine-review-loop-design.md` (status line only)

- [ ] **Step 1: Full backend check**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` → clean.
Run: `pnpm --filter vibedeckx test` → all tests pass.

- [ ] **Step 2: Full frontend check**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit` → clean.
Run: `pnpm --filter vibedeckx-ui lint` → clean.

- [ ] **Step 3: Manual smoke of the closed loop (dev servers)**

Run `pnpm dev:all`. In a workspace with an agent session that has completed a turn:
1. Click the Review button in the agent session header → pinned panel appears in Main Chat with "reviewer 审查中…"; a reviewer session appears in the sidebar.
2. Wait for the reviewer to finish → panel shows the editable feedback; **no** commander model reply about the reviewer's completion should appear in Main Chat.
3. Edit the text, click 发送反馈给原 session → source session receives the `[Review Feedback]` message and starts a turn; panel disappears.
4. Start another review, then type a message directly into the reviewer session → the run ends (panel disappears).

- [ ] **Step 4: Update spec status + commit**

Change the spec's status line to: `> 状态：**Phase 1 已实现**（实现计划 docs/superpowers/plans/2026-07-17-adhoc-review-phase1.md）。`

```bash
git add docs/superpowers/specs/2026-07-17-workflow-engine-review-loop-design.md
git commit -m "docs: mark workflow spec Phase 1 implemented"
```
