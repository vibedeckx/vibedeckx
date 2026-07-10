import type { Storage, RemoteServer, CrossRemoteAccess } from "./storage/types.js";
import type { CrossRemoteTokenPayload } from "./utils/cross-remote-token.js";

/**
 * Lives here rather than in the route file: both the route and cross-remote-mcp-config
 * need it, and this module imports neither of them — that keeps the dependency acyclic
 * and keeps the Fastify route out of the provider's import graph on the remote.
 */
export const CROSS_REMOTE_MCP_PATH = "/api/cross-remote-mcp";

export type CrossRemoteTier = "read" | "exec";

export const TOOL_TIERS: Record<string, CrossRemoteTier> = {
  remote_read_file: "read",
  remote_list_dir: "read",
  remote_stat_path: "read",
  remote_process_list: "read",
  remote_bash: "exec",
};

export const MAX_IN_FLIGHT_PER_SESSION = 4;

/** Structural subset of FastifyInstance, so the gateway route can pass `fastify` directly. */
export interface AccessDeps {
  storage: Pick<Storage, "remoteServers">;
  reverseConnectManager: { isConnected(remoteServerId: string): boolean };
  remoteSessionMap: Map<string, unknown>;
  agentSessionManager: { getSessionProcessAlive(sessionId: string): boolean };
}

const tierSatisfies = (granted: CrossRemoteAccess, required: CrossRemoteTier): boolean =>
  granted === "exec" || (granted === "read" && required === "read");

const isOnline = (deps: AccessDeps, server: RemoteServer): boolean =>
  server.connection_mode === "inbound"
    ? deps.reverseConnectManager.isConnected(server.id)
    : !!server.url;

/**
 * True when the session that minted this token still exists.
 *
 * For local sessions this is a real liveness check. For remote sessions the server
 * holds no liveness bit — the process runs on the source remote — so this checks that
 * the session mapping still exists (rehydrated from storage at boot, removed on delete).
 * Tier changes and the token's 24h expiry are the other revocation levers.
 */
export function isSessionUsable(deps: AccessDeps, sessionId: string): boolean {
  if (sessionId.startsWith("remote-")) return deps.remoteSessionMap.has(sessionId);
  return deps.agentSessionManager.getSessionProcessAlive(sessionId);
}

export type ResolveResult =
  | { ok: true; server: RemoteServer }
  | { ok: false; reason: "not_accessible" | "offline" };

export async function resolveTarget(
  deps: AccessDeps,
  payload: CrossRemoteTokenPayload,
  targetRemoteId: string,
  requiredTier: CrossRemoteTier,
): Promise<ResolveResult> {
  if (payload.sourceRemoteServerId && payload.sourceRemoteServerId === targetRemoteId) {
    return { ok: false, reason: "not_accessible" };
  }

  const server = await deps.storage.remoteServers.getById(targetRemoteId, payload.userId);
  if (!server) return { ok: false, reason: "not_accessible" };
  if (!tierSatisfies(server.cross_remote_access, requiredTier)) {
    return { ok: false, reason: "not_accessible" };
  }
  if (!isOnline(deps, server)) return { ok: false, reason: "offline" };

  return { ok: true, server };
}

export async function listAccessibleRemotes(
  deps: AccessDeps,
  payload: CrossRemoteTokenPayload,
): Promise<Array<{ id: string; name: string; access: CrossRemoteAccess; online: boolean }>> {
  const servers = await deps.storage.remoteServers.getAll(payload.userId);
  return servers
    .filter((s) => s.cross_remote_access !== "off")
    .filter((s) => s.id !== payload.sourceRemoteServerId)
    .map((s) => ({ id: s.id, name: s.name, access: s.cross_remote_access, online: isOnline(deps, s) }));
}

export class SessionConcurrencyGuard {
  private inFlight = new Map<string, number>();

  constructor(private readonly maxInFlight: number = MAX_IN_FLIGHT_PER_SESSION) {}

  acquire(sessionId: string): boolean {
    const current = this.inFlight.get(sessionId) ?? 0;
    if (current >= this.maxInFlight) return false;
    this.inFlight.set(sessionId, current + 1);
    return true;
  }

  release(sessionId: string): void {
    const current = this.inFlight.get(sessionId) ?? 0;
    if (current <= 1) this.inFlight.delete(sessionId);
    else this.inFlight.set(sessionId, current - 1);
  }
}
