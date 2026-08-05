import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { RemoteSessionActivityUpdateResult } from "../storage/types.js";

const { proxyMock, ensureStreamMock } = vi.hoisted(() => ({
  proxyMock: vi.fn(),
  ensureStreamMock: vi.fn(),
}));
vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, proxyToRemoteAuto: proxyMock };
});
vi.mock("../remote-agent-sessions.js", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  ensureRemoteAgentStream: ensureStreamMock,
}));
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
    remoteServerId: "srv1",
    remoteSessionId: "src1", branch: "dev",
  });
  const upsert = vi.fn(async () => undefined);
  const markTitleResolvedDb = vi.fn(async () => undefined);
  const updateRemoteSessionActivity = vi.fn(async (): Promise<RemoteSessionActivityUpdateResult> => true);
  const markTitleResolvedMem = vi.fn(() => true);
  const emitBranchActivityIfChanged = vi.fn();
  const emit = vi.fn();
  // Notification sync seam: prepareForNewTurn gates a reused reviewer's new
  // turn, and the reviewer registration asks for an immediate sweep.
  const prepareForNewTurn = vi.fn(async () => true);
  const extendWatch = vi.fn(async () => undefined);
  const syncServer = vi.fn(async () => undefined);
  const enqueue = vi.fn((work: () => Promise<void>) => { void work(); });
  app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    projects: { getById: async (id: string) => (id === "p1" ? { id: "p1", name: "p", path: null, agent_mode: "srv1" } : undefined) },
    projectRemotes: {
      getByProjectAndServer: async (pid: string, sid: string) =>
        pid === "p1" && sid === "srv1"
          ? { remote_path: "/w/repo", remote_server_id: "srv1" }
          : undefined,
    },
    remoteSessionMappings: {
      upsert,
      getByLocal: async () => undefined,
      upsertBound: async (opts: { localSessionId: string; projectId: string; remoteServerId: string; remoteSessionId: string; branch: string | null; notificationSyncStart?: string }) =>
        upsert(opts.localSessionId, opts.projectId, opts.remoteServerId, opts.remoteSessionId, opts.branch, opts.notificationSyncStart),
      markTitleResolved: markTitleResolvedDb,
    },
    workspaceRegistry: {
      getByProjectBranch: async (_projectId: string, branch: string, targetId: string) => ({
        workspace: { id: `w-${branch}`, project_id: "p1", branch, status: "ready", error: null },
        checkout: { id: `c-${targetId}-${branch}`, workspace_id: `w-${branch}`, target_id: targetId,
          worktree_path: branch ? `/w/repo-worktrees/${branch}` : "/w/repo", path_source: "reported",
          expected_branch: branch, status: "ready", error: null, deleted_at: null },
      }),
    },
    searchCache: { updateRemoteSessionActivity },
    workflowRuns: { getActive: async () => [], getById: async () => undefined },
    agentSessions: { getById: async () => undefined },
  } as never);
  app.decorate("workflowEngine", {} as never);
  app.decorate("remoteSessionMap", remoteSessionMap as never);
  app.decorate("remotePatchCache", {} as never);
  app.decorate("reverseConnectManager", null);
  app.decorate("eventBus", { emit } as never);
  app.decorate("agentSessionManager", {
    markTitleResolved: markTitleResolvedMem,
    emitBranchActivityIfChanged,
  } as never);
  app.decorate("remoteNotificationSync", {
    prepareForNewTurn, extendWatch, syncServer, enqueue,
  } as never);
  return {
    remoteSessionMap, upsert, updateRemoteSessionActivity, emit, markTitleResolvedDb, markTitleResolvedMem,
    emitBranchActivityIfChanged,
    prepareForNewTurn, extendWatch, syncServer, enqueue,
  };
}

describe("workflow-run remote proxying (front server)", () => {
  it("fails closed before proxying when the source mapping points at a tombstoned checkout", async () => {
    makeApp();
    const storage = app.storage as any;
    storage.remoteSessionMappings.getByLocal = vi.fn(async () => ({
      local_session_id: SRC,
      project_id: "p1",
      remote_server_id: "srv1",
      remote_session_id: "src1",
      branch: "dev",
      workspace_checkout_id: "checkout-old",
    }));
    storage.workspaceRegistry.getCheckoutById = vi.fn(async () => ({
      workspace: { id: "workspace-dev", project_id: "p1", branch: "dev", status: "archived", error: null },
      checkout: {
        id: "checkout-old", workspace_id: "workspace-dev", target_id: "srv1",
        worktree_path: "/w/old-dev", path_source: "reported", expected_branch: "dev",
        status: "ready", error: null, deleted_at: "2026-08-01 00:00:00",
      },
    }));
    await app.register(workflowRunRoutes);

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/checkout/i);
    expect(proxyMock).not.toHaveBeenCalled();
  });

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

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().candidate.sessionId).toBe("remote-srv1-p1-rev1");
    expect(proxyMock.mock.calls[0][2]).toBe(
      "/api/path/workflow-runs/reviewer-candidate?sourceSessionId=src1",
    );
    expect(remoteSessionMap.get("remote-srv1-p1-rev1")).toMatchObject({
      remoteSessionId: "rev1", branch: "dev",
    });
    // Candidate lookup DISCOVERS a reviewer from a past run: from_now, so its
    // old reviews aren't replayed as new unread notifications.
    expect(upsert).toHaveBeenCalledWith("remote-srv1-p1-rev1", "p1", "srv1", "rev1", "dev", "from_now");
    expect(ensureStreamMock).not.toHaveBeenCalled();
  });

  it("POST reuse forwards the bare reviewer id and rejects an unmapped reviewer", async () => {
    const { remoteSessionMap } = makeApp();
    remoteSessionMap.set("remote-srv1-p1-rev1", {
      remoteServerId: "srv1",
      remoteSessionId: "rev1", branch: "dev",
    });
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const ok = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, reviewerSessionId: "remote-srv1-p1-rev1" },
    });
    expect(ok.statusCode).toBe(201);
    expect(proxyMock.mock.calls[0][3]).toMatchObject({
      sourceSessionId: "src1", reviewerSessionId: "rev1",
    });

    const missing = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, reviewerSessionId: "remote-srv1-p1-missing" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("POST reuse baselines the reused reviewer's notification cursor before dispatching", async () => {
    const { remoteSessionMap, prepareForNewTurn } = makeApp();
    remoteSessionMap.set("remote-srv1-p1-rev1", {
      remoteServerId: "srv1",
      remoteSessionId: "rev1", branch: "dev",
    });
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, reviewerSessionId: "remote-srv1-p1-rev1" },
    });
    expect(res.statusCode).toBe(201);
    expect(prepareForNewTurn).toHaveBeenCalledWith("remote-srv1-p1-rev1");
    // Baseline first, dispatch second — the other order would let the review we
    // are starting be mistaken for this reviewer's history and be suppressed.
    expect(prepareForNewTurn.mock.invocationCallOrder[0])
      .toBeLessThan(proxyMock.mock.invocationCallOrder[0]);
  });

  it("POST reuse does not start the review when the notification baseline fails", async () => {
    const { remoteSessionMap, prepareForNewTurn } = makeApp();
    remoteSessionMap.set("remote-srv1-p1-rev1", {
      remoteServerId: "srv1",
      remoteSessionId: "rev1", branch: "dev",
    });
    await app.register(workflowRunRoutes);
    prepareForNewTurn.mockResolvedValueOnce(false);

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, reviewerSessionId: "remote-srv1-p1-rev1" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().errorCode).toBe("notification_baseline_failed");
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("a fresh review needs no reviewer baseline (the reviewer does not exist yet)", async () => {
    const { prepareForNewTurn } = makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: { ...bareRun, reviewer_session_id: null } } });

    // intentBrief supplied so no distillation call competes for the single
    // queued proxy response — this test is about the baseline gate.
    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, intentBrief: "client brief" },
    });
    expect(res.statusCode).toBe(201);
    expect(prepareForNewTurn).not.toHaveBeenCalled();
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
    const [, method, apiPath, body] = proxyMock.mock.calls[0];
    expect([method, apiPath]).toEqual(["POST", "/api/path/workflow-runs"]);
    expect(body).toMatchObject({ sourceSessionId: "src1", intentBrief: "client brief" });
  });

  // Same contract as the local branch: "" says the client already ran tier-1
  // and got nothing. Re-distilling would pull the whole remote history back
  // over the tunnel and repeat two model calls that just failed.
  it("POST treats an empty client intentBrief as an attempt, without pulling history", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, intentBrief: "" },
    });
    expect(res.statusCode).toBe(201);
    expect(proxyMock).toHaveBeenCalledTimes(1); // no history pull
    const [, method, apiPath, body] = proxyMock.mock.calls[0];
    expect([method, apiPath]).toEqual(["POST", "/api/path/workflow-runs"]);
    expect((body as { intentBrief?: string }).intentBrief).toBeUndefined();
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
    expect(proxyMock.mock.calls[0][1]).toBe("GET");
    // Projected history, not the raw session — the tool traffic in a real
    // session dwarfs the text distillation reads.
    expect(proxyMock.mock.calls[0][2]).toBe("/api/agent-sessions/src1/brief-source");
  });

  it("POST proxies to the worker path mirror, maps ids, registers the reviewer stream", async () => {
    const {
      remoteSessionMap, upsert, updateRemoteSessionActivity, emit, markTitleResolvedDb, markTitleResolvedMem,
      emitBranchActivityIfChanged, extendWatch, syncServer,
    } = makeApp();
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
    expect(proxyMock.mock.calls[0][2]).toBe("/api/agent-sessions/src1/brief-source");
    const [serverId, method, apiPath, body] = proxyMock.mock.calls[1];
    expect([serverId, method, apiPath]).toEqual(["srv1", "POST", "/api/path/workflow-runs"]);
    expect(body).toMatchObject({ sourceSessionId: "src1", reviewFocus: "tests", sourceTurnEndIndex: 4, reviewerAgentType: "codex" });

    const run = res.json().run;
    expect(run.id).toBe("remote-srv1-p1-run1");
    expect(run.project_id).toBe("p1");
    expect(run.source_session_id).toBe(SRC);
    expect(run.reviewer_session_id).toBe("remote-srv1-p1-rev1");

    expect(remoteSessionMap.get("remote-srv1-p1-rev1")).toMatchObject({ remoteSessionId: "rev1", remoteServerId: "srv1" });
    // A reviewer this run just created: from_start, because the review can
    // finish before this mapping row lands.
    expect(upsert).toHaveBeenCalledWith("remote-srv1-p1-rev1", "p1", "srv1", "rev1", "dev", "from_start");
    expect(updateRemoteSessionActivity).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "remote-srv1-p1-rev1",
      projectId: "p1",
      targetId: "srv1",
      remoteSessionId: "rev1",
      status: "running",
      lastUserMessageAt: expect.any(Number),
    }));
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(updateRemoteSessionActivity.mock.invocationCallOrder[0]);
    expect(updateRemoteSessionActivity.mock.invocationCallOrder[0]).toBeLessThan(ensureStreamMock.mock.invocationCallOrder[0]);
    expect(updateRemoteSessionActivity.mock.invocationCallOrder[0]).toBeLessThan(emitBranchActivityIfChanged.mock.invocationCallOrder[0]);
    expect(updateRemoteSessionActivity.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]);
    // ...and it is swept immediately rather than waiting for the periodic tick.
    expect(extendWatch).toHaveBeenCalledWith("remote-srv1-p1-rev1");
    expect(syncServer).toHaveBeenCalledWith("srv1", { includeExpired: true });
    expect(ensureStreamMock).toHaveBeenCalledWith("remote-srv1-p1-rev1", expect.anything());
    // The reviewer's `working` dot is still seeded (its worker-side `working`
    // never bridges to the front), but purely for DISPLAY: the reviewer's
    // attention milestone is now a durable review_ready outbox row, so no
    // notification behavior depends on this emit — and nothing marks the
    // reviewer for status-patch reconciliation any more.
    expect(emitBranchActivityIfChanged).toHaveBeenCalledWith("p1", "dev", expect.objectContaining({
      activity: "working", sessionId: "remote-srv1-p1-rev1",
    }));
    // The harness's agentSessionManager stub no longer provides a reconcile
    // marker at all — if the route still called one, this test would have thrown.
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

  it("creates the reviewer activity projection even when its resident stream is not connected", async () => {
    const { updateRemoteSessionActivity, emit } = makeApp();
    ensureStreamMock.mockImplementationOnce(() => undefined);
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, intentBrief: "client brief" },
    });

    expect(res.statusCode).toBe(201);
    expect(updateRemoteSessionActivity).toHaveBeenCalledTimes(1);
    expect(ensureStreamMock).toHaveBeenCalledTimes(1);
    expect(updateRemoteSessionActivity.mock.invocationCallOrder[0])
      .toBeLessThan(ensureStreamMock.mock.invocationCallOrder[0]);
    expect(updateRemoteSessionActivity.mock.invocationCallOrder[0])
      .toBeLessThan(emit.mock.invocationCallOrder[0]);
  });

  it("timestamps reviewer running before the outbound request so a completion before ACK wins", async () => {
    const { updateRemoteSessionActivity } = makeApp();
    let clock = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    await app.register(workflowRunRoutes);
    proxyMock.mockImplementationOnce(async () => {
      clock = 2_000;
      return { ok: true, status: 201, data: { run: bareRun } };
    });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, intentBrief: "client brief" },
    });

    expect(res.statusCode).toBe(201);
    expect(updateRemoteSessionActivity).toHaveBeenCalledWith(expect.objectContaining({
      status: "running", activityAt: 1_000, lastUserMessageAt: 1_000,
    }));
    now.mockRestore();
  });

  it("keeps a completion that arrives before ACK and suppresses stale running events", async () => {
    const { updateRemoteSessionActivity, emit, emitBranchActivityIfChanged } = makeApp();
    updateRemoteSessionActivity.mockResolvedValueOnce("stale");
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, intentBrief: "client brief" },
    });

    expect(res.statusCode).toBe(201);
    expect(ensureStreamMock).toHaveBeenCalledTimes(1);
    expect(emitBranchActivityIfChanged).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "workflow:run-updated", projectId: "p1",
    }));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session:process" }));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session:status" }));
  });

  it("does not attach or emit reviewer activity when the mapped projection is no longer authorized", async () => {
    const { updateRemoteSessionActivity, emit, emitBranchActivityIfChanged } = makeApp();
    updateRemoteSessionActivity.mockResolvedValueOnce(false);
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 201, data: { run: bareRun } });

    const res = await app.inject({
      method: "POST", url: "/api/workflow-runs",
      payload: { projectId: "p1", sourceSessionId: SRC, intentBrief: "client brief" },
    });

    expect(res.statusCode).toBe(409);
    expect(ensureStreamMock).not.toHaveBeenCalled();
    expect(emitBranchActivityIfChanged).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
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
    const listPath = proxyMock.mock.calls[0][2] as string;
    expect(listPath).toContain("/api/path/workflow-runs?");
    expect(listPath).toContain("branch=dev");

    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { run: { ...bareRun, status: "completed" } } });
    const gate = await app.inject({
      method: "POST", url: "/api/workflow-runs/remote-srv1-p1-run1/gate",
      payload: { action: "approve", editedPayload: "edited" },
    });
    expect(gate.statusCode).toBe(200);
    expect(gate.json().run.status).toBe("completed");
    expect(proxyMock.mock.calls[1][2]).toBe("/api/workflow-runs/run1/gate");
    expect(proxyMock.mock.calls[1][3]).toMatchObject({ action: "approve", editedPayload: "edited" });
  });

  it("gate forwards a finalize action to the worker verbatim", async () => {
    makeApp();
    await app.register(workflowRunRoutes);
    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { runs: [bareRun] } });
    const list = await app.inject({ method: "GET", url: "/api/workflow-runs?projectId=p1&branch=dev" });
    expect(list.statusCode).toBe(200);

    proxyMock.mockResolvedValueOnce({ ok: true, status: 200, data: { run: { ...bareRun, status: "completed" } } });
    const gate = await app.inject({
      method: "POST", url: "/api/workflow-runs/remote-srv1-p1-run1/gate",
      payload: { action: "finalize" },
    });
    expect(gate.statusCode).toBe(200);
    expect(gate.json().run.status).toBe("completed");
    expect(proxyMock.mock.calls[1][2]).toBe("/api/workflow-runs/run1/gate");
    expect(proxyMock.mock.calls[1][3]).toMatchObject({ action: "finalize" });
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
