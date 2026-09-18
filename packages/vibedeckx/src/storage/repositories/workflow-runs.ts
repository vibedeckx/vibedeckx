import { sql, type Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage, WorkflowRun } from "../types.js";
import { WORKFLOW_ACTIVE_STATUSES } from "../workflow-run-status.js";
// NotificationOutboxEvent flows in through Storage["workflowRuns"] signatures,
// which this factory's return type pins.

const ACTIVE = [...WORKFLOW_ACTIVE_STATUSES];

const asRun = (row: unknown): WorkflowRun => row as WorkflowRun;

export const createWorkflowRunRepos = (kdb: Kysely<DB>): Pick<Storage, "workflowRuns"> => ({
  workflowRuns: {
    create: async (opts) => {
      await kdb.insertInto("workflow_runs").values({
        ...opts,
        reviewer_session_id: opts.reviewer_session_id ?? null,
        review_span: opts.review_span ?? "this_turn",
        status: opts.status ?? "waiting_reviewer",
        loop_id: opts.loop_id ?? null,
        round: opts.round ?? 1,
        max_rounds: opts.max_rounds ?? null,
      }).execute();
      const row = await kdb
        .selectFrom("workflow_runs").selectAll().where("id", "=", opts.id)
        .executeTakeFirstOrThrow();
      return asRun(row);
    },
    getById: async (id) => {
      const row = await kdb.selectFrom("workflow_runs").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? asRun(row) : undefined;
    },
    getActive: async (projectId, branch) => {
      const rows = await kdb
        .selectFrom("workflow_runs").selectAll()
        .where("project_id", "=", projectId)
        .where("branch", "is", branch)
        .where("status", "in", ACTIVE)
        .orderBy("created_at", "asc")
        .execute();
      return rows.map(asRun);
    },
    getAllActive: async () => {
      const rows = await kdb
        .selectFrom("workflow_runs").selectAll().where("status", "in", ACTIVE)
        .orderBy("created_at", "asc").execute();
      return rows.map(asRun);
    },
    getActiveBySession: async (sessionId) => {
      const row = await kdb
        .selectFrom("workflow_runs").selectAll()
        .where("status", "in", ACTIVE)
        .where((eb) => eb.or([
          eb("source_session_id", "=", sessionId),
          eb("reviewer_session_id", "=", sessionId),
        ]))
        .executeTakeFirst();
      return row ? asRun(row) : undefined;
    },
    getLatestCompletedBySource: async (sourceSessionId) => {
      const row = await kdb
        .selectFrom("workflow_runs")
        .selectAll()
        .where("source_session_id", "=", sourceSessionId)
        .where("status", "=", "completed")
        .where("reviewer_session_id", "is not", null)
        .orderBy("created_at", "desc")
        .orderBy(sql`rowid`, "desc")
        .executeTakeFirst();
      return row ? asRun(row) : undefined;
    },
    getLoopRound: async (loopId, round) => {
      const row = await kdb.selectFrom("workflow_runs").selectAll()
        .where("loop_id", "=", loopId).where("round", "=", round)
        .orderBy("created_at", "desc").orderBy(sql`rowid`, "desc")
        .executeTakeFirst();
      return row ? asRun(row) : undefined;
    },
    listReviewedSourceSessions: async (projectId, branch) => {
      const rows = await kdb
        .selectFrom("workflow_runs")
        .select("source_session_id")
        .distinct()
        .where("project_id", "=", projectId)
        .where("branch", "is", branch)
        .where("status", "=", "completed")
        .where("reviewer_session_id", "is not", null)
        .execute();
      return rows.map((r) => r.source_session_id);
    },
    update: async (id, patch) => {
      if (Object.keys(patch).length > 0) {
        await kdb.updateTable("workflow_runs")
          .set({ ...patch, updated_at: sql`datetime('now')` })
          .where("id", "=", id).execute();
      }
      const row = await kdb.selectFrom("workflow_runs").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? asRun(row) : undefined;
    },
    transition: async (id, from, to, patch) => {
      const result = await kdb.updateTable("workflow_runs")
        .set({ ...(patch ?? {}), status: to, updated_at: sql`datetime('now')` })
        .where("id", "=", id)
        .where("status", "=", from)
        .executeTakeFirst();
      return (result.numUpdatedRows ?? 0n) > 0n;
    },

    // Guarded update FIRST, then the outbox insert conditioned on it having
    // applied: that ordering is what makes a lost CAS silent. Both statements
    // share one transaction so a crash between them can't leave a notified
    // transition unpersisted (or vice versa).
    transitionWithOutbox: async (id, from, to, patch, outbox) => {
      return kdb.transaction().execute(async (trx) => {
        const result = await trx.updateTable("workflow_runs")
          .set({ ...(patch ?? {}), status: to, updated_at: sql`datetime('now')` })
          .where("id", "=", id)
          .where("status", "=", from)
          .executeTakeFirst();
        if ((result.numUpdatedRows ?? 0n) === 0n) return false;
        await trx.insertInto("notification_outbox")
          .values(outbox)
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
        return true;
      });
    },

    // Step CAS, run CAS and the outbox row in ONE transaction. A guard that
    // fails throws to roll the whole thing back — a claimed step with an
    // un-advanced run would be unrecoverable after a restart.
    claimStepAndTransition: async ({ stepId, turnEndIndex, outputSnapshot, run, nextRun }) => {
      const LOST = Symbol("cas-lost");
      try {
        await kdb.transaction().execute(async (trx) => {
          const step = await trx.updateTable("workflow_run_steps")
            .set({
              status: "claimed", turn_end_index: turnEndIndex, output_snapshot: outputSnapshot,
              error: null, updated_at: sql`datetime('now')`,
            })
            .where("id", "=", stepId)
            .where("status", "=", "dispatched")
            .executeTakeFirst();
          if ((step.numUpdatedRows ?? 0n) === 0n) throw LOST;
          if (run) {
            const moved = await trx.updateTable("workflow_runs")
              .set({ ...(run.patch ?? {}), status: run.to, updated_at: sql`datetime('now')` })
              .where("id", "=", run.id)
              .where("status", "=", run.from)
              .executeTakeFirst();
            if ((moved.numUpdatedRows ?? 0n) === 0n) throw LOST;
            if (run.outbox) {
              await trx.insertInto("notification_outbox")
                .values(run.outbox)
                .onConflict((oc) => oc.column("id").doNothing())
                .execute();
            }
          }
          if (nextRun) {
            // After the run CAS on purpose: the run being completed in this
            // same transaction must not count as occupying its own source.
            await sql`
              INSERT INTO workflow_runs
                (id, project_id, branch, source_session_id, source_turn_end_index, reviewer_session_id,
                 review_focus, review_target, review_span, status, loop_id, round, max_rounds)
              SELECT ${nextRun.id}, ${nextRun.project_id}, ${nextRun.branch}, ${nextRun.source_session_id},
                     ${nextRun.source_turn_end_index}, NULL, ${nextRun.review_focus}, ${nextRun.review_target},
                     'this_turn', 'waiting_rereview', ${nextRun.loop_id}, ${nextRun.round}, ${nextRun.max_rounds}
              WHERE NOT EXISTS (
                SELECT 1 FROM workflow_runs
                WHERE status IN (${sql.join(ACTIVE)})
                  AND (source_session_id = ${nextRun.source_session_id}
                    OR reviewer_session_id = ${nextRun.source_session_id})
              )
            `.execute(trx);
          }
        });
        return true;
      } catch (err) {
        if (err === LOST) return false;
        throw err;
      }

    },
  },
});
