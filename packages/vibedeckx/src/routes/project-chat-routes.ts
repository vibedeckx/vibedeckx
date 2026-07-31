import { randomUUID } from "crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { ProjectChatThread } from "../storage/types.js";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";

const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 100_000;
const LIST_LIMIT = 100;

type PatchBody = { title?: string | null; archived?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCreateBody(body: unknown): { message?: string } | null {
  if (body === undefined) return {};
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "message")) return null;
  if (!("message" in body)) return {};
  if (typeof body.message !== "string") return null;
  const message = body.message.trim();
  if (!message || message.length > MAX_MESSAGE_LENGTH) return null;
  return { message };
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

    const project = await fastify.storage.projects.getById(discovered.project_id, authResult);
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
    Querystring: { includeArchived?: string };
  }>("/api/projects/:projectId/project-chat/threads", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const { projectId } = req.params;
    const project = await fastify.storage.projects.getById(projectId, authResult);
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const threads = await fastify.storage.projectChatThreads.listByProject(
      projectId,
      resolveUserId(authResult),
      LIST_LIMIT,
      { includeArchived: req.query.includeArchived === "true" },
    );
    return reply.code(200).send({ threads });
  });

  fastify.post<{
    Params: { projectId: string };
    Body: unknown;
  }>("/api/projects/:projectId/project-chat/threads", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const { projectId } = req.params;
    const project = await fastify.storage.projects.getById(projectId, authResult);
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const body = parseCreateBody(req.body);
    if (!body) return reply.code(400).send({ error: "Body must contain only an optional non-empty message" });

    const userId = resolveUserId(authResult);
    const threadId = randomUUID();
    const thread = await fastify.storage.projectChatThreads.create({
      id: threadId,
      project_id: projectId,
      user_id: userId,
      title: null,
    });

    if (body.message !== undefined) {
      try {
        const message = await fastify.storage.projectChatMessages.append({
          id: randomUUID(),
          thread_id: threadId,
          project_id: projectId,
          user_id: userId,
          sequence: 1,
          type: "user",
          content: body.message,
        });
        if (!message) throw new Error("Failed to persist initial project chat message");
      } catch (error) {
        await fastify.storage.projectChatThreads.delete(threadId, projectId, userId);
        throw error;
      }
    }

    return reply.code(201).send({ thread });
  });

  fastify.get<{ Params: { threadId: string } }>(
    "/api/project-chat/threads/:threadId",
    async (req, reply) => {
      const owned = await getOwnedThread(req, reply, req.params.threadId);
      if (!owned) return;
      return reply.code(200).send({ thread: owned.thread });
    },
  );

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

    let thread = owned.thread;
    if ("title" in patch) {
      thread = (await fastify.storage.projectChatThreads.updateTitle(
        thread.id,
        thread.project_id,
        owned.userId,
        patch.title!,
      ))!;
    }
    if (patch.archived !== undefined) {
      const updateArchived = patch.archived
        ? fastify.storage.projectChatThreads.archive
        : fastify.storage.projectChatThreads.unarchive;
      thread = (await updateArchived(thread.id, thread.project_id, owned.userId))!;
    }
    return reply.code(200).send({ thread });
  });

  fastify.delete<{ Params: { threadId: string } }>(
    "/api/project-chat/threads/:threadId",
    async (req, reply) => {
      const owned = await getOwnedThread(req, reply, req.params.threadId);
      if (!owned) return;
      await fastify.storage.projectChatThreads.delete(
        owned.thread.id,
        owned.thread.project_id,
        owned.userId,
      );
      return reply.code(204).send();
    },
  );
};

export default fp(routes, { name: "project-chat-routes" });
