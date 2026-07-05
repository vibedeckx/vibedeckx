import { sql, type Kysely, type Selectable } from "kysely";
import type { DB, ScheduledTasksTable, ScheduledTaskRunsTable } from "../schema.js";
import { fromDbBool, type DialectHelpers } from "../dialect.js";
import type { Storage, ScheduledTask, ScheduledTaskRun, ScheduledTaskRunType, ScheduledTaskCwdMode, ScheduledTaskRunStatus } from "../types.js";

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
        exit_code: null,
        output: null,
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
      // Never delete a 'running' row — see original comment at sqlite.ts:1601.
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
