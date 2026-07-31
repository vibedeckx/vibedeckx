import { sql, type Kysely, type Selectable } from "kysely";
import { Cron } from "croner";
import type { DB, ScheduledTasksTable, ScheduledTaskRunsTable } from "../schema.js";
import { fromDbBool, type DialectHelpers } from "../dialect.js";
import type { Storage, ScheduledTask, ScheduledTaskRun, ScheduledTaskRunType, ScheduledTaskCwdMode, ScheduledTaskRunStatus, PromptProvider } from "../types.js";

const mapTask = (row: Selectable<ScheduledTasksTable>): ScheduledTask => ({
  ...row,
  enabled: fromDbBool(row.enabled),
  run_type: row.run_type as ScheduledTaskRunType,
  prompt_provider: (row.prompt_provider as PromptProvider) ?? null,
  cwd_mode: row.cwd_mode as ScheduledTaskCwdMode,
});

const mapRun = (row: Selectable<ScheduledTaskRunsTable>): ScheduledTaskRun => ({
  ...row,
  status: row.status as ScheduledTaskRunStatus,
});

const computeNextRunAt = (cronExpr: string, timezone: string, enabled: boolean): string | null => {
  if (!enabled) return null;
  let cron: Cron | undefined;
  try {
    cron = new Cron(cronExpr, { paused: true, timezone });
    return cron.nextRun()?.toISOString() ?? null;
  } catch {
    return null;
  } finally {
    cron?.stop();
  }
};

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
        prompt_provider: opts.run_type === "prompt" ? (opts.prompt_provider ?? "claude") : null,
        content: opts.content,
        cwd_mode: opts.cwd_mode,
        branch: opts.branch ?? null,
        directory: opts.directory ?? null,
        timeout_seconds: opts.timeout_seconds ?? 1800,
        next_run_at: computeNextRunAt(opts.cron_expr, opts.timezone, opts.enabled !== false),
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
    listByProject: async (projectId, limit) => {
      const rows = await kdb.selectFrom("scheduled_tasks").selectAll()
        .where("project_id", "=", projectId)
        .orderBy("created_at", "asc").orderBy("id", "asc")
        .limit(limit).execute();
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
    getEarliestNextRunAt: async (projectId) => {
      const row = await kdb.selectFrom("scheduled_tasks")
        .select("next_run_at")
        .where("project_id", "=", projectId)
        .where("enabled", "=", h.toDbBool(true))
        .where("next_run_at", "is not", null)
        .orderBy("next_run_at", "asc")
        .limit(1)
        .executeTakeFirst();
      return row?.next_run_at ?? null;
    },
    refreshNextRunAt: async (id) => {
      const current = await kdb.selectFrom("scheduled_tasks")
        .select(["cron_expr", "timezone", "enabled"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!current) return null;
      const nextRunAt = computeNextRunAt(current.cron_expr, current.timezone, fromDbBool(current.enabled));
      await kdb.updateTable("scheduled_tasks").set({ next_run_at: nextRunAt }).where("id", "=", id).execute();
      return nextRunAt;
    },
    update: async (id, opts) => {
      const current = await kdb.selectFrom("scheduled_tasks").selectAll().where("id", "=", id).executeTakeFirst();
      if (!current) return undefined;
      const sets: Record<string, unknown> = {};
      if (opts.name !== undefined) sets.name = opts.name;
      if (opts.cron_expr !== undefined) sets.cron_expr = opts.cron_expr;
      if (opts.timezone !== undefined) sets.timezone = opts.timezone;
      if (opts.target !== undefined) sets.target = opts.target;
      if (opts.enabled !== undefined) sets.enabled = h.toDbBool(opts.enabled);
      if (opts.run_type !== undefined) sets.run_type = opts.run_type;
      if (opts.prompt_provider !== undefined) sets.prompt_provider = opts.prompt_provider;
      if (opts.content !== undefined) sets.content = opts.content;
      if (opts.cwd_mode !== undefined) sets.cwd_mode = opts.cwd_mode;
      if (opts.branch !== undefined) sets.branch = opts.branch;
      if (opts.directory !== undefined) sets.directory = opts.directory;
      if (opts.timeout_seconds !== undefined) sets.timeout_seconds = opts.timeout_seconds;
      const nextRunAt = computeNextRunAt(
        opts.cron_expr ?? current.cron_expr,
        opts.timezone ?? current.timezone,
        opts.enabled ?? fromDbBool(current.enabled),
      );
      if (nextRunAt !== current.next_run_at) sets.next_run_at = nextRunAt;
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
      await kdb.insertInto("scheduled_task_runs").values((eb) => ({
        id, schedule_id, status: st,
        project_id: eb.selectFrom("scheduled_tasks")
          .select("project_id")
          .where("id", "=", schedule_id),
        process_id: process_id ?? null,
        exit_code: null,
        output: null,
        report: null,
        finished_at: st === "running" ? null : sql<string>`CURRENT_TIMESTAMP`,
      })).execute();
      const row = await kdb.selectFrom("scheduled_task_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapRun(row);
    },
    claimManualRequest: async ({ requestId, runId, projectId, scheduleId, sourceRunId = null }) => kdb.transaction().execute(async (trx) => {
      const inserted = await trx.insertInto("scheduled_task_run_requests").values({
        request_id: requestId,
        run_id: runId,
        project_id: projectId,
        schedule_id: scheduleId,
        source_run_id: sourceRunId,
      }).onConflict((oc) => oc.doNothing()).executeTakeFirst();
      const row = await trx.selectFrom("scheduled_task_run_requests")
        .selectAll().where("request_id", "=", requestId).executeTakeFirst();
      if (!row) return "conflict" as const;
      const matches = row.run_id === runId
        && row.project_id === projectId
        && row.schedule_id === scheduleId
        && row.source_run_id === sourceRunId;
      if (!matches) return "conflict" as const;
      const duplicateRunId = await trx.selectFrom("scheduled_task_run_requests")
        .select("request_id").where("run_id", "=", runId).executeTakeFirst();
      if (duplicateRunId?.request_id !== requestId) return "conflict" as const;
      return (inserted.numInsertedOrUpdatedRows ?? 0n) === 1n ? "claimed" as const : "existing" as const;
    }),
    getManualRequest: async (requestId) => {
      const row = await kdb.selectFrom("scheduled_task_run_requests")
        .selectAll().where("request_id", "=", requestId).executeTakeFirst();
      return row ? {
        requestId: row.request_id,
        runId: row.run_id,
        projectId: row.project_id,
        scheduleId: row.schedule_id,
        sourceRunId: row.source_run_id,
        createdAt: row.created_at,
      } : undefined;
    },
    claimStart: async ({ id, scheduleId, processId, ownerToken, effectFingerprint, leaseMs = 30_000 }) => kdb.transaction().execute(async (trx) => {
      const nowMs = Date.now();
      const existing = await trx.selectFrom("scheduled_task_runs")
        .selectAll().where("id", "=", id).executeTakeFirst();
      if (existing) {
        if (existing.schedule_id !== scheduleId
          || (existing.status === "starting" && existing.process_id !== processId)) return "conflict" as const;
        let claim = await trx.selectFrom("scheduled_task_execution_claims")
          .selectAll().where("run_id", "=", id).executeTakeFirst();
        if (!claim) return "conflict" as const;
        if (claim.effect_fingerprint === "") {
          const bound = await trx.updateTable("scheduled_task_execution_claims")
            .set({ effect_fingerprint: effectFingerprint })
            .where("run_id", "=", id).where("schedule_id", "=", scheduleId)
            .where("effect_fingerprint", "=", "").executeTakeFirst();
          if (Number(bound.numUpdatedRows) !== 1) return "conflict" as const;
          claim = { ...claim, effect_fingerprint: effectFingerprint };
        }
        if (claim.effect_fingerprint !== effectFingerprint) return "conflict" as const;
        if (existing.status !== "starting" && existing.status !== "running") return "existing" as const;
        if (claim.owner_token === ownerToken) return "retry" as const;
        if (claim.lease_expires_at > nowMs) return "existing" as const;
        const takeover = await trx.updateTable("scheduled_task_execution_claims")
          .set({ owner_token: ownerToken, lease_expires_at: nowMs + leaseMs })
          .where("run_id", "=", id).where("owner_token", "=", claim.owner_token)
          .where("lease_expires_at", "<=", nowMs).executeTakeFirst();
        return Number(takeover.numUpdatedRows) === 1 ? "retry" as const : "existing" as const;
      }
      const active = await trx.selectFrom("scheduled_task_execution_claims")
        .select("run_id")
        .where("schedule_id", "=", scheduleId)
        .executeTakeFirst();
      if (active) return "occupied" as const;
      await trx.insertInto("scheduled_task_runs").values((eb) => ({
        id, schedule_id: scheduleId, status: "starting", process_id: processId,
        project_id: eb.selectFrom("scheduled_tasks").select("project_id").where("id", "=", scheduleId),
        exit_code: null, output: null, report: null, finished_at: null,
      })).execute();
      await trx.insertInto("scheduled_task_execution_claims").values({
        schedule_id: scheduleId, run_id: id, process_id: processId,
        owner_token: ownerToken, lease_expires_at: nowMs + leaseMs,
        effect_fingerprint: effectFingerprint,
      }).execute();
      return "claimed" as const;
    }),
    heartbeat: async (id, ownerToken, leaseMs = 30_000) => {
      const result = await kdb.updateTable("scheduled_task_execution_claims")
        .set({ lease_expires_at: Date.now() + leaseMs })
        .where("run_id", "=", id).where("owner_token", "=", ownerToken).executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    markRunning: async (id, claimedProcessId, processId = claimedProcessId, ownerToken) => {
      const result = await kdb.updateTable("scheduled_task_runs")
        .set({ status: "running", process_id: processId })
        .where("id", "=", id)
        .where("status", "in", ["starting", "running"])
        .where("process_id", "=", claimedProcessId)
        .$if(ownerToken !== undefined, (qb) => qb.where("id", "in", kdb.selectFrom("scheduled_task_execution_claims")
          .select("run_id").where("owner_token", "=", ownerToken!)))
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    failBeforeStart: async ({ id, scheduleId, output }) => {
      const result = await kdb.insertInto("scheduled_task_runs").values((eb) => ({
        id, schedule_id: scheduleId, status: "failed",
        project_id: eb.selectFrom("scheduled_tasks")
          .select("project_id").where("id", "=", scheduleId),
        process_id: null, exit_code: null, output, report: null,
        finished_at: sql<string>`CURRENT_TIMESTAMP`,
      })).onConflict((oc) => oc.column("id").doNothing()).executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) === 1n;
    },
    getById: async (id) => {
      const row = await kdb.selectFrom("scheduled_task_runs").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapRun(row) : undefined;
    },
    listRecentByProject: async (projectId, limit) => {
      const rows = await kdb.selectFrom("scheduled_task_runs as run")
        .select([
          "run.id", "run.schedule_id", "run.project_id", "run.status", "run.exit_code",
          sql<string | null>`NULL`.as("output"), sql<string | null>`NULL`.as("report"),
          "run.process_id", "run.started_at", "run.finished_at",
        ])
        .where("run.project_id", "=", projectId)
        .orderBy("run.started_at", "desc").orderBy("run.id", "desc")
        .limit(limit).execute();
      return rows.map(mapRun);
    },
    getRecentByProject: async (projectId, limit) => {
      const candidates = kdb.selectFrom("scheduled_task_runs as run")
        .select([
          "run.id", "run.schedule_id", "run.status", "run.exit_code", "run.process_id",
          "run.started_at", "run.finished_at",
          sql<string | null>`case when run.report is null then null else substr(run.report, 1, 500) end`.as("reportPreview"),
        ])
        .where("run.project_id", "=", projectId)
        .orderBy("run.started_at", "desc")
        .orderBy("run.id", "desc")
        .limit(limit)
        .as("candidate");
      const rows = await kdb.selectFrom(candidates)
        .innerJoin("scheduled_tasks as schedule", "schedule.id", "candidate.schedule_id")
        .select([
          "candidate.id", "candidate.schedule_id", "candidate.status", "candidate.exit_code",
          "candidate.process_id", "candidate.started_at", "candidate.finished_at", "candidate.reportPreview",
          "schedule.name as scheduleName", "schedule.branch", "schedule.target",
        ])
        .orderBy("candidate.started_at", "desc")
        .orderBy("candidate.id", "desc")
        .execute();
      return rows.map((row) => ({
        ...row,
        status: row.status as ScheduledTaskRunStatus,
      }));
    },
    getAttentionByProject: async (projectId, limit) => {
      const occurredAt = sql<string>`coalesce(run.finished_at, run.started_at)`;
      const candidates = kdb.selectFrom("scheduled_task_runs as run")
        .select([
          "run.id", "run.schedule_id", "run.status", "run.exit_code", "run.process_id",
          "run.started_at", "run.finished_at",
          sql<string | null>`case when run.report is null then null else substr(run.report, 1, 500) end`.as("reportPreview"),
        ])
        .where("run.project_id", "=", projectId)
        // Keep this predicate literal-equivalent to the partial index definition.
        .where(sql<boolean>`run.status IN ('failed', 'timeout')`)
        .orderBy(occurredAt, "desc")
        .orderBy("run.id", "desc")
        .limit(limit)
        .as("candidate");
      const rows = await kdb.selectFrom(candidates)
        .innerJoin("scheduled_tasks as schedule", "schedule.id", "candidate.schedule_id")
        .select([
          "candidate.id", "candidate.schedule_id", "candidate.status", "candidate.exit_code",
          "candidate.process_id", "candidate.started_at", "candidate.finished_at", "candidate.reportPreview",
          "schedule.name as scheduleName", "schedule.branch", "schedule.target",
        ])
        .orderBy(sql<string>`coalesce(candidate.finished_at, candidate.started_at)`, "desc")
        .orderBy("candidate.id", "desc")
        .execute();
      return rows.map((row) => ({
        ...row,
        status: row.status as ScheduledTaskRunStatus,
      }));
    },
    countByProjectStatuses: async (projectId, statuses) => {
      if (statuses.length === 0) return 0;
      const row = await kdb.selectFrom("scheduled_task_runs as run")
        .select(kdb.fn.countAll<number>().as("count"))
        .where("run.project_id", "=", projectId)
        .where("run.status", "in", statuses)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
    getByScheduleId: async (scheduleId, limit = 50) => {
      const rows = await kdb.selectFrom("scheduled_task_runs")
        .select(["id", "schedule_id", "project_id", "status", "exit_code", sql<string | null>`NULL`.as("output"), sql<string | null>`NULL`.as("report"), "process_id", "started_at", "finished_at"])
        .where("schedule_id", "=", scheduleId)
        .orderBy("started_at", "desc").orderBy(h.rowIdDesc())
        .limit(limit).execute();
      return rows.map(mapRun);
    },
    getLastByScheduleIds: async (scheduleIds) => {
      const result: Record<string, ScheduledTaskRun> = {};
      for (const sid of scheduleIds) {
        const row = await kdb.selectFrom("scheduled_task_runs")
          .select(["id", "schedule_id", "project_id", "status", "exit_code", sql<string | null>`NULL`.as("output"), sql<string | null>`NULL`.as("report"), "process_id", "started_at", "finished_at"])
          .where("schedule_id", "=", sid)
          .orderBy("started_at", "desc").orderBy(h.rowIdDesc())
          .limit(1).executeTakeFirst();
        if (row) result[sid] = mapRun(row);
      }
      return result;
    },
    finish: async (id, opts) => {
      await kdb.transaction().execute(async (trx) => {
        await trx.updateTable("scheduled_task_runs").set({
          status: opts.status,
          exit_code: opts.exit_code ?? null,
          output: opts.output ?? null,
          report: opts.report ?? null,
          finished_at: sql<string>`CURRENT_TIMESTAMP`,
        }).where("id", "=", id).execute();
        await trx.deleteFrom("scheduled_task_execution_claims").where("run_id", "=", id).execute();
      });
    },
    finishOwned: async (id, ownerToken, opts) => kdb.transaction().execute(async (trx) => {
      const result = await trx.updateTable("scheduled_task_runs").set({
        status: opts.status,
        exit_code: opts.exit_code ?? null,
        output: opts.output ?? null,
        report: opts.report ?? null,
        finished_at: sql<string>`CURRENT_TIMESTAMP`,
      }).where("id", "=", id)
        .where("status", "in", ["starting", "running"])
        .where("id", "in", trx.selectFrom("scheduled_task_execution_claims")
          .select("run_id").where("owner_token", "=", ownerToken))
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return false;
      const deleted = await trx.deleteFrom("scheduled_task_execution_claims")
        .where("run_id", "=", id).where("owner_token", "=", ownerToken).executeTakeFirst();
      if (Number(deleted.numDeletedRows) !== 1) {
        throw new Error("Scheduled run claim changed during owned finalization");
      }
      return true;
    }),
    prune: async (scheduleId, keep) => {
      // Never delete a claimed or running row.
      await kdb.deleteFrom("scheduled_task_runs")
        .where("schedule_id", "=", scheduleId)
        .where("status", "not in", ["starting", "running"])
        .where("id", "not in", kdb.selectFrom("scheduled_task_runs").select("id")
          .where("schedule_id", "=", scheduleId)
          .orderBy("started_at", "desc").orderBy(h.rowIdDesc())
          .limit(keep))
        .execute();
    },
  },
});
