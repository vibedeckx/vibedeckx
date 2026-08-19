/**
 * Transport-agnostic shape of a brokered MCP session. The remote MCP broker keeps one
 * of these per open handle; callers (session manager, routes) never branch on whether
 * the session is backed by a stdio child process or an HTTP endpoint.
 */
export interface McpTool { name: string; description?: string; inputSchema?: unknown }

export class McpClientError extends Error {}
export class McpTimeoutError extends McpClientError {}
/** The downstream server dropped the protocol session; the caller must re-open. */
export class McpSessionExpiredError extends McpClientError {}

export interface RemoteMcpClient {
  readonly isClosed: boolean;
  listTools(timeoutMs?: number): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}
