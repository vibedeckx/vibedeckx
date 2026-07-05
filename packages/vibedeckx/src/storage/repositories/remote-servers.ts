import crypto from "crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import type { DB, RemoteServersTable, ProjectRemotesTable } from "../schema.js";
import type { DialectHelpers } from "../dialect.js";
import type {
  Storage,
  RemoteServer,
  RemoteServerConnectionMode,
  RemoteServerStatus,
  ProjectRemote,
  ProjectRemoteWithServer,
  SyncButtonConfig,
} from "../types.js";

const mapRemoteServer = (row: Selectable<RemoteServersTable>): RemoteServer => ({
  id: row.id,
  name: row.name,
  url: row.url,
  api_key: row.api_key ?? undefined,
  connection_mode: (row.connection_mode as RemoteServerConnectionMode) ?? "outbound",
  connect_token: row.connect_token ?? undefined,
  connect_token_created_at: row.connect_token_created_at ?? undefined,
  status: (row.status as RemoteServerStatus) ?? "unknown",
  last_connected_at: row.last_connected_at ?? undefined,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const mapProjectRemote = (row: Selectable<ProjectRemotesTable>): ProjectRemote => ({
  id: row.id,
  project_id: row.project_id,
  remote_server_id: row.remote_server_id,
  remote_path: row.remote_path,
  sort_order: row.sort_order,
  sync_up_config: row.sync_up_config ? (JSON.parse(row.sync_up_config) as SyncButtonConfig) : undefined,
  sync_down_config: row.sync_down_config ? (JSON.parse(row.sync_down_config) as SyncButtonConfig) : undefined,
});

type ProjectRemoteJoinedRow = Selectable<ProjectRemotesTable> & {
  server_name: string;
  server_url: string | null;
  server_api_key: string | null;
};

const mapProjectRemoteWithServer = (row: ProjectRemoteJoinedRow): ProjectRemoteWithServer => ({
  ...mapProjectRemote(row),
  server_name: row.server_name,
  server_url: row.server_url,
  server_api_key: row.server_api_key ?? undefined,
});

export const createRemoteServerRepos = (
  kdb: Kysely<DB>,
  _h: DialectHelpers,
): Pick<Storage, "remoteServers" | "projectRemotes" | "machineIdentity"> => ({
  remoteServers: {
    create: async (server, userId) => {
      const id = crypto.randomUUID();
      const connectionMode = server.connection_mode ?? "outbound";
      await kdb.insertInto("remote_servers").values({
        id,
        name: server.name,
        url: server.url,
        api_key: server.api_key ?? null,
        connection_mode: connectionMode,
        connect_token: null,
        connect_token_created_at: null,
        last_connected_at: null,
        user_id: userId ?? "",
      }).execute();

      const row = await kdb.selectFrom("remote_servers").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapRemoteServer(row);
    },

    getAll: async (userId) => {
      let query = kdb.selectFrom("remote_servers").selectAll();
      if (userId) query = query.where("user_id", "=", userId);
      const rows = await query.orderBy("created_at", "desc").execute();
      return rows.map(mapRemoteServer);
    },

    getById: async (id, userId) => {
      let query = kdb.selectFrom("remote_servers").selectAll().where("id", "=", id);
      if (userId) query = query.where("user_id", "=", userId);
      const row = await query.executeTakeFirst();
      return row ? mapRemoteServer(row) : undefined;
    },

    getByUrl: async (url) => {
      const row = await kdb.selectFrom("remote_servers").selectAll().where("url", "=", url).executeTakeFirst();
      return row ? mapRemoteServer(row) : undefined;
    },

    getByToken: async (token) => {
      const row = await kdb.selectFrom("remote_servers").selectAll().where("connect_token", "=", token).executeTakeFirst();
      return row ? mapRemoteServer(row) : undefined;
    },

    getOwnerId: async (id) => {
      const row = await kdb.selectFrom("remote_servers").select("user_id").where("id", "=", id).executeTakeFirst();
      return row?.user_id;
    },

    update: async (id, opts, userId) => {
      const sets: Record<string, unknown> = {};
      if (opts.name !== undefined) sets.name = opts.name;
      if (opts.url !== undefined) sets.url = opts.url;
      if (opts.api_key !== undefined) sets.api_key = opts.api_key;
      if (opts.connection_mode !== undefined) sets.connection_mode = opts.connection_mode;

      if (Object.keys(sets).length > 0) {
        sets.updated_at = sql`datetime('now')`;
        let query = kdb.updateTable("remote_servers").set(sets).where("id", "=", id);
        if (userId) query = query.where("user_id", "=", userId);
        await query.execute();
      }

      let readQuery = kdb.selectFrom("remote_servers").selectAll().where("id", "=", id);
      if (userId) readQuery = readQuery.where("user_id", "=", userId);
      const row = await readQuery.executeTakeFirst();
      return row ? mapRemoteServer(row) : undefined;
    },

    updateStatus: async (id, status) => {
      const sets: Record<string, unknown> = { status, updated_at: sql`datetime('now')` };
      if (status === "online") sets.last_connected_at = sql`datetime('now')`;
      await kdb.updateTable("remote_servers").set(sets).where("id", "=", id).execute();
    },

    generateToken: async (id, userId) => {
      let existingQuery = kdb.selectFrom("remote_servers").selectAll().where("id", "=", id);
      if (userId) existingQuery = existingQuery.where("user_id", "=", userId);
      const existing = await existingQuery.executeTakeFirst();
      if (!existing) return undefined;

      const token = crypto.randomBytes(32).toString("hex");
      let updateQuery = kdb.updateTable("remote_servers").set({
        connect_token: token,
        connect_token_created_at: sql`datetime('now')`,
        updated_at: sql`datetime('now')`,
      }).where("id", "=", id);
      if (userId) updateQuery = updateQuery.where("user_id", "=", userId);
      await updateQuery.execute();
      return token;
    },

    revokeToken: async (id, userId) => {
      let query = kdb.updateTable("remote_servers").set({
        connect_token: null,
        connect_token_created_at: null,
        updated_at: sql`datetime('now')`,
      }).where("id", "=", id);
      if (userId) query = query.where("user_id", "=", userId);
      const result = await query.executeTakeFirst();
      return (result?.numUpdatedRows ?? 0n) > 0n;
    },

    delete: async (id, userId) => {
      let query = kdb.deleteFrom("remote_servers").where("id", "=", id);
      if (userId) query = query.where("user_id", "=", userId);
      const result = await query.executeTakeFirst();
      return (result?.numDeletedRows ?? 0n) > 0n;
    },
  },

  projectRemotes: {
    getByProject: async (projectId) => {
      const rows = await kdb.selectFrom("project_remotes")
        .innerJoin("remote_servers", "remote_servers.id", "project_remotes.remote_server_id")
        .select([
          "project_remotes.id",
          "project_remotes.project_id",
          "project_remotes.remote_server_id",
          "project_remotes.remote_path",
          "project_remotes.sort_order",
          "project_remotes.sync_up_config",
          "project_remotes.sync_down_config",
          "remote_servers.name as server_name",
          "remote_servers.url as server_url",
          "remote_servers.api_key as server_api_key",
        ])
        .where("project_remotes.project_id", "=", projectId)
        .orderBy("project_remotes.sort_order", "asc")
        .execute();
      return rows.map(mapProjectRemoteWithServer);
    },

    getByProjectAndServer: async (projectId, remoteServerId) => {
      const row = await kdb.selectFrom("project_remotes")
        .innerJoin("remote_servers", "remote_servers.id", "project_remotes.remote_server_id")
        .select([
          "project_remotes.id",
          "project_remotes.project_id",
          "project_remotes.remote_server_id",
          "project_remotes.remote_path",
          "project_remotes.sort_order",
          "project_remotes.sync_up_config",
          "project_remotes.sync_down_config",
          "remote_servers.name as server_name",
          "remote_servers.url as server_url",
          "remote_servers.api_key as server_api_key",
        ])
        .where("project_remotes.project_id", "=", projectId)
        .where("project_remotes.remote_server_id", "=", remoteServerId)
        .executeTakeFirst();
      return row ? mapProjectRemoteWithServer(row) : undefined;
    },

    add: async (opts) => {
      const id = crypto.randomUUID();
      await kdb.insertInto("project_remotes").values({
        id,
        project_id: opts.project_id,
        remote_server_id: opts.remote_server_id,
        remote_path: opts.remote_path,
        sort_order: opts.sort_order ?? 0,
        sync_up_config: opts.sync_up_config ? JSON.stringify(opts.sync_up_config) : null,
        sync_down_config: opts.sync_down_config ? JSON.stringify(opts.sync_down_config) : null,
      }).execute();

      const row = await kdb.selectFrom("project_remotes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapProjectRemote(row);
    },

    update: async (id, opts) => {
      const sets: Record<string, unknown> = {};
      if (opts.remote_path !== undefined) sets.remote_path = opts.remote_path;
      if (opts.sort_order !== undefined) sets.sort_order = opts.sort_order;
      if (opts.sync_up_config !== undefined) {
        sets.sync_up_config = opts.sync_up_config ? JSON.stringify(opts.sync_up_config) : null;
      }
      if (opts.sync_down_config !== undefined) {
        sets.sync_down_config = opts.sync_down_config ? JSON.stringify(opts.sync_down_config) : null;
      }

      if (Object.keys(sets).length > 0) {
        await kdb.updateTable("project_remotes").set(sets).where("id", "=", id).execute();
      }

      const row = await kdb.selectFrom("project_remotes").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapProjectRemote(row) : undefined;
    },

    remove: async (id) => {
      const result = await kdb.deleteFrom("project_remotes").where("id", "=", id).executeTakeFirst();
      return (result?.numDeletedRows ?? 0n) > 0n;
    },
  },

  machineIdentity: {
    get: async (machineId) => {
      const row = await kdb.selectFrom("machine_identity").selectAll().where("machine_id", "=", machineId).executeTakeFirst();
      return row ?? undefined;
    },

    pin: async (machineId, publicKey, userId) => {
      await kdb.insertInto("machine_identity")
        .values({ machine_id: machineId, public_key: publicKey, user_id: userId ?? "", last_seen_at: null })
        .onConflict((oc) => oc.column("machine_id").doNothing())
        .execute();
    },

    touch: async (machineId) => {
      await kdb.updateTable("machine_identity")
        .set({ last_seen_at: sql`datetime('now')` })
        .where("machine_id", "=", machineId)
        .execute();
    },

    claimOrVerify: async (machineId, publicKey, userId) => {
      const insertResult = await kdb.insertInto("machine_identity")
        .values({ machine_id: machineId, public_key: publicKey, user_id: userId ?? "", last_seen_at: null })
        .onConflict((oc) => oc.column("machine_id").doNothing())
        .executeTakeFirst();
      const row = await kdb.selectFrom("machine_identity").selectAll().where("machine_id", "=", machineId).executeTakeFirstOrThrow();
      const owned = row.user_id === (userId ?? "");
      // Only bump last_seen_at for the verified owner — a rejected
      // owner-mismatch claim must not update the machine's liveness
      // timestamp (the pre-push-down code only called touch() after the
      // ownership guard passed).
      if (owned) {
        await kdb.updateTable("machine_identity")
          .set({ last_seen_at: sql`datetime('now')` })
          .where("machine_id", "=", machineId)
          .execute();
      }
      return { owned, ownerId: row.user_id, created: (insertResult?.numInsertedOrUpdatedRows ?? 0n) > 0n };
    },
  },
});
