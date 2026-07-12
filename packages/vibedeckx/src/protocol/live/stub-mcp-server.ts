/**
 * Minimal streamable-HTTP MCP server for the CC-7 probe. Serves one tool
 * (`compat_ping`) and records every request's Authorization header so the
 * test can assert the CLI presented the exact bearer token from
 * buildMcpConfigArg. Stateless: no session ids.
 */
import http from "http";
import type { AddressInfo } from "net";

export interface StubMcpServer {
  url: string;
  authHeaders: string[];
  requests: Array<{ method: string; rpcMethod?: string }>;
  toolCalls: number;
  close: () => Promise<void>;
}

export async function startStubMcpServer(): Promise<StubMcpServer> {
  const state: Omit<StubMcpServer, "url" | "close"> = { authHeaders: [], requests: [], toolCalls: 0 };

  const server = http.createServer((req, res) => {
    state.authHeaders.push(req.headers.authorization ?? "");
    if (req.method === "GET") {
      // Server-initiated SSE stream: not supported by this stub (allowed by spec).
      res.writeHead(405, { Allow: "POST" }).end();
      state.requests.push({ method: "GET" });
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      state.requests.push({ method: "DELETE" });
      return;
    }
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: { protocolVersion?: string; name?: string } };
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      state.requests.push({ method: "POST", rpcMethod: msg.method });
      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      switch (msg.method) {
        case "initialize":
          reply({
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "vibedeckx-compat-stub", version: "1.0.0" },
          });
          return;
        case "tools/list":
          reply({ tools: [{ name: "compat_ping", description: "Returns pong. Call this to verify MCP connectivity.", inputSchema: { type: "object", properties: {} } }] });
          return;
        case "tools/call":
          state.toolCalls++;
          reply({ content: [{ type: "text", text: "pong" }] });
          return;
        default:
          // notifications (no id) get 202; unknown requests get an empty result
          if (msg.id === undefined) { res.writeHead(202).end(); return; }
          reply({});
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    // `toolCalls` is a primitive: spreading `state` here would snapshot it at
    // 0 and never reflect later `state.toolCalls++` mutations (unlike the
    // array fields, which stay shared by reference). Expose it as a live
    // getter so callers always see the current count.
    authHeaders: state.authHeaders,
    requests: state.requests,
    get toolCalls() { return state.toolCalls; },
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
