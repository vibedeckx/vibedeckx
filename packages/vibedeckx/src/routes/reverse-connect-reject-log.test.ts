import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import reverseConnectRoutes from "./reverse-connect-routes.js";

// A worker holding a revoked/rotated connect token retries indefinitely. Before
// this logging the hub closed those upgrades before printing anything, so its
// log showed no trace of hundreds of rejections — the outage was invisible from
// the server side.
describe("rejected reverse-connect upgrades are logged", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-rcr-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));

    app = Fastify();
    app.decorate("storage", storage);
    await app.register(fastifyWebsocket);
    await app.register(reverseConnectRoutes);
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const knock = (query: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/reverse-connect${query}`);
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => resolve(-1));
    });

  it("warns on an unrecognized token without echoing it, then rate-limits repeats", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await knock("?token=long-dead-token")).toBe(4001);
    expect(warn).toHaveBeenCalledTimes(1);
    const first = String(warn.mock.calls[0]?.[0]);
    expect(first).toMatch(/token not recognized/i);
    expect(first).toContain("127.0.0.1");
    // The token is the secret in play — the source address is what identifies
    // the stuck worker.
    expect(first).not.toContain("long-dead-token");

    // Same source knocking again inside the window must not add log lines.
    expect(await knock("?token=long-dead-token")).toBe(4001);
    expect(await knock("?token=another-dead-token")).toBe(4001);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns when no token is supplied at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await knock("")).toBe(4001);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/no connect token/i);
  });

  it("warns and closes 4003 when the machine auth reply is malformed", async () => {
    const server = await storage.remoteServers.create({ name: "worker-bad-auth" });
    const token = (await storage.remoteServers.generateToken(server.id))!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/reverse-connect?token=${token}`);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    // Answers the challenge, but without the key/signature the hub needs.
    ws.send(JSON.stringify({ type: "machine_auth" }));

    expect(await closed).toBe(4003);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toMatch(/malformed machine auth/i);
    expect(line).toContain(server.id);
  });

  it("stays quiet for a valid token", async () => {
    const server = await storage.remoteServers.create({ name: "worker-ok" });
    const token = (await storage.remoteServers.generateToken(server.id))!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/reverse-connect?token=${token}`);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    expect(warn).not.toHaveBeenCalled();
    ws.close();
  });
});
