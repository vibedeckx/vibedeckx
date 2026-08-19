import path from "node:path";

export interface McpStdioTransport { type: "stdio"; command: string; args?: string[]; cwd?: string }
export interface McpStreamableHttpTransport { type: "streamable-http"; url: string; headers?: Record<string, string> }
export type RemoteMcpTransport = McpStdioTransport | McpStreamableHttpTransport;

export type ParsedTransport =
  | { ok: true; transport: RemoteMcpTransport }
  | { ok: false; error: string };

const LABEL_MAX = 120;

/**
 * Validates the `transport` union accepted by remote_mcp_open. Runs on both sides of the
 * tunnel: the hub rejects bad input before it spends a proxy round trip, and the worker
 * re-validates because it is the side that actually spawns a process or dials a URL.
 */
export function parseRemoteMcpTransport(value: unknown): ParsedTransport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "transport is required" };
  }
  const input = value as Record<string, unknown>;
  const type = input.type;
  if (typeof type !== "string" || !type) return { ok: false, error: "transport.type is required" };

  switch (type) {
    case "stdio": {
      for (const key of ["url", "headers"]) {
        if (input[key] !== undefined) return { ok: false, error: `stdio transport does not accept ${key}` };
      }
      const { command, args, cwd } = input;
      if (typeof command !== "string" || !command.trim()) return { ok: false, error: "transport.command is required" };
      if (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))) {
        return { ok: false, error: "transport.args must be an array of strings" };
      }
      if (cwd !== undefined && (typeof cwd !== "string" || !path.isAbsolute(cwd))) {
        return { ok: false, error: "transport.cwd must be an absolute path" };
      }
      return {
        ok: true,
        transport: { type, command, ...(args ? { args: args as string[] } : {}), ...(cwd ? { cwd: cwd as string } : {}) },
      };
    }
    case "streamable-http": {
      for (const key of ["command", "args", "cwd"]) {
        if (input[key] !== undefined) return { ok: false, error: `streamable-http transport does not accept ${key}` };
      }
      const { url, headers } = input;
      if (typeof url !== "string" || !url.trim()) return { ok: false, error: "transport.url is required" };
      let parsed: URL;
      try { parsed = new URL(url); } catch { return { ok: false, error: "transport.url must be a valid URL" }; }
      if (!isAllowedMcpProtocol(parsed)) {
        return { ok: false, error: "transport.url must use http: or https:" };
      }
      if (headers !== undefined) {
        if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
          return { ok: false, error: "transport.headers must be an object of strings" };
        }
        for (const [key, headerValue] of Object.entries(headers as Record<string, unknown>)) {
          if (typeof key !== "string" || !key || typeof headerValue !== "string") {
            return { ok: false, error: "transport.headers must be an object of strings" };
          }
        }
      }
      return {
        ok: true,
        transport: { type, url, ...(headers ? { headers: headers as Record<string, string> } : {}) },
      };
    }
    default:
      return { ok: false, error: `Unsupported MCP transport type: ${type}` };
  }
}

export const isAllowedMcpProtocol = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";

/**
 * Audit/display label for a brokered session. For HTTP this is deliberately lossy: the
 * userinfo, query string and fragment of an MCP URL routinely carry credentials, and the
 * label reaches the audit table, the signed handle and the agent's transcript.
 */
export function deriveMcpServerLabel(transport: RemoteMcpTransport): string {
  if (transport.type === "stdio") return sanitizeLabel(transport.command);
  let url: URL;
  try { url = new URL(transport.url); } catch { return "mcp"; }
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return sanitizeLabel(`${url.host}${pathname}`) || "mcp";
}

/** Resolves the caller's explicit label, falling back to the transport-derived one. */
export const resolveMcpServerLabel = (explicit: unknown, transport: RemoteMcpTransport): string =>
  typeof explicit === "string" && explicit.trim() ? sanitizeLabel(explicit) : deriveMcpServerLabel(transport);

const sanitizeLabel = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, LABEL_MAX);
