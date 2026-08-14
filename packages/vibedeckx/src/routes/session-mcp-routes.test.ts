import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import { getSessionToolsSecret, signSessionToolsToken } from "../utils/session-tools-token.js";
import { getCrossRemoteSecret, signCrossRemoteToken } from "../utils/cross-remote-token.js";
import { CANONICAL_PROPOSE_SCHEDULE_TOOL, PROPOSE_SCHEDULE_TOOL } from "../session-tools-mcp.js";
import sessionMcpRoutes from "./session-mcp-routes.js";

describe("session tools MCP endpoint", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let secret: string;
  let alive: boolean;

  const rpc = (token: string | null, body: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/session-mcp",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });

  const propose = (token: string, args: Record<string, unknown>) =>
    rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: PROPOSE_SCHEDULE_TOOL, arguments: args } });

  const validArgs = { name: "Watch flakiness", cron_expr: "0 9 * * *", prompt: "Check the nightly build" };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-sessmcp-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    secret = await getSessionToolsSecret(storage);
    alive = true;

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("agentSessionManager", { getSessionProcessAlive: () => alive } as never);
    await app.register(sessionMcpRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const tokenFor = (sessionId = "sess-1") => signSessionToolsToken(secret, { sessionId }, Date.now());

  it("rejects a request with no token", async () => {
    expect((await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(401);
  });

  it("rejects a forged token", async () => {
    const forged = signSessionToolsToken("wrong-secret", { sessionId: "sess-1" }, Date.now());
    expect((await rpc(forged, { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    const expired = signSessionToolsToken(secret, { sessionId: "sess-1" }, Date.now() - 1, 1);
    expect((await rpc(expired, { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(401);
  });

  it("rejects a cross-remote token — the two audiences never overlap", async () => {
    const crossSecret = await getCrossRemoteSecret(storage);
    const crossToken = signCrossRemoteToken(
      crossSecret, { userId: "u1", sessionId: "sess-1", sourceRemoteServerId: null }, Date.now(),
    );
    expect((await rpc(crossToken, { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(401);
  });

  it("rejects a token whose session process is gone", async () => {
    alive = false;
    expect((await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(401);
  });

  it("lists only propose_schedule", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.statusCode).toBe(200);
    const tools = res.json().result.tools as Array<{ name: string; description: string }>;
    expect(tools.map((t) => t.name)).toEqual([PROPOSE_SCHEDULE_TOOL]);
    // The description is the only place the agent learns it must not claim the
    // schedule was created — a regression there is silent otherwise.
    expect(tools[0].description).toMatch(/SUGGESTED/);
  });

  it("answers initialize and ping", async () => {
    const init = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.json().result.serverInfo.name).toBe("vibedeckx-session-tools");
    expect((await rpc(tokenFor(), { jsonrpc: "2.0", id: 2, method: "ping" })).json().result).toEqual({});
  });

  it("acknowledges a valid proposal without creating anything", async () => {
    const res = await propose(tokenFor(), validArgs);
    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Nothing has been created yet/);
    // Fire-and-forget: the tool_use message in the conversation is the only artifact.
    expect(await storage.scheduledTasks.getAllEnabled()).toEqual([]);
  });

  it("rejects an invalid cron expression so the agent can fix it in the same turn", async () => {
    const res = await propose(tokenFor(), { ...validArgs, cron_expr: "not a cron" });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toMatch(/Invalid cron expression/);
  });

  it("rejects an invalid timezone", async () => {
    const res = await propose(tokenFor(), { ...validArgs, timezone: "Mars/Olympus" });
    expect(res.json().result.isError).toBe(true);
  });

  it("rejects missing required arguments", async () => {
    for (const missing of ["name", "cron_expr", "prompt"]) {
      const args: Record<string, unknown> = { ...validArgs };
      delete args[missing];
      const res = await propose(tokenFor(), args);
      expect(res.json().result.isError, missing).toBe(true);
    }
  });

  it("rejects an unknown tool, including the canonical UI-facing name", async () => {
    for (const name of ["remote_bash", CANONICAL_PROPOSE_SCHEDULE_TOOL]) {
      const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
      expect(res.json().result.isError, name).toBe(true);
    }
  });

  it("accepts notifications with no id and rejects malformed envelopes", async () => {
    expect((await rpc(tokenFor(), { jsonrpc: "2.0", method: "notifications/initialized" })).statusCode).toBe(202);
    expect((await rpc(tokenFor(), { hello: "world" })).statusCode).toBe(400);
  });
});
