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

      const project = await fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const groups = await fastify.storage.executorGroups.getByProjectId(req.params.projectId);
      return reply.code(200).send({ groups });
    }
  );

  // Get executor group by branch
  fastify.get<{ Params: { projectId: string }; Querystring: { branch?: string } }>(
    "/api/projects/:projectId/executor-groups/by-branch",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const branch = req.query.branch ?? "";
      const group = await fastify.storage.executorGroups.getByBranch(req.params.projectId, branch);
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

    const project = await fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { name, branch } = req.body;
    const id = randomUUID();
    // Atomic check-then-create: the previous getByBranch()-then-create()
    // sequence had a window (two awaited storage calls) where two concurrent
    // POSTs for the same branch could both observe "none exists" and both
    // attempt to insert — the UNIQUE(project_id, branch) constraint stopped
    // the duplicate row, but the loser got an unhandled 500 instead of the
    // intended 409. createIfBranchFree() does the check-and-insert in one
    // storage call and reports which branch happened.
    const result = await fastify.storage.executorGroups.createIfBranchFree({
      id,
      project_id: req.params.projectId,
      name,
      branch,
    });
    if (!result.created) {
      return reply.code(409).send({ error: "An executor group already exists for this branch" });
    }

    return reply.code(201).send({ group: result.group });
  });

  // Update executor group (rename)
  fastify.put<{
    Params: { id: string };
    Body: { name?: string };
  }>("/api/executor-groups/:id", async (req, reply) => {
    const existing = await fastify.storage.executorGroups.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Executor group not found" });
    }

    const group = await fastify.storage.executorGroups.update(req.params.id, req.body);
    return reply.code(200).send({ group });
  });

  // Delete executor group (cascades executors)
  fastify.delete<{ Params: { id: string } }>(
    "/api/executor-groups/:id",
    async (req, reply) => {
      const existing = await fastify.storage.executorGroups.getById(req.params.id);
      if (!existing) {
        return reply.code(404).send({ error: "Executor group not found" });
      }

      await fastify.storage.executorGroups.delete(req.params.id);
      return reply.code(200).send({ success: true });
    }
  );
};

export default fp(routes, { name: "executor-group-routes" });
