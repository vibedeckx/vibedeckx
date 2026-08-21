import type { Storage } from "./storage/types.js";
import type { ProcessManager } from "./process-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { ChatSessionManager } from "./chat-session-manager.js";
import type { ProjectChatManager } from "./project-chat-manager.js";
import type { EventBus } from "./event-bus.js";
import type { ProxyManager } from "./utils/proxy-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import type { BrowserManager } from "./browser-manager.js";
import type { RemoteExecutorMonitor } from "./remote-executor-monitor.js";
import type { SchedulerService } from "./scheduler.js";
import type { NotificationService } from "./notification-service.js";
import type { RemoteNotificationSync } from "./remote-notification-sync.js";
import type { SessionRetentionSweeper } from "./session-retention.js";
import type { RemoteSessionReconciler } from "./remote-session-reconcile-service.js";
import type { RemoteMcpSessionManager } from "./remote-mcp-session-manager.js";

export interface RemoteExecutorInfo {
  remoteServerId: string;
  remoteProcessId: string;
  executorId: string;
  projectId?: string;
  branch?: string | null;
  /** Set to true after executor:stopped has been emitted to prevent double emission */
  stoppedEmitted?: boolean;
}

export interface RemoteSessionInfo {
  remoteServerId: string;
  remoteSessionId: string;
  branch?: string | null;
}

declare module "fastify" {
  interface FastifyInstance {
    storage: Storage;
    processManager: ProcessManager;
    agentSessionManager: AgentSessionManager;
    chatSessionManager: ChatSessionManager;
    projectChatManager: ProjectChatManager;
    remoteExecutorMap: Map<string, RemoteExecutorInfo>;
    remoteExecutorMonitor: RemoteExecutorMonitor;
    remoteSessionMap: Map<string, RemoteSessionInfo>;
    eventBus: EventBus;
    proxyManager: ProxyManager;
    remotePatchCache: RemotePatchCache;
    reverseConnectManager: ReverseConnectManager;
    authEnabled: boolean;
    noLocalProjects: boolean;
    /** Build fingerprint of the UI assets this server serves; undefined = API-only or pre-build-id bundle. */
    uiBuildId: string | undefined;
    browserManager: BrowserManager;
    scheduler: SchedulerService;
    notificationService: NotificationService;
    remoteNotificationSync: RemoteNotificationSync;
    sessionRetention: SessionRetentionSweeper;
    remoteSessionReconciler: RemoteSessionReconciler;
    remoteMcpSessionManager: RemoteMcpSessionManager;
    workflowEngine: import("./workflow-engine.js").WorkflowEngine;
  }
}
