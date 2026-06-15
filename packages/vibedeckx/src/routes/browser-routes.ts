import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // Authenticate and verify the caller owns (or, in solo mode, that there
  // exists) the project before touching BrowserManager. Returns the projectId
  // on success, or null after sending the appropriate error response.
  const ensureProjectAccess = (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): string | null => {
    const userId = requireAuth(req, reply);
    if (userId === null) return null;

    const projectId = req.params.id;
    const project = fastify.storage.projects.getById(projectId, userId);
    if (!project) {
      reply.code(404).send({ error: "Project not found" });
      return null;
    }

    return projectId;
  };

  // Start browser session
  fastify.post<{
    Params: { id: string };
    Body: { branch?: string };
  }>("/api/projects/:id/browser", async (req, reply) => {
    const projectId = ensureProjectAccess(req, reply);
    if (projectId === null) return;
    const { branch } = req.body || {};

    try {
      const session = await fastify.browserManager.startSession(
        projectId,
        branch ?? null,
      );
      return reply.code(200).send(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start browser";
      return reply.code(500).send({ error: msg });
    }
  });

  // Get browser session status
  fastify.get<{
    Params: { id: string };
  }>("/api/projects/:id/browser", async (req, reply) => {
    const projectId = ensureProjectAccess(req, reply);
    if (projectId === null) return;
    const session = fastify.browserManager.getSession(projectId);

    if (!session) {
      return reply.code(404).send({ error: "No browser session" });
    }

    return reply.code(200).send(session);
  });

  // Stop browser session
  fastify.delete<{
    Params: { id: string };
  }>("/api/projects/:id/browser", async (req, reply) => {
    const projectId = ensureProjectAccess(req, reply);
    if (projectId === null) return;
    const stopped = await fastify.browserManager.stopSession(projectId);

    if (!stopped) {
      return reply.code(404).send({ error: "No browser session to stop" });
    }

    return reply.code(200).send({ ok: true });
  });

  // Navigate browser to URL
  fastify.post<{
    Params: { id: string };
    Body: { url: string };
  }>("/api/projects/:id/browser/navigate", async (req, reply) => {
    const projectId = ensureProjectAccess(req, reply);
    if (projectId === null) return;
    const { url } = req.body;

    if (!url) {
      return reply.code(400).send({ error: "URL is required" });
    }

    try {
      const result = await fastify.browserManager.navigate(projectId, url);
      if (!result) {
        return reply.code(404).send({ error: "No browser session. Start one first." });
      }
      return reply.code(200).send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Navigation failed";
      return reply.code(500).send({ error: msg });
    }
  });

  // Report browser error from injected script
  fastify.post<{
    Params: { id: string };
    Body: { type: string; data: Record<string, unknown> };
  }>("/api/projects/:id/browser/error", async (req, reply) => {
    const projectId = ensureProjectAccess(req, reply);
    if (projectId === null) return;
    const { type, data } = req.body;

    console.log(`[BrowserRoutes] Error report for project ${projectId}: ${type}`, data);

    return reply.code(200).send({ ok: true });
  });
};

export default fp(routes, { name: "browser-routes" });
