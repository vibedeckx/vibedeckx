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
  remote_mcp_open: "exec",
  remote_mcp_list_tools: "exec",
  remote_mcp_call: "exec",
  remote_mcp_ping: "exec",
  remote_mcp_close: "exec",
};

export const MAX_IN_FLIGHT_PER_SESSION = 4;
/** One grant list is one pass through the composer menu; longer is not a user's intent. */
export const MAX_SESSION_GRANTS = 64;
export const REMOTE_MCP_CAPABILITIES = [
  "http:POST /api/path/cross-remote/mcp/open",
  "http:POST /api/path/cross-remote/mcp/list-tools",
  "http:POST /api/path/cross-remote/mcp/call",
  "http:POST /api/path/cross-remote/mcp/ping",
  "http:POST /api/path/cross-remote/mcp/close",
] as const;

export const supportsRemoteMcpBroker = (server: RemoteServer): boolean =>
  REMOTE_MCP_CAPABILITIES.every((capability) => server.worker_capabilities?.includes(capability));

/** Structural subset of FastifyInstance, so the gateway route can pass `fastify` directly. */
export interface AccessDeps {
  storage: Pick<Storage, "remoteServers" | "sessionRemoteGrants">;
  reverseConnectManager: { isConnected(remoteServerId: string): boolean };
  remoteSessionMap: Map<string, unknown>;
  agentSessionManager: { getSessionProcessAlive(sessionId: string): boolean };
}

const tierSatisfies = (granted: CrossRemoteAccess, required: CrossRemoteTier): boolean =>
  granted === "exec" || (granted === "read" && required === "read");

const isOnline = (deps: ReachDeps, server: RemoteServer): boolean =>
  deps.reverseConnectManager.isConnected(server.id);

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
  | { ok: false; reason: "not_accessible" | "offline" | "not_granted" };

/** What the tier check itself needs — no session, no token. */
export type ReachDeps = Pick<AccessDeps, "storage" | "reverseConnectManager">;

/**
 * Whether this user may reach that machine at this tier right now.
 *
 * Split out of `resolveTarget` because the gateway is not the only caller: a
 * cross-remote artifact the conversation links (`artifact-read-targets.ts`)
 * is read from a machine the agent touched, and must be gated by exactly the
 * tier that let it touch it — one policy, not two.
 *
 * Deliberately tier-only: this path also serves the USER opening a screenshot
 * or a file link, and revoking the session's grant must not take those away
 * (docs/cross-remote-session-grants-design.md §3.4). The session allowlist is
 * applied one level up, in `resolveTarget`.
 */
export async function canReachRemote(
  deps: ReachDeps,
  userId: string | undefined,
  targetRemoteId: string,
  requiredTier: CrossRemoteTier,
): Promise<ResolveResult> {
  const server = await deps.storage.remoteServers.getById(targetRemoteId, userId);
  if (!server) return { ok: false, reason: "not_accessible" };
  if (!tierSatisfies(server.cross_remote_access, requiredTier)) {
    return { ok: false, reason: "not_accessible" };
  }
  if (!isOnline(deps, server)) return { ok: false, reason: "offline" };

  return { ok: true, server };
}

/**
 * The session-scoped half of the policy: which machines the user explicitly
 * allowed this conversation to reach, from the composer's + menu. Read fresh
 * on every call, so a revocation takes effect on the next tool use without
 * restarting the agent process or re-minting its token.
 */
async function grantedTo(deps: AccessDeps, sessionId: string): Promise<Set<string>> {
  return new Set(await deps.storage.sessionRemoteGrants.list(sessionId));
}

export async function resolveTarget(
  deps: AccessDeps,
  payload: CrossRemoteTokenPayload,
  targetRemoteId: string,
  requiredTier: CrossRemoteTier,
): Promise<ResolveResult> {
  if (payload.sourceRemoteServerId && payload.sourceRemoteServerId === targetRemoteId) {
    return { ok: false, reason: "not_accessible" };
  }

  // Checked before the tier so an ungranted machine reports the actionable
  // reason ("ask the user to allow it") rather than a generic refusal.
  const granted = await grantedTo(deps, payload.sessionId);
  if (!granted.has(targetRemoteId)) return { ok: false, reason: "not_granted" };

  return canReachRemote(deps, payload.userId, targetRemoteId, requiredTier);
}

export async function listAccessibleRemotes(
  deps: AccessDeps,
  payload: CrossRemoteTokenPayload,
): Promise<Array<{ id: string; name: string; access: CrossRemoteAccess; online: boolean; mcp_broker_supported: boolean }>> {
  const [servers, granted] = await Promise.all([
    deps.storage.remoteServers.getAll(payload.userId),
    grantedTo(deps, payload.sessionId),
  ]);
  return servers
    .filter((s) => s.cross_remote_access !== "off")
    .filter((s) => s.id !== payload.sourceRemoteServerId)
    .filter((s) => granted.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      access: s.cross_remote_access,
      online: isOnline(deps, s),
      mcp_broker_supported: supportsRemoteMcpBroker(s),
    }));
}

/**
 * Validate a grant list against the machine tier (the ceiling) and the
 * session's own machine, shared by the two routes that accept one: the
 * composer's create body and the grant API. All-or-nothing — one bad id
 * rejects the request rather than quietly granting fewer machines than the
 * user ticked. Returns null when the list is acceptable.
 */
export async function validateSessionGrantIds(
  storage: Pick<Storage, "remoteServers">,
  ids: string[],
  userId: string | undefined,
  sourceRemoteServerId: string | null | undefined,
): Promise<string | null> {
  if (ids.length > MAX_SESSION_GRANTS) {
    return `At most ${MAX_SESSION_GRANTS} remotes can be granted to one session`;
  }
  for (const id of ids) {
    if (sourceRemoteServerId && id === sourceRemoteServerId) {
      return `Remote ${id} is the machine this session runs on`;
    }
    const server = await storage.remoteServers.getById(id, userId);
    if (!server) return `Remote ${id} not found`;
    if (server.cross_remote_access === "off") {
      return `Remote ${server.name} has cross-remote access turned off`;
    }
  }
  return null;
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
