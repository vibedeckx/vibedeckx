import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { Storage } from "../storage/types.js";
import { ProcessManager } from "../process-manager.js";
import { AgentSessionManager } from "../agent-session-manager.js";
import { ChatSessionManager } from "../chat-session-manager.js";
import { EventBus } from "../event-bus.js";
import { ProxyManager } from "../utils/proxy-manager.js";
import type { ProxyConfig } from "../utils/proxy-manager.js";
import { setGlobalProxyManager, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { RemotePatchCache } from "../remote-patch-cache.js";
import { ReverseConnectManager } from "../reverse-connect-manager.js";
import { BrowserManager } from "../browser-manager.js";
import type { RemoteExecutorInfo, RemoteSessionInfo } from "../server-types.js";
import "../server-types.js";

interface SharedServicesOptions {
  storage: Storage;
}

const sharedServices: FastifyPluginAsync<SharedServicesOptions> = async (fastify, opts) => {
  const processManager = new ProcessManager(opts.storage);
  const agentSessionManager = new AgentSessionManager(opts.storage);
  agentSessionManager.restoreSessionsFromDb();
  const remoteExecutorMap = new Map<string, RemoteExecutorInfo>();

  const remoteSessionMap = new Map<string, RemoteSessionInfo>();

  // Hydrate remoteSessionMap from the persisted mapping table. URL/api key are
  // looked up from project_remotes (the authoritative source — no duplication).
  // Skip rows whose project_remotes row is gone (stale; will be cleaned up the
  // next time the user explicitly deletes the session).
  for (const row of opts.storage.remoteSessionMappings.getAll()) {
    const remote = opts.storage.projectRemotes.getByProjectAndServer(
      row.project_id,
      row.remote_server_id,
    );
    if (!remote) {
      console.warn(`[SharedServices] Skipping remote_session_mappings row ${row.local_session_id}: project_remotes(${row.project_id}, ${row.remote_server_id}) not found`);
      continue;
    }
    remoteSessionMap.set(row.local_session_id, {
      remoteServerId: row.remote_server_id,
      remoteUrl: remote.server_url ?? "",
      remoteApiKey: remote.server_api_key || "",
      remoteSessionId: row.remote_session_id,
      branch: row.branch ?? null,
    });
  }
  console.log(`[SharedServices] Hydrated ${remoteSessionMap.size} remote session mapping(s) from DB`);

  const remotePatchCache = new RemotePatchCache();
  const eventBus = new EventBus();

  // Initialize proxy manager from stored settings
  const proxyManager = new ProxyManager();
  const savedProxy = opts.storage.settings.get("proxy");
  if (savedProxy) {
    try {
      const config = JSON.parse(savedProxy) as ProxyConfig;
      proxyManager.updateConfig(config);
      if (config.type !== "none") {
        console.log(`[ProxyManager] Loaded ${config.type} proxy: ${config.host}:${config.port}`);
      }
    } catch {
      console.warn("[ProxyManager] Failed to parse saved proxy config, using direct connection");
    }
  }
  setGlobalProxyManager(proxyManager);

  const reverseConnectManager = new ReverseConnectManager();
  const browserManager = new BrowserManager();
  const chatSessionManager = new ChatSessionManager(opts.storage, processManager, agentSessionManager, remoteSessionMap, remoteExecutorMap, remotePatchCache, reverseConnectManager, browserManager);
  // Restore persisted remote executors by verifying against a connected
  // server's running process list and repopulating remoteExecutorMap.
  // For direct-URL servers: only checks rows matching the exact server ID.
  // For reverse-connect: checks ALL unrestored rows (handles server ID changes).
  async function restoreRemoteExecutorsForServer(connectedServerId: string, directUrl?: string): Promise<void> {
    // Only inspect rows still flagged 'running'. Finished rows are kept for
    // "Last run" lookup but should not be re-validated against the remote.
    const runningRows = opts.storage.remoteExecutorProcesses.getRunning();
    const unrestoredRows = runningRows.filter(r => !remoteExecutorMap.has(r.local_process_id));
    if (unrestoredRows.length === 0) return;

    // For direct-URL servers: only check rows with matching server ID.
    // For reverse-connect: check all unrestored rows (process IDs are UUIDs, no collision risk).
    const candidateRows = directUrl
      ? unrestoredRows.filter(r => r.remote_server_id === connectedServerId)
      : unrestoredRows;
    if (candidateRows.length === 0) return;

    try {
      const result = await proxyToRemoteAuto(
        connectedServerId,
        directUrl ?? "",
        candidateRows[0].remote_api_key,
        "GET", "/api/executor-processes/running",
        undefined, { timeoutMs: 5000, reverseConnectManager },
      );
      if (result.ok) {
        const data = result.data as { processes?: Array<{ id: string }> };
        const processes = Array.isArray(data?.processes) ? data.processes : [];
        const runningIds = new Set(processes.map((p) => p.id));
        for (const row of candidateRows) {
          if (remoteExecutorMap.has(row.local_process_id)) continue;
          if (runningIds.has(row.remote_process_id)) {
            // Register alias if the stored server ID differs from the connected one
            if (row.remote_server_id !== connectedServerId) {
              reverseConnectManager.addAlias(row.remote_server_id, connectedServerId);
              console.log(`[SharedServices] Registered server alias: ${row.remote_server_id} → ${connectedServerId}`);
            }
            // Restore with original server ID (frontend matches against project.executor_mode)
            remoteExecutorMap.set(row.local_process_id, {
              remoteServerId: row.remote_server_id,
              remoteUrl: row.remote_url,
              remoteApiKey: row.remote_api_key,
              remoteProcessId: row.remote_process_id,
              executorId: row.executor_id,
              projectId: row.project_id ?? undefined,
              branch: row.branch,
            });
            eventBus.emit({
              type: "executor:started",
              projectId: row.project_id ?? "",
              executorId: row.executor_id,
              processId: row.local_process_id,
              target: row.remote_server_id,
            });
            console.log(`[SharedServices] Restored remote executor: ${row.local_process_id}`);
          } else if (row.remote_server_id === connectedServerId) {
            // The remote no longer has this process — mark it finished so the
            // row stays for "Last run" lookup but isn't re-validated next time.
            opts.storage.remoteExecutorProcesses.markFinished(row.local_process_id, undefined, 'killed');
            console.log(`[SharedServices] Marked stale remote executor as finished: ${row.local_process_id}`);
          }
        }
      } else {
        console.warn(`[SharedServices] Could not verify remote executors on ${connectedServerId} (status ${result.status})`);
      }
    } catch (err) {
      console.warn(`[SharedServices] Failed to verify remote executors on ${connectedServerId}: ${err}`);
    }
  }

  reverseConnectManager.setStatusChangeHandler((remoteServerId, status) => {
    opts.storage.remoteServers.updateStatus(remoteServerId, status);
    // When a reverse connection comes online, restore any persisted remote executors
    if (status === "online") {
      restoreRemoteExecutorsForServer(remoteServerId).catch(err => {
        console.warn(`[SharedServices] Failed to restore remote executors on reconnect for ${remoteServerId}: ${err}`);
      });
    }
  });

  fastify.decorate("storage", opts.storage);
  fastify.decorate("processManager", processManager);
  fastify.decorate("agentSessionManager", agentSessionManager);
  fastify.decorate("chatSessionManager", chatSessionManager);
  fastify.decorate("remoteExecutorMap", remoteExecutorMap);
  fastify.decorate("remoteSessionMap", remoteSessionMap);
  fastify.decorate("eventBus", eventBus);
  fastify.decorate("proxyManager", proxyManager);
  fastify.decorate("remotePatchCache", remotePatchCache);
  fastify.decorate("reverseConnectManager", reverseConnectManager);
  fastify.decorate("browserManager", browserManager);
  agentSessionManager.setEventBus(eventBus);
  chatSessionManager.setEventBus(eventBus);
  processManager.setEventBus(eventBus);

  // Restore remote executor processes from DB in the background.
  // Only processes direct-URL servers here; reverse-connect servers are
  // restored when they reconnect (via the status change handler above).
  void (async () => {
    const savedRows = opts.storage.remoteExecutorProcesses.getRunning();
    // Only process rows with a direct URL — reverse-connect rows (empty URL)
    // will be restored when their connection comes online
    const directUrlRows = savedRows.filter(r => r.remote_url);
    if (directUrlRows.length === 0) return;

    const byServer = new Map<string, string>();
    for (const r of directUrlRows) byServer.set(r.remote_server_id, r.remote_url);

    console.log(`[SharedServices] Found ${directUrlRows.length} persisted direct-URL remote executor(s), verifying...`);

    for (const [serverId, url] of byServer) {
      await restoreRemoteExecutorsForServer(serverId, url);
    }
  })().catch(err => {
    console.error(`[SharedServices] Unexpected error in remote executor restore:`, err);
  });

  // Graceful shutdown: kill child processes and clear timers when server closes
  fastify.addHook("onClose", async () => {
    agentSessionManager.shutdown();
    processManager.shutdown();
    remotePatchCache.shutdown();
    reverseConnectManager.shutdown();
    await browserManager.shutdown();
  });
};

export default fp(sharedServices, { name: "shared-services" });
