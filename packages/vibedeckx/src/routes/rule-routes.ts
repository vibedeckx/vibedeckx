import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import { requireAuth } from "../server.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // List rules for a workspace (project + branch)
  fastify.get<{ Params: { projectId: string }; Querystring: { branch?: string } }>(
    "/api/projects/:projectId/rules",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const branch = req.query.branch ?? null;
      const rules = fastify.storage.rules.getByWorkspace(req.params.projectId, branch);
      return reply.code(200).send({ rules });
    }
  );

  // Create rule
  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null; name: string; content: string; enabled?: boolean };
  }>("/api/projects/:projectId/rules", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branch, name, content, enabled } = req.body;
    if (!name || !content) {
      return reply.code(400).send({ error: "name and content are required" });
    }

    const id = randomUUID();
    const rule = fastify.storage.rules.create({
      id,
      project_id: req.params.projectId,
      branch: branch ?? null,
      name,
      content,
      enabled,
    });

    return reply.code(201).send({ rule });
  });

  // Update rule
  fastify.put<{
    Params: { id: string };
    Body: { name?: string; content?: string; enabled?: boolean; position?: number };
  }>("/api/rules/:id", async (req, reply) => {
    const existing = fastify.storage.rules.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Rule not found" });
    }

    const rule = fastify.storage.rules.update(req.params.id, {
      name: req.body.name,
      content: req.body.content,
      enabled: req.body.enabled,
      position: req.body.position,
    });
    return reply.code(200).send({ rule });
  });

  // Delete rule
  fastify.delete<{ Params: { id: string } }>("/api/rules/:id", async (req, reply) => {
    const existing = fastify.storage.rules.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Rule not found" });
    }

    fastify.storage.rules.delete(req.params.id);
    return reply.code(200).send({ success: true });
  });

  // Reorder rules
  fastify.put<{
    Params: { projectId: string };
    Querystring: { branch?: string };
    Body: { orderedIds: string[] };
  }>("/api/projects/:projectId/rules/reorder", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return reply.code(400).send({ error: "orderedIds must be an array" });
    }

    const branch = req.query.branch ?? null;
    fastify.storage.rules.reorder(req.params.projectId, branch, orderedIds);
    return reply.code(200).send({ success: true });
  });
};

export default fp(routes, { name: "rule-routes" });
