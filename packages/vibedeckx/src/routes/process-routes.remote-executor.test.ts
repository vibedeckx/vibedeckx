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
      isConnected: () => true,
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

    it("confirms a lost start that the reconnected worker reports running", async () => {
      proxy.handler = async () => lost;
      await startExecutor();
      const { processId } = executeCalls()[0][3] as ExecuteBody;
      proxy.handler = async (_s, method, p) => {
        if (method === "GET" && p === "/api/executor-processes/running") return ok({ processes: [{ id: processId }] });
        throw new Error(`unexpected ${method} ${p}`);
      };

      statusHandler!(serverId, "online");

      const localId = `remote-e1-${processId}`;
      await vi.waitFor(() => expect(remoteExecutorMap.has(localId)).toBe(true));
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "executor:started", processId: localId }));
    });

    it("keeps a lost start pending when the reconnected worker does not list it", async () => {
      proxy.handler = async () => lost;
      await startExecutor();
      const { processId } = executeCalls()[0][3] as ExecuteBody;
      proxy.handler = async () => ok({ processes: [] });

      statusHandler!(serverId, "online");
      await vi.waitFor(() =>
        expect(vi.mocked(proxyToRemoteAuto)).toHaveBeenCalledWith(serverId, "GET", "/api/executor-processes/running", undefined, expect.anything()));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(remoteExecutorMap.size).toBe(0);

      proxy.handler = async (_s, _m, _p, body) => ok({ processId: (body as ExecuteBody).processId });
      await startExecutor();
      expect((executeCalls()[1][3] as ExecuteBody).processId).toBe(processId);
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
});
