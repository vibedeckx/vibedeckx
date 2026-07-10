import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import { signCrossRemoteToken, getCrossRemoteSecret } from "../utils/cross-remote-token.js";

const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("../utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyStatus: (r: { status: number }, fallback = 502) => (r.status === 0 ? fallback : r.status),
}));

// vi.mock is hoisted above imports, so this static import receives the mocked module.
import crossRemoteMcpRoutes from "./cross-remote-mcp-routes.js";

describe("cross-remote MCP gateway", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let secret: string;
  let targetId: string;

  const rpc = (token: string | null, body: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/cross-remote-mcp",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });

  const tokenFor = (over: { userId?: string; sessionId?: string; sourceRemoteServerId?: string | null } = {}) =>
    signCrossRemoteToken(
      secret,
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: "srv-a", ...over },
      Date.now(),
    );

  const call = (token: string, name: string, args: Record<string, unknown>) =>
    rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xrmcp-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    secret = await getCrossRemoteSecret(storage);

    const target = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
    targetId = target.id;
    await storage.remoteServers.update(targetId, { cross_remote_access: "exec" }, "user-1");

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    app.decorate("remoteSessionMap", new Map());
    app.decorate("agentSessionManager", { getSessionProcessAlive: () => true } as never);
    await app.register(crossRemoteMcpRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a request with no token", async () => {
    const res = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a forged token", async () => {
    const forged = signCrossRemoteToken("wrong-secret", { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: null }, Date.now());
    const res = await rpc(forged, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token whose session no longer exists", async () => {
    app.agentSessionManager.getSessionProcessAlive = () => false;
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.statusCode).toBe(401);
  });

  it("answers initialize with protocol and server info", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.serverInfo.name).toBe("vibedeckx-cross-remote");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("returns 202 with no body for the initialized notification", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.statusCode).toBe(202);
  });

  it("lists all six tools", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = res.json().result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "list_accessible_remotes",
      "remote_bash",
      "remote_list_dir",
      "remote_process_list",
      "remote_read_file",
      "remote_stat_path",
    ]);
  });

  it("returns a JSON-RPC error for an unknown method", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "nope" });
    expect(res.json().error.code).toBe(-32601);
  });

  it("list_accessible_remotes excludes the source remote", async () => {
    const source = await storage.remoteServers.create({ name: "a", url: "http://a:5173" }, "user-1");
    await storage.remoteServers.update(source.id, { cross_remote_access: "exec" }, "user-1");

    const res = await call(tokenFor({ sourceRemoteServerId: source.id }), "list_accessible_remotes", {});
    const text = res.json().result.content[0].text;
    expect(text).toContain(targetId);
    expect(text).not.toContain(source.id);
  });

  it("forwards remote_bash to the target and returns its output", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { stdout: "linux\n", stderr: "", exitCode: 0, timedOut: false, truncated: false },
    });

    const res = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uname" });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.content[0].text).toContain("linux");

    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      targetId,
      "http://b:5173",
      "",
      "POST",
      "/api/path/cross-remote/exec",
      { command: "uname", cwd: undefined, timeoutSec: undefined },
      expect.anything(),
    );
  });

  it("writes an audit row for a successful call", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true, status: 200,
      data: { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false },
    });
    await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uptime" });

    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "user-1",
      session_id: "sess-1",
      source_remote_id: "srv-a",
      tool_name: "remote_bash",
      args_summary: "uptime",
      exit_code: 0,
      status: "ok",
    });
  });

  it("denies remote_bash against a read-tier target and audits the denial", async () => {
    await storage.remoteServers.update(targetId, { cross_remote_access: "read" }, "user-1");

    const res = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "rm -rf /" });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toContain("not found or not accessible");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();

    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows[0].status).toBe("denied");
    expect(rows[0].exit_code).toBeNull();
  });

  it("allows a read-tier tool against a read-tier target", async () => {
    await storage.remoteServers.update(targetId, { cross_remote_access: "read" }, "user-1");
    proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { content: "log line", truncated: false, size: 8 } });

    const res = await call(tokenFor(), "remote_read_file", { remoteId: targetId, path: "/var/log/app.log" });
    expect(res.json().result.isError).toBeUndefined();
    expect(res.json().result.content[0].text).toContain("log line");
  });

  it("denies a target owned by another user without leaking existence", async () => {
    const other = await storage.remoteServers.create({ name: "other", url: "http://o:5173" }, "user-2");
    await storage.remoteServers.update(other.id, { cross_remote_access: "exec" }, "user-2");

    const res = await call(tokenFor(), "remote_bash", { remoteId: other.id, command: "id" });
    expect(res.json().result.content[0].text).toContain("not found or not accessible");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("reports an offline target and audits it", async () => {
    const inbound = await storage.remoteServers.create({ name: "c", url: null, connection_mode: "inbound" }, "user-1");
    await storage.remoteServers.update(inbound.id, { cross_remote_access: "exec" }, "user-1");

    const res = await call(tokenFor(), "remote_bash", { remoteId: inbound.id, command: "uptime" });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toContain("offline");

    const rows = await storage.crossRemoteAudit.listByTarget(inbound.id);
    expect(rows[0].status).toBe("offline");
  });

  it("surfaces a proxy failure as a tool error", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 0, data: { error: "boom" }, errorCode: "network_error" });

    const res = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uptime" });
    expect(res.json().result.isError).toBe(true);

    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows[0].status).toBe("error");
  });

  it("rejects a tool call missing remoteId", async () => {
    const res = await call(tokenFor(), "remote_bash", { command: "uptime" });
    expect(res.json().result.isError).toBe(true);
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("rejects an unknown tool name", async () => {
    const res = await call(tokenFor(), "remote_launch_missiles", { remoteId: targetId });
    expect(res.json().result.isError).toBe(true);
  });

  it("truncates args_summary at 1KB", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true, status: 200,
      data: { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false },
    });
    const long = "x".repeat(3000);
    await call(tokenFor(), "remote_bash", { remoteId: targetId, command: long });

    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows[0].args_summary.length).toBe(1024);
  });
});
