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
  // Restore persisted remote executors for a specific server by verifying
  // against the remote's running process list and repopulating remoteExecutorMap.
  async function restoreRemoteExecutorsForServer(serverId: string): Promise<void> {
    const allRows = opts.storage.remoteExecutorProcesses.getAll();
    console.log(`[DEBUG restoreForServer] serverId=${serverId}, allRows=${allRows.length}, allServerIds=${JSON.stringify([...new Set(allRows.map(r => r.remote_server_id))])}`);
    const rows = allRows.filter(r => r.remote_server_id === serverId);
    if (rows.length === 0) {
      console.log(`[DEBUG restoreForServer] No rows match serverId=${serverId}, skipping`);
      return;
    }

    // Skip if already restored
    if (rows.every(r => remoteExecutorMap.has(r.local_process_id))) return;

    try {
      const { remote_url, remote_api_key } = rows[0];
      const result = await proxyToRemoteAuto(
        serverId, remote_url, remote_api_key,
        "GET", "/api/executor-processes/running",
        undefined, { timeoutMs: 5000, reverseConnectManager },
      );
      if (result.ok) {
        const data = result.data as { processes?: Array<{ id: string }> };
        const processes = Array.isArray(data?.processes) ? data.processes : [];
        const runningIds = new Set(processes.map((p) => p.id));
        for (const row of rows) {
          if (remoteExecutorMap.has(row.local_process_id)) continue;
          if (runningIds.has(row.remote_process_id)) {
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
          } else {
            opts.storage.remoteExecutorProcesses.delete(row.local_process_id);
            console.log(`[SharedServices] Cleaned up stale remote executor: ${row.local_process_id}`);
          }
        }
      } else {
        console.warn(`[SharedServices] Could not verify remote executors on ${serverId} (status ${result.status})`);
      }
    } catch (err) {
      console.warn(`[SharedServices] Failed to verify remote executors on ${serverId}: ${err}`);
    }
  }

  reverseConnectManager.setStatusChangeHandler((remoteServerId, status) => {
    console.log(`[DEBUG statusChange] remoteServerId=${remoteServerId}, status=${status}`);
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
  // Servers reachable now are restored immediately; reverse-connect servers
  // are restored when they reconnect (via the status change handler above).
  void (async () => {
    const savedRows = opts.storage.remoteExecutorProcesses.getAll();
    if (savedRows.length === 0) return;

    const serverIds = new Set(savedRows.map(r => r.remote_server_id));
    console.log(`[SharedServices] Found ${savedRows.length} persisted remote executor(s) across ${serverIds.size} server(s), verifying...`);

    for (const serverId of serverIds) {
      await restoreRemoteExecutorsForServer(serverId);
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
