import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpStdioClient, McpTimeoutError, type McpServerSpec, type McpTool } from "./protocol/mcp/stdio-client.js";

const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const MAX_MCP_TIMEOUT_MS = 300_000;

export class RemoteMcpSessionNotFoundError extends Error {}

interface Session {
  client: McpStdioClient;
  serverInfo: unknown;
  tools: McpTool[];
  lastUsedAt: number;
}

export class RemoteMcpSessionManager {
  private sessions = new Map<string, Session>();
  private reaper: NodeJS.Timeout;

  constructor(private idleTtlMs = DEFAULT_IDLE_TTL_MS) {
    this.reaper = setInterval(() => void this.reapIdle(), Math.min(60_000, idleTtlMs));
    this.reaper.unref();
  }

  async open(spec: McpServerSpec, timeoutMs = 20_000): Promise<{ workerHandle: string; serverInfo: unknown; tools: McpTool[] }> {
    if (!spec.command.trim()) throw new Error("command is required");
    if (spec.args && !spec.args.every((arg) => typeof arg === "string")) throw new Error("args must contain strings");
    if (spec.cwd !== undefined && !path.isAbsolute(spec.cwd)) throw new Error("cwd must be absolute");
    const { client, serverInfo } = await McpStdioClient.connect(spec, clampTimeout(timeoutMs));
    try {
      const tools = await client.listTools(clampTimeout(timeoutMs));
      const workerHandle = randomUUID();
      this.sessions.set(workerHandle, { client, serverInfo, tools, lastUsedAt: Date.now() });
      return { workerHandle, serverInfo, tools };
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async listTools(workerHandle: string): Promise<McpTool[]> {
    const session = this.get(workerHandle);
    session.tools = await session.client.listTools();
    return session.tools;
  }

  async call(workerHandle: string, tool: string, args: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const session = this.get(workerHandle);
    return session.client.callTool(tool, args, clampTimeout(timeoutMs));
  }

  async ping(workerHandle: string): Promise<void> {
    await this.get(workerHandle).client.ping();
  }

  async close(workerHandle: string): Promise<boolean> {
    const session = this.sessions.get(workerHandle);
    if (!session) return false;
    this.sessions.delete(workerHandle);
    await session.client.close();
    return true;
  }

  async closeAll(_reason = "shutdown"): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.client.close()));
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await this.closeAll("shutdown");
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

export { McpTimeoutError };
