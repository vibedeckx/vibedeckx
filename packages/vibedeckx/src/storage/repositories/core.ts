import { type Kysely, type Selectable } from "kysely";
import type { DB, ProjectsTable } from "../schema.js";
import { fromDbBool, type DialectHelpers } from "../dialect.js";
import type { Storage, Project, ExecutionMode, SyncButtonConfig } from "../types.js";

const mapProject = (row: Selectable<ProjectsTable>): Project => ({
  id: row.id,
  name: row.name,
  path: row.path,
  is_remote: fromDbBool(row.is_remote),
  remote_path: row.remote_path ?? undefined,
  remote_url: row.remote_url ?? undefined,
  remote_api_key: row.remote_api_key ?? undefined,
  agent_mode: (row.agent_mode as ExecutionMode) ?? "local",
  executor_mode: (row.executor_mode as ExecutionMode) ?? "local",
  sync_up_config: row.sync_up_config ? (JSON.parse(row.sync_up_config) as SyncButtonConfig) : undefined,
  sync_down_config: row.sync_down_config ? (JSON.parse(row.sync_down_config) as SyncButtonConfig) : undefined,
  created_at: row.created_at,
});

export const createCoreRepos = (
  kdb: Kysely<DB>,
  h: DialectHelpers,
): Pick<Storage, "projects" | "settings"> => ({
  projects: {
    create: async (opts, userId) => {
      await kdb.insertInto("projects").values({
        id: opts.id,
        name: opts.name,
        path: opts.path ?? null,
        remote_path: opts.remote_path ?? null,
        // is_remote is derived from remote_url, same as the legacy inline code.
        is_remote: h.toDbBool(!!opts.remote_url),
        remote_url: opts.remote_url ?? null,
        remote_api_key: opts.remote_api_key ?? null,
        // Dead column: never populated by any current caller (kept only so
        // legacy DDL/back-compat readers relying on its presence don't break).
        remote_project_id: null,
        agent_mode: opts.agent_mode ?? "local",
        executor_mode: opts.executor_mode ?? "local",
        sync_up_config: opts.sync_up_config ? JSON.stringify(opts.sync_up_config) : null,
        sync_down_config: opts.sync_down_config ? JSON.stringify(opts.sync_down_config) : null,
        user_id: userId ?? "",
      }).execute();

      const row = await kdb.selectFrom("projects").selectAll().where("id", "=", opts.id).executeTakeFirstOrThrow();
      return mapProject(row);
    },

    getAll: async (userId) => {
      // Exclude path:* pseudo-projects: these are bookkeeping rows inserted
      // by /api/path/agent-sessions* to satisfy agent_sessions' FK when this
      // instance is being used as a remote provider. They have no user-facing
      // meaning and should never appear in the project list. getById /
      // getByPath intentionally still see them so FK resolution and remote
      // session list proxying continue to work.
      let query = kdb.selectFrom("projects").selectAll().where("id", "not like", "path:%");
      if (userId) query = query.where("user_id", "=", userId);
      const rows = await query.orderBy("created_at", "desc").execute();
      return rows.map(mapProject);
    },

    getById: async (id, userId) => {
      let query = kdb.selectFrom("projects").selectAll().where("id", "=", id);
      if (userId) query = query.where("user_id", "=", userId);
      const row = await query.executeTakeFirst();
      return row ? mapProject(row) : undefined;
    },

    getByPath: async (projectPath) => {
      const row = await kdb.selectFrom("projects").selectAll().where("path", "=", projectPath).executeTakeFirst();
      return row ? mapProject(row) : undefined;
    },

    update: async (id, opts, userId) => {
      const sets: Record<string, unknown> = {};
      if (opts.name !== undefined) sets.name = opts.name;
      if (opts.path !== undefined) sets.path = opts.path;
      if (opts.remote_path !== undefined) sets.remote_path = opts.remote_path;
      if (opts.remote_url !== undefined) sets.remote_url = opts.remote_url;
      if (opts.remote_api_key !== undefined) sets.remote_api_key = opts.remote_api_key;
      if (opts.agent_mode !== undefined) sets.agent_mode = opts.agent_mode;
      if (opts.executor_mode !== undefined) sets.executor_mode = opts.executor_mode;
      if (opts.sync_up_config !== undefined) {
        sets.sync_up_config = opts.sync_up_config ? JSON.stringify(opts.sync_up_config) : null;
      }
      if (opts.sync_down_config !== undefined) {
        sets.sync_down_config = opts.sync_down_config ? JSON.stringify(opts.sync_down_config) : null;
      }
      // Auto-derive is_remote from remote_url, same condition as the legacy code.
      if (opts.remote_url !== undefined) {
        sets.is_remote = h.toDbBool(!!opts.remote_url);
      }

      if (Object.keys(sets).length > 0) {
        let query = kdb.updateTable("projects").set(sets).where("id", "=", id);
        if (userId) query = query.where("user_id", "=", userId);
        await query.execute();
      }

      let readQuery = kdb.selectFrom("projects").selectAll().where("id", "=", id);
      if (userId) readQuery = readQuery.where("user_id", "=", userId);
      const row = await readQuery.executeTakeFirst();
      return row ? mapProject(row) : undefined;
    },

    delete: async (id, userId) => {
      let query = kdb.deleteFrom("projects").where("id", "=", id);
      if (userId) query = query.where("user_id", "=", userId);
      await query.execute();
    },
  },

  settings: {
    get: async (key) => {
      const row = await kdb.selectFrom("global_settings").select("value").where("key", "=", key).executeTakeFirst();
      return row?.value;
    },

    set: async (key, value) => {
      await kdb.insertInto("global_settings").values({ key, value })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
        .execute();
    },

    delete: async (key) => {
      await kdb.deleteFrom("global_settings").where("key", "=", key).execute();
    },

    getOrCreate: async (key, factory) => {
      const existing = await kdb.selectFrom("global_settings").select("value").where("key", "=", key).executeTakeFirst();
      if (existing) return existing.value;
      const value = factory();
      // INSERT OR IGNORE — the loser of a concurrent race falls through to
      // the re-read below and gets the winner's persisted value.
      await kdb.insertInto("global_settings").values({ key, value })
        .onConflict((oc) => oc.column("key").doNothing())
        .execute();
      const row = await kdb.selectFrom("global_settings").select("value").where("key", "=", key).executeTakeFirstOrThrow();
      return row.value;
    },

    update: async (key, mergeFn) => {
      const existing = await kdb.selectFrom("global_settings").select("value").where("key", "=", key).executeTakeFirst();
      const next = mergeFn(existing?.value);
      await kdb.insertInto("global_settings").values({ key, value: next })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: next }))
        .execute();
      return next;
    },
  },
});
