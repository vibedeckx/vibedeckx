import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";
import type {
  DB,
  ProjectChatContextRefsTable,
  ProjectChatMessagesTable,
  ProjectChatOperationsTable,
  ProjectChatThreadsTable,
  ProjectChatWorkItemsTable,
} from "../schema.js";
import type {
  ProjectChatContextRef,
  ProjectChatMessage,
  ProjectChatOperation,
  ProjectChatThread,
  ProjectChatWorkItem,
  Storage,
} from "../types.js";

const now = () => sql<string>`strftime('%Y-%m-%d %H:%M:%f', 'now')`;

const mapThread = (row: Selectable<ProjectChatThreadsTable>): ProjectChatThread => row;

const mapMessage = (row: Selectable<ProjectChatMessagesTable>): ProjectChatMessage => row;

const mapWorkItem = (row: Selectable<ProjectChatWorkItemsTable>): ProjectChatWorkItem => row;

const mapContextRef = (row: Selectable<ProjectChatContextRefsTable>): ProjectChatContextRef => row;

const operationStatusSchema = z.enum(["pending", "resolving", "running", "completed", "failed"]);
const operationPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("task_create"), operationId: z.string().min(1).max(512), status: operationStatusSchema, taskId: z.string().min(1).max(512), title: z.string().max(512).optional() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("task_update"), operationId: z.string().min(1).max(512), status: operationStatusSchema, taskId: z.string().min(1).max(512), title: z.string().max(512).optional() }).strict(),
  z.object({
    version: z.literal(1), kind: z.literal("agent_session_create"), operationId: z.string().min(1).max(512),
    status: operationStatusSchema, sessionId: z.string().min(1).max(512), workspaceId: z.string().min(1).max(512).optional(),
    target: z.string().min(1).max(512).optional(), branch: z.string().max(512).nullable().optional(), instruction: z.string().max(8_000).optional(),
    permissionMode: z.enum(["plan", "edit"]).optional(), agentType: z.enum(["claude-code", "codex"]).optional(), model: z.string().max(512).nullable().optional(),
    initialInstructionDelivery: z.enum(["pending", "confirmed"]).optional(),
    phase: z.literal("workspace_selection").optional(), requestId: z.string().min(1).max(512).optional(),
    candidates: z.array(z.object({ id: z.string().min(1).max(512), target: z.string().min(1).max(512), branch: z.string().max(512).nullable() }).strict()).max(20).optional(),
    selectedWorkspaceId: z.string().min(1).max(512).optional(), claimToken: z.string().min(1).max(512).optional(),
  }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("agent_instruction"), operationId: z.string().min(1).max(512), status: operationStatusSchema, sessionId: z.string().min(1).max(512), instruction: z.string().max(8_000).optional(), target: z.union([z.literal("local"), z.object({ remoteServerId: z.string().min(1).max(512), remoteSessionId: z.string().min(1).max(512) }).strict()]).optional(), delivery: z.enum(["pending", "confirmed"]).optional() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("schedule_run"), operationId: z.string().min(1).max(512), status: operationStatusSchema, scheduleId: z.string().min(1).max(512), runId: z.string().min(1).max(512), contextConfirmed: z.boolean().optional(), skipped: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("workspace_selection"), operationId: z.string().min(1).max(512), status: operationStatusSchema, requestId: z.string().min(1).max(512), candidates: z.array(z.object({ id: z.string().min(1).max(512), target: z.string().min(1).max(512), branch: z.string().max(512).nullable() }).strict()).max(20) }).strict(),
]);

const serializeOperationPayload = (
  payload: ProjectChatOperation["payload"],
  expected: { id: string; kind: ProjectChatOperation["kind"]; status: ProjectChatOperation["status"] },
): string => {
  const parsed = operationPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.operationId !== expected.id
    || parsed.data.kind !== expected.kind || parsed.data.status !== expected.status) {
    throw new Error("Invalid Project Chat operation payload");
  }
  const serialized = JSON.stringify(parsed.data);
  if (Buffer.byteLength(serialized, "utf8") > 32_768) throw new Error("Project Chat operation payload is too large");
  return serialized;
};

const mapOperation = (row: Selectable<ProjectChatOperationsTable>): ProjectChatOperation => {
  let decoded: unknown;
  try { decoded = JSON.parse(row.payload); } catch { throw new Error("Project Chat operation data is malformed"); }
  const parsed = operationPayloadSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.kind !== row.kind || parsed.data.version !== row.payload_version
    || parsed.data.operationId !== row.id || parsed.data.status !== row.status) {
    throw new Error("Project Chat operation data does not match its kind/version");
  }
  return { ...row, payload: parsed.data as ProjectChatOperation["payload"] };
};

export const createProjectChatRepos = (
  kdb: Kysely<DB>,
): Pick<Storage, "projectChatThreads" | "projectChatMessages" | "projectChatWorkItems" | "projectChatContextRefs" | "projectChatOperations"> => ({
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
        .innerJoin("project_chat_messages as user_message", "user_message.id", "work.user_message_id")
        .selectAll("work")
        .where("work.thread_id", "=", threadId)
        .where("thread.project_id", "=", projectId)
        .where("thread.user_id", "=", userId)
        .where("work.status", "in", ["accepted", "running"])
        .orderBy("user_message.sequence", "asc")
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
          .set({ status: "running", attempt: sql`attempt + 1`, updated_at: now() })
          .where("id", "=", id)
          .where("thread_id", "=", threadId)
          .where("status", "in", ["accepted", "running"])
          .returningAll()
          .executeTakeFirst();
        return row ? mapWorkItem(row) : undefined;
      });
    },

    markAccepted: async (id, threadId, projectId, userId, attempt) => {
      return kdb.transaction().execute(async (trx) => {
        const owned = await trx.selectFrom("project_chat_work_items as work")
          .innerJoin("project_chat_threads as thread", "thread.id", "work.thread_id")
          .select("work.id")
          .where("work.id", "=", id)
          .where("work.thread_id", "=", threadId)
          .where("thread.project_id", "=", projectId)
          .where("thread.user_id", "=", userId)
          .where("work.status", "=", "running")
          .where("work.attempt", "=", attempt)
          .executeTakeFirst();
        if (!owned) return undefined;
        const row = await trx.updateTable("project_chat_work_items")
          .set({ status: "accepted", updated_at: now() })
          .where("id", "=", id)
          .where("thread_id", "=", threadId)
          .where("status", "=", "running")
          .where("attempt", "=", attempt)
          .returningAll()
          .executeTakeFirst();
        return row ? mapWorkItem(row) : undefined;
      });
    },

    appendEvent: async ({
      id, thread_id, project_id, user_id, attempt, is_current, message_id, type, content,
    }) => {
      if (is_current && !is_current()) return undefined;
      return kdb.transaction().execute(async (trx) => {
        if (is_current && !is_current()) return undefined;
        const running = await trx.selectFrom("project_chat_work_items as work")
          .innerJoin("project_chat_threads as thread", "thread.id", "work.thread_id")
          .select("work.id")
          .where("work.id", "=", id)
          .where("work.thread_id", "=", thread_id)
          .where("work.status", "=", "running")
          .where("work.attempt", "=", attempt)
          .where("thread.project_id", "=", project_id)
          .where("thread.user_id", "=", user_id)
          .executeTakeFirst();
        if (!running) return undefined;
        if (is_current && !is_current()) return undefined;
        const sequenceRow = await trx.selectFrom("project_chat_messages")
          .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
          .where("thread_id", "=", thread_id)
          .executeTakeFirstOrThrow();
        if (is_current && !is_current()) return undefined;
        await trx.insertInto("project_chat_messages")
          .values({
            id: message_id,
            thread_id,
            sequence: Number(sequenceRow.sequence) + 1,
            type,
            content,
          })
          .execute();
        const touched = await trx.updateTable("project_chat_threads")
          .set({ updated_at: now() })
          .where("id", "=", thread_id)
          .where("project_id", "=", project_id)
          .where("user_id", "=", user_id)
          .executeTakeFirst();
        if (touched.numUpdatedRows !== 1n) throw new Error("Project Chat thread not found");
        const message = await trx.selectFrom("project_chat_messages")
          .selectAll().where("id", "=", message_id).executeTakeFirstOrThrow();
        return mapMessage(message);
      });
    },

    finish: async ({
      id, thread_id, project_id, user_id, attempt, is_current,
      status, error, turn_end_id, turn_end_content,
    }) => {
      if (is_current && !is_current()) {
        throw new Error("Project Chat work item not found or already terminal");
      }
      return kdb.transaction().execute(async (trx) => {
        if (is_current && !is_current()) {
          throw new Error("Project Chat work item not found or already terminal");
        }
        const work = await trx.selectFrom("project_chat_work_items as work")
          .innerJoin("project_chat_threads as thread", "thread.id", "work.thread_id")
          .selectAll("work")
          .where("work.id", "=", id)
          .where("work.thread_id", "=", thread_id)
          .where("thread.project_id", "=", project_id)
          .where("thread.user_id", "=", user_id)
          .executeTakeFirst();
        if (!work) throw new Error("Project Chat work item not found or already terminal");
        if (!["accepted", "running"].includes(work.status) && work.attempt === attempt) {
          const existingTurnEnd = await trx.selectFrom("project_chat_messages")
            .selectAll()
            .where("id", "=", turn_end_id)
            .where("thread_id", "=", thread_id)
            .where("type", "=", "turn_end")
            .executeTakeFirst();
          if (existingTurnEnd) {
            return { workItem: mapWorkItem(work), turnEnd: mapMessage(existingTurnEnd) };
          }
        }
        if (work.status !== "running" || work.attempt !== attempt) {
          throw new Error("Project Chat work item not found or already terminal");
        }
        if (is_current && !is_current()) {
          throw new Error("Project Chat work item not found or already terminal");
        }
        const sequenceRow = await trx.selectFrom("project_chat_messages")
          .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
          .where("thread_id", "=", thread_id)
          .executeTakeFirstOrThrow();
        if (is_current && !is_current()) {
          throw new Error("Project Chat work item not found or already terminal");
        }
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
        if (is_current && !is_current()) {
          throw new Error("Project Chat work item not found or already terminal");
        }
        const terminalWork = await trx.updateTable("project_chat_work_items")
          .set({ status, error, updated_at: now() })
          .where("id", "=", id)
          .where("thread_id", "=", thread_id)
          .where("status", "=", "running")
          .where("attempt", "=", attempt)
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

    touchMany: async (threadId, projectId, userId, refs) => {
      return kdb.transaction().execute(async (trx) => {
        const thread = await trx.selectFrom("project_chat_threads")
          .select("id")
          .where("id", "=", threadId)
          .where("project_id", "=", projectId)
          .where("user_id", "=", userId)
          .executeTakeFirst();
        if (!thread) return undefined;
        if (refs.length === 0) return [];

        const rows = await trx.insertInto("project_chat_context_refs")
          .values(refs.map((ref) => ({
            thread_id: threadId,
            entity_type: ref.entityType,
            entity_id: ref.entityId,
          })))
          .onConflict((conflict) => conflict
            .columns(["thread_id", "entity_type", "entity_id"])
            .doUpdateSet({ last_referenced_at: now() }))
          .returningAll()
          .execute();
        return rows.map(mapContextRef);
      });
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

  projectChatOperations: {
    create: async (opts) => {
      const result = await kdb.insertInto("project_chat_operations")
        .columns([
          "id", "thread_id", "project_id", "user_id", "kind", "payload_version",
          "status", "entity_type", "entity_id", "idempotency_key", "payload", "error",
        ])
        .expression((eb) => eb.selectFrom("project_chat_threads")
          .select([
            sql<string>`${opts.id}`.as("id"),
            sql<string>`${opts.thread_id}`.as("thread_id"),
            sql<string>`${opts.project_id}`.as("project_id"),
            sql<string>`${opts.user_id}`.as("user_id"),
            sql<typeof opts.kind>`${opts.kind}`.as("kind"),
            sql<1>`${opts.payload_version ?? 1}`.as("payload_version"),
            sql<typeof opts.status>`${opts.status}`.as("status"),
            sql<typeof opts.entity_type>`${opts.entity_type}`.as("entity_type"),
            sql<string | null>`${opts.entity_id}`.as("entity_id"),
            sql<string>`${opts.idempotency_key}`.as("idempotency_key"),
            sql<string>`${serializeOperationPayload(opts.payload, { id: opts.id, kind: opts.kind, status: opts.status })}`.as("payload"),
            sql<string | null>`${opts.error}`.as("error"),
          ])
          .where("id", "=", opts.thread_id)
          .where("project_id", "=", opts.project_id)
          .where("user_id", "=", opts.user_id))
        .onConflict((conflict) => conflict.columns(["thread_id", "idempotency_key"]).doNothing())
        .executeTakeFirst();
      if (result.numInsertedOrUpdatedRows === 0n) {
        const existing = await kdb.selectFrom("project_chat_operations as operation")
          .innerJoin("project_chat_threads as thread", "thread.id", "operation.thread_id")
          .selectAll("operation")
          .where("operation.thread_id", "=", opts.thread_id)
          .where("operation.idempotency_key", "=", opts.idempotency_key)
          .where("operation.project_id", "=", opts.project_id)
          .where("operation.user_id", "=", opts.user_id)
          .whereRef("thread.project_id", "=", "operation.project_id")
          .whereRef("thread.user_id", "=", "operation.user_id")
          .executeTakeFirst();
        return existing ? mapOperation(existing) : undefined;
      }
      const row = await kdb.selectFrom("project_chat_operations")
        .selectAll().where("id", "=", opts.id).executeTakeFirstOrThrow();
      return mapOperation(row);
    },

    getById: async (id, threadId, projectId, userId) => {
      const row = await kdb.selectFrom("project_chat_operations as operation")
        .innerJoin("project_chat_threads as thread", "thread.id", "operation.thread_id")
        .selectAll("operation")
        .where("operation.id", "=", id)
        .where("operation.thread_id", "=", threadId)
        .where("operation.project_id", "=", projectId)
        .where("operation.user_id", "=", userId)
        .whereRef("thread.project_id", "=", "operation.project_id")
        .whereRef("thread.user_id", "=", "operation.user_id")
        .executeTakeFirst();
      return row ? mapOperation(row) : undefined;
    },

    listByCorrelation: async (projectId, entityType, entityId, limit) => {
      const rows = await kdb.selectFrom("project_chat_operations as operation")
        .innerJoin("project_chat_threads as thread", "thread.id", "operation.thread_id")
        .selectAll("operation")
        .where("operation.project_id", "=", projectId)
        .whereRef("thread.project_id", "=", "operation.project_id")
        .whereRef("thread.user_id", "=", "operation.user_id")
        .where("operation.entity_type", "=", entityType)
        .where("operation.entity_id", "=", entityId)
        .orderBy("operation.created_at", "asc")
        .orderBy("operation.id", "asc")
        .limit(Math.max(0, Math.min(limit, 100)))
        .execute();
      return rows.map(mapOperation);
    },

    listNonterminal: async (afterId, limit) => {
      let query = kdb.selectFrom("project_chat_operations as operation")
        .innerJoin("project_chat_threads as thread", "thread.id", "operation.thread_id")
        .selectAll("operation")
        .whereRef("thread.project_id", "=", "operation.project_id")
        .whereRef("thread.user_id", "=", "operation.user_id")
        .where("operation.status", "in", ["pending", "resolving", "running"]);
      if (afterId !== null) query = query.where("operation.id", ">", afterId);
      const rows = await query.orderBy("operation.id", "asc")
        .limit(Math.max(1, Math.min(limit, 100))).execute();
      return rows.map(mapOperation);
    },

    announce: async (opts) => kdb.transaction().execute(async (trx) => {
      const operation = await trx.selectFrom("project_chat_operations as operation")
        .innerJoin("project_chat_threads as thread", "thread.id", "operation.thread_id")
        .select("operation.id")
        .where("operation.id", "=", opts.id)
        .where("operation.thread_id", "=", opts.thread_id)
        .where("operation.project_id", "=", opts.project_id)
        .where("operation.user_id", "=", opts.user_id)
        .whereRef("thread.project_id", "=", "operation.project_id")
        .whereRef("thread.user_id", "=", "operation.user_id")
        .executeTakeFirst();
      if (!operation) return undefined;
      const existing = await trx.selectFrom("project_chat_messages")
        .selectAll().where("id", "=", opts.message.id)
        .where("thread_id", "=", opts.thread_id).executeTakeFirst();
      if (existing) return mapMessage(existing);
      const sequenceRow = await trx.selectFrom("project_chat_messages")
        .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
        .where("thread_id", "=", opts.thread_id).executeTakeFirstOrThrow();
      await trx.insertInto("project_chat_messages").values({
        id: opts.message.id,
        thread_id: opts.thread_id,
        sequence: Number(sequenceRow.sequence) + 1,
        type: "operation",
        content: opts.message.content,
      }).execute();
      await trx.updateTable("project_chat_threads").set({ updated_at: now() })
        .where("id", "=", opts.thread_id).execute();
      const message = await trx.selectFrom("project_chat_messages")
        .selectAll().where("id", "=", opts.message.id).executeTakeFirstOrThrow();
      return mapMessage(message);
    }),

    claimWorkspaceSelection: async (opts) => {
      if (opts.payload.claimToken !== opts.claim_token
        || opts.payload.selectedWorkspaceId !== opts.workspace_id
        || opts.payload.workspaceId !== opts.workspace_id
        || opts.payload.sessionId !== opts.session_id) {
        throw new Error("Invalid Project Chat workspace-selection claim");
      }
      const updated = await kdb.updateTable("project_chat_operations")
        .set({
          status: "resolving",
          entity_type: "agent_session",
          entity_id: opts.session_id,
          payload: serializeOperationPayload(opts.payload, {
            id: opts.id, kind: "agent_session_create", status: "resolving",
          }),
          updated_at: now(),
        })
        .where("id", "=", opts.id)
        .where("thread_id", "=", opts.thread_id)
        .where("project_id", "=", opts.project_id)
        .where("user_id", "=", opts.user_id)
        .where("kind", "=", "agent_session_create")
        .where("status", "=", "pending")
        .where("entity_type", "is", null)
        .where("entity_id", "is", null)
        .returningAll()
        .executeTakeFirst();
      if (updated) return { operation: mapOperation(updated), claimed: true };
      const existing = await kdb.selectFrom("project_chat_operations")
        .selectAll()
        .where("id", "=", opts.id)
        .where("thread_id", "=", opts.thread_id)
        .where("project_id", "=", opts.project_id)
        .where("user_id", "=", opts.user_id)
        .executeTakeFirst();
      return existing ? { operation: mapOperation(existing), claimed: false } : undefined;
    },

    bindCorrelation: async (opts) => {
      const owned = await kdb.selectFrom("project_chat_operations as operation")
        .innerJoin("project_chat_threads as thread", "thread.id", "operation.thread_id")
        .select(["operation.entity_type", "operation.entity_id"])
        .where("operation.id", "=", opts.id)
        .where("operation.thread_id", "=", opts.thread_id)
        .where("operation.project_id", "=", opts.project_id)
        .where("operation.user_id", "=", opts.user_id)
        .whereRef("thread.project_id", "=", "operation.project_id")
        .whereRef("thread.user_id", "=", "operation.user_id")
        .where("operation.status", "=", "pending")
        .executeTakeFirst();
      if (!owned) return undefined;
      if (owned.entity_type !== null
        && (owned.entity_type !== opts.entity_type || owned.entity_id !== opts.entity_id)) return undefined;
      const row = await kdb.updateTable("project_chat_operations")
        .set({ entity_type: opts.entity_type, entity_id: opts.entity_id, updated_at: now() })
        .where("id", "=", opts.id)
        .where("thread_id", "=", opts.thread_id)
        .where("status", "=", "pending")
        .returningAll().executeTakeFirst();
      return row ? mapOperation(row) : undefined;
    },

    transition: async (opts) => kdb.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("project_chat_operations as operation")
        .innerJoin("project_chat_threads as thread", "thread.id", "operation.thread_id")
        .selectAll("operation")
        .where("operation.id", "=", opts.id)
        .where("operation.thread_id", "=", opts.thread_id)
        .where("operation.project_id", "=", opts.project_id)
        .where("operation.user_id", "=", opts.user_id)
        .whereRef("thread.project_id", "=", "operation.project_id")
        .whereRef("thread.user_id", "=", "operation.user_id")
        .executeTakeFirst();
      if (!row) return undefined;
      const terminal = row.status === "completed" || row.status === "failed";
      if (terminal && row.status !== opts.status) return undefined;
      if (row.status === opts.status) {
        const existingMessage = await trx.selectFrom("project_chat_messages")
          .selectAll().where("id", "=", opts.message.id)
          .where("thread_id", "=", opts.thread_id).executeTakeFirst();
        if (!existingMessage) return undefined;
        return { operation: mapOperation(row), message: mapMessage(existingMessage), changed: false };
      }

      const allowed = (row.status === "pending" && ["running", "completed", "failed"].includes(opts.status))
        || (row.status === "resolving" && ["running", "completed", "failed"].includes(opts.status))
        || (row.status === "running" && ["completed", "failed"].includes(opts.status));
      if (!allowed) return undefined;
      const sequenceRow = await trx.selectFrom("project_chat_messages")
        .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
        .where("thread_id", "=", opts.thread_id).executeTakeFirstOrThrow();
      await trx.insertInto("project_chat_messages").values({
        id: opts.message.id,
        thread_id: opts.thread_id,
        sequence: Number(sequenceRow.sequence) + 1,
        type: "operation",
        content: opts.message.content,
      }).execute();
      const updated = await trx.updateTable("project_chat_operations")
        .set({ status: opts.status, payload: serializeOperationPayload(opts.payload, {
          id: opts.id, kind: row.kind, status: opts.status,
        }), error: opts.error, updated_at: now() })
        .where("id", "=", opts.id)
        .where("thread_id", "=", opts.thread_id)
        .where("status", "=", row.status)
        .returningAll().executeTakeFirst();
      if (!updated) throw new Error("Project Chat operation changed concurrently");
      await trx.updateTable("project_chat_threads")
        .set({ updated_at: now() }).where("id", "=", opts.thread_id).execute();
      const message = await trx.selectFrom("project_chat_messages")
        .selectAll().where("id", "=", opts.message.id).executeTakeFirstOrThrow();
      return { operation: mapOperation(updated), message: mapMessage(message), changed: true };
    }),
  },
});
