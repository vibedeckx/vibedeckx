import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { Storage } from "../storage/types.js";
import { ProcessManager } from "../process-manager.js";
import { AgentSessionManager } from "../agent-session-manager.js";
import { ChatSessionManager } from "../chat-session-manager.js";
import { ProjectChatManager } from "../project-chat-manager.js";
import { createRemoteProjectSessionReader } from "../project-chat-tools.js";
import { WorkflowEngine } from "../workflow-engine.js";
import { EventBus } from "../event-bus.js";
import { ProxyManager } from "../utils/proxy-manager.js";
import type { ProxyConfig } from "../utils/proxy-manager.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { RemotePatchCache } from "../remote-patch-cache.js";
import { ReverseConnectManager } from "../reverse-connect-manager.js";
import { BrowserManager } from "../browser-manager.js";
import { RemoteExecutorMonitor } from "../remote-executor-monitor.js";
import { SchedulerService } from "../scheduler.js";
import { NotificationService } from "../notification-service.js";
import { RemoteNotificationSync } from "../remote-notification-sync.js";
import { createRemoteAgentSession, createRemoteProjectChatSessionWithInstruction } from "../remote-agent-sessions.js";
import type { RemoteExecutorInfo, RemoteSessionInfo } from "../server-types.js";
import "../server-types.js";

interface SharedServicesOptions {
  storage: Storage;
  authEnabled?: boolean;
}

const sharedServices: FastifyPluginAsync<SharedServicesOptions> = async (fastify, opts) => {
  const processManager = new ProcessManager(opts.storage);
  const agentSessionManager = new AgentSessionManager(opts.storage);
  await agentSessionManager.restoreSessionsFromDb();
  const remoteExecutorMap = new Map<string, RemoteExecutorInfo>();

  const remoteSessionMap = new Map<string, RemoteSessionInfo>();

  // Hydrate remoteSessionMap from the persisted mapping table. URL/api key are
  // looked up from project_remotes (the authoritative source — no duplication).
  // Skip rows whose project_remotes row is gone (stale; will be cleaned up the
  // next time the user explicitly deletes the session).
  for (const row of await opts.storage.remoteSessionMappings.getAll()) {
    const remote = await opts.storage.projectRemotes.getByProjectAndServer(
      row.project_id,
      row.remote_server_id,
    );
    if (!remote) {
      console.warn(`[SharedServices] Skipping remote_session_mappings row ${row.local_session_id}: project_remotes(${row.project_id}, ${row.remote_server_id}) not found`);
      continue;
    }
    remoteSessionMap.set(row.local_session_id, {
      remoteServerId: row.remote_server_id,
      remoteSessionId: row.remote_session_id,
      branch: row.branch ?? null,
    });
  }
  console.log(`[SharedServices] Hydrated ${remoteSessionMap.size} remote session mapping(s) from DB`);

  const remotePatchCache = new RemotePatchCache();
  const eventBus = new EventBus();

  // Initialize proxy manager from stored settings
  const proxyManager = new ProxyManager();
  const savedProxy = await opts.storage.settings.get("proxy");
  if (savedProxy) {
    try {
      const config = JSON.parse(savedProxy) as ProxyConfig;
      proxyManager.updateConfig(config);
      if (config.type !== "none") {
        console.log(`[ProxyManager] Loaded ${config.type} proxy: ${config.host}:${config.port}`);
        if (opts.authEnabled) {
          // The browser-preview proxy egresses directly (with SSRF IP filtering),
          // not through this proxy. Make that explicit so the configured proxy is
          // not mistaken for the egress-control point in hosted mode.
          console.warn(
            "[ProxyManager] --auth is on with an outbound proxy configured. " +
            "Browser-preview egress uses direct connections with SSRF filtering and does NOT route through this proxy. " +
            "Enforce any additional egress policy at the proxy itself.",
          );
        }
      }
    } catch {
      console.warn("[ProxyManager] Failed to parse saved proxy config, using direct connection");
    }
  }

  const reverseConnectManager = new ReverseConnectManager();
  const browserManager = new BrowserManager();
  // Watches remote executor processes for completion independently of any
  // frontend log-proxy subscription (see RemoteExecutorMonitor). Shared across
  // all remoteExecutorMap.set sites (panel start, boot recovery, chat).
  const remoteExecutorMonitor = new RemoteExecutorMonitor(reverseConnectManager, eventBus, opts.storage, remoteExecutorMap);
  const scheduler = new SchedulerService(opts.storage, processManager, {
    reverseConnectManager,
    remoteExecutorMap,
    remoteExecutorMonitor,
  });
  const chatSessionManager = new ChatSessionManager(opts.storage, processManager, agentSessionManager, remoteSessionMap, remoteExecutorMap, remotePatchCache, reverseConnectManager, browserManager);
  const projectChatRemoteSessions = createRemoteProjectSessionReader({
    storage: opts.storage,
    proxy: (remoteServerId, method, apiPath) => proxyToRemoteAuto(
      remoteServerId,
      method,
      apiPath,
      undefined,
      { reverseConnectManager },
    ),
  });
  const projectChatManager = new ProjectChatManager(opts.storage, undefined, {
    eventBus,
    toolDependencies: {
      agentSessionManager,
      remoteSessions: projectChatRemoteSessions,
      mutationServices: {
        createAgentSession: async (input) => {
          if (input.target === "local") {
            const project = await opts.storage.projects.getById(input.projectId, input.userId);
            if (!project?.path) throw new Error("Project has no local path");
            const existing = await opts.storage.agentSessions.getById(input.sessionId);
            if (existing && existing.project_id !== input.projectId) {
              throw new Error("Session identity is already in use");
            }
            if (!existing) {
              await agentSessionManager.createNewSession(
                input.projectId, input.branch, project.path, false, input.permissionMode,
                input.agentType, true, false, { sessionId: input.workerSessionId, model: input.model },
              );
            }
            // Local stdin has no acknowledgement protocol. Retrying a durable
            // unconfirmed operation is intentionally at-least-once: a crash
            // after write may duplicate, but transcript persistence is never
            // treated as proof that stdin accepted the command.
            if (!(await agentSessionManager.sendUserMessage(
              input.workerSessionId, input.instruction, project.path, input.userId,
            ))) throw new Error("Agent session did not accept its initial instruction");
            return { sessionId: input.sessionId };
          }

          const association = await opts.storage.projectRemotes.getByProjectAndServer(
            input.projectId, input.target,
          );
          if (!association) throw new Error("Remote workspace is no longer authorized");
          return createRemoteProjectChatSessionWithInstruction({
            remoteSessionMap, remoteSessionMappings: opts.storage.remoteSessionMappings,
            remotePatchCache, agentSessionManager, reverseConnectManager, storage: opts.storage,
          }, {
            projectId: input.projectId, userId: input.userId, remoteServerId: input.target,
            remoteConfig: association, sessionId: input.sessionId,
            workerSessionId: input.workerSessionId, branch: input.branch,
            permissionMode: input.permissionMode, agentType: input.agentType, model: input.model,
            instruction: input.instruction, idempotencyKey: input.idempotencyKey,
          });
        },
        sendAgentInstruction: async (input) => {
          if (input.target === "local") {
            const project = await opts.storage.projects.getById(input.projectId, input.userId);
            return Boolean(project?.path) && agentSessionManager.sendUserMessage(
              input.sessionId, input.instruction, project!.path!, input.userId,
            );
          }
          const result = await proxyToRemoteAuto(
            input.target.remoteServerId, "POST",
            `/api/agent-sessions/${encodeURIComponent(input.target.remoteSessionId)}/message`,
            { content: input.instruction, idempotencyKey: input.idempotencyKey }, { reverseConnectManager },
          );
          return result.ok;
        },
        runScheduleNow: (scheduleId, runId) => scheduler.runNow(scheduleId, runId),
      },
    },
  });
  // Restore persisted remote executors by verifying against a connected
  // server's running process list and repopulating remoteExecutorMap.
  async function restoreRemoteExecutorsForServer(connectedServerId: string, machineId?: string): Promise<void> {
    // Only inspect rows still flagged 'running'. Finished rows are kept for
    // "Last run" lookup but should not be re-validated against the remote.
    const runningRows = await opts.storage.remoteExecutorProcesses.getRunning();
    const unrestoredRows = runningRows.filter(r => !remoteExecutorMap.has(r.local_process_id));
    if (unrestoredRows.length === 0) return;

    // Candidate selection determines which persisted rows this connection may
    // re-claim:
    //  - a VERIFIED machine identity: rows anchored to that machine (may carry
    //    a stale server ID after record recreation). The remote's self-reported
    //    process list below is then used only to prune dead processes — never
    //    to claim a row it doesn't already own.
    //  - without a verified machine (legacy/no-key remote): exact server-ID
    //    match only, and no aliasing. This denies the cross-tenant hijack that
    //    trusting self-reported process IDs allowed.
    const candidateRows = machineId
      ? unrestoredRows.filter(r => r.machine_id === machineId)
      : unrestoredRows.filter(r => r.remote_server_id === connectedServerId);
    if (candidateRows.length === 0) return;

    try {
      const result = await proxyToRemoteAuto(
        connectedServerId,
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
            // Register an alias only when the row was matched by a VERIFIED
            // machine identity. Without that proof (legacy connections) the
            // candidate set is already restricted to the exact server ID, so
            // this branch never aliases across server IDs.
            if (machineId && row.remote_server_id !== connectedServerId) {
              reverseConnectManager.addAlias(row.remote_server_id, connectedServerId);
              console.log(`[SharedServices] Registered server alias: ${row.remote_server_id} → ${connectedServerId}`);
            }
            // Restore with original server ID (frontend matches against project.executor_mode)
            const restoredInfo = {
              remoteServerId: row.remote_server_id,
              remoteProcessId: row.remote_process_id,
              executorId: row.executor_id,
              projectId: row.project_id ?? undefined,
              branch: row.branch,
            };
            remoteExecutorMap.set(row.local_process_id, restoredInfo);
            // Watch so a finish AFTER restart is still observed without an
            // active frontend log proxy.
            remoteExecutorMonitor.watch(row.local_process_id, restoredInfo);
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
            await opts.storage.remoteExecutorProcesses.markFinished(row.local_process_id, undefined, 'killed');
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
    void (async () => {
      await opts.storage.remoteServers.updateStatus(remoteServerId, status);
      // When a reverse connection comes online, restore any persisted remote executors
      if (status === "online") {
        const machineId = reverseConnectManager.getMachineId(remoteServerId);
        await restoreRemoteExecutorsForServer(remoteServerId, machineId);
      }
    })().catch(err => {
      console.warn(`[SharedServices] Failed to handle status change for ${remoteServerId}: ${err}`);
    });
  });

  fastify.decorate("storage", opts.storage);
  fastify.decorate("processManager", processManager);
  fastify.decorate("agentSessionManager", agentSessionManager);
  fastify.decorate("chatSessionManager", chatSessionManager);
  fastify.decorate("projectChatManager", projectChatManager);
  fastify.decorate("remoteExecutorMap", remoteExecutorMap);
  fastify.decorate("remoteExecutorMonitor", remoteExecutorMonitor);
  fastify.decorate("remoteSessionMap", remoteSessionMap);
  fastify.decorate("eventBus", eventBus);
  fastify.decorate("proxyManager", proxyManager);
  fastify.decorate("remotePatchCache", remotePatchCache);
  fastify.decorate("reverseConnectManager", reverseConnectManager);
  fastify.decorate("browserManager", browserManager);
  fastify.decorate("scheduler", scheduler);
  agentSessionManager.setEventBus(eventBus);

  // Durable notification inbox. Milestone producers (agent sessions, workflow
  // runs) only nudge it; the periodic + startup drains are what make delivery
  // survive a crash between the milestone commit and its import.
  const notificationService = new NotificationService(opts.storage, eventBus);
  fastify.decorate("notificationService", notificationService);
  agentSessionManager.setMilestoneListener(() => notificationService.requestDrain());

  // Pulls worker outboxes into the inbox. Independent of any session WebSocket
  // or open browser tab — that independence is the whole point: a remote result
  // produced while the front was down still arrives.
  const remoteNotificationSync = new RemoteNotificationSync({
    storage: opts.storage,
    notificationService,
    reverseConnectManager,
  });
  fastify.decorate("remoteNotificationSync", remoteNotificationSync);
  // Observe live remote activity: keeps a running session's mapping pollable
  // even when its turn outlives the watch window without emitting anything.
  remoteNotificationSync.setEventBus(eventBus);

  // A worker that just reconnected may hold milestones produced while it was
  // unreachable — sweep it immediately instead of waiting for the periodic tick,
  // and include expired mappings since the downtime may have outlasted their
  // watch windows. setStatusChangeHandler APPENDS (see ReverseConnectManager),
  // so this composes with the executor-restore handler registered above rather
  // than replacing it.
  reverseConnectManager.setStatusChangeHandler((remoteServerId, status) => {
    if (status !== "online") return;
    remoteNotificationSync.enqueue(() =>
      remoteNotificationSync.syncServer(remoteServerId, { includeExpired: true }),
    );
  });

  const workflowEngine = new WorkflowEngine(opts.storage, agentSessionManager);
  workflowEngine.setEventBus(eventBus);   // subscribe BEFORE chatSessionManager so ordering is explicit
  workflowEngine.setMilestoneListener(() => notificationService.requestDrain());
  await workflowEngine.init();
  fastify.decorate("workflowEngine", workflowEngine);
  chatSessionManager.setWorkflowEngine(workflowEngine);
  agentSessionManager.setWorkflowSuppressionCheck((sessionId) => workflowEngine.shouldSuppressAgentEvent(sessionId));

  chatSessionManager.setEventBus(eventBus);
  chatSessionManager.setRemoteExecutorMonitor(remoteExecutorMonitor);
  processManager.setEventBus(eventBus);
  scheduler.setEventBus(eventBus);
  await scheduler.start();

  // Startup drain closes the crash window: a milestone committed just before the
  // previous process died has no live nudge to ride, so it is recovered here.
  notificationService.start();
  notificationService.requestDrain();

  // One bounded full sweep now that persisted mappings are hydrated — this is
  // what recovers remote milestones produced while this front was offline. The
  // periodic timer afterwards only polls mappings inside their watch window, so
  // historical mappings aren't re-queried forever.
  remoteNotificationSync.start();
  remoteNotificationSync.enqueue(() => remoteNotificationSync.syncAll({ includeExpired: true }));

  // Graceful shutdown: kill child processes and clear timers when server closes
  fastify.addHook("onClose", async () => {
    scheduler.shutdown();
    notificationService.shutdown();
    remoteNotificationSync.shutdown();
    agentSessionManager.shutdown();
    processManager.shutdown();
    remotePatchCache.shutdown();
    remoteExecutorMonitor.shutdown();
    reverseConnectManager.shutdown();
    await projectChatManager.shutdown();
    await browserManager.shutdown();
  });
};

export default fp(sharedServices, { name: "shared-services" });
