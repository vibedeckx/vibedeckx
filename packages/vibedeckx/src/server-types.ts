import type { Storage } from "./storage/types.js";
import type { ProcessManager } from "./process-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { EventBus } from "./event-bus.js";
import type { ProxyManager } from "./utils/proxy-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";

export interface RemoteExecutorInfo {
  remoteUrl: string;
  remoteApiKey: string;
  remoteProcessId: string;
  projectId?: string;
  branch?: string | null;
}

export interface RemoteSessionInfo {
  remoteUrl: string;
  remoteApiKey: string;
  remoteSessionId: string;
}

declare module "fastify" {
  interface FastifyInstance {
    storage: Storage;
    processManager: ProcessManager;
    agentSessionManager: AgentSessionManager;
    remoteExecutorMap: Map<string, RemoteExecutorInfo>;
    remoteSessionMap: Map<string, RemoteSessionInfo>;
    eventBus: EventBus;
    proxyManager: ProxyManager;
    remotePatchCache: RemotePatchCache;
  }
}
