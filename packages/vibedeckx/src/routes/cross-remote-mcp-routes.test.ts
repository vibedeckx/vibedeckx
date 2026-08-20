import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import { signCrossRemoteToken, getCrossRemoteSecret } from "../utils/cross-remote-token.js";
import { REMOTE_MCP_CAPABILITIES } from "../cross-remote-access.js";

const STDIO = { type: "stdio", command: "fake-mcp" } as const;

const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("../utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyStatus: (r: { status: number }, fallback = 502) => (r.status === 0 ? fallback : r.status),
}));

// vi.mock is hoisted above imports, so this static import receives the mocked module.
import crossRemoteMcpRoutes, { CROSS_REMOTE_MCP_INSTRUCTIONS } from "./cross-remote-mcp-routes.js";

describe("cross-remote MCP gateway", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let secret: string;
  let targetId: string;
  let connected: Set<string>;

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

    const target = await storage.remoteServers.create({ name: "b" }, "user-1");
    targetId = target.id;
    await storage.remoteServers.update(targetId, { cross_remote_access: "exec" }, "user-1");
    await storage.remoteServers.updateWorkerVersion(targetId, "0.3.23", [...REMOTE_MCP_CAPABILITIES]);
    connected = new Set([targetId]);

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: (id: string) => connected.has(id) } as never);
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
    expect(body.result.instructions).toBe(CROSS_REMOTE_MCP_INSTRUCTIONS);
    expect(body.result.instructions).toContain("inspect files, directories, paths, and processes");
    expect(body.result.instructions).toContain("run commands on exec-tier remotes");
    expect(body.result.instructions).toContain("remote_mcp_open");
    expect(body.result.instructions).toContain("Do not reopen");
    expect(body.result.instructions).toContain("look at the ubuntu machine");
    expect(body.result.instructions).toContain("If exactly one accessible remote matches");
    expect(body.result.instructions).toContain("ask the user which target they mean");
    expect(body.result.instructions).toContain("instead of silently falling back to local");
  });

  it("returns 202 with no body for the initialized notification", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.statusCode).toBe(202);
  });

  it("lists the remote and broker tools", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = res.json().result.tools as Array<{ name: string; description: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "list_accessible_remotes",
      "remote_bash",
      "remote_list_dir",
      "remote_mcp_call",
      "remote_mcp_close",
      "remote_mcp_list_tools",
      "remote_mcp_open",
      "remote_mcp_ping",
      "remote_process_list",
      "remote_read_file",
      "remote_stat_path",
    ]);
    expect(tools.find((t) => t.name === "list_accessible_remotes")?.description)
      .toContain("whenever the user names or otherwise identifies a machine/host");
  });

  it("opens a broker session, signs its handle, and reuses it for a tool call", async () => {
    proxyToRemoteAuto
      .mockResolvedValueOnce({ ok: true, status: 200, data: { workerHandle: "worker-1", serverInfo: { name: "fake" }, tools: [{ name: "echo" }] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { result: { content: [{ type: "text", text: "ok" }] } } });

    const opened = await call(tokenFor(), "remote_mcp_open", {
      remoteId: targetId,
      transport: { type: "stdio", command: "fake-mcp", args: ["--stdio"] },
      serverLabel: "fake",
      timeoutSec: 10,
    });
    const openData = JSON.parse(opened.json().result.content[0].text);
    expect(openData.handle).toMatch(/^mcp\./);
    expect(openData.workerHandle).toBeUndefined();
    expect(proxyToRemoteAuto).toHaveBeenNthCalledWith(
      1,
      targetId,
      "POST",
      "/api/path/cross-remote/mcp/open",
      expect.anything(),
      expect.objectContaining({ timeoutMs: 25_000 }),
    );

    const called = await call(tokenFor(), "remote_mcp_call", {
      handle: openData.handle, tool: "echo", arguments: { text: "ok" }, timeoutSec: 40,
    });
    expect(called.json().result.isError).toBeUndefined();
    expect(proxyToRemoteAuto).toHaveBeenLastCalledWith(
      targetId,
      "POST",
      "/api/path/cross-remote/mcp/call",
      { workerHandle: "worker-1", tool: "echo", arguments: { text: "ok" }, timeoutSec: 40 },
      expect.objectContaining({ timeoutMs: 45_000 }),
    );
  });

  it("rejects a broker handle from another source session", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { workerHandle: "worker-1", tools: [] } });
    const opened = await call(tokenFor(), "remote_mcp_open", { remoteId: targetId, transport: STDIO });
    const handle = JSON.parse(opened.json().result.content[0].text).handle;
    proxyToRemoteAuto.mockClear();
    const res = await call(tokenFor({ sessionId: "sess-2" }), "remote_mcp_ping", { handle });
    expect(res.json().result.isError).toBe(true);
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("derives the audit label from the transport when serverLabel is empty", async () => {
    proxyToRemoteAuto
      .mockResolvedValueOnce({ ok: true, status: 200, data: { workerHandle: "worker-1", tools: [] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true } });
    const opened = await call(tokenFor(), "remote_mcp_open", {
      remoteId: targetId, transport: STDIO, serverLabel: "",
    });
    const handle = JSON.parse(opened.json().result.content[0].text).handle;
    const pinged = await call(tokenFor(), "remote_mcp_ping", { handle });
    expect(pinged.json().result.isError).toBeUndefined();
    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows.at(-1)?.args_summary).toContain("server=fake-mcp transport=stdio");
    expect(proxyToRemoteAuto).toHaveBeenLastCalledWith(
      targetId,
      "POST",
      "/api/path/cross-remote/mcp/ping",
      expect.objectContaining({ workerHandle: "worker-1" }),
      expect.anything(),
    );
  });

  it("degrades before proxying when a worker lacks MCP broker capabilities", async () => {
    const old = await storage.remoteServers.create({ name: "old" }, "user-1");
    await storage.remoteServers.update(old.id, { cross_remote_access: "exec" }, "user-1");
    connected.add(old.id);
    const res = await call(tokenFor(), "remote_mcp_open", { remoteId: old.id, transport: STDIO });
    expect(res.json().result.content[0].text).toContain("upgrade");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("requires exec access for broker operations", async () => {
    await storage.remoteServers.update(targetId, { cross_remote_access: "read" }, "user-1");
    const res = await call(tokenFor(), "remote_mcp_open", { remoteId: targetId, transport: STDIO });
    expect(res.json().result.isError).toBe(true);
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("audits downstream MCP errors with tool and argument keys but not values", async () => {
    proxyToRemoteAuto
      .mockResolvedValueOnce({ ok: true, status: 200, data: { workerHandle: "worker-1", tools: [] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { result: { isError: true, content: [] } } });
    const opened = await call(tokenFor(), "remote_mcp_open", { remoteId: targetId, transport: STDIO, serverLabel: "safe" });
    const handle = JSON.parse(opened.json().result.content[0].text).handle;
    const called = await call(tokenFor(), "remote_mcp_call", { handle, tool: "login", arguments: { password: "never-log-me", user: "j" } });
    expect(called.json().result.isError).toBe(true);
    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows[0]).toMatchObject({ tool_name: "remote_mcp_call", status: "error" });
    expect(rows[0].args_summary).toContain("tool=login");
    expect(rows[0].args_summary).toContain("argKeys=password,user");
    expect(rows[0].args_summary).not.toContain("never-log-me");
    expect(rows[1]).toMatchObject({ tool_name: "remote_mcp_open", status: "ok" });
    expect(rows[1].args_summary).toContain("server=safe transport=stdio command=fake-mcp argCount=0");
  });

  it("opens a streamable-http session and audits only the safe part of the URL", async () => {
    proxyToRemoteAuto.mockResolvedValueOnce({ ok: true, status: 200, data: { workerHandle: "worker-1", transport: "streamable-http", tools: [] } });

    const opened = await call(tokenFor(), "remote_mcp_open", {
      remoteId: targetId,
      transport: {
        type: "streamable-http",
        url: "http://user:pass@127.0.0.1:8080/mcp?token=secret#x",
        headers: { Authorization: "Bearer super-secret" },
      },
    });
    expect(JSON.parse(opened.json().result.content[0].text).handle).toMatch(/^mcp\./);
    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      targetId,
      "POST",
      "/api/path/cross-remote/mcp/open",
      {
        transport: {
          type: "streamable-http",
          url: "http://user:pass@127.0.0.1:8080/mcp?token=secret#x",
          headers: { Authorization: "Bearer super-secret" },
        },
        timeoutSec: undefined,
      },
      expect.anything(),
    );

    const [row] = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(row.args_summary).toBe("server=127.0.0.1:8080/mcp transport=streamable-http");
    for (const secret of ["super-secret", "Authorization", "token=secret", "user:pass"]) {
      expect(row.args_summary).not.toContain(secret);
    }
  });

  it("rejects an unknown or malformed transport before proxying", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "websocket", url: "ws://127.0.0.1/mcp" }, "Unsupported MCP transport type: websocket"],
      [{ type: "streamable-http", url: "file:///etc/passwd" }, "http: or https:"],
      [{ type: "streamable-http", url: "http://127.0.0.1/mcp", command: "npx" }, "does not accept command"],
      [{ type: "stdio", command: "npx", url: "http://127.0.0.1/mcp" }, "does not accept url"],
      [{ type: "stdio", command: "npx", cwd: "relative/dir" }, "absolute path"],
    ];
    for (const [transport, expected] of cases) {
      const res = await call(tokenFor(), "remote_mcp_open", { remoteId: targetId, transport });
      expect(res.json().result.isError).toBe(true);
      expect(res.json().result.content[0].text).toContain(expected);
    }
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("surfaces the worker's session-expired code so the agent re-opens instead of retrying", async () => {
    proxyToRemoteAuto
      .mockResolvedValueOnce({ ok: true, status: 200, data: { workerHandle: "worker-1", tools: [] } })
      .mockResolvedValueOnce({
        ok: false,
        status: 410,
        data: { code: "MCP_SESSION_EXPIRED", error: "Remote MCP session expired; call remote_mcp_open again" },
      });
    const opened = await call(tokenFor(), "remote_mcp_open", { remoteId: targetId, transport: STDIO });
    const handle = JSON.parse(opened.json().result.content[0].text).handle;

    const called = await call(tokenFor(), "remote_mcp_call", { handle, tool: "echo" });
    const text = called.json().result.content[0].text;
    expect(called.json().result.isError).toBe(true);
    expect(text).toContain("MCP_SESSION_EXPIRED");
    expect(text).toContain("remote_mcp_open again");
  });

  it("returns a JSON-RPC error for an unknown method", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "nope" });
    expect(res.json().error.code).toBe(-32601);
  });

  it("list_accessible_remotes excludes the source remote", async () => {
    const source = await storage.remoteServers.create({ name: "a" }, "user-1");
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

  it("still returns the normal tool result when the audit insert rejects", async () => {
    const auditError = new Error("audit db unavailable");
    vi.spyOn(storage.crossRemoteAudit, "insert").mockRejectedValueOnce(auditError);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { stdout: "linux\n", stderr: "", exitCode: 0, timedOut: false, truncated: false },
    });

    const res = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uname" });

    expect(res.statusCode).toBe(200);
    expect(res.json().result.isError).toBeUndefined();
    expect(res.json().result.content[0].text).toContain("linux");
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
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
    const other = await storage.remoteServers.create({ name: "other" }, "user-2");
    await storage.remoteServers.update(other.id, { cross_remote_access: "exec" }, "user-2");

    const res = await call(tokenFor(), "remote_bash", { remoteId: other.id, command: "id" });
    expect(res.json().result.content[0].text).toContain("not found or not accessible");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("reports an unconnected target as offline and audits it", async () => {
    const unconnected = await storage.remoteServers.create({ name: "c" }, "user-1");
    await storage.remoteServers.update(unconnected.id, { cross_remote_access: "exec" }, "user-1");

    const res = await call(tokenFor(), "remote_bash", { remoteId: unconnected.id, command: "uptime" });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toContain("offline");

    const rows = await storage.crossRemoteAudit.listByTarget(unconnected.id);
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

  it("rejects a 5th concurrent call for the same session while 4 are in flight, and frees a slot once one completes", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    proxyToRemoteAuto.mockImplementation(() => pending);

    const inFlight = [1, 2, 3, 4].map(() => call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uptime" }));

    // Wait until all 4 have actually reached the (blocked) transport call, i.e. each has
    // acquired a concurrency-guard slot, before firing the 5th. Fastify's inject() involves
    // its own async scheduling, so we can't assume 4 synchronous "fire and forget" calls have
    // all reached guard.acquire() by the time control returns here — poll for it instead.
    const deadline = Date.now() + 2000;
    while (proxyToRemoteAuto.mock.calls.length < 4) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for 4 in-flight calls to reach the transport");
      await new Promise((r) => setTimeout(r, 5));
    }

    const fifth = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uptime" });
    expect(fifth.json().result.isError).toBe(true);
    expect(fifth.json().result.content[0].text).toContain("Too many concurrent");
    // The 5th call never touched the transport.
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(4);

    release({
      ok: true,
      status: 200,
      data: { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false },
    });
    const settled = await Promise.all(inFlight);
    for (const res of settled) {
      expect(res.json().result.isError).toBeUndefined();
    }

    // A slot was freed by the `finally` release, so a subsequent call succeeds.
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false },
    });
    const after = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uptime" });
    expect(after.json().result.isError).toBeUndefined();
  });

  it("answers a tools/call with no id (a notification) with 202 and no body, without invoking the tool", async () => {
    const res = await rpc(tokenFor(), {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "remote_bash", arguments: { remoteId: targetId, command: "uptime" } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("catches a rejected proxyToRemoteAuto (inbound transport failure) as a tool error and audits it", async () => {
    proxyToRemoteAuto.mockRejectedValue(new Error("reverse-connect channel closed"));

    const res = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uptime" });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).not.toMatch(/^Internal Server Error/);

    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
  });

  it("rejects an inherited Object.prototype property used as a tool name, without invoking the tool", async () => {
    // Pin the actual gate: TOOL_TIERS has no own "toString" property, so
    // Object.hasOwn(TOOL_TIERS, "toString") is false and callTool must short-circuit with
    // the unknown-tool message *before* ever reaching buildTargetCall's "Invalid arguments"
    // path (which, before the Object.hasOwn fix, is what a bare `if (!tier)` check would
    // have fallen through to instead, via buildTargetCall's switch default returning null).
    const res = await call(tokenFor(), "toString", { remoteId: targetId });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toBe("Unknown tool: toString");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("rejects the inherited 'constructor' property used as a tool name, without invoking the tool", async () => {
    const res = await call(tokenFor(), "constructor", { remoteId: targetId });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toBe("Unknown tool: constructor");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });
});
