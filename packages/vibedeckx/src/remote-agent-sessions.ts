import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import { ConversationPatch } from "./conversation-patch.js";
import { generateSessionTitle, snippetTitle } from "./utils/session-title.js";
import type { AgentMessage } from "./agent-types.js";
import type { Storage } from "./storage/types.js";
import type { RemoteSessionInfo } from "./server-types.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import { VirtualWsAdapter } from "./virtual-ws-adapter.js";
import { statusEventFromRemotePatch, projectIdFromRemoteSessionId } from "./routes/remote-status-bridge.js";
import type { EventBus } from "./event-bus.js";
import { mintCrossRemoteMcpConfig } from "./cross-remote-mcp-config.js";

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
    remoteConfig: { server_url: string | null; server_api_key?: string; remote_path?: string | null };
    branch: string | null;
    permissionMode: "plan" | "edit";
    agentType?: string;
    force?: boolean;
    userId: string | undefined;
  },
): Promise<CreateRemoteAgentSessionResult> {
  const { projectId, agentMode, remoteConfig, branch, permissionMode, agentType, force, userId } = params;

  // The server picks the session id so it can mint a token bound to it before the
  // remote spawns claude. The remote honours the supplied id.
  const remoteSessionId = randomUUID();
  const localSessionId = `remote-${agentMode}-${projectId}-${remoteSessionId}`;

  const crossRemoteMcp = await mintCrossRemoteMcpConfig(
    { storage: deps.storage },
    { userId, sessionId: localSessionId, sourceRemoteServerId: agentMode },
  );

  // Register before the call, not after: createNewSession on the remote spawns claude
  // before it responds, and claude connects to its MCP servers at startup. A late
  // registration would make isSessionUsable reject the agent's first tool call.
  deps.remoteSessionMap.set(localSessionId, {
    remoteServerId: agentMode,
    remoteUrl: remoteConfig.server_url ?? "",
    remoteApiKey: remoteConfig.server_api_key || "",
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
      remoteConfig.server_url ?? "",
      remoteConfig.server_api_key || "",
      "POST",
      `/api/path/agent-sessions/new`,
      { path: remoteConfig.remote_path, branch, permissionMode, agentType, force, sessionId: remoteSessionId, crossRemoteMcp },
      { reverseConnectManager: deps.reverseConnectManager ?? undefined },
    );
    if (!result.ok) {
      deps.remoteSessionMap.delete(localSessionId);
      return { ok: false, status: result.status, data: result.data };
    }

    remoteData = result.data as { session: { id: string; processAlive?: boolean; [key: string]: unknown }; messages: unknown[] };
    if (remoteData.session.id !== remoteSessionId) {
      // An older remote that ignores the supplied id. Fail closed: the token we minted
      // names a session that does not exist, so cross-remote calls would be rejected
      // anyway, and the map entry we registered would be wrong.
      deps.remoteSessionMap.delete(localSessionId);
      return { ok: false, status: 409, data: { error: "Remote returned an unexpected session id; upgrade the remote" } };
    }

    await deps.remoteSessionMappings.upsert(localSessionId, projectId, agentMode, remoteSessionId, branch ?? null);
  } catch (err) {
    // A thrown transport error (reverse-connect send) or DB write rejection leaves
    // the pre-registered entry orphaned. Remove it, then rethrow so the caller's
    // existing 502 behavior is preserved and the original error is not swallowed.
    deps.remoteSessionMap.delete(localSessionId);
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

  deps.agentSessionManager.emitBranchActivityIfChanged(projectId, branch ?? null, { activity: "idle", since: Date.now() });

  return { ok: true, localSessionId, remoteSession: remoteData.session, messages: remoteData.messages };
}

// ---- Remote reconnection constants ----
const REMOTE_RECONNECT_MAX_ATTEMPTS = 10;
const REMOTE_RECONNECT_BASE_DELAY_MS = 1000;
const REMOTE_RECONNECT_MAX_DELAY_MS = 30000;
/** How long a connection must stay open before we consider it "stable" and reset the attempt counter. */
const REMOTE_RECONNECT_STABILITY_MS = 10000;

/** Build a WebSocket URL for a remote agent session. */
function buildRemoteWsUrl(remoteInfo: RemoteSessionInfo): string {
  const cleanRemoteUrl = remoteInfo.remoteUrl.replace(/\/+$/, "");
  const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
  const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
  return `${wsUrl}/api/agent-sessions/${remoteInfo.remoteSessionId}/stream?apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
}

/** Try to parse a raw WS message string, returning undefined on failure. */
export function tryParseWsMessage(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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
  wsOptions: Record<string, unknown>,
  reverseConnectManager?: ReverseConnectManager,
  eventBus?: EventBus,
  agentSessionManager?: AgentSessionManager,
): void {
  const hasCachedData = cache.hasData(sessionId);
  const useVirtual = reverseConnectManager && reverseConnectManager.isConnected(remoteInfo.remoteServerId);
  console.log(`[AgentWS] Opening persistent remote WS for ${sessionId} (cached=${hasCachedData}, virtual=${!!useVirtual})`);

  let remoteWs: WebSocket | VirtualWsAdapter;

  if (useVirtual) {
    const channelId = randomUUID();
    const wsPath = `/api/agent-sessions/${remoteInfo.remoteSessionId}/stream`;
    const wsQuery = `apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;

    const adapter = new VirtualWsAdapter(
      (data) => reverseConnectManager.sendChannelData(remoteInfo.remoteServerId, channelId, data),
      () => reverseConnectManager.closeChannel(remoteInfo.remoteServerId, channelId),
    );

    reverseConnectManager.setChannelAdapter(remoteInfo.remoteServerId, channelId, adapter);
    reverseConnectManager.openVirtualChannel(remoteInfo.remoteServerId, channelId, wsPath, wsQuery);

    remoteWs = adapter;
    // Simulate open event on next tick
    setTimeout(() => adapter.emit("open"), 0);
  } else {
    if (!remoteInfo.remoteUrl) {
      // No direct URL available (reverse-connect only) — cannot fall back to direct WS
      console.log(`[AgentWS] No direct URL for ${sessionId}, skipping reconnect (reverse-connect only)`);
      cache.setReconnecting(sessionId, false);
      cache.broadcast(sessionId, JSON.stringify({ remoteStatus: "disconnected" }));
      return;
    }
    let remoteWsUrl: string;
    try {
      remoteWsUrl = buildRemoteWsUrl(remoteInfo);
      remoteWs = new WebSocket(remoteWsUrl, undefined, wsOptions);
    } catch (err) {
      console.error(`[AgentWS] Failed to open remote WS for ${sessionId}:`, err);
      cache.setReconnecting(sessionId, false);
      cache.broadcast(sessionId, JSON.stringify({ remoteStatus: "disconnected" }));
      return;
    }
  }

  cache.setRemoteWs(sessionId, remoteWs as WebSocket);
  cache.setReconnecting(sessionId, false);
  cache.clearReconnectTimer(sessionId);

  /** Live-mode message handler — shared by both first-connect and post-sync paths. */
  const handleLiveMessage = (data: import("ws").RawData) => {
    const raw = data.toString();
    const parsed = tryParseWsMessage(raw);
    if (!parsed) return;

    // DEBUG: trace every message arriving from remote, with status-patch detail
    const kind = "JsonPatch" in parsed ? "JsonPatch"
      : "finished" in parsed ? "finished"
      : "taskCompleted" in parsed ? "taskCompleted"
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
      if (eventBus) {
        const statusEvent = statusEventFromRemotePatch(parsed, sessionId, remoteInfo);
        if (statusEvent) {
          console.log(`[AgentWS:remote→eventBus] ${sessionId} session:status=${statusEvent.status}`);
          eventBus.emit(statusEvent);
        }
      }
    } else if ("finished" in parsed) {
      cache.setFinished(sessionId);
      cache.broadcast(sessionId, raw);
    } else if ("taskCompleted" in parsed) {
      cache.appendMessage(sessionId, raw, false);
      cache.broadcast(sessionId, raw);
      // Emit on local EventBus so ChatSessionManager can detect task completion
      // (mirrors the executor:stopped pattern for remote executors)
      if (eventBus) {
        const tc = parsed.taskCompleted as Record<string, unknown> | undefined;
        const projectId = projectIdFromRemoteSessionId(sessionId, remoteInfo);
        const branch = remoteInfo.branch ?? null;
        eventBus.emit({
          type: "session:taskCompleted",
          projectId,
          branch,
          sessionId,
          duration_ms: tc?.duration_ms as number | undefined,
          cost_usd: tc?.cost_usd as number | undefined,
          input_tokens: tc?.input_tokens as number | undefined,
          output_tokens: tc?.output_tokens as number | undefined,
          summaryText: tc?.summaryText as string | undefined,
        });
        agentSessionManager?.emitBranchActivityIfChanged(
          projectId,
          branch,
          { activity: "completed", since: Date.now(), sessionId },
        );
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
      cache.appendMessage(sessionId, raw, false);
      cache.broadcast(sessionId, raw);
      // If session not found on remote, stop reconnecting
      if (parsed.error === "Session not found") {
        cache.setFinished(sessionId);
      }
    } else if ("Ready" in parsed) {
      cache.broadcast(sessionId, raw);
    }
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
    // Has cached data but persistent WS died — need sync first
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
        const cachedMsgCount = currentEntry.messages.length;

        if (replayBuffer.length > cachedMsgCount) {
          // Remote has newer data — send delta + update cache
          const delta = replayBuffer.slice(cachedMsgCount);
          console.log(`[AgentWS] Sync delta: ${delta.length} new msgs for ${sessionId}`);
          for (const msg of delta) {
            const p = tryParseWsMessage(msg);
            cache.appendMessage(sessionId, msg, !!(p && "JsonPatch" in p));
            cache.broadcast(sessionId, msg);
          }
        } else if (replayBuffer.length < cachedMsgCount) {
          // Cache is stale (session was restarted remotely) — full replace
          console.log(`[AgentWS] Sync stale cache for ${sessionId}: remote=${replayBuffer.length}, cached=${cachedMsgCount}`);
          let newPatchCount = 0;
          for (const msg of replayBuffer) {
            const p = tryParseWsMessage(msg);
            if (p && "JsonPatch" in p) newPatchCount++;
          }
          cache.replaceAll(sessionId, [...replayBuffer], newPatchCount);
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
        // else equal — cache is current, nothing to send

        // Switch to live-mode handler
        remoteWs.removeAllListeners("message");
        remoteWs.on("message", handleLiveMessage);
        return;
      }

      // Buffer history messages during sync
      if ("JsonPatch" in parsed || "taskCompleted" in parsed || "error" in parsed) {
        replayBuffer.push(raw);
      }
      if ("finished" in parsed) {
        cache.setFinished(sessionId);
      }
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

    scheduleRemoteReconnect(sessionId, remoteInfo, cache, wsOptions, reverseConnectManager, eventBus, agentSessionManager);
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
  wsOptions: Record<string, unknown>,
  reverseConnectManager?: ReverseConnectManager,
  eventBus?: EventBus,
  agentSessionManager?: AgentSessionManager,
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
    connectPersistentRemoteWs(sessionId, remoteInfo, cache, wsOptions, reverseConnectManager, eventBus, agentSessionManager);
  }, totalDelay);

  cache.setReconnectTimer(sessionId, timer);
}

export interface EnsureStreamDeps {
  remoteSessionMap: Map<string, RemoteSessionInfo>;
  remotePatchCache: RemotePatchCache;
  reverseConnectManager: ReverseConnectManager | null;
  eventBus: EventBus | null;
  agentSessionManager: AgentSessionManager;
  wsOptions?: Record<string, unknown>;
}

/**
 * Idempotently ensure a persistent remote stream is connected for this session,
 * so its remote `taskCompleted` bridges to the local EventBus (which wakes the
 * commander) even when no frontend window is open. No-op if a connection is
 * already live or reconnecting. Reverse-connect deployments don't use wsOptions.
 */
export function ensureRemoteAgentStream(localSessionId: string, deps: EnsureStreamDeps): void {
  const remoteInfo = deps.remoteSessionMap.get(localSessionId);
  if (!remoteInfo) return;
  if (deps.remotePatchCache.getRemoteWs(localSessionId) || deps.remotePatchCache.isReconnecting(localSessionId)) return;
  connectPersistentRemoteWs(
    localSessionId,
    remoteInfo,
    deps.remotePatchCache,
    deps.wsOptions ?? {},
    deps.reverseConnectManager ?? undefined,
    deps.eventBus ?? undefined,
    deps.agentSessionManager,
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
    remoteInfo.remoteUrl,
    remoteInfo.remoteApiKey,
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
