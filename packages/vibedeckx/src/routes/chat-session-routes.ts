/**
 * REST routes for chat sessions (AI SDK chat, not Claude Code agent).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // Resolve a session only if the authenticated caller owns it. Returns the
  // session, or null after sending the appropriate error reply.
  const getAuthorizedSession = (req: FastifyRequest, reply: FastifyReply, sessionId: string) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return null;
    const userId = resolveUserId(authResult);

    const session = fastify.chatSessionManager.getSession(sessionId);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return null;
    }
    if (session.userId !== userId) {
      reply.code(403).send({ error: "Forbidden" });
      return null;
    }
    return session;
  };

  // Create or get existing chat session for a project+branch
  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null };
  }>("/api/projects/:projectId/chat-sessions", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const { projectId } = req.params;
    const project = fastify.storage.projects.getById(projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
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
    const { sessionId } = req.params;
    const { content } = req.body;

    const session = getAuthorizedSession(req, reply, sessionId);
    if (!session) return;

    if (!content?.trim()) {
      return reply.code(400).send({ error: "Message content is required" });
    }

    // Fire and forget — response streams over WebSocket
    fastify.chatSessionManager.sendMessage(sessionId, content.trim()).catch((err) => {
      console.error(`[ChatRoutes] sendMessage error for ${sessionId}:`, err);
    });

    return reply.send({ ok: true });
  });

  // Decide a parked tool-approval-request (event-driven outbound send)
  fastify.post<{
    Params: { sessionId: string };
    Body: { approvalId: string; approved: boolean };
  }>("/api/chat-sessions/:sessionId/tool-approval", async (req, reply) => {
    const { sessionId } = req.params;
    const { approvalId, approved } = req.body;

    const session = getAuthorizedSession(req, reply, sessionId);
    if (!session) return;

    if (typeof approvalId !== "string" || typeof approved !== "boolean") {
      return reply.code(400).send({ error: "approvalId (string) and approved (boolean) are required" });
    }

    const ok = fastify.chatSessionManager.resolveToolApproval(sessionId, approvalId, approved);
    if (!ok) {
      return reply.code(404).send({ error: "No matching pending approval" });
    }
    return reply.send({ ok: true });
  });

  // Toggle event listening for a chat session
  fastify.post<{
    Params: { sessionId: string };
    Body: { enabled: boolean };
  }>("/api/chat-sessions/:sessionId/event-listening", async (req, reply) => {
    const { sessionId } = req.params;
    const { enabled } = req.body;

    const session = getAuthorizedSession(req, reply, sessionId);
    if (!session) return;

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

    const session = getAuthorizedSession(req, reply, sessionId);
    if (!session) return;

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

    const session = getAuthorizedSession(req, reply, sessionId);
    if (!session) return;

    const reset = fastify.chatSessionManager.resetSession(sessionId);
    if (!reset) {
      return reply.code(404).send({ error: "Session not found" });
    }

    return reply.send({ ok: true });
  });
};

export default fp(routes, { name: "chat-session-routes" });
