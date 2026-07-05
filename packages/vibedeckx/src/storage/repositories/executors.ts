import { sql, type Kysely, type Selectable } from "kysely";
import type { DB, ExecutorsTable, ExecutorProcessesTable, RemoteExecutorProcessesTable } from "../schema.js";
import { fromDbBool, type DialectHelpers } from "../dialect.js";
import type {
  Storage,
  Executor,
  ExecutorType,
  PromptProvider,
  ExecutorProcess,
  ExecutorProcessStatus,
  RemoteExecutorProcessRow,
} from "../types.js";

const mapExecutor = (row: Selectable<ExecutorsTable>): Executor => ({
  ...row,
  // The DB column is nullable (legacy DDL), but every real caller supplies a
  // group_id (routes/executor-routes.ts requires it; scheduler.ts/
  // process-routes.ts pass ""), so this never actually surfaces null.
  group_id: row.group_id ?? "",
  executor_type: (row.executor_type || "command") as ExecutorType,
  prompt_provider: (row.prompt_provider as PromptProvider) ?? null,
  pty: fromDbBool(row.pty),
  disabled_targets: row.disabled_targets ? (JSON.parse(row.disabled_targets) as string[]) : [],
});

const mapExecutorProcess = (row: Selectable<ExecutorProcessesTable>): ExecutorProcess => ({
  ...row,
  status: row.status as ExecutorProcessStatus,
});

const mapRemoteExecutorProcess = (row: Selectable<RemoteExecutorProcessesTable>): RemoteExecutorProcessRow => ({
  ...row,
  status: row.status as ExecutorProcessStatus,
});

export const createExecutorRepos = (
  kdb: Kysely<DB>,
  h: DialectHelpers,
): Pick<Storage, "executorGroups" | "executors" | "executorProcesses" | "remoteExecutorProcesses"> => ({
  executorGroups: {
    create: async ({ id, project_id, name, branch }) => {
      await kdb.insertInto("executor_groups").values({ id, project_id, name, branch }).execute();
      const row = await kdb.selectFrom("executor_groups").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return row;
    },

    getByProjectId: async (projectId) => {
      return kdb.selectFrom("executor_groups").selectAll()
        .where("project_id", "=", projectId)
        .orderBy("created_at", "asc")
        .execute();
    },

    getById: async (id) => {
      return kdb.selectFrom("executor_groups").selectAll().where("id", "=", id).executeTakeFirst();
    },

    getByBranch: async (projectId, branch) => {
      return kdb.selectFrom("executor_groups").selectAll()
        .where("project_id", "=", projectId).where("branch", "=", branch)
        .executeTakeFirst();
    },

    createIfBranchFree: async ({ id, project_id, name, branch }) => {
      // DB-level arbitration via the table's UNIQUE(project_id, branch)
      // index — the old `INSERT OR IGNORE` + re-read, ported to
      // `.onConflict(...).doNothing()` + re-read. No transaction needed: a
      // single guarded statement is atomic on its own (see the pg-era note
      // on executors.setTargetDisabled below for when a transaction IS
      // required).
      //
      // This targets only the (project_id, branch) unique index, not the
      // `id` primary key. The old `INSERT OR IGNORE` silently swallowed a
      // conflict on EITHER constraint, but every caller always supplies a
      // fresh id (crypto.randomUUID()-style), so an `id` collision never
      // happens in practice; if it somehow did, this port surfaces a
      // constraint-violation error instead of silently ignoring it, which
      // is arguably the safer behavior for a bug that should never occur.
      const result = await kdb.insertInto("executor_groups")
        .values({ id, project_id, name, branch })
        .onConflict((oc) => oc.columns(["project_id", "branch"]).doNothing())
        .executeTakeFirst();
      const group = await kdb.selectFrom("executor_groups").selectAll()
        .where("project_id", "=", project_id).where("branch", "=", branch)
        .executeTakeFirstOrThrow();
      return { created: (result?.numInsertedOrUpdatedRows ?? 0n) > 0n, group };
    },

    update: async (id, opts) => {
      if (opts.name !== undefined) {
        await kdb.updateTable("executor_groups").set({ name: opts.name }).where("id", "=", id).execute();
      }
      return kdb.selectFrom("executor_groups").selectAll().where("id", "=", id).executeTakeFirst();
    },

    delete: async (id) => {
      await kdb.deleteFrom("executor_groups").where("id", "=", id).execute();
    },
  },

  executors: {
    create: async ({ id, project_id, group_id, name, command, executor_type, prompt_provider, cwd, pty }) => {
      // Position assignment pushed into the INSERT itself (a
      // `coalesce(max(position), -1) + 1` subquery scoped to the group)
      // instead of a JS-side "read max, then write" — that keeps the whole
      // operation a single atomic SQL statement, so unlike
      // setTargetDisabled below, no transaction is needed here even though
      // Kysely's awaits are real microtask yield points.
      await kdb.insertInto("executors").values((eb) => ({
        id, project_id, group_id, name, command,
        executor_type: executor_type ?? "command",
        prompt_provider: prompt_provider ?? null,
        cwd: cwd ?? null,
        pty: h.toDbBool(pty !== false),
        position: eb.selectFrom("executors")
          .select(sql<number>`coalesce(max(position), -1) + 1`.as("next_position"))
          .where("group_id", "=", group_id),
      })).execute();

      const row = await kdb.selectFrom("executors").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapExecutor(row);
    },

    getByProjectId: async (projectId) => {
      const rows = await kdb.selectFrom("executors").selectAll()
        .where("project_id", "=", projectId)
        .orderBy("position", "asc")
        .execute();
      return rows.map(mapExecutor);
    },

    getByGroupId: async (groupId) => {
      const rows = await kdb.selectFrom("executors").selectAll()
        .where("group_id", "=", groupId)
        .orderBy("position", "asc")
        .execute();
      return rows.map(mapExecutor);
    },

    getById: async (id) => {
      const row = await kdb.selectFrom("executors").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapExecutor(row) : undefined;
    },

    update: async (id, opts) => {
      const sets: Record<string, unknown> = {};
      if (opts.name !== undefined) sets.name = opts.name;
      if (opts.command !== undefined) sets.command = opts.command;
      if (opts.executor_type !== undefined) sets.executor_type = opts.executor_type;
      if (opts.prompt_provider !== undefined) sets.prompt_provider = opts.prompt_provider;
      if (opts.cwd !== undefined) sets.cwd = opts.cwd;
      if (opts.pty !== undefined) sets.pty = h.toDbBool(opts.pty);
      if (opts.disabled_targets !== undefined) sets.disabled_targets = JSON.stringify(opts.disabled_targets);

      if (Object.keys(sets).length > 0) {
        await kdb.updateTable("executors").set(sets).where("id", "=", id).execute();
      }
      const row = await kdb.selectFrom("executors").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapExecutor(row) : undefined;
    },

    setTargetDisabled: async (id, target, disabled) => {
      // MUST run inside a transaction. This method's atomicity promise
      // (types.ts docstring) comes from a JS-side read-modify-write of the
      // disabled_targets JSON Set, not DB-level arbitration — the old
      // inline code was atomic for free (raw better-sqlite3 calls, zero
      // internal awaits, so it always ran to completion in one event-loop
      // turn). Every Kysely call is a real Promise, so each `await` here is
      // a microtask yield point EVEN ON the synchronous better-sqlite3
      // driver: two concurrent setTargetDisabled() calls for the same
      // executor could interleave read->read->write->write and silently
      // drop one toggle (e.g. disabling "local" and a remote server at
      // nearly the same time, with one edit clobbering the other). The
      // transaction serializes the read-modify-write under better-sqlite3
      // (one connection, transactions execute one-at-a-time).
      //
      // pg-era caveat: on postgres, a transaction alone does NOT serialize
      // concurrent read-modify-write at the default READ COMMITTED
      // isolation level — the pg backend will additionally need
      // SELECT ... FOR UPDATE (or equivalent row locking) here.
      return kdb.transaction().execute(async (trx) => {
        const existing = await trx.selectFrom("executors").selectAll().where("id", "=", id).executeTakeFirst();
        if (!existing) return undefined;
        const current = new Set(existing.disabled_targets ? (JSON.parse(existing.disabled_targets) as string[]) : []);
        if (disabled) current.add(target);
        else current.delete(target);
        await trx.updateTable("executors")
          .set({ disabled_targets: JSON.stringify([...current]) })
          .where("id", "=", id)
          .execute();
        const row = await trx.selectFrom("executors").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
        return mapExecutor(row);
      });
    },

    delete: async (id) => {
      await kdb.deleteFrom("executors").where("id", "=", id).execute();
    },

    reorder: async (groupId, orderedIds) => {
      // Multi-row transaction — already transactional in the old
      // `db.transaction(() => { ... })()` inline code; kept transactional
      // here for the same reason (a partial reorder must never be
      // observable).
      await kdb.transaction().execute(async (trx) => {
        for (let i = 0; i < orderedIds.length; i++) {
          await trx.updateTable("executors")
            .set({ position: i })
            .where("id", "=", orderedIds[i])
            .where("group_id", "=", groupId)
            .execute();
        }
      });
    },
  },

  executorProcesses: {
    create: async ({ id, executor_id, pid }) => {
      await kdb.insertInto("executor_processes").values({
        id, executor_id,
        pid: pid ?? null,
        status: "running",
        exit_code: null,
        finished_at: null,
      }).execute();
      const row = await kdb.selectFrom("executor_processes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapExecutorProcess(row);
    },

    getById: async (id) => {
      const row = await kdb.selectFrom("executor_processes").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapExecutorProcess(row) : undefined;
    },

    getRunning: async () => {
      const rows = await kdb.selectFrom("executor_processes").selectAll().where("status", "=", "running").execute();
      return rows.map(mapExecutorProcess);
    },

    getLastByExecutorId: async (executorId) => {
      const row = await kdb.selectFrom("executor_processes").selectAll()
        .where("executor_id", "=", executorId)
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return row ? mapExecutorProcess(row) : undefined;
    },

    getLastByExecutorIds: async (executorIds) => {
      if (executorIds.length === 0) return [];
      // DIALECT-OK: ANSI window function (ROW_NUMBER), supported by both
      // sqlite and postgres. No secondary tiebreak column — matches the old
      // raw SQL exactly, including its tie-break quirk (see
      // executors.test.ts) where rows with an identical started_at keep
      // whatever order SQLite's internal sort happens to produce.
      const ranked = kdb.selectFrom("executor_processes")
        .select([
          "id", "executor_id", "pid", "status", "exit_code", "started_at", "finished_at",
          sql<number>`row_number() over (partition by executor_id order by started_at desc)`.as("rn"),
        ])
        .where("executor_id", "in", executorIds);
      const rows = await kdb.selectFrom(ranked.as("ranked"))
        .select(["id", "executor_id", "pid", "status", "exit_code", "started_at", "finished_at"])
        .where("rn", "=", 1)
        .execute();
      return rows.map(mapExecutorProcess);
    },

    updateStatus: async (id, status, exitCode) => {
      const finishedAt = status !== "running" ? new Date().toISOString() : null;
      await kdb.updateTable("executor_processes")
        .set({ status, exit_code: exitCode ?? null, finished_at: finishedAt })
        .where("id", "=", id)
        .execute();
    },

    updatePid: async (id, pid) => {
      await kdb.updateTable("executor_processes").set({ pid }).where("id", "=", id).execute();
    },

    markKilledIfRunning: async (id) => {
      // DB-level arbitration via the guarded `WHERE status = 'running'` —
      // no transaction needed (see the note on setTargetDisabled above for
      // when one is).
      await kdb.updateTable("executor_processes")
        .set({ status: "killed", exit_code: null, finished_at: new Date().toISOString() })
        .where("id", "=", id)
        .where("status", "=", "running")
        .execute();
    },
  },

  remoteExecutorProcesses: {
    insert: async (localProcessId, info) => {
      // sqlite-specific `INSERT OR REPLACE` (Kysely's `.orReplace()`,
      // "only supported by some dialects like SQLite" per its own docs) —
      // ported literally to preserve REPLACE's reset semantics: columns not
      // listed here (status/exit_code/finished_at) fall back to the fresh-
      // row values (running/null/null) rather than being preserved, exactly
      // like the old raw `INSERT OR REPLACE INTO remote_executor_processes
      // (...)` statement (see executors.test.ts's "INSERT OR REPLACE"
      // test). A future postgres backend will need an
      // `.onConflict((oc) => oc.column("local_process_id").doUpdateSet({
      // ..., status: "running", exit_code: null, finished_at: null }))`
      // upsert to reproduce the same reset-on-reinsert behavior.
      await kdb.insertInto("remote_executor_processes")
        .orReplace()
        .values({
          local_process_id: localProcessId,
          remote_server_id: info.remoteServerId,
          remote_url: info.remoteUrl,
          remote_api_key: info.remoteApiKey,
          remote_process_id: info.remoteProcessId,
          executor_id: info.executorId,
          project_id: info.projectId ?? null,
          branch: info.branch ?? null,
          machine_id: info.machineId ?? null,
        })
        .execute();
    },

    delete: async (localProcessId) => {
      await kdb.deleteFrom("remote_executor_processes").where("local_process_id", "=", localProcessId).execute();
    },

    markFinished: async (localProcessId, exitCode, status) => {
      const finalStatus: ExecutorProcessStatus =
        status ?? ((exitCode === undefined || exitCode === 0) ? "completed" : "failed");
      await kdb.updateTable("remote_executor_processes")
        .set({ status: finalStatus, exit_code: exitCode ?? null, finished_at: new Date().toISOString() })
        .where("local_process_id", "=", localProcessId)
        .where("status", "=", "running")
        .execute();
    },

    getById: async (localProcessId) => {
      const row = await kdb.selectFrom("remote_executor_processes").selectAll()
        .where("local_process_id", "=", localProcessId)
        .executeTakeFirst();
      return row ? mapRemoteExecutorProcess(row) : undefined;
    },

    getLastByExecutorId: async (executorId) => {
      // Skip terminal rows (executor_id = '') and order by started_at DESC.
      if (!executorId) return undefined;
      const row = await kdb.selectFrom("remote_executor_processes").selectAll()
        .where("executor_id", "=", executorId)
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return row ? mapRemoteExecutorProcess(row) : undefined;
    },

    getLastByExecutorIdsGroupedByServer: async (executorIds) => {
      if (executorIds.length === 0) return [];
      // DIALECT-OK: ANSI window function. ROW_NUMBER partitioned by
      // (executor_id, remote_server_id) gives the most recent row for every
      // (executor, server) pair in one shot — same tie-break caveat as
      // executorProcesses.getLastByExecutorIds above.
      const ranked = kdb.selectFrom("remote_executor_processes")
        .selectAll()
        .select(
          sql<number>`row_number() over (partition by executor_id, remote_server_id order by started_at desc)`.as("rn"),
        )
        .where("executor_id", "in", executorIds);
      const rows = await kdb.selectFrom(ranked.as("ranked"))
        .selectAll(["ranked"])
        .where("rn", "=", 1)
        .execute();
      return rows.map(mapRemoteExecutorProcess);
    },

    getRunning: async () => {
      const rows = await kdb.selectFrom("remote_executor_processes").selectAll()
        .where("status", "=", "running")
        .execute();
      return rows.map(mapRemoteExecutorProcess);
    },

    getRunningByMachine: async (machineId) => {
      const rows = await kdb.selectFrom("remote_executor_processes").selectAll()
        .where("status", "=", "running").where("machine_id", "=", machineId)
        .execute();
      return rows.map(mapRemoteExecutorProcess);
    },

    getAll: async () => {
      const rows = await kdb.selectFrom("remote_executor_processes").selectAll().execute();
      return rows.map(mapRemoteExecutorProcess);
    },
  },
});
