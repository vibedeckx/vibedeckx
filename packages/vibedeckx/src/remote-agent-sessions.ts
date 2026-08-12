import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import { ConversationPatch } from "./conversation-patch.js";
import { generateSessionTitle, snippetTitle } from "./utils/session-title.js";
import type { AgentMessage } from "./agent-types.js";
import type { RemoteReviewerCreationIntent, RemoteSessionActivityUpdateResult, RemoteSessionCreationIntent, ReviewSpan, Storage, WorkflowRun } from "./storage/types.js";
import type { RemoteSessionInfo } from "./server-types.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import { VirtualWsAdapter } from "./virtual-ws-adapter.js";
import { statusEventFromRemotePatch, projectIdFromRemoteSessionId, taskCompletedEventFromRemoteFrame, runUpdatedEventFromRemoteFrame, runUpdatedFrameForSubscribers } from "./routes/remote-status-bridge.js";
import type { EventBus } from "./event-bus.js";
import { mintCrossRemoteMcpConfig } from "./cross-remote-mcp-config.js";
import { WATCH_WINDOW_MS as NOTIFICATION_WATCH_WINDOW_MS } from "./remote-notification-sync.js";
import { conventionalWorktreePath } from "./utils/worktree-paths.js";

export interface RemoteAgentSessionDeps {
  remoteSessionMap: Map<string, RemoteSessionInfo>;
  remoteSessionMappings: Storage["remoteSessionMappings"];
  remotePatchCache: RemotePatchCache;
  agentSessionManager: AgentSessionManager;
  reverseConnectManager: ReverseConnectManager | null;
  storage: Storage;
}

export type CreateRemoteAgentSessionResult =
  | { ok: true; localSessionId: string; remoteSession: { id: string; processAlive?: boolean; [key: string]: unknown }; messages: unknown[] }
  | { ok: false; status: number; data: unknown };

export interface CreateRemoteBranchedSessionParams {
  projectId: string;
  agentMode: string;
  remotePath: string;
  branch: string | null;
  sourceRemoteSessionId: string;
  agentType?: string;
  upToEntryIndex?: number;
  userId: string | undefined;
  remoteSessionId?: string;
  localSessionId?: string;
}

export interface CreateRemoteWorkflowReviewerParams {
  projectId: string;
  agentMode: string;
  remotePath: string;
  branch: string | null;
  sourceRemoteSessionId: string;
  reviewFocus?: string;
  sourceTurnEndIndex?: number;
  reviewSpan: ReviewSpan;
  reviewerAgentType: string;
  intentBrief?: string;
  userId: string | undefined;
  remoteRunId?: string;
  remoteReviewerSessionId?: string;
  localReviewerSessionId?: string;
}

export type CreateRemoteWorkflowReviewerResult =
  | {
    ok: true;
    localReviewerSessionId: string;
    remoteReviewerSessionId: string;
    remoteRun: WorkflowRun;
  }
  | { ok: false; status: number; data: unknown };

export async function bindRemoteSessionMapping(
  storage: Storage,
  opts: {
    localSessionId: string;
    projectId: string;
    remoteServerId: string;
    remoteSessionId: string;
    branch: string | null;
    remotePath: string;
    reportedWorktreePath?: string | null;
    notificationSyncStart?: "from_start" | "from_now";
    mappingRepo?: Storage["remoteSessionMappings"];
  },
): Promise<void> {
  const mappingRepo = opts.mappingRepo ?? storage.remoteSessionMappings;
  const existingMapping = await mappingRepo.getByLocal(opts.localSessionId);
  if (existingMapping?.workspace_checkout_id) {
    if (existingMapping.project_id !== opts.projectId
      || existingMapping.remote_server_id !== opts.remoteServerId
      || existingMapping.remote_session_id !== opts.remoteSessionId
      || (existingMapping.branch ?? "") !== (opts.branch ?? "")) {
      throw new Error(`Remote session mapping ${opts.localSessionId} has conflicting workspace identity`);
    }
    // Never move an already-bound historical session to the active
    // incarnation merely because the same branch name was recreated.
    return;
  }
  const branchKey = opts.branch ?? "";
  const fallbackPath = opts.branch
    ? conventionalWorktreePath(opts.remotePath, opts.branch)
    : opts.remotePath;
  let registered = await storage.workspaceRegistry.getByProjectBranch(
    opts.projectId, branchKey, opts.remoteServerId,
  );
  // A reported worker path is authoritative. Absence means an old worker and
  // never replaces a path already persisted by a newer worker.
  if (!registered || (opts.reportedWorktreePath
    && (registered.checkout.path_source !== "reported"
      || registered.checkout.worktree_path !== opts.reportedWorktreePath))) {
    registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: opts.projectId,
      branch: branchKey,
      targetId: opts.remoteServerId,
      worktreePath: opts.reportedWorktreePath ?? fallbackPath,
      expectedBranch: branchKey,
      pathSource: opts.reportedWorktreePath ? "reported" : "conventional",
    });
  }
  await mappingRepo.upsertBound({
    localSessionId: opts.localSessionId,
    projectId: opts.projectId,
    remoteServerId: opts.remoteServerId,
    remoteSessionId: opts.remoteSessionId,
    branch: opts.branch,
    checkoutId: registered.checkout.id,
    notificationSyncStart: opts.notificationSyncStart,
  });
}

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
    remoteConfig: { remote_path?: string | null };
    branch: string | null;
    permissionMode: "plan" | "edit";
    agentType?: string;
    model?: string | null;
    force?: boolean;
    userId: string | undefined;
    remoteSessionId?: string;
    localSessionId?: string;
  },
): Promise<CreateRemoteAgentSessionResult> {
  const { projectId, agentMode, remoteConfig, branch, permissionMode, agentType, model, force, userId } = params;

  // The server picks the session id so it can mint a token bound to it before the
  // remote spawns claude. The remote honours the supplied id.
  const remoteSessionId = params.remoteSessionId ?? randomUUID();
  const localSessionId = params.localSessionId ?? `remote-${agentMode}-${projectId}-${remoteSessionId}`;
  if (!remoteConfig.remote_path) throw new Error("Remote project has no workspace path");

  // Durable saga boundary: this lands before any worker call. A front crash
  // after the worker creates the session leaves enough identity to replay the
  // exact same request (worker session IDs are idempotent).
  await deps.storage.remoteSessionCreationIntents.begin({
    localSessionId,
    remoteSessionId,
    projectId,
    remoteServerId: agentMode,
    branch: branch ?? null,
    remotePath: remoteConfig.remote_path,
    permissionMode,
    agentType: agentType ?? null,
    model: model ?? null,
    force: force ?? false,
    userId: userId ?? null,
  });

  const crossRemoteMcp = await mintCrossRemoteMcpConfig(
    { storage: deps.storage },
    { userId, sessionId: localSessionId, sourceRemoteServerId: agentMode },
  );

  // Register before the call, not after: createNewSession on the remote spawns claude
  // before it responds, and claude connects to its MCP servers at startup. A late
  // registration would make isSessionUsable reject the agent's first tool call.
  deps.remoteSessionMap.set(localSessionId, {
    remoteServerId: agentMode,
    remoteSessionId,
    branch: branch ?? null,
  });

  // Everything after the pre-registration must clean up the map entry on *any*
  // failure — a returned { ok: false } as well as a thrown transport/DB error.
  // Otherwise a stale entry keeps a dead session id "usable" to the gateway
  // (isSessionUsable checks remoteSessionMap.has) until process restart.
  let remoteData: { session: { id: string; processAlive?: boolean; [key: string]: unknown }; messages: unknown[] };
  try {
    const result = await proxyToRemoteAuto(
      agentMode,
      "POST",
      `/api/path/agent-sessions/new`,
      { path: remoteConfig.remote_path, branch, permissionMode, agentType, force, sessionId: remoteSessionId, crossRemoteMcp, model },
      { reverseConnectManager: deps.reverseConnectManager ?? undefined },
    );
    if (!result.ok) {
      deps.remoteSessionMap.delete(localSessionId);
      const uncertain = result.errorCode === "network_error" || result.errorCode === "timeout";
      await (uncertain
        ? deps.storage.remoteSessionCreationIntents.recordError(
          localSessionId, `worker result unknown: ${result.errorCode}`,
        )
        : deps.storage.remoteSessionCreationIntents.discard(localSessionId));
      return { ok: false, status: result.status, data: result.data };
    }

    remoteData = result.data as { session: { id: string; processAlive?: boolean; [key: string]: unknown }; messages: unknown[] };
    if (remoteData.session.id !== remoteSessionId) {
      // An older remote that ignores the supplied id. Fail closed: the token we minted
      // names a session that does not exist, so cross-remote calls would be rejected
      // anyway, and the map entry we registered would be wrong.
      deps.remoteSessionMap.delete(localSessionId);
      await deps.storage.remoteSessionCreationIntents.discard(localSessionId);
      return { ok: false, status: 409, data: { error: "Remote returned an unexpected session id; upgrade the remote" } };
    }

    // from_start: this front just created the session, so it has no unrelated
    // history to suppress — and sequence zero closes the race where the very
    // first turn completes before this mapping row exists.
    await bindRemoteSessionMapping(deps.storage, {
      localSessionId,
      projectId,
      remoteServerId: agentMode,
      remoteSessionId,
      branch: branch ?? null,
      remotePath: remoteConfig.remote_path,
      reportedWorktreePath: typeof remoteData.session.worktreePath === "string"
        ? remoteData.session.worktreePath : null,
      notificationSyncStart: "from_start",
      mappingRepo: deps.remoteSessionMappings,
    });
    await deps.storage.remoteSessionCreationIntents.confirm(localSessionId);
    // Bring the new session into the periodic notification-poll set so its first
    // result is picked up even if no stream or browser tab is watching.
    await deps.remoteSessionMappings
      .extendNotificationWatch(localSessionId, Date.now() + NOTIFICATION_WATCH_WINDOW_MS)
      .catch((err) => console.warn("[RemoteSession] notification watch extend failed:", err));
    // Search-cache write-through: surface the new session in Cmd+K now instead
    // of after the next on-open refresh. Best-effort — the session exists on
    // the remote at this point, so a cache failure must not fail the create.
    const activityProjectionReady = await deps.storage.searchCache.noteSessionCreated({
      localSessionId, projectId, targetId: agentMode, branch: branch ?? null,
      title: typeof remoteData.session.title === "string" ? remoteData.session.title : null,
      ...(remoteData.session.status === "running" || remoteData.session.status === "stopped"
        || remoteData.session.status === "error" ? { status: remoteData.session.status } : {}),
      agentType: typeof remoteData.session.agent_type === "string" ? remoteData.session.agent_type : agentType ?? null,
      model: typeof remoteData.session.model === "string" ? remoteData.session.model : model ?? null,
    }).then(() => true).catch((err) => {
      console.error("[RemoteSession] search-cache create write-through failed:", err);
      return false;
    });
    if (activityProjectionReady) {
      deps.agentSessionManager.emitBranchActivityIfChanged(
        projectId, branch ?? null, { activity: "idle", since: Date.now() },
      );
    }
  } catch (err) {
    // A thrown transport error (reverse-connect send) or DB write rejection leaves
    // the pre-registered entry orphaned. Remove it, then rethrow so the caller's
    // existing 502 behavior is preserved and the original error is not swallowed.
    deps.remoteSessionMap.delete(localSessionId);
    await deps.storage.remoteSessionCreationIntents.recordError(
      localSessionId, err instanceof Error ? err.message : String(err),
    ).catch((intentError) => console.warn("[RemoteSession] Failed to record creation intent error:", intentError));
    throw err;
  }

  if (remoteData.messages && remoteData.messages.length > 0) {
    const cacheEntry = deps.remotePatchCache.getOrCreate(localSessionId);
    if (cacheEntry.messages.length === 0) {
      for (let i = 0; i < remoteData.messages.length; i++) {
        const patch = ConversationPatch.addEntry(i, remoteData.messages[i] as AgentMessage);
        deps.remotePatchCache.appendMessage(localSessionId, JSON.stringify({ JsonPatch: patch }), true);
      }
    }
  }

  return { ok: true, localSessionId, remoteSession: remoteData.session, messages: remoteData.messages };
}

/** Durable, idempotent counterpart of the remote conversation-branch route. */
export async function createRemoteBranchedSession(
  deps: RemoteAgentSessionDeps,
  params: CreateRemoteBranchedSessionParams,
): Promise<CreateRemoteAgentSessionResult> {
  const remoteSessionId = params.remoteSessionId ?? randomUUID();
  const localSessionId = params.localSessionId
    ?? `remote-${params.agentMode}-${params.projectId}-${remoteSessionId}`;
  await deps.storage.remoteSessionCreationIntents.begin({
    localSessionId,
    remoteSessionId,
    projectId: params.projectId,
    remoteServerId: params.agentMode,
    branch: params.branch,
    remotePath: params.remotePath,
    // These columns predate operation_kind and remain required. A branch
    // inherits its effective mode/model on the worker; they are not replay
    // inputs for this operation.
    permissionMode: "edit",
    agentType: params.agentType ?? null,
    model: null,
    force: false,
    userId: params.userId ?? null,
    operationKind: "branch",
    sourceRemoteSessionId: params.sourceRemoteSessionId,
    upToEntryIndex: params.upToEntryIndex ?? null,
  });

  const crossRemoteMcp = await mintCrossRemoteMcpConfig(
    { storage: deps.storage },
    { userId: params.userId, sessionId: localSessionId, sourceRemoteServerId: params.agentMode },
  );
  deps.remoteSessionMap.set(localSessionId, {
    remoteServerId: params.agentMode,
    remoteSessionId,
    branch: params.branch,
  });

  try {
    const result = await proxyToRemoteAuto(
      params.agentMode,
      "POST",
      `/api/path/agent-sessions/${params.sourceRemoteSessionId}/branch`,
      { agentType: params.agentType, sessionId: remoteSessionId, crossRemoteMcp, upToEntryIndex: params.upToEntryIndex },
      { reverseConnectManager: deps.reverseConnectManager ?? undefined },
    );
    if (!result.ok) {
      deps.remoteSessionMap.delete(localSessionId);
      const uncertain = result.errorCode === "network_error" || result.errorCode === "timeout";
      await (uncertain
        ? deps.storage.remoteSessionCreationIntents.recordError(
          localSessionId, `worker result unknown: ${result.errorCode}`,
        )
        : deps.storage.remoteSessionCreationIntents.discard(localSessionId));
      return { ok: false, status: result.status, data: result.data };
    }

    const remoteData = result.data as {
      session: { id: string; processAlive?: boolean; [key: string]: unknown };
      messages: unknown[];
    };
    if (remoteData.session.id !== remoteSessionId
      || (params.upToEntryIndex !== undefined
        && remoteData.messages.length > params.upToEntryIndex + 1)) {
      deps.remoteSessionMap.delete(localSessionId);
      await deps.storage.remoteSessionCreationIntents.discard(localSessionId);
      return {
        ok: false,
        status: 409,
        data: { error: remoteData.session.id !== remoteSessionId
          ? "Remote returned an unexpected session id; upgrade the remote"
          : "Remote ignored branch cutoff; upgrade the remote" },
      };
    }

    await bindRemoteSessionMapping(deps.storage, {
      localSessionId,
      projectId: params.projectId,
      remoteServerId: params.agentMode,
      remoteSessionId,
      branch: params.branch,
      remotePath: params.remotePath,
      reportedWorktreePath: typeof remoteData.session.worktreePath === "string"
        ? remoteData.session.worktreePath : null,
      notificationSyncStart: "from_start",
      mappingRepo: deps.remoteSessionMappings,
    });
    await deps.remoteSessionMappings.markTitleResolved(localSessionId);
    deps.agentSessionManager.markTitleResolved(localSessionId);
    await deps.storage.remoteSessionCreationIntents.confirm(localSessionId);

    if (remoteData.messages.length > 0) {
      const cacheEntry = deps.remotePatchCache.getOrCreate(localSessionId);
      if (cacheEntry.messages.length === 0) {
        for (let i = 0; i < remoteData.messages.length; i++) {
          deps.remotePatchCache.appendMessage(
            localSessionId,
            JSON.stringify({ JsonPatch: ConversationPatch.addEntry(i, remoteData.messages[i] as AgentMessage) }),
            true,
          );
        }
      }
    }
    return { ok: true, localSessionId, remoteSession: remoteData.session, messages: remoteData.messages };
  } catch (error) {
    deps.remoteSessionMap.delete(localSessionId);
    await deps.storage.remoteSessionCreationIntents.recordError(
      localSessionId, error instanceof Error ? error.message : String(error),
    ).catch((intentError) => console.warn("[RemoteSession] Failed to record branch intent error:", intentError));
    throw error;
  }
}

export async function createRemoteWorkflowReviewer(
  deps: RemoteAgentSessionDeps,
  params: CreateRemoteWorkflowReviewerParams,
): Promise<CreateRemoteWorkflowReviewerResult> {
  const remoteRunId = params.remoteRunId ?? randomUUID();
  const remoteReviewerSessionId = params.remoteReviewerSessionId ?? randomUUID();
  const localReviewerSessionId = params.localReviewerSessionId
    ?? `remote-${params.agentMode}-${params.projectId}-${remoteReviewerSessionId}`;
  await deps.storage.remoteReviewerCreationIntents.begin({
    localReviewerSessionId,
    remoteReviewerSessionId,
    remoteRunId,
    projectId: params.projectId,
    remoteServerId: params.agentMode,
    branch: params.branch,
    remotePath: params.remotePath,
    sourceRemoteSessionId: params.sourceRemoteSessionId,
    reviewFocus: params.reviewFocus ?? null,
    sourceTurnEndIndex: params.sourceTurnEndIndex ?? null,
    reviewSpan: params.reviewSpan,
    agentType: params.reviewerAgentType,
    intentBrief: params.intentBrief ?? null,
    userId: params.userId ?? null,
  });

  let registeredLocalSessionId: string | null = null;
  try {
    const result = await proxyToRemoteAuto(
      params.agentMode,
      "POST",
      "/api/path/workflow-runs",
      {
        sourceSessionId: params.sourceRemoteSessionId,
        reviewFocus: params.reviewFocus,
        sourceTurnEndIndex: params.sourceTurnEndIndex,
        reviewSpan: params.reviewSpan,
        reviewerAgentType: params.reviewerAgentType,
        intentBrief: params.intentBrief,
        runId: remoteRunId,
        newReviewerSessionId: remoteReviewerSessionId,
      },
      { reverseConnectManager: deps.reverseConnectManager ?? undefined },
    );
    if (!result.ok) {
      const uncertain = result.errorCode === "network_error" || result.errorCode === "timeout";
      await (uncertain
        ? deps.storage.remoteReviewerCreationIntents.recordError(
          localReviewerSessionId, `worker result unknown: ${result.errorCode}`,
        )
        : deps.storage.remoteReviewerCreationIntents.discard(localReviewerSessionId));
      return { ok: false, status: result.status, data: result.data };
    }

    const remoteRun = (result.data as { run: WorkflowRun }).run;
    if (!remoteRun?.reviewer_session_id) {
      await deps.storage.remoteReviewerCreationIntents.discard(localReviewerSessionId);
      return {
        ok: false,
        status: 409,
        data: { error: "Remote did not return a reviewer session" },
      };
    }
    const stableIdentity = remoteRun.id === remoteRunId
      && remoteRun.reviewer_session_id === remoteReviewerSessionId;
    const effectiveRemoteReviewerSessionId = remoteRun.reviewer_session_id;
    const effectiveLocalReviewerSessionId = stableIdentity
      ? localReviewerSessionId
      : `remote-${params.agentMode}-${params.projectId}-${effectiveRemoteReviewerSessionId}`;
    if (!stableIdentity) {
      // Additive rolling compatibility: an old worker ignores the two stable
      // IDs but can still create a valid reviewer. Its acknowledged result is
      // usable, just not replay-safe; remove the preallocated intent so a later
      // sweep cannot manufacture a second reviewer from a request the old
      // worker cannot deduplicate.
      await deps.storage.remoteReviewerCreationIntents.discard(localReviewerSessionId);
    }

    registeredLocalSessionId = effectiveLocalReviewerSessionId;
    deps.remoteSessionMap.set(effectiveLocalReviewerSessionId, {
      remoteServerId: params.agentMode,
      remoteSessionId: effectiveRemoteReviewerSessionId,
      branch: remoteRun.branch,
    });
    await bindRemoteSessionMapping(deps.storage, {
      localSessionId: effectiveLocalReviewerSessionId,
      projectId: params.projectId,
      remoteServerId: params.agentMode,
      remoteSessionId: effectiveRemoteReviewerSessionId,
      branch: remoteRun.branch,
      remotePath: params.remotePath,
      notificationSyncStart: "from_start",
      mappingRepo: deps.remoteSessionMappings,
    });
    await deps.remoteSessionMappings.markTitleResolved(effectiveLocalReviewerSessionId);
    deps.agentSessionManager.markTitleResolved(effectiveLocalReviewerSessionId);
    await deps.remoteSessionMappings.extendNotificationWatch(
      effectiveLocalReviewerSessionId, Date.now() + NOTIFICATION_WATCH_WINDOW_MS,
    );
    if (stableIdentity) {
      await deps.storage.remoteReviewerCreationIntents.confirm(localReviewerSessionId);
    }
    return {
      ok: true,
      localReviewerSessionId: effectiveLocalReviewerSessionId,
      remoteReviewerSessionId: effectiveRemoteReviewerSessionId,
      remoteRun,
    };
  } catch (error) {
    deps.remoteSessionMap.delete(registeredLocalSessionId ?? localReviewerSessionId);
    await deps.storage.remoteReviewerCreationIntents.recordError(
      localReviewerSessionId, error instanceof Error ? error.message : String(error),
    ).catch((intentError) => console.warn("[RemoteSession] Failed to record reviewer intent error:", intentError));
    throw error;
  }
}

export async function recoverPendingRemoteAgentSessions(
  deps: RemoteAgentSessionDeps,
  remoteServerId?: string,
): Promise<{ attempted: number; confirmed: number; failed: number }> {
  const pending = await deps.storage.remoteSessionCreationIntents.listPending(remoteServerId);
  const pendingReviewers = await deps.storage.remoteReviewerCreationIntents.listPending(remoteServerId);
  let confirmed = 0;
  let failed = 0;
  for (const intent of pending) {
    const outcome = await recoverPendingRemoteAgentSessionOnce(deps, intent);
    if (outcome === "confirmed") confirmed++;
    else failed++;
  }
  for (const intent of pendingReviewers) {
    const outcome = await recoverPendingRemoteReviewerOnce(deps, intent);
    if (outcome === "confirmed") confirmed++;
    else failed++;
  }
  return { attempted: pending.length + pendingReviewers.length, confirmed, failed };
}

type PendingRecoveryOutcome = "confirmed" | "failed";
const pendingRecoveryFlights = new WeakMap<Storage, Map<string, Promise<PendingRecoveryOutcome>>>();

function recoverPendingRemoteAgentSessionOnce(
  deps: RemoteAgentSessionDeps,
  intent: RemoteSessionCreationIntent,
): Promise<PendingRecoveryOutcome> {
  let flights = pendingRecoveryFlights.get(deps.storage);
  if (!flights) {
    flights = new Map();
    pendingRecoveryFlights.set(deps.storage, flights);
  }
  const existingFlight = flights.get(intent.local_session_id);
  if (existingFlight) return existingFlight;

  const flight = (async (): Promise<PendingRecoveryOutcome> => {
    const association = await deps.storage.projectRemotes.getByProjectAndServer(
      intent.project_id, intent.remote_server_id,
    );
    if (!association) {
      await deps.storage.remoteSessionCreationIntents.recordError(
        intent.local_session_id, "remote workspace association no longer exists",
      );
      return "failed";
    }

    // A concurrent sweep may have completed the mapping after this sweep read
    // its pending page. Confirm locally instead of issuing a second worker call.
    const mapped = await deps.remoteSessionMappings.getByLocal(intent.local_session_id);
    if (mapped?.workspace_checkout_id
      && mapped.project_id === intent.project_id
      && mapped.remote_server_id === intent.remote_server_id
      && mapped.remote_session_id === intent.remote_session_id
      && (mapped.branch ?? "") === (intent.branch ?? "")) {
      await deps.storage.remoteSessionCreationIntents.confirm(intent.local_session_id);
      return "confirmed";
    }

    try {
      // Safe replay requires a worker that honors the preallocated sessionId
      // idempotently. Older workers fail the identity check loudly; they must
      // not be treated as having confirmed this intent.
      const result = intent.operation_kind === "branch"
        ? await createRemoteBranchedSession(deps, {
          projectId: intent.project_id,
          agentMode: intent.remote_server_id,
          remotePath: intent.remote_path,
          branch: intent.branch,
          sourceRemoteSessionId: intent.source_remote_session_id!,
          agentType: intent.agent_type ?? undefined,
          upToEntryIndex: intent.up_to_entry_index ?? undefined,
          userId: intent.user_id ?? undefined,
          remoteSessionId: intent.remote_session_id,
          localSessionId: intent.local_session_id,
        })
        : await createRemoteAgentSession(deps, {
        projectId: intent.project_id,
        agentMode: intent.remote_server_id,
        // Replay the exact effect recorded before the worker call. The current
        // association proves the target is still authorized, but its path may
        // have changed since the uncertain create attempt.
        remoteConfig: { remote_path: intent.remote_path },
        branch: intent.branch,
        permissionMode: intent.permission_mode,
        agentType: intent.agent_type ?? undefined,
        model: intent.model,
        force: intent.force,
        userId: intent.user_id ?? undefined,
        remoteSessionId: intent.remote_session_id,
        localSessionId: intent.local_session_id,
      });
      return result.ok ? "confirmed" : "failed";
    } catch (error) {
      console.warn(`[RemoteSession] Pending creation recovery failed for ${intent.local_session_id}:`, error);
      return "failed";
    }
  })();
  flights.set(intent.local_session_id, flight);
  const clearFlight = () => {
    if (flights?.get(intent.local_session_id) === flight) flights.delete(intent.local_session_id);
  };
  void flight.then(clearFlight, clearFlight);
  return flight;
}

const pendingReviewerRecoveryFlights = new WeakMap<Storage, Map<string, Promise<PendingRecoveryOutcome>>>();

function recoverPendingRemoteReviewerOnce(
  deps: RemoteAgentSessionDeps,
  intent: RemoteReviewerCreationIntent,
): Promise<PendingRecoveryOutcome> {
  let flights = pendingReviewerRecoveryFlights.get(deps.storage);
  if (!flights) {
    flights = new Map();
    pendingReviewerRecoveryFlights.set(deps.storage, flights);
  }
  const key = intent.local_reviewer_session_id;
  const existingFlight = flights.get(key);
  if (existingFlight) return existingFlight;

  const flight = (async (): Promise<PendingRecoveryOutcome> => {
    const association = await deps.storage.projectRemotes.getByProjectAndServer(
      intent.project_id, intent.remote_server_id,
    );
    if (!association) {
      await deps.storage.remoteReviewerCreationIntents.recordError(
        key, "remote workspace association no longer exists",
      );
      return "failed";
    }
    const mapped = await deps.remoteSessionMappings.getByLocal(key);
    if (mapped?.workspace_checkout_id
      && mapped.project_id === intent.project_id
      && mapped.remote_server_id === intent.remote_server_id
      && mapped.remote_session_id === intent.remote_reviewer_session_id
      && (mapped.branch ?? "") === (intent.branch ?? "")) {
      await deps.storage.remoteReviewerCreationIntents.confirm(key);
      return "confirmed";
    }

    try {
      const result = await createRemoteWorkflowReviewer(deps, {
        projectId: intent.project_id,
        agentMode: intent.remote_server_id,
        remotePath: intent.remote_path,
        branch: intent.branch,
        sourceRemoteSessionId: intent.source_remote_session_id,
        reviewFocus: intent.review_focus ?? undefined,
        sourceTurnEndIndex: intent.source_turn_end_index ?? undefined,
        reviewSpan: intent.review_span,
        reviewerAgentType: intent.agent_type,
        intentBrief: intent.intent_brief ?? undefined,
        userId: intent.user_id ?? undefined,
        remoteRunId: intent.remote_run_id,
        remoteReviewerSessionId: intent.remote_reviewer_session_id,
        localReviewerSessionId: key,
      });
      return result.ok ? "confirmed" : "failed";
    } catch (error) {
      console.warn(`[RemoteSession] Pending reviewer recovery failed for ${key}:`, error);
      return "failed";
    }
  })();
  flights.set(key, flight);
  const clearFlight = () => {
    if (flights?.get(key) === flight) flights.delete(key);
  };
  void flight.then(clearFlight, clearFlight);
  return flight;
}

export async function createRemoteProjectChatSessionWithInstruction(
  deps: RemoteAgentSessionDeps,
  params: {
    projectId: string; userId: string; remoteServerId: string;
    remoteConfig: { remote_path?: string | null }; sessionId: string; workerSessionId: string;
    branch: string | null; permissionMode: "plan" | "edit"; agentType: string;
    model: string | null; instruction: string; idempotencyKey: string;
  },
): Promise<{ sessionId: string }> {
  let mapping = await deps.remoteSessionMappings.getByLocal(params.sessionId);
  if (mapping && (mapping.project_id !== params.projectId
    || mapping.remote_server_id !== params.remoteServerId
    || mapping.remote_session_id !== params.workerSessionId
    || (mapping.branch ?? null) !== params.branch)) {
    throw new Error("Session identity is already in use");
  }
  if (!mapping) {
    const created = await createRemoteAgentSession(deps, {
      projectId: params.projectId, agentMode: params.remoteServerId,
      remoteConfig: params.remoteConfig, branch: params.branch,
      permissionMode: params.permissionMode, agentType: params.agentType,
      model: params.model, userId: params.userId,
      remoteSessionId: params.workerSessionId, localSessionId: params.sessionId,
    });
    if (!created.ok) throw new Error("Remote agent session creation failed");
    mapping = await deps.remoteSessionMappings.getByLocal(params.sessionId);
  }
  if (!mapping) throw new Error("Remote session mapping was not persisted");
  const activityAt = Date.now();
  const sent = await proxyToRemoteAuto(
    mapping.remote_server_id, "POST",
    `/api/agent-sessions/${encodeURIComponent(mapping.remote_session_id)}/message`,
    { content: params.instruction, idempotencyKey: params.idempotencyKey },
    { reverseConnectManager: deps.reverseConnectManager ?? undefined },
  );
  if (!sent.ok) throw new Error("Remote agent session did not accept its initial instruction");
  const activityReady = await deps.storage.searchCache.updateRemoteSessionActivity({
    localSessionId: params.sessionId,
    projectId: params.projectId,
    targetId: mapping.remote_server_id,
    remoteSessionId: mapping.remote_session_id,
    status: "running",
    activityAt,
    lastUserMessageAt: activityAt,
  });
  if (activityReady === false) throw new Error("Remote session mapping is no longer authorized");
  return { sessionId: params.sessionId };
}

// ---- Remote reconnection constants ----
const REMOTE_RECONNECT_MAX_ATTEMPTS = 10;
const REMOTE_RECONNECT_BASE_DELAY_MS = 1000;
const REMOTE_RECONNECT_MAX_DELAY_MS = 30000;
/** How long a connection must stay open before we consider it "stable" and reset the attempt counter. */
const REMOTE_RECONNECT_STABILITY_MS = 10000;

/** Try to parse a raw WS message string, returning undefined on failure. */
export function tryParseWsMessage(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Whether a frame belongs to the worker's replay sequence.
 *
 * That sequence is the worker's `store.patches` — append-only, prefix-stable,
 * and containing *only* patches targeting `/entries/<i>`. Status patches are
 * broadcast live but never recorded there, and `taskCompleted`/`error` are not
 * patches at all; both nonetheless land in the front's message cache. Counting
 * raw cache messages (or even all JsonPatch frames) therefore overstates how
 * much of the sequence we hold, and reconciliation then slices that many frames
 * off the delta — silently dropping real entries. Reconciliation must compare
 * like with like, which is what this predicate defines.
 *
 * `/entries` with no index is the CLEAR_ALL marker, deliberately excluded: it
 * resets the sequence rather than extending it.
 */
export function isEntryPatchFrame(parsed: Record<string, unknown> | undefined): boolean {
  if (!parsed || !("JsonPatch" in parsed)) return false;
  const ops = parsed.JsonPatch;
  if (!Array.isArray(ops)) return false;
  return ops.some((op: { path?: unknown }) =>
    typeof op?.path === "string" && op.path.startsWith("/entries/"));
}

/** The entry patches in `messages`, in order — our copy of the replay sequence. */
export function entryPatchFrames(messages: readonly string[]): string[] {
  const frames: string[] = [];
  for (const raw of messages) {
    if (isEntryPatchFrame(tryParseWsMessage(raw))) frames.push(raw);
  }
  return frames;
}

/**
 * Whether `cached` is a genuine prefix of `replay`, compared frame by frame.
 *
 * Lengths alone cannot answer this. `restartSession`/`switchAgentType` wipe
 * `store.patches` AND reset the index provider, so a session reset during a
 * disconnect produces a *new* sequence that also starts at `/entries/0`. To a
 * length or index check that is indistinguishable from the old sequence having
 * grown — and reconciliation would then skip the new sequence's first N frames
 * as "already held", leaving the cache a permanent splice of two conversations.
 *
 * Frames are the worker's own serialization, cached verbatim and re-sent
 * verbatim on replay, so equality is exact. A false mismatch (were the worker
 * ever to re-serialize differently) costs one full re-render, while a false
 * match corrupts history — so this errs toward replacing.
 */
function isSequencePrefix(cached: readonly string[], replay: readonly string[]): boolean {
  if (cached.length > replay.length) return false;
  for (let i = 0; i < cached.length; i++) {
    if (cached[i] !== replay[i]) return false;
  }
  return true;
}

/**
 * Persist the activity carried by one worker stream frame. The repository
 * validates the exact project, remote target, and durable session mapping, so
 * a malformed synthetic local id cannot move another project's cache row.
 */
export async function persistRemoteSessionActivityFrame(
  storage: Storage,
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
  parsed: Record<string, unknown>,
  activityAt: number = Date.now(),
): Promise<RemoteSessionActivityUpdateResult> {
  const projectId = projectIdFromRemoteSessionId(sessionId, remoteInfo);
  const statusEvent = statusEventFromRemotePatch(parsed, sessionId, remoteInfo);
  if (statusEvent) {
    return storage.searchCache.updateRemoteSessionActivity({
      localSessionId: sessionId,
      projectId,
      targetId: remoteInfo.remoteServerId,
      remoteSessionId: remoteInfo.remoteSessionId,
      status: statusEvent.status,
      activityAt,
      ...(statusEvent.status === "running" ? { lastUserMessageAt: activityAt } : {}),
    });
  }
  if ("taskCompleted" in parsed) {
    return storage.searchCache.updateRemoteSessionActivity({
      localSessionId: sessionId,
      projectId,
      targetId: remoteInfo.remoteServerId,
      remoteSessionId: remoteInfo.remoteSessionId,
      status: "stopped",
      activityAt,
      lastCompletedAt: activityAt,
    });
  }
  if ("error" in parsed) {
    return storage.searchCache.updateRemoteSessionActivity({
      localSessionId: sessionId,
      projectId,
      targetId: remoteInfo.remoteServerId,
      remoteSessionId: remoteInfo.remoteSessionId,
      status: "error",
      activityAt,
    });
  }
  return false;
}

/**
 * Create a persistent WebSocket to the remote server and wire up message
 * handling (sync or live mode), reconnection on close, and status broadcasts.
 *
 * Called both on first frontend connection and on automatic reconnection.
 */
export function connectPersistentRemoteWs(
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
  cache: RemotePatchCache,
  reverseConnectManager?: ReverseConnectManager,
  eventBus?: EventBus,
  agentSessionManager?: AgentSessionManager,
  storage?: Storage,
  requestedHistory?: { afterEntryIndex?: number; historyEpoch?: number },
): void {
  const hasCachedData = cache.hasData(sessionId);
  console.log(`[AgentWS] Opening persistent remote WS for ${sessionId} (cached=${hasCachedData})`);

  if (!reverseConnectManager || !reverseConnectManager.isConnected(remoteInfo.remoteServerId)) {
    // Remote worker not connected — nothing to attach to until it reconnects.
    console.log(`[AgentWS] Remote ${remoteInfo.remoteServerId} not connected for ${sessionId}, skipping reconnect`);
    cache.setReconnecting(sessionId, false);
    cache.broadcast(sessionId, JSON.stringify({ remoteStatus: "disconnected" }));
    return;
  }

  const channelId = randomUUID();
  const cachedHead = cache.get(sessionId);
  const upstreamEpoch = requestedHistory?.historyEpoch ?? cachedHead?.historyEpoch ?? undefined;
  const upstreamAfter = requestedHistory?.afterEntryIndex ?? (
    upstreamEpoch !== undefined ? cachedHead?.lastTurnEndEntryIndex ?? undefined : undefined
  );
  const upstreamParams = new URLSearchParams();
  if (upstreamEpoch !== undefined && upstreamAfter !== undefined) {
    upstreamParams.set("after", String(upstreamAfter));
    upstreamParams.set("epoch", String(upstreamEpoch));
  }
  const usesBoundedReplay = upstreamParams.size > 0;
  const wsPath = `/api/agent-sessions/${encodeURIComponent(remoteInfo.remoteSessionId)}/stream${
    usesBoundedReplay ? `?${upstreamParams}` : ""
  }`;

  const adapter = new VirtualWsAdapter(
    (data) => reverseConnectManager.sendChannelData(remoteInfo.remoteServerId, channelId, data),
    () => reverseConnectManager.closeChannel(remoteInfo.remoteServerId, channelId),
  );

  reverseConnectManager.setChannelAdapter(remoteInfo.remoteServerId, channelId, adapter);
  reverseConnectManager.openVirtualChannel(remoteInfo.remoteServerId, channelId, wsPath);

  const remoteWs: VirtualWsAdapter = adapter;
  // Simulate open event on next tick
  setTimeout(() => adapter.emit("open"), 0);

  cache.setRemoteWs(sessionId, remoteWs as unknown as WebSocket);
  cache.setReconnecting(sessionId, false);
  cache.clearReconnectTimer(sessionId);

  /** Live-mode message handler — shared by both first-connect and post-sync paths. */
  const processLiveMessage = async (data: import("ws").RawData) => {
    const raw = data.toString();
    const parsed = tryParseWsMessage(raw);
    if (!parsed) return;

    // The worker's liveness frame. Proves the tunnel channel is alive; carries
    // no conversation state, so it must not be cached, forwarded, or logged
    // (it arrives every 30s on every open stream).
    if ("keepalive" in parsed) return;

    // DEBUG: trace every message arriving from remote, with status-patch detail
    const kind = "JsonPatch" in parsed ? "JsonPatch"
      : "finished" in parsed ? "finished"
      : "taskCompleted" in parsed ? "taskCompleted"
      : "workflowRunUpdated" in parsed ? "workflowRunUpdated"
      : "processAlive" in parsed ? "processAlive"
      : "branchActivity" in parsed ? "branchActivity"
      : "Ready" in parsed ? "Ready"
      : "error" in parsed ? "error"
      : "other";
    if (kind === "JsonPatch") {
      const ops = (parsed as { JsonPatch: Array<{ op: string; path: string; value?: { type?: string; content?: unknown } }> }).JsonPatch;
      const statusOp = ops.find(o => o.path === "/status");
      if (statusOp) {
        console.log(`[AgentWS:remote→local] ${sessionId} /status patch:`, statusOp.value?.content);
      } else {
        console.log(`[AgentWS:remote→local] ${sessionId} JsonPatch paths:`, ops.map(o => o.path));
      }
    } else {
      console.log(`[AgentWS:remote→local] ${sessionId} ${kind}`);
    }

    if ("JsonPatch" in parsed) {
      cache.appendMessage(sessionId, raw, true);
      cache.broadcast(sessionId, raw);
      const statusEvent = statusEventFromRemotePatch(parsed, sessionId, remoteInfo);
      if (statusEvent) {
        cache.setSessionStatus(sessionId, statusEvent.status);
        let activityReady: true | "stale" | false = true;
        if (storage) {
          activityReady = await persistRemoteSessionActivityFrame(storage, sessionId, remoteInfo, parsed)
            .catch((error) => {
              console.error(`[AgentWS] activity write-through failed for ${sessionId}:`, error);
              return false;
            });
        }
        if (eventBus && activityReady === true) {
          console.log(`[AgentWS:remote→eventBus] ${sessionId} session:status=${statusEvent.status}`);
          eventBus.emit(statusEvent);
        }
      }
    } else if ("finished" in parsed) {
      cache.setFinished(sessionId);
      cache.broadcast(sessionId, raw);
    } else if ("taskCompleted" in parsed) {
      cache.setSessionStatus(sessionId, "stopped");
      const turnEndIndex = (parsed.taskCompleted as { turnEndEntryIndex?: unknown }).turnEndEntryIndex;
      if (typeof turnEndIndex === "number" && Number.isInteger(turnEndIndex)) {
        cache.setLastTurnEndEntryIndex(sessionId, turnEndIndex);
      }
      cache.appendMessage(sessionId, raw, false);
      cache.broadcast(sessionId, raw);
      let activityReady: true | "stale" | false = true;
      if (storage) {
        activityReady = await persistRemoteSessionActivityFrame(storage, sessionId, remoteInfo, parsed)
          .catch((error) => {
            console.error(`[AgentWS] completion write-through failed for ${sessionId}:`, error);
            return false;
          });
      }
      if (eventBus && activityReady === true) {
        const evt = taskCompletedEventFromRemoteFrame(parsed, sessionId, remoteInfo);
        if (evt) {
          eventBus.emit(evt);
          agentSessionManager?.emitBranchActivityIfChanged(evt.projectId, evt.branch, {
            activity: "completed",
            since: Date.now(),
            sessionId,
          });
        }
      }
    } else if ("workflowRunUpdated" in parsed) {
      // Worker-side WorkflowEngine mirrors run transitions onto participant
      // session streams. Re-emit on the front bus (ChatSessionManager pushes
      // it to the Main Chat WS) AND mirror the mapped frame to this session's
      // agent-stream subscribers — the reviewer-side finalize button consumes
      // it live (local sessions get the same frame via broadcastRawToSession).
      // Duplicate delivery across both participant streams is harmless.
      const evt = runUpdatedEventFromRemoteFrame(parsed, sessionId, remoteInfo);
      if (evt) {
        eventBus?.emit(evt);
        cache.broadcast(sessionId, runUpdatedFrameForSubscribers(evt));
      }
    } else if ("processAlive" in parsed) {
      cache.broadcast(sessionId, raw);
      if (eventBus) {
        const pa = parsed.processAlive as { alive?: unknown };
        if (typeof pa.alive === "boolean") {
          eventBus.emit({
            type: "session:process",
            projectId: projectIdFromRemoteSessionId(sessionId, remoteInfo),
            branch: remoteInfo.branch ?? null,
            sessionId,
            alive: pa.alive,
          });
        }
      }
    } else if ("branchActivity" in parsed) {
      // Remote signaled a branch:activity transition outside the natural
      // taskCompleted path (e.g. user clicked Stop). Forward to subscribers
      // and re-emit on local EventBus so the local frontend's SSE listener
      // (useBranchActivity) updates the workspace dot live without waiting
      // for the next REST refetch.
      cache.broadcast(sessionId, raw);
      if (agentSessionManager) {
        const ba = parsed.branchActivity as { activity?: unknown; since?: unknown };
        if (
          (ba.activity === "idle" || ba.activity === "working" ||
           ba.activity === "completed" || ba.activity === "stopped") &&
          typeof ba.since === "number"
        ) {
          agentSessionManager.emitBranchActivityIfChanged(
            projectIdFromRemoteSessionId(sessionId, remoteInfo),
            remoteInfo.branch ?? null,
            // sessionId is the local `remote-` prefixed id — what the frontend
            // needs for ?session= deep links, not the remote's raw id.
            { activity: ba.activity, since: ba.since, sessionId },
          );
        }
      }
    } else if ("error" in parsed) {
      cache.setSessionStatus(sessionId, "error");
      cache.appendMessage(sessionId, raw, false);
      cache.broadcast(sessionId, raw);
      let activityReady: true | "stale" | false = true;
      if (storage) {
        activityReady = await persistRemoteSessionActivityFrame(storage, sessionId, remoteInfo, parsed)
          .catch((error) => {
            console.error(`[AgentWS] error write-through failed for ${sessionId}:`, error);
            return false;
          });
      }
      if (eventBus && activityReady === true) {
        eventBus.emit({
          type: "session:status",
          projectId: projectIdFromRemoteSessionId(sessionId, remoteInfo),
          branch: remoteInfo.branch ?? null,
          sessionId,
          status: "error",
        });
      }
      // If session not found on remote, stop reconnecting
      if (parsed.error === "Session not found") {
        cache.setFinished(sessionId);
      }
    } else if ("Ready" in parsed) {
      const epoch = (parsed as { historyEpoch?: unknown }).historyEpoch;
      if (typeof epoch === "number" && Number.isInteger(epoch)) cache.setHistoryEpoch(sessionId, epoch);
      cache.broadcast(sessionId, raw);
    } else if ("HistorySync" in parsed) {
      const sync = parsed.HistorySync as { historyEpoch?: unknown; reset?: unknown };
      if (typeof sync.historyEpoch === "number" && Number.isInteger(sync.historyEpoch)) {
        if (sync.reset === true) cache.resetHistory(sessionId, sync.historyEpoch);
        else cache.setHistoryEpoch(sessionId, sync.historyEpoch);
      }
      cache.broadcast(sessionId, raw);
    }
  };
  const handleLiveMessage = (data: import("ws").RawData) => {
    void processLiveMessage(data).catch((error) => {
      console.error(`[AgentWS] live frame handling failed for ${sessionId}:`, error);
    });
  };

  remoteWs.on("open", () => {
    console.log(`[AgentWS] Persistent remote WS connected for ${sessionId} (sync=${hasCachedData})`);
    cache.broadcast(sessionId, JSON.stringify({ remoteStatus: "connected" }));
    // Only reset the reconnect attempt counter after the connection has been
    // stable for a minimum duration. This prevents an infinite ~1s reconnect
    // loop when connections succeed but immediately close (e.g. remote closes
    // after sync, idle timeout, etc.).
    const stabilityTimer = setTimeout(() => {
      cache.resetReconnectAttempt(sessionId);
    }, REMOTE_RECONNECT_STABILITY_MS);
    remoteWs.once("close", () => clearTimeout(stabilityTimer));
  });

  // Ping/pong keepalive to prevent idle disconnections (e.g. Cloudflare 100s timeout)
  const pingInterval = setInterval(() => {
    if (remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.ping();
    }
  }, 30000);

  if (!hasCachedData) {
    // First connection ever — stream directly in live mode
    remoteWs.on("message", handleLiveMessage);
  } else {
    // Has cached data but persistent WS died — need sync first.
    // `replayBuffer` holds ONLY entry-patch frames: the worker replays
    // `store.patches`, which is exactly that sequence (see entryPatchCount).
    const replayBuffer: string[] = [];
    let syncing = true;

    remoteWs.on("message", (data) => {
      const raw = data.toString();
      const parsed = tryParseWsMessage(raw);
      if (!parsed) return;

      if (!syncing) {
        handleLiveMessage(data);
        return;
      }

      if ("Ready" in parsed) {
        // Remote finished replay — reconcile
        syncing = false;
        const currentEntry = cache.get(sessionId)!;
        const cachedSeq = entryPatchFrames(currentEntry.messages);
        const extendsCache = !usesBoundedReplay && isSequencePrefix(cachedSeq, replayBuffer);

        if (usesBoundedReplay) {
          // The worker replayed only the namespace after the last sealed turn.
          // Replace that mutable tail by absolute index; a partial history
          // window is intentionally not a prefix of the worker's full store.
          cache.replaceEntryTail(sessionId, upstreamAfter!, replayBuffer);
          for (const msg of replayBuffer) cache.broadcast(sessionId, msg);
          cache.broadcast(sessionId, raw);
        } else if (extendsCache && replayBuffer.length > cachedSeq.length) {
          // Remote has newer data — send delta + update cache
          const delta = replayBuffer.slice(cachedSeq.length);
          console.log(`[AgentWS] Sync delta: ${delta.length} new entry patches for ${sessionId} (remote=${replayBuffer.length}, cached=${cachedSeq.length})`);
          for (const msg of delta) {
            cache.appendMessage(sessionId, msg, true);
            cache.broadcast(sessionId, msg);
          }
        } else if (!extendsCache) {
          // Cache no longer matches the worker — it restarted the session, or
          // truncated it. Either way our copy is unusable: replace it whole.
          console.log(`[AgentWS] Sync replace for ${sessionId}: remote=${replayBuffer.length}, cached=${cachedSeq.length} (sequence diverged or shrank)`);
          cache.replaceAll(sessionId, [...replayBuffer], replayBuffer.length);
          // Tell frontends to clear and re-render
          const clearPatch = {
            JsonPatch: [{
              op: "replace",
              path: "/entries",
              value: { type: "ENTRY", content: { type: "system", content: "__CLEAR_ALL__", timestamp: Date.now() } },
            }],
          };
          cache.broadcast(sessionId, JSON.stringify(clearPatch));
          for (const msg of replayBuffer) {
            cache.broadcast(sessionId, msg);
          }
          cache.broadcast(sessionId, JSON.stringify({ Ready: true }));
        }
        // else the cache is exactly the worker's sequence — nothing to send

        // NOTE: a reviewer that completed during the disconnect needs no
        // patch-scanning here any more. Its milestone is durable in the worker's
        // notification outbox and is pulled by RemoteNotificationSync, so
        // delivery no longer depends on this stream having observed the turn_end.

        // Switch to live-mode handler
        remoteWs.removeAllListeners("message");
        remoteWs.on("message", handleLiveMessage);
        return;
      }

      // Buffer the replay sequence itself.
      if (isEntryPatchFrame(parsed)) {
        replayBuffer.push(raw);
        return;
      }
      if ("finished" in parsed) {
        cache.setFinished(sessionId);
        return;
      }
      // Anything else arriving before Ready is not part of the replay prefix
      // (the worker sends only entry patches ahead of it), so it is live
      // traffic that raced the reconnect — a `taskCompleted` for a turn that
      // ended just now, a `/status` flip, an `error`. Forwarding it keeps it
      // out of the sequence comparison without dropping it.
      handleLiveMessage(data);
    });
  }

  // ---- Lifecycle handlers ----

  remoteWs.on("error", (error) => {
    console.error(`[AgentWS] Persistent remote WS error for ${sessionId}:`, error);
    clearInterval(pingInterval);
    // "close" event fires next and handles reconnection
  });

  remoteWs.on("close", () => {
    console.log(`[AgentWS] Persistent remote WS closed for ${sessionId}`);
    clearInterval(pingInterval);
    cache.setRemoteWs(sessionId, null);

    // Don't reconnect if session is finished or cache entry was deleted
    const entry = cache.get(sessionId);
    if (!entry || entry.finished) return;

    scheduleRemoteReconnect(sessionId, remoteInfo, cache, reverseConnectManager, eventBus, agentSessionManager, storage);
  });
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 * Broadcasts `remoteStatus` updates to all subscribed frontends.
 */
function scheduleRemoteReconnect(
  sessionId: string,
  remoteInfo: RemoteSessionInfo,
  cache: RemotePatchCache,
  reverseConnectManager?: ReverseConnectManager,
  eventBus?: EventBus,
  agentSessionManager?: AgentSessionManager,
  storage?: Storage,
): void {
  const entry = cache.get(sessionId);
  if (!entry || entry.finished) return;

  const attempt = cache.getReconnectAttempt(sessionId);
  if (attempt >= REMOTE_RECONNECT_MAX_ATTEMPTS) {
    console.log(`[AgentWS] Max reconnect attempts (${REMOTE_RECONNECT_MAX_ATTEMPTS}) reached for ${sessionId}`);
    cache.setReconnecting(sessionId, false);
    cache.broadcast(sessionId, JSON.stringify({ remoteStatus: "disconnected" }));
    return;
  }

  cache.setReconnecting(sessionId, true);

  const delay = Math.min(REMOTE_RECONNECT_MAX_DELAY_MS, REMOTE_RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt));
  const jitter = delay * Math.random() * 0.25;
  const totalDelay = delay + jitter;

  console.log(`[AgentWS] Scheduling remote reconnect for ${sessionId} in ${Math.round(totalDelay)}ms (attempt ${attempt + 1}/${REMOTE_RECONNECT_MAX_ATTEMPTS})`);
  cache.broadcast(sessionId, JSON.stringify({ remoteStatus: "reconnecting", attempt: attempt + 1 }));

  cache.incrementReconnectAttempt(sessionId);
  const timer = setTimeout(() => {
    // Guard: entry might have been deleted while waiting
    if (!cache.get(sessionId) || cache.get(sessionId)!.finished) {
      cache.setReconnecting(sessionId, false);
      return;
    }
    connectPersistentRemoteWs(sessionId, remoteInfo, cache, reverseConnectManager, eventBus, agentSessionManager, storage);
  }, totalDelay);

  cache.setReconnectTimer(sessionId, timer);
}

export interface EnsureStreamDeps {
  remoteSessionMap: Map<string, RemoteSessionInfo>;
  remotePatchCache: RemotePatchCache;
  reverseConnectManager: ReverseConnectManager | null;
  eventBus: EventBus | null;
  agentSessionManager: AgentSessionManager;
  storage: Storage;
}

/**
 * Idempotently ensure a persistent remote stream is connected for this session,
 * so its remote `taskCompleted` bridges to the local EventBus (which wakes the
 * commander) even when no frontend window is open. No-op if a connection is
 * already live or reconnecting.
 */
export function ensureRemoteAgentStream(localSessionId: string, deps: EnsureStreamDeps): void {
  const remoteInfo = deps.remoteSessionMap.get(localSessionId);
  if (!remoteInfo) return;
  if (deps.remotePatchCache.getRemoteWs(localSessionId) || deps.remotePatchCache.isReconnecting(localSessionId)) return;
  connectPersistentRemoteWs(
    localSessionId,
    remoteInfo,
    deps.remotePatchCache,
    deps.reverseConnectManager ?? undefined,
    deps.eventBus ?? undefined,
    deps.agentSessionManager,
    deps.storage,
  );
}

export interface RemoteSessionTitleDeps {
  storage: Storage;
  agentSessionManager: AgentSessionManager;
  remotePatchCache: RemotePatchCache;
  reverseConnectManager: ReverseConnectManager | null;
}

/**
 * For a remote session, generate a title locally (using the local chat_provider
 * config — the same one main chat uses), then PATCH it to the remote DB and
 * broadcast `titleUpdated` to local subscribers so the history dropdown
 * refreshes. Falls back to a snippet of the user's first message when no chat
 * model is configured or the AI call fails.
 *
 * Shared by the UI message route and the commander's spawn/send tools so that
 * commander-created remote sessions get titles too (they proxy `/message`
 * directly, bypassing the route that used to own this). Idempotent per local
 * session id via `markTitleResolved` (in-memory) + `remoteSessionMappings`
 * (across restarts), so calling it on every delivered message is safe.
 */
export async function generateAndPushRemoteSessionTitle(
  deps: RemoteSessionTitleDeps,
  localSessionId: string,
  userText: string,
  remoteInfo: RemoteSessionInfo,
  userId: string,
): Promise<void> {
  if (userText.trim().length === 0) return;
  // Cheap in-memory dedupe within this process lifetime.
  if (!deps.agentSessionManager.markTitleResolved(localSessionId)) return;
  // Persistent dedupe across restarts: if a previous server lifetime already
  // resolved this session's title, don't regenerate (the new title would be
  // derived from a non-first message and would clobber the original).
  if (await deps.storage.remoteSessionMappings.isTitleResolved(localSessionId)) return;

  let aiTitle: string | null = null;
  try {
    aiTitle = await generateSessionTitle(deps.storage, userText, userId);
  } catch (error) {
    console.warn(
      `[SessionTitle] AI title generation threw for ${localSessionId}:`,
      (error as Error).message,
    );
  }
  const finalTitle = aiTitle && aiTitle.length > 0 ? aiTitle : snippetTitle(userText);
  if (!finalTitle) return;

  const result = await proxyToRemoteAuto(
    remoteInfo.remoteServerId,
    "PATCH",
    `/api/agent-sessions/${remoteInfo.remoteSessionId}/title`,
    { title: finalTitle },
    { reverseConnectManager: deps.reverseConnectManager ?? undefined },
  );
  if (!result.ok) {
    console.warn(
      `[SessionTitle] Failed to PATCH remote title for ${localSessionId}:`,
      result.status,
      result.errorCode,
    );
    return;
  }
  await deps.storage.remoteSessionMappings.markTitleResolved(localSessionId);
  // Keep the search cache's copy fresh too — the generated title transits
  // this server only here (the direct proxy PATCH bypasses the title route's
  // write-through).
  await deps.storage.searchCache.updateCachedSessionTitle(localSessionId, finalTitle)
    .catch((err) => console.error("[SessionTitle] search-cache title write-through failed:", err));
  deps.remotePatchCache.broadcast(
    localSessionId,
    JSON.stringify({ titleUpdated: { title: finalTitle } }),
  );
  // Announce globally too, so the sidebar picks up the title even when the
  // user has navigated away from this session's workspace (the broadcast above
  // only reaches the focused AgentConversation over its per-session WS).
  deps.agentSessionManager.emitSessionTitle(
    projectIdFromRemoteSessionId(localSessionId, remoteInfo),
    remoteInfo.branch ?? null,
    localSessionId,
    finalTitle,
  );
}
