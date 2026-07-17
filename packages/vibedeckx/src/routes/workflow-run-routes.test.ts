import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import workflowRunRoutes from "./workflow-run-routes.js";
import { WorkflowError } from "../workflow-engine.js";

const project = { id: "p1", name: "p", path: "/tmp/p" };
const run = { id: "r1", project_id: "p1", branch: "dev", status: "waiting_feedback" };

let app: FastifyInstance;

function makeApp(overrides: { engine?: Record<string, unknown>; runs?: Record<string, unknown> } = {}) {
  app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    projects: { getById: async (id: string) => (id === "p1" ? project : undefined) },
    workflowRuns: {
      getActive: async () => [run],
      getById: async (id: string) => (id === "r1" ? run : undefined),
      ...(overrides.runs ?? {}),
    },
  } as never);
  app.decorate("workflowEngine", {
    startAdhocReview: vi.fn(async () => run),
    approveFeedback: vi.fn(async () => ({ ...run, status: "completed" })),
    cancelRun: vi.fn(async () => ({ ...run, status: "cancelled" })),
    ...(overrides.engine ?? {}),
  } as never);
  return app;
}

afterEach(async () => { if (app) await app.close(); });

describe("workflow-run-routes", () => {
  it("POST creates an ad-hoc run", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", branch: "dev", sourceSessionId: "s-src", reviewFocus: "tests" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().run.id).toBe("r1");
  });

  it("POST rejects remote sessions and unknown projects", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const remote = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "p1", sourceSessionId: "remote-x" } });
    expect(remote.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "nope", sourceSessionId: "s" } });
    expect(missing.statusCode).toBe(404);
  });

  it("POST maps WorkflowError codes to HTTP", async () => {
    const app = makeApp({
      engine: { startAdhocReview: vi.fn(async () => { throw new WorkflowError("session-busy", "busy"); }) },
    });
    await app.register(workflowRunRoutes);
    const res = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "p1", sourceSessionId: "s" } });
    expect(res.statusCode).toBe(409);
  });

  it("GET lists active runs for a workspace", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const res = await app.inject({ method: "GET", url: "/api/workflow-runs?projectId=p1&branch=dev" });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toHaveLength(1);
  });

  it("gate approve calls engine and returns the run", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs/r1/gate",
      payload: { action: "approve", editedPayload: "edited" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.status).toBe("completed");
  });

  it("gate maps bad-state to 409", async () => {
    const app = makeApp({
      engine: { approveFeedback: vi.fn(async () => { throw new WorkflowError("bad-state", "no"); }) },
    });
    await app.register(workflowRunRoutes);
    const res = await app.inject({ method: "POST", url: "/api/workflow-runs/r1/gate", payload: { action: "approve" } });
    expect(res.statusCode).toBe(409);
  });
});
