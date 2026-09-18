import { sql, type Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage, WorkflowRunStep } from "../types.js";

const asStep = (row: unknown): WorkflowRunStep => row as WorkflowRunStep;

export const createWorkflowRunStepRepos = (kdb: Kysely<DB>): Pick<Storage, "workflowRunSteps"> => ({
  workflowRunSteps: {
    // Lookup and insert share a transaction so two concurrent opens of the
    // same (run, kind) resolve to one row; the partial unique index is the
    // backstop if they ever interleave anyway.
    open: async (opts) => {
      return kdb.transaction().execute(async (trx) => {
        const existing = await trx.selectFrom("workflow_run_steps").selectAll()
          .where("run_id", "=", opts.run_id)
          .where("kind", "=", opts.kind)
          .where("status", "=", "dispatched")
          .executeTakeFirst();
        if (existing) return { step: asStep(existing), reused: true };

        // Abandoned steps never happened as far as rounds go.
        const max = await trx.selectFrom("workflow_run_steps")
          .select((eb) => eb.fn.max("round").as("round"))
          .where("run_id", "=", opts.run_id)
          .where("status", "!=", "abandoned")
          .executeTakeFirst();
        const current = Number(max?.round ?? 0);
        const round = opts.kind === "feedback" ? Math.max(current, 1) : current + 1;

        await trx.insertInto("workflow_run_steps").values({
          id: opts.id, run_id: opts.run_id, round, role: opts.role, kind: opts.kind,
          session_id: opts.session_id, idempotency_key: opts.idempotency_key,
          payload_hash: opts.payload_hash, status: "dispatched",
          user_entry_index: null, turn_end_index: null, output_snapshot: null, error: null,
        }).execute();
        const row = await trx.selectFrom("workflow_run_steps").selectAll()
          .where("id", "=", opts.id).executeTakeFirstOrThrow();
        return { step: asStep(row), reused: false };
      });
    },
    getById: async (id) => {
      const row = await kdb.selectFrom("workflow_run_steps").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? asStep(row) : undefined;
    },
    getOpenBySession: async (sessionId) => {
      const rows = await kdb.selectFrom("workflow_run_steps").selectAll()
        .where("session_id", "=", sessionId).where("status", "=", "dispatched")
        .orderBy("created_at", "asc").orderBy(sql`rowid`, "asc").execute();
      return rows.map(asStep);
    },
    listAllOpen: async () => {
      const rows = await kdb.selectFrom("workflow_run_steps").selectAll()
        .where("status", "=", "dispatched")
        .orderBy("created_at", "asc").orderBy(sql`rowid`, "asc").execute();
      return rows.map(asStep);
    },
    listByRun: async (runId) => {
      const rows = await kdb.selectFrom("workflow_run_steps").selectAll()
        .where("run_id", "=", runId)
        .orderBy("round", "asc").orderBy(sql`rowid`, "asc").execute();
      return rows.map(asStep);
    },
    hasAny: async (runId) => {
      const row = await kdb.selectFrom("workflow_run_steps").select("id")
        .where("run_id", "=", runId).limit(1).executeTakeFirst();
      return row !== undefined;
    },
    setUserEntryIndex: async (id, entryIndex) => {
      const result = await kdb.updateTable("workflow_run_steps")
        .set({ user_entry_index: entryIndex, updated_at: sql`datetime('now')` })
        .where("id", "=", id).where("status", "=", "dispatched")
        .executeTakeFirst();
      return (result.numUpdatedRows ?? 0n) > 0n;
    },
    abandon: async (id, error) => {
      const result = await kdb.updateTable("workflow_run_steps")
        .set({ status: "abandoned", error, updated_at: sql`datetime('now')` })
        .where("id", "=", id).where("status", "=", "dispatched")
        .executeTakeFirst();
      return (result.numUpdatedRows ?? 0n) > 0n;
    },
    abandonOpenByRun: async (runId, error, role) => {
      let q = kdb.updateTable("workflow_run_steps")
        .set({ status: "abandoned", error, updated_at: sql`datetime('now')` })
        .where("run_id", "=", runId).where("status", "=", "dispatched");
      if (role) q = q.where("role", "=", role);
      const result = await q.executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n);
    },
    setError: async (id, error) => {
      await kdb.updateTable("workflow_run_steps")
        .set({ error, updated_at: sql`datetime('now')` })
        .where("id", "=", id).where("status", "=", "dispatched")
        .execute();
    },
  },
});
