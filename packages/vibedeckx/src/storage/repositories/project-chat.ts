import { sql, type Kysely, type Selectable } from "kysely";
import type {
  DB,
  ProjectChatContextRefsTable,
  ProjectChatMessagesTable,
  ProjectChatThreadsTable,
} from "../schema.js";
import type {
  ProjectChatContextRef,
  ProjectChatMessage,
  ProjectChatThread,
  Storage,
} from "../types.js";

const now = () => sql<string>`strftime('%Y-%m-%d %H:%M:%f', 'now')`;

const mapThread = (row: Selectable<ProjectChatThreadsTable>): ProjectChatThread => row;

const mapMessage = (row: Selectable<ProjectChatMessagesTable>): ProjectChatMessage => row;

const mapContextRef = (row: Selectable<ProjectChatContextRefsTable>): ProjectChatContextRef => row;

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

    getById: async (id, projectId, userId) => {
      if (!userId) return undefined;
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll()
        .where("id", "=", id)
        .where("project_id", "=", projectId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    updateTitle: async (id, projectId, userId, title) => {
      await kdb.updateTable("project_chat_threads")
        .set({ title, updated_at: now() })
        .where("id", "=", id)
        .where("project_id", "=", projectId)
        .where("user_id", "=", userId)
        .execute();
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll().where("id", "=", id).where("project_id", "=", projectId).where("user_id", "=", userId).executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    archive: async (id, projectId, userId) => {
      await kdb.updateTable("project_chat_threads")
        .set({ archived_at: Date.now(), updated_at: now() })
        .where("id", "=", id)
        .where("project_id", "=", projectId)
        .where("user_id", "=", userId)
        .execute();
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll().where("id", "=", id).where("project_id", "=", projectId).where("user_id", "=", userId).executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    unarchive: async (id, projectId, userId) => {
      await kdb.updateTable("project_chat_threads")
        .set({ archived_at: null, updated_at: now() })
        .where("id", "=", id)
        .where("project_id", "=", projectId)
        .where("user_id", "=", userId)
        .execute();
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll().where("id", "=", id).where("project_id", "=", projectId).where("user_id", "=", userId).executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    touchUpdatedAt: async (id, projectId, userId) => {
      await kdb.updateTable("project_chat_threads")
        .set({ updated_at: now() })
        .where("id", "=", id)
        .where("project_id", "=", projectId)
        .where("user_id", "=", userId)
        .execute();
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll().where("id", "=", id).where("project_id", "=", projectId).where("user_id", "=", userId).executeTakeFirst();
      return row ? mapThread(row) : undefined;
    },

    delete: async (id, projectId, userId) => {
      await kdb.deleteFrom("project_chat_threads")
        .where("id", "=", id)
        .where("project_id", "=", projectId)
        .where("user_id", "=", userId)
        .execute();
    },
  },

  projectChatMessages: {
    append: async ({ id, thread_id, project_id, user_id, sequence, type, content }) => {
      const result = await kdb.insertInto("project_chat_messages")
        .columns(["id", "thread_id", "sequence", "type", "content"])
        .expression((eb) => eb.selectFrom("project_chat_threads")
          .select([
            sql<string>`${id}`.as("id"),
            sql<string>`${thread_id}`.as("thread_id"),
            sql<number>`${sequence}`.as("sequence"),
            sql<typeof type>`${type}`.as("type"),
            sql<string>`${content}`.as("content"),
          ])
          .where("id", "=", thread_id)
          .where("project_id", "=", project_id)
          .where("user_id", "=", user_id))
        .executeTakeFirst();
      if (result.numInsertedOrUpdatedRows === 0n) return undefined;
      const row = await kdb.selectFrom("project_chat_messages as message")
        .innerJoin("project_chat_threads as thread", "thread.id", "message.thread_id")
        .selectAll("message")
        .where("message.id", "=", id)
        .where("thread.project_id", "=", project_id)
        .where("thread.user_id", "=", user_id)
        .executeTakeFirstOrThrow();
      return mapMessage(row);
    },

    listByThread: async (threadId, projectId, userId) => {
      const rows = await kdb.selectFrom("project_chat_messages as message")
        .innerJoin("project_chat_threads as thread", "thread.id", "message.thread_id")
        .selectAll("message")
        .where("message.thread_id", "=", threadId)
        .where("thread.project_id", "=", projectId)
        .where("thread.user_id", "=", userId)
        .orderBy("message.sequence", "asc")
        .execute();
      return rows.map(mapMessage);
    },
  },

  projectChatContextRefs: {
    touch: async (threadId, projectId, userId, entityType, entityId) => {
      const result = await kdb.insertInto("project_chat_context_refs")
        .columns(["thread_id", "entity_type", "entity_id"])
        .expression((eb) => eb.selectFrom("project_chat_threads")
          .select([
            sql<string>`${threadId}`.as("thread_id"),
            sql<typeof entityType>`${entityType}`.as("entity_type"),
            sql<string>`${entityId}`.as("entity_id"),
          ])
          .where("id", "=", threadId)
          .where("project_id", "=", projectId)
          .where("user_id", "=", userId))
        .onConflict((conflict) => conflict
          .columns(["thread_id", "entity_type", "entity_id"])
          .doUpdateSet({ last_referenced_at: now() }))
        .executeTakeFirst();
      if (result.numInsertedOrUpdatedRows === 0n) return undefined;
      const row = await kdb.selectFrom("project_chat_context_refs as ref")
        .innerJoin("project_chat_threads as thread", "thread.id", "ref.thread_id")
        .selectAll("ref")
        .where("ref.thread_id", "=", threadId)
        .where("ref.entity_type", "=", entityType)
        .where("ref.entity_id", "=", entityId)
        .where("thread.project_id", "=", projectId)
        .where("thread.user_id", "=", userId)
        .executeTakeFirst();
      return row ? mapContextRef(row) : undefined;
    },

    listByThread: async (threadId, projectId, userId) => {
      const rows = await kdb.selectFrom("project_chat_context_refs as ref")
        .innerJoin("project_chat_threads as thread", "thread.id", "ref.thread_id")
        .selectAll("ref")
        .where("ref.thread_id", "=", threadId)
        .where("thread.project_id", "=", projectId)
        .where("thread.user_id", "=", userId)
        .orderBy("ref.last_referenced_at", "desc")
        .orderBy("ref.entity_type", "asc")
        .orderBy("ref.entity_id", "asc")
        .execute();
      return rows.map(mapContextRef);
    },
  },
});
