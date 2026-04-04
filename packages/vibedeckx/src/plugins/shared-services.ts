import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { Storage } from "../storage/types.js";
import { ProcessManager } from "../process-manager.js";
import { AgentSessionManager } from "../agent-session-manager.js";
import { ChatSessionManager } from "../chat-session-manager.js";
import { EventBus } from "../event-bus.js";
import { ProxyManager } from "../utils/proxy-manager.js";
import type { ProxyConfig } from "../utils/proxy-manager.js";
import { setGlobalProxyManager } from "../utils/remote-proxy.js";
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
