import type { Storage } from "./storage/types.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import { proxyToRemoteAuto } from "./utils/remote-proxy.js";

/**
 * Push the hub's retention window down to the workers
 * (docs/plans/2026-08-08-session-retention.md §3, Phase 2).
 *
 * Retention has to run where the sessions live, so the hub owns the value and
 * each worker enforces it locally. One global value: no per-worker override,
 * because no scenario wants one machine at 30 days and another at 365 and a
 * second config source only adds a precedence rule to get wrong.
 *
 * The downlink is purely additive on the tunnel: a worker predating the route
 * answers 404, which this reports back so the settings UI can say "update
 * this worker" instead of silently leaving it unswept.
 */

/**
 * Capability key for the worker-side receiver. Deliberately its own path
 * rather than the operator-facing PUT: the operator route fans out to workers,
 * and a worker receiving THAT would try to fan out again.
 */
export const RETENTION_DOWNLINK_CAPABILITY = "http:PUT /api/settings/session-retention/apply";

export interface RetentionPushResult {
  remoteServerId: string;
  name: string;
  /** "applied" | "needs_upgrade" (404 — worker too old) | "unreachable" | "error" */
  status: "applied" | "needs_upgrade" | "unreachable" | "error";
  detail?: string;
}

export interface RetentionDownlinkDeps {
  storage: Storage;
  reverseConnectManager: ReverseConnectManager;
  timeoutMs?: number;
}

/**
 * Send `days` (null = retention off) to one worker. Never throws: a worker
 * that is down is reported as unreachable and picks the value up the next time
 * it connects (shared-services re-pushes on every "online" transition).
 */
export async function pushRetentionToWorker(
  deps: RetentionDownlinkDeps,
  server: { id: string; name: string },
  days: number | null,
): Promise<RetentionPushResult> {
  try {
    const result = await proxyToRemoteAuto(
      server.id,
      "PUT",
      "/api/settings/session-retention/apply",
      { days },
      { reverseConnectManager: deps.reverseConnectManager, timeoutMs: deps.timeoutMs ?? 10_000 },
    );
    if (result.ok) return { remoteServerId: server.id, name: server.name, status: "applied" };
    if (result.status === 404) {
      return {
        remoteServerId: server.id, name: server.name, status: "needs_upgrade",
        detail: "This worker predates session retention — update it to apply the window.",
      };
    }
    // status 0 = the request never reached the worker (see proxyStatus).
    if (result.status === 0 || result.errorCode === "network_error" || result.errorCode === "timeout") {
      return { remoteServerId: server.id, name: server.name, status: "unreachable" };
    }
    return {
      remoteServerId: server.id, name: server.name, status: "error",
      detail: `worker responded ${result.status}`,
    };
  } catch (error) {
    return {
      remoteServerId: server.id, name: server.name, status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Fan `days` out to every remote server, one result row per worker. */
export async function pushRetentionToWorkers(
  deps: RetentionDownlinkDeps,
  days: number | null,
  userId?: string,
): Promise<RetentionPushResult[]> {
  const servers = await deps.storage.remoteServers.getAll(userId);
  return Promise.all(servers.map((server) => pushRetentionToWorker(deps, server, days)));
}
