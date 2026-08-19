/**
 * A Streamable HTTP MCP server for broker tests. Unlike protocol/live/stub-mcp-server.ts
 * (a stateless probe for the agent-CLI compat suite) this one exists to exercise the
 * transport corners the broker has to survive: JSON vs SSE responses, stateful vs
 * stateless `Mcp-Session-Id`, DELETE teardown (including 405), slow tools and expiry.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeHttpMcpOptions {
  /** Issue an `Mcp-Session-Id` on initialize and require it afterwards. */
  stateful?: boolean;
  /** Answer requests with text/event-stream instead of application/json. */
  sse?: boolean;
  /** Status for DELETE; 405 means "this server does not let clients terminate sessions". */
  deleteStatus?: number;
  /** Delay the *first* tools/call, so a test can time it out and then reuse the session. */
  firstToolDelayMs?: number;
  /** Delay tools/list, so a test can act while an open is still in flight. */
  listToolsDelayMs?: number;
  /** Redirect every POST with this status instead of serving it. */
  redirect?: { status: number; location: string };
}

export interface RecordedRequest {
  method: string;
  rpcMethod?: string;
  sessionId?: string;
  protocolVersion?: string;
  authorization?: string;
}

export interface FakeHttpMcpServer {
  url: string;
  readonly sessionId: string | undefined;
  requests: RecordedRequest[];
  readonly toolCalls: number;
  readonly deletes: number;
  /** Make the server behave as if it dropped the session: everything answers 404. */
  expire(): void;
  close(): Promise<void>;
}

export async function startFakeHttpMcpServer(options: FakeHttpMcpOptions = {}): Promise<FakeHttpMcpServer> {
  const {
    stateful = false, sse = false, deleteStatus = 200,
    firstToolDelayMs = 0, listToolsDelayMs = 0, redirect,
  } = options;
  const requests: RecordedRequest[] = [];
  let sessionId: string | undefined;
  let toolCalls = 0;
  let deletes = 0;
  let expired = false;

  const server = http.createServer((req, res) => {
    const record: RecordedRequest = {
      method: req.method ?? "",
      sessionId: header(req, "mcp-session-id"),
      protocolVersion: header(req, "mcp-protocol-version"),
      authorization: header(req, "authorization"),
    };

    if (req.method === "GET") {
      // No standalone notification stream; the spec lets a server decline with 405.
      requests.push(record);
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (req.method === "DELETE") {
      requests.push(record);
      deletes++;
      if (deleteStatus === 200) sessionId = undefined;
      res.writeHead(deleteStatus).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let msg: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      record.rpcMethod = msg.method;
      requests.push(record);

      if (redirect) {
        res.writeHead(redirect.status, { Location: redirect.location }).end();
        return;
      }
      if (expired || (stateful && msg.method !== "initialize" && record.sessionId !== sessionId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return;
      }

      const reply = (result: unknown) => {
        const headers: Record<string, string> = sessionId ? { "Mcp-Session-Id": sessionId } : {};
        const envelope = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        if (sse) {
          res.writeHead(200, { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          res.end(`event: message\ndata: ${envelope}\n\n`);
        } else {
          res.writeHead(200, { ...headers, "Content-Type": "application/json" });
          res.end(envelope);
        }
      };

      switch (msg.method) {
        case "initialize":
          if (stateful) sessionId = "fake-session-1";
          reply({
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-http-mcp", version: "9.9.9" },
          });
          return;
        case "tools/list":
          after(listToolsDelayMs, () => reply({ tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] }));
          return;
        case "tools/call":
          toolCalls++;
          after(toolCalls === 1 ? firstToolDelayMs : 0, () => reply({ content: [{ type: "text", text: `call-${toolCalls}` }] }));
          return;
        default:
          if (msg.id === undefined) { res.writeHead(202).end(); return; }
          reply({});
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get sessionId() { return sessionId; },
    requests,
    get toolCalls() { return toolCalls; },
    get deletes() { return deletes; },
    expire() { expired = true; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Answers inline when there is no delay, so a test on fake timers is not stalled by the fixture. */
const after = (delayMs: number, run: () => void): void => {
  if (delayMs > 0) setTimeout(run, delayMs);
  else run();
};

const header = (req: http.IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
