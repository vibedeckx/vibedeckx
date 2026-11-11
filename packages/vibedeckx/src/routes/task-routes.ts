import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import { generateText } from "ai";
import { resolveFastChatModel } from "../utils/chat-model.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import { isProjectSourceSession, resolveSourceSessions, validSourceId } from "./source-sessions.js";
import type { Task, TaskRevertField, TaskSource } from "../storage/types.js";
import { applyTaskChange, applyTaskChanges, revertTaskPatch } from "../retention-holds.js";
import "../server-types.js";

/** Far above PROPOSE_TASK_MAX_ITEMS; only bounds what a caller can claim. */
const SOURCE_ITEM_INDEX_MAX = 100;

interface SourceBody { session_id?: unknown; tool_use_id?: unknown; item_index?: unknown }

/** Most tasks one batch create may file; above PROPOSE_TASK_MAX_ITEMS. */
const BATCH_CREATE_MAX = 20;

/** Most tasks one batch update may change; above the propose_task_update item limit. */
const BATCH_UPDATE_MAX = 20;

const TASK_STATUSES: readonly string[] = ["todo", "in_progress", "done", "cancelled"];
const TASK_PRIORITIES: readonly string[] = ["low", "medium", "high", "urgent"];

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

  type CreateBody = {
    title?: string; description: string; status?: string; priority?: string; assigned_branch?: string | null;
    parent_id?: string | null;
    /** Provenance of an agent proposal (propose_task); makes create idempotent. */
    source?: SourceBody | null;
  };
  type CreateOpts = Parameters<typeof fastify.storage.tasks.create>[0];

  /** Validated insert options for one create body (title still possibly empty), or why it's rejected. */
  const readCreateBody = async (
    projectId: string,
    body: CreateBody,
  ): Promise<{ error: string } | { opts: Omit<CreateOpts, "title">; title: string | undefined }> => {
    const { title, description, status, priority } = body ?? {};
    let assigned_branch = body?.assigned_branch;
    if (!description) return { error: "description is required" };
    const parent_id = body.parent_id ?? null;
    const invalidParent = await parentError(projectId, null, parent_id);
    if (invalidParent) return { error: invalidParent };

    let source: TaskSource | null = null;
    if (body.source) {
      const { session_id, tool_use_id, item_index } = body.source;
      if (!validSourceId(session_id) || !validSourceId(tool_use_id)
        || typeof item_index !== "number" || !Number.isInteger(item_index)
        || item_index < 0 || item_index > SOURCE_ITEM_INDEX_MAX) {
        return { error: "Invalid source" };
      }
      if (!(await isProjectSourceSession(fastify.storage, session_id, projectId))) {
        return { error: "Invalid source" };
      }
      source = { session_id, tool_use_id, item_index };
      // Never pre-assigned: turn-end auto-complete closes the first task
      // assigned to a branch, so a follow-up assigned to its source session's
      // branch would be marked done by that session's very next turn. The
      // user assigns a branch when they actually start on it.
      assigned_branch = null;
    }
    return {
      title,
      opts: {
        id: randomUUID(),
        project_id: projectId,
        description,
        status: status as 'todo' | 'in_progress' | 'done' | 'cancelled' | undefined,
        priority: priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
        assigned_branch,
        source,
        parent_id,
      },
    };
  };

  const generateTitle = async (userId: string, projectId: string, description: string): Promise<string> => {
    try {
      const { text } = await generateText({
        model: await resolveFastChatModel(fastify.storage, resolveUserId(userId), "task-suggest"),
        prompt: `Generate a concise task title (under 10 words) that captures the essence of this task description. Write the title in the same language as the description. Return only the title text, nothing else.\n\nDescription: ${description}`,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "task-suggest",
          metadata: {
            userId: resolveUserId(userId),
            tags: ["vibedeckx", "task-suggest"],
            projectId,
          },
        },
      });
      return text.trim();
    } catch {
      return description.length > 50 ? description.slice(0, 50) + "..." : description;
    }
  };

  /**
   * Same shape as the schedule proposal create: the source session must be
   * held out of retention before its tasks count as created, so insert + hold
   * sync (+ rollback of rows THIS request inserted) share the session's slot.
   * A row with a different id than asked for is a replayed confirmation — the
   * first confirmation's fields win.
   */
  const insertHeld = async (
    sourceSessionId: string | null,
    ids: string[],
    insert: () => Promise<Task[]>,
  ): Promise<Task[]> => {
    if (!sourceSessionId) return insert();
    return fastify.retentionHolds.exclusive(sourceSessionId, async (syncNow) => {
      const rows = await insert();
      try {
        await syncNow();
        return rows;
      } catch (error) {
        const inserted = rows.filter((row, i) => row.id === ids[i]);
        for (const row of inserted) await fastify.storage.tasks.delete(row.id);
        if (inserted.length > 0) await syncNow().catch(() => undefined);
        throw error;
      }
    });
  };

  // Create task
  fastify.post<{ Params: { projectId: string }; Body: CreateBody }>("/api/projects/:projectId/tasks", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const project = await fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const read = await readCreateBody(req.params.projectId, req.body);
    if ("error" in read) return reply.code(400).send({ error: read.error });
    const { opts } = read;
    const title = read.title || await generateTitle(userId, req.params.projectId, opts.description!);

    let task: Task;
    try {
      [task] = await insertHeld(opts.source?.session_id ?? null, [opts.id], async () =>
        [await fastify.storage.tasks.create({ ...opts, title })]);
    } catch (error) {
      return reply.code(502).send({ error: holdFailed(error) });
    }

    const created = task.id === opts.id;
    if (created) {
      fastify.eventBus.emit({ type: "task:created", projectId: req.params.projectId, task: { ...task } });
    }
    return reply.code(created ? 201 : 200).send({ task });
  });

  // Create several tasks at once — "Create all" on a propose_task card. All
  // or nothing, filed in list order; per item the same rules as a single
  // create, including idempotency on `source`.
  fastify.post<{ Params: { projectId: string }; Body: { tasks?: unknown } }>(
    "/api/projects/:projectId/tasks/batch",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = await fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const bodies = req.body?.tasks;
      if (!Array.isArray(bodies) || bodies.length === 0 || bodies.length > BATCH_CREATE_MAX) {
        return reply.code(400).send({ error: `tasks must list 1 to ${BATCH_CREATE_MAX} tasks` });
      }
      const reads = [];
      for (const [i, body] of bodies.entries()) {
        const read = await readCreateBody(req.params.projectId, body as CreateBody);
        if ("error" in read) return reply.code(400).send({ error: `Task ${i + 1}: ${read.error}` });
        reads.push(read);
      }
      // One retention slot per request: a card's items share their session.
      const sessions = new Set(reads.flatMap((r) => (r.opts.source ? [r.opts.source.session_id] : [])));
      if (sessions.size > 1) {
        return reply.code(400).send({ error: "All tasks in a batch must come from the same source session" });
      }

      const items = await Promise.all(reads.map(async (r) => ({
        ...r.opts,
        title: r.title || await generateTitle(userId, req.params.projectId, r.opts.description!),
      })));
      const ids = items.map((item) => item.id);
      let tasks: Task[];
      try {
        tasks = await insertHeld([...sessions][0] ?? null, ids, () => fastify.storage.tasks.createMany(items));
      } catch (error) {
        return reply.code(502).send({ error: holdFailed(error) });
      }

      const created = tasks.filter((task, i) => task.id === ids[i]);
      for (const task of created) {
        fastify.eventBus.emit({ type: "task:created", projectId: req.params.projectId, task: { ...task } });
      }
      return reply.code(created.length > 0 ? 201 : 200).send({ tasks });
    },
  );

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

  // Update several tasks at once — "Apply all" on a propose_task_update card.
  // All or nothing, in one transaction. Parent moves are checked against the
  // tree as it will be once the whole batch lands, so two moves that only
  // form a cycle together are refused too.
  type UpdatePatch = Parameters<typeof fastify.storage.tasks.update>[1];
  fastify.put<{ Params: { projectId: string }; Body: { updates?: unknown } }>(
    "/api/projects/:projectId/tasks/batch",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const { projectId } = req.params;
      const project = await fastify.storage.projects.getById(projectId, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const bodies = req.body?.updates;
      if (!Array.isArray(bodies) || bodies.length === 0 || bodies.length > BATCH_UPDATE_MAX) {
        return reply.code(400).send({ error: `updates must list 1 to ${BATCH_UPDATE_MAX} tasks` });
      }
      const projectTasks = await fastify.storage.tasks.getByProjectId(projectId, { includeArchived: true });
      const byId = new Map(projectTasks.map((t) => [t.id, t]));
      const patches: Array<{ id: string; opts: UpdatePatch }> = [];
      for (const [i, raw] of bodies.entries()) {
        const fail = (error: string) => reply.code(400).send({ error: `Update ${i + 1}: ${error}` });
        const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const { id, title, description, status, priority, assigned_branch, parent_id } = body;
        if (!validSourceId(id) || !byId.has(id)) return fail("Task not found");
        if (patches.some((p) => p.id === id)) return fail("Task listed more than once");
        if (title !== undefined && (typeof title !== "string" || !title.trim())) return fail("Invalid title");
        if (description !== undefined && description !== null && typeof description !== "string") {
          return fail("Invalid description");
        }
        if (status !== undefined && !TASK_STATUSES.includes(status as string)) return fail("Invalid status");
        if (priority !== undefined && !TASK_PRIORITIES.includes(priority as string)) return fail("Invalid priority");
        if (assigned_branch !== undefined && assigned_branch !== null && typeof assigned_branch !== "string") {
          return fail("Invalid assigned_branch");
        }
        if (parent_id !== undefined && parent_id !== null && !validSourceId(parent_id)) return fail("Invalid parent_id");
        patches.push({
          id,
          opts: {
            title: title as string | undefined,
            description: description as string | null | undefined,
            status: status as UpdatePatch["status"],
            priority: priority as UpdatePatch["priority"],
            assigned_branch: assigned_branch as string | null | undefined,
            parent_id: parent_id as string | null | undefined,
          },
        });
      }

      const parentOf = new Map(projectTasks.map((t) => [t.id, t.parent_id]));
      for (const { id, opts } of patches) if (opts.parent_id !== undefined) parentOf.set(id, opts.parent_id);
      for (const [i, { id, opts }] of patches.entries()) {
        if (opts.parent_id === undefined || opts.parent_id === null) continue;
        let current: string | null = opts.parent_id;
        for (let depth = 0; current !== null; depth++) {
          const error = current === id
            ? "A task can't be nested under itself or its own sub-task"
            : depth >= PARENT_DEPTH_MAX ? "Task nesting is too deep"
            : !byId.has(current) ? "Parent task not found"
            : null;
          if (error) return reply.code(400).send({ error: `Update ${i + 1}: ${error}` });
          current = parentOf.get(current) ?? null;
        }
      }

      const ids = patches.map((p) => p.id);
      let tasks: Task[] | undefined;
      try {
        tasks = await applyTaskChanges(
          fastify,
          ids,
          () => fastify.storage.tasks.updateMany(patches),
          // Field by field, and only what still holds this batch's value: an
          // edit or delete that landed during the hold sync is kept.
          (before, after) => fastify.storage.tasks.revertIfUnchanged(patches.map(({ id, opts }, i) => ({
            id,
            fields: (Object.keys(opts) as TaskRevertField[])
              .filter((field) => opts[field] !== undefined)
              .map((field) => ({ field, written: after[i][field], restore: before[i][field] })),
          }))),
        );
      } catch (error) {
        return reply.code(502).send({ error: holdFailed(error) });
      }
      // Deleted between validation and the slots being held: nothing changed.
      if (!tasks) return reply.code(409).send({ error: "A task changed while updating; none were updated" });
      // Also re-derives each proposed task's retention hold (shared-services listener).
      for (const task of tasks) fastify.eventBus.emit({ type: "task:updated", projectId, task: { ...task } });
      return reply.code(200).send({ tasks });
    },
  );

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
