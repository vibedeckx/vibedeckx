import { sql, type Kysely, type Selectable } from "kysely";
import type {
  DB,
  ProjectChatContextRefsTable,
  ProjectChatMessagesTable,
  ProjectChatThreadsTable,
  ProjectChatWorkItemsTable,
} from "../schema.js";
import type {
  ProjectChatContextRef,
  ProjectChatMessage,
  ProjectChatThread,
  ProjectChatWorkItem,
  Storage,
} from "../types.js";

const now = () => sql<string>`strftime('%Y-%m-%d %H:%M:%f', 'now')`;

const mapThread = (row: Selectable<ProjectChatThreadsTable>): ProjectChatThread => row;

const mapMessage = (row: Selectable<ProjectChatMessagesTable>): ProjectChatMessage => row;

const mapWorkItem = (row: Selectable<ProjectChatWorkItemsTable>): ProjectChatWorkItem => row;

const mapContextRef = (row: Selectable<ProjectChatContextRefsTable>): ProjectChatContextRef => row;

export const createProjectChatRepos = (
  kdb: Kysely<DB>,
): Pick<Storage, "projectChatThreads" | "projectChatMessages" | "projectChatWorkItems" | "projectChatContextRefs"> => ({
  projectChatThreads: {
    create: async ({ id, project_id, user_id, title }) => {
      await kdb.insertInto("project_chat_threads")
        .values({ id, project_id, user_id, title, archived_at: null })
        .execute();
      const row = await kdb.selectFrom("project_chat_threads").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return mapThread(row);
    },

    createWithInitialMessage: async ({ id, project_id, user_id, title, initialMessage }) => {
      return kdb.transaction().execute(async (trx) => {
        await trx.insertInto("project_chat_threads")
          .values({ id, project_id, user_id, title, archived_at: null })
          .execute();
        if (initialMessage) {
          await trx.insertInto("project_chat_messages")
            .values({
              id: initialMessage.id,
              thread_id: id,
              sequence: 1,
              type: "user",
              content: initialMessage.content,
            })
            .execute();
        }
        const row = await trx.selectFrom("project_chat_threads")
          .selectAll()
          .where("id", "=", id)
          .where("project_id", "=", project_id)
          .where("user_id", "=", user_id)
          .executeTakeFirstOrThrow();
        return mapThread(row);
      });
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

    getOwnedById: async (id, userId) => {
      if (!userId) return undefined;
      const row = await kdb.selectFrom("project_chat_threads")
        .selectAll()
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row ? mapThread(row) : undefined;
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

    update: async (id, projectId, userId, patch) => {
      const row = await kdb.updateTable("project_chat_threads")
        .set({
          updated_at: now(),
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.archived !== undefined
            ? { archived_at: patch.archived ? Date.now() : null }
            : {}),
        })
        .where("id", "=", id)
        .where("project_id", "=", projectId)
        .where("user_id", "=", userId)
        .returningAll()
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

  projectChatWorkItems: {
    accept: async ({ id, user_message_id, thread_id, project_id, user_id, content }) => {
      return kdb.transaction().execute(async (trx) => {
        const thread = await trx.selectFrom("project_chat_threads")
          .select("id")
          .where("id", "=", thread_id)
          .where("project_id", "=", project_id)
          .where("user_id", "=", user_id)
          .executeTakeFirst();
        if (!thread) throw new Error("Project Chat thread not found");

        const sequenceRow = await trx.selectFrom("project_chat_messages")
          .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
          .where("thread_id", "=", thread_id)
          .executeTakeFirstOrThrow();
        const sequence = Number(sequenceRow.sequence) + 1;
        await trx.insertInto("project_chat_messages")
          .values({ id: user_message_id, thread_id, sequence, type: "user", content })
          .execute();
        await trx.insertInto("project_chat_work_items")
          .values({
            id,
            thread_id,
            user_message_id,
            content,
            status: "accepted",
            error: null,
          })
          .execute();
        const touched = await trx.updateTable("project_chat_threads")
          .set({ updated_at: now() })
          .where("id", "=", thread_id)
          .where("project_id", "=", project_id)
          .where("user_id", "=", user_id)
          .executeTakeFirst();
        if (touched.numUpdatedRows !== 1n) throw new Error("Project Chat thread not found");

        const [message, work] = await Promise.all([
          trx.selectFrom("project_chat_messages").selectAll()
            .where("id", "=", user_message_id).executeTakeFirstOrThrow(),
          trx.selectFrom("project_chat_work_items").selectAll()
            .where("id", "=", id).executeTakeFirstOrThrow(),
        ]);
        return { userMessage: mapMessage(message), workItem: mapWorkItem(work) };
      });
    },

    listNonterminal: async (threadId, projectId, userId) => {
      const rows = await kdb.selectFrom("project_chat_work_items as work")
        .innerJoin("project_chat_threads as thread", "thread.id", "work.thread_id")
        .selectAll("work")
        .where("work.thread_id", "=", threadId)
        .where("thread.project_id", "=", projectId)
        .where("thread.user_id", "=", userId)
        .where("work.status", "in", ["accepted", "running"])
        .orderBy("work.created_at", "asc")
        .orderBy("work.id", "asc")
        .execute();
      return rows.map(mapWorkItem);
    },

    markRunning: async (id, threadId, projectId, userId) => {
      return kdb.transaction().execute(async (trx) => {
        const owned = await trx.selectFrom("project_chat_work_items as work")
          .innerJoin("project_chat_threads as thread", "thread.id", "work.thread_id")
          .select("work.id")
          .where("work.id", "=", id)
          .where("work.thread_id", "=", threadId)
          .where("thread.project_id", "=", projectId)
          .where("thread.user_id", "=", userId)
          .where("work.status", "in", ["accepted", "running"])
          .executeTakeFirst();
        if (!owned) return undefined;
        const row = await trx.updateTable("project_chat_work_items")
          .set({ status: "running", updated_at: now() })
          .where("id", "=", id)
          .where("thread_id", "=", threadId)
          .returningAll()
          .executeTakeFirst();
        return row ? mapWorkItem(row) : undefined;
      });
    },

    finish: async ({
      id, thread_id, project_id, user_id, status, error, turn_end_id, turn_end_content,
    }) => {
      return kdb.transaction().execute(async (trx) => {
        const work = await trx.selectFrom("project_chat_work_items as work")
          .innerJoin("project_chat_threads as thread", "thread.id", "work.thread_id")
          .selectAll("work")
          .where("work.id", "=", id)
          .where("work.thread_id", "=", thread_id)
          .where("thread.project_id", "=", project_id)
          .where("thread.user_id", "=", user_id)
          .where("work.status", "in", ["accepted", "running"])
          .executeTakeFirst();
        if (!work) throw new Error("Project Chat work item not found or already terminal");
        const sequenceRow = await trx.selectFrom("project_chat_messages")
          .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
          .where("thread_id", "=", thread_id)
          .executeTakeFirstOrThrow();
        const sequence = Number(sequenceRow.sequence) + 1;
        await trx.insertInto("project_chat_messages")
          .values({
            id: turn_end_id,
            thread_id,
            sequence,
            type: "turn_end",
            content: turn_end_content,
          })
          .execute();
        const terminalWork = await trx.updateTable("project_chat_work_items")
          .set({ status, error, updated_at: now() })
          .where("id", "=", id)
          .where("thread_id", "=", thread_id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const touched = await trx.updateTable("project_chat_threads")
          .set({ updated_at: now() })
          .where("id", "=", thread_id)
          .where("project_id", "=", project_id)
          .where("user_id", "=", user_id)
          .executeTakeFirst();
        if (touched.numUpdatedRows !== 1n) throw new Error("Project Chat thread not found");
        const turnEnd = await trx.selectFrom("project_chat_messages")
          .selectAll().where("id", "=", turn_end_id).executeTakeFirstOrThrow();
        return { workItem: mapWorkItem(terminalWork), turnEnd: mapMessage(turnEnd) };
      });
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
