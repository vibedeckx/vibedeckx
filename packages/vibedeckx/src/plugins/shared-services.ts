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
import type { RemoteExecutorInfo, RemoteSessionInfo } from "../server-types.js";
import "../server-types.js";

interface SharedServicesOptions {
  storage: Storage;
}

const sharedServices: FastifyPluginAsync<SharedServicesOptions> = async (fastify, opts) => {
  const processManager = new ProcessManager(opts.storage);
  const agentSessionManager = new AgentSessionManager(opts.storage);
  const chatSessionManager = new ChatSessionManager();
  const remoteExecutorMap = new Map<string, RemoteExecutorInfo>();
  const remoteSessionMap = new Map<string, RemoteSessionInfo>();
  const eventBus = new EventBus();
  const remotePatchCache = new RemotePatchCache();

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

  fastify.decorate("storage", opts.storage);
  fastify.decorate("processManager", processManager);
  fastify.decorate("agentSessionManager", agentSessionManager);
  fastify.decorate("chatSessionManager", chatSessionManager);
  fastify.decorate("remoteExecutorMap", remoteExecutorMap);
  fastify.decorate("remoteSessionMap", remoteSessionMap);
  fastify.decorate("eventBus", eventBus);
  fastify.decorate("proxyManager", proxyManager);
  fastify.decorate("remotePatchCache", remotePatchCache);
  agentSessionManager.setEventBus(eventBus);
  processManager.setEventBus(eventBus);
};

export default fp(sharedServices, { name: "shared-services" });
