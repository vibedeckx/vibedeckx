# Storage Async + Kysely Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `Storage` interface fully async and rewrite the sqlite backend's query layer on Kysely, with zero behavior change, so a Postgres backend can later share the same query code.

**Architecture:** Phase 1 flips the interface to `Promise` and converts all ~40 caller files (implementation stays better-sqlite3 with `async` wrappers). Phase 2 audits read-then-write races exposed by new yield points. Phase 3 introduces Kysely (schema types + dialect helpers) wrapping the *same* better-sqlite3 handle; the legacy DDL/migration code is kept verbatim. Phases 4–8 port the 17 repositories group-by-group onto Kysely, each group individually verified. Phase 9 smoke-tests against a real pre-existing database.

**Tech Stack:** TypeScript (ESM, NodeNext — all local imports need `.js` extensions), better-sqlite3 (kept), Kysely (new, pure JS), vitest.

**Spec:** `docs/superpowers/specs/2026-07-05-storage-async-kysely-design.md`

## Global Constraints

- Zero behavior change for sqlite users. The existing `sqlite.ts` code is the authoritative behavior spec for every ported method — preserve semantics exactly (ordering, tiebreaks, defaults, null handling, JSON parsing).
- The legacy DDL/migration block (`createDatabase()`, `sqlite.ts:9-699`) is **kept verbatim** on the raw better-sqlite3 handle. Never rewrite it.
- Backend type check: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` (run from repo root).
- Tests: `pnpm --filter vibedeckx test` (vitest).
- Commit style: conventional commits (`refactor:`, `feat:`, `test:`).
- Only new dependency allowed: `kysely`.
- Entity types in `storage/types.ts` (`Project`, `Executor`, …) must not change shape — callers receive identical objects.

---

### Task 1: Asyncify the Storage interface, implementation, and all callers

One atomic commit: the interface flip breaks every caller until all are converted, so this task ends with the only commit.

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts` (Storage interface, lines 231-451)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (add `async` to every repo method)
- Modify: all caller files listed in Step 3 (~40 files)
- Modify: `packages/vibedeckx/src/storage/scheduled-tasks.test.ts`, `packages/vibedeckx/src/scheduler.test.ts`

**Interfaces:**
- Produces: `Storage` interface where **every** method returns `Promise<T>` (same params, same `T` as today). `close: () => Promise<void>`.

- [ ] **Step 1: Flip `storage/types.ts` to async**

Mechanically wrap every method return type in `Promise<>`. Examples of the pattern (apply to all ~100 methods):

```ts
// before
getById: (id: string, userId?: string) => Project | undefined;
delete: (id: string, userId?: string) => void;
// after
getById: (id: string, userId?: string) => Promise<Project | undefined>;
delete: (id: string, userId?: string) => Promise<void>;
```

Including `close: () => Promise<void>`.

- [ ] **Step 2: Add `async` to every method in `sqlite.ts`**

No logic changes — only the keyword, e.g. `create: async ({ id, name, ... }, userId?: string) => {`. The sync better-sqlite3 calls inside are unchanged; each method now returns a resolved promise. `close: async () => { db.close(); }`.

- [ ] **Step 3: Run tsc to enumerate broken callers**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: FAIL with errors **only** in caller files (storage/ itself clean). This is the authoritative work list. Known callers:

```
agent-session-manager.ts  branch-activity.ts  chat-session-manager.ts  command.ts
plugins/shared-services.ts  process-manager.ts  remote-agent-sessions.ts
remote-executor-monitor.ts  reverse-connect-client.ts  scheduler.ts  server.ts
utils/chat-model.ts  routes/: agent-session, branch-activity, browser-proxy, browser,
chat-session, command, diff, event, executor-group, executor, executor-stream-handlers,
file, process, project-remote, project, remote, remote-server, reverse-connect, rule,
schedule, settings, task, terminal, translate, worktree, ws-authz
```

- [ ] **Step 4: Convert callers — apply these recipes, file by file, until tsc is clean**

Recipes (in priority order):

1. **Plain call in async function** (most route handlers are already `async`): add `await`.
2. **Sync function containing storage calls**: make it `async`, then `await` **its** callers too (the ripple is the point — follow tsc).
3. **`array.map(x => storage...)`**: `await Promise.all(items.map(x => storage...))` when independent; `for (const x of items)` with `await` when order matters or writes depend on prior reads.
4. **`array.filter(x => storage...)` / `.find(...)` with a now-async predicate**: an async predicate returns a truthy Promise — **silently wrong, not a type error in all cases**. Rewrite as an explicit loop:
   ```ts
   const kept = [];
   for (const x of items) if (await storage.foo.getById(x.id)) kept.push(x);
   ```
   After converting each file, grep it for `.filter(` / `.find(` / `.some(` / `.every(` around storage calls to catch these.
5. **Event/WS/child-process callbacks** (`ws.on("message", ...)`, `proc.on("exit", ...)`, timers): make the callback `async` and ensure rejections can't escape — wrap the body in `try/catch` with the file's existing logger, or append `.catch(err => log.error(...))` if refactoring the body is riskier.
6. **Constructors or property initializers calling storage**: move the storage work into an `async init()`/static factory called right after construction, or defer to first use. Flag each such restructure in the commit message body.
7. **Getters returning storage values**: convert to an async method (`getFoo(): Promise<...>`), update call sites.

- [ ] **Step 5: Convert the two test files**

`storage/scheduled-tasks.test.ts` and `scheduler.test.ts`: add `await` to every storage call; `afterEach` becomes `async () => { await storage.close(); ... }`. Assertions like `expect(storage.scheduledTasks.getByProjectId(projectId)).toHaveLength(1)` become `expect(await storage.scheduledTasks.getByProjectId(projectId)).toHaveLength(1)`.

- [ ] **Step 6: Verify tsc clean**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS (no output).

- [ ] **Step 7: Verify tests pass**

Run: `pnpm --filter vibedeckx test`
Expected: PASS (both test files).

- [ ] **Step 8: Verify frontend unaffected**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS — the frontend talks over HTTP, no storage import; this guards against accidental cross-package edits.

- [ ] **Step 9: Commit**

```bash
git add -A packages/vibedeckx
git commit -m "refactor: make Storage interface async across all callers

Implementation stays better-sqlite3 (sync under async wrappers); zero
behavior change. Prep for a future Postgres backend.
List any constructor/getter restructures from Step 4 recipe 6/7 here."
```

---

### Task 2: Race audit — cross-call read-then-write sequences

Asyncification turned every `await` into a yield point; under the future multi-user pg backend, caller-side read-then-write sequences are real races. Find them, push real ones down into single storage methods (internally atomic), document the rest.

**Files:**
- Modify: caller files where sequences get pushed down; `storage/types.ts` + `storage/sqlite.ts` for any new methods
- Create: `docs/superpowers/plans/2026-07-05-storage-race-audit-notes.md`

**Interfaces:**
- Produces: possibly new `Storage` methods (each documented in the notes file with before/after call-site).

- [ ] **Step 1: Enumerate candidates**

For each of the 40 caller files, list every place with ≥2 storage calls where a later **write** depends on an earlier **read** of the same table(s). Grep starting points (not exhaustive — read surrounding code):

```bash
grep -rn "getByBranch\|getByPath\|getById\|getByWorkspace" packages/vibedeckx/src --include="*.ts" -A6 | grep -B3 "\.create\|\.update\|\.delete\|\.reorder"
```

Known suspects to check explicitly: executor-group ensure-exists (getByBranch → create), project create-if-missing (getByPath → create), settings read-modify-write in `utils/chat-model.ts` and `settings-routes.ts`, position assignment on create for executors/tasks/rules/commands (verify whether MAX(position)+1 already lives inside the storage method — if yes, it's safe).

- [ ] **Step 2: Classify each candidate**

- **Safe**: reads and writes touch different rows/tables, or last-write-wins is acceptable semantics → document as safe, no change.
- **Real race**: interleaving produces duplicate rows, lost updates, or constraint violations under concurrency → push down.

- [ ] **Step 3: Push down real races**

Pattern: add a storage method that performs the whole sequence; sqlite impl may use `db.transaction(() => {...})()` (better-sqlite3 sync txn) or an upsert. Example shape for check-then-create:

```ts
// types.ts
getOrCreateByBranch: (opts: { id: string; project_id: string; name: string; branch: string }) => Promise<ExecutorGroup>;
// sqlite.ts — INSERT OR IGNORE + re-read is atomic per statement
getOrCreateByBranch: async (opts) => {
  db.prepare(`INSERT OR IGNORE INTO executor_groups (id, project_id, name, branch) VALUES (@id, @project_id, @name, @branch)`).run(opts);
  const row = db.prepare(`SELECT * FROM executor_groups WHERE project_id = @project_id AND branch = @branch`).get(opts)!;
  return row as ExecutorGroup;
},
```

(`INSERT OR IGNORE` is sqlite-flavored; when this method reaches the Kysely port in Task 6 it becomes `.onConflict(oc => oc.columns(["project_id","branch"]).doNothing())` — portable to pg.)

- [ ] **Step 4: Write the notes file**

`docs/superpowers/plans/2026-07-05-storage-race-audit-notes.md`: table of every candidate — location, classification, action taken. This is the delivery artifact promised in the spec.

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: both PASS.

```bash
git add -A
git commit -m "refactor: push cross-call read-then-write sequences into atomic storage methods

See docs/superpowers/plans/2026-07-05-storage-race-audit-notes.md"
```

---

### Task 3: Add Kysely — schema types, dialect helpers, wiring

Kysely wraps the same better-sqlite3 handle; no queries use it yet. Legacy DDL keeps running first.

**Files:**
- Modify: `packages/vibedeckx/package.json` (add `kysely` dependency)
- Create: `packages/vibedeckx/src/storage/schema.ts`
- Create: `packages/vibedeckx/src/storage/dialect.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (wrap db in Kysely, thread `kdb`/`helpers` down)

**Interfaces:**
- Produces: `DB` (Kysely database type, 17 tables), `DbBool` type alias, `DialectHelpers` interface, `fromDbBool()`, `sqliteHelpers`. `createSqliteStorage` signature unchanged.

- [ ] **Step 1: Add dependency**

Run: `pnpm --filter vibedeckx add kysely`
Expected: `kysely` in `packages/vibedeckx/package.json` dependencies (pure JS, no postinstall).

- [ ] **Step 2: Create `storage/schema.ts`**

Table types mirror the CREATE TABLE statements in `sqlite.ts:14-186, 435-443, 650-683` exactly. Booleans are `DbBool` (sqlite stores 0/1; pg will store native booleans). Timestamps/JSON are `string` (pg backend will configure its driver to return strings — noted for that phase).

```ts
import type { ColumnType, Generated } from "kysely";

/** Boolean column: 0/1 under sqlite, native boolean under pg. Always read via fromDbBool(), write via DialectHelpers.toDbBool(). */
export type DbBool = ColumnType<number | boolean, number | boolean, number | boolean>;

export interface ProjectsTable {
  id: string;
  name: string;
  path: string | null;
  remote_path: string | null;
  is_remote: DbBool;
  remote_url: string | null;
  remote_api_key: string | null;
  remote_project_id: string | null;
  user_id: Generated<string>;
  agent_mode: string | null;
  executor_mode: string | null;
  sync_up_config: string | null;   // JSON: SyncButtonConfig
  sync_down_config: string | null; // JSON: SyncButtonConfig
  created_at: Generated<string>;
}

export interface ExecutorGroupsTable {
  id: string;
  project_id: string;
  name: string;
  branch: Generated<string>;
  created_at: Generated<string>;
}

export interface ExecutorsTable {
  id: string;
  project_id: string;
  group_id: string | null;
  name: string;
  command: string;
  executor_type: Generated<string>;
  prompt_provider: string | null;
  cwd: string | null;
  pty: Generated<DbBool>;
  position: Generated<number>;
  disabled_targets: Generated<string>; // JSON: string[]
  created_at: Generated<string>;
}

export interface ExecutorProcessesTable {
  id: string;
  executor_id: string;
  pid: number | null;
  status: Generated<string>;
  exit_code: number | null;
  started_at: Generated<string>;
  finished_at: string | null;
}

export interface RemoteExecutorProcessesTable {
  local_process_id: string;
  remote_server_id: string;
  remote_url: string;
  remote_api_key: string;
  remote_process_id: string;
  executor_id: string;
  project_id: string | null;
  branch: string | null;
  started_at: Generated<string>;
  status: Generated<string>;
  exit_code: number | null;
  finished_at: string | null;
  machine_id: string | null;
}

export interface MachineIdentityTable {
  machine_id: string;
  public_key: string;
  user_id: Generated<string>;
  created_at: Generated<string>;
  last_seen_at: string | null;
}

export interface AgentSessionsTable {
  id: string;
  project_id: string;
  branch: Generated<string>;
  status: Generated<string>;
  permission_mode: string | null;
  agent_type: string | null;
  title: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  last_user_message_at: number | null;
  last_completed_at: number | null;
  favorited_at: number | null;
}

export interface AgentSessionEntriesTable {
  session_id: string;
  entry_index: number;
  data: string;
}

export interface TasksTable {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: Generated<string>;
  priority: Generated<string>;
  assigned_branch: string | null;
  position: Generated<number>;
  archived_at: number | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface RulesTable {
  id: string;
  project_id: string;
  branch: string | null;
  name: string;
  content: string;
  enabled: Generated<DbBool>;
  position: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface CommandsTable {
  id: string;
  project_id: string;
  branch: string | null;
  name: string;
  content: string;
  position: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface GlobalSettingsTable {
  key: string;
  value: string;
}

export interface RemoteServersTable {
  id: string;
  name: string;
  url: string | null;
  api_key: string | null;
  connection_mode: Generated<string>;
  connect_token: string | null;
  connect_token_created_at: string | null;
  status: Generated<string>;
  last_connected_at: string | null;
  user_id: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ProjectRemotesTable {
  id: string;
  project_id: string;
  remote_server_id: string;
  remote_path: string;
  sort_order: Generated<number>;
  sync_up_config: string | null;   // JSON: SyncButtonConfig
  sync_down_config: string | null; // JSON: SyncButtonConfig
}

export interface RemoteSessionMappingsTable {
  local_session_id: string;
  project_id: string;
  remote_server_id: string;
  remote_session_id: string;
  branch: string | null;
  title_resolved: Generated<DbBool>;
}

export interface ScheduledTasksTable {
  id: string;
  project_id: string;
  name: string;
  cron_expr: string;
  timezone: string;
  target: Generated<string>;
  enabled: Generated<DbBool>;
  run_type: Generated<string>;
  content: string;
  cwd_mode: Generated<string>;
  branch: string | null;
  directory: string | null;
  timeout_seconds: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ScheduledTaskRunsTable {
  id: string;
  schedule_id: string;
  status: Generated<string>;
  exit_code: number | null;
  output: string | null;
  process_id: string | null;
  started_at: Generated<string>;
  finished_at: string | null;
}

export interface DB {
  projects: ProjectsTable;
  executor_groups: ExecutorGroupsTable;
  executors: ExecutorsTable;
  executor_processes: ExecutorProcessesTable;
  remote_executor_processes: RemoteExecutorProcessesTable;
  machine_identity: MachineIdentityTable;
  agent_sessions: AgentSessionsTable;
  agent_session_entries: AgentSessionEntriesTable;
  tasks: TasksTable;
  rules: RulesTable;
  commands: CommandsTable;
  global_settings: GlobalSettingsTable;
  remote_servers: RemoteServersTable;
  project_remotes: ProjectRemotesTable;
  remote_session_mappings: RemoteSessionMappingsTable;
  scheduled_tasks: ScheduledTasksTable;
  scheduled_task_runs: ScheduledTaskRunsTable;
}
```

- [ ] **Step 3: Create `storage/dialect.ts`**

```ts
import { sql, type RawBuilder } from "kysely";

/**
 * Dialect-specific value/SQL adapters injected into the repositories.
 * The repositories never know which backend they run on; everything
 * dialect-flavored lives here. A future postgres.ts provides its own.
 */
export interface DialectHelpers {
  /** Boolean → storage representation (sqlite: 0/1; pg: native). */
  toDbBool(b: boolean): number | boolean;
  /** Millisecond-precision "now" for agent_sessions timestamps (lex-sortable). */
  nowMs(): RawBuilder<string>;
  /**
   * Recency tiebreaker for same-timestamp rows.
   * DIALECT: sqlite rowid; the pg backend will need a monotonic column —
   * grep for rowIdDesc when building it.
   */
  rowIdDesc(): RawBuilder<unknown>;
}

/** Storage → JS boolean, valid for both 0/1 and native booleans. */
export const fromDbBool = (v: number | boolean | null | undefined): boolean => v === 1 || v === true;

export const sqliteHelpers: DialectHelpers = {
  toDbBool: (b) => (b ? 1 : 0),
  nowMs: () => sql<string>`strftime('%Y-%m-%d %H:%M:%f', 'now')`,
  rowIdDesc: () => sql`rowid desc`,
};
```

- [ ] **Step 4: Wire Kysely into `sqlite.ts`**

At the top of `createSqliteStorage` (after `createDatabase(dbPath)` has run all legacy DDL):

```ts
import { Kysely, SqliteDialect } from "kysely";
import type { DB } from "./schema.js";
import { sqliteHelpers } from "./dialect.js";

export const createSqliteStorage = async (dbPath: string): Promise<Storage> => {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = createDatabase(dbPath);            // legacy DDL/migrations, kept verbatim
  const kdb = new Kysely<DB>({ dialect: new SqliteDialect({ database: db }) });
  const h = sqliteHelpers;
  // ... existing repository object, unchanged for now
```

And change `close` to destroy through Kysely (it closes the wrapped db):

```ts
close: async () => { await kdb.destroy(); },
```

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: both PASS (kdb is wired but unused by queries; tests prove close() still works).

```bash
git add -A packages/vibedeckx docs
git commit -m "feat: add Kysely schema types and dialect helpers, wire into sqlite storage"
```

---

### Task 4: Port scheduledTasks + scheduledTaskRuns to Kysely (template group)

The group with direct test coverage goes first and establishes the repository-file pattern all later tasks copy.

**Files:**
- Create: `packages/vibedeckx/src/storage/repositories/scheduled.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (delete inline scheduledTasks/scheduledTaskRuns blocks at lines ~1462-1570 + their row mappers, use the factory)
- Test: `packages/vibedeckx/src/storage/scheduled-tasks.test.ts` (existing, must stay green — do not modify)

**Interfaces:**
- Consumes: `Kysely<DB>`, `DialectHelpers`, `fromDbBool` (Task 3).
- Produces: `createScheduledRepos(kdb: Kysely<DB>, h: DialectHelpers): Pick<Storage, "scheduledTasks" | "scheduledTaskRuns">` — the factory-per-group pattern.

- [ ] **Step 1: Run the existing tests as the red/green baseline**

Run: `pnpm --filter vibedeckx test -- scheduled-tasks`
Expected: PASS (pre-port baseline).

- [ ] **Step 2: Create `storage/repositories/scheduled.ts`**

Full port — semantics copied from `sqlite.ts:1462-1570`:

```ts
import { sql, type Kysely } from "kysely";
import type { DB, ScheduledTasksTable, ScheduledTaskRunsTable } from "../schema.js";
import { fromDbBool, type DialectHelpers } from "../dialect.js";
import type { Storage, ScheduledTask, ScheduledTaskRun, ScheduledTaskRunType, ScheduledTaskCwdMode, ScheduledTaskRunStatus } from "../types.js";
import type { Selectable } from "kysely";

const mapTask = (row: Selectable<ScheduledTasksTable>): ScheduledTask => ({
  ...row,
  enabled: fromDbBool(row.enabled),
  run_type: row.run_type as ScheduledTaskRunType,
  cwd_mode: row.cwd_mode as ScheduledTaskCwdMode,
});

const mapRun = (row: Selectable<ScheduledTaskRunsTable>): ScheduledTaskRun => ({
  ...row,
  status: row.status as ScheduledTaskRunStatus,
});

export const createScheduledRepos = (
  kdb: Kysely<DB>,
  h: DialectHelpers,
): Pick<Storage, "scheduledTasks" | "scheduledTaskRuns"> => ({
  scheduledTasks: {
    create: async (opts) => {
      await kdb.insertInto("scheduled_tasks").values({
        id: opts.id,
        project_id: opts.project_id,
        name: opts.name,
        cron_expr: opts.cron_expr,
        timezone: opts.timezone,
        target: opts.target ?? "local",
        enabled: h.toDbBool(opts.enabled !== false),
        run_type: opts.run_type,
        content: opts.content,
        cwd_mode: opts.cwd_mode,
        branch: opts.branch ?? null,
        directory: opts.directory ?? null,
        timeout_seconds: opts.timeout_seconds ?? 1800,
      }).execute();
      const row = await kdb.selectFrom("scheduled_tasks").selectAll().where("id", "=", opts.id).executeTakeFirstOrThrow();
      return mapTask(row);
    },
    getByProjectId: async (projectId) => {
      const rows = await kdb.selectFrom("scheduled_tasks").selectAll()
        .where("project_id", "=", projectId)
        .orderBy("created_at", "asc").orderBy("id", "asc")
        .execute();
      return rows.map(mapTask);
    },
    getById: async (id) => {
      const row = await kdb.selectFrom("scheduled_tasks").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapTask(row) : undefined;
    },
    getAllEnabled: async () => {
      const rows = await kdb.selectFrom("scheduled_tasks").selectAll()
        .where("enabled", "=", h.toDbBool(true)).execute();
      return rows.map(mapTask);
    },
    update: async (id, opts) => {
      const sets: Record<string, unknown> = {};
      if (opts.name !== undefined) sets.name = opts.name;
      if (opts.cron_expr !== undefined) sets.cron_expr = opts.cron_expr;
      if (opts.timezone !== undefined) sets.timezone = opts.timezone;
      if (opts.target !== undefined) sets.target = opts.target;
      if (opts.enabled !== undefined) sets.enabled = h.toDbBool(opts.enabled);
      if (opts.run_type !== undefined) sets.run_type = opts.run_type;
      if (opts.content !== undefined) sets.content = opts.content;
      if (opts.cwd_mode !== undefined) sets.cwd_mode = opts.cwd_mode;
      if (opts.branch !== undefined) sets.branch = opts.branch;
      if (opts.directory !== undefined) sets.directory = opts.directory;
      if (opts.timeout_seconds !== undefined) sets.timeout_seconds = opts.timeout_seconds;
      if (Object.keys(sets).length > 0) {
        sets.updated_at = sql`CURRENT_TIMESTAMP`;
        await kdb.updateTable("scheduled_tasks").set(sets).where("id", "=", id).execute();
      }
      const row = await kdb.selectFrom("scheduled_tasks").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapTask(row) : undefined;
    },
    delete: async (id) => {
      await kdb.deleteFrom("scheduled_tasks").where("id", "=", id).execute();
    },
  },
  scheduledTaskRuns: {
    create: async ({ id, schedule_id, status, process_id }) => {
      const st = status ?? "running";
      await kdb.insertInto("scheduled_task_runs").values({
        id, schedule_id, status: st,
        process_id: process_id ?? null,
        finished_at: st === "running" ? null : sql<string>`CURRENT_TIMESTAMP`,
      }).execute();
      const row = await kdb.selectFrom("scheduled_task_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapRun(row);
    },
    getById: async (id) => {
      const row = await kdb.selectFrom("scheduled_task_runs").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapRun(row) : undefined;
    },
    getByScheduleId: async (scheduleId, limit = 50) => {
      const rows = await kdb.selectFrom("scheduled_task_runs")
        .select(["id", "schedule_id", "status", "exit_code", sql<string | null>`NULL`.as("output"), "process_id", "started_at", "finished_at"])
        .where("schedule_id", "=", scheduleId)
        .orderBy("started_at", "desc").orderBy(h.rowIdDesc())
        .limit(limit).execute();
      return rows.map(mapRun);
    },
    getLastByScheduleIds: async (scheduleIds) => {
      const result: Record<string, ScheduledTaskRun> = {};
      for (const sid of scheduleIds) {
        const row = await kdb.selectFrom("scheduled_task_runs")
          .select(["id", "schedule_id", "status", "exit_code", sql<string | null>`NULL`.as("output"), "process_id", "started_at", "finished_at"])
          .where("schedule_id", "=", sid)
          .orderBy("started_at", "desc").orderBy(h.rowIdDesc())
          .limit(1).executeTakeFirst();
        if (row) result[sid] = mapRun(row);
      }
      return result;
    },
    finish: async (id, opts) => {
      await kdb.updateTable("scheduled_task_runs").set({
        status: opts.status,
        exit_code: opts.exit_code ?? null,
        output: opts.output ?? null,
        finished_at: sql<string>`CURRENT_TIMESTAMP`,
      }).where("id", "=", id).execute();
    },
    prune: async (scheduleId, keep) => {
      // Never delete a 'running' row — see original comment at sqlite.ts:1558.
      await kdb.deleteFrom("scheduled_task_runs")
        .where("schedule_id", "=", scheduleId)
        .where("status", "!=", "running")
        .where("id", "not in", kdb.selectFrom("scheduled_task_runs").select("id")
          .where("schedule_id", "=", scheduleId)
          .orderBy("started_at", "desc").orderBy(h.rowIdDesc())
          .limit(keep))
        .execute();
    },
  },
});
```

Note: if `orderBy(h.rowIdDesc())` doesn't type-check against the installed Kysely version, use `orderBy(sql`rowid`, "desc")` inline with a `// DIALECT:` comment instead — keep the marker greppable.

- [ ] **Step 3: Use the factory in `sqlite.ts`**

Delete the inline `scheduledTasks:`/`scheduledTaskRuns:` blocks and `mapScheduledTaskRow`/`mapScheduledTaskRunRow` + their Row types; spread the factory:

```ts
import { createScheduledRepos } from "./repositories/scheduled.js";
// inside the returned object:
...createScheduledRepos(kdb, h),
```

- [ ] **Step 4: Verify green**

Run: `pnpm --filter vibedeckx test && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS — the scheduled-tasks suite (including rowid-tiebreak prune tests) proves the port byte-equivalent.

- [ ] **Step 5: Commit**

```bash
git add -A packages/vibedeckx
git commit -m "refactor: port scheduledTasks/scheduledTaskRuns storage to Kysely"
```

---

### Task 5: Port projects, settings, remoteServers, projectRemotes, machineIdentity

**Files:**
- Create: `packages/vibedeckx/src/storage/repositories/core.ts` (projects + settings) and `packages/vibedeckx/src/storage/repositories/remote-servers.ts` (remoteServers + projectRemotes + machineIdentity)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (remove inline blocks: projects 791-925, remoteServers 926-1062, projectRemotes 1063-1254, machineIdentity 1677-1699, settings 1890-1909, plus `toProject`/`toRemoteServer` mappers)
- Test: add `packages/vibedeckx/src/storage/projects.test.ts`

**Interfaces:**
- Consumes: `Kysely<DB>`, `DialectHelpers`, `fromDbBool`.
- Produces: `createCoreRepos(kdb, h): Pick<Storage, "projects" | "settings">`, `createRemoteServerRepos(kdb, h): Pick<Storage, "remoteServers" | "projectRemotes" | "machineIdentity">`.

- [ ] **Step 1: Write a failing test capturing current behavior (`projects.test.ts`)**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("projects + settings storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-proj-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("create/getById round-trips including JSON sync configs and is_remote coercion", async () => {
    const p = await storage.projects.create({
      id: "p1", name: "proj", path: "/tmp/x",
      remote_url: "http://r:3000",
      sync_up_config: { actionType: "command", executionMode: "local", content: "make up" },
    });
    expect(p.is_remote).toBe(true);                      // boolean, not 0/1
    expect(p.sync_up_config?.content).toBe("make up");   // parsed object, not JSON string
    const got = await storage.projects.getById("p1");
    expect(got?.is_remote).toBe(true);
    expect(got?.sync_up_config?.actionType).toBe("command");
  });

  it("user scoping: getById with wrong userId returns undefined", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" }, "user-a");
    expect(await storage.projects.getById("p1", "user-a")).toBeDefined();
    expect(await storage.projects.getById("p1", "user-b")).toBeUndefined();
  });

  it("update: null clears a field, undefined leaves it untouched", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x", remote_url: "http://r" });
    const u1 = await storage.projects.update("p1", { name: "renamed" });
    expect(u1?.remote_url).toBe("http://r");
    const u2 = await storage.projects.update("p1", { remote_url: null });
    expect(u2?.remote_url).toBeUndefined();
  });

  it("settings get/set/delete round-trip", async () => {
    expect(await storage.settings.get("k")).toBeUndefined();
    await storage.settings.set("k", "v1");
    await storage.settings.set("k", "v2"); // upsert
    expect(await storage.settings.get("k")).toBe("v2");
    await storage.settings.delete("k");
    expect(await storage.settings.get("k")).toBeUndefined();
  });
});
```

**Before writing this test, read the current `projects.create/update` implementation (sqlite.ts:791-925) and align expectations with its exact semantics** (e.g. whether `update` with `null` really clears vs. how `undefined` is skipped — the test above encodes the expected contract; if the current code differs, the current code wins and the test is adjusted, since this task must not change behavior).

- [ ] **Step 2: Run new test against the un-ported code**

Run: `pnpm --filter vibedeckx test -- projects`
Expected: PASS (this is a characterization test — it must pass before AND after the port; "failing test" here means it fails if the port breaks semantics).

- [ ] **Step 3: Port the five repos**

Same factory pattern as Task 4. Conversion rules for this group's specials:

- `projects` user scoping: every read gets `.where(eb => eb.or([eb("user_id", "=", userId ?? ""), ...]))` — copy the exact existing SQL predicate (check whether it's `user_id = @user_id` only, or admits `''`; the current code is authoritative).
- JSON columns (`sync_up_config` etc.): `JSON.stringify` on write when value provided, `null` when explicitly cleared; `JSON.parse` in the row mapper (copy `toProject`, sqlite.ts:706-719).
- `settings.set` upsert: current code is INSERT OR REPLACE or UPDATE-then-INSERT (read sqlite.ts:1890-1909). Portable Kysely form:
  ```ts
  await kdb.insertInto("global_settings").values({ key, value })
    .onConflict(oc => oc.column("key").doUpdateSet({ value })).execute();
  ```
- `remoteServers.generateToken`/`revokeToken`: keep `crypto.randomBytes` logic identical; only the SQL moves to Kysely.
- `projectRemotes` joins (`getByProject` returns `ProjectRemoteWithServer`): use `.innerJoin("remote_servers", "remote_servers.id", "project_remotes.remote_server_id")` selecting aliased columns `remote_servers.name as server_name`, `remote_servers.url as server_url`, `remote_servers.api_key as server_api_key`.

- [ ] **Step 4: Verify green + commit**

Run: `pnpm --filter vibedeckx test && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

```bash
git add -A packages/vibedeckx
git commit -m "refactor: port projects/settings/remoteServers/projectRemotes/machineIdentity to Kysely"
```

---

### Task 6: Port executorGroups, executors, executorProcesses, remoteExecutorProcesses

**Files:**
- Create: `packages/vibedeckx/src/storage/repositories/executors.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (remove inline blocks: executorGroups 1255-1299, executors 1300-1397, executorProcesses 1398-1461, remoteExecutorProcesses 1572-1676, plus `mapExecutorRow`)
- Test: add `packages/vibedeckx/src/storage/executors.test.ts`

**Interfaces:**
- Consumes: `Kysely<DB>`, `DialectHelpers`, `fromDbBool`.
- Produces: `createExecutorRepos(kdb, h): Pick<Storage, "executorGroups" | "executors" | "executorProcesses" | "remoteExecutorProcesses">`.

- [ ] **Step 1: Write characterization test (`executors.test.ts`)**

Cover the behaviors most at risk in this group:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("executor storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-exec-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
    await storage.executorGroups.create({ id: "g1", project_id: "p1", name: "G", branch: "main" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("executor round-trip: pty boolean, disabled_targets JSON, defaults", async () => {
    const e = await storage.executors.create({ id: "e1", project_id: "p1", group_id: "g1", name: "run", command: "make" });
    expect(e.pty).toBe(true);
    expect(e.disabled_targets).toEqual([]);
    const u = await storage.executors.update("e1", { pty: false, disabled_targets: ["local", "srv-1"] });
    expect(u?.pty).toBe(false);
    expect(u?.disabled_targets).toEqual(["local", "srv-1"]);
  });

  it("reorder persists positions in the given order", async () => {
    await storage.executors.create({ id: "e1", project_id: "p1", group_id: "g1", name: "a", command: "a" });
    await storage.executors.create({ id: "e2", project_id: "p1", group_id: "g1", name: "b", command: "b" });
    await storage.executors.reorder("g1", ["e2", "e1"]);
    const list = await storage.executors.getByGroupId("g1");
    expect(list.map(x => x.id)).toEqual(["e2", "e1"]);
  });

  it("getLastByExecutorIds returns at most one (the newest) row per executor", async () => {
    await storage.executors.create({ id: "e1", project_id: "p1", group_id: "g1", name: "a", command: "a" });
    await storage.executorProcesses.create({ id: "pr1", executor_id: "e1" });
    await storage.executorProcesses.updateStatus("pr1", "completed", 0);
    await storage.executorProcesses.create({ id: "pr2", executor_id: "e1" });
    const last = await storage.executorProcesses.getLastByExecutorIds(["e1"]);
    expect(last).toHaveLength(1);
    expect(last[0].id).toBe("pr2");
  });

  it("remoteExecutorProcesses markFinished preserves the row; getRunning excludes it", async () => {
    storage; // created above
    await storage.remoteExecutorProcesses.insert("lp1", {
      remoteServerId: "rs1", remoteUrl: "http://r", remoteApiKey: "k",
      remoteProcessId: "rp1", executorId: "e-x",
    });
    expect(await storage.remoteExecutorProcesses.getRunning()).toHaveLength(1);
    await storage.remoteExecutorProcesses.markFinished("lp1", 0);
    expect(await storage.remoteExecutorProcesses.getRunning()).toHaveLength(0);
    expect((await storage.remoteExecutorProcesses.getById("lp1"))?.status).not.toBe("running");
  });
});
```

Run before porting: `pnpm --filter vibedeckx test -- executors` → Expected: PASS (characterization; adjust expectations to current code if any assertion disagrees — current behavior wins).

- [ ] **Step 2: Port the four repos**

Group-specific rules:

- `executors.create` position assignment and `reorder` transaction: if position uses `MAX(position)+1` inside the method, port with a subquery; `reorder` becomes
  ```ts
  await kdb.transaction().execute(async (trx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await trx.updateTable("executors").set({ position: i }).where("id", "=", orderedIds[i]).where("group_id", "=", groupId).execute();
    }
  });
  ```
- `getLastByExecutorIds` / `getLastByExecutorIdsGroupedByServer`: the current SQL (read sqlite.ts:1398-1461 and 1572-1676 first) likely uses `MAX(started_at)` group-by or a window; port keeping identical row selection. ANSI window functions (`row_number() over (partition by ...)`) work on both sqlite and pg via `sql` fragments if the builder API can't express it — add `// DIALECT-OK: ANSI window` comment.
- Any `IN (list)` with dynamic ids: `.where("executor_id", "in", executorIds)` — but guard `executorIds.length === 0` → return `[]` early (Kysely `in []` generates `in (null)`, matching sqlite's empty result — still, guard explicitly to keep semantics obvious).
- `pty`/booleans + `disabled_targets` JSON: same mapper logic as `mapExecutorRow` (sqlite.ts:768-774) with `fromDbBool`.

- [ ] **Step 3: Verify green + commit**

Run: `pnpm --filter vibedeckx test && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

```bash
git add -A packages/vibedeckx
git commit -m "refactor: port executor storage repos to Kysely"
```

---

### Task 7: Port agentSessions (+entries) and remoteSessionMappings

**Files:**
- Create: `packages/vibedeckx/src/storage/repositories/agent-sessions.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (remove inline blocks: agentSessions 1700-1847, remoteSessionMappings 1848-1889)
- Test: add `packages/vibedeckx/src/storage/agent-sessions.test.ts`

**Interfaces:**
- Consumes: `Kysely<DB>`, `DialectHelpers` (this group is the `nowMs()` consumer), `fromDbBool`.
- Produces: `createAgentSessionRepos(kdb, h): Pick<Storage, "agentSessions" | "remoteSessionMappings">`.

- [ ] **Step 1: Write characterization test (`agent-sessions.test.ts`)**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("agent session storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-as-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("getLatestByBranch picks the newer of two sessions created in the same second (ms precision)", async () => {
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
    await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
    expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).toBe("s2");
    expect((await storage.agentSessions.listByBranch("p1", "dev")).map(s => s.id)).toEqual(["s2", "s1"]);
  });

  it("updateStatusPreservingTimestamp does not disturb getLatestByBranch ordering", async () => {
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
    await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateStatusPreservingTimestamp("s1", "stopped");
    expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).toBe("s2");
  });

  it("entries upsert overwrites same index, getEntries returns index order", async () => {
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
    await storage.agentSessions.upsertEntry("s1", 1, "one");
    await storage.agentSessions.upsertEntry("s1", 0, "zero");
    await storage.agentSessions.upsertEntry("s1", 1, "one-v2");
    const entries = await storage.agentSessions.getEntries("s1");
    expect(entries).toEqual([{ entry_index: 0, data: "zero" }, { entry_index: 1, data: "one-v2" }]);
    expect(await storage.agentSessions.countEntries()).toEqual([{ session_id: "s1", cnt: 2 }]);
  });

  it("remoteSessionMappings upsert + title_resolved lifecycle", async () => {
    await storage.remoteSessionMappings.upsert("l1", "p1", "rs1", "r1", "dev");
    await storage.remoteSessionMappings.upsert("l1", "p1", "rs1", "r2", "dev"); // overwrite
    const all = await storage.remoteSessionMappings.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].remote_session_id).toBe("r2");
    expect(await storage.remoteSessionMappings.isTitleResolved("l1")).toBe(false);
    await storage.remoteSessionMappings.markTitleResolved("l1");
    expect(await storage.remoteSessionMappings.isTitleResolved("l1")).toBe(true);
  });
});
```

Run before porting → Expected: PASS (characterization baseline; where an assertion disagrees with current behavior, current behavior wins).

- [ ] **Step 2: Port the two repos**

Group-specific rules:

- **Millisecond timestamps are load-bearing** (see comment sqlite.ts:1701-1704): `create`, `updateStatus`, `touchUpdatedAt`, etc. write `strftime('%Y-%m-%d %H:%M:%f','now')` explicitly. Use `h.nowMs()` everywhere the original uses `strftime('%Y-%m-%d %H:%M:%f', 'now')`; use `sql`CURRENT_TIMESTAMP`` only where the original does.
- `updateStatusPreservingTimestamp`: sets `status` only — must NOT touch `updated_at`.
- `upsertEntry` (sqlite.ts:1823): portable upsert —
  ```ts
  await kdb.insertInto("agent_session_entries").values({ session_id: sessionId, entry_index: entryIndex, data })
    .onConflict(oc => oc.columns(["session_id", "entry_index"]).doUpdateSet({ data })).execute();
  ```
  (First read the original statement; if it's `INSERT OR REPLACE`, the onConflict form above is semantically identical here because the PK covers (session_id, entry_index).)
- `countEntries`: `select("session_id").select(kdb.fn.countAll<number>().as("cnt")).groupBy("session_id")`.
- `remoteSessionMappings.upsert`: same onConflict pattern keyed on `local_session_id`; preserve exactly which columns get overwritten (read sqlite.ts:1848-1889 — note whether `title_resolved` is reset on upsert or preserved).
- `isTitleResolved` returns `fromDbBool(row?.title_resolved)`.

- [ ] **Step 3: Verify green + commit**

Run: `pnpm --filter vibedeckx test && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

```bash
git add -A packages/vibedeckx
git commit -m "refactor: port agentSessions/remoteSessionMappings storage to Kysely"
```

---

### Task 8: Port tasks, rules, commands — and seal the query layer

**Files:**
- Create: `packages/vibedeckx/src/storage/repositories/workspace.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (remove inline blocks: tasks 1910-2016, rules 2017-2101, commands 2102-2163)
- Test: add `packages/vibedeckx/src/storage/workspace.test.ts`

**Interfaces:**
- Consumes: `Kysely<DB>`, `DialectHelpers`, `fromDbBool`.
- Produces: `createWorkspaceRepos(kdb, h): Pick<Storage, "tasks" | "rules" | "commands">`. After this task, `sqlite.ts` contains ONLY: imports, `createDatabase` (legacy DDL), and the factory assembly.

- [ ] **Step 1: Write characterization test (`workspace.test.ts`)**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("tasks/rules/commands storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-ws-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tasks: archive/unarchive lifecycle and includeArchived filter", async () => {
    await storage.tasks.create({ id: "t1", project_id: "p1", title: "T" });
    await storage.tasks.archive("t1");
    expect(await storage.tasks.getByProjectId("p1")).toHaveLength(0);
    expect(await storage.tasks.getByProjectId("p1", { includeArchived: true })).toHaveLength(1);
    await storage.tasks.unarchive("t1");
    expect(await storage.tasks.getByProjectId("p1")).toHaveLength(1);
  });

  it("rules: branch-scoped getByWorkspace — null branch means project-level", async () => {
    await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "global", content: "x" });
    await storage.rules.create({ id: "r2", project_id: "p1", branch: "dev", name: "dev-only", content: "y" });
    const projectLevel = await storage.rules.getByWorkspace("p1", null);
    const devLevel = await storage.rules.getByWorkspace("p1", "dev");
    expect(projectLevel.map(r => r.id)).toEqual(["r1"]);
    expect(devLevel.map(r => r.id)).toEqual(["r2"]);
  });

  it("rules: enabled round-trips through create/update", async () => {
    const r = await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "n", content: "c", enabled: false });
    // NOTE: Rule.enabled is typed `number` in types.ts — assert the current representation.
    expect(r.enabled).toBe(0);
    const u = await storage.rules.update("r1", { enabled: true });
    expect(u?.enabled).toBe(1);
  });

  it("commands: create/getByWorkspace/update/delete round-trip", async () => {
    await storage.commands.create({ id: "c1", project_id: "p1", branch: null, name: "deploy", content: "make deploy" });
    expect((await storage.commands.getByWorkspace("p1", null)).map(c => c.name)).toEqual(["deploy"]);
    await storage.commands.update("c1", { content: "make deploy2" });
    expect((await storage.commands.getById("c1"))?.content).toBe("make deploy2");
    await storage.commands.delete("c1");
    expect(await storage.commands.getById("c1")).toBeUndefined();
  });
});
```

Run before porting → Expected: PASS (characterization; verify the `enabled: 0/1` assertion against actual current output first — `Rule.enabled` is `number` in types.ts, so the port must keep returning numbers, NOT convert to boolean).

- [ ] **Step 2: Port the three repos**

Group-specific rules:

- **`Rule.enabled` stays a number** (types.ts:194 declares `enabled: number`) — do NOT apply `fromDbBool` here; the mapper passes the raw 0/1 through. This is the one boolean-looking column that must not be coerced (behavior-preservation beats consistency; normalizing it is a separate future change).
- `getByWorkspace(projectId, branch)`: branch `null` filters `branch IS NULL` (`.where("branch", "is", null)`), non-null uses `=`. Read the original to check whether branch-scoped queries also include project-level rows (copy exactly).
- `tasks.getByProjectId` default excludes archived: `.where("archived_at", "is", null)` unless `includeArchived`.
- `reorder` for tasks/rules: same transaction pattern as Task 6.

- [ ] **Step 3: Sweep for leftovers**

Run: `grep -n "db.prepare" packages/vibedeckx/src/storage/sqlite.ts | grep -v -E "PRAGMA|sqlite_master"`
Expected: no matches outside `createDatabase()` (legacy DDL/migrations are the only remaining raw usage). If matches remain, they're missed ports — fix before committing.

- [ ] **Step 4: Verify green + commit**

Run: `pnpm --filter vibedeckx test && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

```bash
git add -A packages/vibedeckx
git commit -m "refactor: port tasks/rules/commands storage to Kysely; query layer fully on Kysely"
```

---

### Task 9: Real-database smoke test + delivery notes

Prove zero breakage against a production-shaped database, per the spec's acceptance criteria.

**Files:**
- No source changes expected (fixes only if the smoke run finds regressions)
- Create: delivery notes appended to `docs/superpowers/plans/2026-07-05-storage-race-audit-notes.md`

- [ ] **Step 1: Build production bundle**

Run: `pnpm build`
Expected: exits 0.

- [ ] **Step 2: Prepare an isolated HOME with a real database copy**

If `~/.vibedeckx/data.sqlite` exists on this machine, copy it (plus `-wal`/`-shm` if present) into a temp HOME; otherwise generate a database by briefly running the PREVIOUS release build (`git stash` not needed — check out `main`'s built artifact or run current dev server once) and creating a project + executor + scheduled task through the API.

```bash
SMOKE_HOME=$(mktemp -d)
mkdir -p "$SMOKE_HOME/.vibedeckx"
cp ~/.vibedeckx/data.sqlite* "$SMOKE_HOME/.vibedeckx/" 2>/dev/null || echo "no existing db — create one via previous build first"
```

- [ ] **Step 3: Boot the new build against the old database**

```bash
HOME="$SMOKE_HOME" node packages/vibedeckx/dist/bin.js --port 3210 &
sleep 3
```

Expected: server starts, no migration errors in output.

- [ ] **Step 4: Exercise the read/write surface**

```bash
curl -sf localhost:3210/api/projects | head -c 400            # legacy projects listed
PID=$(curl -sf localhost:3210/api/projects | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0]?.id??''))")
curl -sf "localhost:3210/api/projects/$PID" >/dev/null         # single get
curl -sf -X POST localhost:3210/api/projects -H 'content-type: application/json' \
  -d '{"name":"smoke-proj","path":"/tmp/smoke-proj"}' >/dev/null   # write path
curl -sf localhost:3210/api/projects | grep -q smoke-proj && echo WRITE-OK
```

Then in the browser (or curl) verify: agent session history replays for an existing session (`GET /api/agent-sessions?projectId=...` + entries load), executor list shows last-run data, scheduled tasks list loads. Expected: all succeed; `WRITE-OK` printed.

Kill the server, delete `$SMOKE_HOME`.

- [ ] **Step 5: Full verification battery**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../.. && pnpm --filter vibedeckx test && pnpm --filter vibedeckx-ui lint`
Expected: all PASS.

- [ ] **Step 6: Append delivery notes + commit**

Append to the race-audit notes file: smoke-test evidence (what was exercised, against which database), the `DIALECT:` marker inventory (`grep -rn "DIALECT" packages/vibedeckx/src/storage/`), and the list of restructured call sites from Task 1. Commit:

```bash
git add -A
git commit -m "test: real-database smoke verification for Kysely storage port + delivery notes"
```

---

## Self-Review (completed)

- **Spec coverage:** interface async (Task 1), caller conversion + race audit (Tasks 1-2), Kysely schema/helpers/wiring with legacy DDL untouched (Task 3), dialect-agnostic repositories (Tasks 4-8), shared-migration mount point deferred to pg phase per spec ("empty today" — no task needed), acceptance criteria (Task 9). ✓
- **Placeholder scan:** conversion rules reference exact line ranges of authoritative existing code rather than inlining 2,200 lines — deliberate: the current implementation is the behavior spec; every non-obvious pattern (booleans, JSON, onConflict, nowMs, rowid, transactions, empty-IN) has explicit code. ✓
- **Type consistency:** `createXxxRepos(kdb: Kysely<DB>, h: DialectHelpers)` naming uniform across Tasks 4-8; `fromDbBool`/`toDbBool`/`nowMs`/`rowIdDesc` defined once in Task 3 and consumed by name thereafter; `Rule.enabled: number` exception called out in Task 8. ✓
