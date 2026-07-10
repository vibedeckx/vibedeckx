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
    const created = await storage.remoteServers.create({ name: "b", url: "http://b:5173" });
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
