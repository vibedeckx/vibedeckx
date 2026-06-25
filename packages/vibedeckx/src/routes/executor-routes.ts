import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import type { ExecutorType, PromptProvider } from "../storage/types.js";
import { requireAuth } from "../server.js";
import "../server-types.js";

// SQLite's CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" in UTC with no
// timezone marker. JavaScript's Date constructor parses that as *local* wall
// time (V8) or returns Invalid Date (Safari) — either way the UI ends up
// displaying the UTC value as if it were local. Normalize to a proper ISO
// 8601 UTC string so toLocaleString() converts to the user's local timezone.
function normalizeSqlTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  // Already ISO with 'T' separator and tz suffix (Z or +/-HH[:MM]) — pass through.
  if (value.includes('T') && /(Z|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  // SQLite "YYYY-MM-DD HH:MM:SS[.SSS]" → ISO with explicit UTC marker.
  return value.replace(' ', 'T') + 'Z';
}

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

      // Build a per-target "Last run" map for each executor so the UI can show
      // the correct timestamp when the user switches between local/remote tabs
      // (and reconnect to the buffered log of a finished process). Skip the
      // local query entirely for projects with no local path, and the remote
      // query for projects with no configured remotes.
      const executorIds = executors.map((e) => e.id);
      const hasLocal = !!project.path;
      const hasRemotes =
        fastify.storage.projectRemotes.getByProject(req.params.projectId).length > 0;

      const localRows = hasLocal && executorIds.length > 0
        ? fastify.storage.executorProcesses.getLastByExecutorIds(executorIds)
        : [];
      const remoteRows = hasRemotes && executorIds.length > 0
        ? fastify.storage.remoteExecutorProcesses.getLastByExecutorIdsGroupedByServer(executorIds)
        : [];

      const lastRunsByExecutor = new Map<string, Record<string, { started_at: string; process_id: string }>>();
      const ensure = (executorId: string) => {
        let entry = lastRunsByExecutor.get(executorId);
        if (!entry) {
          entry = {};
          lastRunsByExecutor.set(executorId, entry);
        }
        return entry;
      };
      for (const row of localRows) {
        const startedAt = normalizeSqlTimestamp(row.started_at);
        if (!startedAt) continue;
        ensure(row.executor_id).local = { started_at: startedAt, process_id: row.id };
      }
      for (const row of remoteRows) {
        const startedAt = normalizeSqlTimestamp(row.started_at);
        if (!startedAt) continue;
        ensure(row.executor_id)[row.remote_server_id] = {
          started_at: startedAt,
          process_id: row.local_process_id,
        };
      }

      const augmented = executors.map((executor) => ({
        ...executor,
        last_runs: lastRunsByExecutor.get(executor.id) ?? {},
      }));
      return reply.code(200).send({ executors: augmented });
    }
  );

  // Create Executor
  fastify.post<{
    Params: { projectId: string };
    Body: { name: string; command: string; executor_type?: string; prompt_provider?: string; cwd?: string; pty?: boolean; disabled?: boolean; group_id: string };
  }>("/api/projects/:projectId/executors", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.projectId, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { name, command, executor_type, prompt_provider, cwd, pty, disabled, group_id } = req.body;
    if (!group_id) {
      return reply.code(400).send({ error: "group_id is required" });
    }

    const parsedType = (executor_type === 'prompt' ? 'prompt' : 'command') as ExecutorType;
    const parsedProvider = (prompt_provider === 'codex' ? 'codex' : 'claude') as PromptProvider;

    const id = randomUUID();
    const executor = fastify.storage.executors.create({
      id,
      project_id: req.params.projectId,
      group_id,
      name,
      command,
      executor_type: parsedType,
      prompt_provider: parsedType === 'prompt' ? parsedProvider : null,
      cwd,
      pty,
      disabled,
    });

    return reply.code(201).send({ executor });
  });

  // 更新 Executor
  fastify.put<{
    Params: { id: string };
    Body: { name?: string; command?: string; executor_type?: string; prompt_provider?: string; cwd?: string | null; pty?: boolean; disabled?: boolean };
  }>("/api/executors/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const existing = fastify.storage.executors.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Executor not found" });
    }
    // Confirm the caller owns the executor's project — otherwise one tenant
    // could rewrite another tenant's executor command by id.
    const project = fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { executor_type, prompt_provider, ...rest } = req.body;
    const parsedType = executor_type !== undefined
      ? (executor_type === 'prompt' ? 'prompt' : 'command') as ExecutorType
      : undefined;
    const parsedProvider = prompt_provider !== undefined
      ? (prompt_provider === 'codex' ? 'codex' : 'claude') as PromptProvider
      : undefined;
    const updateOpts = {
      ...rest,
      ...(parsedType !== undefined ? { executor_type: parsedType } : {}),
      ...(parsedProvider !== undefined ? { prompt_provider: parsedProvider } : {}),
    };
    const executor = fastify.storage.executors.update(req.params.id, updateOpts);
    return reply.code(200).send({ executor });
  });

  // 删除 Executor
  fastify.delete<{ Params: { id: string } }>("/api/executors/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const existing = fastify.storage.executors.getById(req.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "Executor not found" });
    }
    // Confirm the caller owns the executor's project before deleting it.
    const project = fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
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
