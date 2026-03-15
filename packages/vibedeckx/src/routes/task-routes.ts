import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import { generateText } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { requireAuth } from "../server.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // List tasks for a project (ordered by position)
  fastify.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tasks",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const tasks = fastify.storage.tasks.getByProjectId(req.params.projectId);
      return reply.code(200).send({ tasks });
    }
  );

  // Create task
  fastify.post<{
    Params: { projectId: string };
    Body: { title?: string; description: string; status?: string; priority?: string; assigned_branch?: string | null };
  }>("/api/projects/:projectId/tasks", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { title: providedTitle, description, status, priority, assigned_branch } = req.body;
    if (!description) {
      return reply.code(400).send({ error: "description is required" });
    }

    let title = providedTitle;
    if (!title) {
      try {
        const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY ?? "" });
        const { text } = await generateText({
          model: deepseek("deepseek-chat"),
          prompt: `Generate a concise task title (under 10 words) that captures the essence of this task description. Return only the title text, nothing else.\n\nDescription: ${description}`,
        });
        title = text.trim();
      } catch {
        title = description.length > 50 ? description.slice(0, 50) + "..." : description;
      }
    }

    const id = randomUUID();
    const task = fastify.storage.tasks.create({
      id,
      project_id: req.params.projectId,
      title,
      description,
      status: status as 'todo' | 'in_progress' | 'done' | 'cancelled' | undefined,
      priority: priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
      assigned_branch,
    });

    return reply.code(201).send({ task });
  });

  // Update task
  fastify.put<{
    Params: { id: string };
    Body: { title?: string; description?: string | null; status?: string; priority?: string; assigned_branch?: string | null; position?: number };
  }>("/api/tasks/:id", async (req, reply) => {
    const existing = fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const task = fastify.storage.tasks.update(req.params.id, {
      title: req.body.title,
      description: req.body.description,
      status: req.body.status as 'todo' | 'in_progress' | 'done' | 'cancelled' | undefined,
      priority: req.body.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
      assigned_branch: req.body.assigned_branch,
      position: req.body.position,
    });
    return reply.code(200).send({ task });
  });

  // Delete task
  fastify.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const existing = fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }

    fastify.storage.tasks.delete(req.params.id);
    return reply.code(200).send({ success: true });
  });

  // Reorder tasks
  fastify.put<{
    Params: { projectId: string };
    Body: { orderedIds: string[] };
  }>("/api/projects/:projectId/tasks/reorder", async (req, reply) => {
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

    const existingTasks = fastify.storage.tasks.getByProjectId(req.params.projectId);
    const existingIds = new Set(existingTasks.map(t => t.id));
    for (const id of orderedIds) {
      if (!existingIds.has(id)) {
        return reply.code(400).send({ error: `Task ${id} not found in project` });
      }
    }

    fastify.storage.tasks.reorder(req.params.projectId, orderedIds);
    return reply.code(200).send({ success: true });
  });
};

export default fp(routes, { name: "task-routes" });
