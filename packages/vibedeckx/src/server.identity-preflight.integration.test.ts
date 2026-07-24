import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { CONNECT_IDENTITY_HEADER } from "./connect-preflight.js";

/**
 * Full-server integration test for the identity-preflight auth exemptions.
 * server.ts reads VIBEDECKX_API_KEY at module load, so the env var is set
 * before a fresh dynamic import. This is the deployment the capability
 * discovery exists for: an API-key-protected hub where a token-only HTTP
 * request would be 401'd by the global middleware unless explicitly exempted.
 */
describe("identity preflight through an API-key-protected server", () => {
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
    const inbound = await storage.remoteServers.create({
      name: "worker-a",
      url: null,
      connection_mode: "inbound",
    });
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

  it("still guards every other /api route", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("Unauthorized");
  });
});
