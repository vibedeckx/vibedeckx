# Schedule Remote Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a scheduled task run on a remote server (chosen per-schedule via a `target`), the same way a remote Executor runs, with no remote-server code change.

**Architecture:** Add a `target` column (`'local'` | `remote_server_id`) to `scheduled_tasks`, orthogonal to the existing `cwd_mode`. When a run's `target` is remote, `SchedulerService.executeRun` proxies `POST /api/path/execute` to the remote (via `proxyToRemoteAuto`) instead of calling the local `ProcessManager`, registers the remote process with the existing `RemoteExecutorMonitor`, and detects completion by subscribing to the event bus's `executor:stopped` event (capturing its `tailOutput`). Timeout proxies the remote stop endpoint. All schedule CRUD/history stays on the control server.

**Tech Stack:** TypeScript (ESM NodeNext backend — `.js` import extensions), Fastify, better-sqlite3, `croner`, Next.js 16 / React 19, vitest 4.

**Spec:** `docs/superpowers/specs/2026-07-03-schedule-remote-execution-design.md`

## Global Constraints

- Backend is ESM with NodeNext resolution — **all local imports use `.js` extensions**.
- Backend type-check: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Frontend type-check: `cd apps/vibedeckx-ui && npx tsc --noEmit`.
- vitest 4 is configured in both packages (`*.test.ts`). Backend tests: `cd packages/vibedeckx && npx vitest run <file>`.
- Frontend uses `eslint-plugin-react-hooks@7` compiler rules (no ref writes in render body, no unconditional `setState` in effect body). Lint the touched files: `cd apps/vibedeckx-ui && npx eslint <files>`.
- `target` default is the literal string `'local'`. Remote targets are `remote_server_id` strings.
- Remote runs persist `executor:stopped.tailOutput` (last 10,000 chars, ANSI-stripped) — this is intentional, not a bug.
- No remote-server code changes: the remote's existing `POST /api/path/execute` is reused as-is.
- Match existing file idioms exactly (named `@param` binding, re-select-and-map after write, the dynamic-SET update pattern). Don't reformat surrounding code.

---

### Task 1: Storage — `target` column on `scheduled_tasks`

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts` (`ScheduledTask` interface + `scheduledTasks` create/update signatures)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (CREATE TABLE, migration guard, `ScheduledTaskRow`, `create`, `update`)
- Test: `packages/vibedeckx/src/storage/scheduled-tasks.test.ts` (append cases)

**Interfaces:**
- Consumes: existing `Storage.scheduledTasks` namespace, `ScheduledTask` type.
- Produces: `ScheduledTask.target: string`; `scheduledTasks.create(opts)` accepts `target?: string` (defaults `'local'`); `scheduledTasks.update(id, opts)` accepts `target?: string`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/vibedeckx/src/storage/scheduled-tasks.test.ts`, inside the existing top-level `describe("scheduledTasks storage", ...)` block (reuse its `storage`/`projectId`/`createTask` helpers):

```ts
  it("defaults target to 'local' and round-trips a remote target", () => {
    const t = createTask();
    expect(t.target).toBe("local");

    const remote = storage.scheduledTasks.create({
      id: "s-remote",
      project_id: projectId,
      name: "remote scan",
      cron_expr: "0 9 * * *",
      timezone: "UTC",
      run_type: "command",
      content: "echo hi",
      cwd_mode: "branch",
      target: "remote-server-1",
    });
    expect(remote.target).toBe("remote-server-1");
    expect(storage.scheduledTasks.getById("s-remote")?.target).toBe("remote-server-1");
  });

  it("update can change target", () => {
    createTask();
    const updated = storage.scheduledTasks.update("s1", { target: "remote-server-2" });
    expect(updated?.target).toBe("remote-server-2");
    expect(storage.scheduledTasks.getById("s1")?.target).toBe("remote-server-2");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vibedeckx && npx vitest run src/storage/scheduled-tasks.test.ts`
Expected: FAIL — TypeScript/property errors: `target` does not exist on `ScheduledTask` / not accepted by `create`/`update`.

- [ ] **Step 3: Add `target` to the `ScheduledTask` type and storage signatures**

In `packages/vibedeckx/src/storage/types.ts`, add `target` to the `ScheduledTask` interface (right after `timezone`):

```ts
  /** IIANA timezone name the cron expression is evaluated in, e.g. "Asia/Shanghai". */
  timezone: string;
  /** 'local' or a remote_server_id — where the run's process is spawned. */
  target: string;
  enabled: boolean;
```

(If the existing comment above `timezone` differs, leave it; only insert the `target` field + its comment.)

In the same file, in the `scheduledTasks` interface block, add `target?: string` to both signatures:

```ts
    create: (opts: { id: string; project_id: string; name: string; cron_expr: string; timezone: string; run_type: ScheduledTaskRunType; content: string; cwd_mode: ScheduledTaskCwdMode; branch?: string | null; directory?: string | null; timeout_seconds?: number; enabled?: boolean; target?: string }) => ScheduledTask;
```

and to the `update` opts object add `target?: string;` alongside the other optional fields.

- [ ] **Step 4: Add the column + migration + mapping + writes in sqlite.ts**

In `packages/vibedeckx/src/storage/sqlite.ts`:

(a) CREATE TABLE (`scheduled_tasks`, ~line 657) — add the `target` column after `timezone`:

```sql
      timezone TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'local',
      enabled INTEGER NOT NULL DEFAULT 1,
```

(b) Migration guard for existing DBs — add immediately after the `db.exec(\`...scheduled_task_runs...\`)` block and its `UPDATE ... SET status='killed'` fixup, still **before** `db.pragma("foreign_keys = ON");`:

```ts
  // Add scheduled_tasks.target for DBs created before remote-schedule support.
  const scheduledTaskCols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as { name: string }[];
  if (!scheduledTaskCols.some((c) => c.name === "target")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN target TEXT NOT NULL DEFAULT 'local'");
  }
```

(c) `ScheduledTaskRow` type (~line 769) — add `target: string`:

```ts
  type ScheduledTaskRow = { id: string; project_id: string; name: string; cron_expr: string; timezone: string; target: string; enabled: number; run_type: string; content: string; cwd_mode: string; branch: string | null; directory: string | null; timeout_seconds: number; created_at: string; updated_at: string };
```

`mapScheduledTaskRow` needs no change — `target` is a plain string carried by `...row`.

(d) `create` (~line 1456) — add `target` to the destructure, column list, values, and `.run`:

```ts
      create: ({ id, project_id, name, cron_expr, timezone, run_type, content, cwd_mode, branch, directory, timeout_seconds, enabled, target }) => {
        db.prepare(
          `INSERT INTO scheduled_tasks (id, project_id, name, cron_expr, timezone, target, enabled, run_type, content, cwd_mode, branch, directory, timeout_seconds)
           VALUES (@id, @project_id, @name, @cron_expr, @timezone, @target, @enabled, @run_type, @content, @cwd_mode, @branch, @directory, @timeout_seconds)`
        ).run({
          id, project_id, name, cron_expr, timezone,
          target: target ?? 'local',
          enabled: enabled === false ? 0 : 1,
          run_type, content, cwd_mode,
          branch: branch ?? null,
          directory: directory ?? null,
          timeout_seconds: timeout_seconds ?? 1800,
        });
        const row = db.prepare<{ id: string }, ScheduledTaskRow>(`SELECT * FROM scheduled_tasks WHERE id = @id`).get({ id })!;
        return mapScheduledTaskRow(row);
      },
```

(e) `update` (~line 1485) — add a `target` set after the `timezone` line:

```ts
        if (opts.timezone !== undefined) { sets.push("timezone = @timezone"); params.timezone = opts.timezone; }
        if (opts.target !== undefined) { sets.push("target = @target"); params.target = opts.target; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/storage/scheduled-tasks.test.ts`
Expected: PASS (all cases, including the two new ones).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add packages/vibedeckx/src/storage/types.ts packages/vibedeckx/src/storage/sqlite.ts packages/vibedeckx/src/storage/scheduled-tasks.test.ts
git commit -m "feat: scheduled_tasks.target column for remote execution"
```

---

### Task 2: Scheduler — remote execution branch + dependency injection

**Files:**
- Modify: `packages/vibedeckx/src/scheduler.ts` (imports, constructor, `runNow`/`executeRun` async, new `executeRemoteRun`, cron callback)
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts` (move scheduler construction, inject remote deps)
- Modify: `packages/vibedeckx/src/routes/schedule-routes.ts` (await the now-async `runNow` in the run handler)
- Test: `packages/vibedeckx/src/scheduler.test.ts` (await existing local `runNow` calls; add remote cases)

**Interfaces:**
- Consumes: `Storage.scheduledTasks` / `.scheduledTaskRuns` / `.projectRemotes.getByProjectAndServer` (Task 1 + existing); `proxyToRemoteAuto(remoteServerId, remoteUrl, apiKey, method, apiPath, body?, options?) => Promise<ProxyResult>` (`utils/remote-proxy.ts`); `RemoteExecutorMonitor.watch(localProcessId, remoteInfo)` (`remote-executor-monitor.ts`); `RemoteExecutorInfo` (`server-types.ts`); `EventBus.subscribe(cb) => () => void` and its `executor:stopped { processId, exitCode, tailOutput }` event (`event-bus.ts`).
- Produces: `SchedulerRemoteDeps` interface (exported); `SchedulerService` constructor `(storage, processManager, remote?: SchedulerRemoteDeps)`; `runNow(scheduleId) => Promise<RunNowResult>` (now async).

- [ ] **Step 1: Write the failing remote tests**

Append to `packages/vibedeckx/src/scheduler.test.ts`. First ensure these imports exist at the top (add only the ones missing — `EventBus`/`GlobalEvent` were already imported in the earlier scheduler fix round; do NOT duplicate):

```ts
import { EventBus, type GlobalEvent } from "./event-bus.js"; // likely already present
import type { RemoteExecutorInfo } from "./server-types.js"; // new
```

Then add a new `describe` block (a real sqlite + a real `EventBus` + a fake proxy/monitor):

```ts
describe("SchedulerService remote runs", () => {
  let dir: string;
  let storage: Storage;
  let pm: ReturnType<typeof makeFakeProcessManager>;
  let eventBus: EventBus;
  let proxyCalls: { path: string; body: unknown; serverId: string }[];
  let scheduler: SchedulerService;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-sched-remote-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    storage.projects.create({ id: "proj-1", name: "p", path: dir });
    const server = storage.remoteServers.create({ name: "r", url: "http://remote.test", api_key: "K" });
    storage.projectRemotes.add({ project_id: "proj-1", remote_server_id: server.id, remote_path: "/srv/app" });
    storage.scheduledTasks.create({
      id: "s1", project_id: "proj-1", name: "remote scan", cron_expr: "0 9 * * *",
      timezone: "UTC", run_type: "command", content: "echo hi",
      cwd_mode: "branch", branch: "main", target: server.id,
    });

    pm = makeFakeProcessManager();
    eventBus = new EventBus();
    proxyCalls = [];
    const fakeProxy = async (serverId: string, _url: string, _key: string, _method: string, apiPath: string, body?: unknown) => {
      proxyCalls.push({ path: apiPath, body, serverId });
      if (apiPath === "/api/path/execute") return { ok: true, status: 200, data: { processId: "rp-1" } };
      return { ok: true, status: 200, data: {} };
    };
    scheduler = new SchedulerService(storage, pm as unknown as ProcessManager, {
      reverseConnectManager: {} as never,
      remoteExecutorMap: new Map<string, RemoteExecutorInfo>(),
      remoteExecutorMonitor: { watch() {}, unwatch() {} } as never,
      proxy: fakeProxy as never,
    });
    scheduler.setEventBus(eventBus);
  });

  afterEach(() => {
    scheduler.shutdown();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("proxies /api/path/execute with branch payload and records a running run", async () => {
    const result = await scheduler.runNow("s1");
    expect(result).toMatchObject({ skipped: false });
    const exec = proxyCalls.find((c) => c.path === "/api/path/execute");
    expect(exec).toBeDefined();
    expect(exec!.body).toMatchObject({ path: "/srv/app", branch: "main", command: "echo hi" });
    const runs = storage.scheduledTaskRuns.getByScheduleId("s1");
    expect(runs[0].status).toBe("running");
    expect(runs[0].process_id).toBe("remote-schedule-s1-rp-1");
    expect(pm.started).toHaveLength(0); // never touches the local ProcessManager
  });

  it("finalizes completed from an executor:stopped event, storing tailOutput", async () => {
    const result = await scheduler.runNow("s1") as { runId: string };
    eventBus.emit({
      type: "executor:stopped", projectId: "proj-1", executorId: "schedule-s1",
      processId: "remote-schedule-s1-rp-1", exitCode: 0, target: "remote", tailOutput: "remote-done",
    } as GlobalEvent);
    const run = storage.scheduledTaskRuns.getById(result.runId);
    expect(run?.status).toBe("completed");
    expect(run?.output).toBe("remote-done");
  });

  it("directory mode proxies path=<directory>, branch undefined", async () => {
    storage.scheduledTasks.update("s1", { cwd_mode: "directory", directory: "/var/log" });
    await scheduler.runNow("s1");
    const exec = proxyCalls.find((c) => c.path === "/api/path/execute")!;
    expect(exec.body).toMatchObject({ path: "/var/log" });
    expect((exec.body as { branch?: unknown }).branch).toBeUndefined();
  });

  it("records failed without a proxy call when the remote target is unknown", async () => {
    storage.scheduledTasks.update("s1", { target: "nonexistent-server" });
    const result = await scheduler.runNow("s1");
    expect(result).toMatchObject({ error: expect.stringContaining("Remote server config not found") });
    expect(proxyCalls).toHaveLength(0);
    expect(storage.scheduledTaskRuns.getByScheduleId("s1")[0].status).toBe("failed");
  });

  it("on timeout, proxies the remote stop endpoint and records timeout", async () => {
    vi.useFakeTimers();
    try {
      storage.scheduledTasks.update("s1", { timeout_seconds: 1 });
      const result = await scheduler.runNow("s1") as { runId: string };
      await vi.advanceTimersByTimeAsync(1100);
      expect(proxyCalls.some((c) => c.path === "/api/executor-processes/rp-1/stop")).toBe(true);
      expect(storage.scheduledTaskRuns.getById(result.runId)?.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Update existing local tests for the now-async `runNow`**

In the SAME file, the existing local-run tests call `scheduler.runNow(...)` synchronously. `runNow` becomes async in Step 3. In each existing local test that calls `runNow`, make the `it` callback `async` and `await` the call. Concretely, change every occurrence of:

```ts
    const result = scheduler.runNow("s1");
```
to
```ts
    const result = await scheduler.runNow("s1");
```
and every bare `scheduler.runNow("s1");` to `await scheduler.runNow("s1");`, marking each affected `it("...", () => {...})` as `it("...", async () => {...})`. (The local path has no internal `await`, so it still completes synchronously before the promise resolves — `pm.emit(...)` after the `await` still runs after the subscriber is registered. The fake-timer shutdown/timeout tests keep `vi.useFakeTimers()`; awaiting an already-resolved promise is safe under fake timers.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/vibedeckx && npx vitest run src/scheduler.test.ts`
Expected: FAIL — `SchedulerRemoteDeps`/3rd constructor arg doesn't exist; `runNow` not async; remote branch unimplemented.

- [ ] **Step 4: Implement the scheduler changes**

In `packages/vibedeckx/src/scheduler.ts`:

(a) Add imports (after the existing imports):

```ts
import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import type { RemoteExecutorMonitor } from "./remote-executor-monitor.js";
import type { RemoteExecutorInfo } from "./server-types.js";
```

(b) Add the deps interface (above the `SchedulerService` class):

```ts
export interface SchedulerRemoteDeps {
  reverseConnectManager: ReverseConnectManager;
  remoteExecutorMap: Map<string, RemoteExecutorInfo>;
  remoteExecutorMonitor: RemoteExecutorMonitor;
  /** Injectable for tests; defaults to the real proxyToRemoteAuto. */
  proxy?: typeof proxyToRemoteAuto;
}
```

(c) Extend the constructor (add the optional third param):

```ts
  constructor(
    private storage: Storage,
    private processManager: ProcessManager,
    private remote?: SchedulerRemoteDeps,
  ) {}
```

(d) Make `runNow` async:

```ts
  async runNow(scheduleId: string): Promise<RunNowResult> {
    if (this.stopped) return { error: "Scheduler stopped" };
    return this.executeRun(scheduleId);
  }
```

(e) In `scheduleJob`, update the cron callback to handle the now-async `executeRun`:

```ts
      const job = new Cron(task.cron_expr, { timezone: task.timezone, catch: true }, () => {
        if (this.stopped) return;
        void this.executeRun(task.id).then((result) => {
          if ("error" in result) {
            console.error(`[Scheduler] Run of ${task.id} failed to start: ${result.error}`);
          }
        }).catch((err) => {
          console.error(`[Scheduler] Run of ${task.id} threw: ${err}`);
        });
      });
```

(f) Change `executeRun`'s signature to async and add the remote branch right after the overlap-skip guard, before the local cwd resolution:

```ts
  private async executeRun(scheduleId: string): Promise<RunNowResult> {
    const task = this.storage.scheduledTasks.getById(scheduleId);
    if (!task) return { error: "Schedule not found" };

    const runId = randomUUID();

    // Overlap policy: skip (recorded) when the previous run is still going.
    if (this.activeRuns.has(scheduleId)) {
      this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: scheduleId, status: "skipped" });
      this.storage.scheduledTaskRuns.prune(scheduleId, RUNS_KEEP);
      this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId, runId, status: "skipped", exitCode: null });
      return { runId, skipped: true };
    }

    if (task.target !== "local") {
      return this.executeRemoteRun(task, runId);
    }

    // ... existing local body unchanged (cwd resolution, fabricated executor,
    //     processManager.start, processManager.subscribe, timeout) ...
  }
```

(Leave the entire existing local body exactly as-is below the new `if (task.target !== "local")` line.)

(g) Add the new `executeRemoteRun` method (place it right after `executeRun`):

```ts
  private async executeRemoteRun(task: ScheduledTask, runId: string): Promise<RunNowResult> {
    if (!this.remote) {
      return this.failWithoutStart(task, runId, "Remote execution is not configured on this server");
    }
    const remoteConfig = this.storage.projectRemotes.getByProjectAndServer(task.project_id, task.target);
    if (!remoteConfig) {
      return this.failWithoutStart(task, runId, `Remote server config not found for target ${task.target}`);
    }

    // Derive the remote working-directory args from cwd_mode.
    let remotePath: string;
    let remoteBranch: string | null;
    if (task.cwd_mode === "directory") {
      if (!task.directory || !path.isAbsolute(task.directory)) {
        return this.failWithoutStart(task, runId, `Schedule directory must be an absolute path: ${task.directory ?? "(unset)"}`);
      }
      remotePath = task.directory;
      remoteBranch = null;
    } else {
      remotePath = remoteConfig.remote_path;
      remoteBranch = task.branch;
    }

    const proxy = this.remote.proxy ?? proxyToRemoteAuto;
    const serverUrl = remoteConfig.server_url ?? "";
    const serverKey = remoteConfig.server_api_key || "";

    let result;
    try {
      result = await proxy(
        task.target, serverUrl, serverKey, "POST", "/api/path/execute",
        {
          path: remotePath,
          command: task.content,
          executor_type: task.run_type,
          prompt_provider: task.run_type === "prompt" ? "claude" : null,
          branch: remoteBranch ?? undefined,
          pty: true,
        },
        { reverseConnectManager: this.remote.reverseConnectManager },
      );
    } catch (err) {
      return this.failWithoutStart(task, runId, `Remote start failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const processId = (result.data as { processId?: unknown } | null)?.processId;
    if (!result.ok || typeof processId !== "string") {
      return this.failWithoutStart(task, runId, `Remote start rejected (status ${result.status})`);
    }
    const remoteProcessId = processId;
    const localProcessId = `remote-schedule-${task.id}-${remoteProcessId}`;

    const remoteInfo: RemoteExecutorInfo = {
      remoteServerId: task.target,
      remoteUrl: serverUrl,
      remoteApiKey: serverKey,
      remoteProcessId,
      executorId: `schedule-${task.id}`,
      projectId: task.project_id,
    };
    this.remote.remoteExecutorMap.set(localProcessId, remoteInfo);
    this.remote.remoteExecutorMonitor.watch(localProcessId, remoteInfo);

    this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: task.id, status: "running", process_id: localProcessId });
    this.activeRuns.set(task.id, runId);
    this.eventBus?.emit({ type: "schedule:run-started", projectId: task.project_id, scheduleId: task.id, runId });

    let finalized = false;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;

    const releaseRunResources = () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };

    const finalize = (status: ScheduledTaskRunStatus, exitCode: number | null, output: string) => {
      if (finalized) return;
      finalized = true;
      releaseRunResources();
      this.activeRuns.delete(task.id);
      this.activeRunCleanups.delete(task.id);
      this.storage.scheduledTaskRuns.finish(runId, { status, exit_code: exitCode, output: output.slice(-OUTPUT_CAP) });
      this.storage.scheduledTaskRuns.prune(task.id, RUNS_KEEP);
      this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId: task.id, runId, status, exitCode });
    };

    // Remote processes are not in the local ProcessManager; RemoteExecutorMonitor
    // emits executor:stopped on the bus when the remote finishes (with tailOutput).
    unsubscribe = this.eventBus?.subscribe((e) => {
      if (e.type === "executor:stopped" && e.processId === localProcessId) {
        finalize(e.exitCode === 0 ? "completed" : "failed", e.exitCode, e.tailOutput ?? "");
      }
    });

    timer = setTimeout(() => {
      void proxy(
        task.target, serverUrl, serverKey, "POST",
        `/api/executor-processes/${remoteProcessId}/stop`, undefined,
        { reverseConnectManager: this.remote!.reverseConnectManager },
      ).catch(() => {});
      finalize("timeout", null, "");
    }, task.timeout_seconds * 1000);
    timer.unref();

    this.activeRunCleanups.set(task.id, () => {
      if (finalized) return;
      finalized = true;
      releaseRunResources();
      this.activeRuns.delete(task.id);
      this.activeRunCleanups.delete(task.id);
    });

    return { runId, skipped: false };
  }
```

- [ ] **Step 5: Wire the remote deps in shared-services**

In `packages/vibedeckx/src/plugins/shared-services.ts`:

Delete the early construction at line ~26:
```ts
  const scheduler = new SchedulerService(opts.storage, processManager);
```

And re-create it just after `remoteExecutorMonitor` is constructed (after the `const remoteExecutorMonitor = new RemoteExecutorMonitor(...)` line, ~line 90):

```ts
  const scheduler = new SchedulerService(opts.storage, processManager, {
    reverseConnectManager,
    remoteExecutorMap,
    remoteExecutorMonitor,
  });
```

(`fastify.decorate("scheduler", scheduler)`, `scheduler.setEventBus(eventBus)`, `scheduler.start()`, and the `onClose` `scheduler.shutdown()` all stay where they are — they run after this new construction point.)

- [ ] **Step 6: Await the now-async `runNow` in the route**

In `packages/vibedeckx/src/routes/schedule-routes.ts`, the `POST /api/schedules/:id/run` handler calls `fastify.scheduler.runNow(...)`. Make the call `await`ed (the handler is already `async`):

```ts
      const result = await fastify.scheduler.runNow(req.params.id);
```

(If the current code destructures/returns the result the same way, only add `await`; keep the surrounding `if ("error" in result)` handling intact.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/scheduler.test.ts`
Expected: PASS — existing local cases + the 5 new remote cases.

- [ ] **Step 8: Full backend suite + type-check**

Run: `cd packages/vibedeckx && npx vitest run` then `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: all tests PASS; tsc exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/vibedeckx/src/scheduler.ts packages/vibedeckx/src/scheduler.test.ts packages/vibedeckx/src/plugins/shared-services.ts packages/vibedeckx/src/routes/schedule-routes.ts
git commit -m "feat: scheduler remote execution via /api/path/execute + monitor"
```

---

### Task 3: Routes — accept + validate `target`

**Files:**
- Modify: `packages/vibedeckx/src/routes/schedule-routes.ts` (create + update handlers)

**Interfaces:**
- Consumes: `storage.projectRemotes.getByProjectAndServer(projectId, target)` (existing); `storage.scheduledTasks.create/update` now accept `target` (Task 1).
- Produces: create/update accept `target` in the body (default `'local'`); unknown remote target → 400.

- [ ] **Step 1: Add `target` to the request body type + a validation helper**

In `packages/vibedeckx/src/routes/schedule-routes.ts`, add `target?: string` to the `ScheduleBody` interface (alongside the other optional fields).

Add a small helper near `validateResolved` (it needs `fastify`, so define it inside the plugin function or pass storage in — inline it in each handler as shown in Steps 2–3). The rule: when `target` is present and not `'local'`, `storage.projectRemotes.getByProjectAndServer(projectId, target)` must exist.

- [ ] **Step 2: Validate + persist `target` in the create handler**

In the `POST /api/projects/:projectId/schedules` handler, after the existing `validateResolved(...)` check passes and before calling `scheduledTasks.create`, add:

```ts
      const target = b.target ?? "local";
      if (target !== "local" && !fastify.storage.projectRemotes.getByProjectAndServer(req.params.projectId, target)) {
        return reply.code(400).send({ error: "Unknown remote target" });
      }
```

and pass `target` into the `scheduledTasks.create({ ... })` call (add `target,` to the object).

- [ ] **Step 3: Validate + persist `target` in the update handler**

In the `PUT /api/schedules/:id` handler, after the merged-shape validation, resolve the effective target and validate it when changing to a remote:

```ts
      const nextTarget = b.target !== undefined ? b.target : existing.target;
      if (nextTarget !== "local" && !fastify.storage.projectRemotes.getByProjectAndServer(existing.project_id, nextTarget)) {
        return reply.code(400).send({ error: "Unknown remote target" });
      }
```

and add `target: b.target` to the `scheduledTasks.update(req.params.id, { ... })` opts (only when `b.target !== undefined`, matching how the other optional fields are threaded — e.g. `target: b.target`).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: Manual e2e — validation + persistence**

Build and start a throwaway instance:

```bash
pnpm build:main
mkdir -p /tmp/vdx-sched-remote && rm -f /tmp/vdx-sched-remote/data.sqlite*
node packages/vibedeckx/dist/bin.js start --port 5199 --data-dir /tmp/vdx-sched-remote > /tmp/vdx-sched-remote.log 2>&1 &
sleep 3
PID=$(curl -s -X POST http://127.0.0.1:5199/api/projects -H 'Content-Type: application/json' -d '{"name":"t","path":"/tmp"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).project.id))')
echo "== unknown target -> expect 400 =="
curl -s -w "\nHTTP %{http_code}\n" -X POST http://127.0.0.1:5199/api/projects/$PID/schedules -H 'Content-Type: application/json' -d '{"name":"r","cron_expr":"0 9 * * *","content":"echo hi","cwd_mode":"branch","target":"nope"}'
echo "== local target omitted -> expect 201, target 'local' =="
curl -s -X POST http://127.0.0.1:5199/api/projects/$PID/schedules -H 'Content-Type: application/json' -d '{"name":"ok","cron_expr":"0 9 * * *","content":"echo hi","cwd_mode":"directory","directory":"/tmp"}'
kill %1
```

Expected: first call `HTTP 400` `{"error":"Unknown remote target"}`; second returns a schedule with `"target":"local"`.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/routes/schedule-routes.ts
git commit -m "feat: schedule routes accept + validate target"
```

---

### Task 4: Frontend — `target` types + Target selector in the form

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` (`Schedule` + `ScheduleInput` gain `target`)
- Modify: `apps/vibedeckx-ui/components/schedule/schedule-form-dialog.tsx` (Target `<Select>`, remote branch as text input)

**Interfaces:**
- Consumes: `api.getProjectRemotes(projectId): Promise<ProjectRemote[]>` and `ProjectRemote` (`{ id, remote_server_id, remote_path, server_name?, server_url }`, existing in `lib/api.ts`); `Worktree[]` (existing form prop).
- Produces: `Schedule.target: string`; `ScheduleInput.target: string`; the form emits `target` in its submitted `ScheduleInput`.

- [ ] **Step 1: Add `target` to the shared interfaces**

In `apps/vibedeckx-ui/lib/api.ts`, add `target: string;` to the `Schedule` interface (after `timezone`) and `target: string;` to `ScheduleInput` (after `timezone`).

- [ ] **Step 2: Add a Target selector to the form**

In `apps/vibedeckx-ui/components/schedule/schedule-form-dialog.tsx`:

(a) Import the project-remotes API + type. Add remote state and an **optional** `projectId` prop to the component's props (optional so existing callers in `schedules-view.tsx` still compile — Task 5 wires the actual value; the effect no-ops when `projectId` is undefined):

```tsx
import { api, type ProjectRemote, type Schedule, type ScheduleInput, type Worktree } from "@/lib/api";
```

Add `projectId?: string;` to the `ScheduleFormDialog` props type and destructure it. Add near the other `useState` hooks:

```tsx
  const [target, setTarget] = useState<string>("local");
  const [remotes, setRemotes] = useState<ProjectRemote[]>([]);
```

(b) Load remotes when the dialog opens (guard the effect body so it only fetches when open + projectId present — satisfies the react-hooks compiler rule by keeping the fetch inside a conditional, effect always returns cleanup):

```tsx
  useEffect(() => {
    let cancelled = false;
    if (open && projectId) {
      api.getProjectRemotes(projectId)
        .then((r) => { if (!cancelled) setRemotes(r); })
        .catch((err) => console.error("Failed to load project remotes:", err));
    }
    return () => { cancelled = true; };
  }, [open, projectId]);
```

(c) In the existing "re-seed on open" effect, also seed `target`:

```tsx
    setTarget(initial?.target ?? "local");
```

(d) Add the Target `<Select>` in the JSX, above the existing "Runs in" (cwd_mode) controls:

```tsx
        <div className="space-y-2">
          <label className="text-sm font-medium">Target</label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local</SelectItem>
              {remotes.map((r) => (
                <SelectItem key={r.remote_server_id} value={r.remote_server_id}>
                  {r.server_name ?? r.server_url ?? r.remote_server_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
```

(e) Branch source per target. In the `cwd_mode === "branch"` branch of the form:
- when `target === "local"`, keep the existing branch `<Select>` fed by `worktrees`.
- when `target !== "local"`, render a free-text branch input instead (V1 — a remote-branch dropdown is a deferred follow-up):

```tsx
          {cwdMode === "branch" && target !== "local" && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Workspace (branch on remote)</label>
              <Input
                placeholder="main"
                value={branch === MAIN ? "" : branch}
                onChange={(e) => setBranch(e.target.value || MAIN)}
              />
            </div>
          )}
          {cwdMode === "branch" && target === "local" && (
            /* existing worktree-fed branch Select, unchanged */
          )}
```

(f) Include `target` in the submitted `ScheduleInput`:

```tsx
      const input: ScheduleInput = {
        // ...existing fields...
        target,
      };
```

(Keep the existing directory-mode input working under any target — its label can stay "Directory"; when a remote is selected it is the absolute path on the remote box.)

- [ ] **Step 3: Type-check + lint the touched files**

Run:
```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && npx eslint components/schedule/schedule-form-dialog.tsx lib/api.ts
```
Expected: tsc exit 0; eslint exit 0 (no ref-in-render / setState-in-effect violations).

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/components/schedule/schedule-form-dialog.tsx
git commit -m "feat: schedule form target selector (local | remote)"
```

---

### Task 5: Frontend — remote badge, page wiring, and remote e2e

**Files:**
- Modify: `apps/vibedeckx-ui/app/page.tsx` (pass `projectId` to `ScheduleFormDialog` via `SchedulesView`, if not already threaded)
- Modify: `apps/vibedeckx-ui/components/schedule/schedules-view.tsx` (pass `projectId` down to the form; show a small remote badge in the list/detail)
- Modify: `apps/vibedeckx-ui/components/layout/app-sidebar.tsx` (optional: remote badge on sidebar rows)

**Interfaces:**
- Consumes: `Schedule.target` (Task 4); `ProjectRemote` names (optional, for the badge label).
- Produces: the form receives `projectId`; schedules with `target !== "local"` show a remote indicator.

- [ ] **Step 1: Thread `projectId` into the form**

`ScheduleFormDialog` now needs `projectId` (Task 4 Step 2a). In `schedules-view.tsx`, add a `projectId: string` prop to `SchedulesView`, and pass it to both `<ScheduleFormDialog projectId={projectId} .../>` usages (create + edit). In `app/page.tsx`, pass `projectId={currentProject?.id ?? ""}` to `<SchedulesView .../>` (it is only mounted when `currentProject` exists, so the empty-string fallback is never used in practice).

- [ ] **Step 2: Show a remote badge**

In `schedules-view.tsx`, in the schedule detail header (and/or each list row), when `schedule.target !== "local"` render a small badge with the target label:

```tsx
{schedule.target !== "local" && (
  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-600">
    remote
  </span>
)}
```

(Keep it minimal; the literal "remote" is fine for V1. A per-server name is optional polish.)

- [ ] **Step 3: Type-check + lint**

Run:
```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && npx eslint components/schedule/schedules-view.tsx app/page.tsx components/layout/app-sidebar.tsx
```
Expected: tsc exit 0; eslint exit 0.

- [ ] **Step 4: Remote e2e with a second instance acting as the remote**

This exercises the full remote path against a real reachable remote (a second local vibedeckx instance started with `--accept-remote` + an API key).

```bash
pnpm build:main
# Remote instance (the "remote server"):
mkdir -p /tmp/vdx-remote-srv && rm -f /tmp/vdx-remote-srv/data.sqlite*
VIBEDECKX_API_KEY=testkey node packages/vibedeckx/dist/bin.js start --port 5300 --accept-remote --data-dir /tmp/vdx-remote-srv > /tmp/vdx-remote-srv.log 2>&1 &
# Control instance:
mkdir -p /tmp/vdx-control && rm -f /tmp/vdx-control/data.sqlite*
node packages/vibedeckx/dist/bin.js start --port 5173 --data-dir /tmp/vdx-control > /tmp/vdx-control.log 2>&1 &
sleep 3
# Frontend dev (proxies to 5173):
pnpm dev > /tmp/vdx-fe.log 2>&1 &
# Wait for the frontend, then drive the browser (playwright-core is resolvable from packages/vibedeckx).
```

Steps to verify (script with playwright-core, or drive by REST if the browser is unavailable):
1. Create a project on the control server; register a remote (`POST /api/projects/:id/remotes` with `{ remoteServerId, remotePath: "/tmp" }`) pointing at the 5300 instance's remote-server row (create it via `POST /api/remote-servers` with `url: http://127.0.0.1:5300`, `api_key: testkey`).
2. In the UI, open the schedule form, pick the remote in **Target**, `cwd_mode = directory`, directory `/tmp`, command `echo scheduled-remote-hello`, create.
3. Confirm the sidebar row shows the **remote** badge.
4. Click **Run now**; confirm the run appears `running` then `completed`, and the run-output dialog shows `scheduled-remote-hello`.
5. Confirm on the remote instance's log (`/tmp/vdx-remote-srv.log`) that `/api/path/execute` was hit.

Cleanup:
```bash
pkill -f "dist/bin.js start"; pkill -f "next dev"
rm -rf /tmp/vdx-remote-srv /tmp/vdx-control
```

Record the outcome (pass/fail per step) in the task report. If the browser/playwright is unavailable in the environment, drive steps 1–2 and 4–5 via REST (`POST /api/projects/:id/schedules` with `target`, then `POST /api/schedules/:id/run`, then `GET /api/schedule-runs/:runId`) and note that the badge (step 3) was verified by tsc/inspection only.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/app/page.tsx apps/vibedeckx-ui/components/schedule/schedules-view.tsx apps/vibedeckx-ui/components/layout/app-sidebar.tsx
git commit -m "feat: remote schedule badge + form projectId wiring"
```

---

## Deferred (out of scope for this plan)

- Full-output parity for remote runs (200k raw instead of 10k ANSI-stripped tailOutput).
- Remote-branch **dropdown** (V1 uses a free-text branch input for remote targets).
- Offline catch-up / running the scheduler on the remote box itself.
- Per-target disable (`disabled_targets`) for schedules.
