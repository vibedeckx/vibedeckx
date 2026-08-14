import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { Storage } from "./storage/types.js";
import { PROPOSE_SCHEDULE_TOOL, mintSessionToolsMcpConfig } from "./session-tools-mcp.js";

/**
 * The seam the unit tests can't reach: a real server binds a port, publishes it
 * as the loopback origin agent processes are given, and serves the session MCP
 * endpoint there. Exercised over real HTTP, the way a spawned CLI reaches it.
 */
describe("session MCP endpoint on a real server", () => {
  let baseUrl: string;
  let storage: Storage;
  let localApiOrigin: string | null;
  let close: () => Promise<void>;
  let dir: string;
  const aliveSessions = new Set<string>(["sess-live"]);

  beforeAll(async () => {
    vi.resetModules();
    const { createServer } = await import("./server.js");
    const { createSqliteStorage } = await import("./storage/sqlite.js");

    dir = mkdtempSync(path.join(tmpdir(), "vdx-sessmcp-int-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));

    const server = await createServer({ storage, uiRoot: null });
    const started = await server.startLocal(0);
    baseUrl = started.url;
    localApiOrigin = started.instance.agentSessionManager.localApiOrigin;
    // Stand in for spawned agent processes without running a CLI.
    started.instance.agentSessionManager.getSessionProcessAlive = (id: string) => aliveSessions.has(id);
    close = async () => {
      await server.close();
      await storage.close();
    };
  }, 30_000);

  afterAll(async () => {
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (token: string, body: unknown) =>
    fetch(`${baseUrl}/api/session-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("publishes its own bound port as the origin handed to agent processes", () => {
    expect(localApiOrigin).toBe(baseUrl);
    expect(localApiOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("serves a proposal from a config minted for a live session", async () => {
    const config = await mintSessionToolsMcpConfig({ storage }, {
      sessionId: "sess-live",
      origin: localApiOrigin,
    });
    expect(config!.url).toBe(`${baseUrl}/api/session-mcp`);

    const res = await fetch(config!.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config!.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: PROPOSE_SCHEDULE_TOOL,
          arguments: { name: "Watch it", cron_expr: "0 9 * * *", prompt: "check the thing" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const result = (await res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Nothing has been created yet/);
  });

  it("refuses a config minted for a session that is not running here", async () => {
    const config = await mintSessionToolsMcpConfig({ storage }, {
      sessionId: "sess-elsewhere",
      origin: localApiOrigin,
    });
    const res = await call(config!.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
  });

  it("refuses an unauthenticated request", async () => {
    const res = await fetch(`${baseUrl}/api/session-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
