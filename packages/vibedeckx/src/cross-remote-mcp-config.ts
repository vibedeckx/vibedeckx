import type { Storage } from "./storage/types.js";
import { getCrossRemoteSecret, signCrossRemoteToken } from "./utils/cross-remote-token.js";
import { CROSS_REMOTE_MCP_PATH } from "./cross-remote-access.js";

export interface CrossRemoteMcpConfig {
  url: string;
  token: string;
}

/** The gateway needs a publicly reachable base URL; without one the feature stays off. */
export function crossRemoteMcpEnabled(): boolean {
  return !!process.env.VIBEDECKX_PUBLIC_URL?.trim();
}

export function buildMcpConfigArg(config: CrossRemoteMcpConfig): string {
  return JSON.stringify({
    mcpServers: {
      "cross-remote": {
        type: "http",
        url: config.url,
        headers: { Authorization: `Bearer ${config.token}` },
      },
    },
  });
}

/**
 * Mints a session-scoped token, but only when the session could actually use it:
 * the public URL is configured, the caller is an authenticated user, and that user
 * owns at least one opted-in remote that is not the machine the agent runs on.
 * Otherwise the agent would see an empty tool surface for no reason.
 */
export async function mintCrossRemoteMcpConfig(
  deps: { storage: Pick<Storage, "remoteServers" | "settings"> },
  args: { userId: string | undefined; sessionId: string; sourceRemoteServerId: string | null },
): Promise<CrossRemoteMcpConfig | undefined> {
  const baseUrl = process.env.VIBEDECKX_PUBLIC_URL?.trim();
  if (!baseUrl) return undefined;

  // No userId (solo/no-auth mode): a token scoped to "" would resolve any tenant's
  // remote, because getById(id, "") skips the user_id predicate. Mint nothing.
  const { userId } = args;
  if (!userId) return undefined;

  const servers = await deps.storage.remoteServers.getAll(userId);
  const hasTarget = servers.some(
    (s) => s.cross_remote_access !== "off" && s.id !== args.sourceRemoteServerId,
  );
  if (!hasTarget) return undefined;

  const secret = await getCrossRemoteSecret(deps.storage);
  const token = signCrossRemoteToken(
    secret,
    { userId, sessionId: args.sessionId, sourceRemoteServerId: args.sourceRemoteServerId },
    Date.now(),
  );

  return { url: `${baseUrl.replace(/\/+$/, "")}${CROSS_REMOTE_MCP_PATH}`, token };
}
