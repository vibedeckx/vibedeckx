import { createHash, randomUUID } from "crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { ProjectChatThread } from "../storage/types.js";
import {
  ProjectChatActiveTurnConflictError,
  PROJECT_CHAT_MODEL_MESSAGE_BYTE_LIMIT,
  PROJECT_CHAT_LIVE_MESSAGE_BYTE_LIMIT,
  ProjectChatWorkspaceSelectionConflictError,
} from "../project-chat-manager.js";
import { MAX_TOOL_SELECTOR_ID } from "../project-chat-tools.js";
import { listProjectChatPublicContextRefs } from "../project-chat-context.js";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";

const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 100_000;
const THREAD_PAGE_LIMIT = 50;
const MAX_THREAD_SEARCH_LENGTH = 200;
const MAX_THREAD_CURSOR_LENGTH = 2048;
const MESSAGE_PAGE_LIMIT = 100;
const MESSAGE_PAGE_BYTE_LIMIT = PROJECT_CHAT_LIVE_MESSAGE_BYTE_LIMIT;

type PatchBody = { title?: string | null; archived?: boolean };
type MessageBody = { content: string };
type ToolApprovalBody = { approvalId: string; approved: boolean };
type StopBody = { expectedActiveTurnId: string };
type WorkspaceSelectionBody = { requestId: string; workspaceId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ThreadListQuery = {
  includeArchived: boolean;
  query?: string;
  cursor?: { updatedAt: string; id: string };
};

function encodeThreadCursor(cursor: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, updatedAt: cursor.updatedAt, id: cursor.id }), "utf8")
    .toString("base64url");
}

function decodeThreadCursor(value: string): { updatedAt: string; id: string } | null {
  if (!value || value.length > MAX_THREAD_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded) || Object.keys(decoded).sort().join(",") !== "id,updatedAt,v"
      || decoded.v !== 1 || typeof decoded.updatedAt !== "string" || !decoded.updatedAt
      || decoded.updatedAt.length > 100 || typeof decoded.id !== "string" || !decoded.id
      || decoded.id.length > 512) return null;
    return { updatedAt: decoded.updatedAt, id: decoded.id };
  } catch {
    return null;
  }
}

function parseThreadListQuery(value: unknown): ThreadListQuery | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== "includeArchived" && key !== "q" && key !== "cursor")) return null;
  let includeArchived = false;
  if ("includeArchived" in value) {
    if (value.includeArchived !== "true" && value.includeArchived !== "false") return null;
    includeArchived = value.includeArchived === "true";
  }
  let query: string | undefined;
  if ("q" in value) {
    if (typeof value.q !== "string") return null;
    query = value.q.trim();
    if (!query || query.length > MAX_THREAD_SEARCH_LENGTH) return null;
  }
  let cursor: { updatedAt: string; id: string } | undefined;
  if ("cursor" in value) {
    if (typeof value.cursor !== "string") return null;
    cursor = decodeThreadCursor(value.cursor) ?? undefined;
    if (!cursor) return null;
  }
  return { includeArchived, ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) };
}

function parseCreateBody(body: unknown): { message?: string; createRequestId?: string } | null {
  if (body === undefined) return {};
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "message" && key !== "createRequestId")) return null;
  let createRequestId: string | undefined;
  if ("createRequestId" in body) {
    if (typeof body.createRequestId !== "string") return null;
    createRequestId = body.createRequestId.trim();
    if (!createRequestId || createRequestId.length > 512) return null;
  }
  if (!("message" in body)) return createRequestId ? { createRequestId } : {};
  if (typeof body.message !== "string") return null;
  const message = body.message.trim();
  if (!message || message.length > MAX_MESSAGE_LENGTH
    || Buffer.byteLength(message, "utf8") > PROJECT_CHAT_MODEL_MESSAGE_BYTE_LIMIT) return null;
  return { message, ...(createRequestId ? { createRequestId } : {}) };
}

function parsePatchBody(body: unknown): PatchBody | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => key !== "title" && key !== "archived")) return null;

  const patch: PatchBody = {};
  if ("title" in body) {
    if (body.title !== null && typeof body.title !== "string") return null;
    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (!title || title.length > MAX_TITLE_LENGTH) return null;
      patch.title = title;
    } else {
      patch.title = null;
    }
  }
  if ("archived" in body) {
    if (typeof body.archived !== "boolean") return null;
    patch.archived = body.archived;
  }
  return patch;
}

function parseMessageBody(body: unknown): MessageBody | null {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "content")) return null;
  if (typeof body.content !== "string") return null;
  const content = body.content.trim();
  if (!content || content.length > MAX_MESSAGE_LENGTH
    || Buffer.byteLength(content, "utf8") > PROJECT_CHAT_MODEL_MESSAGE_BYTE_LIMIT) return null;
  return { content };
}

function parseToolApprovalBody(body: unknown): ToolApprovalBody | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || keys.some((key) => key !== "approvalId" && key !== "approved")) return null;
  if (typeof body.approvalId !== "string" || !body.approvalId.trim()) return null;
  if (typeof body.approved !== "boolean") return null;
  return { approvalId: body.approvalId.trim(), approved: body.approved };
}

function parseStopBody(body: unknown): StopBody | null {
  if (!isRecord(body) || Object.keys(body).length !== 1
    || typeof body.expectedActiveTurnId !== "string") return null;
  const expectedActiveTurnId = body.expectedActiveTurnId.trim();
  return expectedActiveTurnId ? { expectedActiveTurnId } : null;
}

function parseWorkspaceSelectionBody(body: unknown): WorkspaceSelectionBody | null {
  if (!isRecord(body) || Object.keys(body).length !== 2
    || Object.keys(body).some((key) => key !== "requestId" && key !== "workspaceId")) return null;
  if (typeof body.requestId !== "string" || typeof body.workspaceId !== "string") return null;
  const requestId = body.requestId.trim();
  const workspaceId = body.workspaceId.trim();
  if (!requestId || requestId.length > MAX_TOOL_SELECTOR_ID
    || !workspaceId || workspaceId.length > MAX_TOOL_SELECTOR_ID) return null;
  return { requestId, workspaceId };
}

const routes: FastifyPluginAsync = async (fastify) => {
  const getOwnedThread = async (
    req: FastifyRequest,
    reply: FastifyReply,
    threadId: string,
  ): Promise<{ thread: ProjectChatThread; userId: string } | null> => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return null;
    const userId = resolveUserId(authResult);
    const discovered = await fastify.storage.projectChatThreads.getOwnedById(threadId, userId);
    if (!discovered) {
      reply.code(404).send({ error: "Thread not found" });
      return null;
    }

    const project = await fastify.storage.projects.getById(discovered.project_id, userId);
    if (!project) {
      reply.code(404).send({ error: "Thread not found" });
      return null;
    }

    const thread = await fastify.storage.projectChatThreads.getById(
      threadId,
      discovered.project_id,
      userId,
    );
    if (!thread) {
      reply.code(404).send({ error: "Thread not found" });
      return null;
    }
    return { thread, userId };
  };

  fastify.get<{
    Params: { projectId: string };
    Querystring: unknown;
  }>("/api/projects/:projectId/project-chat/threads", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
    const { projectId } = req.params;
    const project = await fastify.storage.projects.getById(projectId, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const query = parseThreadListQuery(req.query);
    if (!query) return reply.code(400).send({ error: "Invalid thread list query" });

    const page = await fastify.storage.projectChatThreads.listPageByProject(
      projectId,
      userId,
      THREAD_PAGE_LIMIT,
      query,
    );
    const last = page.threads.at(-1);
    return reply.code(200).send({
      threads: page.threads,
      nextCursor: page.hasMore && last
        ? encodeThreadCursor({ updatedAt: last.updated_at, id: last.id })
        : null,
    });
  });

  fastify.post<{
    Params: { projectId: string };
    Body: unknown;
  }>("/api/projects/:projectId/project-chat/threads", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
    const { projectId } = req.params;
    const project = await fastify.storage.projects.getById(projectId, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const body = parseCreateBody(req.body);
    if (!body) return reply.code(400).send({ error: "Body must contain only an optional non-empty message" });

    const createRequestId = body.createRequestId ?? randomUUID();
    const createPayloadHash = createHash("sha256")
      .update(JSON.stringify({ message: body.message ?? null }))
      .digest("hex");
    let accepted: { thread: ProjectChatThread; created: boolean };
    try {
      accepted = await fastify.storage.projectChatThreads.createIdempotent({
        id: randomUUID(), project_id: projectId, user_id: userId, title: null,
        create_request_id: createRequestId, create_payload_hash: createPayloadHash,
        ...(body.message !== undefined
          ? { initialTurn: {
            messageId: randomUUID(), workItemId: randomUUID(), content: body.message,
          } }
          : {}),
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "PROJECT_CHAT_CREATE_CONFLICT") {
        return reply.code(409).send({ error: "createRequestId was already used with a different payload" });
      }
      throw error;
    }
    const { thread } = accepted;
    if (accepted.created && body.message !== undefined) {
      try {
        await fastify.projectChatManager.startAcceptedThread(thread.id, userId);
      } catch (error) {
        // Acceptance is already durable. A later stream open (or a process
        // restart) reloads this exact journal row, so returning the created
        // Thread is safer than inviting a client retry that creates a second
        // Thread and duplicates the user's intent.
        req.log.warn({ err: error, threadId: thread.id }, "Project Chat initial turn will resume later");
      }
    }

    return reply.code(201).send({ thread });
  });

  fastify.get<{ Params: { threadId: string } }>(
    "/api/project-chat/threads/:threadId",
    async (req, reply) => {
      const owned = await getOwnedThread(req, reply, req.params.threadId);
      if (!owned) return;
      const contextRefs = await listProjectChatPublicContextRefs(fastify.storage, owned.thread);
      return reply.code(200).send({ thread: owned.thread, contextRefs });
    },
  );

  fastify.get<{
    Params: { threadId: string };
    Querystring: { beforeSequence?: string; limit?: string };
  }>("/api/project-chat/threads/:threadId/messages", async (req, reply) => {
    const owned = await getOwnedThread(req, reply, req.params.threadId);
    if (!owned) return;
    const beforeSequence = req.query.beforeSequence === undefined
      ? null
      : Number(req.query.beforeSequence);
    const requestedLimit = req.query.limit === undefined ? MESSAGE_PAGE_LIMIT : Number(req.query.limit);
    if ((beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence <= 0))
      || !Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
      return reply.code(400).send({ error: "Invalid message cursor or limit" });
    }
    const page = await fastify.storage.projectChatMessages.listPageBefore(
      owned.thread.id,
      owned.thread.project_id,
      owned.userId,
      {
        beforeSequence,
        limit: Math.min(requestedLimit, MESSAGE_PAGE_LIMIT),
        maxUtf8Bytes: MESSAGE_PAGE_BYTE_LIMIT,
      },
    );
    if (!page) return reply.code(404).send({ error: "Thread not found" });
    return reply.code(200).send(page);
  });

  fastify.patch<{
    Params: { threadId: string };
    Body: unknown;
  }>("/api/project-chat/threads/:threadId", async (req, reply) => {
    const owned = await getOwnedThread(req, reply, req.params.threadId);
    if (!owned) return;
    const patch = parsePatchBody(req.body);
    if (!patch) {
      return reply.code(400).send({ error: "Body must contain only title and/or archived" });
    }

    const thread = await fastify.storage.projectChatThreads.update(
      owned.thread.id,
      owned.thread.project_id,
      owned.userId,
      patch,
    );
    if (!thread) {
      return reply.code(404).send({ error: "Thread not found" });
    }
    return reply.code(200).send({ thread });
  });

  fastify.delete<{ Params: { threadId: string } }>(
    "/api/project-chat/threads/:threadId",
    async (req, reply) => {
      const owned = await getOwnedThread(req, reply, req.params.threadId);
      if (!owned) return;
      const deleted = await fastify.projectChatManager.deleteThread(owned.thread.id, owned.userId);
      if (!deleted) return reply.code(404).send({ error: "Thread not found" });
      return reply.code(204).send();
    },
  );

  fastify.post<{
    Params: { threadId: string };
    Body: unknown;
  }>("/api/project-chat/threads/:threadId/messages", async (req, reply) => {
    const owned = await getOwnedThread(req, reply, req.params.threadId);
    if (!owned) return;
    const body = parseMessageBody(req.body);
    if (!body) return reply.code(400).send({ error: "A non-empty content string is required" });

    // Wait only for durable acceptance; generation continues over WebSocket.
    await fastify.projectChatManager.sendMessage(owned.thread.id, owned.userId, body.content);
    return reply.code(202).send({ accepted: true });
  });

  fastify.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/project-chat/threads/:threadId/stop",
    async (req, reply) => {
      const owned = await getOwnedThread(req, reply, req.params.threadId);
      if (!owned) return;
      const body = parseStopBody(req.body);
      if (!body) return reply.code(400).send({ error: "expectedActiveTurnId is required" });
      try {
        const stopped = await fastify.projectChatManager.stopGeneration(
          owned.thread.id,
          owned.userId,
          body.expectedActiveTurnId,
        );
        return reply.code(200).send({ stopped });
      } catch (error) {
        if (error instanceof ProjectChatActiveTurnConflictError
          || (isRecord(error) && error.code === "PROJECT_CHAT_ACTIVE_TURN_CONFLICT")) {
          return reply.code(409).send({ error: "Active Project Chat turn changed" });
        }
        throw error;
      }
    },
  );

  fastify.post<{
    Params: { threadId: string };
    Body: unknown;
  }>("/api/project-chat/threads/:threadId/tool-approval", async (req, reply) => {
    const owned = await getOwnedThread(req, reply, req.params.threadId);
    if (!owned) return;
    const body = parseToolApprovalBody(req.body);
    if (!body) {
      return reply.code(400).send({ error: "approvalId (string) and approved (boolean) are required" });
    }
    const resolved = await fastify.projectChatManager.resolveToolApproval(
      owned.thread.id,
      owned.userId,
      body.approvalId,
      body.approved,
    );
    if (!resolved) return reply.code(404).send({ error: "Tool approval not found" });
    return reply.code(200).send({ resolved: true });
  });

  fastify.post<{
    Params: { threadId: string };
    Body: unknown;
  }>("/api/project-chat/threads/:threadId/workspace-selection", async (req, reply) => {
    const owned = await getOwnedThread(req, reply, req.params.threadId);
    if (!owned) return;
    const body = parseWorkspaceSelectionBody(req.body);
    if (!body) {
      return reply.code(400).send({ error: "requestId and workspaceId are required" });
    }
    try {
      const result = await fastify.projectChatManager.selectWorkspace(
        owned.thread.id, owned.userId, body.requestId, body.workspaceId,
      );
      if (!result) return reply.code(404).send({ error: "Workspace selection not found" });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ProjectChatWorkspaceSelectionConflictError
        || (isRecord(error) && error.code === "PROJECT_CHAT_WORKSPACE_SELECTION_CONFLICT")) {
        const message = error instanceof Error ? error.message : "Workspace selection conflict";
        return reply.code(409).send({ error: message.slice(0, 512) });
      }
      req.log.error({ err: error }, "Project Chat workspace selection failed");
      return reply.code(500).send({ error: "Workspace selection failed" });
    }
  });
};

export default fp(routes, { name: "project-chat-routes" });
