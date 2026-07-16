# Server-Persisted Branch Merge Targets — Design

Date: 2026-07-16
Status: Approved (brainstorm + external review with Jesse)

## Problem

The branch merge status feature (see `2026-07-12-branch-merge-status-design.md`) lets each
workspace track a chosen target branch. That choice is stored only in browser
`localStorage` (`vibedeckx:mergeTarget:<projectId>:<branch>`, `use-merge-status.ts`). A
user who logs in from a second machine sees every branch fall back to the default target —
the tracking state is wrong there, and any change made on one machine never reaches the
others.

## Goal

Persist the explicit target choice server-side, keyed per (project, branch), so all
logged-in machines see the same tracking state. Changes propagate to already-open
machines promptly (SSE) and survive browser data loss.

## Non-goals

- Per-user targets within a shared project (projects are single-owner via `user_id`;
  tenancy comes from project ownership).
- Storing the choice in git itself (`git config`) — pollutes user repos, needs a proxy
  round-trip for remote projects.
- Versioning / optimistic locking — concurrent edits are last-write-wins.
- Any change to the merge detection algorithm or the remote worker protocol.

## Key decisions (from design review)

1. **Server resolves targets; the browser stops sending them.** Precedence per branch:
   request-explicit > stored > git default branch.
2. **Every entry gains `targetSource: "request" | "stored" | "default"`.** Without it the
   frontend cannot tell a stored target from the auto-detected default —
   `deriveDefaultTarget` keys off "which comparisons were explicit in the request", which
   breaks the moment the client sends bare branches (it would report some branch's custom
   target as the project default).
3. **`target-not-found` no longer deletes the stored choice.** The old localStorage flow
   cleared the key and silently fell back to the default. Server-side that would mean one
   device's *read* mutates every device's config, and transient conditions (primary remote
   switch, worker repo not yet synced) could wipe a deliberate choice. Instead the row is
   kept, the error is returned, and the UI shows a "target branch missing" warning state.
   Rows are removed only by explicit user reset (`target: null`) or project deletion
   (FK cascade).
4. **SSE propagation is part of the core scope, not optional.** The event is a cache
   invalidation signal only; the database stays the single source of truth.
5. **No git validation on write.** The picker (`workspace-row-menu.tsx`) only offers
   branches that exist; validating again on write would make "save a preference" fail
   whenever a remote is offline. Existence is reflected by the next merge-status
   computation (decision 3 makes that visible instead of silent).

## Data model

New table (Kysely schema in `storage/schema.ts`, migration in `storage/sqlite.ts`,
matching existing column style):

```sql
CREATE TABLE IF NOT EXISTS branch_merge_targets (
  project_id TEXT NOT NULL,
  branch     TEXT NOT NULL,
  target     TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, branch),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

`updated_at` must be set explicitly in the upsert's `ON CONFLICT DO UPDATE` clause —
SQLite defaults apply on INSERT only.

New `Storage` sub-repository `mergeTargets`:

```ts
mergeTargets: {
  getForBranches: (projectId: string, branches: string[]) => Promise<Map<string, string>>;
  upsert: (projectId: string, branch: string, target: string) => Promise<void>;
  /** INSERT ... ON CONFLICT DO NOTHING; returns true if the row was inserted. */
  insertIfAbsent: (projectId: string, branch: string, target: string) => Promise<boolean>;
  delete: (projectId: string, branch: string) => Promise<void>;
};
```

No `user_id` column: every route resolves the project via
`storage.projects.getById(id, userId)` first, which already enforces ownership.

## Read path

`POST /api/projects/:id/branches/merge-status` (existing route,
`routes/merge-status-routes.ts`):

```
browser sends comparisons: [{branch: "dev3"}, {branch: "dev4"}]  (bare — no targets)
  ↓ requireAuth + projects.getById(id, userId)
  ↓ mergeTargets.getForBranches(projectId, branches)
  ↓ build effective comparisons (request target > stored target > none)
  ↓ compute locally OR proxy to primary remote (unchanged)
  ↓ annotate each entry with targetSource based on where its target came from
  ↓ respond
```

- The worker-side endpoint `/api/path/branches/merge-status` is untouched — workers stay
  stateless and never see the persistence layer. `targetSource` is attached by the
  central server after the proxy call returns.
- Entries that errored still carry `targetSource` (a `target-not-found` on a stored
  target reports `targetSource: "stored"` so the UI can label the warning correctly; a
  `no-default-branch` error reports `"default"`).
- `"request"` exists for ad-hoc comparisons and API compatibility only; it is never
  written to the database. The UI's normal fetch never sends targets.
- No stale-row cleanup happens here (decision 3).

Type change (`api.ts` + backend):

```ts
export type TargetSource = "request" | "stored" | "default";
export interface MergeStatusPairEntry {
  branch: string;
  target: string | null;
  targetSource: TargetSource;   // new
  status?: MergeStatusValue;
  unmergedCount?: number;
  dirty?: boolean;
  error?: MergePairError;
}
```

## Write path

New route in `merge-status-routes.ts`:

```
PUT /api/projects/:id/branches/merge-target
Body: { branch: string, target: string | null, ifAbsent?: boolean }
```

1. `requireAuth` + `projects.getById(id, userId)` — 404 when not owned.
2. Validate: `branch` is a non-empty string; `target` is a non-empty string or `null`;
   both length-capped (256). No git existence check (decision 5).
3. `target === null` → `mergeTargets.delete` (branch falls back to the default).
   `target` set → `upsert`, or `insertIfAbsent` when `ifAbsent: true` (migration path,
   see below).
4. On success emit `{ type: "merge-target:updated", projectId, branch }` on the event
   bus and return `{ branch, target: <stored value or null> }` (for `ifAbsent`, the value
   that actually won).

## Live propagation

- Add to the `GlobalEvent` union (`event-bus.ts`):
  `{ type: "merge-target:updated"; projectId: string; branch: string }`.
- `/api/events` (`event-routes.ts`) already filters every event by
  `projects.getById(event.projectId, userId)` — the new event gets per-tenant scoping for
  free and carries no payload beyond identifiers.
- Frontend: `useMergeStatusAutoRefresh` already subscribes via `useGlobalEventStream` for
  `executor:stopped`; add a case for `merge-target:updated` with matching `projectId` →
  `refetch()`. Existing focus-refresh and 30/60 s visible-tab polling remain as the
  disconnection backstop.

## Frontend changes (`hooks/use-merge-status.ts` + consumers)

- Delete `mergeTargetStorageKey` / `readMergeTarget` and all localStorage access.
  `buildComparisons` degenerates to bare `{ branch }` entries.
- Delete `staleTargetBranches` and the one-shot clear-and-refetch fallback (decision 3
  removes the behavior it implemented).
- `deriveDefaultTarget` reworked: first entry with `targetSource === "default"` and a
  non-null `target`. (When every branch has a stored target it stays `null` — same as
  today when every comparison was explicit.)
- `setTarget(branch, target)` → `api.setMergeTarget(projectId, branch, target)` then
  `refetch()`.
- **Warning state:** entries with `error: "target-not-found"` no longer get skipped.
  `BranchMergeInfo` becomes a union: the existing ok shape, plus
  `{ branch, target, targetSource, error: "target-not-found" }`. The sidebar badge
  renders a warning variant (alert-style icon, tooltip "Target branch '<target>' not
  found — pick a new target or reset to default"). Other errors (`branch-not-found`,
  `no-default-branch`) stay skipped as today.
- The row menu (`workspace-row-menu.tsx`) gains a "Default (<name>)" reset entry that
  calls `setTarget(branch, null)`, so a user facing the warning can explicitly return to
  the default. (Previously reachable only by localStorage deletion.)

## One-time localStorage migration

Lazy, client-driven, atomic per row:

1. On `useMergeStatus` mount for a project, scan localStorage for
   `vibedeckx:mergeTarget:<projectId>:*` keys.
2. For each, `PUT … { branch, target, ifAbsent: true }` — `INSERT … ON CONFLICT DO
   NOTHING` server-side, so a value already set (by another device or an earlier import)
   always wins over the import. No read-then-write race.
3. Only after a 2xx response delete that localStorage key. On failure keep the key and
   retry on a later mount.
4. When two old devices hold different values, first successful import wins — accepted
   one-time arbitrariness; afterwards the server is the single source of truth.

The migration block is self-contained and marked for removal in a future release once
localStorage keys have drained.

## Error handling

- Write route: 400 on malformed body, 404 on unowned/unknown project; storage errors
  surface as 500. The client keeps its previous UI state on any non-2xx (no optimistic
  update — `refetch` after success is the only state change).
- Read path: unchanged transport semantics (`result.ok === false` keeps previous
  statuses). Per-entry errors now partially flow into UI state per the warning-state rule.

## Testing

- **Pure frontend functions** (existing pattern in `use-merge-status.test.ts`):
  `buildComparisons` (bare), reworked `deriveDefaultTarget` (targetSource-driven), and
  the new warning-state mapping. Delete `staleTargetBranches` tests.
- **Behavior test** (`use-merge-status.behavior.test.tsx`): setTarget calls the API and
  refetches; `merge-target:updated` event triggers refetch; target-not-found produces the
  warning entry instead of clearing anything.
- **Backend** (vitest, colocated): `mergeTargets` repo (upsert updates `updated_at`,
  insertIfAbsent semantics, cascade on project delete); merge-status route resolves
  stored targets and annotates `targetSource` (local + proxied paths, with the proxy
  mocked); PUT route auth, validation, delete-on-null, event emission.

## Out of scope / follow-ups

- Squash-merge content detection (phase 2 of the original spec) — unrelated.
- Draining the migration code path — remove after a release or two.
