import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { CONNECT_IDENTITY_HEADER } from "./connect-preflight.js";

/**
 * Full-server integration test for identity preflight on a hub that has an
 * operator key configured. server.ts reads VIBEDECKX_API_KEY at module load, so
 * the env var is set before a fresh dynamic import.
 *
 * The key gates /api/admin/* only, so nothing here should need an exemption —
 * these cases pin that down from the outside, since the reverse-connect
 * handshake is the flow that a broader gate used to break.
 */
describe("identity preflight on a server with an operator key configured", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;
  let inboundId: string;
  let inboundToken: string;

  beforeAll(async () => {
    process.env.VIBEDECKX_API_KEY = "test-api-key";
    vi.resetModules();
    const { createServer } = await import("./server.js");
    const { createSqliteStorage } = await import("./storage/sqlite.js");

    dir = mkdtempSync(path.join(tmpdir(), "vdx-ipf-"));
    const storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    const inbound = await storage.remoteServers.create({ name: "worker-a" });
    inboundId = inbound.id;
    inboundToken = (await storage.remoteServers.generateToken(inbound.id))!;

    const server = await createServer({ storage, uiRoot: null });
    const started = await server.startLocal(0);
    baseUrl = started.url;
    close = async () => {
      await server.close();
      await storage.close();
    };
  }, 30_000);

  afterAll(async () => {
    delete process.env.VIBEDECKX_API_KEY;
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves /api/config publicly with the capability flag", async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reverseConnectIdentity?: boolean }).reverseConnectIdentity).toBe(true);
  });

  it("lets a token-only identity request through to the handler", async () => {
    const res = await fetch(`${baseUrl}/api/reverse-connect/identity`, {
      headers: { [CONNECT_IDENTITY_HEADER]: inboundToken },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ serverId: inboundId, name: "worker-a" });
  });

  it("401s from the handler (not the middleware) when the token is missing or bad", async () => {
    // The middleware's rejection body is a bare "Unauthorized"; reaching the
    // handler's specific messages proves the exemption worked.
    const missing = await fetch(`${baseUrl}/api/reverse-connect/identity`);
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: string }).error).toMatch(/token required/i);

    const bad = await fetch(`${baseUrl}/api/reverse-connect/identity`, {
      headers: { [CONNECT_IDENTITY_HEADER]: "wrong" },
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: string }).error).toMatch(/invalid/i);
  });

  it("does not gate ordinary /api routes — the UI's requests must not need the key", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
  });

  it("gates /api/admin/* on the operator key", async () => {
    const withoutKey = await fetch(`${baseUrl}/api/admin/worker-version-stats`);
    expect(withoutKey.status).toBe(404);

    const wrongKey = await fetch(`${baseUrl}/api/admin/worker-version-stats`, {
      headers: { "x-vibedeckx-api-key": "not-the-key" },
    });
    expect(wrongKey.status).toBe(404);

    const withKey = await fetch(`${baseUrl}/api/admin/worker-version-stats`, {
      headers: { "x-vibedeckx-api-key": "test-api-key" },
    });
    expect(withKey.status).toBe(200);
    expect((await withKey.json()) as { workers_total: number }).toHaveProperty("workers_total");
  });

  it("lets a token-only reverse-connect WS upgrade through to the route (bad token → 4001, not HTTP 401)", async () => {
    // If the API-key middleware intercepted the upgrade, the handshake would
    // fail with "Unexpected server response: 401" before the route ever saw
    // the token. A route-level 4001 close proves the exemption worked and
    // that invalid tokens are still rejected.
    const { default: WebSocket } = await import("ws");
    const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/reverse-connect?token=wrong";
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on("close", (code) => resolve(code));
      ws.on("error", (err) => reject(err));
    });
    expect(closeCode).toBe(4001);
  });

  it("accepts the WS upgrade for a valid connect token", async () => {
    const { default: WebSocket } = await import("ws");
    const wsUrl = baseUrl.replace(/^http/, "ws") + `/api/reverse-connect?token=${encodeURIComponent(inboundToken)}`;
    const opened = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 5000);
      ws.on("open", () => { clearTimeout(timer); ws.close(); resolve(true); });
      // A 401 handshake rejection surfaces as an error event.
      ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    expect(opened).toBe(true);
  });
});
