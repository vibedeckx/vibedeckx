# Schedule Remote Execution — Design Spec

## Goal

Let a scheduled task run on a **remote server**, the same way a remote Executor
runs. When creating/editing a schedule the user picks a **target** (Local, or
one of the project's configured remote servers). The target is orthogonal to the
existing working-directory model, giving four run locations:

| | `cwd_mode = directory` | `cwd_mode = branch` |
|---|---|---|
| **target = local** | fixed absolute directory, locally | local branch worktree |
| **target = remote** | fixed absolute directory on the remote box | that remote's workspace for the branch |

This builds on the shipped scheduled-tasks feature
(`docs/superpowers/plans/2026-07-02-scheduled-tasks.md`, commits `952653c..762e718`),
which currently runs local-only.

## Non-goals

- No change to the remote server's code. The existing remote endpoint
  `POST /api/path/execute` already covers both remote run locations (see
  Execution below), so this is a **control-server-only** change.
- No full-output parity for remote runs in V1 (see Output capture).
- No independent per-schedule "disabled targets" concept (a schedule targets
  exactly one place). Executors' `disabled_targets` is not mirrored.
- No offline catch-up. As with remote executors, if the control server is down
  at fire time the run does not trigger (see Constraints).

## Key architecture insight

A remote executor already runs by proxying `POST /api/path/execute` to the
remote, which resolves the working directory **on the remote side** and calls
its own `processManager.start(executor, cwd, skipDb=true)`. Both of our remote
run locations map onto that one endpoint with no remote change:

- **remote + branch** → proxy `{ path: remote_path, branch }`. The remote runs
  `resolveWorktreePath(remote_path, branch)` → the workspace.
- **remote + directory** → proxy `{ path: <absolute dir>, branch: null }`.
  `resolveWorktreePath` returns `projectPath` immediately when `branch` is falsy
  (`utils/worktree-paths.ts:103` — `if (!branch) return projectPath;`), so the
  remote runs directly in that absolute directory, no containment guard applied.

Completion + output are observed headlessly by the existing
`RemoteExecutorMonitor`, which watches the remote process's log WS server-side
and emits an `executor:stopped { exitCode, tailOutput }` event on the event bus —
no frontend WS client required.

## Data model

`scheduled_tasks` gains one column:

```sql
target TEXT NOT NULL DEFAULT 'local'   -- 'local' | <remote_server_id>
```

- Migration follows the existing idiom in `createDatabase` (`storage/sqlite.ts`):
  a `PRAGMA table_info(scheduled_tasks)` guard + `ALTER TABLE scheduled_tasks ADD
  COLUMN target TEXT NOT NULL DEFAULT 'local'`. (New-DB path also carries it in
  the `CREATE TABLE`.)
- `ScheduledTask` (types.ts) gains `target: string`. `scheduledTasks.create` and
  `.update` accept `target` (default `'local'`), mapped like the other columns.
- Frontend `Schedule` and `ScheduleInput` gain `target: string` (default
  `'local'`).

`target` only affects execution when set to a remote id; `cwd_mode` / `branch` /
`directory` keep their current meanings under either target.

## Execution — `scheduler.ts` `executeRun`

`executeRun` becomes `async`. After the existing overlap-skip guard, it branches
on `task.target`.

### Local branch (unchanged)

Resolve cwd (`directory` → `task.directory`; `branch` →
`resolveWorktreePath(project.path, task.branch)`), `existsSync(cwd)` check,
`processManager.start(fabricatedExecutor, cwd, true)`, capture via
`processManager.subscribe`, timeout via `processManager.stop`.

### Remote branch (new)

1. `remoteConfig = storage.projectRemotes.getByProjectAndServer(task.project_id,
   task.target)`. Missing → `failWithoutStart(task, runId, "Remote server config
   not found")`.
2. Derive the proxy payload from `cwd_mode`:
   - `branch` → `{ path: remoteConfig.remote_path, branch: task.branch }`
   - `directory` → `{ path: task.directory, branch: null }`
   - (No local `existsSync`; the remote reports a bad directory as a failed run.)
3. `const result = await proxyToRemoteAuto(task.target, remoteConfig.server_url ??
   "", remoteConfig.server_api_key || "", "POST", "/api/path/execute", { path,
   command: task.content, executor_type: task.run_type, prompt_provider:
   task.run_type === "prompt" ? "claude" : null, branch, pty: true },
   { reverseConnectManager: this.reverseConnectManager })`
   (`utils/remote-proxy.ts:185`). `!result.ok` → `failWithoutStart` with the
   error text.
4. `remoteProcessId = result.data.processId`; synthesize
   `localProcessId = \`remote-schedule-${task.id}-${remoteProcessId}\``.
5. Register with the shared remote infra so the monitor watches it:
   - `this.remoteExecutorMap.set(localProcessId, remoteInfo)`
   - `this.remoteExecutorMonitor.watch(localProcessId, remoteInfo)`
   where `remoteInfo = { remoteServerId: task.target, remoteUrl:
   remoteConfig.server_url ?? "", remoteApiKey: remoteConfig.server_api_key || "",
   remoteProcessId, executorId: \`schedule-${task.id}\`, projectId:
   task.project_id }` (`server-types.ts:13` `RemoteExecutorInfo`).
6. Persist the run row (`status: "running"`, `process_id: localProcessId`), set
   `activeRuns`, emit `schedule:run-started`.

The fabricated `executorId` `schedule-<id>` never matches a real executor, so the
`executor:stopped` event the monitor later emits is ignored by the frontend
`use-executors` hook (it filters by known executor ids) — no UI cross-talk, same
as the local fabricated-executor events today.

## Completion detection (the one mechanism change)

The remote process is not in the local `ProcessManager`, so
`processManager.subscribe(localProcessId, …)` returns `null`. The remote branch
instead subscribes to the **event bus**:

```ts
unsubscribe = this.eventBus.subscribe((e) => {
  if (e.type === "executor:stopped" && e.processId === localProcessId) {
    finalize(e.exitCode === 0 ? "completed" : "failed", e.exitCode, e.tailOutput ?? "");
  }
});
```

`RemoteExecutorMonitor` emits that event when the remote process finishes
(`remote-executor-monitor.ts` — dedup-guarded by `RemoteExecutorInfo.stoppedEmitted`,
also fabricates a `finished` if the upstream WS closes without one, so a silently
dying remote still finalizes). `e.tailOutput` is the captured output.

`finalize` and `releaseRunResources` are reused, with the per-run
`releaseRunResources` doing "clearTimeout + eventBus `unsubscribe()`" for a remote
run instead of "clearTimeout + processManager unsubscribe". The existing
`finalized` single-finish guard, `activeRuns`/`activeRunCleanups` maps, and
`shutdown()` semantics carry over unchanged (shutdown cancels the timer +
unsubscribes, leaves the row `running`, and the SQLite startup fixup marks it
`killed` on next boot).

## Output capture — V1 decision

Remote runs persist `executor:stopped.tailOutput` = **last 10,000 chars,
ANSI-stripped** (what `RemoteExecutorMonitor` already surfaces). Local runs keep
their 200,000-char raw capture. Accepted for V1: it is exactly the
"run-like-a-remote-executor" behavior, needs no new infrastructure, and ANSI
stripping matches the frontend's `<pre>` rendering. Full-output parity (driving
`attachRemoteProcessStream` with a buffering sink, or raising the monitor's cap)
is a deferred follow-up.

## Timeout — remote branch

The local timeout calls `processManager.stop(processId)`, invalid for a remote
handle. The remote branch's timeout proxies the remote stop endpoint instead:

```ts
timer = setTimeout(async () => {
  await proxyToRemoteAuto(task.target, remoteConfig.server_url ?? "",
    remoteConfig.server_api_key || "", "POST",
    `/api/executor-processes/${remoteProcessId}/stop`, undefined,
    { reverseConnectManager: this.reverseConnectManager });
  finalize("timeout", null);
}, task.timeout_seconds * 1000);
timer.unref();
```

Stopping the remote makes it send `finished`; the monitor's follow-up
`executor:stopped` is swallowed by the `finalized` guard.

## Routes — `schedule-routes.ts`

- Create and update: when `target !== "local"`, validate
  `storage.projectRemotes.getByProjectAndServer(projectId, target)` exists → 400
  `"Unknown remote target"` otherwise. Reuse the shared `validateResolved` for
  cron/timezone/content/directory checks (directory must still be absolute for
  both targets).
- `target` is accepted in the create/update body (default `'local'`), passed
  through to storage.
- No remote-proxy branches in the route layer itself — CRUD/run/history all stay
  on the control server's DB and scheduler; only the scheduler's *execution*
  reaches out to the remote.

## Dependency injection — `plugins/shared-services.ts`

`SchedulerService` currently receives `(storage, processManager)` and is
constructed before the remote managers exist. To reach the remote path it also
needs `reverseConnectManager`, `remoteExecutorMap`, and `remoteExecutorMonitor`.

Move `new SchedulerService(...)` **below** the creation of those managers
(`reverseConnectManager`, `remoteExecutorMonitor`, `remoteExecutorMap`) and pass
them into the constructor. `eventBus` continues via `setEventBus`. `start()` /
`shutdown()` wiring is unchanged. `server-types.ts` needs no new decoration (the
scheduler already carries these internally).

## Frontend

- **Form** (`schedule-form-dialog.tsx`): add a **Target** `<Select>` (options:
  "Local" + each `ProjectRemoteWithServer` from `api.getProjectRemotes(projectId)`).
  Keep the `cwd_mode` toggle (directory | branch) under any target. The branch
  picker's source depends on target: local worktrees for Local, the remote's
  branches (`GET /api/projects/:id/branches?target=<remote>`, or the path-based
  equivalent) for a remote target. Directory mode is a plain absolute-path input
  under either target (labelled "path on the remote" when a remote is selected).
- **Types** (`lib/api.ts`): `Schedule` and `ScheduleInput` gain `target: string`.
- **Detail / sidebar**: show a small remote-name badge on schedules whose
  `target !== "local"` (light polish; not load-bearing).

## Constraints (documented, not enforced in code)

- The scheduler runs on the **control server**; a remote schedule only fires when
  the control server is up at the cron instant. This matches remote-executor
  behavior (you trigger a remote executor from the control server too).
- Remote run output is capped/stripped as above.
- No remote-server code change is required; the remote must simply be reachable
  (outbound HTTP or an active reverse-connect channel) at fire time, exactly as
  for a manually-run remote executor.

## Testing

- **Storage** (`scheduled-tasks.test.ts`): `target` column defaults to `'local'`,
  round-trips through create/update, survives the migration guard on an existing
  DB.
- **Scheduler** (`scheduler.test.ts`): with a fake `proxyToRemoteAuto` /
  fake remote infra, a `target=remote` run (a) proxies `/api/path/execute` with
  the right payload for each `cwd_mode`, (b) finalizes `completed`/`failed` from a
  synthesized `executor:stopped` on the event bus, storing `tailOutput`, (c) on
  timeout proxies the remote stop endpoint and records `timeout`, (d) a missing
  `projectRemotes` row yields a `failed` run without a proxy call. Reuse the
  existing fake-ProcessManager harness style; add a fake EventBus + fake remote
  proxy seam (inject the proxy fn or wrap it behind a small method so tests can
  stub it).
- **Routes**: unknown remote target → 400 (verified by inspection + curl e2e, per
  the repo's no-route-tests convention).
- **UI e2e**: create a `target=remote` schedule, Run now, confirm the run reaches
  the remote and the history shows `completed` with output — using an actual
  reachable remote (reverse-connect or a second local instance with
  `--accept-remote`).

## Deferred follow-ups

- Full-output parity for remote runs (200k raw).
- Offline catch-up / making the remote box itself the scheduler (the "always-on"
  variant) remains out of scope.

(Note: "remote + fixed directory" is **in scope** — it needs no special handling
because `path=<dir>, branch=null` runs there directly. The remote applies no
containment guard to that absolute path, which is acceptable since it is the
user's own reachable remote box.)
