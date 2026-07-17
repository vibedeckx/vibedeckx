import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import { WorkflowError } from "../workflow-engine.js";

function errStatus(err: unknown): number | null {
  if (!(err instanceof WorkflowError)) return null;
  switch (err.code) {
    case "session-busy": return 409;
    case "bad-state": return 409;
    case "no-completed-turn": return 400;
    case "send-failed": return 502;
    case "spawn-failed": return 500;
    default: return 500;
  }
}

async function routes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { projectId: string; branch?: string | null; sourceSessionId: string; reviewFocus?: string; sourceTurnEndIndex?: number };
  }>("/api/workflow-runs", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const { projectId, branch, sourceSessionId, reviewFocus, sourceTurnEndIndex } = req.body ?? {};
    if (!projectId || !sourceSessionId) return reply.code(400).send({ error: "projectId and sourceSessionId are required" });
    if (sourceSessionId.startsWith("remote-")) return reply.code(400).send({ error: "Remote sessions are not supported in ad-hoc review yet" });
    const project = await fastify.storage.projects.getById(projectId, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (!project.path) return reply.code(400).send({ error: "Project has no local path (remote-only projects are not supported yet)" });
    try {
      const run = await fastify.workflowEngine.startAdhocReview({
        project: { id: project.id, path: project.path },
        branch: branch ?? null,
        sourceSessionId,
        reviewFocus,
        sourceTurnEndIndex,
      });
      return reply.code(201).send({ run });
    } catch (err) {
      const status = errStatus(err);
      if (status) return reply.code(status).send({ error: (err as Error).message });
      throw err;
    }
  });

  fastify.get<{ Querystring: { projectId: string; branch?: string } }>(
    "/api/workflow-runs", async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const { projectId, branch } = req.query;
      if (!projectId) return reply.code(400).send({ error: "projectId is required" });
      const project = await fastify.storage.projects.getById(projectId, userId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const runs = await fastify.storage.workflowRuns.getActive(projectId, branch ?? null);
      return reply.send({ runs });
    });

  fastify.get<{ Params: { id: string } }>("/api/workflow-runs/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const run = await fastify.storage.workflowRuns.getById(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const project = await fastify.storage.projects.getById(run.project_id, userId);
    if (!project) return reply.code(404).send({ error: "Run not found" });
    return reply.send({ run });
  });

  fastify.post<{ Params: { id: string }; Body: { action: "approve" | "cancel"; editedPayload?: string } }>(
    "/api/workflow-runs/:id/gate", async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;
      const existing = await fastify.storage.workflowRuns.getById(req.params.id);
      if (!existing) return reply.code(404).send({ error: "Run not found" });
      const project = await fastify.storage.projects.getById(existing.project_id, userId);
      if (!project) return reply.code(404).send({ error: "Run not found" });
      const { action, editedPayload } = req.body ?? {};
      try {
        if (action === "approve") {
          const run = await fastify.workflowEngine.approveFeedback(req.params.id, editedPayload);
          return reply.send({ run });
        }
        if (action === "cancel") {
          const run = await fastify.workflowEngine.cancelRun(req.params.id);
          return reply.send({ run });
        }
        return reply.code(400).send({ error: "action must be approve or cancel" });
      } catch (err) {
        const status = errStatus(err);
        if (status) return reply.code(status).send({ error: (err as Error).message });
        throw err;
      }
    });

  fastify.post<{ Params: { id: string } }>("/api/workflow-runs/:id/cancel", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    const existing = await fastify.storage.workflowRuns.getById(req.params.id);
    if (!existing) return reply.code(404).send({ error: "Run not found" });
    const project = await fastify.storage.projects.getById(existing.project_id, userId);
    if (!project) return reply.code(404).send({ error: "Run not found" });
    const run = await fastify.workflowEngine.cancelRun(req.params.id);
    return reply.send({ run });
  });
}

export default fp(routes, { name: "workflow-run-routes" });
