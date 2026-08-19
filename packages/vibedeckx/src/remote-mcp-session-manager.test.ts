import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  McpSessionExpiredError,
  RemoteMcpSessionLimitError,
  RemoteMcpSessionManager,
  RemoteMcpSessionNotFoundError,
} from "./remote-mcp-session-manager.js";
import { startFakeHttpMcpServer, type FakeHttpMcpServer } from "./protocol/mcp/__fixtures__/fake-http-mcp-server.js";

const STDIO_SERVER = `
  import readline from "node:readline";
  let calls = 0;
  const rl = readline.createInterface({ input: process.stdin });
  const send = (x) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...x }) + "\\n");
  rl.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "fake-stdio" }, capabilities: {} } });
    else if (m.method === "tools/list") send({ id: m.id, result: { tools: [{ name: "count" }] } });
    else if (m.method === "tools/call") send({ id: m.id, result: { content: [{ type: "text", text: String(++calls) }] } });
    else if (m.method === "ping") send({ id: m.id, result: {} });
  });
`;

describe("RemoteMcpSessionManager", () => {
  const managers: RemoteMcpSessionManager[] = [];
  const servers: FakeHttpMcpServer[] = [];
  const dirs: string[] = [];

  const manager = (...args: ConstructorParameters<typeof RemoteMcpSessionManager>) => {
    const instance = new RemoteMcpSessionManager(...args);
    managers.push(instance);
    return instance;
  };

  const httpServer = async (...args: Parameters<typeof startFakeHttpMcpServer>) => {
    const server = await startFakeHttpMcpServer(...args);
    servers.push(server);
    return server;
  };

  const stdioSpec = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vdx-mcp-mgr-"));
    dirs.push(dir);
    const file = path.join(dir, "server.mjs");
    writeFileSync(file, STDIO_SERVER);
    return { type: "stdio", command: process.execPath, args: [file], cwd: dir } as const;
  };

  afterEach(async () => {
    await Promise.allSettled(managers.splice(0).map((instance) => instance.shutdown()));
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("brokers stdio and streamable-http sessions side by side", async () => {
    const sessions = manager();
    const http = await httpServer();

    const stdio = await sessions.open(stdioSpec());
    const web = await sessions.open({ type: "streamable-http", url: http.url });

    expect(stdio.transport).toBe("stdio");
    expect(web.transport).toBe("streamable-http");
    expect(stdio.tools[0].name).toBe("count");
    expect(web.tools[0].name).toBe("echo");
    expect(sessions.size).toBe(2);

    // Each handle keeps talking to its own server, and the sessions carry state across
    // calls: the stdio child's counter keeps incrementing.
    expect(await sessions.call(stdio.workerHandle, "count", {})).toMatchObject({ content: [{ text: "1" }] });
    expect(await sessions.call(stdio.workerHandle, "count", {})).toMatchObject({ content: [{ text: "2" }] });
    expect(await sessions.call(web.workerHandle, "echo", {})).toMatchObject({ content: [{ text: "call-1" }] });
    await sessions.ping(web.workerHandle);
    expect((await sessions.listTools(web.workerHandle)).map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("rejects an invalid transport before touching the host", async () => {
    const sessions = manager();
    await expect(sessions.open({ type: "streamable-http", url: "file:///etc/passwd" })).rejects.toThrow("http: or https:");
    expect(sessions.size).toBe(0);
  });

  it("refuses to open past the session cap", async () => {
    const sessions = manager(30 * 60_000, 1);
    const http = await httpServer();
    await sessions.open({ type: "streamable-http", url: http.url });

    await expect(sessions.open({ type: "streamable-http", url: http.url }))
      .rejects.toBeInstanceOf(RemoteMcpSessionLimitError);
    expect(sessions.size).toBe(1);
  });

  it("holds the cap when opens race each other", async () => {
    const sessions = manager(30 * 60_000, 2);
    const http = await httpServer();

    // All four pass the pre-check simultaneously if the slot is only claimed after
    // connect + tools/list have resolved.
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => sessions.open({ type: "streamable-http", url: http.url })),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const rejected of results.filter((r) => r.status === "rejected")) {
      expect(rejected.reason).toBeInstanceOf(RemoteMcpSessionLimitError);
    }
    expect(sessions.size).toBe(2);
  });

  it("drops a session whose downstream expired, so the next call reads as not-found", async () => {
    const sessions = manager();
    const http = await httpServer({ stateful: true });
    const { workerHandle } = await sessions.open({ type: "streamable-http", url: http.url });

    http.expire();
    await expect(sessions.call(workerHandle, "echo", {})).rejects.toBeInstanceOf(McpSessionExpiredError);
    expect(sessions.size).toBe(0);
    await expect(sessions.ping(workerHandle)).rejects.toBeInstanceOf(RemoteMcpSessionNotFoundError);
  });

  it("reaps an idle session", async () => {
    vi.useFakeTimers();
    try {
      const sessions = manager(1_000);
      const http = await httpServer({ stateful: true });
      const { workerHandle } = await sessions.open({ type: "streamable-http", url: http.url });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(sessions.size).toBe(0);
      await expect(sessions.ping(workerHandle)).rejects.toBeInstanceOf(RemoteMcpSessionNotFoundError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an open that was in flight during closeAll land as an orphan", async () => {
    const sessions = manager();
    // The tunnel drops (reverse-connect calls closeAll) while this open is still waiting
    // on tools/list. Without a generation check the client would land in `sessions` with
    // no hub handle pointing at it, holding a slot until the idle reaper.
    const http = await httpServer({ stateful: true, listToolsDelayMs: 300 });
    const opening = sessions.open({ type: "streamable-http", url: http.url });
    await vi.waitFor(() => expect(http.requests.some((r) => r.rpcMethod === "tools/list")).toBe(true));

    await sessions.closeAll("reverse-connect disconnected");
    await expect(opening).rejects.toThrow(/reset while opening/);

    expect(sessions.size).toBe(0);
    // The abandoned client was torn down, not leaked: the downstream session got its DELETE.
    await vi.waitFor(() => expect(http.deletes).toBe(1));
  });

  it("closes every session on closeAll, the way a reverse-connect drop does", async () => {
    const sessions = manager();
    const http = await httpServer({ stateful: true });
    const stdio = await sessions.open(stdioSpec());
    const web = await sessions.open({ type: "streamable-http", url: http.url });

    await sessions.closeAll("reverse-connect disconnected");

    expect(sessions.size).toBe(0);
    expect(http.deletes).toBe(1);
    for (const handle of [stdio.workerHandle, web.workerHandle]) {
      await expect(sessions.ping(handle)).rejects.toBeInstanceOf(RemoteMcpSessionNotFoundError);
    }
  });
});
