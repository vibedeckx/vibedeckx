import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import { requireAuth } from "../server.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // Get executors — optionally scoped to a group
  fastify.get<{ Params: { projectId: string }; Querystring: { groupId?: string } }>(
    "/api/projects/:projectId/executors",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const executors = req.query.groupId
        ? fastify.storage.executors.getByGroupId(req.query.groupId)
        : fastify.storage.executors.getByProjectId(req.params.projectId);
      return reply.code(200).send({ executors });
    }
  );

  // Create Executor
  fastify.post<{
    Params: { projectId: string };
    Body: { name: string; command: string; cwd?: string; pty?: boolean; group_id: string };
  }>("/api/projects/:projectId/executors", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { name, command, cwd, pty, group_id } = req.body;
    if (!group_id) {
      return reply.code(400).send({ error: "group_id is required" });
    }

    const id = randomUUID();
    const executor = fastify.storage.executors.create({
      id,
      project_id: req.params.projectId,
      group_id,
      name,
      command,
      cwd,
      pty,
    });

    return reply.code(201).send({ executor });
  });

  // 更新 Executor
  fastify.put<{
    Params: { id: string };
    Body: { name?: string; command?: string; cwd?: string | null; pty?: boolean };
  }>("/api/executors/:id", async (req, reply) => {
    const existing = fastify.storage.executors.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Executor not found" });
    }

    const executor = fastify.storage.executors.update(req.params.id, req.body);
    return reply.code(200).send({ executor });
  });

  // 删除 Executor
  fastify.delete<{ Params: { id: string } }>("/api/executors/:id", async (req, reply) => {
    const existing = fastify.storage.executors.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Executor not found" });
    }

    fastify.storage.executors.delete(req.params.id);
    return reply.code(200).send({ success: true });
  });

  // Reorder Executors within a group
  fastify.put<{
    Params: { projectId: string };
    Body: { orderedIds: string[]; groupId: string };
  }>("/api/projects/:projectId/executors/reorder", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { orderedIds, groupId } = req.body;
    if (!Array.isArray(orderedIds)) {
      return reply.code(400).send({ error: "orderedIds must be an array" });
    }
    if (!groupId) {
      return reply.code(400).send({ error: "groupId is required" });
    }

    const existingExecutors = fastify.storage.executors.getByGroupId(groupId);
    const existingIds = new Set(existingExecutors.map(e => e.id));
    for (const id of orderedIds) {
      if (!existingIds.has(id)) {
        return reply.code(400).send({ error: `Executor ${id} not found in group` });
      }
    }

    fastify.storage.executors.reorder(groupId, orderedIds);
    return reply.code(200).send({ success: true });
  });
};

export default fp(routes, { name: "executor-routes" });
