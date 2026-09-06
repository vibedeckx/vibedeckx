import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const { proxyToRemoteAuto } = vi.hoisted(() => ({
  proxyToRemoteAuto: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
}));
vi.mock("../utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyToRemote: vi.fn(),
  proxyStatus: (result: { status: number }) => result.status,
}));

import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import type { RemoteSessionInfo } from "../server-types.js";
import agentSessionRoutes from "./agent-session-routes.js";
import { ATTACHMENT_DIR } from "../utils/temp-file-sweep.js";
import { MAX_ATTACHMENT_BYTES } from "../utils/attachment-file.js";

const CAP = "http:POST /api/agent-sessions/:param/attachment";

/**
 * Non-image composer attachments land on the agent's machine as a temp file;
 * the hub forwards them to a worker over the tunnel only when the worker's
 * handshake says it serves the route, and maps a 404 to the same
 * `worker_unsupported` answer so the UI can say "update the worker".
 */
describe("POST /api/agent-sessions/:sessionId/attachment", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let serverId: string;
  const remoteSessionMap = new Map<string, RemoteSessionInfo>();
  const writtenDirs: string[] = [];

  const body = (over: Record<string, unknown> = {}) => ({
    name: "spec.pdf",
    mediaType: "application/pdf",
    contentBase64: Buffer.from("%PDF-1.4 hello").toString("base64"),
    ...over,
  });
  const post = (sessionId: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/attachment`, payload });

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: {} });
    remoteSessionMap.clear();

    dir = mkdtempSync(path.join(tmpdir(), "vdx-attachment-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project 1", path: null });
    const remote = await storage.remoteServers.create({ name: "W1", url: "http://w1" });
    serverId = remote.id;
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverId, remote_path: "/repo" });

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("agentSessionManager", {} as never);
    app.decorate("remoteSessionMap", remoteSessionMap as never);
    app.decorate("reverseConnectManager", null as never);
    await app.register(agentSessionRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    for (const d of writtenDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  describe("local", () => {
    it("writes the bytes under a per-upload dir and echoes the sanitized name", async () => {
      const res = await post("local-1", body({ name: '../../x/spe"c.pdf' }));
      expect(res.statusCode, res.body).toBe(200);
      const json = res.json();
      writtenDirs.push(path.dirname(json.path));
      expect(json).toMatchObject({ name: "spec.pdf", size: 14, mediaType: "application/pdf" });
      expect(path.dirname(path.dirname(json.path))).toBe(ATTACHMENT_DIR);
      expect((await readFile(json.path)).toString()).toBe("%PDF-1.4 hello");
    });

    it("rejects malformed bodies", async () => {
      expect((await post("local-1", body({ name: "" }))).statusCode).toBe(400);
      expect((await post("local-1", body({ contentBase64: "" }))).statusCode).toBe(400);
      expect((await post("local-1", body({ contentBase64: "!!!!" }))).statusCode).toBe(400);
      expect((await post("local-1", body({ mediaType: 7 }))).statusCode).toBe(400);
    });

    it("caps the raw size", async () => {
      const over = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");
      const res = await post("local-1", body({ contentBase64: over }));
      expect(res.statusCode).toBe(413);
      expect(res.json().errorCode).toBe("attachment_too_large");
    });
  });

  describe("remote", () => {
    const wrapped = () => `remote-${serverId}-p1-rs1`;
    const mapSession = () => {
      remoteSessionMap.set(wrapped(), { remoteServerId: serverId, remoteSessionId: "rs1", branch: "main" });
    };

    it("refuses without probing when the worker reports capabilities that lack the route", async () => {
      mapSession();
      await storage.remoteServers.updateWorkerVersion(serverId, "0.3.36", ["http:POST /api/agent-sessions/:param/paste"]);
      const res = await post(wrapped(), body());
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().errorCode).toBe("worker_unsupported");
      expect(proxyToRemoteAuto).not.toHaveBeenCalled();
    });

    it("forwards the identical payload when the worker advertises the route", async () => {
      mapSession();
      await storage.remoteServers.updateWorkerVersion(serverId, "0.3.37", [CAP]);
      proxyToRemoteAuto.mockResolvedValue({
        ok: true, status: 200,
        data: { path: "/tmp/vibedeckx-attachments/u/spec.pdf", name: "spec.pdf", size: 14, mediaType: "application/pdf" },
      });
      const res = await post(wrapped(), body());
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().path).toBe("/tmp/vibedeckx-attachments/u/spec.pdf");
      expect(proxyToRemoteAuto).toHaveBeenCalledWith(
        serverId, "POST", "/api/agent-sessions/rs1/attachment", body(), expect.anything(),
      );
    });

    it("maps a worker 404 (capabilities unknown) to worker_unsupported", async () => {
      mapSession();
      proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 404, data: { error: "Not Found" } });
      const res = await post(wrapped(), body());
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().errorCode).toBe("worker_unsupported");
    });

    it("resolves a prepared (not yet activated) session through its intent", async () => {
      // First send with an attachment: prepare → upload → activate. Between
      // the first two steps there is no mapping, only the pending intent.
      const local = `remote-${serverId}-p1-prep1`;
      await storage.remoteSessionCreationIntents.begin({
        localSessionId: local, remoteSessionId: "prep1", projectId: "p1", remoteServerId: serverId,
        branch: "main", remotePath: "/repo", permissionMode: "edit", prepareOperationId: "op-1",
      });
      await storage.remoteServers.updateWorkerVersion(serverId, "0.3.37", [CAP]);
      const res = await post(local, body());
      expect(res.statusCode, res.body).toBe(200);
      expect(proxyToRemoteAuto).toHaveBeenCalledWith(
        serverId, "POST", "/api/agent-sessions/prep1/attachment", expect.anything(), expect.anything(),
      );
    });

    it("404s an unknown remote session", async () => {
      const res = await post(`remote-${serverId}-p1-nope`, body());
      expect(res.statusCode).toBe(404);
      expect(proxyToRemoteAuto).not.toHaveBeenCalled();
    });
  });
});
