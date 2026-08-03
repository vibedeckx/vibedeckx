import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import remoteServerRoutes, { primeNpmLatestCacheForTests } from "./remote-server-routes.js";

describe("PUT /api/remote-servers/:id cross-remote access", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let serverId: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-rsr-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    const created = await storage.remoteServers.create({ name: "b" });
    serverId = created.id;

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    await app.register(remoteServerRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (payload: unknown) =>
    app.inject({ method: "PUT", url: `/api/remote-servers/${serverId}`, payload: payload as object });

  it("persists a tier change and echoes it back", async () => {
    const res = await put({ crossRemoteAccess: "read" });
    expect(res.statusCode).toBe(200);
    expect(res.json().cross_remote_access).toBe("read");

    const stored = await storage.remoteServers.getById(serverId);
    expect(stored?.cross_remote_access).toBe("read");
  });

  it("rejects an invalid tier value", async () => {
    const res = await put({ crossRemoteAccess: "root" });
    expect(res.statusCode).toBe(400);

    const stored = await storage.remoteServers.getById(serverId);
    expect(stored?.cross_remote_access).toBe("off");
  });

  it("leaves the tier alone when the field is omitted", async () => {
    await put({ crossRemoteAccess: "exec" });
    const res = await put({ name: "renamed" });
    expect(res.json().cross_remote_access).toBe("exec");
  });

  it("never returns the api key", async () => {
    const res = await put({ crossRemoteAccess: "read" });
    expect(res.json().api_key).toBeUndefined();
  });
});

describe("inbound server lifecycle (create → id → connect token)", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-rsr-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    await app.register(remoteServerRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a server from a bare name and returns the server object directly", async () => {
    const res = await app.inject({ method: "POST", url: "/api/remote-servers", payload: { name: "worker-1" } });
    expect(res.statusCode).toBe(201);
    const server = res.json();
    // Contract: the handler replies with the sanitized server itself, not { server } —
    // the UI reads .id off this response to drive the token flow.
    expect(server.id).toBeTypeOf("string");
    expect(server.name).toBe("worker-1");
    expect(server.api_key).toBeUndefined();
    expect(server.connect_token).toBeUndefined();
  });

  it("rejects a missing name", async () => {
    const res = await app.inject({ method: "POST", url: "/api/remote-servers", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("generates a connect token + command for the created server", async () => {
    const created = await app.inject({ method: "POST", url: "/api/remote-servers", payload: { name: "worker-2" } });
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/api/remote-servers/${id}/connect-token` });
    expect(res.statusCode).toBe(200);
    const { token, connectCommand } = res.json();
    expect(token).toBeTypeOf("string");
    expect(token.length).toBeGreaterThan(0);
    expect(connectCommand).toContain("connect --connect-to");
    expect(connectCommand).toContain(`--token ${token}`);

    // Token is persisted and resolvable — the worker will authenticate with it.
    const byToken = await storage.remoteServers.getByToken(token);
    expect(byToken?.id).toBe(id);
  });

  it("returns the same token on repeat connect-token reads", async () => {
    const created = await app.inject({ method: "POST", url: "/api/remote-servers", payload: { name: "worker-4" } });
    const id = created.json().id as string;

    const first = await app.inject({ method: "POST", url: `/api/remote-servers/${id}/connect-token` });
    const second = await app.inject({ method: "POST", url: `/api/remote-servers/${id}/connect-token` });
    expect(second.statusCode).toBe(200);
    // The connect command handed out to a worker must stay stable — re-opening
    // the token dialog is a read, not a rotation.
    expect(second.json().token).toBe(first.json().token);
    expect(second.json().connectCommand).toBe(first.json().connectCommand);
  });

  it("connect-token/rotate issues a new token and invalidates the old one", async () => {
    const created = await app.inject({ method: "POST", url: "/api/remote-servers", payload: { name: "worker-5" } });
    const id = created.json().id as string;

    const old = (await app.inject({ method: "POST", url: `/api/remote-servers/${id}/connect-token` })).json().token;
    const res = await app.inject({ method: "POST", url: `/api/remote-servers/${id}/connect-token/rotate` });
    expect(res.statusCode).toBe(200);
    const { token, connectCommand } = res.json();
    expect(token).not.toBe(old);
    expect(connectCommand).toContain(`--token ${token}`);

    expect(await storage.remoteServers.getByToken(old)).toBeUndefined();
    expect((await storage.remoteServers.getByToken(token))?.id).toBe(id);

    // Subsequent reads return the rotated token, not another new one.
    const after = await app.inject({ method: "POST", url: `/api/remote-servers/${id}/connect-token` });
    expect(after.json().token).toBe(token);
  });

  it("404s on connect-token read/rotate for an unknown server", async () => {
    for (const route of ["connect-token", "connect-token/rotate"]) {
      const res = await app.inject({ method: "POST", url: `/api/remote-servers/nope/${route}` });
      expect(res.statusCode).toBe(404);
    }
  });

  it("revokes the connect token via DELETE", async () => {
    const created = await app.inject({ method: "POST", url: "/api/remote-servers", payload: { name: "worker-6" } });
    const id = created.json().id as string;

    const token = (await app.inject({ method: "POST", url: `/api/remote-servers/${id}/connect-token` })).json().token;
    const res = await app.inject({ method: "DELETE", url: `/api/remote-servers/${id}/connect-token` });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(await storage.remoteServers.getByToken(token)).toBeUndefined();

    // DELETE /:id must still delete the server itself, not be shadowed by the above.
    const del = await app.inject({ method: "DELETE", url: `/api/remote-servers/${id}` });
    expect(del.statusCode).toBe(200);
  });

  it("reports reverse-connect status on /test", async () => {
    const created = await app.inject({ method: "POST", url: "/api/remote-servers", payload: { name: "worker-3" } });
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/api/remote-servers/${id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, status: "offline" });
  });
});

describe("GET /api/remote-servers worker upgrade annotation", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-rsr-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    await app.register(remoteServerRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("annotates each server with its update status against the cached npm latest", async () => {
    primeNpmLatestCacheForTests("0.3.3");
    const behind = await storage.remoteServers.create({ name: "behind" });
    const current = await storage.remoteServers.create({ name: "current" });
    await storage.remoteServers.create({ name: "silent" });
    await storage.remoteServers.updateWorkerVersion(behind.id, "0.3.1", []);
    await storage.remoteServers.updateWorkerVersion(current.id, "0.3.3", ["http:GET /x"]);

    const res = await app.inject({ method: "GET", url: "/api/remote-servers" });
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(
      (res.json() as Array<{ name: string; worker_version?: string; worker_update_status: string; latest_worker_version?: string; connect_token?: string }>)
        .map((s) => [s.name, s]),
    );
    expect(byName.behind.worker_update_status).toBe("behind-latest");
    expect(byName.behind.worker_version).toBe("0.3.1");
    expect(byName.behind.latest_worker_version).toBe("0.3.3");
    expect(byName.current.worker_update_status).toBe("current");
    expect(byName.silent.worker_update_status).toBe("unreported");
    expect(byName.silent.connect_token).toBeUndefined();
  });
});
