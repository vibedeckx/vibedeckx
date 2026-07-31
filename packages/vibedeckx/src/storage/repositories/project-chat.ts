import { sql, type Kysely, type Selectable } from "kysely";
import type {
  DB,
  ProjectChatContextRefsTable,
  ProjectChatMessagesTable,
  ProjectChatThreadsTable,
} from "../schema.js";
import type {
  ProjectChatContextEntityType,
  ProjectChatContextRef,
  ProjectChatMessage,
  ProjectChatMessageType,
  ProjectChatThread,
  Storage,
} from "../types.js";

const now = () => sql<string>`strftime('%Y-%m-%d %H:%M:%f', 'now')`;

const mapThread = (row: Selectable<ProjectChatThreadsTable>): ProjectChatThread => row;

const mapMessage = (row: Selectable<ProjectChatMessagesTable>): ProjectChatMessage => ({
  ...row,
  type: row.type as ProjectChatMessageType,
});

const mapContextRef = (row: Selectable<ProjectChatContextRefsTable>): ProjectChatContextRef => ({
  ...row,
  entity_type: row.entity_type as ProjectChatContextEntityType,
});

export const createProjectChatRepos = (
  kdb: Kysely<DB>,
): Pick<Storage, "projectChatThreads" | "projectChatMessages" | "projectChatContextRefs"> => ({
  projectChatThreads: {
    create: async ({ id, project_id, user_id, title }) => {
      await kdb.insertInto("project_chat_threads")
        .values({ id, project_id, user_id, title, archived_at: null })
        .execute();
      const row = await kdb.selectFrom("project_chat_threads").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapThread(row);
    },

    listByProject: async (projectId, userId, limit, opts) => {
      let query = kdb.selectFrom("project_chat_threads")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("user_id", "=", userId);
      if (!opts?.includeArchived) query = query.where("archived_at", "is", null);
      const rows = await query
        .orderBy("updated_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(mapThread);
    },

    getById: async (id, userId) => {
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll()
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    updateTitle: async (id, userId, title) => {
      await kdb.updateTable("project_chat_threads")
        .set({ title, updated_at: now() })
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .execute();
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll().where("id", "=", id).where("user_id", "=", userId).executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    archive: async (id, userId) => {
      await kdb.updateTable("project_chat_threads")
        .set({ archived_at: Date.now(), updated_at: now() })
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .execute();
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll().where("id", "=", id).where("user_id", "=", userId).executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    unarchive: async (id, userId) => {
      await kdb.updateTable("project_chat_threads")
        .set({ archived_at: null, updated_at: now() })
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .execute();
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll().where("id", "=", id).where("user_id", "=", userId).executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    touchUpdatedAt: async (id, userId) => {
      await kdb.updateTable("project_chat_threads")
        .set({ updated_at: now() })
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .execute();
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll().where("id", "=", id).where("user_id", "=", userId).executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    delete: async (id, userId) => {
      await kdb.deleteFrom("project_chat_threads")
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .execute();
    },
  },

  projectChatMessages: {
    append: async ({ id, thread_id, sequence, type, content }) => {
      await kdb.insertInto("project_chat_messages")
        .values({ id, thread_id, sequence, type, content })
        .execute();
      const row = await kdb.selectFrom("project_chat_messages").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapMessage(row);
    },

    listByThread: async (threadId) => {
      const rows = await kdb.selectFrom("project_chat_messages")
        .selectAll()
        .where("thread_id", "=", threadId)
        .orderBy("sequence", "asc")
        .execute();
      return rows.map(mapMessage);
    },
  },

  projectChatContextRefs: {
    touch: async (threadId, entityType, entityId) => {
      await kdb.insertInto("project_chat_context_refs")
        .values({ thread_id: threadId, entity_type: entityType, entity_id: entityId })
        .onConflict((conflict) => conflict
          .columns(["thread_id", "entity_type", "entity_id"])
          .doUpdateSet({ last_referenced_at: now() }))
        .execute();
      const row = await kdb.selectFrom("project_chat_context_refs")
        .selectAll()
        .where("thread_id", "=", threadId)
        .where("entity_type", "=", entityType)
        .where("entity_id", "=", entityId)
        .executeTakeFirstOrThrow();
      return mapContextRef(row);
    },

    listByThread: async (threadId) => {
      const rows = await kdb.selectFrom("project_chat_context_refs")
        .selectAll()
        .where("thread_id", "=", threadId)
        .orderBy("last_referenced_at", "desc")
        .orderBy("entity_type", "asc")
        .orderBy("entity_id", "asc")
        .execute();
      return rows.map(mapContextRef);
    },
  },
});
