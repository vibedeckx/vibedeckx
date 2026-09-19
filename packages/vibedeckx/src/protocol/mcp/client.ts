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

/** Bound on server-level instructions forwarded to the agent; they land in its context. */
export const MAX_MCP_INSTRUCTIONS_CHARS = 8192;

/**
 * Normalizes the optional `instructions` string from an `initialize` result. It is
 * downstream-authored text headed for the agent's context, so it is capped; absent,
 * non-string or blank values collapse to undefined so the open response omits the field.
 */
export function normalizeMcpInstructions(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  if (text.length <= MAX_MCP_INSTRUCTIONS_CHARS) return text;
  return `${text.slice(0, MAX_MCP_INSTRUCTIONS_CHARS)}\n[instructions truncated at ${MAX_MCP_INSTRUCTIONS_CHARS} characters]`;
}
