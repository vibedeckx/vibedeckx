import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpClientError, McpSessionExpiredError, McpTimeoutError, type McpTool, type RemoteMcpClient } from "./client.js";
import { isAllowedMcpProtocol, type McpStreamableHttpTransport } from "./transport.js";

const MAX_REDIRECTS = 5;
/** Caps a JSON response, and a single SSE event, so a hostile endpoint cannot balloon worker memory. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DELETE_TIMEOUT_MS = 5_000;

const CLIENT_INFO = { name: "vibedeckx-remote-mcp-broker", version: "1.0.0" };

/**
 * A brokered MCP session over Streamable HTTP. The official SDK owns the wire details —
 * SSE framing, `Mcp-Session-Id`, `MCP-Protocol-Version`, the initialized notification,
 * cancellation and DELETE teardown — and this class narrows it to the same
 * {@link RemoteMcpClient} surface the stdio broker exposes.
 */
export class McpStreamableHttpClient implements RemoteMcpClient {
  private closed = false;
  private initialized = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private client: Client,
    private transport: StreamableHTTPClientTransport,
  ) {}

  static async connect(
    spec: McpStreamableHttpTransport,
    timeoutMs = 20_000,
  ): Promise<{ client: McpStreamableHttpClient; serverInfo: unknown }> {
    // reconnectionOptions is deliberately left at the SDK default. Its retries are stream
    // *resumption* — a GET carrying `last-event-id`, only after the server sent a priming
    // event and before a result arrived — so an interrupted response is picked up where it
    // stopped. It never re-POSTs tools/call, which is the replay the broker must not do.
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: spec.headers ? { headers: { ...spec.headers } } : undefined,
      fetch: guardedFetch,
    });
    const sdkClient = new Client(CLIENT_INFO, { capabilities: {} });
    const client = new McpStreamableHttpClient(sdkClient, transport);
    try {
      await sdkClient.connect(transport, { timeout: timeoutMs });
      client.initialized = true;
      return { client, serverInfo: sdkClient.getServerVersion() };
    } catch (error) {
      await client.close();
      throw client.translate(error);
    }
  }

  /** The downstream protocol session id, when the server is stateful. Never leaves the worker. */
  get sessionId(): string | undefined { return this.transport.sessionId; }

  get isClosed(): boolean { return this.closed; }

  async listTools(timeoutMs = 20_000): Promise<McpTool[]> {
    return this.guard(async () => {
      const result = await this.client.listTools({}, { timeout: timeoutMs });
      return Array.isArray(result?.tools) ? (result.tools as McpTool[]) : [];
    });
  }

  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return this.guard(() => this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }));
  }

  async ping(timeoutMs = 10_000): Promise<void> {
    await this.guard(() => this.client.ping({ timeout: timeoutMs }));
  }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeSession();
    await this.closePromise;
  }

  private async closeSession(): Promise<void> {
    this.closed = true;
    // Best-effort DELETE first — it needs the session id, which client.close() discards.
    // A 405 means the server does not allow client-side termination; the SDK already
    // treats that as success, and anything else is still a local close for us.
    if (this.transport.sessionId) {
      await withTimeout(this.transport.terminateSession(), DELETE_TIMEOUT_MS).catch(() => {});
    }
    await this.client.close().catch(() => {});
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new McpClientError("MCP client is closed");
    try {
      return await operation();
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): Error {
    if (error instanceof McpTimeoutError || error instanceof McpSessionExpiredError) return error;
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      return new McpTimeoutError(error.message);
    }
    // 404 on an established session is the spec's "session expired"; 410 is the same
    // answer from servers that prefer Gone. Either way the local client is unusable.
    // Before initialize there is no session to expire — a 404 there just means the URL is
    // wrong, and telling the caller to re-open would send it round the same loop.
    if (this.initialized && error instanceof StreamableHTTPError && (error.code === 404 || error.code === 410)) {
      this.closed = true;
      return new McpSessionExpiredError("Remote MCP session expired; call remote_mcp_open again");
    }
    return error instanceof Error ? new McpClientError(error.message) : new McpClientError(String(error));
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpTimeoutError(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * fetch with the guards the broker needs and the platform does not give us: redirects are
 * followed manually so every hop is re-checked for an http(s) scheme, and response bodies
 * are size-capped.
 */
const guardedFetch: FetchLike = async (input, init) => {
  let url = new URL(typeof input === "string" ? input : input.toString());
  let request: RequestInit = { ...init, redirect: "manual" };

  for (let hop = 0; ; hop++) {
    if (!isAllowedMcpProtocol(url)) {
      throw new McpClientError(`MCP endpoint redirected to an unsupported scheme: ${url.protocol}`);
    }
    const response = await fetch(url, request);
    if (!isRedirect(response.status)) return limitBody(response);

    const location = response.headers.get("location");
    if (!location) return limitBody(response);
    if (hop >= MAX_REDIRECTS) throw new McpClientError(`MCP endpoint exceeded ${MAX_REDIRECTS} redirects`);
    await response.body?.cancel().catch(() => {});

    const method = (request.method ?? "GET").toUpperCase();
    // 307/308 preserve the method and body. The older codes do not, and silently
    // downgrading a JSON-RPC POST to a bodiless GET would look like a protocol bug —
    // say so instead and let the caller re-open against the real endpoint.
    if (response.status !== 307 && response.status !== 308 && method !== "GET") {
      throw new McpClientError(`MCP endpoint answered ${method} with a ${response.status} redirect; open the redirect target directly`);
    }
    url = new URL(location, url);
  }
};

const isRedirect = (status: number): boolean => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

function limitBody(response: Response): Response {
  const isSse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const declared = Number(response.headers.get("content-length"));
  if (!isSse && Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new McpClientError(`MCP response exceeds the ${MAX_RESPONSE_BYTES} byte limit`);
  }
  if (!response.body) return response;
  return new Response(response.body.pipeThrough(byteLimiter(isSse)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * For a plain response the cap is on the whole body. For SSE it is on one event: the
 * stream itself is long-lived and consumed incrementally, so only the event the parser
 * is currently buffering can grow without bound. Delimiter state carries across chunks,
 * and every completed frame is checked — a frame that overruns is rejected even if its
 * terminator arrives in the same chunk. Exported so the cap can be exercised directly
 * instead of by streaming megabytes through a fixture.
 */
export function byteLimiter(isSse: boolean, maxBytes = MAX_RESPONSE_BYTES): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  // Last two bytes of the previous chunk, so a delimiter split across chunks still counts.
  let prev1 = -1;
  let prev2 = -1;

  return new TransformStream({
    transform(chunk, controller) {
      const overrun = () =>
        controller.error(new McpClientError(`MCP response exceeds the ${maxBytes} byte limit`));

      if (!isSse) {
        seen += chunk.byteLength;
        if (seen > maxBytes) return overrun();
        controller.enqueue(chunk);
        return;
      }

      const byteAt = (index: number): number =>
        index >= 0 ? chunk[index] : index === -1 ? prev1 : index === -2 ? prev2 : -1;

      let frameStart = 0;
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) {
        const isDelimiter = byteAt(i - 1) === 0x0a || (byteAt(i - 1) === 0x0d && byteAt(i - 2) === 0x0a);
        if (!isDelimiter) continue;
        if (seen + (i + 1 - frameStart) > maxBytes) return overrun();
        seen = 0;
        frameStart = i + 1;
      }
      seen += chunk.byteLength - frameStart;
      if (seen > maxBytes) return overrun();

      prev2 = chunk.byteLength >= 2 ? chunk[chunk.byteLength - 2] : prev1;
      prev1 = chunk.byteLength >= 1 ? chunk[chunk.byteLength - 1] : prev1;
      controller.enqueue(chunk);
    },
  });
}
