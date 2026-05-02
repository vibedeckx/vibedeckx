/**
 * REST routes for chat sessions (AI SDK chat, not Claude Code agent).
 */

import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // Create or get existing chat session for a project+branch
  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null };
  }>("/api/projects/:projectId/chat-sessions", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const { projectId } = req.params;
    const branch = req.body?.branch ?? null;

    const sessionId = fastify.chatSessionManager.getOrCreateSession(
      projectId,
      branch,
      resolveUserId(userId),
    );
    const session = fastify.chatSessionManager.getSession(sessionId);
    const messages = fastify.chatSessionManager.getMessages(sessionId);

    return reply.send({
      session: {
        id: session!.id,
        projectId: session!.projectId,
        branch: session!.branch,
        status: session!.status,
        eventListeningEnabled: session!.eventListeningEnabled,
      },
      messages,
    });
  });

  // Send a user message (triggers AI streaming)
  fastify.post<{
    Params: { sessionId: string };
    Body: { content: string };
  }>("/api/chat-sessions/:sessionId/message", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;

    const { sessionId } = req.params;
    const { content } = req.body;

    if (!content?.trim()) {
      return reply.code(400).send({ error: "Message content is required" });
    }

    const session = fastify.chatSessionManager.getSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }

    // Fire and forget — response streams over WebSocket
    fastify.chatSessionManager.sendMessage(sessionId, content.trim()).catch((err) => {
      console.error(`[ChatRoutes] sendMessage error for ${sessionId}:`, err);
    });

    return reply.send({ ok: true });
  });

  // Toggle event listening for a chat session
  fastify.post<{
    Params: { sessionId: string };
    Body: { enabled: boolean };
  }>("/api/chat-sessions/:sessionId/event-listening", async (req, reply) => {
    const { sessionId } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" });
    }

    const success = fastify.chatSessionManager.setEventListening(sessionId, enabled);
    if (!success) {
      return reply.code(404).send({ error: "Session not found" });
    }

    return reply.send({ enabled });
  });

  // Stop current generation
  fastify.post<{
    Params: { sessionId: string };
  }>("/api/chat-sessions/:sessionId/stop", async (req, reply) => {
    const { sessionId } = req.params;

    const stopped = fastify.chatSessionManager.stopGeneration(sessionId);
    if (!stopped) {
      return reply.code(404).send({ error: "Session not found or not generating" });
    }

    return reply.send({ ok: true });
  });

  // Reset session (clear conversation history)
  fastify.post<{
    Params: { sessionId: string };
  }>("/api/chat-sessions/:sessionId/reset", async (req, reply) => {
    const { sessionId } = req.params;

    const reset = fastify.chatSessionManager.resetSession(sessionId);
    if (!reset) {
      return reply.code(404).send({ error: "Session not found" });
    }

    return reply.send({ ok: true });
  });
};

export default fp(routes, { name: "chat-session-routes" });
