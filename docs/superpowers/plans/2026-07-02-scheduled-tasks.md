# Scheduled Tasks (cron-triggered executor runs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-project scheduled tasks ("定时任务") that run a shell command or a headless Claude prompt on a cron schedule (or on demand via Run Now), in a branch worktree or a fixed directory, persisting a run history with captured output — surfaced as a SCHEDULE sidebar section with a detail view.

**Architecture:** A new `SchedulerService` (croner-based) lives in shared-services alongside `ProcessManager`. On fire it fabricates an in-memory `Executor` object (never persisted) and calls `processManager.start(executor, cwd, /*skipDb*/ true)` — the exact mechanism the existing `POST /api/path/execute` route uses — then captures output via `processManager.subscribe()` and persists a run row in a new `scheduled_task_runs` table (ProcessManager's own log buffer is in-memory only, evicted 30 min after exit). Two new SQLite tables (`scheduled_tasks`, `scheduled_task_runs`), REST routes following the executor/command auth pattern, `schedule:run-started/finished` events on the existing EventBus/SSE, and a frontend that clones the Workspace sidebar section + TasksView patterns.

**Tech Stack:** TypeScript (ESM NodeNext backend — `.js` import extensions), Fastify, better-sqlite3, `croner` (new dep), Next.js 16 / React 19, vitest 4.

## Global Constraints

- Backend is ESM with NodeNext resolution — **all local imports use `.js` extensions**.
- Backend type-check: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Frontend type-check: `cd apps/vibedeckx-ui && npx tsc --noEmit`.
- vitest 4 is configured in `packages/vibedeckx` (`*.test.ts` convention, no config file — defaults). Run a file with: `cd packages/vibedeckx && npx vitest run <file>`.
- Run records must be **persisted by the scheduler itself** — ProcessManager log buffers are in-memory and deleted 30 minutes after process exit (`LOG_RETENTION_MS`, `process-manager.ts:44`).
- Fabricated executors MUST be started with `skipDb = true` — `executor_processes` rows are FK-bound to real `executors` rows and would violate the constraint.
- Prompt-type runs use the existing claude prompt-executor path (`startClaudeStreamProcess`), which hardcodes `--dangerously-skip-permissions`. This matches existing prompt executors and the agreed product decision (user is responsible; unattended runs can't answer approval prompts). Do not add a permission-mode field.
- V1 is **local-execution only**. Branch-mode schedules on a project without a local `path` fail at run time with a recorded `failed` run ("Project has no local path"); directory-mode schedules work regardless.
- Overlap policy: **skip** — if the previous run is still active, record a `skipped` run row and do not spawn.
- Persisted output is capped at the **last 200,000 characters**; run history keeps the **newest 50 rows** per schedule (pruned on every insert).
- Default `timeout_seconds` = 1800 (30 min); on timeout the process group is killed and the run is marked `timeout`.
- Timezone is stored per schedule (IANA name, e.g. `Asia/Shanghai`); cron expressions are croner 5/6-field syntax.
- Wire/API field names use snake_case (`cron_expr`, `run_type`, `cwd_mode`, `timeout_seconds`, `last_run`, `next_run_at`) matching existing entities.

## File Structure

Backend (`packages/vibedeckx/src/`):
- Modify `storage/types.ts` — `ScheduledTask`/`ScheduledTaskRun` entities + `Storage` interface slices.
- Modify `storage/sqlite.ts` — two `CREATE TABLE`s, startup fixup, row mappers, CRUD.
- Create `storage/scheduled-tasks.test.ts` — storage tests.
- Modify `event-bus.ts` — `schedule:run-started` / `schedule:run-finished` union members.
- Create `scheduler.ts` — `validateCron()` + `SchedulerService` (cron jobs, run execution, output capture, timeout, overlap skip).
- Create `scheduler.test.ts` — validateCron + runNow lifecycle tests (fake ProcessManager, real sqlite storage).
- Create `routes/schedule-routes.ts` — REST API.
- Modify `plugins/shared-services.ts`, `server-types.ts`, `server.ts` — wiring.

Frontend (`apps/vibedeckx-ui/`):
- Modify `lib/api.ts` — `Schedule`/`ScheduleRun`/`ScheduleInput` interfaces + 7 api methods.
- Create `hooks/use-schedules.ts` — fetch/CRUD/SSE-refresh hook.
- Create `components/schedule/schedule-form-dialog.tsx` — create/edit dialog.
- Create `components/schedule/schedules-view.tsx` — detail view + run history + output dialog.
- Create `components/schedule/index.ts` — barrel.
- Modify `components/layout/app-sidebar.tsx` — `ActiveView` + SCHEDULE section + `ScheduleDot`.
- Modify `app/page.tsx` — hook, state, sidebar props, view render.

---

### Task 1: Storage layer — `scheduled_tasks` + `scheduled_task_runs`

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts` (entity types near `ExecutorProcess` ~line 89; interface slices after `executorProcesses` ~line 280)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (tables at end of `createDatabase` ~line 649; mappers near `mapExecutorRow` ~line 720; CRUD in the returned object after the `executorProcesses` block ~line 1399)
- Test: `packages/vibedeckx/src/storage/scheduled-tasks.test.ts`

**Interfaces:**
- Produces: `storage.scheduledTasks.{create,getByProjectId,getById,getAllEnabled,update,delete}` and `storage.scheduledTaskRuns.{create,getById,getByScheduleId,getLastByScheduleIds,finish,prune}` with the exact signatures below. Later tasks (scheduler, routes) consume these verbatim.
- Produces: types `ScheduledTask`, `ScheduledTaskRun`, `ScheduledTaskRunType` (`'command' | 'prompt'`), `ScheduledTaskCwdMode` (`'branch' | 'directory'`), `ScheduledTaskRunStatus` (`'running' | 'completed' | 'failed' | 'timeout' | 'killed' | 'skipped'`).

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/storage/scheduled-tasks.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("scheduledTasks storage", () => {
  let dir: string;
  let storage: Storage;
  const projectId = "proj-1";

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-sched-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    storage.projects.create({ id: projectId, name: "p", path: "/tmp/p" });
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const createTask = (id = "s1") =>
    storage.scheduledTasks.create({
      id,
      project_id: projectId,
      name: "daily scan",
      cron_expr: "0 9 * * *",
      timezone: "Asia/Shanghai",
      run_type: "command",
      content: "echo hi",
      cwd_mode: "branch",
    });

  it("creates and reads back a scheduled task with defaults", () => {
    const t = createTask();
    expect(t.enabled).toBe(true);
    expect(t.timeout_seconds).toBe(1800);
    expect(t.branch).toBeNull();
    expect(t.directory).toBeNull();
    expect(t.run_type).toBe("command");
    expect(storage.scheduledTasks.getByProjectId(projectId)).toHaveLength(1);
    expect(storage.scheduledTasks.getAllEnabled().map((x) => x.id)).toContain("s1");
    expect(storage.scheduledTasks.getById("s1")?.name).toBe("daily scan");
  });

  it("update changes fields and getAllEnabled respects enabled=false", () => {
    createTask();
    const updated = storage.scheduledTasks.update("s1", {
      enabled: false,
      name: "n2",
      cwd_mode: "directory",
      directory: "/tmp",
      timeout_seconds: 60,
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe("n2");
    expect(updated?.cwd_mode).toBe("directory");
    expect(updated?.directory).toBe("/tmp");
    expect(updated?.timeout_seconds).toBe(60);
    expect(storage.scheduledTasks.getAllEnabled()).toHaveLength(0);
  });

  it("delete removes the schedule", () => {
    createTask();
    storage.scheduledTasks.delete("s1");
    expect(storage.scheduledTasks.getById("s1")).toBeUndefined();
  });

  it("runs: create → finish; list omits output, getById includes it", () => {
    createTask();
    const run = storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1", process_id: "p1" });
    expect(run.status).toBe("running");
    expect(run.finished_at).toBeNull();

    storage.scheduledTaskRuns.finish("r1", { status: "completed", exit_code: 0, output: "hello" });

    const listed = storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("completed");
    expect(listed[0].exit_code).toBe(0);
    expect(listed[0].finished_at).not.toBeNull();
    expect(listed[0].output).toBeNull(); // list never ships output

    expect(storage.scheduledTaskRuns.getById("r1")?.output).toBe("hello");
  });

  it("runs created with a non-running status get finished_at immediately (skipped)", () => {
    createTask();
    const run = storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1", status: "skipped" });
    expect(run.status).toBe("skipped");
    expect(run.finished_at).not.toBeNull();
  });

  it("getLastByScheduleIds returns the newest run per schedule", () => {
    createTask("s1");
    createTask("s2");
    storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1" });
    storage.scheduledTaskRuns.create({ id: "r2", schedule_id: "s1" }); // newer (rowid tiebreak)
    const last = storage.scheduledTaskRuns.getLastByScheduleIds(["s1", "s2"]);
    expect(last["s1"]?.id).toBe("r2");
    expect(last["s2"]).toBeUndefined();
  });

  it("prune keeps only the newest N runs", () => {
    createTask();
    for (let i = 0; i < 5; i++) {
      storage.scheduledTaskRuns.create({ id: `r${i}`, schedule_id: "s1" });
    }
    storage.scheduledTaskRuns.prune("s1", 2);
    const remaining = storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(remaining.map((r) => r.id)).toEqual(["r4", "r3"]);
  });

  it("deleting a schedule cascades to its runs", () => {
    createTask();
    storage.scheduledTaskRuns.create({ id: "r1", schedule_id: "s1" });
    storage.scheduledTasks.delete("s1");
    expect(storage.scheduledTaskRuns.getById("r1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/storage/scheduled-tasks.test.ts`
Expected: FAIL — TypeScript/property errors (`scheduledTasks` does not exist on `Storage`).

- [ ] **Step 3: Add the entity types and `Storage` interface slices**

In `packages/vibedeckx/src/storage/types.ts`, directly after the `ExecutorProcess` interface (ends ~line 97), add:

```ts
export type ScheduledTaskRunType = 'command' | 'prompt';
export type ScheduledTaskCwdMode = 'branch' | 'directory';
export type ScheduledTaskRunStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'killed' | 'skipped';

export interface ScheduledTask {
  id: string;
  project_id: string;
  name: string;
  cron_expr: string;
  /** IANA timezone name the cron expression is evaluated in, e.g. "Asia/Shanghai". */
  timezone: string;
  enabled: boolean;
  run_type: ScheduledTaskRunType;
  /** Shell command (run_type=command) or prompt text (run_type=prompt). */
  content: string;
  cwd_mode: ScheduledTaskCwdMode;
  /** cwd_mode=branch: worktree branch to run in; null = main worktree. */
  branch: string | null;
  /** cwd_mode=directory: absolute path to run in. */
  directory: string | null;
  timeout_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRun {
  id: string;
  schedule_id: string;
  status: ScheduledTaskRunStatus;
  exit_code: number | null;
  /** Captured output (ANSI included), capped. Omitted (null) by list queries. */
  output: string | null;
  process_id: string | null;
  started_at: string;
  finished_at: string | null;
}
```

Then, inside the `Storage` interface, directly after the `executorProcesses` slice (ends ~line 280, before `remoteExecutorProcesses`), add:

```ts
  scheduledTasks: {
    create: (opts: { id: string; project_id: string; name: string; cron_expr: string; timezone: string; run_type: ScheduledTaskRunType; content: string; cwd_mode: ScheduledTaskCwdMode; branch?: string | null; directory?: string | null; timeout_seconds?: number; enabled?: boolean }) => ScheduledTask;
    getByProjectId: (projectId: string) => ScheduledTask[];
    getById: (id: string) => ScheduledTask | undefined;
    getAllEnabled: () => ScheduledTask[];
    update: (id: string, opts: { name?: string; cron_expr?: string; timezone?: string; enabled?: boolean; run_type?: ScheduledTaskRunType; content?: string; cwd_mode?: ScheduledTaskCwdMode; branch?: string | null; directory?: string | null; timeout_seconds?: number }) => ScheduledTask | undefined;
    delete: (id: string) => void;
  };
  scheduledTaskRuns: {
    create: (opts: { id: string; schedule_id: string; status?: ScheduledTaskRunStatus; process_id?: string | null }) => ScheduledTaskRun;
    getById: (id: string) => ScheduledTaskRun | undefined;
    /** Newest first. Never includes the output column (always null) — use getById for output. */
    getByScheduleId: (scheduleId: string, limit?: number) => ScheduledTaskRun[];
    /** Most recent run per schedule for the given IDs (output omitted). */
    getLastByScheduleIds: (scheduleIds: string[]) => Record<string, ScheduledTaskRun>;
    finish: (id: string, opts: { status: ScheduledTaskRunStatus; exit_code?: number | null; output?: string | null }) => void;
    /** Delete all but the newest `keep` runs for a schedule. */
    prune: (scheduleId: string, keep: number) => void;
  };
```

- [ ] **Step 4: Create the tables + startup fixup in `createDatabase`**

In `packages/vibedeckx/src/storage/sqlite.ts`, at the end of `createDatabase`, immediately **before** the `db.pragma("foreign_keys = ON");` line (~line 649), add:

```ts
  // Scheduled tasks (cron-triggered executor-like runs) + their run history
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      timezone TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      run_type TEXT NOT NULL DEFAULT 'command',
      content TEXT NOT NULL,
      cwd_mode TEXT NOT NULL DEFAULT 'branch',
      branch TEXT,
      directory TEXT,
      timeout_seconds INTEGER NOT NULL DEFAULT 1800,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      output TEXT,
      process_id TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP,
      FOREIGN KEY (schedule_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_schedule ON scheduled_task_runs(schedule_id);
  `);

  // Server died mid-run: 'running' rows from a previous instance are orphans
  // (same idiom as the executor_processes fixup earlier in this function).
  db.exec("UPDATE scheduled_task_runs SET status = 'killed', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'");
```

- [ ] **Step 5: Add row mappers and CRUD implementations**

In `packages/vibedeckx/src/storage/sqlite.ts`:

First extend the type import from `./types.js` (top of file) with: `ScheduledTask`, `ScheduledTaskRun`, `ScheduledTaskRunType`, `ScheduledTaskCwdMode`, `ScheduledTaskRunStatus`.

Next, directly after the `mapExecutorRow` helper (~line 728, inside `createSqliteStorage`), add:

```ts
  type ScheduledTaskRow = { id: string; project_id: string; name: string; cron_expr: string; timezone: string; enabled: number; run_type: string; content: string; cwd_mode: string; branch: string | null; directory: string | null; timeout_seconds: number; created_at: string; updated_at: string };
  const mapScheduledTaskRow = (row: ScheduledTaskRow): ScheduledTask => ({
    ...row,
    enabled: row.enabled === 1,
    run_type: row.run_type as ScheduledTaskRunType,
    cwd_mode: row.cwd_mode as ScheduledTaskCwdMode,
  });

  type ScheduledTaskRunRow = { id: string; schedule_id: string; status: string; exit_code: number | null; output: string | null; process_id: string | null; started_at: string; finished_at: string | null };
  const mapScheduledTaskRunRow = (row: ScheduledTaskRunRow): ScheduledTaskRun => ({
    ...row,
    status: row.status as ScheduledTaskRunStatus,
  });
```

Then, in the returned storage object, directly after the `executorProcesses: { ... },` block (ends ~line 1399), add:

```ts
    scheduledTasks: {
      create: ({ id, project_id, name, cron_expr, timezone, run_type, content, cwd_mode, branch, directory, timeout_seconds, enabled }) => {
        db.prepare(
          `INSERT INTO scheduled_tasks (id, project_id, name, cron_expr, timezone, enabled, run_type, content, cwd_mode, branch, directory, timeout_seconds)
           VALUES (@id, @project_id, @name, @cron_expr, @timezone, @enabled, @run_type, @content, @cwd_mode, @branch, @directory, @timeout_seconds)`
        ).run({
          id, project_id, name, cron_expr, timezone,
          enabled: enabled === false ? 0 : 1,
          run_type, content, cwd_mode,
          branch: branch ?? null,
          directory: directory ?? null,
          timeout_seconds: timeout_seconds ?? 1800,
        });
        const row = db.prepare<{ id: string }, ScheduledTaskRow>(`SELECT * FROM scheduled_tasks WHERE id = @id`).get({ id })!;
        return mapScheduledTaskRow(row);
      },
      getByProjectId: (projectId) => {
        const rows = db
          .prepare<{ project_id: string }, ScheduledTaskRow>(`SELECT * FROM scheduled_tasks WHERE project_id = @project_id ORDER BY created_at ASC, id ASC`)
          .all({ project_id: projectId });
        return rows.map(mapScheduledTaskRow);
      },
      getById: (id) => {
        const row = db.prepare<{ id: string }, ScheduledTaskRow>(`SELECT * FROM scheduled_tasks WHERE id = @id`).get({ id });
        return row ? mapScheduledTaskRow(row) : undefined;
      },
      getAllEnabled: () => {
        const rows = db.prepare<[], ScheduledTaskRow>(`SELECT * FROM scheduled_tasks WHERE enabled = 1`).all();
        return rows.map(mapScheduledTaskRow);
      },
      update: (id, opts) => {
        const sets: string[] = [];
        const params: Record<string, unknown> = { id };
        if (opts.name !== undefined) { sets.push("name = @name"); params.name = opts.name; }
        if (opts.cron_expr !== undefined) { sets.push("cron_expr = @cron_expr"); params.cron_expr = opts.cron_expr; }
        if (opts.timezone !== undefined) { sets.push("timezone = @timezone"); params.timezone = opts.timezone; }
        if (opts.enabled !== undefined) { sets.push("enabled = @enabled"); params.enabled = opts.enabled ? 1 : 0; }
        if (opts.run_type !== undefined) { sets.push("run_type = @run_type"); params.run_type = opts.run_type; }
        if (opts.content !== undefined) { sets.push("content = @content"); params.content = opts.content; }
        if (opts.cwd_mode !== undefined) { sets.push("cwd_mode = @cwd_mode"); params.cwd_mode = opts.cwd_mode; }
        if (opts.branch !== undefined) { sets.push("branch = @branch"); params.branch = opts.branch; }
        if (opts.directory !== undefined) { sets.push("directory = @directory"); params.directory = opts.directory; }
        if (opts.timeout_seconds !== undefined) { sets.push("timeout_seconds = @timeout_seconds"); params.timeout_seconds = opts.timeout_seconds; }
        if (sets.length > 0) {
          sets.push("updated_at = CURRENT_TIMESTAMP");
          db.prepare(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = @id`).run(params);
        }
        const row = db.prepare<{ id: string }, ScheduledTaskRow>(`SELECT * FROM scheduled_tasks WHERE id = @id`).get({ id });
        return row ? mapScheduledTaskRow(row) : undefined;
      },
      delete: (id) => {
        db.prepare(`DELETE FROM scheduled_tasks WHERE id = @id`).run({ id });
      },
    },
    scheduledTaskRuns: {
      create: ({ id, schedule_id, status, process_id }) => {
        db.prepare(
          `INSERT INTO scheduled_task_runs (id, schedule_id, status, process_id, finished_at)
           VALUES (@id, @schedule_id, @status, @process_id, CASE WHEN @status = 'running' THEN NULL ELSE CURRENT_TIMESTAMP END)`
        ).run({ id, schedule_id, status: status ?? "running", process_id: process_id ?? null });
        const row = db.prepare<{ id: string }, ScheduledTaskRunRow>(`SELECT * FROM scheduled_task_runs WHERE id = @id`).get({ id })!;
        return mapScheduledTaskRunRow(row);
      },
      getById: (id) => {
        const row = db.prepare<{ id: string }, ScheduledTaskRunRow>(`SELECT * FROM scheduled_task_runs WHERE id = @id`).get({ id });
        return row ? mapScheduledTaskRunRow(row) : undefined;
      },
      getByScheduleId: (scheduleId, limit = 50) => {
        const rows = db.prepare<{ schedule_id: string; limit: number }, ScheduledTaskRunRow>(
          `SELECT id, schedule_id, status, exit_code, NULL AS output, process_id, started_at, finished_at
           FROM scheduled_task_runs WHERE schedule_id = @schedule_id
           ORDER BY started_at DESC, rowid DESC LIMIT @limit`
        ).all({ schedule_id: scheduleId, limit });
        return rows.map(mapScheduledTaskRunRow);
      },
      getLastByScheduleIds: (scheduleIds) => {
        const stmt = db.prepare<{ schedule_id: string }, ScheduledTaskRunRow>(
          `SELECT id, schedule_id, status, exit_code, NULL AS output, process_id, started_at, finished_at
           FROM scheduled_task_runs WHERE schedule_id = @schedule_id
           ORDER BY started_at DESC, rowid DESC LIMIT 1`
        );
        const result: Record<string, ScheduledTaskRun> = {};
        for (const sid of scheduleIds) {
          const row = stmt.get({ schedule_id: sid });
          if (row) result[sid] = mapScheduledTaskRunRow(row);
        }
        return result;
      },
      finish: (id, opts) => {
        db.prepare(
          `UPDATE scheduled_task_runs SET status = @status, exit_code = @exit_code, output = @output, finished_at = CURRENT_TIMESTAMP WHERE id = @id`
        ).run({ id, status: opts.status, exit_code: opts.exit_code ?? null, output: opts.output ?? null });
      },
      prune: (scheduleId, keep) => {
        db.prepare(
          `DELETE FROM scheduled_task_runs WHERE schedule_id = @schedule_id AND id NOT IN (
             SELECT id FROM scheduled_task_runs WHERE schedule_id = @schedule_id ORDER BY started_at DESC, rowid DESC LIMIT @keep
           )`
        ).run({ schedule_id: scheduleId, keep });
      },
    },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/vibedeckx && npx vitest run src/storage/scheduled-tasks.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: exits 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/vibedeckx/src/storage/types.ts packages/vibedeckx/src/storage/sqlite.ts packages/vibedeckx/src/storage/scheduled-tasks.test.ts
git commit -m "feat: scheduled_tasks + scheduled_task_runs storage"
```

---

### Task 2: SchedulerService — cron jobs, run execution, output capture

**Files:**
- Modify: `packages/vibedeckx/package.json` (add `croner` dependency)
- Modify: `packages/vibedeckx/src/event-bus.ts` (two new `GlobalEvent` union members, ~lines 4-13)
- Create: `packages/vibedeckx/src/scheduler.ts`
- Test: `packages/vibedeckx/src/scheduler.test.ts`

**Interfaces:**
- Consumes: `storage.scheduledTasks` / `storage.scheduledTaskRuns` (Task 1 signatures), `ProcessManager.start(executor: Executor, projectPath: string, skipDb?: boolean): string`, `ProcessManager.subscribe(processId: string, cb: (msg: LogMessage) => void): (() => void) | null`, `ProcessManager.stop(processId: string): boolean`, `resolveWorktreePath(projectPath: string, branch: string | null): string` from `utils/worktree-paths.js`.
- Produces: `validateCron(expr: string, timezone?: string): string | null` (error message or null); `class SchedulerService` with `constructor(storage: Storage, processManager: ProcessManager)`, `setEventBus(eventBus: EventBus): void`, `start(): void`, `reschedule(scheduleId: string): void`, `unschedule(scheduleId: string): void`, `nextRunAt(scheduleId: string): string | null`, `isRunning(scheduleId: string): boolean`, `runNow(scheduleId: string): RunNowResult`, `shutdown(): void`. `RunNowResult = { runId: string; skipped: boolean } | { error: string }`.
- Produces: `GlobalEvent` members `schedule:run-started` / `schedule:run-finished` (both carry `projectId` so the existing SSE per-tenant filter in `event-routes.ts` works unchanged).

- [ ] **Step 1: Add the croner dependency**

Run: `pnpm --filter vibedeckx add croner`
Expected: `croner` (^9.x) appears in `packages/vibedeckx/package.json` dependencies.

- [ ] **Step 2: Add the event-bus union members**

In `packages/vibedeckx/src/event-bus.ts`, inside the `GlobalEvent` union (after the `executor:stopped` member), add:

```ts
  | { type: "schedule:run-started"; projectId: string; scheduleId: string; runId: string }
  | { type: "schedule:run-finished"; projectId: string; scheduleId: string; runId: string; status: string; exitCode: number | null }
```

- [ ] **Step 3: Write the failing test**

Create `packages/vibedeckx/src/scheduler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage, Executor } from "./storage/types.js";
import type { ProcessManager, LogMessage } from "./process-manager.js";
import { SchedulerService, validateCron } from "./scheduler.js";

describe("validateCron", () => {
  it("accepts a standard 5-field expression", () => {
    expect(validateCron("0 9 * * *")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(validateCron("not a cron")).toBeTypeOf("string");
  });
  it("rejects an invalid timezone", () => {
    expect(validateCron("0 9 * * *", "Mars/Olympus")).toContain("Invalid timezone");
  });
  it("accepts a valid timezone", () => {
    expect(validateCron("0 9 * * *", "Asia/Shanghai")).toBeNull();
  });
});

function makeFakeProcessManager() {
  const subscribers = new Map<string, (msg: LogMessage) => void>();
  let counter = 0;
  const fake = {
    started: [] as { executor: Executor; cwd: string; skipDb: boolean }[],
    stopped: [] as string[],
    start(executor: Executor, cwd: string, skipDb = false): string {
      const id = `proc-${++counter}`;
      fake.started.push({ executor, cwd, skipDb });
      return id;
    },
    subscribe(processId: string, cb: (msg: LogMessage) => void) {
      subscribers.set(processId, cb);
      return () => subscribers.delete(processId);
    },
    stop(processId: string): boolean {
      fake.stopped.push(processId);
      return true;
    },
    emit(processId: string, msg: LogMessage) {
      subscribers.get(processId)?.(msg);
    },
  };
  return fake;
}

describe("SchedulerService.runNow", () => {
  let dir: string;
  let storage: Storage;
  let pm: ReturnType<typeof makeFakeProcessManager>;
  let scheduler: SchedulerService;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-schedsvc-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    storage.projects.create({ id: "proj-1", name: "p", path: dir });
    storage.scheduledTasks.create({
      id: "s1", project_id: "proj-1", name: "echo", cron_expr: "0 9 * * *",
      timezone: "UTC", run_type: "command", content: "echo hi",
      cwd_mode: "directory", directory: dir, timeout_seconds: 60,
    });
    pm = makeFakeProcessManager();
    scheduler = new SchedulerService(storage, pm as unknown as ProcessManager);
  });

  afterEach(() => {
    scheduler.shutdown();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns with skipDb in the task directory and records a completed run with output", () => {
    const result = scheduler.runNow("s1");
    expect(result).toMatchObject({ skipped: false });
    expect(pm.started[0].cwd).toBe(dir);
    expect(pm.started[0].skipDb).toBe(true);
    expect(pm.started[0].executor.executor_type).toBe("command");
    expect(pm.started[0].executor.command).toBe("echo hi");
    expect(scheduler.isRunning("s1")).toBe(true);

    pm.emit("proc-1", { type: "stdout", data: "hello " });
    pm.emit("proc-1", { type: "stdout", data: "world" });
    pm.emit("proc-1", { type: "finished", exitCode: 0 });

    const runId = (result as { runId: string }).runId;
    const run = storage.scheduledTaskRuns.getById(runId);
    expect(run?.status).toBe("completed");
    expect(run?.exit_code).toBe(0);
    expect(run?.output).toBe("hello world");
    expect(scheduler.isRunning("s1")).toBe(false);
  });

  it("records failed on non-zero exit", () => {
    const result = scheduler.runNow("s1") as { runId: string };
    pm.emit("proc-1", { type: "finished", exitCode: 3 });
    const run = storage.scheduledTaskRuns.getById(result.runId);
    expect(run?.status).toBe("failed");
    expect(run?.exit_code).toBe(3);
  });

  it("skips (and records the skip) when a run is already active", () => {
    scheduler.runNow("s1");
    const second = scheduler.runNow("s1");
    expect(second).toMatchObject({ skipped: true });
    const runs = storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(runs.some((r) => r.status === "skipped")).toBe(true);
  });

  it("kills and marks timeout when the run exceeds timeout_seconds", () => {
    vi.useFakeTimers();
    try {
      const result = scheduler.runNow("s1") as { runId: string };
      vi.advanceTimersByTime(61_000);
      expect(pm.stopped).toContain("proc-1");
      expect(storage.scheduledTaskRuns.getById(result.runId)?.status).toBe("timeout");
      // A late 'finished' after the kill must not overwrite the timeout status
      pm.emit("proc-1", { type: "finished", exitCode: 137 });
      expect(storage.scheduledTaskRuns.getById(result.runId)?.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prompt tasks are fabricated as claude prompt executors", () => {
    storage.scheduledTasks.create({
      id: "s2", project_id: "proj-1", name: "ai", cron_expr: "0 9 * * *",
      timezone: "UTC", run_type: "prompt", content: "analyze the logs",
      cwd_mode: "directory", directory: dir,
    });
    scheduler.runNow("s2");
    const started = pm.started[pm.started.length - 1];
    expect(started.executor.executor_type).toBe("prompt");
    expect(started.executor.prompt_provider).toBe("claude");
    expect(started.executor.command).toBe("analyze the logs");
  });

  it("fails without spawning when the directory does not exist", () => {
    storage.scheduledTasks.update("s1", { directory: path.join(dir, "missing") });
    const result = scheduler.runNow("s1");
    expect(result).toMatchObject({ error: expect.stringContaining("does not exist") });
    expect(pm.started).toHaveLength(0);
    const runs = storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(runs[0].status).toBe("failed");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/scheduler.test.ts`
Expected: FAIL — cannot resolve `./scheduler.js`.

- [ ] **Step 5: Write `scheduler.ts`**

Create `packages/vibedeckx/src/scheduler.ts`:

```ts
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import path from "path";
import { Cron } from "croner";
import type { Storage, Executor, ScheduledTask, ScheduledTaskRunStatus } from "./storage/types.js";
import type { ProcessManager, LogMessage } from "./process-manager.js";
import type { EventBus } from "./event-bus.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";

/** Max characters of captured output persisted per run. */
const OUTPUT_CAP = 200_000;
/** Run-history rows kept per schedule. */
const RUNS_KEEP = 50;

/** Returns an error message, or null when the expression (and timezone) are valid. */
export function validateCron(expr: string, timezone?: string): string | null {
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return `Invalid timezone: ${timezone}`;
    }
  }
  try {
    const job = new Cron(expr, { paused: true, timezone });
    job.stop();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export type RunNowResult = { runId: string; skipped: boolean } | { error: string };

export class SchedulerService {
  private jobs = new Map<string, Cron>();
  /** scheduleId -> runId of the currently active run (overlap guard). */
  private activeRuns = new Map<string, string>();
  private eventBus?: EventBus;
  private stopped = false;

  constructor(
    private storage: Storage,
    private processManager: ProcessManager,
  ) {}

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /** Schedule all enabled tasks. Call once at startup. */
  start(): void {
    for (const task of this.storage.scheduledTasks.getAllEnabled()) {
      this.scheduleJob(task);
    }
    console.log(`[Scheduler] Started with ${this.jobs.size} scheduled task(s)`);
  }

  /** (Re)compute the cron job for a schedule after create/update/toggle. */
  reschedule(scheduleId: string): void {
    this.unschedule(scheduleId);
    const task = this.storage.scheduledTasks.getById(scheduleId);
    if (task && task.enabled) {
      this.scheduleJob(task);
    }
  }

  unschedule(scheduleId: string): void {
    const job = this.jobs.get(scheduleId);
    if (job) {
      job.stop();
      this.jobs.delete(scheduleId);
    }
  }

  nextRunAt(scheduleId: string): string | null {
    return this.jobs.get(scheduleId)?.nextRun()?.toISOString() ?? null;
  }

  isRunning(scheduleId: string): boolean {
    return this.activeRuns.has(scheduleId);
  }

  runNow(scheduleId: string): RunNowResult {
    return this.executeRun(scheduleId);
  }

  shutdown(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    // In-flight child processes are killed by ProcessManager.shutdown();
    // their run rows are marked 'killed' by the sqlite startup fixup on next boot.
  }

  private scheduleJob(task: ScheduledTask): void {
    try {
      const job = new Cron(task.cron_expr, { timezone: task.timezone, catch: true }, () => {
        if (this.stopped) return;
        const result = this.executeRun(task.id);
        if ("error" in result) {
          console.error(`[Scheduler] Run of ${task.id} failed to start: ${result.error}`);
        }
      });
      this.jobs.set(task.id, job);
    } catch (err) {
      // Bad cron/timezone that slipped past route validation must not crash startup.
      console.error(`[Scheduler] Could not schedule ${task.id} (${task.cron_expr}): ${err}`);
    }
  }

  /** Record a run that failed before a process could be spawned. */
  private failWithoutStart(task: ScheduledTask, runId: string, message: string): RunNowResult {
    this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: task.id });
    this.storage.scheduledTaskRuns.finish(runId, { status: "failed", output: message });
    this.storage.scheduledTaskRuns.prune(task.id, RUNS_KEEP);
    this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId: task.id, runId, status: "failed", exitCode: null });
    return { error: message };
  }

  private executeRun(scheduleId: string): RunNowResult {
    const task = this.storage.scheduledTasks.getById(scheduleId);
    if (!task) return { error: "Schedule not found" };

    const runId = randomUUID();

    // Overlap policy: skip (recorded) when the previous run is still going.
    if (this.activeRuns.has(scheduleId)) {
      this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: scheduleId, status: "skipped" });
      this.storage.scheduledTaskRuns.prune(scheduleId, RUNS_KEEP);
      return { runId, skipped: true };
    }

    // Resolve the working directory.
    let cwd: string;
    if (task.cwd_mode === "directory") {
      if (!task.directory || !path.isAbsolute(task.directory)) {
        return this.failWithoutStart(task, runId, `Schedule directory must be an absolute path: ${task.directory ?? "(unset)"}`);
      }
      cwd = task.directory;
    } else {
      const project = this.storage.projects.getById(task.project_id);
      if (!project?.path) {
        return this.failWithoutStart(task, runId, "Project has no local path");
      }
      try {
        cwd = resolveWorktreePath(project.path, task.branch);
      } catch (err) {
        return this.failWithoutStart(task, runId, `Could not resolve worktree for branch ${task.branch}: ${err}`);
      }
    }
    if (!existsSync(cwd)) {
      return this.failWithoutStart(task, runId, `Working directory does not exist: ${cwd}`);
    }

    // Fabricated executor — same shape a UI command/prompt executor has, so
    // ProcessManager applies its normal dispatch (command -> PTY; prompt ->
    // claude stream-json with readable formatted log output). skipDb=true keeps
    // ProcessManager from writing executor_processes rows (FK-bound to real
    // executors); our run history lives in scheduled_task_runs instead.
    const executor: Executor = {
      id: `schedule-${task.id}`,
      project_id: task.project_id,
      group_id: "",
      name: task.name,
      command: task.content,
      executor_type: task.run_type,
      prompt_provider: task.run_type === "prompt" ? "claude" : null,
      cwd: null,
      pty: true,
      position: 0,
      disabled_targets: [],
      created_at: new Date().toISOString(),
    };

    let processId: string;
    try {
      processId = this.processManager.start(executor, cwd, true);
    } catch (err) {
      return this.failWithoutStart(task, runId, `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: scheduleId, status: "running", process_id: processId });
    this.activeRuns.set(scheduleId, runId);
    this.eventBus?.emit({ type: "schedule:run-started", projectId: task.project_id, scheduleId, runId });

    let output = "";
    let finalized = false;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | null = null;

    const finalize = (status: ScheduledTaskRunStatus, exitCode: number | null) => {
      if (finalized) return;
      finalized = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      this.activeRuns.delete(scheduleId);
      this.storage.scheduledTaskRuns.finish(runId, { status, exit_code: exitCode, output: output.slice(-OUTPUT_CAP) });
      this.storage.scheduledTaskRuns.prune(scheduleId, RUNS_KEEP);
      this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId, runId, status, exitCode });
    };

    unsubscribe = this.processManager.subscribe(processId, (msg: LogMessage) => {
      if (msg.type === "stdout" || msg.type === "stderr" || msg.type === "pty") {
        output += msg.data;
        // Trim lazily at 2x cap to avoid re-slicing on every chunk.
        if (output.length > OUTPUT_CAP * 2) output = output.slice(-OUTPUT_CAP);
      } else if (msg.type === "finished") {
        finalize(msg.exitCode === 0 ? "completed" : "failed", msg.exitCode);
      }
    });
    if (!unsubscribe) {
      // Process vanished before we could observe it — should not happen
      // (subscribe runs in the same tick as start), but don't leak activeRuns.
      finalize("failed", null);
      return { runId, skipped: false };
    }

    timer = setTimeout(() => {
      this.processManager.stop(processId);
      finalize("timeout", null);
    }, task.timeout_seconds * 1000);
    timer.unref(); // don't hold the event loop open for a sleeping timer

    return { runId, skipped: false };
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/scheduler.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: exits 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/vibedeckx/package.json pnpm-lock.yaml packages/vibedeckx/src/event-bus.ts packages/vibedeckx/src/scheduler.ts packages/vibedeckx/src/scheduler.test.ts
git commit -m "feat: SchedulerService with croner cron jobs and run capture"
```

---

### Task 3: REST routes + server wiring

**Files:**
- Create: `packages/vibedeckx/src/routes/schedule-routes.ts`
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts` (instantiate ~line 24, decorate block ~line 189, eventBus wiring ~line 201, onClose hook ~line 231)
- Modify: `packages/vibedeckx/src/server-types.ts` (FastifyInstance augmentation)
- Modify: `packages/vibedeckx/src/server.ts` (import + register)

**Interfaces:**
- Consumes: `SchedulerService` + `validateCron` (Task 2), storage slices (Task 1), `requireAuth` from `../server.js` (returns `string | undefined | null`; `null` = 401 already sent).
- Produces: `fastify.scheduler: SchedulerService` decorator.
- Produces REST API (all responses wrapped like existing routes: `{ schedules }`, `{ schedule }`, `{ runs }`, `{ run }`, errors as `{ error }`):
  - `GET /api/projects/:projectId/schedules` → `{ schedules: (ScheduledTask & { last_run: ScheduledTaskRun | null; next_run_at: string | null; running: boolean })[] }`
  - `POST /api/projects/:projectId/schedules` → 201 `{ schedule }`
  - `PUT /api/schedules/:id` → `{ schedule }`
  - `DELETE /api/schedules/:id` → 204
  - `POST /api/schedules/:id/run` → `{ runId }`, 409 when already running, 400 when it can't start
  - `GET /api/schedules/:id/runs` → `{ runs }` (output always null)
  - `GET /api/schedule-runs/:id` → `{ run }` (includes output)

- [ ] **Step 1: Write the routes file**

Create `packages/vibedeckx/src/routes/schedule-routes.ts`:

```ts
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import type { ScheduledTask, ScheduledTaskRunType, ScheduledTaskCwdMode } from "../storage/types.js";
import { requireAuth } from "../server.js";
import { validateCron } from "../scheduler.js";
import "../server-types.js";

const RUN_TYPES: ScheduledTaskRunType[] = ["command", "prompt"];
const CWD_MODES: ScheduledTaskCwdMode[] = ["branch", "directory"];

interface ScheduleBody {
  name?: string;
  cron_expr?: string;
  timezone?: string;
  enabled?: boolean;
  run_type?: string;
  content?: string;
  cwd_mode?: string;
  branch?: string | null;
  directory?: string | null;
  timeout_seconds?: number;
}

/** Cross-field validation shared by create and update. Returns an error string or null. */
function validateResolved(b: { cron_expr: string; timezone: string; run_type: string; content: string; cwd_mode: string; directory: string | null; timeout_seconds: number }): string | null {
  if (!RUN_TYPES.includes(b.run_type as ScheduledTaskRunType)) return `run_type must be one of: ${RUN_TYPES.join(", ")}`;
  if (!CWD_MODES.includes(b.cwd_mode as ScheduledTaskCwdMode)) return `cwd_mode must be one of: ${CWD_MODES.join(", ")}`;
  if (!b.content.trim()) return "content is required";
  if (b.cwd_mode === "directory" && !b.directory?.trim()) return "directory is required when cwd_mode is 'directory'";
  if (!Number.isInteger(b.timeout_seconds) || b.timeout_seconds <= 0) return "timeout_seconds must be a positive integer";
  const cronError = validateCron(b.cron_expr, b.timezone);
  if (cronError) return `Invalid cron expression: ${cronError}`;
  return null;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Resolve a schedule by id and enforce project ownership (same idiom as
  // command-routes PUT/DELETE: child fetched unscoped, parent project scoped
  // by userId). Sends the 404 itself and returns null when not accessible.
  const getAuthorizedSchedule = (id: string, userId: string | undefined, reply: FastifyReply): ScheduledTask | null => {
    const schedule = fastify.storage.scheduledTasks.getById(id);
    if (!schedule) {
      reply.code(404).send({ error: "Schedule not found" });
      return null;
    }
    const project = fastify.storage.projects.getById(schedule.project_id, userId);
    if (!project) {
      reply.code(404).send({ error: "Schedule not found" });
      return null;
    }
    return schedule;
  };

  fastify.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/schedules",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) return reply.code(404).send({ error: "Project not found" });

      const schedules = fastify.storage.scheduledTasks.getByProjectId(req.params.projectId);
      const lastRuns = fastify.storage.scheduledTaskRuns.getLastByScheduleIds(schedules.map((s) => s.id));
      return reply.code(200).send({
        schedules: schedules.map((s) => ({
          ...s,
          last_run: lastRuns[s.id] ?? null,
          next_run_at: fastify.scheduler.nextRunAt(s.id),
          running: fastify.scheduler.isRunning(s.id),
        })),
      });
    }
  );

  fastify.post<{ Params: { projectId: string }; Body: ScheduleBody }>(
    "/api/projects/:projectId/schedules",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) return reply.code(404).send({ error: "Project not found" });

      const b = req.body ?? {};
      if (!b.name?.trim()) return reply.code(400).send({ error: "name is required" });
      if (!b.cron_expr?.trim()) return reply.code(400).send({ error: "cron_expr is required" });
      const resolved = {
        cron_expr: b.cron_expr.trim(),
        timezone: b.timezone?.trim() || "UTC",
        run_type: b.run_type ?? "command",
        content: b.content ?? "",
        cwd_mode: b.cwd_mode ?? "branch",
        directory: b.directory ?? null,
        timeout_seconds: b.timeout_seconds ?? 1800,
      };
      const error = validateResolved(resolved);
      if (error) return reply.code(400).send({ error });

      const schedule = fastify.storage.scheduledTasks.create({
        id: randomUUID(),
        project_id: req.params.projectId,
        name: b.name.trim(),
        cron_expr: resolved.cron_expr,
        timezone: resolved.timezone,
        run_type: resolved.run_type as ScheduledTaskRunType,
        content: resolved.content,
        cwd_mode: resolved.cwd_mode as ScheduledTaskCwdMode,
        branch: b.branch ?? null,
        directory: resolved.directory,
        timeout_seconds: resolved.timeout_seconds,
        enabled: b.enabled ?? true,
      });
      fastify.scheduler.reschedule(schedule.id);
      return reply.code(201).send({ schedule });
    }
  );

  fastify.put<{ Params: { id: string }; Body: ScheduleBody }>(
    "/api/schedules/:id",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = getAuthorizedSchedule(req.params.id, userId ?? undefined, reply);
      if (!existing) return;

      const b = req.body ?? {};
      // Validate the merged (existing + patch) shape so partial updates can't
      // produce an invalid combination (e.g. cwd_mode=directory without directory).
      const merged = {
        cron_expr: b.cron_expr?.trim() ?? existing.cron_expr,
        timezone: b.timezone?.trim() ?? existing.timezone,
        run_type: b.run_type ?? existing.run_type,
        content: b.content ?? existing.content,
        cwd_mode: b.cwd_mode ?? existing.cwd_mode,
        directory: b.directory !== undefined ? b.directory : existing.directory,
        timeout_seconds: b.timeout_seconds ?? existing.timeout_seconds,
      };
      if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: "name must not be empty" });
      const error = validateResolved(merged);
      if (error) return reply.code(400).send({ error });

      const schedule = fastify.storage.scheduledTasks.update(req.params.id, {
        name: b.name?.trim(),
        cron_expr: b.cron_expr?.trim(),
        timezone: b.timezone?.trim(),
        enabled: b.enabled,
        run_type: b.run_type as ScheduledTaskRunType | undefined,
        content: b.content,
        cwd_mode: b.cwd_mode as ScheduledTaskCwdMode | undefined,
        branch: b.branch,
        directory: b.directory,
        timeout_seconds: b.timeout_seconds,
      });
      fastify.scheduler.reschedule(req.params.id);
      return reply.code(200).send({ schedule });
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/schedules/:id",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = getAuthorizedSchedule(req.params.id, userId ?? undefined, reply);
      if (!existing) return;

      fastify.scheduler.unschedule(req.params.id);
      fastify.storage.scheduledTasks.delete(req.params.id);
      return reply.code(204).send();
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/schedules/:id/run",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = getAuthorizedSchedule(req.params.id, userId ?? undefined, reply);
      if (!existing) return;

      const result = fastify.scheduler.runNow(req.params.id);
      if ("error" in result) return reply.code(400).send({ error: result.error });
      if (result.skipped) return reply.code(409).send({ error: "A run is already in progress" });
      return reply.code(200).send({ runId: result.runId });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    "/api/schedules/:id/runs",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = getAuthorizedSchedule(req.params.id, userId ?? undefined, reply);
      if (!existing) return;

      return reply.code(200).send({ runs: fastify.storage.scheduledTaskRuns.getByScheduleId(req.params.id) });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    "/api/schedule-runs/:id",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const run = fastify.storage.scheduledTaskRuns.getById(req.params.id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      // Ownership: run -> schedule -> project (scoped by userId)
      const schedule = getAuthorizedSchedule(run.schedule_id, userId ?? undefined, reply);
      if (!schedule) return;

      return reply.code(200).send({ run });
    }
  );
};

export default fp(routes, { name: "schedule-routes" });
```

- [ ] **Step 2: Wire the scheduler into shared services**

In `packages/vibedeckx/src/plugins/shared-services.ts`:

Add the import (with the other manager imports at the top):

```ts
import { SchedulerService } from "../scheduler.js";
```

Instantiate directly after `const processManager = new ProcessManager(opts.storage);` (~line 24):

```ts
  const scheduler = new SchedulerService(opts.storage, processManager);
```

In the decorate block (after `fastify.decorate("browserManager", browserManager);` ~line 200), add:

```ts
  fastify.decorate("scheduler", scheduler);
```

After `processManager.setEventBus(eventBus);` (~line 204), add:

```ts
  scheduler.setEventBus(eventBus);
  scheduler.start();
```

In the `fastify.addHook("onClose", ...)` handler (~line 231), add as the first line:

```ts
    scheduler.shutdown();
```

- [ ] **Step 3: Type the decorator**

In `packages/vibedeckx/src/server-types.ts`, add the import:

```ts
import type { SchedulerService } from "./scheduler.js";
```

and inside `declare module "fastify"` → `interface FastifyInstance`, after `browserManager: BrowserManager;`:

```ts
    scheduler: SchedulerService;
```

- [ ] **Step 4: Register the routes**

In `packages/vibedeckx/src/server.ts`, add with the other route imports (~line 15):

```ts
import scheduleRoutes from "./routes/schedule-routes.js";
```

and in the route-registration block (next to `server.register(executorRoutes);` ~line 293):

```ts
  server.register(scheduleRoutes);
```

- [ ] **Step 5: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: exits 0, no errors.

- [ ] **Step 6: Manual end-to-end verification of the backend**

```bash
pnpm build:main
node packages/vibedeckx/dist/bin.js start --port 5199 &
sleep 2

# Create a project to hang the schedule off
PID=$(curl -s -X POST http://127.0.0.1:5199/api/projects -H 'Content-Type: application/json' \
  -d '{"name":"schedtest","path":"/tmp"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).project.id))')

# Create an every-minute schedule running in /tmp
SID=$(curl -s -X POST http://127.0.0.1:5199/api/projects/$PID/schedules -H 'Content-Type: application/json' \
  -d '{"name":"hello","cron_expr":"* * * * *","timezone":"UTC","run_type":"command","content":"echo scheduled-hello; date","cwd_mode":"directory","directory":"/tmp"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).schedule.id))')

# List: expect next_run_at set, last_run null
curl -s http://127.0.0.1:5199/api/projects/$PID/schedules

# Run now, then check history and output
RID=$(curl -s -X POST http://127.0.0.1:5199/api/schedules/$SID/run \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).runId))')
sleep 3
curl -s http://127.0.0.1:5199/api/schedules/$SID/runs          # expect one completed run, output:null
curl -s http://127.0.0.1:5199/api/schedule-runs/$RID           # expect output containing "scheduled-hello"

# Bad cron is rejected
curl -s -X POST http://127.0.0.1:5199/api/projects/$PID/schedules -H 'Content-Type: application/json' \
  -d '{"name":"bad","cron_expr":"nope","content":"true","cwd_mode":"directory","directory":"/tmp"}'   # expect 400 Invalid cron expression

# Wait for the cron firing (~60s), then confirm a second run appeared
sleep 65
curl -s http://127.0.0.1:5199/api/schedules/$SID/runs

# Cleanup
curl -s -X DELETE http://127.0.0.1:5199/api/schedules/$SID -o /dev/null -w "%{http_code}\n"   # expect 204
curl -s -X DELETE http://127.0.0.1:5199/api/projects/$PID
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add packages/vibedeckx/src/routes/schedule-routes.ts packages/vibedeckx/src/plugins/shared-services.ts packages/vibedeckx/src/server-types.ts packages/vibedeckx/src/server.ts
git commit -m "feat: scheduled-task REST routes and scheduler wiring"
```

---

### Task 4: Frontend API layer + `useSchedules` hook

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` (interfaces near `Command` ~line 421; methods after the Commands CRUD block ~line 1403)
- Create: `apps/vibedeckx-ui/hooks/use-schedules.ts`

**Interfaces:**
- Consumes: Task 3's REST API; `authFetch`/`getApiBase` (module-internal to `lib/api.ts`); `useGlobalEventStream` from `@/hooks/global-event-stream`.
- Produces: exported types `Schedule`, `ScheduleRun`, `ScheduleRunStatus`, `ScheduleInput`; api methods `getSchedules`, `createSchedule`, `updateSchedule`, `deleteSchedule`, `runScheduleNow`, `getScheduleRuns`, `getScheduleRun`; hook `useSchedules(projectId: string | null)` returning `{ schedules, loading, refetch, createSchedule, updateSchedule, deleteSchedule, runNow }`.

- [ ] **Step 1: Add the shared interfaces**

In `apps/vibedeckx-ui/lib/api.ts`, after the `Command` interface (~line 421), add:

```ts
export type ScheduleRunStatus = "running" | "completed" | "failed" | "timeout" | "killed" | "skipped";

export interface ScheduleRun {
  id: string;
  schedule_id: string;
  status: ScheduleRunStatus;
  exit_code: number | null;
  /** Only populated by getScheduleRun; list endpoints return null. */
  output?: string | null;
  process_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface Schedule {
  id: string;
  project_id: string;
  name: string;
  cron_expr: string;
  timezone: string;
  enabled: boolean;
  run_type: "command" | "prompt";
  content: string;
  cwd_mode: "branch" | "directory";
  branch: string | null;
  directory: string | null;
  timeout_seconds: number;
  created_at: string;
  updated_at: string;
  // Enriched by GET /api/projects/:id/schedules
  last_run?: ScheduleRun | null;
  next_run_at?: string | null;
  running?: boolean;
}

export interface ScheduleInput {
  name: string;
  cron_expr: string;
  timezone: string;
  enabled?: boolean;
  run_type: "command" | "prompt";
  content: string;
  cwd_mode: "branch" | "directory";
  branch?: string | null;
  directory?: string | null;
  timeout_seconds?: number;
}
```

- [ ] **Step 2: Add the api methods**

In the `api` object, directly after `deleteCommand` (~line 1403), add:

```ts
  async getSchedules(projectId: string): Promise<Schedule[]> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/schedules`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.schedules;
  },

  async createSchedule(projectId: string, opts: ScheduleInput): Promise<Schedule> {
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.schedule;
  },

  async updateSchedule(id: string, opts: Partial<ScheduleInput>): Promise<Schedule> {
    const res = await authFetch(`${getApiBase()}/api/schedules/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.schedule;
  },

  async deleteSchedule(id: string): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/schedules/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
  },

  async runScheduleNow(id: string): Promise<{ runId: string }> {
    const res = await authFetch(`${getApiBase()}/api/schedules/${id}/run`, { method: "POST" });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  },

  async getScheduleRuns(id: string): Promise<ScheduleRun[]> {
    const res = await authFetch(`${getApiBase()}/api/schedules/${id}/runs`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.runs;
  },

  async getScheduleRun(runId: string): Promise<ScheduleRun> {
    const res = await authFetch(`${getApiBase()}/api/schedule-runs/${runId}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.run;
  },
```

- [ ] **Step 3: Create the `useSchedules` hook**

Create `apps/vibedeckx-ui/hooks/use-schedules.ts`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Schedule, type ScheduleInput } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

/**
 * Schedules for a project. Refetches on any schedule:* SSE event for the
 * project, so run status dots and next_run_at stay live.
 */
export function useSchedules(projectId: string | null) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!projectId) {
      setSchedules([]);
      return;
    }
    try {
      setSchedules(await api.getSchedules(projectId));
    } catch (err) {
      console.error("Failed to fetch schedules:", err);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setSchedules([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getSchedules(projectId)
      .then((s) => {
        if (!cancelled) setSchedules(s);
      })
      .catch((err) => console.error("Failed to fetch schedules:", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useGlobalEventStream((raw) => {
    const data = raw as { type?: string; projectId?: string };
    if (!data.type?.startsWith("schedule:")) return;
    if (!projectIdRef.current || data.projectId !== projectIdRef.current) return;
    void refetchRef.current();
  });

  const createSchedule = useCallback(
    async (opts: ScheduleInput) => {
      if (!projectId) throw new Error("No project selected");
      const created = await api.createSchedule(projectId, opts);
      await refetch();
      return created;
    },
    [projectId, refetch]
  );

  const updateSchedule = useCallback(
    async (id: string, opts: Partial<ScheduleInput>) => {
      const updated = await api.updateSchedule(id, opts);
      await refetch();
      return updated;
    },
    [refetch]
  );

  const deleteSchedule = useCallback(
    async (id: string) => {
      await api.deleteSchedule(id);
      await refetch();
    },
    [refetch]
  );

  const runNow = useCallback(
    async (id: string) => {
      const result = await api.runScheduleNow(id);
      await refetch();
      return result;
    },
    [refetch]
  );

  return { schedules, loading, refetch, createSchedule, updateSchedule, deleteSchedule, runNow };
}
```

- [ ] **Step 4: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: exits 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/hooks/use-schedules.ts
git commit -m "feat: schedules API client and useSchedules hook"
```

---

### Task 5: Schedule components — form dialog, detail view, run history

**Files:**
- Create: `apps/vibedeckx-ui/components/schedule/schedule-form-dialog.tsx`
- Create: `apps/vibedeckx-ui/components/schedule/schedules-view.tsx`
- Create: `apps/vibedeckx-ui/components/schedule/index.ts`

**Interfaces:**
- Consumes: `Schedule`, `ScheduleRun`, `ScheduleInput`, `Worktree`, `api.getScheduleRuns`, `api.getScheduleRun` (Task 4); `PageHeader` from `@/components/layout`; shadcn `Dialog`/`Button`/`Input`/`Textarea`/`Select`/`Table` from `@/components/ui/*`. Note: there is **no** `components/ui/switch.tsx` — booleans use the plain `<input type="checkbox" className="h-4 w-4 rounded border-input accent-primary" />` pattern from `create-worktree-dialog.tsx`.
- Produces: `ScheduleFormDialog({ open, onOpenChange, onSubmit, initial?, worktrees })` — create when `initial` is absent, edit when present; `SchedulesView({ schedules, loading, selectedId, onSelect, worktrees, onCreate, onUpdate, onDelete, onRunNow, createOpen, onCreateOpenChange })` (exact prop types in the code below — Task 6 wires these from `app/page.tsx`).

- [ ] **Step 1: Create the form dialog**

Create `apps/vibedeckx-ui/components/schedule/schedule-form-dialog.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Schedule, ScheduleInput, Worktree } from "@/lib/api";

// Radix Select items can't have an empty-string value; sentinel for the main worktree.
const MAIN = "__main__";

export function ScheduleFormDialog({
  open,
  onOpenChange,
  onSubmit,
  initial,
  worktrees,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: ScheduleInput) => Promise<void>;
  /** Set when editing an existing schedule. */
  initial?: Schedule | null;
  worktrees: Worktree[];
}) {
  const [name, setName] = useState("");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState("");
  const [runType, setRunType] = useState<"command" | "prompt">("command");
  const [content, setContent] = useState("");
  const [cwdMode, setCwdMode] = useState<"branch" | "directory">("branch");
  const [branch, setBranch] = useState<string>(MAIN);
  const [directory, setDirectory] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("30");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)seed fields each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(initial?.name ?? "");
    setCronExpr(initial?.cron_expr ?? "0 9 * * *");
    setTimezone(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    setRunType(initial?.run_type ?? "command");
    setContent(initial?.content ?? "");
    setCwdMode(initial?.cwd_mode ?? "branch");
    setBranch(initial?.branch ?? MAIN);
    setDirectory(initial?.directory ?? "");
    setTimeoutMinutes(String(Math.round((initial?.timeout_seconds ?? 1800) / 60)));
  }, [open, initial]);

  const handleSubmit = async () => {
    if (!name.trim() || !content.trim()) {
      setError("Name and content are required");
      return;
    }
    const minutes = parseInt(timeoutMinutes, 10);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      setError("Timeout must be a positive number of minutes");
      return;
    }
    if (cwdMode === "directory" && !directory.trim()) {
      setError("Directory is required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        cron_expr: cronExpr.trim(),
        timezone: timezone.trim() || "UTC",
        run_type: runType,
        content,
        cwd_mode: cwdMode,
        branch: cwdMode === "branch" ? (branch === MAIN ? null : branch) : null,
        directory: cwdMode === "directory" ? directory.trim() : null,
        timeout_seconds: minutes * 60,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save schedule");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Scheduled Task" : "New Scheduled Task"}</DialogTitle>
          <DialogDescription>
            Run a command or a Claude prompt on a cron schedule
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily log analysis" disabled={loading} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Cron</label>
              <Input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} placeholder="0 9 * * *" className="font-mono" disabled={loading} />
              <p className="text-xs text-muted-foreground">5-field cron — “0 9 * * *” = every day at 09:00</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Timezone</label>
              <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Shanghai" disabled={loading} />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Type</label>
            <Select value={runType} onValueChange={(v) => setRunType(v as "command" | "prompt")} disabled={loading}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="command">Command (shell)</SelectItem>
                <SelectItem value="prompt">Prompt (Claude)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{runType === "command" ? "Command" : "Prompt"}</label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={runType === "command" ? "./scripts/scan.sh --daily" : "Analyze today's server logs under ./logs and summarize anomalies"}
              className="font-mono text-sm min-h-[80px]"
              disabled={loading}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Runs in</label>
              <Select value={cwdMode} onValueChange={(v) => setCwdMode(v as "branch" | "directory")} disabled={loading}>
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="branch">Workspace (branch)</SelectItem>
                  <SelectItem value="directory">Directory</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              {cwdMode === "branch" ? (
                <>
                  <label className="text-sm font-medium">Branch</label>
                  <Select value={branch} onValueChange={setBranch} disabled={loading}>
                    <SelectTrigger size="sm">
                      <SelectValue placeholder="Select branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {worktrees.map((wt) => (
                        <SelectItem key={wt.branch ?? MAIN} value={wt.branch ?? MAIN}>
                          {wt.branch ?? "main"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <>
                  <label className="text-sm font-medium">Directory</label>
                  <Input value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="/var/log/myapp" className="font-mono" disabled={loading} />
                </>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Timeout (minutes)</label>
            <Input value={timeoutMinutes} onChange={(e) => setTimeoutMinutes(e.target.value)} className="w-24" disabled={loading} />
          </div>

          {error && <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={loading || !name.trim() || !content.trim()}>
            {loading ? "Saving..." : initial ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> Note: if `Worktree` is not exported from `@/lib/api`, use the inline type `{ branch: string | null }[]` for the `worktrees` prop instead — that is the only field used.

- [ ] **Step 2: Create the detail view**

Create `apps/vibedeckx-ui/components/schedule/schedules-view.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { Play, Pencil, Trash2, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, type Schedule, type ScheduleInput, type ScheduleRun, type Worktree } from "@/lib/api";
import { PageHeader } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScheduleFormDialog } from "./schedule-form-dialog";

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-500/15 text-blue-600",
  completed: "bg-emerald-500/15 text-emerald-600",
  failed: "bg-red-500/15 text-red-600",
  timeout: "bg-amber-500/15 text-amber-600",
  killed: "bg-amber-500/15 text-amber-600",
  skipped: "bg-muted text-muted-foreground",
};

// PTY output carries ANSI escapes and \r line endings; clean for <pre> display.
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function cleanOutput(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// SQLite timestamps are UTC "YYYY-MM-DD HH:MM:SS"; next_run_at is already ISO.
function parseTs(ts: string): Date {
  return new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
}
function fmtTs(ts: string | null | undefined): string {
  return ts ? parseTs(ts).toLocaleString() : "—";
}
function fmtDuration(run: ScheduleRun): string {
  if (!run.finished_at) return "…";
  const s = Math.max(0, Math.round((parseTs(run.finished_at).getTime() - parseTs(run.started_at).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function SchedulesView({
  schedules,
  loading,
  selectedId,
  onSelect,
  worktrees,
  onCreate,
  onUpdate,
  onDelete,
  onRunNow,
  createOpen,
  onCreateOpenChange,
}: {
  schedules: Schedule[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  worktrees: Worktree[];
  onCreate: (input: ScheduleInput) => Promise<Schedule>;
  onUpdate: (id: string, input: Partial<ScheduleInput>) => Promise<Schedule>;
  onDelete: (id: string) => Promise<void>;
  onRunNow: (id: string) => Promise<{ runId: string }>;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const selected = schedules.find((s) => s.id === selectedId) ?? schedules[0] ?? null;

  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [viewRun, setViewRun] = useState<ScheduleRun | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refetchRuns = useCallback(async (scheduleId: string) => {
    try {
      setRuns(await api.getScheduleRuns(scheduleId));
    } catch (err) {
      console.error("Failed to fetch schedule runs:", err);
    }
  }, []);

  // Refetch on selection change AND whenever the schedules array identity
  // changes (useSchedules refetches on schedule:* SSE events, so a finished
  // run refreshes this list too).
  useEffect(() => {
    if (selected?.id) void refetchRuns(selected.id);
    else setRuns([]);
  }, [selected?.id, schedules, refetchRuns]);

  const handleRunNow = async () => {
    if (!selected) return;
    setActionError(null);
    try {
      await onRunNow(selected.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start run");
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete scheduled task "${selected.name}" and its run history?`)) return;
    await onDelete(selected.id);
  };

  const openRun = async (run: ScheduleRun) => {
    if (run.status === "skipped") return;
    try {
      setViewRun(await api.getScheduleRun(run.id));
    } catch (err) {
      console.error("Failed to fetch run output:", err);
    }
  };

  if (!loading && schedules.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-center">
        <CalendarClock className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">No scheduled tasks yet</p>
        <Button size="sm" onClick={() => onCreateOpenChange(true)}>
          New Scheduled Task
        </Button>
        <ScheduleFormDialog open={createOpen} onOpenChange={onCreateOpenChange} onSubmit={async (input) => { await onCreate(input); }} worktrees={worktrees} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {selected && (
        <>
          <PageHeader
            title={selected.name}
            description={`${selected.cron_expr} · ${selected.timezone} · next: ${fmtTs(selected.next_run_at)}`}
            actions={
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleRunNow} disabled={!!selected.running}>
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  {selected.running ? "Running…" : "Run now"}
                </Button>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.enabled}
                    onChange={(e) => void onUpdate(selected.id, { enabled: e.target.checked })}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span>Enabled</span>
                </label>
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="outline" onClick={handleDelete} className="hover:bg-destructive/15 hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            }
          />

          <div className="px-5 py-3 grid grid-cols-2 gap-x-8 gap-y-1 text-sm border-b border-border/50">
            <div>
              <span className="text-muted-foreground">Type: </span>
              {selected.run_type === "command" ? "Command" : "Prompt (Claude)"}
            </div>
            <div>
              <span className="text-muted-foreground">Runs in: </span>
              {selected.cwd_mode === "branch" ? `workspace ${selected.branch ?? "main"}` : selected.directory}
            </div>
            <div className="col-span-2 font-mono text-xs text-muted-foreground truncate" title={selected.content}>
              {selected.content}
            </div>
            <div>
              <span className="text-muted-foreground">Timeout: </span>
              {Math.round(selected.timeout_seconds / 60)}m
            </div>
          </div>

          {actionError && <div className="mx-5 mt-3 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{actionError}</div>}

          <div className="flex-1 overflow-auto px-5 py-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Exit code</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id} onClick={() => void openRun(run)} className={cn(run.status !== "skipped" && "cursor-pointer")}>
                    <TableCell>{fmtTs(run.started_at)}</TableCell>
                    <TableCell>{run.status === "skipped" ? "—" : fmtDuration(run)}</TableCell>
                    <TableCell>
                      <span className={cn("px-1.5 py-0.5 rounded text-[11px] font-medium", STATUS_STYLES[run.status])}>{run.status}</span>
                    </TableCell>
                    <TableCell>{run.exit_code ?? "—"}</TableCell>
                  </TableRow>
                ))}
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      No runs yet — click “Run now” to try it
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <ScheduleFormDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            initial={selected}
            onSubmit={async (input) => {
              await onUpdate(selected.id, input);
            }}
            worktrees={worktrees}
          />
        </>
      )}

      <ScheduleFormDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        onSubmit={async (input) => {
          const created = await onCreate(input);
          onSelect(created.id);
        }}
        worktrees={worktrees}
      />

      <Dialog open={viewRun !== null} onOpenChange={(o) => !o && setViewRun(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Run output — {viewRun ? fmtTs(viewRun.started_at) : ""}{" "}
              {viewRun && <span className={cn("ml-2 px-1.5 py-0.5 rounded text-[11px] font-medium", STATUS_STYLES[viewRun.status])}>{viewRun.status}</span>}
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap">
            {viewRun?.output ? cleanOutput(viewRun.output) : "(no output captured)"}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 3: Create the barrel**

Create `apps/vibedeckx-ui/components/schedule/index.ts`:

```ts
export { SchedulesView } from "./schedules-view";
export { ScheduleFormDialog } from "./schedule-form-dialog";
```

- [ ] **Step 4: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: exits 0, no errors. (If `SelectTrigger` doesn't accept `size="sm"`, drop the prop — check how `create-worktree-dialog.tsx` calls it and match.)

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/schedule/
git commit -m "feat: schedule form dialog and detail view with run history"
```

---

### Task 6: Sidebar SCHEDULE section + page wiring + end-to-end verification

**Files:**
- Modify: `apps/vibedeckx-ui/components/layout/app-sidebar.tsx` (`ActiveView` line 10, `AppSidebarProps` ~lines 12-26, new section between the Navigation section ~line 220 and the Workspace section ~line 222, new `ScheduleDot` helper)
- Modify: `apps/vibedeckx-ui/app/page.tsx` (hook + state near `useTasks` ~line 125, sidebar props ~line 439, view render after the project-info block ~line 577)

**Interfaces:**
- Consumes: `useSchedules` (Task 4), `SchedulesView` (Task 5), `Schedule` from `@/lib/api`.
- Produces: `ActiveView` gains `"schedules"`; `AppSidebarProps` gains `schedules?: Schedule[]`, `selectedScheduleId?: string | null`, `onScheduleSelect?: (id: string) => void`, `onCreateScheduleOpen?: () => void`.

- [ ] **Step 1: Extend `ActiveView` and `AppSidebarProps`**

In `apps/vibedeckx-ui/components/layout/app-sidebar.tsx`:

Change line 10 to:

```tsx
export type ActiveView = "workspace" | "tasks" | "schedules" | "remote-servers" | "settings" | "project-info";
```

Add the import:

```tsx
import type { Schedule } from "@/lib/api";
```

Add to the `AppSidebarProps` interface:

```tsx
  schedules?: Schedule[];
  selectedScheduleId?: string | null;
  onScheduleSelect?: (id: string) => void;
  onCreateScheduleOpen?: () => void;
```

and destructure the four new props in the component signature alongside the existing ones.

- [ ] **Step 2: Add the `ScheduleDot` helper**

In the same file, after the existing `StatusDot` component (~line 62), add:

```tsx
// Last-run status for a scheduled task; blue pulse while a run is active
// (same visual language as StatusDot, plus red for failures).
function ScheduleDot({ schedule }: { schedule: Schedule }) {
  const base = "relative h-[7px] w-[7px] rounded-full shrink-0";
  if (schedule.running) {
    return (
      <span className={cn(base, "bg-blue-500")}>
        <span
          className="absolute inset-[-2px] rounded-full bg-blue-500"
          style={{ animation: "status-dot-pulse 1.6s ease-out infinite", opacity: 0.5 }}
        />
      </span>
    );
  }
  const last = schedule.last_run;
  if (!last || last.status === "skipped") {
    return <span className={cn(base, "bg-muted-foreground/40")} />;
  }
  if (last.status === "completed") {
    return <span className={cn(base, "bg-emerald-500")} />;
  }
  if (last.status === "failed" || last.status === "timeout" || last.status === "killed") {
    return <span className={cn(base, "bg-red-500")} />;
  }
  return <span className={cn(base, "bg-blue-500")} />;
}
```

- [ ] **Step 3: Add the SCHEDULE section**

In the same file, between the Navigation section's closing `</SidebarSection>` (~line 220) and the `{/* Workspace Section — branches as mono tree */}` comment (~line 222), add:

```tsx
      {/* Schedule Section — cron tasks for the current project */}
      <SidebarSection>
        <SectionLabel
          action={
            currentProject ? (
              <button
                onClick={onCreateScheduleOpen}
                className="p-0.5 rounded hover:bg-muted hover:text-foreground transition-colors text-muted-foreground"
                title="Create scheduled task"
              >
                <Plus className="h-3 w-3" />
              </button>
            ) : undefined
          }
        >
          Schedule
        </SectionLabel>
        {currentProject && schedules && schedules.length > 0 && (
          <div className="flex flex-col gap-px">
            {schedules.map((s) => {
              const isActive = activeView === "schedules" && selectedScheduleId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => onScheduleSelect?.(s.id)}
                  className={cn(
                    "w-full min-w-0 flex items-center gap-2 rounded-[5px] px-2 py-1 text-[11.5px] transition-colors overflow-hidden",
                    !isActive && "text-foreground/80 hover:bg-muted",
                    isActive && "bg-accent text-accent-foreground font-medium",
                    !s.enabled && "opacity-50"
                  )}
                >
                  <ScheduleDot schedule={s} />
                  <span className="truncate text-left">{s.name}</span>
                </button>
              );
            })}
          </div>
        )}
        {currentProject && schedules && schedules.length === 0 && (
          <span className="block px-2 mt-1 text-[11.5px] text-muted-foreground/60">No scheduled tasks</span>
        )}
      </SidebarSection>
```

- [ ] **Step 4: Wire `app/page.tsx`**

In `apps/vibedeckx-ui/app/page.tsx`:

Add imports:

```tsx
import { useSchedules } from "@/hooks/use-schedules";
import { SchedulesView } from "@/components/schedule";
```

Near the `useTasks` call (~line 125), add:

```tsx
  const {
    schedules,
    loading: schedulesLoading,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    runNow: runScheduleNow,
  } = useSchedules(currentProject?.id ?? null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [scheduleCreateOpen, setScheduleCreateOpen] = useState(false);
```

In the `<AppSidebar ... />` props (~line 439), add:

```tsx
        schedules={schedules}
        selectedScheduleId={selectedScheduleId}
        onScheduleSelect={(id) => {
          setSelectedScheduleId(id);
          setActiveView("schedules");
        }}
        onCreateScheduleOpen={() => {
          setActiveView("schedules");
          setScheduleCreateOpen(true);
        }}
```

After the project-info view block (~line 577), add a mount-when-active view (same pattern as project-info):

```tsx
      {activeView === 'schedules' && !needsProject && currentProject && (
        <div className="flex-1 overflow-hidden">
          <SchedulesView
            schedules={schedules}
            loading={schedulesLoading}
            selectedId={selectedScheduleId}
            onSelect={setSelectedScheduleId}
            worktrees={worktrees}
            onCreate={createSchedule}
            onUpdate={updateSchedule}
            onDelete={async (id) => {
              await deleteSchedule(id);
              if (selectedScheduleId === id) setSelectedScheduleId(null);
            }}
            onRunNow={runScheduleNow}
            createOpen={scheduleCreateOpen}
            onCreateOpenChange={setScheduleCreateOpen}
          />
        </div>
      )}
```

Also run `grep -n "urlTab" apps/vibedeckx-ui/app/page.tsx`: if the initial-tab URL param is validated against an explicit list of view names, add `"schedules"` to that list; if it just casts the param, no change is needed.

- [ ] **Step 5: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: exits 0, no errors.

- [ ] **Step 6: End-to-end manual verification (UI)**

Run `pnpm dev:all`, open http://localhost:3000, select (or create) a project with a local path, then verify:

1. Sidebar shows a **SCHEDULE** section with "No scheduled tasks" and a `+` button.
2. Click `+` → dialog opens pre-filled with your local timezone. Create: name "hello", cron `* * * * *`, type Command, content `echo scheduled-hello; date`, Runs in → Directory `/tmp`. The task appears in the sidebar with a grey dot and the detail view shows the next-run time.
3. Click **Run now** → sidebar dot pulses blue, then turns green; a `completed` run appears in the history (duration + exit code 0) without a manual refresh (SSE-driven).
4. Click the run row → output dialog shows `scheduled-hello` and the date.
5. Wait ~1 minute → a second run appears on its own (cron firing).
6. Uncheck **Enabled** → sidebar entry dims and the header shows "next: —". Re-enable → the next-run time returns.
7. (Timeout check) Edit → content `sleep 120`, timeout 1 minute → Run now → after ~60s the run ends as `timeout`.
8. Create a second schedule with type **Prompt** and content like "总结当前目录有哪些文件" → Run now → output dialog shows readable Claude output (requires the `claude` binary or npx fallback).
9. Delete the task → confirm dialog → it disappears from the sidebar and the view shows the empty state.
10. Restart the backend while a run is in flight → after restart the run row shows `killed` (startup fixup).

- [ ] **Step 7: Lint the frontend**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: no new errors in the touched/created files.

- [ ] **Step 8: Commit**

```bash
git add apps/vibedeckx-ui/components/layout/app-sidebar.tsx apps/vibedeckx-ui/app/page.tsx
git commit -m "feat: SCHEDULE sidebar section and schedules view wiring"
```

---

## Deferred (explicitly out of scope for V1)

- Live streaming of an in-flight run's output (reuse `useExecutorLogs(processId)` + `ExecutorOutput` — `process_id` is already persisted on the run row for this).
- Queue-after-current overlap policy (current: skip + record).
- Remote-server execution of schedules (V1 is local-only).
- Notifications (bell) on failed runs.
- xterm-based colored output rendering (V1 strips ANSI into a `<pre>`).

## Self-Review

**Spec coverage:**
- Sidebar SCHEDULE section listing the project's tasks with status dot + `+` create → Task 6 Steps 1-3. ✓
- Click a task → detail with config + run history → Task 5 Step 2 + Task 6 Step 4. ✓
- Task defines: command or prompt (claude headless) → `run_type`/`content` (Tasks 1-3, form in Task 5). ✓
- Runs in a workspace (branch worktree) or a fixed persistent directory → `cwd_mode`/`branch`/`directory`, resolved via `resolveWorktreePath` or absolute dir (Task 2 `executeRun`). ✓
- Cron schedule with timezone, daily-at-fixed-time capable → croner job per enabled schedule (Task 2), validated in routes (Task 3). ✓
- Produces persisted run results (status, exit code, output) → `scheduled_task_runs` + capture via `processManager.subscribe` (Tasks 1-2), output viewer (Task 5). ✓
- Run now → `runNow` + route + button (Tasks 2, 3, 5). ✓
- Enable/disable → `enabled` + `reschedule` + checkbox (Tasks 1, 3, 5). ✓
- No permission-mode field; prompt runs inherit `--dangerously-skip-permissions` (agreed decision) → Global Constraints. ✓
- Timeout guard (default 30 min) → Tasks 1, 2, form field in Task 5. ✓
- Overlap = skip + record → Task 2. ✓
- Live sidebar/status updates → EventBus events (Task 2) + SSE refetch in `useSchedules` (Task 4). ✓

**Type consistency:** `ScheduledTask`/`ScheduledTaskRun` (backend) and `Schedule`/`ScheduleRun` (frontend wire types) carry identical snake_case fields; enriched list fields `last_run`/`next_run_at`/`running` are produced in Task 3's GET-list, declared optional on Task 4's `Schedule`, and consumed by Task 6's `ScheduleDot`. `RunNowResult` produced in Task 2 matches Task 3's `"error" in result` / `result.skipped` handling. Storage method names (`getByScheduleId`, `getLastByScheduleIds`, `finish`, `prune`) are identical across Task 1's interface, Task 2's scheduler, and Task 3's routes. `useSchedules` return names (`runNow`, `createSchedule`, …) match Task 6's destructuring.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Three conditional instructions (Task 5 `Worktree` fallback type, Task 5 `SelectTrigger size` note, Task 6 `urlTab` check) each give the exact check and both outcomes.





