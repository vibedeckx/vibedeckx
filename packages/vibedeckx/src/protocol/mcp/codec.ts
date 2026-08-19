export type McpIncoming =
  | { kind: "response"; id: string | number; result: unknown }
  | { kind: "error"; id: string | number; error: { code?: number; message?: string } }
  | { kind: "request"; id: string | number; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "ignored" };

export function parseMcpLine(line: string): McpIncoming {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return { kind: "ignored" }; }
  if (!value || typeof value !== "object") return { kind: "ignored" };
  const msg = value as Record<string, unknown>;
  const id = msg.id as string | number | null | undefined;
  const method = typeof msg.method === "string" ? msg.method : undefined;
  if (id != null && method) return { kind: "request", id, method, params: msg.params };
  if (id != null && msg.error !== undefined) {
    return { kind: "error", id, error: (msg.error ?? {}) as { code?: number; message?: string } };
  }
  if (id != null && Object.hasOwn(msg, "result")) return { kind: "response", id, result: msg.result };
  if (method) return { kind: "notification", method, params: msg.params };
  return { kind: "ignored" };
}

export const mcpLine = (payload: Record<string, unknown>): string =>
  JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n";
