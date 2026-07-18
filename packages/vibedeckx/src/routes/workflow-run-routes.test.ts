import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import workflowRunRoutes from "./workflow-run-routes.js";
import { WorkflowError } from "../workflow-engine.js";

const project = { id: "p1", name: "p", path: "/tmp/p" };
const run = { id: "r1", project_id: "p1", branch: "dev", status: "waiting_feedback" };

let app: FastifyInstance;

function makeApp(overrides: { engine?: Record<string, unknown>; runs?: Record<string, unknown>; sessions?: Record<string, unknown> } = {}) {
  app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    projects: {
      getById: async (id: string) => (id === "p1" ? project : undefined),
      getByPath: async (p: string) => (p === "/tmp/p" ? project : undefined),
    },
    agentSessions: {
      getById: async (id: string) =>
        id === "s-src" || id === "s" || id === "s-rev"
          ? { id, project_id: "p1", branch: "dev" }
          : undefined,
      ...(overrides.sessions ?? {}),
    },
    workflowRuns: {
      getActive: async () => [run],
      getById: async (id: string) => (id === "r1" ? run : undefined),
      ...(overrides.runs ?? {}),
    },
  } as never);
  app.decorate("workflowEngine", {
    startAdhocReview: vi.fn(async () => run),
    getReviewerCandidate: vi.fn(async () => ({
      available: true,
      sessionId: "s-rev",
      title: "Review - Task",
      agentType: "codex",
      reason: null,
    })),
    approveFeedback: vi.fn(async () => ({ ...run, status: "completed" })),
    cancelRun: vi.fn(async () => ({ ...run, status: "cancelled" })),
    ...(overrides.engine ?? {}),
  } as never);
  // Remote-id branches (workflow-run-remote-routes.test.ts covers proxying
  // itself) — an empty map means every "remote-" id here is an unmapped
  // session/run, exercised by the "unknown project" test below.
  app.decorate("remoteSessionMap", new Map() as never);
  app.decorate("reverseConnectManager", null as never);
  app.decorate("eventBus", { emit: vi.fn() } as never);
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

  it("POST forwards an existing reviewer selection", async () => {
    const startAdhocReview = vi.fn(async () => run);
    const app = makeApp({ engine: { startAdhocReview } });
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: "s-src", reviewerSessionId: "s-rev" },
    });
    expect(res.statusCode).toBe(201);
    expect(startAdhocReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerSessionId: "s-rev" }),
    );
  });

  it("POST rejects competing or blank reviewer selection fields", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const both = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: {
        projectId: "p1", sourceSessionId: "s-src",
        reviewerSessionId: "s-rev", reviewerAgentType: "codex",
      },
    });
    expect(both.statusCode).toBe(400);
    const blank = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: "s-src", reviewerSessionId: "  " },
    });
    expect(blank.statusCode).toBe(400);
  });

  it("GET returns the latest reviewer candidate for an authorized source", async () => {
    const getReviewerCandidate = vi.fn(async () => ({
      available: true, sessionId: "s-rev", title: "Review - Task", agentType: "codex", reason: null,
    }));
    const app = makeApp({ engine: { getReviewerCandidate } });
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "GET",
      url: "/api/workflow-runs/reviewer-candidate?projectId=p1&sourceSessionId=s-src",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().candidate.sessionId).toBe("s-rev");
    expect(getReviewerCandidate).toHaveBeenCalledWith("s-src");
  });

  it("POST 404s an unmapped remote session id and an unknown project", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    // Remote proxying itself is covered by workflow-run-remote-routes.test.ts;
    // here remoteSessionMap is empty, so this "remote-" id is simply unmapped.
    const remote = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "p1", sourceSessionId: "remote-x" } });
    expect(remote.statusCode).toBe(404);
    const missing = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "nope", sourceSessionId: "s" } });
    expect(missing.statusCode).toBe(404);
  });

  it("POST rejects a sourceSessionId belonging to another project", async () => {
    const app = makeApp({
      sessions: { getById: async (id: string) => (id === "s-other" ? { id, project_id: "p2" } : undefined) },
    });
    await app.register(workflowRunRoutes);
    const wrongProject = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: "s-other" },
    });
    expect(wrongProject.statusCode).toBe(404);
    const missingSession = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: "s-does-not-exist" },
    });
    expect(missingSession.statusCode).toBe(404);
  });

  it("POST maps WorkflowError codes to HTTP", async () => {
    const app = makeApp({
      engine: { startAdhocReview: vi.fn(async () => { throw new WorkflowError("session-busy", "busy"); }) },
    });
    await app.register(workflowRunRoutes);
    const res = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "p1", sourceSessionId: "s" } });
    expect(res.statusCode).toBe(409);
  });

  it("POST maps source-running to 409", async () => {
    const app = makeApp({
      engine: { startAdhocReview: vi.fn(async () => { throw new WorkflowError("source-running", "still running"); }) },
    });
    await app.register(workflowRunRoutes);
    const res = await app.inject({ method: "POST", url: "/api/workflow-runs", payload: { projectId: "p1", sourceSessionId: "s" } });
    expect(res.statusCode).toBe(409);
  });

  it("POST rejects when the body branch does not match the source session's branch", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", branch: "not-dev", sourceSessionId: "s-src" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/branch/i);
  });

  it("POST derives the run branch from the source session, ignoring an absent body branch", async () => {
    const startAdhocReview = vi.fn(async () => run);
    const app = makeApp({ engine: { startAdhocReview } });
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: "s-src" }, // branch omitted entirely
    });
    expect(res.statusCode).toBe(201);
    expect(startAdhocReview).toHaveBeenCalledWith(expect.objectContaining({ branch: "dev" }));
  });

  it("POST normalizes the session's empty-string (main workspace) branch to null and accepts a matching null body branch", async () => {
    const startAdhocReview = vi.fn(async () => run);
    const app = makeApp({
      engine: { startAdhocReview },
      sessions: { getById: async (id: string) => (id === "s-main" ? { id, project_id: "p1", branch: "" } : undefined) },
    });
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", branch: null, sourceSessionId: "s-main" },
    });
    expect(res.statusCode).toBe(201);
    expect(startAdhocReview).toHaveBeenCalledWith(expect.objectContaining({ branch: null }));
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

  it("cancel maps bad-state (run mid-send) to 409 with the error message", async () => {
    const app = makeApp({
      engine: { cancelRun: vi.fn(async () => { throw new WorkflowError("bad-state", "反馈正在发送，无法取消"); }) },
    });
    await app.register(workflowRunRoutes);
    const res = await app.inject({ method: "POST", url: "/api/workflow-runs/r1/cancel" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("反馈正在发送，无法取消");
  });

  it("path POST derives project and branch from the source session", async () => {
    const startMock = vi.fn(async () => run);
    const app = makeApp({ engine: { startAdhocReview: startMock } });
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/path/workflow-runs",
      payload: { sourceSessionId: "s-src", reviewFocus: "tests", sourceTurnEndIndex: 4 },
    });
    expect(res.statusCode).toBe(201);
    expect(startMock.mock.calls[0][0]).toMatchObject({
      project: { id: "p1", path: "/tmp/p" },
      branch: "dev",
      sourceSessionId: "s-src",
      reviewFocus: "tests",
      sourceTurnEndIndex: 4,
    });
  });

  it("path routes support reviewer candidate lookup and reuse", async () => {
    const getReviewerCandidate = vi.fn(async () => ({
      available: true, sessionId: "s-rev", title: null, agentType: "codex", reason: null,
    }));
    const startAdhocReview = vi.fn(async () => run);
    const app = makeApp({ engine: { getReviewerCandidate, startAdhocReview } });
    await app.register(workflowRunRoutes);

    const candidate = await app.inject({
      method: "GET",
      url: "/api/path/workflow-runs/reviewer-candidate?sourceSessionId=s-src",
    });
    expect(candidate.statusCode).toBe(200);
    expect(candidate.json().candidate.sessionId).toBe("s-rev");

    const created = await app.inject({
      method: "POST", url: "/api/path/workflow-runs",
      payload: { sourceSessionId: "s-src", reviewerSessionId: "s-rev" },
    });
    expect(created.statusCode).toBe(201);
    expect(startAdhocReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerSessionId: "s-rev" }),
    );
  });

  it("path POST 404s an unknown source session and maps engine errors", async () => {
    const app = makeApp({
      engine: { startAdhocReview: vi.fn(async () => { throw new WorkflowError("session-busy", "busy"); }) },
    });
    await app.register(workflowRunRoutes);
    const missing = await app.inject({ method: "POST", url: "/api/path/workflow-runs", payload: { sourceSessionId: "nope" } });
    expect(missing.statusCode).toBe(404);
    const busy = await app.inject({ method: "POST", url: "/api/path/workflow-runs", payload: { sourceSessionId: "s-src" } });
    expect(busy.statusCode).toBe(409);
  });

  it("path GET lists active runs for a path-resolved project", async () => {
    const app = makeApp();
    await app.register(workflowRunRoutes);
    const ok = await app.inject({ method: "GET", url: "/api/path/workflow-runs?path=%2Ftmp%2Fp&branch=dev" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().runs).toHaveLength(1);
    const unknown = await app.inject({ method: "GET", url: "/api/path/workflow-runs?path=%2Fnope" });
    expect(unknown.json().runs).toEqual([]);
    const noPath = await app.inject({ method: "GET", url: "/api/path/workflow-runs" });
    expect(noPath.statusCode).toBe(400);
  });
});
