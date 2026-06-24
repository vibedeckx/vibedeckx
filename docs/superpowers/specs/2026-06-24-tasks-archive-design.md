# Tasks Archive — Design

**Date:** 2026-06-24
**Status:** Approved, pending implementation plan

## Goal

Let users archive individual tasks in the `/tasks` page. Archiving collapses a
task out of the active board while keeping the data intact and recoverable.
"Archive" answers the need to clear finished work off the board without the risk
of deleting it.

## Core concept

Archive is **orthogonal to `status`**. `status: done` means "the work on this
task is finished"; `archived` means "hide it from the active board, but keep it
and allow recovery." A task can be `done` and still sit on the board until the
user decides to archive it.

Reference point: Notion ships both a *Trash* (soft-delete, 30-day retention) and,
since March 2026, a first-class *Archive* (manual, hidden from search/sidebar/DB
views, recoverable). For a table/board-shaped object like tasks, the lightweight
equivalent of Notion's "filter out archived rows" is a single **"Show archived"
toggle**. This design follows that.

## Decisions (locked)

- **Scope:** ordinary tasks in the `/tasks` page, archivable after they are done
  (or at any time).
- **Trigger:** pure manual. A per-row "Archive" action. No auto-archive on
  `done`.
- **Visibility:** same-table toggle ("Show archived"). No separate archive page.
- **Archive vs delete:** both coexist. Archive = recoverable hide (daily use);
  delete = permanent hard delete (rare, dangerous). Existing delete behavior is
  unchanged.

## Data model

Add one nullable column to the `tasks` table:

```sql
archived_at INTEGER DEFAULT NULL   -- epoch ms; NULL = active, value = archived
```

- `NULL` = active; a value = archived (and records when, so the UI can show
  "Archived <date>").
- Matches the epoch-ms style of existing `agent_sessions` activity columns
  (`favorited_at`, `last_completed_at`).
- Orthogonal to `status` — any status (todo/in_progress/done/cancelled) can be
  archived.
- Use the existing additive-column migration pattern in `sqlite.ts` (see the
  migration block around lines 299-304) so existing databases get the column
  automatically. No manual migration step.

## Backend

**Storage interface (`storage/types.ts`, `storage/sqlite.ts`):**

- Add `archive(id: string)` and `unarchive(id: string)` — set / clear
  `archived_at`.
- `getByProjectId(projectId, opts?: { includeArchived?: boolean })` — **defaults
  to active-only** (excludes archived); returns archived too only when
  `includeArchived` is set. Keeps the default list clean.

**REST routes (`routes/task-routes.ts`):**

- Add `POST /api/tasks/:id/archive` and `POST /api/tasks/:id/unarchive`, each
  with full `requireAuth` + project-ownership verification
  (`projects.getById(task.project_id, userId)`).
- The list route accepts an `includeArchived` query flag, forwarded to
  `getByProjectId`.

**Pre-existing auth bug fixed in passing:** `PUT /api/tasks/:id` and
`DELETE /api/tasks/:id` currently lack `requireAuth` + ownership checks (under
`--auth`, cross-tenant modify/delete is possible via a known task UUID). Since we
are already editing this file and adding sibling routes, add the same
`requireAuth` + `projects.getById(task.project_id, userId)` guard to both. Small,
in-scope hardening.

## Frontend

**Types (`lib/api.ts`, backend `types.ts`):** add `archived_at: number | null`
to the `Task` interface.

**API (`lib/api.ts`):**

- Add `archiveTask(id)` and `unarchiveTask(id)`.
- `getTasks` gains an optional `includeArchived` argument.

**Hook (`hooks/use-tasks.ts`):**

- Add `archive` / `unarchive` callbacks with optimistic updates (an archived task
  immediately leaves the active list).

**Table (`components/task/task-table.tsx`):**

- Add a top-level **"Show archived" toggle**.
  - Off (default): active tasks only; each row's actions include "Archive".
  - On: archived tasks shown, visually de-emphasized (e.g. muted + "Archived
    <date>"); each row's action is "Unarchive".
- Keep the existing delete button (archive and delete coexist).

## Out of scope (YAGNI)

- Auto-archive on `done`.
- Cascade archiving.
- Bulk archive.
- Automatic 30-day cleanup of archived tasks.
- A separate archive page/tab.

Add later only if a real need appears.
