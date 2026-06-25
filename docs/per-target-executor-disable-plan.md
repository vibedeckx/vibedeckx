# Per-target Executor Disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an executor's disabled state per-target (per `"local"` / per `remote_server_id`) instead of a single global boolean, so an executor can be disabled on one remote while remaining runnable on another.

**Architecture:** Replace the global `executors.disabled INTEGER` column with `disabled_targets TEXT` — a JSON array of target ids, parsed/serialized at the SQLite storage boundary so every layer above sees `string[]`. The start guard checks membership after the target is resolved; the UI toggle reads/writes only the currently-selected target via a server-side read-modify-write on `PUT /api/executors/:id`.

**Tech Stack:** Fastify + better-sqlite3 (backend, ESM/NodeNext — local imports need `.js`), Next.js 16 / React 19 (frontend), `sonner` toasts.

## Global Constraints

- This repo has **no test framework** (per CLAUDE.md). The per-task verification gate is a clean type-check, plus a manual behavior check at the end. There are no unit tests to write.
- Backend type-check: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
- Frontend type-check: `cd apps/vibedeckx-ui && npx tsc --noEmit`
- Frontend lint: `pnpm --filter vibedeckx-ui lint`
- A "target" id is the string `"local"` or a `remote_server_id` (UUID) — the exact same namespace already used as keys in `last_runs`.
- Disabled semantics: presence of a target id in `disabled_targets` = disabled for that target; absence = enabled.
- Backend type change ripples across storage + both route files; they must be edited together so the backend stays type-checkable. That is why Task 1 is a single backend task.

---

### Task 1: Backend — per-target disabled storage, migration, and start guard

**Files:**
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (CREATE TABLE ~line 49; old migration ~lines 230-234; new migration after the project_remotes migration ~line 490; `ExecutorRow` type + `mapExecutorRow` ~lines 695-702; `executors.create` ~lines 1215-1230; `executors.update` ~lines 1253-1294)
- Modify: `packages/vibedeckx/src/storage/types.ts` (`Executor` interface ~lines 70-85; `executors.create`/`executors.update` opts ~lines 264-268)
- Modify: `packages/vibedeckx/src/routes/executor-routes.ts` (create body ~lines 87-122; update handler ~lines 124-157)
- Modify: `packages/vibedeckx/src/routes/process-routes.ts` (`tempExecutor` ~line 35; start guard ~lines 62-67)

**Interfaces:**
- Produces:
  - `Executor.disabled_targets: string[]` (replaces `Executor.disabled: boolean`) — on both `storage/types.ts` and consumed by the frontend `lib/api.ts` in Task 2.
  - `storage.executors.update(id, { ..., disabled_targets?: string[] })` — write the whole array; the route does the read-modify-write.
  - `PUT /api/executors/:id` additionally accepts `{ target?: string; disabled?: boolean }` and, when both are present, toggles that one target's membership in `disabled_targets`.
- Consumes: `storage.projectRemotes.getByProject(projectId)` (existing) is **not** used in the route; the route reads `existing.disabled_targets` and `existing.project_id` only.

- [ ] **Step 1: Swap the schema column in CREATE TABLE**

In `packages/vibedeckx/src/storage/sqlite.ts`, in the `CREATE TABLE IF NOT EXISTS executors` block, replace the `disabled` line:

```
      disabled INTEGER DEFAULT 0,
```

with:

```
      disabled_targets TEXT DEFAULT '[]',
```

- [ ] **Step 2: Remove the obsolete add-`disabled` migration**

Still in `sqlite.ts`, delete this entire block (it would otherwise resurrect the column we are about to drop, on every startup):

```js
  // Migration: add disabled column to executors table
  const hasDisabledColumn = tableInfo.some((col) => col.name === "disabled");
  if (!hasDisabledColumn) {
    db.exec("ALTER TABLE executors ADD COLUMN disabled INTEGER DEFAULT 0");
  }
```

- [ ] **Step 3: Add the per-target migration after the project_remotes migration**

In `sqlite.ts`, find the migration that backfills `remote_servers` + `project_remotes` (around line 454-490, the block commented "existing remote projects → remote_servers + project_remotes"). Immediately **after** that block (so a project's migrated remotes are already present), add:

```js
  // Migration: executor.disabled (global bool) → executor.disabled_targets
  // (JSON array of target ids: "local" or a remote_server_id). A disabled
  // executor becomes disabled on every current target of its project, then the
  // old column is dropped. New remotes added later default to enabled.
  const execColsForDisabled = db.prepare("PRAGMA table_info(executors)").all() as { name: string }[];
  if (!execColsForDisabled.some((c) => c.name === "disabled_targets")) {
    db.exec("ALTER TABLE executors ADD COLUMN disabled_targets TEXT DEFAULT '[]'");
  }
  if (execColsForDisabled.some((c) => c.name === "disabled")) {
    const migrateDisabled = db.transaction(() => {
      const disabledRows = db
        .prepare("SELECT id, project_id FROM executors WHERE disabled = 1")
        .all() as { id: string; project_id: string }[];
      for (const row of disabledRows) {
        const remotes = db
          .prepare("SELECT remote_server_id FROM project_remotes WHERE project_id = ?")
          .all(row.project_id) as { remote_server_id: string }[];
        const targets = ["local", ...remotes.map((r) => r.remote_server_id)];
        db.prepare("UPDATE executors SET disabled_targets = @dt WHERE id = @id").run({
          dt: JSON.stringify(targets),
          id: row.id,
        });
      }
      db.exec("ALTER TABLE executors DROP COLUMN disabled");
    });
    migrateDisabled();
  }
```

- [ ] **Step 4: Update the row type and row mapper**

In `sqlite.ts`, change the `ExecutorRow` helper type (~line 695) — replace `disabled: number;` with `disabled_targets: string;`:

```ts
  type ExecutorRow = { id: string; project_id: string; group_id: string; name: string; command: string; executor_type: string; prompt_provider: string | null; cwd: string | null; pty: number; position: number; disabled_targets: string; created_at: string };
```

And in `mapExecutorRow` (~line 696-702), replace `disabled: row.disabled === 1,` with a parse:

```ts
  const mapExecutorRow = (row: ExecutorRow): Executor => ({
    ...row,
    executor_type: (row.executor_type || 'command') as ExecutorType,
    prompt_provider: (row.prompt_provider as PromptProvider) ?? null,
    pty: row.pty === 1,
    disabled_targets: row.disabled_targets ? JSON.parse(row.disabled_targets) as string[] : [],
  });
```

- [ ] **Step 5: Drop `disabled` from `executors.create`**

In `sqlite.ts`, `executors.create` (~lines 1215-1224). New executors always start enabled everywhere (`'[]'`, the column default), so remove `disabled` from the destructured opts, the column list, and the params. Replace the create body with:

```ts
      create: ({ id, project_id, group_id, name, command, executor_type, prompt_provider, cwd, pty }) => {
        // Get max position for this group
        const maxPos = db.prepare<{ group_id: string }, { max_pos: number | null }>(
          `SELECT MAX(position) as max_pos FROM executors WHERE group_id = @group_id`
        ).get({ group_id });
        const position = (maxPos?.max_pos ?? -1) + 1;

        db.prepare(
          `INSERT INTO executors (id, project_id, group_id, name, command, executor_type, prompt_provider, cwd, pty, position) VALUES (@id, @project_id, @group_id, @name, @command, @executor_type, @prompt_provider, @cwd, @pty, @position)`
        ).run({ id, project_id, group_id, name, command, executor_type: executor_type ?? 'command', prompt_provider: prompt_provider ?? null, cwd: cwd ?? null, pty: pty !== false ? 1 : 0, position });

        const row = db
          .prepare<{ id: string }, ExecutorRow>(`SELECT * FROM executors WHERE id = @id`)
          .get({ id })!;
        return mapExecutorRow(row);
      },
```

- [ ] **Step 6: Replace `disabled` with `disabled_targets` in `executors.update`**

In `sqlite.ts`, `executors.update` (~line 1253), change the opts type — replace `disabled?: boolean` with `disabled_targets?: string[]`:

```ts
      update: (id: string, opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean; disabled_targets?: string[] }) => {
```

And replace the `if (opts.disabled !== undefined) { ... }` block (~lines 1281-1284) with:

```ts
        if (opts.disabled_targets !== undefined) {
          updates.push('disabled_targets = @disabled_targets');
          params.disabled_targets = JSON.stringify(opts.disabled_targets);
        }
```

- [ ] **Step 7: Update the storage `types.ts` interfaces**

In `packages/vibedeckx/src/storage/types.ts`, `Executor` interface (~line 83) — replace `disabled: boolean;` with:

```ts
  // Target ids ("local" or a remote_server_id) on which this executor is
  // disabled. Empty = runnable everywhere. Absence of a target = enabled there.
  disabled_targets: string[];
```

In the same file, the `executors` storage interface (~lines 264-268): remove `disabled?: boolean` from the `create` opts, and in `update` opts replace `disabled?: boolean` with `disabled_targets?: string[]`:

```ts
    create: (opts: { id: string; project_id: string; group_id: string; name: string; command: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string; pty?: boolean }) => Executor;
    getByProjectId: (projectId: string) => Executor[];
    getByGroupId: (groupId: string) => Executor[];
    getById: (id: string) => Executor | undefined;
    update: (id: string, opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean; disabled_targets?: string[] }) => Executor | undefined;
```

(If the `create`/`update` lines in `types.ts` differ slightly in field order, keep the existing fields and only make the two changes: drop `disabled?` from `create`, swap `disabled?: boolean` → `disabled_targets?: string[]` in `update`.)

- [ ] **Step 8: Drop `disabled` from the create route**

In `packages/vibedeckx/src/routes/executor-routes.ts`, the create handler (~lines 87-122). Remove `disabled` from the `Body` type, the destructure, and the `executors.create(...)` call:

```ts
  fastify.post<{
    Params: { projectId: string };
    Body: { name: string; command: string; executor_type?: string; prompt_provider?: string; cwd?: string; pty?: boolean; group_id: string };
  }>("/api/projects/:projectId/executors", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { name, command, executor_type, prompt_provider, cwd, pty, group_id } = req.body;
    if (!group_id) {
      return reply.code(400).send({ error: "group_id is required" });
    }

    const parsedType = (executor_type === 'prompt' ? 'prompt' : 'command') as ExecutorType;
    const parsedProvider = (prompt_provider === 'codex' ? 'codex' : 'claude') as PromptProvider;

    const id = randomUUID();
    const executor = fastify.storage.executors.create({
      id,
      project_id: req.params.projectId,
      group_id,
      name,
      command,
      executor_type: parsedType,
      prompt_provider: parsedType === 'prompt' ? parsedProvider : null,
      cwd,
      pty,
    });

    return reply.code(201).send({ executor });
  });
```

- [ ] **Step 9: Add the per-target toggle to the update route**

In `executor-routes.ts`, the `PUT /api/executors/:id` handler (~lines 124-157). Add `target` + `disabled` to the `Body` type, and after the ownership check do a read-modify-write to compute the new `disabled_targets` before building `updateOpts`. Replace the handler from the `Body` type through the `update` call with:

```ts
  // 更新 Executor
  fastify.put<{
    Params: { id: string };
    Body: { name?: string; command?: string; executor_type?: string; prompt_provider?: string; cwd?: string | null; pty?: boolean; target?: string; disabled?: boolean };
  }>("/api/executors/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const existing = fastify.storage.executors.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Executor not found" });
    }
    // Confirm the caller owns the executor's project — otherwise one tenant
    // could rewrite another tenant's executor command by id.
    const project = fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { executor_type, prompt_provider, target, disabled, ...rest } = req.body;
    const parsedType = executor_type !== undefined
      ? (executor_type === 'prompt' ? 'prompt' : 'command') as ExecutorType
      : undefined;
    const parsedProvider = prompt_provider !== undefined
      ? (prompt_provider === 'codex' ? 'codex' : 'claude') as PromptProvider
      : undefined;

    // Per-target disable toggle: read the current set, add/remove this one
    // target, and persist the whole array. Server-side RMW so the client never
    // clobbers the set and concurrent toggles can't race on a stale array.
    let disabledTargetsUpdate: { disabled_targets: string[] } | undefined;
    if (target !== undefined && disabled !== undefined) {
      const current = new Set(existing.disabled_targets);
      if (disabled) current.add(target);
      else current.delete(target);
      disabledTargetsUpdate = { disabled_targets: [...current] };
    }

    const updateOpts = {
      ...rest,
      ...(parsedType !== undefined ? { executor_type: parsedType } : {}),
      ...(parsedProvider !== undefined ? { prompt_provider: parsedProvider } : {}),
      ...(disabledTargetsUpdate ?? {}),
    };
    const executor = fastify.storage.executors.update(req.params.id, updateOpts);
    return reply.code(200).send({ executor });
  });
```

- [ ] **Step 10: Fix the `tempExecutor` literal**

In `packages/vibedeckx/src/routes/process-routes.ts` (~line 35), the inline `tempExecutor` object is typed as an `Executor`. Replace `disabled: false,` with:

```ts
      disabled_targets: [],
```

- [ ] **Step 11: Make the start guard target-aware**

Still in `process-routes.ts`, the start handler (~lines 48-101). The current guard at lines 62-67 runs **before** `executorMode` is resolved. Delete that early guard block:

```ts
    // Disabled executors must not run on any target (local or remote). The flag
    // is stored on the locally-held executor config, so this gate applies even
    // when execution would otherwise be proxied to a remote server.
    if (executor.disabled) {
      return reply.code(409).send({ error: "Executor is disabled" });
    }
```

Then, after the two `executorMode` fallback blocks resolve the final target (immediately **before** the `const remoteConfig = useRemoteExecutor ...` line, ~line 98), add the per-target guard:

```ts
    // Block start only on the resolved target. An executor disabled on "local"
    // can still run on a remote, and vice-versa. Evaluated on the controller
    // before any proxy, so it covers both local and remote starts.
    if (executor.disabled_targets.includes(executorMode)) {
      return reply.code(409).send({ error: "Executor is disabled for this target" });
    }
```

- [ ] **Step 12: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no output (clean). If errors mention `disabled` on an executor, grep for any remaining `.disabled` read in `packages/vibedeckx/src` and convert it to `disabled_targets`.

- [ ] **Step 13: Commit**

```bash
git add packages/vibedeckx/src/storage/sqlite.ts packages/vibedeckx/src/storage/types.ts packages/vibedeckx/src/routes/executor-routes.ts packages/vibedeckx/src/routes/process-routes.ts
git commit -m "feat: make executor disabled state per-target"
```

---

### Task 2: Frontend — types, per-target derivation, and the active-target toggle

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` (`Executor` interface ~lines 315-336; `createExecutor` opts ~line 980; `updateExecutor` opts ~line 996)
- Modify: `apps/vibedeckx-ui/hooks/use-executors.ts` (`ExecutorWithProcess` ~lines 63-72; `updateExecutor` opts ~line 266; per-target map ~lines 433-449)
- Modify: `apps/vibedeckx-ui/components/executor/executor-item.tsx` (`ExecutorItemProps.onUpdate` ~line 45; `isDisabled` ~line 151; toggle ~line 252)

**Interfaces:**
- Consumes: `Executor.disabled_targets: string[]` (from Task 1); `PUT /api/executors/:id` accepting `{ target, disabled }`.
- Produces: `ExecutorWithProcess.isDisabled: boolean` (computed for the active target) — read by `executor-item.tsx`.

- [ ] **Step 1: Update the `Executor` type and create/update opts in `lib/api.ts`**

In `apps/vibedeckx-ui/lib/api.ts`, `Executor` interface (~line 328) — replace `disabled: boolean;` (and its comment) with:

```ts
  // Target ids ("local" or a remote_server_id) on which this executor is
  // disabled. The UI checks membership for the currently-selected target.
  disabled_targets: string[];
```

In `createExecutor` opts (~line 980), remove `disabled?: boolean;` (nothing passes it):

```ts
    opts: { name: string; command: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string; pty?: boolean; group_id: string }
```

In `updateExecutor` opts (~line 996), replace `disabled?: boolean` with the per-target pair (the body is already `JSON.stringify(opts)`, so no other change is needed):

```ts
    opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean; target?: string; disabled?: boolean }
```

- [ ] **Step 2: Derive `isDisabled` per target in the hook**

In `apps/vibedeckx-ui/hooks/use-executors.ts`, add `isDisabled` to `ExecutorWithProcess` (~lines 63-72):

```ts
export interface ExecutorWithProcess extends Executor {
  currentProcessId: string | null;
  isRunning: boolean;
  // Fallback handle and timestamp for the most recent run on the currently
  // selected target (local or a specific remote). Both are derived from
  // executor.last_runs[targetMode], so they reflect what happened on this
  // target only — never the global most-recent across all targets.
  lastProcessId: string | null;
  lastStartedAt: string | null;
  // Whether this executor is disabled on the currently-selected target.
  isDisabled: boolean;
}
```

Then in the `executorsWithProcess` map (~lines 433-449), compute it alongside `lastRun` (which already uses `targetMode`) and return it:

```ts
    const lastRun = executor.last_runs?.[targetMode];
    return {
      ...executor,
      currentProcessId: match?.processId ?? lastStartedMatch?.processId ?? null,
      isRunning: !!match,
      lastProcessId: lastRun?.process_id ?? null,
      lastStartedAt: lastRun?.started_at ?? null,
      isDisabled: executor.disabled_targets.includes(targetMode),
    };
```

- [ ] **Step 3: Update the hook's `updateExecutor` opts type**

In `use-executors.ts`, `updateExecutor` (~line 266), replace `disabled?: boolean` with the per-target pair so it passes through to `api.updateExecutor`:

```ts
      opts: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; pty?: boolean; target?: string; disabled?: boolean }
```

- [ ] **Step 4: Point the item at the per-target state and toggle the active target**

In `apps/vibedeckx-ui/components/executor/executor-item.tsx`:

Update `ExecutorItemProps.onUpdate` (~line 45) — replace `disabled?: boolean` with `target?: string; disabled?: boolean`:

```ts
  onUpdate: (data: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; target?: string; disabled?: boolean }) => Promise<unknown>;
```

Replace `isDisabled` (~line 151) to read the hook-derived, per-target value (the component already receives `executor` as an `ExecutorWithProcess` and an `executorMode` prop):

```ts
  const isDisabled = executor.isDisabled;
```

Replace the toggle (~line 252) to write only the active target:

```tsx
                    <DropdownMenuItem onClick={() => onUpdate({ target: executorMode ?? "local", disabled: !isDisabled })}>
```

- [ ] **Step 5: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no output (clean). If an error says `executor.disabled` no longer exists somewhere, convert that read to `executor.isDisabled` (active-target) or `executor.disabled_targets` as appropriate.

- [ ] **Step 6: Lint the frontend**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/hooks/use-executors.ts apps/vibedeckx-ui/components/executor/executor-item.tsx
git commit -m "feat: per-target executor disable in UI"
```

---

### Task 3: Manual verification

**Files:** none (runtime check).

**Interfaces:**
- Consumes: the running app from Tasks 1-2. The backend change to `process-manager`/storage requires a backend restart to take effect.

- [ ] **Step 1: Build/run and exercise the flow**

Start the app (`pnpm dev:all`, or restart the backend if already running). With a project that has at least one configured remote:

1. On the executor's panel with target = **local**, open the executor menu and click **Disable**. Confirm the item shows disabled styling (strikethrough, Start disabled) and the Start button 409s ("Executor is disabled for this target").
2. Switch the panel target to a **remote**. Confirm the same executor shows **enabled** there and Start works.
3. Switch back to **local**; confirm it is still disabled (state persisted per target).
4. Re-enable on local; confirm `disabled_targets` empties (Start works again on local).

Expected: disabled state is independent per target, and the 409 fires only on the disabled target.

- [ ] **Step 2: (Optional) Spot-check the migration**

If you have a pre-existing `~/.vibedeckx/data.sqlite` with a globally-disabled executor, confirm after first startup that `SELECT disabled_targets FROM executors WHERE ...` lists `"local"` plus the project's remote ids, and that the `disabled` column no longer exists (`PRAGMA table_info(executors)`).

---

## Self-Review

**Spec coverage:**
- Data model (`disabled_targets TEXT`, parse/serialize) → Task 1 Steps 1, 4, 6.
- Migration (seed from old flag across local + project remotes, drop column) → Task 1 Steps 2-3.
- `Executor.disabled` → `disabled_targets: string[]` (backend + frontend types) → Task 1 Step 7, Task 2 Step 1.
- `PUT /api/executors/:id` accepts `{ target, disabled }`, server-side RMW → Task 1 Step 9.
- Start guard moved after target resolution, membership check → Task 1 Steps 10-11.
- Audit of other `.disabled` reads → covered by the grep in Task 1 Step 12 / Task 2 Step 5 (the audit at planning time found only the sites edited here).
- Hook-derived `isDisabled`, active-target toggle → Task 2 Steps 2, 4.
- Error toast already present (prior session) → noted, no task needed.
- Verification = dual tsc + manual → Task 1 Step 12, Task 2 Steps 5-6, Task 3.

**Placeholder scan:** none — every code step shows the full edited block.

**Type consistency:** `disabled_targets: string[]` used identically in `storage/types.ts`, `lib/api.ts`, and the row mapper's parse; `isDisabled: boolean` defined in `ExecutorWithProcess` (Task 2 Step 2) and read in `executor-item.tsx` (Task 2 Step 4); `update(... { disabled_targets?: string[] })` matches between `types.ts` (Step 7) and `sqlite.ts` (Step 6); route `{ target, disabled }` body matches `api.updateExecutor`/hook opts.
