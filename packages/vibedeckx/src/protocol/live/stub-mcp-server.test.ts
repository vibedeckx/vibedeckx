import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStubMcpServer, type StubMcpServer } from "./stub-mcp-server.js";

describe("stub MCP server", () => {
  let stub: StubMcpServer;
  beforeAll(async () => { stub = await startStubMcpServer(); });
  afterAll(async () => { await stub.close(); });

  async function rpc(method: string, params: unknown, id?: number) {
    const res = await fetch(stub.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
    });
    return res;
  }

  it("answers initialize, tools/list, tools/call and records auth", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, 1);
    expect((await init.json()).result.serverInfo.name).toBe("vibedeckx-compat-stub");
    expect((await rpc("notifications/initialized", {})).status).toBe(202);
    const list = await rpc("tools/list", {}, 2);
    expect((await list.json()).result.tools[0].name).toBe("compat_ping");
    const call = await rpc("tools/call", { name: "compat_ping", arguments: {} }, 3);
    expect((await call.json()).result.content[0].text).toBe("pong");
    expect(stub.toolCalls).toBe(1);
    expect(stub.authHeaders.every((h) => h === "Bearer test-token")).toBe(true);
  });
});
