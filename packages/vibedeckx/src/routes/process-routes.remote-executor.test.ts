import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { ProxyResult } from "../utils/remote-proxy.js";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.userId }),
  clerkClient: {},
}));

const proxy = vi.hoisted(() => ({
  handler: null as null | ((serverId: string, method: string, path: string, body: unknown) => Promise<ProxyResult>),
}));
vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/remote-proxy.js")>();
  return {
    ...actual,
    proxyToRemoteAuto: vi.fn((serverId: string, method: string, p: string, body: unknown) => proxy.handler!(serverId, method, p, body)),
  };
});

import processRoutes from "./process-routes.js";
import { createRemoteExecutorStarts, DELIVERY_RETRY_INTERVAL_MS, DELIVERY_WINDOW_MS } from "../remote-executor-starts.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import type { RemoteExecutorInfo } from "../server-types.js";

const ok = (data: unknown): ProxyResult => ({ ok: true, status: 200, data });
const lost: ProxyResult = { ok: false, status: 0, data: { error: "Request timed out after 30000ms" }, errorCode: "timeout" };
const notFound: ProxyResult = { ok: false, status: 404, data: { error: "Process not found or already stopped" } };

type ExecuteBody = { processId?: string; effectFingerprint?: string };

/**
 * A failed tunnel request only means the outcome is unknown. These cover the
 * two ways that used to be misread: a lost Start response (the worker may have
 * spawned the process) and a Stop that never reached the worker.
 */
describe("remote executor start/stop over an unreliable tunnel", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let serverId: string;
  let statusHandler: ((id: string, status: "online" | "offline") => void) | null;
  let remoteExecutorMap: Map<string, RemoteExecutorInfo>;
  let connected: boolean;
  const monitor = { watch: vi.fn(), unwatch: vi.fn() };
  const emit = vi.fn();

  const executeCalls = () =>
    vi.mocked(proxyToRemoteAuto).mock.calls.filter(([, method, p]) => method === "POST" && p === "/api/path/execute");
  const startExecutor = () => app.inject({ method: "POST", url: "/api/executors/e1/start", payload: {} });

  beforeEach(async () => {
    auth.userId = "user-1";
    vi.mocked(proxyToRemoteAuto).mockClear();
    monitor.watch.mockClear();
    monitor.unwatch.mockClear();
    emit.mockClear();
    statusHandler = null;
    connected = true;
    proxy.handler = null;
    dir = mkdtempSync(path.join(tmpdir(), "vdx-remote-exec-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));

    const server = await storage.remoteServers.create({ name: "ubuntu" }, "user-1");
    serverId = server.id;
    await storage.remoteServers.updateWorkerVersion(serverId, "0.3.40", []);
    await storage.projects.create({ id: "project-1", name: "p", path: null }, "user-1");
    await storage.projects.update("project-1", { executor_mode: serverId });
    await storage.projectRemotes.add({ project_id: "project-1", remote_server_id: serverId, remote_path: "/repo" });
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "project-1", branch: "feat", targetId: serverId, worktreePath: "/repo-feat", expectedBranch: "feat",
    });
    await storage.executors.create({
      id: "e1", project_id: "project-1", workspace_id: registered.workspace.id, name: "dev", command: "./dev.sh",
    });

    remoteExecutorMap = new Map();
    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    app.decorate("processManager", { start: vi.fn(), stop: vi.fn(), getRunningProcessIds: vi.fn(() => []), getProcessProjectId: vi.fn(() => null) });
    app.decorate("reverseConnectManager", {
      isConnected: () => connected,
      getMachineId: () => null,
      setStatusChangeHandler: vi.fn((handler) => { statusHandler = handler; }),
    });
    app.decorate("remoteExecutorMap", remoteExecutorMap);
    app.decorate("remoteExecutorMonitor", monitor);
    app.decorate("eventBus", { emit });
    await app.register(processRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("Start", () => {
    it("registers the process the worker started under the requested identity", async () => {
      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });

      const response = await startExecutor();

      expect(response.statusCode).toBe(200);
      const [call] = executeCalls();
      const body = call[3] as ExecuteBody;
      expect(body.processId).toEqual(expect.any(String));
      expect(body.effectFingerprint).toEqual(expect.any(String));
      const localId = `remote-e1-${body.processId}`;
      expect(response.json()).toEqual({ processId: localId });
      expect(remoteExecutorMap.has(localId)).toBe(true);
      expect(monitor.watch).toHaveBeenCalledWith(localId, expect.objectContaining({ remoteProcessId: body.processId }));
    });

    it("rejects a second Start while the first is still waiting on the worker", async () => {
      let release!: (result: ProxyResult) => void;
      proxy.handler = () => new Promise((resolve) => { release = resolve; });

      const first = startExecutor();
      await vi.waitFor(() => expect(executeCalls()).toHaveLength(1));
      const second = await startExecutor();

      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: "starting" });
      expect(second.json().processId).toBeUndefined();

      const body = executeCalls()[0][3] as ExecuteBody;
      release(ok({ processId: body.processId }));
      expect((await first).statusCode).toBe(200);
      expect(executeCalls()).toHaveLength(1);
    });

    it("returns the confirmed process instead of starting another", async () => {
      remoteExecutorMap.set("remote-e1-running", { remoteServerId: serverId, remoteProcessId: "running", executorId: "e1", projectId: "project-1" });
      proxy.handler = async () => { throw new Error("must not reach the worker"); };

      const response = await startExecutor();

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "already_running", processId: "remote-e1-running" });
    });

    it("retries a lost start with the same identity, so a spawn that did happen is not repeated", async () => {
      const spawned = new Set<string>();
      let dropResponse = true;
      proxy.handler = async (_s, _m, _p, body) => {
        const { processId } = body as ExecuteBody;
        spawned.add(processId!); // the worker dedupes on processId
        if (dropResponse) return lost;
        return ok({ processId });
      };

      const first = await startExecutor();
      expect(first.statusCode).toBe(503);
      expect(first.json()).toMatchObject({ code: "start_unknown" });
      expect(remoteExecutorMap.size).toBe(0);

      dropResponse = false;
      const second = await startExecutor();

      expect(second.statusCode).toBe(200);
      const [firstBody, secondBody] = executeCalls().map(([, , , body]) => body as ExecuteBody);
      expect(secondBody.processId).toBe(firstBody.processId);
      expect(secondBody.effectFingerprint).toBe(firstBody.effectFingerprint);
      expect(spawned.size).toBe(1);
      expect([...remoteExecutorMap.keys()]).toEqual([`remote-e1-${firstBody.processId}`]);
    });

    it("forgets a lost start on workers that cannot dedupe a retry", async () => {
      await storage.remoteServers.updateWorkerVersion(serverId, "0.3.0", []);
      proxy.handler = async () => lost;
      await startExecutor();
      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });

      await startExecutor();

      const [firstBody, secondBody] = executeCalls().map(([, , , body]) => body as ExecuteBody);
      expect(secondBody.processId).not.toBe(firstBody.processId);
    });

    it("forgets a start the worker explicitly rejected", async () => {
      proxy.handler = async () => ({ ok: false, status: 404, data: { error: "Project not found" } });
      const first = await startExecutor();
      expect(first.statusCode).toBe(404);
      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });

      await startExecutor();

      const [firstBody, secondBody] = executeCalls().map(([, , , body]) => body as ExecuteBody);
      expect(secondBody.processId).not.toBe(firstBody.processId);
    });

    it("re-delivers a lost start under the same identity as soon as the worker reconnects", async () => {
      const spawned = new Set<string>();
      proxy.handler = async (_s, _m, _p, body) => { spawned.add((body as ExecuteBody).processId!); return lost; };
      const first = await startExecutor();
      expect(first.json()).toMatchObject({ code: "start_unknown", retrying: true });
      const { processId } = executeCalls()[0][3] as ExecuteBody;
      proxy.handler = async (_s, _m, _p, body) => { spawned.add((body as ExecuteBody).processId!); return ok({ processId: (body as ExecuteBody).processId }); };

      statusHandler!(serverId, "online");

      const localId = `remote-e1-${processId}`;
      await vi.waitFor(() => expect(remoteExecutorMap.has(localId)).toBe(true));
      expect(spawned).toEqual(new Set([processId]));
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "executor:started", processId: localId }));
    });

    it("Retry now re-sends the pending start it names, under its identity", async () => {
      proxy.handler = async () => lost;
      await startExecutor();
      const { processId } = executeCalls()[0][3] as ExecuteBody;
      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });

      const retry = await app.inject({
        method: "POST", url: "/api/executors/e1/start", payload: { retryProcessId: `remote-e1-${processId}` },
      });

      expect(retry.statusCode).toBe(200);
      expect((executeCalls()[1][3] as ExecuteBody).processId).toBe(processId);
    });

    it("Retry now on a stale notice starts nothing once that start has ended", async () => {
      proxy.handler = async () => lost;
      await startExecutor();
      const { processId } = executeCalls()[0][3] as ExecuteBody;
      // The hub delivered it and the run finished before the page heard.
      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });
      statusHandler!(serverId, "online");
      await vi.waitFor(() => expect(remoteExecutorMap.has(`remote-e1-${processId}`)).toBe(true));
      remoteExecutorMap.clear();

      const retry = await app.inject({
        method: "POST", url: "/api/executors/e1/start", payload: { retryProcessId: `remote-e1-${processId}` },
      });

      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toMatchObject({ code: "retry_ended" });
      expect(executeCalls()).toHaveLength(2);
    });

    it("lists a start being re-delivered for the project's UI", async () => {
      proxy.handler = async () => lost;
      await startExecutor();
      const { processId } = executeCalls()[0][3] as ExecuteBody;

      const response = await app.inject({ method: "GET", url: "/api/projects/project-1/executor-deliveries" });

      expect(response.statusCode).toBe(200);
      expect(response.json().deliveries).toEqual([expect.objectContaining({
        processId: `remote-e1-${processId}`, executorId: "e1", remoteServerId: serverId, branch: "feat",
        state: "retrying", attempts: 1, reason: "timeout", nextAttemptAt: expect.any(Number),
      })]);
      auth.userId = "someone-else";
      expect((await app.inject({ method: "GET", url: "/api/projects/project-1/executor-deliveries" })).statusCode).toBe(404);
    });
  });

  describe("Stop", () => {
    const localId = "remote-e1-worker-proc";
    const stopProcess = () => app.inject({ method: "POST", url: `/api/executor-processes/${localId}/stop` });

    beforeEach(async () => {
      remoteExecutorMap.set(localId, { remoteServerId: serverId, remoteProcessId: "worker-proc", executorId: "e1", projectId: "project-1" });
      await storage.remoteExecutorProcesses.insert(localId, { remoteServerId: serverId, remoteProcessId: "worker-proc", executorId: "e1", projectId: "project-1" });
    });

    it("keeps the process running when the stop never reached the worker", async () => {
      proxy.handler = async () => ({ ok: false, status: 0, data: { error: "Remote server is not connected" }, errorCode: "network_error" });

      const response = await stopProcess();

      expect(response.statusCode).toBe(502);
      expect(remoteExecutorMap.has(localId)).toBe(true);
      expect(emit).not.toHaveBeenCalled();
      expect((await storage.remoteExecutorProcesses.getById(localId))?.status).toBe("running");
    });

    it("settles a 404 the worker's running list confirms, so Start works right away", async () => {
      proxy.handler = async (_s, method, p, body) => {
        if (p.endsWith("/stop")) return notFound;
        if (method === "GET") return ok({ processes: [] });
        return ok({ processId: (body as ExecuteBody).processId });
      };

      const response = await stopProcess();

      expect(response.statusCode).toBe(404);
      expect(remoteExecutorMap.has(localId)).toBe(false);
      expect(monitor.unwatch).toHaveBeenCalledWith(localId);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "executor:stopped", processId: localId }));
      expect((await startExecutor()).statusCode).toBe(200);
    });

    it("keeps the process when a 404 is contradicted by the worker's running list", async () => {
      proxy.handler = async (_s, method, p) => {
        if (p.endsWith("/stop")) return notFound;
        if (method === "GET") return ok({ processes: [{ id: "worker-proc" }] });
        throw new Error(`unexpected ${method} ${p}`);
      };

      const response = await stopProcess();

      expect(response.statusCode).toBe(502);
      expect(remoteExecutorMap.has(localId)).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    });

    it("keeps the process when a 404 cannot be verified", async () => {
      proxy.handler = async (_s, method, p) => {
        if (p.endsWith("/stop")) return notFound;
        if (method === "GET") return lost;
        throw new Error(`unexpected ${method} ${p}`);
      };

      const response = await stopProcess();

      expect(response.statusCode).toBe(502);
      expect(remoteExecutorMap.has(localId)).toBe(true);
    });

    it("settles a successful stop", async () => {
      proxy.handler = async () => ok({ success: true });

      const response = await stopProcess();

      expect(response.statusCode).toBe(200);
      expect(remoteExecutorMap.has(localId)).toBe(false);
      expect(monitor.unwatch).toHaveBeenCalledWith(localId);
      expect((await storage.remoteExecutorProcesses.getById(localId))?.status).toBe("killed");
    });
  });
  describe("caller-chosen identity (commander operations)", () => {
    const request = (processId: string) => ({
      executorId: "e1", projectId: "project-1", remoteServerId: serverId, branch: null, processId,
      body: { path: "/repo", command: "./dev.sh", executor_type: "command", prompt_provider: null, pty: true },
    });

    it("starts under the caller's id", async () => {
      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });
      const outcome = await createRemoteExecutorStarts(app).start(request("op-proc"));
      expect(outcome).toEqual({ kind: "started", processId: "remote-e1-op-proc" });
      expect((executeCalls()[0][3] as ExecuteBody).processId).toBe("op-proc");
    });

    it("answers a re-sent request for its own running process without reaching the worker", async () => {
      remoteExecutorMap.set("remote-e1-op-proc", { remoteServerId: serverId, remoteProcessId: "op-proc", executorId: "e1", projectId: "project-1" });
      proxy.handler = async () => { throw new Error("must not reach the worker"); };
      const starts = createRemoteExecutorStarts(app);
      expect(await starts.start(request("op-proc"))).toEqual({ kind: "started", processId: "remote-e1-op-proc" });
      expect(await starts.start(request("other"))).toEqual({ kind: "already_running", processId: "remote-e1-op-proc" });
    });

    it("keeps re-delivering on its own until the worker answers, under one identity", async () => {
      proxy.handler = async () => lost;
      const starts = createRemoteExecutorStarts(app);
      const first = await starts.start(request("op-proc"));
      expect(first).toMatchObject({ kind: "unknown", reason: "timeout", retrying: true });
      const deadline = (first as { deadlineAt: number }).deadlineAt;

      // Not due yet: nothing is sent.
      starts.tick(Date.now());
      expect(executeCalls()).toHaveLength(1);

      starts.tick(Date.now() + DELIVERY_RETRY_INTERVAL_MS);
      await vi.waitFor(() => expect(executeCalls()).toHaveLength(2));
      await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: "executor:delivery", delivery: expect.objectContaining({ state: "retrying", attempts: 2 }),
      })));

      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });
      starts.tick(Date.now() + 2 * DELIVERY_RETRY_INTERVAL_MS);
      await vi.waitFor(() => expect(remoteExecutorMap.has("remote-e1-op-proc")).toBe(true));
      expect(executeCalls().map(([, , , body]) => (body as ExecuteBody).processId)).toEqual(["op-proc", "op-proc", "op-proc"]);
      expect(starts.list("project-1")).toEqual([]);
      expect(starts.isRetrying("remote-e1-op-proc")).toBe(false);
      expect(deadline).toBeGreaterThan(Date.now());
    });

    it("waits for the reconnect instead of sending while the worker is offline", async () => {
      connected = false;
      proxy.handler = async () => ({ ok: false, status: 0, data: { error: "Remote server is not connected" }, errorCode: "network_error", notSent: true });
      const starts = createRemoteExecutorStarts(app);
      expect(await starts.start(request("op-proc"))).toMatchObject({ kind: "unknown", reason: "offline", retrying: true });

      starts.tick(Date.now() + DELIVERY_RETRY_INTERVAL_MS);
      expect(executeCalls()).toHaveLength(1);
      expect(starts.list("project-1")[0]).toMatchObject({ reason: "offline", nextAttemptAt: null });

      connected = true;
      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });
      statusHandler!(serverId, "online");
      await vi.waitFor(() => expect(remoteExecutorMap.has("remote-e1-op-proc")).toBe(true));
    });

    it("gives up at the end of the delivery window; the next start is a fresh one", async () => {
      proxy.handler = async () => lost;
      const starts = createRemoteExecutorStarts(app);
      await starts.start(request("op-proc"));
      emit.mockClear();

      starts.tick(Date.now() + DELIVERY_WINDOW_MS);

      expect(starts.isRetrying("remote-e1-op-proc")).toBe(false);
      expect(executeCalls()).toHaveLength(1);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: "executor:delivery",
        delivery: expect.objectContaining({ state: "gave_up", processId: "remote-e1-op-proc", attempts: 1, error: "Request timed out after 30000ms" }),
      }));
      expect(starts.list("project-1")).toEqual([expect.objectContaining({ state: "gave_up" })]);

      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });
      expect(await starts.start(request("op-proc-2"))).toEqual({ kind: "started", processId: "remote-e1-op-proc-2" });
      expect(starts.list("project-1")).toEqual([]);
    });

    it("a manual Start past the window sends nothing and reports the give-up", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        proxy.handler = async () => lost;
        await startExecutor();
        vi.setSystemTime(Date.now() + DELIVERY_WINDOW_MS);

        const late = await startExecutor();

        expect(late.statusCode).toBe(409);
        expect(late.json()).toMatchObject({ code: "delivery_gave_up" });
        expect(executeCalls()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a start that never left the hub is given up as not run", async () => {
      connected = false;
      proxy.handler = async () => ({ ok: false, status: 0, data: { error: "Remote server is not connected" }, errorCode: "network_error", notSent: true });
      const starts = createRemoteExecutorStarts(app);
      await starts.start(request("op-proc"));

      starts.tick(Date.now() + DELIVERY_WINDOW_MS);

      expect(starts.list("project-1")).toEqual([expect.objectContaining({ state: "gave_up", mayHaveRun: false })]);
    });

    it("announces a refusal that comes back on a re-delivery", async () => {
      proxy.handler = async () => lost;
      const starts = createRemoteExecutorStarts(app);
      await starts.start(request("op-proc"));
      proxy.handler = async () => ({ ok: false, status: 404, data: { error: "Project not found" } });

      statusHandler!(serverId, "online");

      await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: "executor:delivery", delivery: expect.objectContaining({ state: "rejected", error: "Project not found", mayHaveRun: true }),
      })));
      expect(starts.isRetrying("remote-e1-op-proc")).toBe(false);
    });

    it("never adopts someone else's unconfirmed start", async () => {
      proxy.handler = async () => lost;
      const starts = createRemoteExecutorStarts(app);
      expect((await starts.start({ ...request("user-proc") })).kind).toBe("unknown");
      expect(await starts.start(request("op-proc"))).toEqual({ kind: "starting" });
      expect(executeCalls()).toHaveLength(1);
    });
  });
});
