import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import remoteServerRoutes from "./remote-server-routes.js";

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

    const res = await app.inject({ method: "POST", url: `/api/remote-servers/${id}/generate-token` });
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

  it("reports reverse-connect status on /test", async () => {
    const created = await app.inject({ method: "POST", url: "/api/remote-servers", payload: { name: "worker-3" } });
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/api/remote-servers/${id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, status: "offline" });
  });
});
