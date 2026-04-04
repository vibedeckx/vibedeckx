import type { Storage } from "./storage/types.js";
import type { ProcessManager } from "./process-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { ChatSessionManager } from "./chat-session-manager.js";
import type { EventBus } from "./event-bus.js";
import type { ProxyManager } from "./utils/proxy-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import type { BrowserManager } from "./browser-manager.js";

export interface RemoteExecutorInfo {
  remoteServerId: string;
  remoteUrl: string;
  remoteApiKey: string;
  remoteProcessId: string;
  executorId: string;
  projectId?: string;
  branch?: string | null;
}

export interface RemoteSessionInfo {
  remoteServerId: string;
  remoteUrl: string;
  remoteApiKey: string;
  remoteSessionId: string;
  branch?: string | null;
}

declare module "fastify" {
  interface FastifyInstance {
    storage: Storage;
    processManager: ProcessManager;
    agentSessionManager: AgentSessionManager;
    chatSessionManager: ChatSessionManager;
    remoteExecutorMap: Map<string, RemoteExecutorInfo>;
    remoteSessionMap: Map<string, RemoteSessionInfo>;
    eventBus: EventBus;
    proxyManager: ProxyManager;
    remotePatchCache: RemotePatchCache;
    reverseConnectManager: ReverseConnectManager;
    authEnabled: boolean;
    browserManager: BrowserManager;
  }
}
