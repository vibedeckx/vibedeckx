# Per-target executor disable

## Problem

An executor's `disabled` state is currently a single global boolean on the
`executors` row (`disabled INTEGER DEFAULT 0`, added in commit 122c290).
Disabling an executor turns it off for every target at once. We want the
disabled state bound to a target instead: an executor can be disabled on one
remote while staying available on another (or on local).

A "target" is the same identifier the codebase already uses for `last_runs`:
either the literal string `"local"` or a `remote_server_id` (UUID). The list
route builds `last_runs` as a `Record<target, …>`; per-target disable mirrors
that namespace exactly.

## Decisions

- **Local participates.** `disabled` is keyed by the full target namespace
  (`"local"` + each `remote_server_id`), not remotes-only. Uniform with
  `last_runs`; supports "disable on my laptop, keep it on the build server".
- **Migrate the old flag.** Any executor currently `disabled = 1` becomes
  disabled for all of that project's current targets, then the old column is
  dropped. New remotes added later default to enabled.
- **JSON column, not a side table.** Store `disabled_targets TEXT` (a JSON
  array) directly on `executors`. Simpler than a join table, no perf concern at
  this scale (a handful of short strings per executor), and the list route needs
  no extra query. We deliberately skip a normalized table — YAGNI until other
  per-target settings (env/timeout) actually land.
- **Toggle acts on the active target only.** The Enable/Disable control affects
  whatever target the panel is currently showing, consistent with how Last-run
  already scopes to the selected target.

## Data model

Replace `executors.disabled INTEGER DEFAULT 0` with:

```
disabled_targets TEXT DEFAULT '[]'
```

A JSON array of target ids. Presence of a target id = disabled for that target;
absence = enabled. The SQLite storage layer parses the JSON on read and
serializes on write, so every layer above storage sees `disabled_targets:
string[]`.

### Migration (one-time)

For each executor row where the old `disabled = 1`, seed:

```
disabled_targets = ["local", ...<remote_server_id for every project_remotes
                                  row of this executor's project>]
```

All other executors → `[]`. Then drop the `disabled` column.

This preserves "it was off everywhere" for current targets without the ongoing
complexity of a two-level (global + per-target) model. As this is pre-release
with few/no disabled executors in real databases, the migration cost is
negligible.

## Backend changes

- **`storage/sqlite.ts`** — schema column swap + the migration above. Parse/
  serialize `disabled_targets` JSON at the storage boundary. `executors.update`
  accepts `disabled_targets?: string[]`.
- **`storage/types.ts`** — `Executor.disabled: boolean` → `disabled_targets:
  string[]`; update the `executors.update` opts type.
- **`PUT /api/executors/:id`** (`routes/executor-routes.ts`) — additionally
  accept `{ target?: string; disabled?: boolean }`. When both are present, do a
  **server-side read-modify-write**: read the current `disabled_targets`,
  add/remove `target`, persist the new array. This avoids the client clobbering
  the set and sidesteps concurrent-toggle races. Generic field updates
  (name/command/cwd/…) keep working unchanged. Returns the updated executor
  carrying the new array.
- **`routes/process-routes.ts` start guard** — the current
  `if (executor.disabled) → 409` at line 64 runs *before* target resolution
  (lines 71–101). Move it to *after* `executorMode` is resolved and change it to
  `if (executor.disabled_targets.includes(executorMode)) → 409 "Executor is
  disabled for this target"`. Because the controller evaluates this before
  proxying to a remote, the guard covers both local and remote starts; the
  remote server does not need to know about disabled state.
- **Audit** every remaining read of `executor.disabled` across the backend
  (grep) — e.g. any run-all / commander spawn path — and make each one
  target-aware.

## Frontend changes

- **`lib/api.ts`** — `Executor.disabled` → `disabled_targets: string[]`;
  `updateExecutor` opts gain optional `target` + `disabled`, passed through to
  the PUT body.
- **`hooks/use-executors.ts`** — derive `isDisabled` onto `ExecutorWithProcess`
  for the active target: `isDisabled = executor.disabled_targets.includes(
  targetMode)`, computed in the same place `targetMode` and `lastRun` already
  are (around line 433). Target resolution stays in the hook; the item stays
  target-agnostic.
- **`components/executor/executor-item.tsx`** — `isDisabled` reads the
  hook-derived value instead of `!!executor.disabled`. The Enable/Disable menu
  item toggles only the active target via
  `onUpdate({ target: targetMode, disabled: !isDisabled })`. The label and
  disabled styling already scope to the selected target, matching "Last run".

## Error handling

The `updateExecutor` catch already shows a `toast.error` on failure (added this
session), which covers the toggle path. Success path stays silent; failures
return `null` without rollback (there is no optimistic update to roll back).

## Testing / verification

This repo has no test framework configured. Verification is:

- `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` (backend) clean.
- `cd apps/vibedeckx-ui && npx tsc --noEmit` (frontend) clean.
- Manual: disable an executor on `local`; switch its target to a remote;
  confirm it shows enabled there and starts fine, while a start on `local`
  returns `409`. Toggle it back and confirm the array empties.

## Out of scope (YAGNI)

- A submenu to manage every target's disabled state from one menu without
  switching the active target.
- Other per-target executor settings (env vars, timeout) — if those land, the
  JSON column may be revisited in favour of a normalized per-target table.
