import { sql, type Kysely, type Selectable } from "kysely";
import { isDeepStrictEqual } from "node:util";
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
  ProjectChatContextNavigation,
  ProjectChatMessage,
  ProjectChatOperation,
  ProjectChatThread,
  ProjectChatWorkItem,
  Storage,
} from "../types.js";

const now = () => sql<string>`strftime('%Y-%m-%d %H:%M:%f', 'now')`;

const mapThread = (row: Selectable<ProjectChatThreadsTable>): ProjectChatThread => {
  const {
    create_request_id: _requestId,
    create_payload_hash: _payloadHash,
    recovery_work_id: _recoveryWorkId,
    recovery_status: _recoveryStatus,
    recovery_created_at: _recoveryCreatedAt,
    recovery_authorized: _recoveryAuthorized,
    ...thread
  } = row as Selectable<ProjectChatThreadsTable> & Record<string, unknown>;
  return thread;
};

const mapMessage = (row: Selectable<ProjectChatMessagesTable>): ProjectChatMessage => row;

const mapWorkItem = (row: Selectable<ProjectChatWorkItemsTable>): ProjectChatWorkItem => row;

const mapContextRef = (row: Selectable<ProjectChatContextRefsTable>): ProjectChatContextRef => row;

const operationStatusSchema = z.enum(["pending", "resolving", "running", "completed", "failed"]);
const operationPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("task_create"), operationId: z.string().min(1).max(512), status: operationStatusSchema, taskId: z.string().min(1).max(512), title: z.string().max(512).optional(), description: z.string().max(8_000).nullable().optional(), taskStatus: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(), priority: z.enum(["low", "medium", "high", "urgent"]).optional(), assignedBranch: z.string().max(512).nullable().optional() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("task_update"), operationId: z.string().min(1).max(512), status: operationStatusSchema, taskId: z.string().min(1).max(512), title: z.string().max(512).optional(), patch: z.object({ title: z.string().max(512).optional(), description: z.string().max(8_000).nullable().optional(), status: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(), priority: z.enum(["low", "medium", "high", "urgent"]).optional(), assignedBranch: z.string().max(512).nullable().optional() }).strict().optional(), before: z.object({ title: z.string().max(512), description: z.string().max(8_000).nullable(), status: z.enum(["todo", "in_progress", "done", "cancelled"]), priority: z.enum(["low", "medium", "high", "urgent"]), assignedBranch: z.string().max(512).nullable() }).strict().optional() }).strict(),
  z.object({
    version: z.literal(1), kind: z.literal("agent_session_create"), operationId: z.string().min(1).max(512),
    status: operationStatusSchema, sessionId: z.string().min(1).max(512), workerSessionId: z.string().min(1).max(512).optional(),
    workspaceId: z.string().min(1).max(512).optional(),
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

const allowsSameStatusPayloadAdvance = (
  current: ProjectChatOperation["payload"], next: ProjectChatOperation["payload"],
): boolean => {
  if (current.kind !== next.kind) return false;
  if (current.kind === "agent_session_create" && next.kind === "agent_session_create") {
    const { initialInstructionDelivery: currentDelivery, ...currentRest } = current;
    const { initialInstructionDelivery: nextDelivery, ...nextRest } = next;
    return isDeepStrictEqual(currentRest, nextRest)
      && currentDelivery !== "confirmed" && nextDelivery === "confirmed";
  }
  if (current.kind === "schedule_run" && next.kind === "schedule_run") {
    const { contextConfirmed: currentContext, skipped: currentSkipped, ...currentRest } = current;
    const { contextConfirmed: nextContext, skipped: nextSkipped, ...nextRest } = next;
    return isDeepStrictEqual(currentRest, nextRest)
      && currentContext !== true && nextContext === true
      && (currentSkipped === undefined || currentSkipped === nextSkipped);
  }
  return false;
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

const quarantinedPayload = (
  row: Selectable<ProjectChatOperationsTable>,
): ProjectChatOperation["payload"] => {
  const base = { version: 1 as const, operationId: row.id, status: "failed" as const };
  const entityId = row.entity_id ?? row.id;
  switch (row.kind) {
    case "task_create": return { ...base, kind: "task_create", taskId: entityId };
    case "task_update": return { ...base, kind: "task_update", taskId: entityId };
    case "agent_session_create": return { ...base, kind: "agent_session_create", sessionId: entityId };
    case "agent_instruction": return { ...base, kind: "agent_instruction", sessionId: entityId };
    case "schedule_run": return {
      ...base, kind: "schedule_run", scheduleId: row.entity_id ?? row.id, runId: entityId,
    };
    case "workspace_selection": return {
      ...base, kind: "workspace_selection", requestId: row.id, candidates: [],
    };
  }
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

    createWithInitialTurn: async ({ id, project_id, user_id, title, initialTurn }) => {
      return kdb.transaction().execute(async (trx) => {
        await trx.insertInto("project_chat_threads")
          .values({ id, project_id, user_id, title, archived_at: null })
          .execute();
        if (initialTurn) {
          await trx.insertInto("project_chat_messages")
            .values({
              id: initialTurn.messageId,
              thread_id: id,
              sequence: 1,
              type: "user",
              content: initialTurn.content,
            })
            .execute();
          await trx.insertInto("project_chat_work_items")
            .values({
              id: initialTurn.workItemId,
              thread_id: id,
              user_message_id: initialTurn.messageId,
              content: initialTurn.content,
              status: "accepted",
              error: null,
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

    createIdempotent: async ({
      id, project_id, user_id, title, create_request_id, create_payload_hash, initialTurn,
    }) => kdb.transaction().execute(async (trx) => {
      const inserted = await trx.insertInto("project_chat_threads")
        .values({
          id, project_id, user_id, title, archived_at: null,
          create_request_id, create_payload_hash,
        })
        .onConflict((conflict) => conflict
          .columns(["project_id", "user_id", "create_request_id"])
          .where("create_request_id", "is not", null)
          .doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) {
        if (initialTurn) {
          await trx.insertInto("project_chat_messages").values({
            id: initialTurn.messageId, thread_id: id, sequence: 1,
            type: "user", content: initialTurn.content,
          }).execute();
          await trx.insertInto("project_chat_work_items").values({
            id: initialTurn.workItemId, thread_id: id, user_message_id: initialTurn.messageId,
            content: initialTurn.content, status: "accepted", error: null,
          }).execute();
        }
        return { thread: mapThread(inserted), created: true };
      }
      const existing = await trx.selectFrom("project_chat_threads")
        .selectAll()
        .where("project_id", "=", project_id)
        .where("user_id", "=", user_id)
        .where("create_request_id", "=", create_request_id)
        .executeTakeFirst();
      if (!existing) throw new Error("Project Chat thread identity collision");
      if (existing.create_payload_hash !== create_payload_hash) {
        throw Object.assign(new Error("Project Chat create request payload mismatch"), {
          code: "PROJECT_CHAT_CREATE_CONFLICT",
        });
      }
      return { thread: mapThread(existing), created: false };
    }),

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
    listRecoveryPage: async (cursor, limit) => {
      const boundedLimit = Math.max(0, limit);
      let query = kdb.selectFrom("project_chat_work_items as work")
        .innerJoin("project_chat_threads as thread", "thread.id", "work.thread_id")
        .leftJoin("projects as project", "project.id", "thread.project_id")
        .selectAll("thread")
        .select([
          "work.id as recovery_work_id",
          "work.status as recovery_status",
          "work.created_at as recovery_created_at",
          sql<number>`case when project.id is not null and
            (thread.user_id = 'local' or project.user_id = thread.user_id)
            then 1 else 0 end`.as("recovery_authorized"),
        ])
        .where("work.status", "in", ["accepted", "running"]);
      if (cursor) {
        query = query.where((eb) => eb.or([
          eb("work.status", ">", cursor.status),
          eb.and([
            eb("work.status", "=", cursor.status),
            eb("work.created_at", ">", cursor.createdAt),
          ]),
          eb.and([
            eb("work.status", "=", cursor.status),
            eb("work.created_at", "=", cursor.createdAt),
            eb("work.id", ">", cursor.id),
          ]),
        ]));
      }
      const rows = await query
        .orderBy("work.status", "asc")
        .orderBy("work.created_at", "asc")
        .orderBy("work.id", "asc")
        .limit(boundedLimit + 1)
        .execute();
      const hasMore = rows.length > boundedLimit;
      const selected = rows.slice(0, boundedLimit);
      const candidates = selected.map((row) => {
        const recoveryRow = row as typeof row & {
          recovery_work_id: string;
          recovery_status: "accepted" | "running";
          recovery_created_at: string;
          recovery_authorized: number | boolean;
        };
        return {
          thread: mapThread(recoveryRow),
          workItemId: recoveryRow.recovery_work_id,
          cursor: {
            status: recoveryRow.recovery_status,
            createdAt: recoveryRow.recovery_created_at,
            id: recoveryRow.recovery_work_id,
          },
          authorized: Boolean(recoveryRow.recovery_authorized),
        };
      });
      return {
        candidates,
        nextCursor: hasMore ? candidates.at(-1)?.cursor ?? cursor : null,
        hasMore,
      };
    },

    quarantineRecovery: async (id, reason) => {
      const result = await kdb.updateTable("project_chat_work_items")
        .set({ status: "failed", error: reason.slice(0, 512), updated_at: now() })
        .where("id", "=", id)
        .where("status", "in", ["accepted", "running"])
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    },

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

    listByThread: async (threadId, projectId, userId, limit) => {
      let query = kdb.selectFrom("project_chat_context_refs as ref")
        .innerJoin("project_chat_threads as thread", "thread.id", "ref.thread_id")
        .selectAll("ref")
        .where("ref.thread_id", "=", threadId)
        .where("thread.project_id", "=", projectId)
        .where("thread.user_id", "=", userId)
        .orderBy("ref.last_referenced_at", "desc")
        .orderBy("ref.entity_type", "asc")
        .orderBy("ref.entity_id", "asc");
      if (limit !== undefined) query = query.limit(Math.max(0, limit));
      const rows = await query.execute();
      return rows.map(mapContextRef);
    },

    resolveExisting: async (projectId, refs) => {
      const found = new Map<string, {
        entity_type: ProjectChatContextRef["entity_type"];
        entity_id: string;
        navigation: ProjectChatContextNavigation;
      }>();
      const add = (
        entity_type: ProjectChatContextRef["entity_type"],
        entity_id: string,
        navigation: ProjectChatContextNavigation,
      ) => {
        found.set(`${entity_type}\0${entity_id}`, { entity_type, entity_id, navigation });
      };
      const ids = (type: ProjectChatContextRef["entity_type"]) =>
        [...new Set(refs.filter((ref) => ref.entity_type === type).map((ref) => ref.entity_id))];

      const taskIds = ids("task");
      if (taskIds.length) {
        for (const row of await kdb.selectFrom("tasks").select(["id", "title"])
          .where("project_id", "=", projectId).where("id", "in", taskIds).execute()) {
          add("task", row.id, { kind: "task", taskId: row.id, label: row.title });
        }
      }
      const sessionIds = ids("agent_session");
      if (sessionIds.length) {
        for (const row of await kdb.selectFrom("agent_sessions").select(["id", "branch", "title"])
          .where("project_id", "=", projectId).where("id", "in", sessionIds).execute()) {
          const branch = row.branch || null;
          add("agent_session", row.id, {
            kind: "agent_session", sessionId: row.id, target: "local", branch,
            label: row.title?.trim() || branch || "main",
          });
        }
        for (const row of await kdb.selectFrom("remote_session_mappings as mapping")
          .innerJoin("project_remotes as remote", (join) => join
            .onRef("remote.project_id", "=", "mapping.project_id")
            .onRef("remote.remote_server_id", "=", "mapping.remote_server_id"))
          .select(["mapping.local_session_id", "mapping.remote_server_id", "mapping.branch"])
          .where("mapping.project_id", "=", projectId)
          .where("mapping.local_session_id", "in", sessionIds).execute()) {
          add("agent_session", row.local_session_id, {
            kind: "agent_session", sessionId: row.local_session_id,
            target: row.remote_server_id, branch: row.branch,
            label: row.branch || "main",
          });
        }
      }
      const scheduleIds = ids("schedule");
      if (scheduleIds.length) {
        for (const row of await kdb.selectFrom("scheduled_tasks").select(["id", "name"])
          .where("project_id", "=", projectId).where("id", "in", scheduleIds).execute()) {
          add("schedule", row.id, { kind: "schedule", scheduleId: row.id, label: row.name });
        }
      }
      const runIds = ids("schedule_run");
      if (runIds.length) {
        for (const row of await kdb.selectFrom("scheduled_task_runs as run")
          .innerJoin("scheduled_tasks as schedule", "schedule.id", "run.schedule_id")
          .select(["run.id", "run.schedule_id", "schedule.name"])
          .where("schedule.project_id", "=", projectId).where("run.id", "in", runIds).execute()) {
          add("schedule_run", row.id, {
            kind: "schedule_run", scheduleId: row.schedule_id, runId: row.id, label: row.name,
          });
        }
      }

      const workspaceRefs = refs.flatMap((ref) => {
        if (ref.entity_type !== "workspace") return [];
        try {
          const parsed = JSON.parse(ref.entity_id) as unknown;
          if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string"
            || (parsed[1] !== null && typeof parsed[1] !== "string")) return [];
          return [{ entityId: ref.entity_id, target: parsed[0], branch: parsed[1] ?? "" }];
        } catch { return []; }
      });
      if (workspaceRefs.length) {
        const rows = await kdb.selectFrom("workspace_search_cache as workspace")
          .leftJoin("project_remotes as remote", (join) => join
            .onRef("remote.project_id", "=", "workspace.project_id")
            .onRef("remote.remote_server_id", "=", "workspace.target_id"))
          .select(["workspace.target_id", "workspace.branch"])
          .where("workspace.project_id", "=", projectId)
          .where("workspace.deleted_at", "is", null)
          .where((eb) => eb.or(workspaceRefs.map(({ target, branch }) => eb.and([
            eb("workspace.target_id", "=", target), eb("workspace.branch", "=", branch),
          ]))))
          .where((eb) => eb.or([
            eb("workspace.target_id", "=", "local"), eb("remote.id", "is not", null),
          ]))
          .execute();
        const available = new Set(rows
          .map(({ target_id, branch }) => `${target_id}\0${branch}`));
        for (const ref of workspaceRefs) {
          if (available.has(`${ref.target}\0${ref.branch}`)) {
            add("workspace", ref.entityId, {
              kind: "workspace", target: ref.target, branch: ref.branch || null,
              label: ref.branch || "main",
            });
          }
        }
      }
      return [...found.values()];
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
      const boundedLimit = Math.max(1, Math.min(limit, 100));
      let query = kdb.selectFrom("project_chat_operations as operation")
        .innerJoin("project_chat_threads as thread", "thread.id", "operation.thread_id")
        .selectAll("operation")
        .whereRef("thread.project_id", "=", "operation.project_id")
        .whereRef("thread.user_id", "=", "operation.user_id")
        .where("operation.status", "in", ["pending", "resolving", "running"])
        .where((eb) => eb.or([
          eb("operation.next_retry_at", "is", null), eb("operation.next_retry_at", "<=", Date.now()),
        ]));
      if (afterId !== null) query = query.where("operation.id", ">", afterId);
      const rows = await query.orderBy("operation.id", "asc")
        .limit(boundedLimit + 1).execute();
      const pageRows = rows.slice(0, boundedLimit);
      const operations: ProjectChatOperation[] = [];
      let malformed = 0;
      for (const row of pageRows) {
        try {
          const operation = mapOperation(row);
          if ((operation.payload.kind === "task_create" && !operation.payload.title)
            || (operation.payload.kind === "task_update"
              && (!operation.payload.patch || !operation.payload.before))) {
            throw new Error("Legacy task operation is missing recovery intent");
          }
          operations.push(operation);
        } catch {
          malformed += 1;
          await kdb.transaction().execute(async (trx) => {
            const updated = await trx.updateTable("project_chat_operations").set({
              status: "failed",
              payload: JSON.stringify(quarantinedPayload(row)),
              error: "Malformed operation data was quarantined",
              updated_at: now(),
            })
            .where("id", "=", row.id)
            .where("status", "in", ["pending", "resolving", "running"])
            .executeTakeFirst();
            if (Number(updated.numUpdatedRows) !== 1) return;
            const sequenceRow = await trx.selectFrom("project_chat_messages")
              .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
              .where("thread_id", "=", row.thread_id).executeTakeFirstOrThrow();
            await trx.insertInto("project_chat_messages").values({
              id: `operation:${row.id}:failed`, thread_id: row.thread_id,
              sequence: Number(sequenceRow.sequence) + 1, type: "operation",
              content: JSON.stringify({ operationId: row.id, status: "failed",
                error: "Malformed operation data was quarantined" }),
            }).onConflict((oc) => oc.column("id").doNothing()).execute();
          });
        }
      }
      return {
        operations,
        nextCursor: pageRows.at(-1)?.id ?? null,
        hasMore: rows.length > boundedLimit,
        malformed,
      };
    },

    recordRetry: async (id, threadId, projectId, userId, delayMs) => {
      const row = await kdb.updateTable("project_chat_operations")
        .set({ retry_count: sql`retry_count + 1`, next_retry_at: Date.now() + Math.max(1, delayMs), updated_at: now() })
        .where("id", "=", id).where("thread_id", "=", threadId)
        .where("project_id", "=", projectId).where("user_id", "=", userId)
        .where("status", "in", ["pending", "resolving", "running"])
        .returning("retry_count").executeTakeFirst();
      return row?.retry_count ?? 0;
    },
    clearRetry: async (id, threadId, projectId, userId) => {
      await kdb.updateTable("project_chat_operations")
        .set({ retry_count: 0, next_retry_at: null, updated_at: now() })
        .where("id", "=", id).where("thread_id", "=", threadId)
        .where("project_id", "=", projectId).where("user_id", "=", userId)
        .where((eb) => eb.or([eb("retry_count", ">", 0), eb("next_retry_at", "is not", null)]))
        .execute();
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
        const serializedPayload = serializeOperationPayload(opts.payload, {
          id: opts.id, kind: row.kind, status: opts.status,
        });
        const existingMessage = await trx.selectFrom("project_chat_messages")
          .selectAll().where("id", "=", opts.message.id)
          .where("thread_id", "=", opts.thread_id).executeTakeFirst();
        if (!existingMessage) return undefined;
        if (serializedPayload === row.payload && opts.error === row.error) {
          if (opts.message.content === existingMessage.content) {
            return { operation: mapOperation(row), message: mapMessage(existingMessage), changed: false };
          }
          const updatedMessage = await trx.updateTable("project_chat_messages")
            .set({ content: opts.message.content })
            .where("id", "=", opts.message.id).where("thread_id", "=", opts.thread_id)
            .where("content", "=", existingMessage.content)
            .returningAll().executeTakeFirst();
          if (!updatedMessage) return undefined;
          return { operation: mapOperation(row), message: mapMessage(updatedMessage), changed: true };
        }
        const currentPayload = operationPayloadSchema.parse(JSON.parse(row.payload));
        if (opts.error !== row.error || !allowsSameStatusPayloadAdvance(currentPayload, opts.payload)) {
          return undefined;
        }
        const updated = await trx.updateTable("project_chat_operations")
          .set({ payload: serializedPayload, updated_at: now() })
          .where("id", "=", opts.id).where("thread_id", "=", opts.thread_id)
          .where("status", "=", row.status).where("payload", "=", row.payload)
          .returningAll().executeTakeFirst();
        if (!updated) return undefined;
        let message = existingMessage;
        const publicChanged = existingMessage.content !== opts.message.content;
        if (publicChanged) {
          message = await trx.updateTable("project_chat_messages")
            .set({ content: opts.message.content })
            .where("id", "=", opts.message.id).where("thread_id", "=", opts.thread_id)
            .returningAll().executeTakeFirstOrThrow();
        }
        return { operation: mapOperation(updated), message: mapMessage(message), changed: publicChanged };
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
