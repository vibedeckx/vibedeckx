# Tasks Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users manually archive tasks in the `/tasks` page so finished work can be hidden from the active board while staying intact and recoverable.

**Architecture:** Add a nullable `archived_at` (epoch ms) column to the `tasks` table, orthogonal to `status`. The list query excludes archived rows by default. New `archive`/`unarchive` storage methods and REST routes (`POST /api/tasks/:id/archive` and `/unarchive`) with full auth. The frontend fetches active + archived together and switches between them via a new "Archived" chip in the existing `FilterBar`; per-row Archive/Unarchive actions live in `task-row.tsx`.

**Tech Stack:** TypeScript, Fastify, better-sqlite3 (backend ESM, NodeNext — local imports need `.js`); Next.js 16 / React 19 (frontend, `@/*` alias).

## Global Constraints

- Backend is ESM with NodeNext resolution — **all local imports must use `.js` extensions**.
- `archived_at` is stored as SQLite `INTEGER` epoch ms, mirroring `agent_sessions.favorited_at`/`last_completed_at`. `NULL` = active, a number = archived. (Note: `created_at`/`updated_at` are TIMESTAMP *strings*; `archived_at` is a *number* — do not mix the two representations.)
- Archive is orthogonal to `status`: any status (todo/in_progress/done/cancelled) can be archived.
- Archive and hard delete coexist — existing delete behavior is unchanged.
- No test framework is configured in this repo (per CLAUDE.md). The per-task verification cycle is: type-check (`tsc --noEmit`), frontend lint where touched, and a concrete manual smoke test. There are no automated unit tests to write.
- Type-check commands:
  - Backend: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
  - Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`
  - Frontend lint: `pnpm --filter vibedeckx-ui lint`

---

### Task 1: Backend data model + storage layer

Add the `archived_at` column, its migration, and the storage methods.

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts` (Task interface ~132-143; Storage.tasks interface ~362-369)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (migration block ~299-304; tasks storage object ~1715-1767)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `Task.archived_at: number | null` (added to interface in both `types.ts` and, in Task 3, `api.ts`).
  - `storage.tasks.getByProjectId(projectId: string, opts?: { includeArchived?: boolean }): Task[]` — defaults to active-only.
  - `storage.tasks.archive(id: string): Task | undefined`
  - `storage.tasks.unarchive(id: string): Task | undefined`

- [ ] **Step 1: Add `archived_at` to the `Task` interface and storage method signatures**

In `packages/vibedeckx/src/storage/types.ts`, add the field to the `Task` interface (after `position`):

```typescript
export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_branch: string | null;
  position: number;
  archived_at: number | null;
  created_at: string;
  updated_at: string;
}
```

In the same file, update the `tasks` block of the `Storage` interface (~362-369) to:

```typescript
  tasks: {
    create: (opts: { id: string; project_id: string; title: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => Task;
    getByProjectId: (projectId: string, opts?: { includeArchived?: boolean }) => Task[];
    getById: (id: string) => Task | undefined;
    update: (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null; position?: number }) => Task | undefined;
    archive: (id: string) => Task | undefined;
    unarchive: (id: string) => Task | undefined;
    delete: (id: string) => void;
    reorder: (projectId: string, orderedIds: string[]) => void;
  };
```

- [ ] **Step 2: Add the column migration**

In `packages/vibedeckx/src/storage/sqlite.ts`, immediately after the existing `assigned_branch` migration block (ends at line 304), add a sibling migration following the identical pattern:

```typescript
  // Migration: add archived_at column to tasks table
  const taskArchivedInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const hasArchivedAtColumn = taskArchivedInfo.some((col) => col.name === "archived_at");
  if (!hasArchivedAtColumn) {
    db.exec("ALTER TABLE tasks ADD COLUMN archived_at INTEGER DEFAULT NULL");
  }
```

(The `CREATE TABLE tasks` at ~108-119 can stay as-is; the migration covers both fresh and existing databases. Optionally also add `archived_at INTEGER DEFAULT NULL` to the CREATE TABLE for clarity — either is fine, the migration is the source of truth.)

- [ ] **Step 3: Make `getByProjectId` archive-aware and add `archive`/`unarchive`**

In `packages/vibedeckx/src/storage/sqlite.ts`, replace the `getByProjectId` method (lines 1715-1719) with:

```typescript
      getByProjectId: (projectId: string, opts?: { includeArchived?: boolean }) => {
        const where = opts?.includeArchived
          ? `project_id = @project_id`
          : `project_id = @project_id AND archived_at IS NULL`;
        return db
          .prepare<{ project_id: string }, Task>(`SELECT * FROM tasks WHERE ${where} ORDER BY position ASC`)
          .all({ project_id: projectId });
      },
```

Then, immediately after the `update` method (which ends at line 1763, just before `delete`), insert:

```typescript
      archive: (id: string) => {
        db.prepare(`UPDATE tasks SET archived_at = @now, updated_at = CURRENT_TIMESTAMP WHERE id = @id`)
          .run({ id, now: Date.now() });
        return db.prepare<{ id: string }, Task>(`SELECT * FROM tasks WHERE id = @id`).get({ id });
      },

      unarchive: (id: string) => {
        db.prepare(`UPDATE tasks SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = @id`)
          .run({ id });
        return db.prepare<{ id: string }, Task>(`SELECT * FROM tasks WHERE id = @id`).get({ id });
      },
```

- [ ] **Step 4: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors. (If `sqlite.ts` errors that `archive`/`unarchive` are missing or mis-typed, the interface in Step 1 and the implementation in Step 3 are out of sync — reconcile them.)

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/storage/types.ts packages/vibedeckx/src/storage/sqlite.ts
git commit -m "feat: add archived_at column and archive/unarchive storage methods for tasks"
```

---

### Task 2: Backend REST routes

Add archive/unarchive endpoints, make the list route archive-aware, and fix the missing auth on the existing PUT/DELETE routes.

**Files:**
- Modify: `packages/vibedeckx/src/routes/task-routes.ts` (list route ~12-25; PUT ~80-99; DELETE ~101-110)

**Interfaces:**
- Consumes: `storage.tasks.getByProjectId(projectId, { includeArchived })`, `storage.tasks.archive(id)`, `storage.tasks.unarchive(id)` (from Task 1); `requireAuth` (already imported), `fastify.storage.projects.getById(projectId, userId)`.
- Produces:
  - `GET /api/projects/:projectId/tasks?includeArchived=true` → `{ tasks }`
  - `POST /api/tasks/:id/archive` → `{ task }`
  - `POST /api/tasks/:id/unarchive` → `{ task }`

- [ ] **Step 1: Make the list route honor `includeArchived`**

In `packages/vibedeckx/src/routes/task-routes.ts`, replace the GET handler (lines 12-25) with:

```typescript
  fastify.get<{ Params: { projectId: string }; Querystring: { includeArchived?: string } }>(
    "/api/projects/:projectId/tasks",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const includeArchived = req.query.includeArchived === "true";
      const tasks = fastify.storage.tasks.getByProjectId(req.params.projectId, { includeArchived });
      return reply.code(200).send({ tasks });
    }
  );
```

- [ ] **Step 2: Add auth + ownership to the existing PUT and DELETE handlers**

In the same file, replace the PUT handler (lines 80-99) with this version (adds `requireAuth` + project-ownership check using the existing task's `project_id`):

```typescript
  // Update task
  fastify.put<{
    Params: { id: string };
    Body: { title?: string; description?: string | null; status?: string; priority?: string; assigned_branch?: string | null; position?: number };
  }>("/api/tasks/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const project = fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const task = fastify.storage.tasks.update(req.params.id, {
      title: req.body.title,
      description: req.body.description,
      status: req.body.status as 'todo' | 'in_progress' | 'done' | 'cancelled' | undefined,
      priority: req.body.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
      assigned_branch: req.body.assigned_branch,
      position: req.body.position,
    });
    return reply.code(200).send({ task });
  });
```

Then replace the DELETE handler (lines 101-110) with:

```typescript
  // Delete task
  fastify.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const project = fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Task not found" });
    }

    fastify.storage.tasks.delete(req.params.id);
    return reply.code(200).send({ success: true });
  });
```

- [ ] **Step 3: Add the archive and unarchive routes**

In the same file, immediately after the DELETE handler (before the reorder route at line 112), insert:

```typescript
  // Archive task
  fastify.post<{ Params: { id: string } }>("/api/tasks/:id/archive", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const project = fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const task = fastify.storage.tasks.archive(req.params.id);
    return reply.code(200).send({ task });
  });

  // Unarchive task
  fastify.post<{ Params: { id: string } }>("/api/tasks/:id/unarchive", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const project = fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const task = fastify.storage.tasks.unarchive(req.params.id);
    return reply.code(200).send({ task });
  });
```

- [ ] **Step 4: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

Start the backend (`pnpm dev:server`, listens on 5173). In solo no-auth mode `requireAuth` returns an empty-string userId and `getById` resolves normally, so no token is needed. Using an existing project id `<P>` and one of its task ids `<T>`:

```bash
# Archive, then confirm it drops out of the default list but appears with includeArchived
curl -s -X POST http://localhost:5173/api/tasks/<T>/archive | grep -o '"archived_at":[0-9]*'
curl -s "http://localhost:5173/api/projects/<P>/tasks" | grep -c '<T>'                     # expect 0
curl -s "http://localhost:5173/api/projects/<P>/tasks?includeArchived=true" | grep -c '<T>' # expect 1
# Unarchive and confirm it returns to the default list
curl -s -X POST http://localhost:5173/api/tasks/<T>/unarchive | grep -o '"archived_at":null'
curl -s "http://localhost:5173/api/projects/<P>/tasks" | grep -c '<T>'                      # expect 1
```

Expected: archive returns a numeric `archived_at`; the task is absent from the default list (count 0) and present with `includeArchived=true` (count 1); unarchive sets `archived_at` back to `null` and the task returns to the default list.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/routes/task-routes.ts
git commit -m "feat: add task archive/unarchive routes; fix missing auth on task PUT/DELETE"
```

---

### Task 3: Frontend API client + types + hook

Mirror the backend types, add API calls, and make `useTasks` hold both active and archived tasks with archive/unarchive callbacks.

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` (Task interface ~381-392; getTasks ~1198-1206; add archive/unarchive after deleteTask ~1250)
- Modify: `apps/vibedeckx-ui/hooks/use-tasks.ts` (whole file)

**Interfaces:**
- Consumes: `GET ...?includeArchived=true`, `POST /api/tasks/:id/archive`, `POST /api/tasks/:id/unarchive` (from Task 2).
- Produces:
  - `Task.archived_at: number | null`
  - `api.getTasks(projectId: string, opts?: { includeArchived?: boolean }): Promise<Task[]>`
  - `api.archiveTask(id: string): Promise<Task>`
  - `api.unarchiveTask(id: string): Promise<Task>`
  - `useTasks(...)` return adds `archive(id: string): Promise<void>` and `unarchive(id: string): Promise<void>`; its `tasks` array now includes archived tasks (distinguished by `archived_at !== null`).

- [ ] **Step 1: Add `archived_at` to the frontend `Task` interface**

In `apps/vibedeckx-ui/lib/api.ts`, update the `Task` interface (~381-392) to add the field after `position`:

```typescript
export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_branch: string | null;
  position: number;
  archived_at: number | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Add `includeArchived` to `getTasks` and add archive/unarchive calls**

In `apps/vibedeckx-ui/lib/api.ts`, replace `getTasks` (lines 1198-1206) with:

```typescript
  async getTasks(projectId: string, opts?: { includeArchived?: boolean }): Promise<Task[]> {
    const qs = opts?.includeArchived ? "?includeArchived=true" : "";
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/tasks${qs}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.tasks;
  },
```

Then, immediately after `deleteTask` (ends line 1250, before `reorderTasks`), insert:

```typescript
  async archiveTask(id: string): Promise<Task> {
    const res = await authFetch(`${getApiBase()}/api/tasks/${id}/archive`, { method: "POST" });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.task;
  },

  async unarchiveTask(id: string): Promise<Task> {
    const res = await authFetch(`${getApiBase()}/api/tasks/${id}/unarchive`, { method: "POST" });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    const data = await res.json();
    return data.task;
  },
```

- [ ] **Step 3: Make `useTasks` fetch archived too and add archive/unarchive**

In `apps/vibedeckx-ui/hooks/use-tasks.ts`, change the fetch call inside `fetchTasks` (line 18) to include archived so the view holds both sets:

```typescript
      const data = await api.getTasks(projectId, { includeArchived: true });
```

Then add two callbacks after `deleteTask` (after line 78, before `reorderTasks`). They optimistically flip `archived_at` on the affected task (it stays in the array; the view decides which list it belongs to):

```typescript
  const archive = useCallback(async (id: string) => {
    const previousTasks = tasks;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, archived_at: Date.now() } : t)));
    try {
      const task = await api.archiveTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
    } catch (error) {
      console.error("Failed to archive task:", error);
      setTasks(previousTasks);
    }
  }, [tasks]);

  const unarchive = useCallback(async (id: string) => {
    const previousTasks = tasks;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, archived_at: null } : t)));
    try {
      const task = await api.unarchiveTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
    } catch (error) {
      console.error("Failed to unarchive task:", error);
      setTasks(previousTasks);
    }
  }, [tasks]);
```

Finally add `archive` and `unarchive` to the returned object (after `deleteTask,` at line 105):

```typescript
  return {
    tasks,
    loading,
    createTask,
    updateTask,
    deleteTask,
    archive,
    unarchive,
    reorderTasks,
    refetch: fetchTasks,
  };
```

- [ ] **Step 4: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors. (A `Task` literal somewhere now missing `archived_at` would surface here; the hook's spread-based updates already preserve it, so errors most likely point to other consumers — fix by spreading the prior task or reading from the server response.)

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/hooks/use-tasks.ts
git commit -m "feat: add archive/unarchive task API client methods and hook callbacks"
```

---

### Task 4: Frontend UI — Archived filter chip + per-row archive action

Add an "Archived" chip to the existing `FilterBar`, route the archived list through the same `TaskTable`, and add per-row Archive/Unarchive actions.

**Files:**
- Modify: `apps/vibedeckx-ui/components/task/tasks-view.tsx` (filters ~11-19; counts/filter ~40-49; props ~21-29; render ~64-104)
- Modify: `apps/vibedeckx-ui/components/task/task-table.tsx` (props ~21-27; TaskRow render ~96-107)
- Modify: `apps/vibedeckx-ui/components/task/task-row.tsx` (props ~19-27; actions cell ~185-194)
- Modify: `apps/vibedeckx-ui/app/page.tsx` (wherever `<TasksView ... />` is rendered — wire the new `onArchive`/`onUnarchive` props)

**Interfaces:**
- Consumes: `useTasks(...)` now returns `archive`/`unarchive` (from Task 3); `Task.archived_at`.
- Produces: end-to-end archive UX. No downstream tasks.

- [ ] **Step 1: Add the "Archived" filter and split active vs archived in `tasks-view.tsx`**

In `apps/vibedeckx-ui/components/task/tasks-view.tsx`:

Change the filter type and list (lines 11-19) to add an `archived` option:

```typescript
type StatusFilter = "all" | TaskStatus | "archived";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "Doing" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "archived", label: "Archived" },
];
```

Add `onArchiveTask`/`onUnarchiveTask` to the props interface (after `onDeleteTask` on line 28):

```typescript
  onDeleteTask: (id: string) => Promise<void>;
  onArchiveTask: (id: string) => Promise<void>;
  onUnarchiveTask: (id: string) => Promise<void>;
```

Update the destructure on line 31 to include them:

```typescript
export function TasksView({ projectId, tasks, loading, worktrees, onCreateTask, onUpdateTask, onDeleteTask, onArchiveTask, onUnarchiveTask }: TasksViewProps) {
```

Replace the counts + filtered-tasks logic (lines 40-49) so status counts and the status views are computed over **active** tasks only, with a separate archived bucket:

```typescript
  const activeTasks = useMemo(() => tasks.filter((t) => t.archived_at === null), [tasks]);
  const archivedTasks = useMemo(() => tasks.filter((t) => t.archived_at !== null), [tasks]);

  // Counts per chip. Status counts come from active tasks; "archived" counts the archived bucket.
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: activeTasks.length, todo: 0, in_progress: 0, done: 0, cancelled: 0, archived: archivedTasks.length };
    for (const t of activeTasks) c[t.status]++;
    return c;
  }, [activeTasks, archivedTasks]);

  const filteredTasks = useMemo(() => {
    if (statusFilter === "archived") return archivedTasks;
    if (statusFilter === "all") return activeTasks;
    return activeTasks.filter((t) => t.status === statusFilter);
  }, [activeTasks, archivedTasks, statusFilter]);

  const archivedView = statusFilter === "archived";
```

Update the `PageHeader` count (line 68) to reflect active tasks:

```typescript
        count={activeTasks.length}
```

Update the `<TaskTable>` render (lines 96-103) to pass the new props:

```typescript
          <TaskTable
            tasks={filteredTasks}
            onUpdate={onUpdateTask}
            onDelete={onDeleteTask}
            onArchive={onArchiveTask}
            onUnarchive={onUnarchiveTask}
            archivedView={archivedView}
            worktrees={worktrees}
            onAssign={handleAssign}
          />
```

- [ ] **Step 2: Thread the new props through `task-table.tsx`**

In `apps/vibedeckx-ui/components/task/task-table.tsx`, extend `TaskTableProps` (lines 21-27):

```typescript
interface TaskTableProps {
  tasks: Task[];
  onUpdate: (id: string, opts: { title?: string; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  archivedView: boolean;
  worktrees: Worktree[];
  onAssign: (taskId: string, branch: string | null) => void;
}
```

Update the destructure (line 29):

```typescript
export function TaskTable({ tasks, onUpdate, onDelete, onArchive, onUnarchive, archivedView, worktrees, onAssign }: TaskTableProps) {
```

Pass them into `<TaskRow>` (lines 97-106):

```typescript
          <TaskRow
            key={task.id}
            task={task}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            archivedView={archivedView}
            onClick={(t) => { setSelectedTask(t); setDetailOpen(true); }}
            worktrees={worktrees}
            assignedBranches={assignedBranches}
            onAssign={onAssign}
          />
```

- [ ] **Step 3: Add the Archive/Unarchive action to `task-row.tsx`**

In `apps/vibedeckx-ui/components/task/task-row.tsx`:

Add the icons to the lucide import (line 16):

```typescript
import { Trash2, GitBranch, Archive, ArchiveRestore } from "lucide-react";
```

Extend `TaskRowProps` (lines 19-27):

```typescript
interface TaskRowProps {
  task: Task;
  onUpdate: (id: string, opts: { title?: string; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  archivedView: boolean;
  onClick?: (task: Task) => void;
  worktrees: Worktree[];
  assignedBranches: Set<string | null>;
  onAssign: (taskId: string, branch: string | null) => void;
}
```

Update the destructure (line 29):

```typescript
export function TaskRow({ task, onUpdate, onDelete, onArchive, onUnarchive, archivedView, onClick, worktrees, assignedBranches, onAssign }: TaskRowProps) {
```

Replace the final actions cell (lines 185-194) with one that shows Unarchive in the archived view and Archive otherwise, keeping the delete button in both:

```typescript
      <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-0.5">
          {archivedView ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Unarchive"
              onClick={() => onUnarchive(task.id)}
            >
              <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Archive"
              onClick={() => onArchive(task.id)}
            >
              <Archive className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Delete"
            onClick={() => onDelete(task.id)}
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </TableCell>
```

- [ ] **Step 4: Wire the new props where `<TasksView>` is rendered**

In `apps/vibedeckx-ui/app/page.tsx`, add `archive` and `unarchive` to the `useTasks` destructure (line 109):

```tsx
  const { tasks, loading: tasksLoading, createTask, updateTask, deleteTask, archive, unarchive, refetch: refetchTasks } = useTasks(currentProject?.id ?? null);
```

Then pass them into the `<TasksView>` element (lines 539-547) — add the two props after `onDeleteTask`:

```tsx
            <TasksView
              projectId={currentProject?.id ?? null}
              tasks={tasks}
              loading={tasksLoading}
              worktrees={worktrees}
              onCreateTask={createTask}
              onUpdateTask={updateTask}
              onDeleteTask={deleteTask}
              onArchiveTask={archive}
              onUnarchiveTask={unarchive}
            />
```

- [ ] **Step 5: Type-check and lint the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors. (If `page.tsx` errors that `archive`/`unarchive` don't exist on the hook result, Task 3 Step 3's return object wasn't updated — fix there. If `TasksView` errors about missing `onArchiveTask`/`onUnarchiveTask`, Step 4 didn't pass them.)

Run: `pnpm --filter vibedeckx-ui lint`
Expected: no new lint errors in the touched files.

- [ ] **Step 6: Manual UI smoke test**

Run `pnpm dev:all` (backend 5173, frontend 3000), open http://localhost:3000, select a project with tasks:
1. Hover a task row → an Archive icon appears next to the trash icon. Click it → the task disappears from the current (active) view; the "All" count decreases; the "Archived" chip count increases by 1.
2. Click the "Archived" chip → the archived task is listed; its row shows an Unarchive (restore) icon instead of Archive. The trash icon is still present.
3. Click Unarchive → the task leaves the archived view and the "Archived" count decreases; switch back to "All" and confirm it reappears.
4. Refresh the page and confirm archived state persisted (archived task still only under the "Archived" chip).

Expected: all four behaviors hold.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/components/task/tasks-view.tsx apps/vibedeckx-ui/components/task/task-table.tsx apps/vibedeckx-ui/components/task/task-row.tsx apps/vibedeckx-ui/app/page.tsx
git commit -m "feat: archive/unarchive tasks UI — Archived filter chip and per-row action"
```

---

## Notes for the implementer

- **Reorder is unaffected:** `getByProjectId` defaults to active-only, and the reorder route only validates ids it was given, so archived tasks simply don't participate in reordering. No change needed there.
- **`create` needs no change:** the `INSERT` omits `archived_at`, so it defaults to `NULL` (active); `SELECT *` returns the new column automatically.
- **Other `api.getTasks` callers:** the `includeArchived` argument is optional and defaults to off, so any other caller (e.g. Main Chat / commander tools) keeps getting active-only tasks with no change.
- **Archived row styling (optional polish):** the spec mentions de-emphasizing archived rows. The Archived view is already visually distinct by being its own filtered list; further muting (e.g. a `text-muted-foreground` class on the title in archived view) is optional and not required for the feature to be correct.
