import { randomUUID } from "node:crypto";
import {
  McpClientError,
  McpSessionExpiredError,
  McpTimeoutError,
  type McpTool,
  type RemoteMcpClient,
} from "./protocol/mcp/client.js";
import { McpStdioClient } from "./protocol/mcp/stdio-client.js";
import { McpStreamableHttpClient } from "./protocol/mcp/http-client.js";
import { parseRemoteMcpTransport, type RemoteMcpTransport } from "./protocol/mcp/transport.js";

const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const MAX_MCP_TIMEOUT_MS = 300_000;
/** Coarse global backstop; per-user quotas are deliberately out of scope for now. */
export const MAX_REMOTE_MCP_SESSIONS = 16;

export class RemoteMcpSessionNotFoundError extends Error {}
export class RemoteMcpSessionLimitError extends Error {}

interface Session {
  client: RemoteMcpClient;
  transport: RemoteMcpTransport["type"];
  serverInfo: unknown;
  tools: McpTool[];
  lastUsedAt: number;
}

export class RemoteMcpSessionManager {
  private sessions = new Map<string, Session>();
  /** Opens that have passed the cap check but have not landed in `sessions` yet. */
  private opening = 0;
  /** Bumped by closeAll so an open still in flight knows its manager was drained. */
  private generation = 0;
  private reaper: NodeJS.Timeout;

  constructor(private idleTtlMs = DEFAULT_IDLE_TTL_MS, private maxSessions = MAX_REMOTE_MCP_SESSIONS) {
    this.reaper = setInterval(() => void this.reapIdle(), Math.min(60_000, idleTtlMs));
    this.reaper.unref();
  }

  async open(
    transport: RemoteMcpTransport,
    timeoutMs = 20_000,
  ): Promise<{ workerHandle: string; transport: RemoteMcpTransport["type"]; serverInfo: unknown; tools: McpTool[] }> {
    // Re-validated here rather than trusted from the hub: this is the side that spawns a
    // process or dials a URL, and the manager is also reachable from tests and future
    // callers that never went through the gateway.
    const parsed = parseRemoteMcpTransport(transport);
    if (!parsed.ok) throw new McpClientError(parsed.error);
    // Reserve the slot before the first await: connect + tools/list take seconds, and
    // concurrent opens would otherwise all pass a size-only check and blow past the cap.
    if (this.sessions.size + this.opening >= this.maxSessions) {
      throw new RemoteMcpSessionLimitError(
        `MCP session limit reached (${this.maxSessions}); close an existing session first`,
      );
    }
    this.opening++;
    const generation = this.generation;

    try {
      const spec = parsed.transport;
      const { client, serverInfo } = spec.type === "stdio"
        ? await McpStdioClient.connect(spec, clampTimeout(timeoutMs))
        : await McpStreamableHttpClient.connect(spec, clampTimeout(timeoutMs));
      try {
        const tools = await client.listTools(clampTimeout(timeoutMs));
        // The tunnel can drop (or the worker can shut down) while this open is still
        // dialling. Landing in `sessions` now would leave a live child process or HTTP
        // session that no hub handle points at, holding a slot until the idle reaper.
        if (generation !== this.generation) throw new McpClientError("MCP broker was reset while opening");
        const workerHandle = randomUUID();
        this.sessions.set(workerHandle, { client, transport: spec.type, serverInfo, tools, lastUsedAt: Date.now() });
        return { workerHandle, transport: spec.type, serverInfo, tools };
      } catch (error) {
        await client.close();
        throw error;
      }
    } finally {
      this.opening--;
    }
  }

  async listTools(workerHandle: string): Promise<McpTool[]> {
    return this.run(workerHandle, async (session) => {
      session.tools = await session.client.listTools();
      return session.tools;
    });
  }

  async call(workerHandle: string, tool: string, args: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    return this.run(workerHandle, (session) => session.client.callTool(tool, args, clampTimeout(timeoutMs)));
  }

  async ping(workerHandle: string): Promise<void> {
    await this.run(workerHandle, (session) => session.client.ping());
  }

  async close(workerHandle: string): Promise<boolean> {
    const session = this.sessions.get(workerHandle);
    if (!session) return false;
    this.sessions.delete(workerHandle);
    await session.client.close();
    return true;
  }

  async closeAll(_reason = "shutdown"): Promise<void> {
    this.generation++;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.client.close()));
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await this.closeAll("shutdown");
  }

  get size(): number { return this.sessions.size; }

  /**
   * A downstream session can expire before our own idle reaper fires. Drop it on the spot
   * so the next call gets a clean "re-open" answer — but never replay the failed call,
   * which may already have had side effects on the server.
   */
  private async run<T>(workerHandle: string, operation: (session: Session) => Promise<T>): Promise<T> {
    const session = this.get(workerHandle);
    try {
      return await operation(session);
    } catch (error) {
      if (error instanceof McpSessionExpiredError) await this.close(workerHandle);
      throw error;
    }
  }

  private get(workerHandle: string): Session {
    const session = this.sessions.get(workerHandle);
    if (!session || session.client.isClosed) {
      this.sessions.delete(workerHandle);
      throw new RemoteMcpSessionNotFoundError("MCP session not found");
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [handle, session] of this.sessions) {
      if (session.lastUsedAt < cutoff) await this.close(handle);
    }
  }
}

export const clampTimeout = (value: number): number =>
  Math.max(1_000, Math.min(Number.isFinite(value) ? value : DEFAULT_CALL_TIMEOUT_MS, MAX_MCP_TIMEOUT_MS));

export { McpClientError, McpSessionExpiredError, McpTimeoutError };
