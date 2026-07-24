import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import reverseConnectRoutes from "./reverse-connect-routes.js";
import { CONNECT_IDENTITY_HEADER } from "../connect-preflight.js";

describe("GET /api/reverse-connect/identity", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let inboundId: string;
  let inboundToken: string;
  let outboundToken: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-rci-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));

    const inbound = await storage.remoteServers.create({
      name: "worker-a",
      url: null,
      connection_mode: "inbound",
    });
    inboundId = inbound.id;
    inboundToken = (await storage.remoteServers.generateToken(inbound.id))!;

    const outbound = await storage.remoteServers.create({
      name: "direct-b",
      url: "http://b:5173",
      connection_mode: "outbound",
    });
    outboundToken = (await storage.remoteServers.generateToken(outbound.id))!;

    app = Fastify();
    app.decorate("storage", storage);
    await app.register(fastifyWebsocket);
    await app.register(reverseConnectRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (token?: string) =>
    app.inject({
      method: "GET",
      url: "/api/reverse-connect/identity",
      headers: token ? { [CONNECT_IDENTITY_HEADER]: token } : {},
    });

  it("401s without a token", async () => {
    const res = await get();
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/token required/i);
  });

  it("401s on an unknown token", async () => {
    const res = await get("no-such-token");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/invalid/i);
  });

  it("403s when the token's record is not inbound", async () => {
    const res = await get(outboundToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/inbound/i);
  });

  it("returns the record's id and name for a valid inbound token", async () => {
    const res = await get(inboundToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId: inboundId, name: "worker-a" });
  });

  it("never leaks the token or api key in the response", async () => {
    const res = await get(inboundToken);
    expect(res.body).not.toContain(inboundToken);
    expect(res.json().connect_token).toBeUndefined();
    expect(res.json().api_key).toBeUndefined();
  });
});
