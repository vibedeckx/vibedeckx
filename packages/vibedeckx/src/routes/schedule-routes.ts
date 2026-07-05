import type { FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import path from "path";
import type { ScheduledTask, ScheduledTaskRunType, ScheduledTaskCwdMode } from "../storage/types.js";
import { requireAuth } from "../server.js";
import { validateCron } from "../scheduler.js";
import "../server-types.js";

const RUN_TYPES: ScheduledTaskRunType[] = ["command", "prompt"];
const CWD_MODES: ScheduledTaskCwdMode[] = ["branch", "directory"];

interface ScheduleBody {
  name?: string;
  cron_expr?: string;
  timezone?: string;
  enabled?: boolean;
  run_type?: string;
  content?: string;
  cwd_mode?: string;
  branch?: string | null;
  directory?: string | null;
  timeout_seconds?: number;
  target?: string;
}

/** Cross-field validation shared by create and update. Returns an error string or null. */
function validateResolved(b: { cron_expr: string; timezone: string; run_type: string; content: string; cwd_mode: string; directory: string | null; timeout_seconds: number }): string | null {
  if (!RUN_TYPES.includes(b.run_type as ScheduledTaskRunType)) return `run_type must be one of: ${RUN_TYPES.join(", ")}`;
  if (!CWD_MODES.includes(b.cwd_mode as ScheduledTaskCwdMode)) return `cwd_mode must be one of: ${CWD_MODES.join(", ")}`;
  if (!b.content.trim()) return "content is required";
  if (b.cwd_mode === "directory" && !b.directory?.trim()) return "directory is required when cwd_mode is 'directory'";
  if (b.cwd_mode === "directory" && b.directory?.trim() && !path.isAbsolute(b.directory)) return "directory must be an absolute path";
  if (!Number.isInteger(b.timeout_seconds) || b.timeout_seconds <= 0) return "timeout_seconds must be a positive integer";
  const cronError = validateCron(b.cron_expr, b.timezone);
  if (cronError) return `Invalid cron expression: ${cronError}`;
  return null;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Resolve a schedule by id and enforce project ownership (same idiom as
  // command-routes PUT/DELETE: child fetched unscoped, parent project scoped
  // by userId). Sends the 404 itself and returns null when not accessible.
  const getAuthorizedSchedule = async (id: string, userId: string | undefined, reply: FastifyReply): Promise<ScheduledTask | null> => {
    const schedule = await fastify.storage.scheduledTasks.getById(id);
    if (!schedule) {
      reply.code(404).send({ error: "Schedule not found" });
      return null;
    }
    const project = await fastify.storage.projects.getById(schedule.project_id, userId);
    if (!project) {
      reply.code(404).send({ error: "Schedule not found" });
      return null;
    }
    return schedule;
  };

  fastify.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/schedules",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = await fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) return reply.code(404).send({ error: "Project not found" });

      const schedules = await fastify.storage.scheduledTasks.getByProjectId(req.params.projectId);
      const lastRuns = await fastify.storage.scheduledTaskRuns.getLastByScheduleIds(schedules.map((s) => s.id));
      return reply.code(200).send({
        schedules: schedules.map((s) => ({
          ...s,
          last_run: lastRuns[s.id] ?? null,
          next_run_at: fastify.scheduler.nextRunAt(s.id),
          running: fastify.scheduler.isRunning(s.id),
        })),
      });
    }
  );

  fastify.post<{ Params: { projectId: string }; Body: ScheduleBody }>(
    "/api/projects/:projectId/schedules",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const project = await fastify.storage.projects.getById(req.params.projectId, userId);
      if (!project) return reply.code(404).send({ error: "Project not found" });

      const b = req.body ?? {};
      if (!b.name?.trim()) return reply.code(400).send({ error: "name is required" });
      if (!b.cron_expr?.trim()) return reply.code(400).send({ error: "cron_expr is required" });
      const resolved = {
        cron_expr: b.cron_expr.trim(),
        timezone: b.timezone?.trim() || "UTC",
        run_type: b.run_type ?? "command",
        content: b.content ?? "",
        cwd_mode: b.cwd_mode ?? "branch",
        directory: b.directory ?? null,
        timeout_seconds: b.timeout_seconds ?? 1800,
      };
      const error = validateResolved(resolved);
      if (error) return reply.code(400).send({ error });

      const target = b.target ?? "local";
      if (target !== "local" && !(await fastify.storage.projectRemotes.getByProjectAndServer(req.params.projectId, target))) {
        return reply.code(400).send({ error: "Unknown remote target" });
      }

      const schedule = await fastify.storage.scheduledTasks.create({
        id: randomUUID(),
        project_id: req.params.projectId,
        name: b.name.trim(),
        cron_expr: resolved.cron_expr,
        timezone: resolved.timezone,
        run_type: resolved.run_type as ScheduledTaskRunType,
        content: resolved.content,
        cwd_mode: resolved.cwd_mode as ScheduledTaskCwdMode,
        branch: b.branch ?? null,
        directory: resolved.directory,
        timeout_seconds: resolved.timeout_seconds,
        enabled: b.enabled ?? true,
        target,
      });
      await fastify.scheduler.reschedule(schedule.id);
      return reply.code(201).send({ schedule });
    }
  );

  fastify.put<{ Params: { id: string }; Body: ScheduleBody }>(
    "/api/schedules/:id",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = await getAuthorizedSchedule(req.params.id, userId ?? undefined, reply);
      if (!existing) return;

      const b = req.body ?? {};
      // Timezone: if provided, coerce blank/whitespace-only to the existing
      // value — mirroring POST's fallback to "UTC" on create — so a blank
      // string can't slip past validateCron's `if (timezone)` skip and get
      // persisted, later breaking croner's Cron() constructor at schedule time.
      // undefined (field omitted) stays undefined so update() leaves the
      // column untouched, same as every other optional field here.
      const resolvedTimezone = b.timezone !== undefined ? (b.timezone.trim() || existing.timezone) : undefined;
      // Validate the merged (existing + patch) shape so partial updates can't
      // produce an invalid combination (e.g. cwd_mode=directory without directory).
      const merged = {
        cron_expr: b.cron_expr?.trim() ?? existing.cron_expr,
        timezone: resolvedTimezone ?? existing.timezone,
        run_type: b.run_type ?? existing.run_type,
        content: b.content ?? existing.content,
        cwd_mode: b.cwd_mode ?? existing.cwd_mode,
        directory: b.directory !== undefined ? b.directory : existing.directory,
        timeout_seconds: b.timeout_seconds ?? existing.timeout_seconds,
      };
      if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: "name must not be empty" });
      const error = validateResolved(merged);
      if (error) return reply.code(400).send({ error });

      const nextTarget = b.target !== undefined ? b.target : existing.target;
      if (nextTarget !== "local" && !(await fastify.storage.projectRemotes.getByProjectAndServer(existing.project_id, nextTarget))) {
        return reply.code(400).send({ error: "Unknown remote target" });
      }

      const schedule = await fastify.storage.scheduledTasks.update(req.params.id, {
        name: b.name?.trim(),
        cron_expr: b.cron_expr?.trim(),
        timezone: resolvedTimezone,
        enabled: b.enabled,
        run_type: b.run_type as ScheduledTaskRunType | undefined,
        content: b.content,
        cwd_mode: b.cwd_mode as ScheduledTaskCwdMode | undefined,
        branch: b.branch,
        directory: b.directory,
        timeout_seconds: b.timeout_seconds,
        target: b.target,
      });
      await fastify.scheduler.reschedule(req.params.id);
      return reply.code(200).send({ schedule });
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/schedules/:id",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = await getAuthorizedSchedule(req.params.id, userId ?? undefined, reply);
      if (!existing) return;

      fastify.scheduler.unschedule(req.params.id);
      await fastify.storage.scheduledTasks.delete(req.params.id);
      return reply.code(204).send();
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/schedules/:id/run",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = await getAuthorizedSchedule(req.params.id, userId ?? undefined, reply);
      if (!existing) return;

      const result = await fastify.scheduler.runNow(req.params.id);
      if ("error" in result) return reply.code(400).send({ error: result.error });
      if (result.skipped) return reply.code(409).send({ error: "A run is already in progress" });
      return reply.code(200).send({ runId: result.runId });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    "/api/schedules/:id/runs",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = await getAuthorizedSchedule(req.params.id, userId ?? undefined, reply);
      if (!existing) return;

      return reply.code(200).send({ runs: await fastify.storage.scheduledTaskRuns.getByScheduleId(req.params.id) });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    "/api/schedule-runs/:id",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const run = await fastify.storage.scheduledTaskRuns.getById(req.params.id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      // Ownership: run -> schedule -> project (scoped by userId)
      const schedule = await getAuthorizedSchedule(run.schedule_id, userId ?? undefined, reply);
      if (!schedule) return;

      return reply.code(200).send({ run });
    }
  );
};

export default fp(routes, { name: "schedule-routes" });
