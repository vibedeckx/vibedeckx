import { sql, type Kysely, type Selectable } from "kysely";
import type { DB, TasksTable, RulesTable } from "../schema.js";
import type { DialectHelpers } from "../dialect.js";
import type { Storage, Task, TaskStatus, TaskPriority, Rule } from "../types.js";

const mapTask = (row: Selectable<TasksTable>): Task => ({
  ...row,
  status: row.status as TaskStatus,
  priority: row.priority as TaskPriority,
});

const mapRule = (row: Selectable<RulesTable>): Rule => ({
  ...row,
  // Rule.enabled is typed `number` in types.ts — deliberately NOT
  // normalized to boolean via fromDbBool. The old raw-SQL code always
  // returned the column's raw 0/1 straight from better-sqlite3, and every
  // caller (routes/UI) depends on that numeric shape; behavior-preservation
  // beats consistency with the other DbBool columns here (that
  // normalization is a separate future change, per the Task 8 brief).
  enabled: row.enabled as number,
});

export const createWorkspaceRepos = (
  kdb: Kysely<DB>,
  h: DialectHelpers,
): Pick<Storage, "tasks" | "rules" | "commands"> => ({
  tasks: {
    create: async ({ id, project_id, title, description, status, priority, assigned_branch }) => {
      // Position assignment pushed into the INSERT itself (a
      // `coalesce(max(position), -1) + 1` subquery scoped to the project)
      // instead of a JS-side "read max, then write" — same technique as
      // executors.create (Task 6): keeps the whole operation a single
      // atomic SQL statement, so no transaction is needed here even though
      // Kysely's awaits are real microtask yield points.
      await kdb.insertInto("tasks").values((eb) => ({
        id,
        project_id,
        title,
        description: description ?? null,
        status: status ?? "todo",
        priority: priority ?? "medium",
        assigned_branch: assigned_branch ?? null,
        position: eb.selectFrom("tasks")
          .select(sql<number>`coalesce(max(position), -1) + 1`.as("next_position"))
          .where("project_id", "=", project_id),
      })).execute();

      const row = await kdb.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapTask(row);
    },

    getByProjectId: async (projectId, opts) => {
      let query = kdb.selectFrom("tasks").selectAll().where("project_id", "=", projectId);
      if (!opts?.includeArchived) query = query.where("archived_at", "is", null);
      const rows = await query.orderBy("position", "asc").execute();
      return rows.map(mapTask);
    },

    getById: async (id) => {
      const row = await kdb.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapTask(row) : undefined;
    },

    update: async (id, opts) => {
      const sets: Record<string, unknown> = {};
      if (opts.title !== undefined) sets.title = opts.title;
      if (opts.description !== undefined) sets.description = opts.description;
      if (opts.status !== undefined) sets.status = opts.status;
      if (opts.priority !== undefined) sets.priority = opts.priority;
      if (opts.assigned_branch !== undefined) sets.assigned_branch = opts.assigned_branch;
      if (opts.position !== undefined) sets.position = opts.position;

      if (Object.keys(sets).length > 0) {
        sets.updated_at = sql`CURRENT_TIMESTAMP`;
        await kdb.updateTable("tasks").set(sets).where("id", "=", id).execute();
      }
      const row = await kdb.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapTask(row) : undefined;
    },

    archive: async (id) => {
      await kdb.updateTable("tasks")
        .set({ archived_at: Date.now(), updated_at: sql`CURRENT_TIMESTAMP` })
        .where("id", "=", id)
        .execute();
      const row = await kdb.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapTask(row) : undefined;
    },

    unarchive: async (id) => {
      await kdb.updateTable("tasks")
        .set({ archived_at: null, updated_at: sql`CURRENT_TIMESTAMP` })
        .where("id", "=", id)
        .execute();
      const row = await kdb.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapTask(row) : undefined;
    },

    delete: async (id) => {
      await kdb.deleteFrom("tasks").where("id", "=", id).execute();
    },

    reorder: async (projectId, orderedIds) => {
      // Multi-row transaction — already transactional in the old
      // `db.transaction(() => { ... })()` inline code; kept transactional
      // here for the same reason (Task 6's executors.reorder precedent): a
      // partial reorder must never be observable.
      await kdb.transaction().execute(async (trx) => {
        for (let i = 0; i < orderedIds.length; i++) {
          await trx.updateTable("tasks")
            .set({ position: i, updated_at: sql`CURRENT_TIMESTAMP` })
            .where("id", "=", orderedIds[i])
            .where("project_id", "=", projectId)
            .execute();
        }
      });
    },

    completeIfAssigned: async (projectId, branch) => {
      // MUST run inside a transaction. This method's atomicity promise
      // (types.ts docstring) comes from a JS-side read-then-guard-then-write
      // (pick the first-by-position assigned task, then only complete it if
      // it isn't already done), not from DB-level arbitration — the old
      // inline code was atomic for free (raw better-sqlite3 calls, zero
      // internal awaits, so it always ran to completion in one event-loop
      // turn before any other queued storage call could interleave). Every
      // Kysely call is a real Promise, so each `await` here is a microtask
      // yield point EVEN ON the synchronous better-sqlite3 driver: a
      // concurrent edit to the same task (reassignment, cancellation)
      // landing in the window between the SELECT and the UPDATE would be
      // silently overwritten back to "done" (see the completeIfAssigned
      // docstring in types.ts, and the concurrency regression test in
      // workspace.test.ts). The transaction serializes the read-guard-write
      // under better-sqlite3 (one connection, transactions execute
      // one-at-a-time).
      //
      // pg-era caveat: on postgres, a transaction alone does NOT serialize
      // concurrent read-modify-write at the default READ COMMITTED
      // isolation level — the pg backend will additionally need
      // SELECT ... FOR UPDATE (or equivalent row locking) here.
      return kdb.transaction().execute(async (trx) => {
        // Mirror the original call site exactly: pick the FIRST matching
        // task by position (no status filter in the selection), then only
        // complete it if that first match isn't already done. Filtering on
        // status in the WHERE clause would change semantics: if the
        // first-by-position assigned task is already done but a later one
        // isn't, the original code was a no-op — it must not skip ahead and
        // complete the later one.
        const row = await trx.selectFrom("tasks")
          .select(["id", "status"])
          .where("project_id", "=", projectId)
          .where("assigned_branch", "=", branch)
          .where("archived_at", "is", null)
          .orderBy("position", "asc")
          .limit(1)
          .executeTakeFirst();
        if (!row || row.status === "done") return undefined;

        await trx.updateTable("tasks")
          .set({ status: "done", updated_at: sql`CURRENT_TIMESTAMP` })
          .where("id", "=", row.id)
          .execute();
        const updated = await trx.selectFrom("tasks").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
        return mapTask(updated);
      });
    },
  },

  rules: {
    create: async ({ id, project_id, branch, name, content, enabled }) => {
      // Same single-statement correlated-subquery technique as tasks.create
      // above, scoped to (project_id, branch) — `branch IS @branch` covers
      // both the null (project-level) and non-null cases in one comparison
      // (SQLite's IS operator behaves like = except it also matches
      // NULL = NULL), matching the original's more verbose
      // `(branch IS @branch OR (branch IS NULL AND @branch IS NULL))`,
      // which is logically redundant with plain `branch IS @branch`.
      await kdb.insertInto("rules").values((eb) => ({
        id,
        project_id,
        branch,
        name,
        content,
        enabled: h.toDbBool(enabled !== false),
        position: eb.selectFrom("rules")
          .select(sql<number>`coalesce(max(position), -1) + 1`.as("next_position"))
          .where("project_id", "=", project_id)
          .where("branch", "is", branch),
      })).execute();

      const row = await kdb.selectFrom("rules").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapRule(row);
    },

    getByWorkspace: async (projectId, branch) => {
      const rows = await kdb.selectFrom("rules").selectAll()
        .where("project_id", "=", projectId)
        .where("branch", "is", branch)
        .orderBy("position", "asc")
        .execute();
      return rows.map(mapRule);
    },

    getById: async (id) => {
      const row = await kdb.selectFrom("rules").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapRule(row) : undefined;
    },

    update: async (id, opts) => {
      const sets: Record<string, unknown> = {};
      if (opts.name !== undefined) sets.name = opts.name;
      if (opts.content !== undefined) sets.content = opts.content;
      if (opts.enabled !== undefined) sets.enabled = h.toDbBool(opts.enabled);
      if (opts.position !== undefined) sets.position = opts.position;

      if (Object.keys(sets).length > 0) {
        sets.updated_at = sql`datetime('now')`;
        await kdb.updateTable("rules").set(sets).where("id", "=", id).execute();
      }
      const row = await kdb.selectFrom("rules").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapRule(row) : undefined;
    },

    delete: async (id) => {
      await kdb.deleteFrom("rules").where("id", "=", id).execute();
    },

    reorder: async (projectId, branch, orderedIds) => {
      // NOTE: matches the original inline SQL exactly — the UPDATE's WHERE
      // clause only scopes by id + project_id, NOT branch (the `branch`
      // param is accepted for interface symmetry with
      // rules.create/getByWorkspace but was never applied to this
      // particular statement in the pre-port code either). Preserved
      // verbatim per "current behavior wins".
      await kdb.transaction().execute(async (trx) => {
        for (let i = 0; i < orderedIds.length; i++) {
          await trx.updateTable("rules")
            .set({ position: i, updated_at: sql`datetime('now')` })
            .where("id", "=", orderedIds[i])
            .where("project_id", "=", projectId)
            .execute();
        }
      });
    },
  },

  commands: {
    create: async ({ id, project_id, branch, name, content }) => {
      // Same correlated-subquery position assignment as rules.create above.
      await kdb.insertInto("commands").values((eb) => ({
        id,
        project_id,
        branch,
        name,
        content,
        position: eb.selectFrom("commands")
          .select(sql<number>`coalesce(max(position), -1) + 1`.as("next_position"))
          .where("project_id", "=", project_id)
          .where("branch", "is", branch),
      })).execute();

      return kdb.selectFrom("commands").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    getByWorkspace: async (projectId, branch) => {
      return kdb.selectFrom("commands").selectAll()
        .where("project_id", "=", projectId)
        .where("branch", "is", branch)
        .orderBy("position", "asc")
        .execute();
    },

    getById: async (id) => {
      return kdb.selectFrom("commands").selectAll().where("id", "=", id).executeTakeFirst();
    },

    update: async (id, opts) => {
      const sets: Record<string, unknown> = {};
      if (opts.name !== undefined) sets.name = opts.name;
      if (opts.content !== undefined) sets.content = opts.content;
      if (opts.position !== undefined) sets.position = opts.position;

      if (Object.keys(sets).length > 0) {
        sets.updated_at = sql`datetime('now')`;
        await kdb.updateTable("commands").set(sets).where("id", "=", id).execute();
      }
      return kdb.selectFrom("commands").selectAll().where("id", "=", id).executeTakeFirst();
    },

    delete: async (id) => {
      await kdb.deleteFrom("commands").where("id", "=", id).execute();
    },
  },
});
