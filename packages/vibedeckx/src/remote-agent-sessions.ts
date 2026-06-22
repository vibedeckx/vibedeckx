import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import { ConversationPatch } from "./conversation-patch.js";
import type { AgentMessage } from "./agent-types.js";
import type { Storage } from "./storage/types.js";
import type { RemoteSessionInfo } from "./server-types.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";

export interface RemoteAgentSessionDeps {
  remoteSessionMap: Map<string, RemoteSessionInfo>;
  remoteSessionMappings: Storage["remoteSessionMappings"];
  remotePatchCache: RemotePatchCache;
  agentSessionManager: AgentSessionManager;
  reverseConnectManager: ReverseConnectManager | null;
}

export type CreateRemoteAgentSessionResult =
  | { ok: true; localSessionId: string; remoteSession: { id: string }; messages: unknown[] }
  | { ok: false; status: number; data: unknown };

/**
 * Create an agent session on the remote server and register the local handle
 * (remoteSessionMap + persisted mapping + seeded patch cache). Identical to the
 * UI create path (agent-session-routes.ts) — both call this so the two paths
 * produce interoperable sessions. Throws only on transport errors; a non-2xx
 * remote response is returned as { ok: false }.
 */
export async function createRemoteAgentSession(
  deps: RemoteAgentSessionDeps,
  params: {
    projectId: string;
    agentMode: string;
    remoteConfig: { server_url: string | null; server_api_key?: string; remote_path?: string | null };
    branch: string | null;
    permissionMode: "plan" | "edit";
    agentType?: string;
  },
): Promise<CreateRemoteAgentSessionResult> {
  const { projectId, agentMode, remoteConfig, branch, permissionMode, agentType } = params;

  const result = await proxyToRemoteAuto(
    agentMode,
    remoteConfig.server_url ?? "",
    remoteConfig.server_api_key || "",
    "POST",
    `/api/path/agent-sessions/new`,
    { path: remoteConfig.remote_path, branch, permissionMode, agentType },
    { reverseConnectManager: deps.reverseConnectManager ?? undefined },
  );
  if (!result.ok) {
    return { ok: false, status: result.status, data: result.data };
  }

  const remoteData = result.data as { session: { id: string }; messages: unknown[] };
  const localSessionId = `remote-${agentMode}-${projectId}-${remoteData.session.id}`;

  deps.remoteSessionMap.set(localSessionId, {
    remoteServerId: agentMode,
    remoteUrl: remoteConfig.server_url ?? "",
    remoteApiKey: remoteConfig.server_api_key || "",
    remoteSessionId: remoteData.session.id,
    branch: branch ?? null,
  });
  deps.remoteSessionMappings.upsert(localSessionId, projectId, agentMode, remoteData.session.id, branch ?? null);

  if (remoteData.messages && remoteData.messages.length > 0) {
    const cacheEntry = deps.remotePatchCache.getOrCreate(localSessionId);
    if (cacheEntry.messages.length === 0) {
      for (let i = 0; i < remoteData.messages.length; i++) {
        const patch = ConversationPatch.addEntry(i, remoteData.messages[i] as AgentMessage);
        deps.remotePatchCache.appendMessage(localSessionId, JSON.stringify({ JsonPatch: patch }), true);
      }
    }
  }

  deps.agentSessionManager.emitBranchActivityIfChanged(projectId, branch ?? null, { activity: "idle", since: Date.now() });

  return { ok: true, localSessionId, remoteSession: remoteData.session, messages: remoteData.messages };
}
