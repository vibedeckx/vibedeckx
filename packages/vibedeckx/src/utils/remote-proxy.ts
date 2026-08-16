import type { ReverseConnectManager } from "../reverse-connect-manager.js";
import { outboundTraceparent } from "../trace-context.js";

export interface ProxyResult {
  ok: boolean;
  status: number;
  data: unknown;
  errorCode?: "timeout" | "network_error" | "auth_error" | "server_error" | "non_json_response";
  requestId?: string;
  durationMs?: number;
  /** Total number of attempts made (1 = no retries) */
  attempts?: number;
  /** Total wall-clock time including all retries */
  totalDurationMs?: number;
}

/**
 * Resolves the HTTP status to forward from a proxy result.
 * status === 0 means the request never reached the remote (network error,
 * timeout, abort) — coerce to `fallback` (default 502) so callers can't
 * accidentally mask a connection failure as success via `status || 200`.
 */
export function proxyStatus(result: { status: number }, fallback: number = 502): number {
  return result.status > 0 ? result.status : fallback;
}

export interface ProxyOptions {
  requestId?: string;
  timeoutMs?: number;
  /** Extra tunnel headers. Merged over the automatic trace header. */
  headers?: Record<string, string>;
}

/**
 * Proxy a request to a remote server over its reverse-connect tunnel.
 * Remotes are only reachable while their worker holds an open reverse
 * connection; when it doesn't, this resolves to a network_error ProxyResult
 * (it never throws for transport failures).
 */
export async function proxyToRemoteAuto(
  remoteServerId: string,
  method: string,
  apiPath: string,
  body?: unknown,
  options?: ProxyOptions & { reverseConnectManager?: ReverseConnectManager }
): Promise<ProxyResult> {
  const rcm = options?.reverseConnectManager;
  if (rcm && rcm.isConnected(remoteServerId)) {
    // Pulled from the ambient request context rather than threaded through the
    // dozens of proxy call sites: the trace header rides along automatically,
    // and a worker running old code simply ignores an unknown header.
    const traceparent = outboundTraceparent();
    const headers = {
      ...(traceparent ? { traceparent } : {}),
      ...options?.headers,
    };
    return rcm.sendHttpRequest(remoteServerId, method, apiPath, body, options?.timeoutMs, headers);
  }
  return {
    ok: false,
    status: 0,
    data: { error: "Remote server is not connected" },
    errorCode: "network_error",
    requestId: options?.requestId,
  };
}
