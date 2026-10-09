import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import { generateText } from "ai";
import { resolveFastChatModel } from "../utils/chat-model.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import { isProjectSourceSession, resolveSourceSessions, validSourceId } from "./source-sessions.js";
import type { Task, TaskSource } from "../storage/types.js";
import { applyTaskChange, revertTaskPatch } from "../retention-holds.js";
import "../server-types.js";

/** Far above PROPOSE_TASK_MAX_ITEMS; only bounds what a caller can claim. */
const SOURCE_ITEM_INDEX_MAX = 100;

interface SourceBody { session_id?: unknown; tool_use_id?: unknown; item_index?: unknown }

/** Bounds the ancestor walk; far deeper than any tree a person keeps. */
const PARENT_DEPTH_MAX = 64;

const routes: FastifyPluginAsync = async (fastify) => {
  const applyHoldingChange = (
    taskId: string,
    apply: () => Promise<Task | undefined>,
    revert: (before: Task) => Promise<unknown>,
  ) => applyTaskChange(fastify, taskId, apply, revert);
  const holdFailed = (error: unknown) =>
    `Could not protect the source session from retention: ${error instanceof Error ? error.message : String(error)}`;

  /**
   * Error message when `parentId` can't parent `taskId` (null for a task not
   * created yet): it must be an existing task in the same project, and not the
   * task itself or one of its descendants.
   */
  const parentError = async (projectId: string, taskId: string | null, parentId: unknown): Promise<string | null> => {
    if (parentId === null) return null;
    if (!validSourceId(parentId)) return "Invalid parent_id";
    let current: string | null = parentId;
    for (let depth = 0; current !== null; depth++) {
      if (current === taskId) return "A task can't be nested under itself or its own sub-task";
      if (depth >= PARENT_DEPTH_MAX) return "Task nesting is too deep";
      const ancestor = await fastify.storage.tasks.getById(current);
      if (!ancestor || ancestor.project_id !== projectId) return "Parent task not found";
      current = ancestor.parent_id;
    }
    return null;
  };

  // List tasks for a project (ordered by position)
  fastify.get<{ Params: { projectId: string }; Querystring: { includeArchived?: string } }>(
    "/api/projects/:projectId/tasks",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = await fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const includeArchived = req.query.includeArchived === "true";
      const tasks = await fastify.storage.tasks.getByProjectId(req.params.projectId, { includeArchived });
      const sources = await resolveSourceSessions(
        fastify.storage,
        tasks.flatMap((t) => (t.source_session_id ? [t.source_session_id] : [])),
      );
      return reply.code(200).send({
        tasks: tasks.map((t) => ({
          ...t,
          source_session: t.source_session_id ? sources.get(t.source_session_id) ?? null : null,
        })),
      });
    }
  );

  // Read one task without loading the project's full task board. Keep project
  // ownership and task/project membership in the same authorization boundary.
  fastify.get<{ Params: { projectId: string; taskId: string } }>(
    "/api/projects/:projectId/tasks/:taskId",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = await fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) return reply.code(404).send({ error: "Task not found" });
      const task = await fastify.storage.tasks.getById(req.params.taskId);
      if (!task || task.project_id !== project.id) {
        return reply.code(404).send({ error: "Task not found" });
      }
      return reply.code(200).send({ task });
    },
  );

  // Create task
  fastify.post<{
    Params: { projectId: string };
    Body: {
      title?: string; description: string; status?: string; priority?: string; assigned_branch?: string | null;
      parent_id?: string | null;
      /** Provenance of an agent proposal (propose_task); makes create idempotent. */
      source?: SourceBody | null;
    };
  }>("/api/projects/:projectId/tasks", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = await fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { title: providedTitle, description, status, priority } = req.body;
    let { assigned_branch } = req.body;
    if (!description) {
      return reply.code(400).send({ error: "description is required" });
    }
    const parent_id = req.body.parent_id ?? null;
    const invalidParent = await parentError(req.params.projectId, null, parent_id);
    if (invalidParent) return reply.code(400).send({ error: invalidParent });

    let source: TaskSource | null = null;
    if (req.body.source) {
      const { session_id, tool_use_id, item_index } = req.body.source;
      if (!validSourceId(session_id) || !validSourceId(tool_use_id)
        || typeof item_index !== "number" || !Number.isInteger(item_index)
        || item_index < 0 || item_index > SOURCE_ITEM_INDEX_MAX) {
        return reply.code(400).send({ error: "Invalid source" });
      }
      if (!(await isProjectSourceSession(fastify.storage, session_id, req.params.projectId))) {
        return reply.code(400).send({ error: "Invalid source" });
      }
      source = { session_id, tool_use_id, item_index };
      // Never pre-assigned: turn-end auto-complete closes the first task
      // assigned to a branch, so a follow-up assigned to its source session's
      // branch would be marked done by that session's very next turn. The
      // user assigns a branch when they actually start on it.
      assigned_branch = null;
    }

    let title = providedTitle;
    if (!title) {
      try {
        const { text } = await generateText({
          model: await resolveFastChatModel(fastify.storage, resolveUserId(userId)),
          prompt: `Generate a concise task title (under 10 words) that captures the essence of this task description. Write the title in the same language as the description. Return only the title text, nothing else.\n\nDescription: ${description}`,
          experimental_telemetry: {
            isEnabled: true,
            functionId: "task-suggest",
            metadata: {
              userId: resolveUserId(userId),
              tags: ["vibedeckx", "task-suggest"],
              projectId: req.params.projectId,
            },
          },
        });
        title = text.trim();
      } catch {
        title = description.length > 50 ? description.slice(0, 50) + "..." : description;
      }
    }

    const id = randomUUID();
    const insert = () => fastify.storage.tasks.create({
      id,
      project_id: req.params.projectId,
      title: title!,
      description,
      status: status as 'todo' | 'in_progress' | 'done' | 'cancelled' | undefined,
      priority: priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
      assigned_branch,
      source,
      parent_id,
    });

    // Same shape as the schedule proposal create: the source session must be
    // held out of retention before the task counts as created, so insert +
    // hold sync (+ rollback of a row THIS request inserted) share the
    // session's slot. A different id back is a replayed confirmation — 200,
    // first confirmation's fields win.
    let task: Task;
    if (source) {
      const sourceSessionId = source.session_id;
      try {
        task = await fastify.retentionHolds.exclusive(sourceSessionId, async (syncNow) => {
          const row = await insert();
          try {
            await syncNow();
            return row;
          } catch (error) {
            if (row.id === id) {
              await fastify.storage.tasks.delete(row.id);
              await syncNow().catch(() => undefined);
            }
            throw error;
          }
        });
      } catch (error) {
        return reply.code(502).send({ error: holdFailed(error) });
      }
    } else {
      task = await insert();
    }

    const created = task.id === id;
    if (created) {
      fastify.eventBus.emit({ type: "task:created", projectId: req.params.projectId, task: { ...task } });
    }
    return reply.code(created ? 201 : 200).send({ task });
  });

  // Update task
  fastify.put<{
    Params: { id: string };
    Body: { title?: string; description?: string | null; status?: string; priority?: string; assigned_branch?: string | null; position?: number; parent_id?: string | null };
  }>("/api/tasks/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = await fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const project = await fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const patch = {
      title: req.body.title,
      description: req.body.description,
      status: req.body.status as 'todo' | 'in_progress' | 'done' | 'cancelled' | undefined,
      priority: req.body.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
      assigned_branch: req.body.assigned_branch,
      position: req.body.position,
      parent_id: req.body.parent_id,
    };
    if (patch.parent_id !== undefined) {
      const invalidParent = await parentError(existing.project_id, existing.id, patch.parent_id);
      if (invalidParent) return reply.code(400).send({ error: invalidParent });
    }
    let task: Task | undefined;
    try {
      task = await applyHoldingChange(
        req.params.id,
        () => fastify.storage.tasks.update(req.params.id, patch),
        revertTaskPatch(fastify.storage, req.params.id, patch),
      );
    } catch (error) {
      return reply.code(502).send({ error: holdFailed(error) });
    }
    // Also re-derives a proposed task's retention hold (shared-services listener).
    if (task) fastify.eventBus.emit({ type: "task:updated", projectId: existing.project_id, task: { ...task } });
    return reply.code(200).send({ task });
  });

  // Delete task
  fastify.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = await fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const project = await fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Task not found" });
    }

    await fastify.storage.tasks.delete(req.params.id);
    fastify.eventBus.emit({ type: "task:deleted", projectId: existing.project_id, taskId: req.params.id });
    // Never blocks the delete; a failed remote release is retried by releaseStale.
    if (existing.source_session_id) {
      await fastify.retentionHolds.sync(existing.source_session_id).catch((error) => {
        console.warn(`[RetentionHolds] release for ${existing.source_session_id} deferred:`, error);
      });
    }
    return reply.code(200).send({ success: true });
  });

  // Archive task
  fastify.post<{ Params: { id: string } }>("/api/tasks/:id/archive", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = await fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const project = await fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const task = await fastify.storage.tasks.archive(req.params.id);
    if (task) fastify.eventBus.emit({ type: "task:updated", projectId: existing.project_id, task: { ...task } });
    return reply.code(200).send({ task });
  });

  // Unarchive task
  fastify.post<{ Params: { id: string } }>("/api/tasks/:id/unarchive", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = await fastify.storage.tasks.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const project = await fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Task not found" });
    }

    let task: Task | undefined;
    try {
      task = await applyHoldingChange(
        req.params.id,
        () => fastify.storage.tasks.unarchive(req.params.id),
        () => fastify.storage.tasks.archive(req.params.id),
      );
    } catch (error) {
      return reply.code(502).send({ error: holdFailed(error) });
    }
    if (task) fastify.eventBus.emit({ type: "task:updated", projectId: existing.project_id, task: { ...task } });
    return reply.code(200).send({ task });
  });

  // Reorder tasks
  fastify.put<{
    Params: { projectId: string };
    Body: { orderedIds: string[] };
  }>("/api/projects/:projectId/tasks/reorder", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = await fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return reply.code(400).send({ error: "orderedIds must be an array" });
    }

    const existingTasks = await fastify.storage.tasks.getByProjectId(req.params.projectId);
    const existingIds = new Set(existingTasks.map(t => t.id));
    for (const id of orderedIds) {
      if (!existingIds.has(id)) {
        return reply.code(400).send({ error: `Task ${id} not found in project` });
      }
    }

    await fastify.storage.tasks.reorder(req.params.projectId, orderedIds);
    return reply.code(200).send({ success: true });
  });
};

export default fp(routes, { name: "task-routes" });
