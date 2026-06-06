import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import { requireAuth } from "../server.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { projectId: string }; Querystring: { branch?: string } }>(
    "/api/projects/:projectId/commands",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const branch = req.query.branch ?? null;
      const commands = fastify.storage.commands.getByWorkspace(req.params.projectId, branch);
      return reply.code(200).send({ commands });
    }
  );

  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null; name: string; content: string };
  }>("/api/projects/:projectId/commands", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branch, name, content } = req.body;
    if (!name || !content) {
      return reply.code(400).send({ error: "name and content are required" });
    }

    const id = randomUUID();
    const command = fastify.storage.commands.create({
      id,
      project_id: req.params.projectId,
      branch: branch ?? null,
      name,
      content,
    });

    return reply.code(201).send({ command });
  });

  fastify.put<{
    Params: { id: string };
    Body: { name?: string; content?: string; position?: number };
  }>("/api/commands/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = fastify.storage.commands.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Command not found" });
    }
    const project = fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Command not found" });
    }

    const command = fastify.storage.commands.update(req.params.id, {
      name: req.body.name,
      content: req.body.content,
      position: req.body.position,
    });
    return reply.code(200).send({ command });
  });

  fastify.delete<{ Params: { id: string } }>("/api/commands/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = fastify.storage.commands.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Command not found" });
    }
    const project = fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Command not found" });
    }

    fastify.storage.commands.delete(req.params.id);
    return reply.code(200).send({ success: true });
  });
};

export default fp(routes, { name: "command-routes" });
