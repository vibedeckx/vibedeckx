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
    remoteSessionMappings: { upsert },
    workflowRuns: { getActive: async () => [], getById: async () => undefined },
    agentSessions: { getById: async () => undefined },
  } as never);
  app.decorate("workflowEngine", {} as never);
  app.decorate("remoteSessionMap", remoteSessionMap as never);
  app.decorate("remotePatchCache", {} as never);
  app.decorate("reverseConnectManager", null);
  app.decorate("eventBus", { emit } as never);
  app.decorate("agentSessionManager", {} as never);
  return { remoteSessionMap, upsert, emit };
}

describe("workflow-run remote proxying (front server)", () => {
  it("POST proxies to the worker path mirror, maps ids, registers the reviewer stream", async () => {
    const { remoteSessionMap, upsert, emit } = makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, reviewFocus: "tests", sourceTurnEndIndex: 4 },
    });
    expect(res.statusCode).toBe(201);
    const [serverId, url, key, method, apiPath, body] = proxyMock.mock.calls[0];
    expect([serverId, url, key, method, apiPath]).toEqual(["srv1", "http://r", "k", "POST", "/api/path/workflow-runs"]);
    expect(body).toMatchObject({ sourceSessionId: "src1", reviewFocus: "tests", sourceTurnEndIndex: 4 });

    const run = res.json().run;
    expect(run.id).toBe("remote-srv1-p1-run1");
    expect(run.project_id).toBe("p1");
    expect(run.source_session_id).toBe(SRC);
    expect(run.reviewer_session_id).toBe("remote-srv1-p1-rev1");

    expect(remoteSessionMap.get("remote-srv1-p1-rev1")).toMatchObject({ remoteSessionId: "rev1", remoteServerId: "srv1" });
    expect(upsert).toHaveBeenCalledWith("remote-srv1-p1-rev1", "p1", "srv1", "rev1", "dev");
    expect(ensureStreamMock).toHaveBeenCalledWith("remote-srv1-p1-rev1", expect.anything());
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "workflow:run-updated", projectId: "p1" }));
  });

  it("POST forwards the worker's semantic 4xx body and 404s an unmapped source", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
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
