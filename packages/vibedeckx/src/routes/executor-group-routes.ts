import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import { requireAuth } from "../server.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // List all executor groups for a project
  fastify.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/executor-groups",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const groups = fastify.storage.executorGroups.getByProjectId(req.params.projectId);
      return reply.code(200).send({ groups });
    }
  );

  // Get executor group by branch
  fastify.get<{ Params: { projectId: string }; Querystring: { branch?: string } }>(
    "/api/projects/:projectId/executor-groups/by-branch",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const branch = req.query.branch ?? "";
      const group = fastify.storage.executorGroups.getByBranch(req.params.projectId, branch);
      if (!group) {
        return reply.code(404).send({ error: "Executor group not found for this branch" });
      }

      return reply.code(200).send({ group });
    }
  );

  // Create executor group
  fastify.post<{
    Params: { projectId: string };
    Body: { name: string; branch: string };
  }>("/api/projects/:projectId/executor-groups", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { name, branch } = req.body;
    const existing = fastify.storage.executorGroups.getByBranch(req.params.projectId, branch);
    if (existing) {
      return reply.code(409).send({ error: "An executor group already exists for this branch" });
    }

    const id = randomUUID();
    const group = fastify.storage.executorGroups.create({
      id,
      project_id: req.params.projectId,
      name,
      branch,
    });

    return reply.code(201).send({ group });
  });

  // Update executor group (rename)
  fastify.put<{
    Params: { id: string };
    Body: { name?: string };
  }>("/api/executor-groups/:id", async (req, reply) => {
    const existing = fastify.storage.executorGroups.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Executor group not found" });
    }

    const group = fastify.storage.executorGroups.update(req.params.id, req.body);
    return reply.code(200).send({ group });
  });

  // Delete executor group (cascades executors)
  fastify.delete<{ Params: { id: string } }>(
    "/api/executor-groups/:id",
    async (req, reply) => {
      const existing = fastify.storage.executorGroups.getById(req.params.id);
      if (!existing) {
        return reply.code(404).send({ error: "Executor group not found" });
      }

      fastify.storage.executorGroups.delete(req.params.id);
      return reply.code(200).send({ success: true });
    }
  );
};

export default fp(routes, { name: "executor-group-routes" });
