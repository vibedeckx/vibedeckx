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
  reverseConnectManager.setStatusChangeHandler((remoteServerId, status) => {
    opts.storage.remoteServers.updateStatus(remoteServerId, status);
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
  // This is intentionally fire-and-forget to avoid blocking plugin
  // registration (proxyToRemote retries can exceed Fastify's plugin timeout).
  void (async () => {
    const savedRemoteExecutors = opts.storage.remoteExecutorProcesses.getAll();
    if (savedRemoteExecutors.length === 0) return;

    console.log(`[SharedServices] Found ${savedRemoteExecutors.length} persisted remote executor(s), verifying...`);

    // Group by remote server ID to batch verification calls
    const byServer = new Map<string, typeof savedRemoteExecutors>();
    for (const row of savedRemoteExecutors) {
      const group = byServer.get(row.remote_server_id) ?? [];
      group.push(row);
      byServer.set(row.remote_server_id, group);
    }

    for (const [serverId, rows] of byServer) {
      try {
        const { remote_url, remote_api_key } = rows[0];
        // Skip verification if no URL and no active reverse connection
        if (!remote_url && !reverseConnectManager.isConnected(serverId)) {
          console.log(`[SharedServices] Remote server ${serverId} has no URL and no reverse connection, keeping DB rows for later`);
          continue;
        }
        const result = await proxyToRemoteAuto(
          serverId,
          remote_url,
          remote_api_key,
          "GET",
          "/api/executor-processes/running",
          undefined,
          { timeoutMs: 5000, reverseConnectManager },
        );
        if (result.ok) {
          const data = result.data as { processes?: Array<{ id: string }> };
          const processes = Array.isArray(data?.processes) ? data.processes : [];
          const runningIds = new Set(processes.map((p) => p.id));
          for (const row of rows) {
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
              console.log(`[SharedServices] Restored remote executor: ${row.local_process_id}`);
            } else {
              opts.storage.remoteExecutorProcesses.delete(row.local_process_id);
              console.log(`[SharedServices] Cleaned up stale remote executor: ${row.local_process_id}`);
            }
          }
        } else {
          console.warn(`[SharedServices] Could not reach remote server ${serverId} (status ${result.status}), keeping DB rows for later retry`);
        }
      } catch (err) {
        console.warn(`[SharedServices] Failed to verify remote executors on ${serverId}: ${err}`);
      }
    }
  })();

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
