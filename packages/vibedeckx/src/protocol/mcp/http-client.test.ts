import { describe, it, expect, afterEach } from "vitest";
import { McpStreamableHttpClient, byteLimiter } from "./http-client.js";
import { McpClientError, McpSessionExpiredError, McpTimeoutError } from "./client.js";
import { startFakeHttpMcpServer, type FakeHttpMcpServer } from "./__fixtures__/fake-http-mcp-server.js";

describe("McpStreamableHttpClient", () => {
  const servers: FakeHttpMcpServer[] = [];
  const clients: McpStreamableHttpClient[] = [];

  const start = async (...args: Parameters<typeof startFakeHttpMcpServer>) => {
    const server = await startFakeHttpMcpServer(...args);
    servers.push(server);
    return server;
  };

  const connect = async (url: string, headers?: Record<string, string>, timeoutMs?: number) => {
    const { client, serverInfo } = await McpStreamableHttpClient.connect(
      { type: "streamable-http", url, ...(headers ? { headers } : {}) },
      timeoutMs,
    );
    clients.push(client);
    return { client, serverInfo };
  };

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  });

  it("initializes over JSON, lists tools and calls one on a stateless server", async () => {
    const server = await start();
    const { client, serverInfo } = await connect(server.url);

    expect(serverInfo).toMatchObject({ name: "fake-http-mcp", version: "9.9.9" });
    expect(client.sessionId).toBeUndefined();
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
    expect(await client.callTool("echo", { text: "hi" }, 5_000)).toMatchObject({
      content: [{ type: "text", text: "call-1" }],
    });
    await client.ping();

    const rpcMethods = server.requests.filter((r) => r.rpcMethod).map((r) => r.rpcMethod);
    expect(rpcMethods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"]);
    // The negotiated version rides every post-initialize request.
    expect(server.requests.find((r) => r.rpcMethod === "tools/list")?.protocolVersion).toBeTruthy();
  });

  it("carries the session id and the caller's headers on every request, over SSE", async () => {
    const server = await start({ stateful: true, sse: true });
    const { client } = await connect(server.url, { Authorization: "Bearer token-1" });

    expect(client.sessionId).toBe("fake-session-1");
    await client.listTools();
    await client.callTool("echo", {}, 5_000);

    const afterInit = server.requests.filter((r) => r.rpcMethod && r.rpcMethod !== "initialize");
    expect(afterInit.length).toBeGreaterThan(0);
    for (const request of afterInit) expect(request.sessionId).toBe("fake-session-1");
    for (const request of server.requests) expect(request.authorization).toBe("Bearer token-1");
  });

  it("terminates the session with DELETE on close", async () => {
    const server = await start({ stateful: true });
    const { client } = await connect(server.url);
    await client.close();

    expect(server.deletes).toBe(1);
    expect(client.isClosed).toBe(true);
  });

  it("treats a 405 on DELETE as a successful local close", async () => {
    const server = await start({ stateful: true, deleteStatus: 405 });
    const { client } = await connect(server.url);
    await expect(client.close()).resolves.toBeUndefined();

    expect(server.deletes).toBe(1);
    expect(client.isClosed).toBe(true);
    await expect(client.listTools()).rejects.toThrow("MCP client is closed");
  });

  it("skips DELETE for a stateless server", async () => {
    const server = await start();
    const { client } = await connect(server.url);
    await client.close();
    expect(server.deletes).toBe(0);
  });

  it("reports an expired session as such and never replays the tool call", async () => {
    const server = await start({ stateful: true });
    const { client } = await connect(server.url);
    await client.callTool("echo", {}, 5_000);

    server.expire();
    await expect(client.callTool("echo", {}, 5_000)).rejects.toBeInstanceOf(McpSessionExpiredError);
    // Exactly two tools/call requests reached the server: the one that worked and the
    // one that was refused. The client must not retry a tool that may already have had
    // side effects on the far side.
    expect(server.requests.filter((r) => r.rpcMethod === "tools/call")).toHaveLength(2);
    expect(client.isClosed).toBe(true);
  });

  it("times out a slow tool call without disturbing the next one", async () => {
    const server = await start({ firstToolDelayMs: 2_000 });
    const { client } = await connect(server.url);

    await expect(client.callTool("echo", {}, 200)).rejects.toBeInstanceOf(McpTimeoutError);
    // The session survives, and the abandoned request's late response — which lands while
    // this second call is in flight — must not be mistaken for its answer.
    expect(await client.callTool("echo", {}, 5_000)).toMatchObject({ content: [{ text: "call-2" }] });
  });

  it("refuses a redirect that leaves http(s)", async () => {
    const server = await start({ redirect: { status: 307, location: "file:///etc/passwd" } });
    await expect(connect(server.url)).rejects.toThrow(/unsupported scheme/i);
  });

  it("refuses to downgrade a POST that gets a 302", async () => {
    const server = await start({ redirect: { status: 302, location: "/elsewhere" } });
    await expect(connect(server.url)).rejects.toThrow(/redirect target/i);
  });

  it("does not report an endpoint that 404s from the start as an expired session", async () => {
    const server = await start({ stateful: true });
    // Never initialized: a 404 here means the URL is wrong, not that a session lapsed.
    server.expire();

    const error = await connect(server.url).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(McpClientError);
    expect(error).not.toBeInstanceOf(McpSessionExpiredError);
  });

  it("surfaces a connection failure as a client error", async () => {
    const server = await start();
    const url = server.url;
    await server.close();
    servers.length = 0;
    await expect(connect(url)).rejects.toBeInstanceOf(McpClientError);
  });
});

describe("byteLimiter", () => {
  const pump = async (isSse: boolean, maxBytes: number, chunks: string[]) => {
    const limiter = byteLimiter(isSse, maxBytes);
    const reader = limiter.readable.getReader();
    const drain = (async () => { for (;;) { if ((await reader.read()).done) return; } })();
    const write = (async () => {
      const writer = limiter.writable.getWriter();
      for (const chunk of chunks) await writer.write(new TextEncoder().encode(chunk));
      await writer.close();
    })();
    await Promise.all([drain, write]);
  };

  it("caps a plain body by its total size", async () => {
    await expect(pump(false, 10, ["12345", "67890"])).resolves.toBeUndefined();
    await expect(pump(false, 10, ["12345", "678901"])).rejects.toThrow(/byte limit/);
  });

  it("resets an SSE frame at a delimiter that straddles two chunks", async () => {
    // "\n" ends one chunk and "\n" opens the next: without carried state the frame
    // counter would never reset and a long-lived stream would trip the cap.
    await expect(pump(true, 16, ["data: aaaa\n", "\ndata: bbbb\n", "\ndata: cccc\n\n"])).resolves.toBeUndefined();
    await expect(pump(true, 16, ["data: aaaa\r\n", "\r\ndata: bbbb\r\n\r\n"])).resolves.toBeUndefined();
  });

  it("rejects an oversized frame even when its terminator lands in the same chunk", async () => {
    await expect(pump(true, 16, ["data: aaaaaaaaaaaa\n\ndata: b\n\n"])).rejects.toThrow(/byte limit/);
  });

  it("rejects an unterminated frame that outgrows the cap", async () => {
    await expect(pump(true, 16, ["data: aaaa", "aaaaaaaa"])).rejects.toThrow(/byte limit/);
  });
});
