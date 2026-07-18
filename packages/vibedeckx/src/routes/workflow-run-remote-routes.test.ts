import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { proxyMock, ensureStreamMock } = vi.hoisted(() => ({
  proxyMock: vi.fn(),
  ensureStreamMock: vi.fn(),
}));
vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, proxyToRemoteAuto: proxyMock };
});
vi.mock("../remote-agent-sessions.js", () => ({ ensureRemoteAgentStream: ensureStreamMock }));
vi.mock("../utils/review-brief.js", () => ({
  generateIntentBrief: vi.fn(async () => "distilled brief"),
}));

import workflowRunRoutes from "./workflow-run-routes.js";

const SRC = "remote-srv1-p1-src1";
const bareRun = {
  id: "run1", project_id: "wp1", branch: "dev",
  source_session_id: "src1", source_turn_end_index: 4,
  reviewer_session_id: "rev1", review_focus: null, review_target: null,
  feedback_snapshot: null, status: "waiting_reviewer", error: null,
  created_at: "", updated_at: "",
};

let app: FastifyInstance;
afterEach(async () => { if (app) await app.close(); vi.clearAllMocks(); });

function makeApp() {
  const remoteSessionMap = new Map<string, unknown>();
  remoteSessionMap.set(SRC, {
    remoteServerId: "srv1", remoteUrl: "http://r", remoteApiKey: "k",
    remoteSessionId: "src1", branch: "dev",
  });
  const upsert = vi.fn(async () => undefined);
  const markTitleResolvedDb = vi.fn(async () => undefined);
  const markTitleResolvedMem = vi.fn(() => true);
  const emit = vi.fn();
  app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    projects: { getById: async (id: string) => (id === "p1" ? { id: "p1", name: "p", path: null, agent_mode: "srv1" } : undefined) },
    projectRemotes: {
      getByProjectAndServer: async (pid: string, sid: string) =>
        pid === "p1" && sid === "srv1"
          ? { remote_path: "/w/repo", server_url: "http://r", server_api_key: "k", remote_server_id: "srv1" }
          : undefined,
    },
    remoteSessionMappings: { upsert, markTitleResolved: markTitleResolvedDb },
    workflowRuns: { getActive: async () => [], getById: async () => undefined },
    agentSessions: { getById: async () => undefined },
  } as never);
  app.decorate("workflowEngine", {} as never);
  app.decorate("remoteSessionMap", remoteSessionMap as never);
  app.decorate("remotePatchCache", {} as never);
  app.decorate("reverseConnectManager", null);
  app.decorate("eventBus", { emit } as never);
  app.decorate("agentSessionManager", { markTitleResolved: markTitleResolvedMem } as never);
  return { remoteSessionMap, upsert, emit, markTitleResolvedDb, markTitleResolvedMem };
}

describe("workflow-run remote proxying (front server)", () => {
  it("GET reviewer candidate proxies to the worker and hydrates the mapped reviewer handle", async () => {
    const { remoteSessionMap, upsert } = makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { candidate: {
        available: true, sessionId: "rev1", title: "Review - Task", agentType: "codex", reason: null,
      } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/workflow-runs/reviewer-candidate?projectId=p1&sourceSessionId=${SRC}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().candidate.sessionId).toBe("remote-srv1-p1-rev1");
    expect(proxyMock.mock.calls[0][4]).toBe(
      "/api/path/workflow-runs/reviewer-candidate?sourceSessionId=src1",
    );
    expect(remoteSessionMap.get("remote-srv1-p1-rev1")).toMatchObject({
      remoteSessionId: "rev1", branch: "dev",
    });
    expect(upsert).toHaveBeenCalledWith("remote-srv1-p1-rev1", "p1", "srv1", "rev1", "dev");
    expect(ensureStreamMock).not.toHaveBeenCalled();
  });

  it("POST reuse forwards the bare reviewer id and rejects an unmapped reviewer", async () => {
    const { remoteSessionMap } = makeApp();
    remoteSessionMap.set("remote-srv1-p1-rev1", {
      remoteServerId: "srv1", remoteUrl: "http://r", remoteApiKey: "k",
      remoteSessionId: "rev1", branch: "dev",
    });
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const ok = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, reviewerSessionId: "remote-srv1-p1-rev1" },
    });
    expect(ok.statusCode).toBe(201);
    expect(proxyMock.mock.calls[0][5]).toMatchObject({
      sourceSessionId: "src1", reviewerSessionId: "rev1",
    });

    const missing = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, reviewerSessionId: "remote-srv1-p1-missing" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("POST forwards a client pre-generated intentBrief without pulling history", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, intentBrief: "client brief" },
    });
    expect(res.statusCode).toBe(201);
    expect(proxyMock).toHaveBeenCalledTimes(1); // no history pull, straight to the worker
    const [, , , method, apiPath, body] = proxyMock.mock.calls[0];
    expect([method, apiPath]).toEqual(["POST", "/api/path/workflow-runs"]);
    expect(body).toMatchObject({ sourceSessionId: "src1", intentBrief: "client brief" });
  });

  it("POST /intent-brief pulls remote history over the session proxy and returns the brief", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { messages: [] } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs/intent-brief",
      payload: { projectId: "p1", sourceSessionId: SRC },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().brief).toBe("distilled brief");
    expect(proxyMock.mock.calls[0][3]).toBe("GET");
    expect(proxyMock.mock.calls[0][4]).toBe("/api/agent-sessions/src1");
  });

  it("POST proxies to the worker path mirror, maps ids, registers the reviewer stream", async () => {
    const { remoteSessionMap, upsert, emit, markTitleResolvedDb, markTitleResolvedMem } = makeApp();
    await app.register(workflowRunRoutes);
    // Fresh review → the front first pulls the source history (intent brief
    // input) over the session proxy, then POSTs to the worker mirror.
    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { session: { id: "src1" }, messages: [] } });
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, reviewFocus: "tests", sourceTurnEndIndex: 4, reviewerAgentType: "codex" },
    });
    expect(res.statusCode).toBe(201);
    expect(proxyMock.mock.calls[0][4]).toBe("/api/agent-sessions/src1");
    const [serverId, url, key, method, apiPath, body] = proxyMock.mock.calls[1];
    expect([serverId, url, key, method, apiPath]).toEqual(["srv1", "http://r", "k", "POST", "/api/path/workflow-runs"]);
    expect(body).toMatchObject({ sourceSessionId: "src1", reviewFocus: "tests", sourceTurnEndIndex: 4, reviewerAgentType: "codex" });

    const run = res.json().run;
    expect(run.id).toBe("remote-srv1-p1-run1");
    expect(run.project_id).toBe("p1");
    expect(run.source_session_id).toBe(SRC);
    expect(run.reviewer_session_id).toBe("remote-srv1-p1-rev1");

    expect(remoteSessionMap.get("remote-srv1-p1-rev1")).toMatchObject({ remoteSessionId: "rev1", remoteServerId: "srv1" });
    expect(upsert).toHaveBeenCalledWith("remote-srv1-p1-rev1", "p1", "srv1", "rev1", "dev");
    expect(ensureStreamMock).toHaveBeenCalledWith("remote-srv1-p1-rev1", expect.anything());
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "workflow:run-updated", projectId: "p1" }));
    // Sidebar/window surfacing for the worker-spawned reviewer: the worker's
    // own announcements fire before the front subscribes, so the route must
    // emit them itself.
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:process", projectId: "p1", branch: "dev", sessionId: "remote-srv1-p1-rev1", alive: true,
    }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:status", projectId: "p1", branch: "dev", sessionId: "remote-srv1-p1-rev1", status: "running",
    }));
    // The worker set the final "Review - …" title; the front claims its
    // one-shot slots so a takeover /message can't regenerate over it.
    expect(markTitleResolvedMem).toHaveBeenCalledWith("remote-srv1-p1-rev1");
    expect(markTitleResolvedDb).toHaveBeenCalledWith("remote-srv1-p1-rev1");
  });

  it("POST forwards the worker's semantic 4xx body and 404s an unmapped source", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { session: { id: "src1" }, messages: [] } }); // history pull
    proxyMock.mockResolvedValueOnce({ ok: false, status: 409, data: { error: "该 session 已在一个进行中的 review 里" } });
    const busy = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/review/);

    const unmapped = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: "remote-srv1-p1-ghost" },
    });
    expect(unmapped.statusCode).toBe(404);
  });

  it("GET list proxies via remote_path and gate reaches the worker through remoteRunMap", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { runs: [bareRun] } });
    const list = await app.inject({ method: "GET", url: "/api/workflow-runs?projectId=p1&branch=dev" });
    expect(list.statusCode).toBe(200);
    expect(list.json().runs[0].id).toBe("remote-srv1-p1-run1");
    const listPath = proxyMock.mock.calls[0][4] as string;
    expect(listPath).toContain("/api/path/workflow-runs?");
    expect(listPath).toContain("branch=dev");

    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { run: { ...bareRun, status: "completed" } } });
    const gate = await app.inject({
      method: "POST", url: "/api/workflow-runs/remote-srv1-p1-run1/gate",
      payload: { action: "approve", editedPayload: "edited" },
    });
    expect(gate.statusCode).toBe(200);
    expect(gate.json().run.status).toBe("completed");
    expect(proxyMock.mock.calls[1][4]).toBe("/api/workflow-runs/run1/gate");
    expect(proxyMock.mock.calls[1][5]).toMatchObject({ action: "approve", editedPayload: "edited" });
  });

  it("gate 404s an unknown remote run id (empty remoteRunMap)", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs/remote-srv1-p1-unknown/gate",
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(404);
  });
});
