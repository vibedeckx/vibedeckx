import type { Storage } from "./storage/types.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import {
  AGENT_PROCESS_SETTING_KEY,
  DEFAULT_AGENT_PROCESS_SETTINGS,
  parseStoredAgentProcessSettings,
  type AgentProcessSettings,
} from "./resident-agent-processes.js";

/**
 * Push a user's resident-agent-process limit down to their workers.
 *
 * On the hub the limit is per user (`user_settings`), and a user's value only
 * ever goes to that user's own remote servers. A worker belongs to one user,
 * so it keeps the value machine-wide in `settings`, which is what its
 * ensureResidentCapacity reads — same shape as the session-retention downlink.
 *
 * Unlike retention there is no separate `/apply` receiver: the hub reuses the
 * operator PUT every worker has had since the feature shipped, so no worker
 * release is needed. The fan-out is skipped on reverse-connect workers (see
 * the route), which is what keeps a worker from pushing onward.
 */

export const AGENT_PROCESS_DOWNLINK_PATH = "/api/settings/agent-processes";

export interface AgentProcessPushResult {
  remoteServerId: string;
  name: string;
  /**
   * "applied"; "offline" — no tunnel (or it dropped mid-request), so the
   * reconnect push will deliver it; "error" — the tunnel is up but the worker
   * timed out or failed, nothing will retry, the user has to save again.
   */
  status: "applied" | "offline" | "error";
  detail?: string;
}

export interface AgentProcessDownlinkDeps {
  storage: Storage;
  reverseConnectManager: ReverseConnectManager;
  timeoutMs?: number;
}

/**
 * The limit this user explicitly saved on the hub, or null if they never did.
 * Null means "don't push": a worker keeps whatever it has rather than being
 * reset to the default by a user who never expressed a value.
 */
export async function readUserAgentProcessSettings(
  storage: Storage,
  userId: string,
): Promise<AgentProcessSettings | null> {
  return parseStoredAgentProcessSettings(await storage.userSettings.get(userId, AGENT_PROCESS_SETTING_KEY));
}

/**
 * The limit in effect for a user on the hub: their own value, else the
 * pre-per-user machine-wide value (so an existing solo setup keeps its
 * number), else the default. Never pushed as-is — only explicit values are.
 */
export async function resolveUserAgentProcessSettings(
  storage: Storage,
  userId: string,
): Promise<AgentProcessSettings> {
  return (
    (await readUserAgentProcessSettings(storage, userId)) ??
    parseStoredAgentProcessSettings(await storage.settings.get(AGENT_PROCESS_SETTING_KEY)) ??
    DEFAULT_AGENT_PROCESS_SETTINGS
  );
}

/**
 * Send the limit to one worker. Never throws, and never retries: a worker that
 * is down is reported as offline and picks the value up the next time it
 * connects (shared-services re-pushes on every "online" transition); any other
 * failure is reported for the user to retry by saving again.
 */
export async function pushAgentProcessSettingsToWorker(
  deps: AgentProcessDownlinkDeps,
  server: { id: string; name: string },
  settings: AgentProcessSettings,
): Promise<AgentProcessPushResult> {
  try {
    const result = await proxyToRemoteAuto(
      server.id,
      "PUT",
      AGENT_PROCESS_DOWNLINK_PATH,
      settings,
      { reverseConnectManager: deps.reverseConnectManager, timeoutMs: deps.timeoutMs ?? 10_000 },
    );
    if (result.ok) return { remoteServerId: server.id, name: server.name, status: "applied" };
    // No live tunnel — not connected, or closed while the request was in
    // flight. Either way the next "online" transition re-pushes.
    if (result.errorCode === "network_error") {
      return { remoteServerId: server.id, name: server.name, status: "offline" };
    }
    // The tunnel stayed up, so no reconnect will come to fix this. A timeout
    // may still have been applied late; the user is told to save again.
    return {
      remoteServerId: server.id, name: server.name, status: "error",
      detail: result.errorCode === "timeout" ? "timed out" : `worker responded ${result.status}`,
    };
  } catch (error) {
    return {
      remoteServerId: server.id, name: server.name, status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Fan the limit out to this user's remote servers, one result row per worker. */
export async function pushAgentProcessSettingsToWorkers(
  deps: AgentProcessDownlinkDeps,
  userId: string,
  settings: AgentProcessSettings,
): Promise<AgentProcessPushResult[]> {
  const servers = await deps.storage.remoteServers.getAll(userId);
  return Promise.all(servers.map((server) => pushAgentProcessSettingsToWorker(deps, server, settings)));
}
