"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { produce } from "immer";
import { toast } from "sonner";
import { getWebSocketUrl, getFreshToken, authFetch, createNewAgentSession, ResidentLimitError, type RunningResidentSession } from "@/lib/api";
import type { AgentType, WorkflowRun } from "@/lib/api";
import {
  workspaceKey,
  hasPlaceholder,
  addPlaceholder,
  removePlaceholder,
} from "@/lib/placeholder-workspaces";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

// ============ Content Part Types (for image attachments) ============

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; mediaType: string; data: string }; // base64
export type ContentPart = TextPart | ImagePart;

// ============ Types ============

export type AgentMessage =
  // origin marks machine-authored user turns (workflow-injected prompts);
  // the UI renders them as markdown under a distinct header.
  | { type: "user"; content: string | ContentPart[]; timestamp: number; origin?: "workflow" }
  | { type: "assistant"; content: string; partial?: boolean; agentType?: AgentType; timestamp: number }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string; timestamp: number }
  | { type: "tool_result"; tool: string; output: string; toolUseId?: string; timestamp: number }
  | { type: "thinking"; content: string; timestamp: number }
  | { type: "error"; message: string; timestamp: number }
  | { type: "system"; content: string; timestamp: number }
  | { type: "approval_request"; requestType: "command" | "fileChange"; requestId: string; command?: string; cwd?: string; changes?: Array<{path: string; diff?: string; kind: string}>; timestamp: number }
  | { type: "turn_end"; timestamp: number; durationMs?: number; outcome?: "completed" | "failed" | "stopped" | "process_exit" | "server_restart" };

export type AgentSessionStatus = "running" | "stopped" | "error";

export interface AgentSession {
  id: string;
  projectId: string;
  branch: string | null;
  status: AgentSessionStatus;
  permissionMode?: "plan" | "edit";
  agentType?: AgentType;
  model?: string | null;
  processAlive?: boolean;
}

// ============ JSON Patch Types (RFC 6902) ============

type PatchOperation = "add" | "replace" | "remove";

interface PatchEntry {
  op: PatchOperation;
  path: string;
  value?: PatchValue;
}

type Patch = PatchEntry[];

type PatchValue =
  | { type: "ENTRY"; content: AgentMessage }
  | { type: "STATUS"; content: AgentSessionStatus }
  | { type: "READY"; content: true }
  | { type: "FINISHED"; content: true };

export type RemoteConnectionStatus = "connected" | "reconnecting" | "disconnected";

// WebSocket message types
type AgentWsMessage =
  | { JsonPatch: Patch }
  | { HistorySync: { historyEpoch: number; reset: boolean } }
  | { Ready: true; historyEpoch?: number }
  | { finished: true }
  | { error: string }
  | { taskCompleted: { duration_ms?: number; cost_usd?: number; input_tokens?: number; output_tokens?: number } }
  | { processAlive: { alive: boolean } }
  | { remoteStatus: RemoteConnectionStatus; attempt?: number }
  | { titleUpdated: { title: string } }
  | { workflowRunUpdated: WorkflowRun }
  // Server liveness frame, every 30s. Carries no state — its only job is to
  // give the silence watchdog something to observe on an idle session.
  | { keepalive: number };

// Container for patch target
interface PatchContainer {
  entries: Record<number, AgentMessage>;
  status: AgentSessionStatus;
}

export interface WindowedAgentEntry {
  entryIndex: number;
  message: AgentMessage;
}

interface SessionHistoryWindow {
  historyEpoch: number;
  latestEntryIndex: number | null;
  lastTurnEndEntryIndex: number | null;
  entries: WindowedAgentEntry[];
  previousCursor: number | null;
  hasMore: boolean;
  status: AgentSessionStatus;
  session?: AgentSession;
}

interface SessionHistoryHead {
  historyEpoch: number;
  latestEntryIndex: number | null;
  lastTurnEndEntryIndex: number | null;
  status: AgentSessionStatus;
}

const INITIAL_HISTORY_TURNS = 5;

// ============ API Functions ============

function getApiBase(): string {
  if (typeof window === "undefined") {
    return "";
  }
  // Local dev mode: frontend on 3000, backend on 5173
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:5173";
  }
  // Production or tunnel access: use relative path
  return "";
}

async function loadExistingSession(
  projectId: string,
  branch: string | null,
  permissionMode?: "plan" | "edit",
  agentType?: AgentType
): Promise<{ session: AgentSession | null; messages: AgentMessage[]; historyWindow?: SessionHistoryWindow }> {
  const response = await authFetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, permissionMode, agentType, historyTurns: INITIAL_HISTORY_TURNS }),
  });

  if (!response.ok) {
    throw new Error("Failed to load session");
  }

  return response.json();
}

async function sendMessageToSession(sessionId: string, content: string | ContentPart[]): Promise<void> {
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      if (body.errorCode) {
        const parts = [`${body.errorCode}`];
        if (body.attempts) parts.push(`${body.attempts} attempts`);
        if (body.totalDurationMs) parts.push(`${(body.totalDurationMs / 1000).toFixed(1)}s`);
        detail = ` (${parts.join(", ")})`;
      } else if (body.error) {
        detail = ` — ${body.error}`;
      }
    } catch {
      // ignore parse errors
    }
    console.error(`[AgentSession] /message failed: status=${response.status}, sessionId=${sessionId}, detail=${detail}`);
    throw new Error(`Failed to send message [${response.status}]${detail}`);
  }
}

export interface UploadedPaste {
  path: string;
  size: number;
}

async function uploadPasteToSession(
  sessionId: string,
  content: string
): Promise<UploadedPaste> {
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/paste`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      if (body.errorCode) {
        const parts = [`${body.errorCode}`];
        if (body.attempts) parts.push(`${body.attempts} attempts`);
        if (body.totalDurationMs) parts.push(`${(body.totalDurationMs / 1000).toFixed(1)}s`);
        detail = ` (${parts.join(", ")})`;
      } else if (body.error) {
        detail = ` — ${body.error}`;
      }
    } catch {
      // ignore parse errors
    }
    console.error(`[AgentSession] /paste failed: status=${response.status}, sessionId=${sessionId}, detail=${detail}`);
    throw new Error(`Failed to upload paste [${response.status}]${detail}`);
  }

  return response.json();
}

async function restartSessionApi(sessionId: string, agentType?: AgentType): Promise<void> {
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentType }),
  });

  if (!response.ok) {
    throw new Error("Failed to restart session");
  }
}

async function switchAgentTypeApi(sessionId: string, agentType: AgentType): Promise<void> {
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/agent-type`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentType }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // ignore parse errors
    }
    throw new Error(detail || `Failed to switch agent [${response.status}]`);
  }
}

async function setModelApi(sessionId: string, model: string | null): Promise<string | null> {
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // ignore parse errors
    }
    throw new Error(detail || `Failed to set model [${response.status}]`);
  }

  // The server normalizes (a blank name is the CLI default), so the stored
  // value is what the chip must show — not the string that was sent.
  const body = (await response.json().catch(() => ({}))) as { model?: string | null };
  return body.model ?? null;
}

async function stopSessionApi(sessionId: string): Promise<void> {
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/stop`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("Failed to stop session");
  }
}

async function switchModeApi(sessionId: string, mode: "plan" | "edit"): Promise<void> {
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/switch-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });

  if (!response.ok) {
    throw new Error("Failed to switch mode");
  }
}

async function acceptPlanApi(sessionId: string, planContent: string): Promise<void> {
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/accept-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planContent }),
  });

  if (!response.ok) {
    throw new Error("Failed to accept plan");
  }
}

// ============ Session Cache ============
// A small, page-lifetime LRU. A stopped snapshot is reused after a lightweight
// head check; changed or running sessions fetch only the latest bounded window.
// The WebSocket then reconciles the active tail after the last sealed turn.
//
// This deliberately is not localStorage: transcripts can contain large tool
// output, images, and sensitive source code. Keeping it in memory bounds both
// persistence and exposure.
interface CachedSessionSnapshot {
  session: AgentSession;
  history: SessionHistoryWindow;
}

const MAX_SESSION_CACHE_KEYS = 16;
const sessionCache = new Map<string, CachedSessionSnapshot>();
const historyFetches = new Map<string, Promise<SessionHistoryWindow>>();

function getCacheKey(projectId: string, branch: string | null, sessionId?: string | null): string {
  return `${projectId}:${branch ?? ""}:${sessionId ?? "latest"}`;
}

function readSessionCache(key: string): CachedSessionSnapshot | undefined {
  const cached = sessionCache.get(key);
  if (!cached) return undefined;
  // Map insertion order is our LRU order.
  sessionCache.delete(key);
  sessionCache.set(key, cached);
  return cached;
}

// Most-recently-used snapshot for a workspace, whatever session id it was
// keyed under. A branch-only arrival asks for `<pid>:<branch>:latest`, but a
// previous visit pinned to ?session=<id> persisted only sid-shaped keys — an
// exact-key miss there does not mean the workspace is cold. The previewed
// session may differ from what latest-for-branch resolves to; startSession
// revalidates and replaces it. Prefix matching is unambiguous: git ref names
// cannot contain ":".
function readLatestWorkspaceSnapshot(projectId: string, branch: string | null): CachedSessionSnapshot | undefined {
  const prefix = `${projectId}:${branch ?? ""}:`;
  let latestKey: string | undefined;
  for (const key of sessionCache.keys()) {
    if (key.startsWith(prefix)) latestKey = key;
  }
  return latestKey ? readSessionCache(latestKey) : undefined;
}

function writeSessionCache(key: string, snapshot: CachedSessionSnapshot): void {
  sessionCache.delete(key);
  sessionCache.set(key, snapshot);
  while (sessionCache.size > MAX_SESSION_CACHE_KEYS) {
    const oldest = sessionCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    sessionCache.delete(oldest);
  }
}

function cacheSessionSnapshot(
  projectId: string,
  branch: string | null,
  requestedSessionId: string | null,
  session: AgentSession,
  history: SessionHistoryWindow,
): void {
  const snapshot = { session, history: { ...history, entries: [...history.entries] } };
  writeSessionCache(getCacheKey(projectId, branch, requestedSessionId), snapshot);
  writeSessionCache(getCacheKey(projectId, branch, session.id), snapshot);
}

function updateCachedSessionMetadata(
  projectId: string,
  branch: string | null,
  requestedSessionId: string | null,
  session: AgentSession,
): void {
  const cached = readSessionCache(getCacheKey(projectId, branch, session.id))
    ?? readSessionCache(getCacheKey(projectId, branch, requestedSessionId));
  if (!cached) return;
  cacheSessionSnapshot(projectId, branch, requestedSessionId, session, cached.history);
}

async function getHistoryWindow(sessionId: string, before?: number | null): Promise<SessionHistoryWindow> {
  const params = new URLSearchParams({ turns: String(INITIAL_HISTORY_TURNS) });
  if (before !== undefined && before !== null) params.set("before", String(before));
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/history-window?${params}`);
  if (!response.ok) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const data = await response.json() as Partial<SessionHistoryWindow> & {
    messages?: AgentMessage[];
    session?: AgentSession;
  };
  if (Array.isArray(data.entries)) return data as SessionHistoryWindow;
  // Test doubles and pre-window servers may answer with the legacy detail
  // shape. Normalize it here; production remote fallback is normally handled
  // by the hub so the browser still receives a bounded response.
  const messages = data.messages ?? [];
  return {
    historyEpoch: 0,
    latestEntryIndex: messages.length > 0 ? messages.length - 1 : null,
    lastTurnEndEntryIndex: messages.reduce<number | null>(
      (last, message, index) => message.type === "turn_end" ? index : last,
      null,
    ),
    entries: messages.map((message, entryIndex) => ({ entryIndex, message })),
    previousCursor: null,
    hasMore: false,
    status: data.session?.status ?? "stopped",
    session: data.session,
  };
}

function getLatestHistoryWindow(sessionId: string): Promise<SessionHistoryWindow> {
  const existing = historyFetches.get(sessionId);
  if (existing) return existing;
  const request = getHistoryWindow(sessionId).finally(() => historyFetches.delete(sessionId));
  historyFetches.set(sessionId, request);
  return request;
}

async function getHistoryHead(sessionId: string): Promise<SessionHistoryHead> {
  const response = await authFetch(`${getApiBase()}/api/agent-sessions/${sessionId}/history-head`);
  if (!response.ok) throw new Error(`Session ${sessionId} not found`);
  const data = await response.json() as Partial<SessionHistoryHead> & {
    messages?: AgentMessage[];
    session?: AgentSession;
  };
  if (typeof data.historyEpoch === "number") return data as SessionHistoryHead;
  const messages = data.messages ?? [];
  return {
    historyEpoch: 0,
    latestEntryIndex: messages.length > 0 ? messages.length - 1 : null,
    lastTurnEndEntryIndex: messages.reduce<number | null>(
      (last, message, index) => message.type === "turn_end" ? index : last,
      null,
    ),
    status: data.session?.status ?? "stopped",
  };
}

function entriesRecord(entries: WindowedAgentEntry[]): Record<number, AgentMessage> {
  return Object.fromEntries(entries.map(({ entryIndex, message }) => [entryIndex, message]));
}

function denseEntries(container: PatchContainer): WindowedAgentEntry[] {
  return Object.entries(container.entries)
    .map(([entryIndex, message]) => ({ entryIndex: Number(entryIndex), message }))
    .sort((a, b) => a.entryIndex - b.entryIndex);
}

function emptyHistory(session: AgentSession): SessionHistoryWindow {
  return {
    historyEpoch: 0,
    latestEntryIndex: null,
    lastTurnEndEntryIndex: null,
    entries: [],
    previousCursor: null,
    hasMore: false,
    status: session.status,
    session,
  };
}

// ============ Patch Application ============

/**
 * Apply a JSON Patch to the container using Immer for structural sharing
 */
function applyPatch(container: PatchContainer, patch: Patch): PatchContainer {
  return produce(container, (draft) => {
    for (const entry of patch) {
      const { op, path, value } = entry;

      // Handle special clearAll patch (path is "/entries" with replace)
      if (path === "/entries" && op === "replace") {
        // Check if it's the special clearAll marker
        if (value?.type === "ENTRY" && value.content?.type === "system" && value.content?.content === "__CLEAR_ALL__") {
          console.log("[JsonPatch] Received clearAll signal - clearing all entries");
          draft.entries = {};
          continue;
        }
      }

      // Parse path: /entries/0 or /status
      if (path.startsWith("/entries/")) {
        const indexStr = path.replace("/entries/", "");
        const index = parseInt(indexStr, 10);

        if (isNaN(index)) {
          console.warn(`[JsonPatch] Invalid index in path: ${path}`);
          continue;
        }

        if (value?.type !== "ENTRY") {
          console.warn(`[JsonPatch] Expected ENTRY type for entries path`);
          continue;
        }

        switch (op) {
          case "add":
            // Ensure array is large enough
            draft.entries[index] = value.content;
            break;

          case "replace":
            if (draft.entries[index] !== undefined) {
              draft.entries[index] = value.content;
            } else {
              console.warn(`[JsonPatch] Replace index out of bounds: ${index}`);
            }
            break;

          case "remove":
            delete draft.entries[index];
            break;
        }
      } else if (path === "/status") {
        if (value?.type === "STATUS") {
          console.log("[AgentSession] /status patch →", value.content);
          draft.status = value.content;
        }
      }
    }
  });
}

/**
 * Deduplicate patches by path - last operation for each path wins
 */
function deduplicatePatches(patches: Patch[]): Patch {
  const lastByPath = new Map<string, PatchEntry>();

  for (const patch of patches) {
    for (const entry of patch) {
      lastByPath.set(entry.path, entry);
    }
  }

  return Array.from(lastByPath.values());
}

// ============ Hook ============

interface UseAgentSessionOptions {
  sessionId?: string | null; // Explicit session to load; when undefined/null -> latest-for-branch behavior
  // True while the caller is mid-navigation and the (branch, sessionId) pair is
  // not final yet (cross-project session jump: branch is nulled until the target
  // project's worktrees load). Blocks auto-start so we never fetch — and flash —
  // the default branch's latest session for a workspace the user didn't pick.
  suspended?: boolean;
  onTaskCompleted?: () => void;
  onSessionStarted?: (session: AgentSession) => void;
  onTitleUpdated?: (title: string, sessionId: string | null) => void;
}

export function useAgentSession(projectId: string | null, branch: string | null, agentMode?: string, agentType?: AgentType, options?: UseAgentSessionOptions) {
  const explicitSessionId = options?.sessionId ?? null;
  const suspended = options?.suspended ?? false;
  const [session, setSession] = useState<AgentSession | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<AgentSessionStatus>("stopped");
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCachePreview, setIsCachePreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteConnectionStatus | null>(null);
  const [workflowRunUpdate, setWorkflowRunUpdate] = useState<WorkflowRun | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const wsSessionIdRef = useRef<string | null>(null);
  const openSocketRef = useRef<(sessionId: string) => void>(() => {});
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const containerRef = useRef<PatchContainer>({ entries: {}, status: "stopped" });
  const historyRef = useRef<SessionHistoryWindow | null>(null);
  const [hasEarlierHistory, setHasEarlierHistory] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const sessionRef = useRef<AgentSession | null>(null);
  const finishedRef = useRef(false);
  const shouldAutoStartRef = useRef(true); // Auto-start on mount and worktree switch
  const connectionStartTimeRef = useRef<number | null>(null);
  const stabilityTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shortLivedConnectionsRef = useRef(0);
  const isReplayingRef = useRef(false); // True during history replay (before Ready signal)
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null); // Zombie-socket watchdog (see SILENCE_TIMEOUT_MS)
  const sessionGenerationRef = useRef(0); // Incremented on branch/project change to discard stale API responses
  const lastStartFailedRef = useRef(false); // Prevents auto-restart loop after session creation failure
  const startingRef = useRef(false); // Reentrancy guard for startSession
  const cachePreviewRef = useRef(false);
  // Read via ref in the reset effect: suspension lifting must NOT re-run the
  // reset (it would tear down the freshly-started target session).
  const suspendedRef = useRef(suspended);
  // Serializes model changes so they reach the server in the order picked and
  // the last reply to land is the last pick (see setModel).
  const modelChangeChain = useRef<Promise<void>>(Promise.resolve());
  // Placeholder mode ("user clicked New Conversation, no session in DB yet")
  // is module-level state in `lib/placeholder-workspaces.ts`. Mirrored to
  // localStorage so the intent survives reloads and project switches; cleared
  // when the user picks a history session or sends the first message.
  const onTaskCompletedRef = useRef(options?.onTaskCompleted);
  const onSessionStartedRef = useRef(options?.onSessionStarted);
  const onTitleUpdatedRef = useRef(options?.onTitleUpdated);
  // connectWebSocket has [] deps so its WS handlers freeze projectId/branch/
  // explicitSessionId at first render. Reading these via refs ensures cache
  // invalidation in the handlers targets the CURRENT cache key, not a stale
  // one (which silently leaked entries and caused a connect/disconnect loop
  // on "Session not found" — handler deleted a never-existing key, leaving
  // the real entry behind for the next auto-start to cache-hit on).
  const projectIdRef = useRef(projectId);
  const branchRef = useRef(branch);
  const explicitSessionIdRef = useRef(explicitSessionId);

  // Keep callback + identity refs in sync with latest props (avoids stale
  // closures in WebSocket handler — see comment above).
  useEffect(() => {
    onTaskCompletedRef.current = options?.onTaskCompleted;
    onSessionStartedRef.current = options?.onSessionStarted;
    onTitleUpdatedRef.current = options?.onTitleUpdated;
    projectIdRef.current = projectId;
    branchRef.current = branch;
    explicitSessionIdRef.current = explicitSessionId;
    sessionRef.current = session;
    suspendedRef.current = suspended;
  });

  // Durable completion notifications are a latency hint: while the user is
  // looking elsewhere, refresh any warm window for the completed session.
  // A missed SSE is harmless because startSession always revalidates the
  // bounded server window before displaying it.
  useGlobalEventStream((data) => {
    if (data.type !== "notification:created") return;
    const notification = (data as {
      notification?: { kind?: string; session_id?: string | null };
    }).notification;
    const sessionId = notification?.session_id;
    if (!sessionId || (notification.kind !== "session_result_ready" && notification.kind !== "session_failed")) return;
    const warm = [...sessionCache.entries()].filter(([, value]) => value.session.id === sessionId);
    if (warm.length === 0) return;
    void getLatestHistoryWindow(sessionId)
      .then((history) => {
        for (const [key, value] of warm) {
          const nextSession = history.session ?? { ...value.session, status: history.status };
          writeSessionCache(key, { session: nextSession, history });
        }
      })
      .catch((error) => console.warn(`[AgentSession] completion prefetch failed for ${sessionId}:`, error));
  });

  // WebSocket reconnection constants
  const MIN_STABLE_CONNECTION_MS = 5000;  // Connection must be stable for 5s before resetting backoff
  const MAX_RECONNECT_DELAY_MS = 30000;   // Maximum reconnect delay (30s)
  const MAX_RECONNECT_ATTEMPTS = 10;      // Stop trying after this many attempts
  const MAX_SHORT_LIVED_CONNECTIONS = 3;  // After 3 short connections, assume session is invalid

  // Zombie-socket watchdog. When the device sleeps or the network switches, the
  // TCP connection dies without a close handshake: readyState stays OPEN, no
  // `onclose` fires, and no reconnect is ever scheduled — so every patch the
  // server broadcasts from then on is lost and the conversation freezes
  // mid-turn while the sidebar (fed by SSE) keeps updating. The server sends a
  // `keepalive` frame every 30s, so three missed intervals means the socket is
  // gone; close it ourselves to fall into the normal reconnect + replay path.
  // Browsers never expose pong events to JS, which is why this watches for
  // application-level frames rather than the protocol-level heartbeat.
  const SILENCE_TIMEOUT_MS = 95000;

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  /** Restart the silence countdown for `ws`; called on every inbound frame. */
  const armSilenceTimer = useCallback((ws: WebSocket) => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null;
      if (ws.readyState !== WebSocket.OPEN) return;
      console.warn(`[AgentSession] No frames for ${SILENCE_TIMEOUT_MS}ms — assuming dead socket, forcing reconnect`);
      // Not 1000: that code is reserved for intentional closes, which onclose
      // treats as "do not reconnect".
      try { ws.close(4000, "silence watchdog"); } catch { /* already gone */ }
    }, SILENCE_TIMEOUT_MS);
  }, []);

  // Calculate reconnect delay with jitter
  const getReconnectDelay = (attempt: number): number => {
    const baseDelay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * Math.pow(2, attempt));
    const jitter = baseDelay * Math.random() * 0.25;  // 0-25% jitter
    return baseDelay + jitter;
  };

  // Token-refreshing entry point. Every (re)connect first fetches a
  // guaranteed-valid token (cache-hit = no network) so the WS upgrade never
  // carries an expired JWT. Actual socket setup is in `openSocket`, reached via
  // a ref to keep this callback's deps empty.
  // `forceRefresh` forces a network token mint (skipCache) — used when reconnecting
  // after the server closed the socket, which may be an expired/rejected token.
  // Bounded, because the token hop is the one step with no failure path of its
  // own: `getFreshToken` swallows its own errors, but if Clerk's getToken()
  // *hangs* (network stall) the `.then` below never runs — no socket, no error,
  // no reconnect, and the session silently has no stream for the rest of its
  // life. On timeout we open anyway with the last known token; if the server
  // rejects it, `onclose` reconnects with `skipCache` — a loop that recovers,
  // unlike a promise that never settles.
  const TOKEN_WAIT_TIMEOUT_MS = 5000;
  const connectWebSocket = useCallback((sessionId: string, forceRefresh = false) => {
    void Promise.race([
      getFreshToken(forceRefresh ? { skipCache: true } : undefined),
      new Promise<void>((resolve) => setTimeout(resolve, TOKEN_WAIT_TIMEOUT_MS)),
    ])
      .catch(() => undefined)
      .then(() => openSocketRef.current(sessionId));
  }, []);

  // Connect WebSocket to session
  const openSocket = useCallback((sessionId: string) => {
    // Helper: invalidate cache entries for the current workspace context.
    // Reads identity from refs because openSocket has [] deps and would
    // otherwise close over stale projectId/branch/explicitSessionId values.
    const invalidateSessionCache = () => {
      const pid = projectIdRef.current;
      if (!pid) return;
      const br = branchRef.current;
      sessionCache.delete(getCacheKey(pid, br, explicitSessionIdRef.current));
      const sid = wsSessionIdRef.current;
      if (sid) sessionCache.delete(getCacheKey(pid, br, sid));
      // The workspace ("latest") key too. A session created without an explicit
      // id is cached under BOTH keys, but by the time it stops the user has
      // usually selected it by id — leaving the latest key holding a snapshot
      // frozen at `status: "running"`. A later cache hit would hand that stale
      // status to onSessionStarted, which seeds the sidebar dot from it.
      sessionCache.delete(getCacheKey(pid, br, null));
    };

    const persistCurrentSnapshot = () => {
      const pid = projectIdRef.current;
      const currentSession = sessionRef.current;
      if (!pid || !currentSession || currentSession.id !== sessionId) return;
      const nextSession = currentSession.status === containerRef.current.status
        ? currentSession
        : { ...currentSession, status: containerRef.current.status };
      sessionRef.current = nextSession;
      const existingHistory = historyRef.current;
      if (!existingHistory) return;
      const windowEntries = denseEntries(containerRef.current);
      const latestEntryIndex = windowEntries.at(-1)?.entryIndex ?? null;
      const lastTurnEndEntryIndex = [...windowEntries].reverse()
        .find((entry) => entry.message.type === "turn_end")?.entryIndex
        ?? existingHistory.lastTurnEndEntryIndex;
      const nextHistory = {
        ...existingHistory,
        status: containerRef.current.status,
        latestEntryIndex,
        lastTurnEndEntryIndex,
        entries: windowEntries,
      };
      historyRef.current = nextHistory;
      cacheSessionSnapshot(
        pid,
        branchRef.current,
        explicitSessionIdRef.current,
        nextSession,
        nextHistory,
      );
    };

    // If WS is open/connecting for a DIFFERENT session, close it first
    if (wsRef.current && wsSessionIdRef.current !== sessionId) {
      console.log(`[AgentSession] Closing stale WS for ${wsSessionIdRef.current}, switching to ${sessionId}`);
      wsRef.current.close(1000, "session-switch");
      wsRef.current = null;
      wsSessionIdRef.current = null;
    }

    // Prevent duplicate connections to the SAME session
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    // Only reset container if it has no existing data (preserve REST-provided messages)
    if (Object.keys(containerRef.current.entries).length === 0) {
      containerRef.current = { entries: {}, status: "running" };
    }
    finishedRef.current = false;
    isReplayingRef.current = true; // Buffer patches until Ready signal

    const history = historyRef.current;
    const syncParams = new URLSearchParams();
    if (history?.lastTurnEndEntryIndex !== null && history?.lastTurnEndEntryIndex !== undefined) {
      syncParams.set("after", String(history.lastTurnEndEntryIndex));
      syncParams.set("epoch", String(history.historyEpoch));
    }
    const suffix = syncParams.size > 0 ? `?${syncParams}` : "";
    const wsUrl = getWebSocketUrl(`/api/agent-sessions/${sessionId}/stream${suffix}`);
    console.log("[AgentSession] Connecting to WebSocket:", wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    wsSessionIdRef.current = sessionId;

    ws.onopen = () => {
      console.log("[AgentSession] WebSocket connected");
      setIsConnected(true);
      setError(null);
      setRemoteStatus(null);

      // Track connection start time
      connectionStartTimeRef.current = Date.now();
      armSilenceTimer(ws);

      // Only reset backoff counter after connection has been stable
      if (stabilityTimeoutRef.current) {
        clearTimeout(stabilityTimeoutRef.current);
      }
      stabilityTimeoutRef.current = setTimeout(() => {
        console.log("[AgentSession] Connection stable, resetting backoff counter");
        reconnectAttemptRef.current = 0;
        shortLivedConnectionsRef.current = 0;
      }, MIN_STABLE_CONNECTION_MS);
    };

    ws.onmessage = (event) => {
      // Any frame proves the socket is alive, whatever it turns out to be.
      armSilenceTimer(ws);
      try {
        const msg = JSON.parse(event.data) as AgentWsMessage;

        // Liveness-only frame — already accounted for above.
        if ("keepalive" in msg) return;

        if ("HistorySync" in msg) {
          if (msg.HistorySync.reset || (historyRef.current && historyRef.current.historyEpoch !== msg.HistorySync.historyEpoch)) {
            containerRef.current = { entries: {}, status: containerRef.current.status };
            historyRef.current = historyRef.current
              ? {
                  ...historyRef.current,
                  historyEpoch: msg.HistorySync.historyEpoch,
                  latestEntryIndex: null,
                  lastTurnEndEntryIndex: null,
                  entries: [],
                  previousCursor: null,
                  hasMore: false,
                }
              : null;
            setHasEarlierHistory(false);
          }
          return;
        }

        // Handle JsonPatch messages
        if ("JsonPatch" in msg) {
          const patch = msg.JsonPatch;

          // Apply patch to container (always)
          containerRef.current = applyPatch(containerRef.current, patch);

          // During replay, skip React state updates to avoid scroll jump
          if (!isReplayingRef.current) {
            const nextMessages = denseEntries(containerRef.current).map((entry) => entry.message);
            setMessages(nextMessages);
            console.log("[AgentSession] setStatus(live) →", containerRef.current.status);
            setStatus(containerRef.current.status);
            persistCurrentSnapshot();
          } else {
            console.log("[AgentSession] /status patch applied during replay (no setStatus), container.status =", containerRef.current.status);
          }
          return;
        }

        // Handle Ready signal - history replay complete, flush state
        if ("Ready" in msg) {
          console.log("[AgentSession] Received Ready signal - history complete, status=", containerRef.current.status);
          isReplayingRef.current = false;
          // Flush accumulated state to React in a single update
          setMessages(denseEntries(containerRef.current).map((entry) => entry.message));
          setStatus(containerRef.current.status);
          setIsInitialized(true);
          persistCurrentSnapshot();
          return;
        }

        // Handle finished signal. Keep the final snapshot: stopped history is
        // exactly the content users most often switch back to.
        if ("finished" in msg) {
          console.log("[AgentSession] Received finished signal, preserving cached snapshot");
          finishedRef.current = true;
          persistCurrentSnapshot();
          ws.close(1000, "finished");
          return;
        }

        // Handle task completed - show toast
        if ("taskCompleted" in msg) {
          const { duration_ms, cost_usd, input_tokens, output_tokens } = msg.taskCompleted;
          const parts: string[] = [];
          if (duration_ms != null) {
            const secs = (duration_ms / 1000).toFixed(1);
            parts.push(`${secs}s`);
          }
          if (cost_usd != null) {
            parts.push(`$${cost_usd.toFixed(4)}`);
          } else if (input_tokens != null || output_tokens != null) {
            const total = (input_tokens ?? 0) + (output_tokens ?? 0);
            const formatted = total > 1000 ? `${(total / 1000).toFixed(1)}K` : String(total);
            parts.push(`${formatted} tokens`);
          }
          toast.success("Task completed", {
            description: parts.length > 0 ? parts.join(" · ") : undefined,
          });
          onTaskCompletedRef.current?.();
          return;
        }

        // Handle remote connection status (for remote sessions)
        if ("remoteStatus" in msg) {
          setRemoteStatus(msg.remoteStatus);
          return;
        }

        // Handle session title (set asynchronously after the first user message)
        if ("titleUpdated" in msg) {
          onTitleUpdatedRef.current?.(msg.titleUpdated.title, wsSessionIdRef.current);
          return;
        }

        if ("workflowRunUpdated" in msg) {
          setWorkflowRunUpdate(msg.workflowRunUpdated);
        }

        // Handle error
        if ("error" in msg) {
          console.error("[AgentSession] Server error:", msg.error);
          setError(msg.error);

          // If session not found, invalidate cache and clear state so auto-start creates a fresh session
          if (msg.error === "Session not found") {
            console.log("[AgentSession] Session invalid, invalidating cache, will create new session");
            invalidateSessionCache();
            finishedRef.current = true;
            setSession(null);
            setStatus("stopped");
            setIsInitialized(false);
            shouldAutoStartRef.current = true;
          }
          return;
        }
      } catch (e) {
        console.error("[AgentSession] Failed to parse message:", e);
      }
    };

    ws.onclose = (event) => {
      console.log("[AgentSession] WebSocket disconnected", event.code, event.reason);
      setIsConnected(false);
      clearSilenceTimer();

      // Clear stability timeout if connection closed before stability threshold
      if (stabilityTimeoutRef.current) {
        clearTimeout(stabilityTimeoutRef.current);
        stabilityTimeoutRef.current = null;
      }

      // Log if connection was short-lived
      const connectionDuration = connectionStartTimeRef.current
        ? Date.now() - connectionStartTimeRef.current
        : 0;
      connectionStartTimeRef.current = null;

      if (connectionDuration > 0 && connectionDuration < MIN_STABLE_CONNECTION_MS) {
        shortLivedConnectionsRef.current++;
        console.log(`[AgentSession] Short-lived connection (${connectionDuration}ms), count: ${shortLivedConnectionsRef.current}, backoff attempt: ${reconnectAttemptRef.current}`);

        // If we've had multiple short-lived connections, the session is likely invalid
        if (shortLivedConnectionsRef.current >= MAX_SHORT_LIVED_CONNECTIONS) {
          console.log("[AgentSession] Multiple short-lived connections detected, session likely invalid - will recreate");
          // Don't auto-restart if the last session creation failed (prevents infinite loop)
          if (lastStartFailedRef.current) {
            console.log("[AgentSession] Skipping auto-restart: last session creation failed");
            setError("Unable to connect to remote server. Please check the server configuration.");
            return;
          }
          // Invalidate cache so auto-start does a full REST call
          invalidateSessionCache();
          // Clear current session to trigger new session creation
          setSession(null);
          setError(null);
          reconnectAttemptRef.current = 0;
          shortLivedConnectionsRef.current = 0;
          shouldAutoStartRef.current = true;
          return; // Don't schedule reconnect, let auto-start create new session
        }
      } else if (connectionDuration >= MIN_STABLE_CONNECTION_MS) {
        // Reset short-lived counter on stable connection
        shortLivedConnectionsRef.current = 0;
      }

      // Don't reconnect if finished or intentionally closed
      if (finishedRef.current || event.code === 1000) {
        return;
      }

      // Check if we've exceeded max attempts
      if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        console.log("[AgentSession] Max reconnect attempts reached");
        setError("Unable to connect to server. Please check if the backend is running.");
        return;
      }

      // Exponential backoff with jitter
      const delay = getReconnectDelay(reconnectAttemptRef.current);
      console.log(`[AgentSession] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttemptRef.current + 1})`);
      reconnectAttemptRef.current++;

      reconnectTimeoutRef.current = setTimeout(() => {
        const currentSessionId = wsSessionIdRef.current;
        if (currentSessionId && !finishedRef.current) {
          // Server-initiated close — mint a fresh token so a reconnect storm after
          // a server restart never re-sends the expired JWT that triggered it.
          connectWebSocket(currentSessionId, true);
        }
      }, delay);
    };

    ws.onerror = (error) => {
      console.error("[AgentSession] WebSocket error:", error);
    };
  }, [connectWebSocket, armSilenceTimer, clearSilenceTimer]);

  // Keep the ref pointed at the latest openSocket so connectWebSocket (stable
  // deps) reaches the current closure after refreshing the token.
  useEffect(() => {
    openSocketRef.current = openSocket;
  }, [openSocket]);

  // Start or get existing session - returns the session for immediate use
  const startSession = useCallback(async (permissionMode?: "plan" | "edit"): Promise<AgentSession | null> => {
    if (!projectId) return null;

    if (startingRef.current) {
      console.log("[AgentSession] startSession already in progress, skipping");
      return null;
    }
    startingRef.current = true;

    // Capture generation at call time to detect stale responses
    const generation = sessionGenerationRef.current;

    setError(null);
    setRemoteStatus(null);
    if (!cachePreviewRef.current) setIsInitialized(false);
    lastStartFailedRef.current = false;

    // A cache hit avoids rendering and parsing the old full transcript, but is
    // not shown until the bounded server window confirms its current head.
    const cacheKey = getCacheKey(projectId, branch, explicitSessionId);
    const cached = readSessionCache(cacheKey);
    setIsLoading(true);

    try {
      console.log(`[AgentSession] Starting REST call: projectId=${projectId}, branch=${branch}, sessionId=${explicitSessionId ?? "latest"}, agentType=${agentType}, generation=${generation}`);
      let newSession: AgentSession | null;
      let initialMessages: AgentMessage[];
      let historyWindow: SessionHistoryWindow | undefined;
      if (explicitSessionId) {
        const head = cached ? await getHistoryHead(explicitSessionId) : null;
        const cacheIsCurrent = cached && head
          && head.status === "stopped"
          && head.historyEpoch === cached.history.historyEpoch
          && head.lastTurnEndEntryIndex === cached.history.lastTurnEndEntryIndex;
        historyWindow = cacheIsCurrent
          ? { ...cached.history, status: head.status, latestEntryIndex: head.latestEntryIndex }
          : await getLatestHistoryWindow(explicitSessionId);
        newSession = historyWindow.session ?? cached?.session ?? null;
        initialMessages = historyWindow.entries.map((entry) => entry.message);
      } else if (cached) {
        // Workspace navigation normally omits ?session=. Reuse the warm
        // latest-session snapshot after the same lightweight sealed-head
        // validation used by explicit history navigation. If it changed (or
        // vanished), fall back to resolving the branch's latest session.
        // The cached handle may have expired; the branch lookup below is the
        // authoritative way to discover its current latest session.
        const head: SessionHistoryHead | null = await getHistoryHead(cached.session.id).catch(() => null);
        const cacheIsCurrent = head
          && head.status === "stopped"
          && head.historyEpoch === cached.history.historyEpoch
          && head.lastTurnEndEntryIndex === cached.history.lastTurnEndEntryIndex;
        if (cacheIsCurrent) {
          historyWindow = { ...cached.history, status: head.status, latestEntryIndex: head.latestEntryIndex };
          newSession = { ...cached.session, status: head.status };
          initialMessages = historyWindow.entries.map((entry) => entry.message);
        } else {
          const loaded = await loadExistingSession(projectId, branch, permissionMode, agentType);
          newSession = loaded.session;
          initialMessages = loaded.messages;
          historyWindow = loaded.historyWindow;
        }
      } else {
        const loaded = await loadExistingSession(projectId, branch, permissionMode, agentType);
        newSession = loaded.session;
        initialMessages = loaded.messages;
        historyWindow = loaded.historyWindow;
      }

      // If branch/project changed while the API call was in flight, discard the result
      if (sessionGenerationRef.current !== generation) {
        console.log("[AgentSession] Discarding stale session response (generation mismatch)");
        return null;
      }

      // No existing session for this (projectId, branch) — surface the empty
      // placeholder. A real session is created on first user message via
      // ensureSession() / POST /agent-sessions/new.
      if (!newSession) {
        console.log(`[AgentSession] No existing session for ${projectId}/${branch ?? "<null>"} — placeholder`);
        setSession(null);
        setStatus("stopped");
        setMessages([]);
        containerRef.current = { entries: {}, status: "stopped" };
        historyRef.current = null;
        setHasEarlierHistory(false);
        setIsInitialized(true);
        return null;
      }

      console.log(`[AgentSession] REST response: sessionId=${newSession.id}, msgCount=${initialMessages?.length ?? 0}, status=${newSession.status}, explicitSessionIdRequested=${explicitSessionId ?? "<null>"}`);

      // Cache the session for future workspace switches (cache under both the explicit id key and the latest key)
      const normalizedHistory: SessionHistoryWindow = historyWindow ? {
        ...historyWindow,
        status: newSession.status,
        session: newSession,
      } : {
        historyEpoch: 0,
        latestEntryIndex: initialMessages.length > 0 ? initialMessages.length - 1 : null,
        lastTurnEndEntryIndex: initialMessages.reduce<number | null>(
          (last, message, index) => message.type === "turn_end" ? index : last,
          null,
        ),
        entries: initialMessages.map((message, entryIndex) => ({ entryIndex, message })),
        previousCursor: null,
        hasMore: false,
        status: newSession.status,
        session: newSession,
      };
      cacheSessionSnapshot(projectId, branch, explicitSessionId, newSession, normalizedHistory);

      setSession(newSession);
      sessionRef.current = newSession;
      historyRef.current = normalizedHistory;
      setHasEarlierHistory(normalizedHistory.hasMore);
      setStatus(newSession.status);

      // Pre-populate the bounded REST window; WebSocket replay only reconciles
      // the active tail after its sealed boundary.
      if (initialMessages && initialMessages.length > 0) {
        setMessages(initialMessages);
        containerRef.current = { entries: entriesRecord(normalizedHistory.entries), status: newSession.status };
      }
      setIsInitialized(true);

      // Connect WebSocket for the active tail and subsequent live patches.
      connectWebSocket(newSession.id);

      // Notify caller that session has started (e.g. to refetch workspace statuses)
      onSessionStartedRef.current?.(newSession);

      // Return session for immediate use (avoids React state timing issues)
      return newSession;
    } catch (e) {
      // Always log the error, even if the request was invalidated
      console.error("[AgentSession] startSession error:", e);

      // Don't set error if the request was invalidated by a branch switch
      if (sessionGenerationRef.current !== generation) {
        console.log("[AgentSession] Discarding error (generation mismatch)");
        return null;
      }

      const errorMsg = e instanceof Error ? e.message : "Failed to start session";
      setError(errorMsg);
      lastStartFailedRef.current = true;
      return null;
    } finally {
      startingRef.current = false;
      // Only clear loading if this is still the current generation
      if (sessionGenerationRef.current === generation) {
        setIsLoading(false);
        setIsCachePreview(false);
        cachePreviewRef.current = false;
      }
    }
  }, [projectId, branch, agentType, explicitSessionId, connectWebSocket]);

  // Send user message - optionally accepts sessionId for immediate use after session creation
  const sendMessage = useCallback(
    async (content: string | ContentPart[], sessionId?: string) => {
      const targetSessionId = sessionId || session?.id;
      if (!targetSessionId) {
        console.warn("[AgentSession] sendMessage: no session ID available (sessionId param:", sessionId, ", session?.id:", session?.id, ")");
        return;
      }
      // Validate: non-empty string or non-empty array
      if (typeof content === "string" && !content.trim()) return;
      if (Array.isArray(content) && content.length === 0) return;

      console.log(`[AgentSession] sendMessage: targetSessionId=${targetSessionId}, source=${sessionId ? 'explicit' : 'state'}`);
      try {
        // Send via REST API (more reliable than WebSocket for important actions)
        const trimmed = typeof content === "string" ? content.trim() : content;
        await sendMessageToSession(targetSessionId, trimmed);
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : "Failed to send message";
        console.error("[AgentSession] Failed to send message:", errorMsg);

        // If 404, the session is gone — invalidate cache and clear state for auto-recovery
        if (errorMsg.includes("[404]")) {
          if (projectId) {
            sessionCache.delete(getCacheKey(projectId, branch, explicitSessionId));
            if (session?.id) sessionCache.delete(getCacheKey(projectId, branch, session.id));
          }
          setSession(null);
          setStatus("stopped");
          setIsInitialized(false);
          shouldAutoStartRef.current = true;
        }

        setError(errorMsg);
        toast.error("Failed to send message", { description: errorMsg });
      }
    },
    [session?.id, projectId, branch, explicitSessionId]
  );

  const uploadPaste = useCallback(
    async (content: string, sessionId?: string): Promise<UploadedPaste> => {
      const targetSessionId = sessionId || session?.id;
      if (!targetSessionId) {
        throw new Error("No session id available for paste upload");
      }
      return uploadPasteToSession(targetSessionId, content);
    },
    [session?.id]
  );

  // Stop session - sends stop signal to the running agent process
  const stopSession = useCallback(async () => {
    if (!session?.id) return;
    try {
      await stopSessionApi(session.id);
      // Status update will come via WebSocket patches
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to stop session";
      console.error("[AgentSession] Failed to stop session:", e);
      toast.error("Failed to stop session");
    }
  }, [session?.id]);

  /**
   * Restart the current session, optionally switching to a different agent type.
   *
   * NOTE: In the multi-session-per-workspace world this is NOT the general
   * "new conversation" path — use `startNewConversation` for that, which creates
   * a new sessionId so the old conversation survives as history.
   *
   * This is now narrowed to the agent-type dropdown: it keeps the same
   * sessionId but stops the existing process, clears its entries, and respawns
   * under the new agent type. DESTRUCTIVE — wipes the conversation. The agent
   * switcher no longer uses this; it calls switchAgentType, which preserves
   * history. Kept for programmatic full-reset use cases.
   */
  const restartSession = useCallback(async (agentType?: AgentType) => {
    if (!session?.id) return;

    // Invalidate cache — session will get new state after restart
    if (projectId) {
      sessionCache.delete(getCacheKey(projectId, branch, explicitSessionId));
      sessionCache.delete(getCacheKey(projectId, branch, session.id));
    }

    setIsLoading(true);
    setError(null);

    try {
      await restartSessionApi(session.id, agentType);
      // Update local session state with new agent type
      if (agentType) {
        setSession((prev) => prev ? { ...prev, agentType } : null);
      }
      // The WebSocket will receive the clearAll patch and status update
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to restart session";
      setError(errorMsg);
      console.error("[AgentSession] Failed to restart session:", e);
    } finally {
      setIsLoading(false);
    }
  }, [session?.id, projectId, branch, explicitSessionId]);

  // Switch coding agent (preserves conversation history — the session goes
  // dormant server-side and the next message wakes it under the new agent
  // with a full context replay). Returns null on success, an error message
  // on failure (e.g. 409 while a turn is running).
  const switchAgentType = useCallback(async (agentType: AgentType): Promise<string | null> => {
    if (!session?.id) return "No active session";

    setError(null);

    try {
      await switchAgentTypeApi(session.id, agentType);
      // Update session locally and cache — history is preserved. The server
      // clears the model on an agent switch (a model name is agent-specific,
      // e.g. "opus" is meaningless to Codex), so mirror that here too.
      setSession((prev) => {
        if (!prev) return prev;
        const updated = { ...prev, agentType, model: null };
        if (projectId) {
          updateCachedSessionMetadata(projectId, branch, explicitSessionId, updated);
        }
        return updated;
      });
      return null;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to switch agent";
      console.error("[AgentSession] Failed to switch agent:", e);
      return errorMsg;
    }
  }, [session?.id, projectId, branch, explicitSessionId]);

  // Change the model of the existing session. The server applies it to the
  // next process the session spawns (retiring an idle one if there is any), so
  // history is preserved. Returns null on success, an error message on failure
  // (e.g. 409 while a turn is running).
  const setModel = useCallback(async (model: string | null): Promise<string | null> => {
    const targetSessionId = session?.id;
    if (!targetSessionId) return "No active session";

    setError(null);

    // One request at a time, in the order the user picked. Firing them
    // concurrently would let the server apply them in either order and let an
    // older reply land last, so the chip could settle on a model the user
    // replaced. A failed change still releases the queue.
    const run = modelChangeChain.current.then(() => setModelApi(targetSessionId, model));
    modelChangeChain.current = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      const stored = await run;
      setSession((prev) => {
        // The reply belongs to the session it was sent for. While it was in
        // flight the user may have switched workspace or conversation, and
        // writing here would stamp one session's model onto another — and
        // cache it under the keys this closure captured, which by then name a
        // different workspace.
        if (!prev || prev.id !== targetSessionId) return prev;
        const updated = { ...prev, model: stored };
        if (projectId) {
          updateCachedSessionMetadata(projectId, branch, explicitSessionId, updated);
        }
        return updated;
      });
      return null;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to set model";
      console.error("[AgentSession] Failed to set model:", e);
      return errorMsg;
    }
  }, [session?.id, projectId, branch, explicitSessionId]);

  // Switch permission mode (preserves conversation history)
  const switchMode = useCallback(async (mode: "plan" | "edit") => {
    if (!session?.id) return;

    setError(null);

    try {
      await switchModeApi(session.id, mode);
      // Update session locally and cache - history is preserved, new messages come via WebSocket
      setSession((prev) => {
        if (!prev) return prev;
        const updated = { ...prev, permissionMode: mode };
        if (projectId) {
          updateCachedSessionMetadata(projectId, branch, explicitSessionId, updated);
        }
        return updated;
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to switch mode";
      setError(errorMsg);
      console.error("[AgentSession] Failed to switch mode:", e);
    }
  }, [session?.id, projectId, branch, explicitSessionId]);

  // Accept plan and restart in edit mode
  const acceptPlan = useCallback(async (planContent: string) => {
    if (!session?.id) return;

    setError(null);

    try {
      await acceptPlanApi(session.id, planContent);
      // Update session locally and cache - mode switches to edit
      setSession((prev) => {
        if (!prev) return prev;
        const updated = { ...prev, permissionMode: "edit" as const };
        if (projectId) {
          updateCachedSessionMetadata(projectId, branch, explicitSessionId, updated);
        }
        return updated;
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to accept plan";
      setError(errorMsg);
      console.error("[AgentSession] Failed to accept plan:", e);
    }
  }, [session?.id, projectId, branch, explicitSessionId]);

  // Reset to an empty conversation placeholder. It does NOT stop the prior
  // resident process and does NOT create a new session in the database — that
  // happens on first user message via ensureSession(). Returns null because
  // there's no sessionId to surface yet.
  const startNewConversation = useCallback(async (): Promise<null> => {
    if (!projectId) return null;
    if (session?.id) sessionCache.delete(getCacheKey(projectId, branch, session.id));
    sessionCache.delete(getCacheKey(projectId, branch, explicitSessionId));
    // Tear down the old session's WebSocket and any pending reconnect timer
    // before clearing UI state. Otherwise the subscribe-replay path can
    // re-populate `messages` with the prior session's history (now ending
    // with "Session stopped by user.") while `session` stays null — leaving
    // a "New Session" header above a fully restored old conversation.
    if (wsRef.current) {
      wsRef.current.close(1000, "new-conversation");
      wsRef.current = null;
      wsSessionIdRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (stabilityTimeoutRef.current) {
      clearTimeout(stabilityTimeoutRef.current);
      stabilityTimeoutRef.current = null;
    }
    finishedRef.current = false;
    isReplayingRef.current = false;
    setIsConnected(false);
    // Clear local UI state to the empty placeholder.
    setSession(null);
    setStatus("stopped");
    setIsInitialized(true);
    setError(null);
    setRemoteStatus(null);
    setMessages([]);
    containerRef.current = { entries: {}, status: "stopped" };
    historyRef.current = null;
    setHasEarlierHistory(false);
    // Mark this workspace as "in placeholder mode" so auto-start skips it,
    // and so switching away and back (or refreshing) preserves the empty
    // placeholder. Cleared when the user picks a session from history or
    // sends the first message.
    addPlaceholder(workspaceKey(projectId, branch, agentMode));
    return null;
  }, [projectId, branch, agentMode, session?.id, explicitSessionId]);

  // Pending resident-limit eviction question, lifted out of ensureSession so
  // the component layer can render a styled confirm dialog instead of
  // window.confirm. `resolve` is the suspended ensureSession continuation:
  // resolve(true) evicts the least recently active session and retries,
  // resolve(false) aborts the send. Mirrored into a ref so the workspace-reset
  // effect and unmount cleanup can cancel it without listing it as a dep.
  interface ResidentLimitPromptState {
    maxResidentAgentProcesses: number;
    runningSessions: RunningResidentSession[];
    resolve: (evict: boolean) => void;
  }
  const [residentLimitPrompt, setResidentLimitPrompt] =
    useState<ResidentLimitPromptState | null>(null);
  const residentLimitPromptRef = useRef<ResidentLimitPromptState | null>(null);

  // Resume a suspended ensureSession with "No" — called on workspace switch
  // and unmount so an unanswered dialog can never strand its caller.
  const cancelResidentLimitPrompt = useCallback(() => {
    residentLimitPromptRef.current?.resolve(false);
    residentLimitPromptRef.current = null;
    setResidentLimitPrompt(null);
  }, []);

  // Single-flight guard for ensureSession: first-sends can race (imperative
  // submitMessage from page.tsx vs the form submit), and two concurrent
  // creates hitting the resident limit would each open an eviction prompt —
  // the second overwriting the first's resolver and stranding that caller.
  // Concurrent callers of the same workspace generation *and* model share one
  // promise; a different model must not be collapsed into an in-flight call
  // for another model. Keyed by `${generation}:${modelKey}` in a Map (not a
  // single-slot ref) so two different-model calls racing in the same
  // generation each get their own in-flight entry instead of the second's
  // assignment clobbering the first's — which would otherwise let a third,
  // same-model-as-first call slip past the guard and fire a duplicate create.
  const ensureSessionInFlightRef = useRef<Map<string, Promise<AgentSession | null>>>(new Map());

  // Create a real session on demand (called by submitMessage on first send).
  // POSTs to /api/projects/:projectId/agent-sessions/new and wires up WS.
  // If a session already exists, returns it unchanged.
  const ensureSession = useCallback((
    permissionMode?: "plan" | "edit",
    model?: string | null,
  ): Promise<AgentSession | null> => {
    if (!projectId) return Promise.resolve(null);
    if (session) return Promise.resolve(session);

    // Capture generation at call time to detect a workspace switch happening
    // under any of the awaits below (same pattern as startSession).
    const generation = sessionGenerationRef.current;
    const modelKey = model ?? null;
    const inFlightKey = `${generation}:${modelKey}`;
    const inFlight = ensureSessionInFlightRef.current.get(inFlightKey);
    if (inFlight) return inFlight;

    const run = async (): Promise<AgentSession | null> => {
      setIsLoading(true);
      setError(null);
      try {
        let data: Awaited<ReturnType<typeof createNewAgentSession>>;
        try {
          data = await createNewAgentSession(projectId, branch, permissionMode, agentType, undefined, model);
        } catch (error) {
          if (!(error instanceof ResidentLimitError)) throw error;
          // Suspend until the user answers the eviction dialog rendered by
          // the consuming component (see residentLimitPrompt above).
          let resolvePrompt!: (evict: boolean) => void;
          const answer = new Promise<boolean>((resolve) => {
            resolvePrompt = resolve;
          });
          const prompt: ResidentLimitPromptState = {
            maxResidentAgentProcesses: error.maxResidentAgentProcesses,
            runningSessions: error.runningSessions,
            resolve: resolvePrompt,
          };
          residentLimitPromptRef.current = prompt;
          setResidentLimitPrompt(prompt);
          const confirmed = await answer;
          // Clear only if still ours — a cancel + newer prompt may have
          // replaced it while this continuation waited its turn.
          if (residentLimitPromptRef.current === prompt) {
            residentLimitPromptRef.current = null;
          }
          setResidentLimitPrompt((cur) => (cur === prompt ? null : cur));
          // Workspace switched while the dialog was up (the reset effect
          // cancels it) — abort silently, don't force-create for the old one.
          if (sessionGenerationRef.current !== generation) return null;
          if (!confirmed) throw error;
          data = await createNewAgentSession(projectId, branch, permissionMode, agentType, true, model);
        }
        // If workspace changed while a create call was in flight, discard the
        // result rather than writing the old workspace's session into the new
        // one's UI state.
        if (sessionGenerationRef.current !== generation) {
          console.log("[AgentSession] Discarding stale ensureSession result (generation mismatch)");
          return null;
        }
        const newSession: AgentSession = {
          id: data.session.id,
          projectId: data.session.projectId,
          branch: data.session.branch,
          status: data.session.status as AgentSessionStatus,
          permissionMode: (data.session.permissionMode ?? "edit") as "plan" | "edit",
          agentType: (data.session.agentType ?? "claude-code") as AgentType,
          model: data.session.model ?? null,
          processAlive: data.session.processAlive ?? true,
        };
        const history = emptyHistory(newSession);
        cacheSessionSnapshot(projectId, branch, explicitSessionId, newSession, history);
        setSession(newSession);
        sessionRef.current = newSession;
        historyRef.current = history;
        setStatus(newSession.status);
        setIsInitialized(true);
        // No longer in placeholder mode — a real session exists now.
        removePlaceholder(workspaceKey(projectId, branch, agentMode));
        connectWebSocket(newSession.id);
        onSessionStartedRef.current?.(newSession);
        return newSession;
      } catch (e) {
        console.error("[AgentSession] ensureSession:", e);
        // Don't surface the error into a workspace that has moved on.
        if (sessionGenerationRef.current !== generation) return null;
        setError(e instanceof Error ? e.message : "Failed to create session");
        return null;
      } finally {
        // Clear only our own entry — a newer-generation call, or a
        // different-model call for the same generation, has its own map key
        // and is never touched by this. The identity check guards against
        // deleting a later call's entry for the same key (defense in depth;
        // shouldn't be reachable since a second call for the same key would
        // have joined via `inFlight` above instead of reaching this point).
        if (ensureSessionInFlightRef.current.get(inFlightKey) === promise) {
          ensureSessionInFlightRef.current.delete(inFlightKey);
        }
        // Only clear loading if this is still the current generation
        if (sessionGenerationRef.current === generation) {
          setIsLoading(false);
        }
      }
    };

    const promise = run();
    ensureSessionInFlightRef.current.set(inFlightKey, promise);
    return promise;
  }, [projectId, branch, agentMode, agentType, session, explicitSessionId, connectWebSocket]);

  const loadEarlierHistory = useCallback(async (): Promise<void> => {
    const currentSession = sessionRef.current;
    const currentHistory = historyRef.current;
    if (!currentSession || !currentHistory?.hasMore || currentHistory.previousCursor === null || isLoadingEarlier) return;
    setIsLoadingEarlier(true);
    try {
      const older = await getHistoryWindow(currentSession.id, currentHistory.previousCursor);
      if (sessionRef.current?.id !== currentSession.id) return;
      if (older.historyEpoch !== currentHistory.historyEpoch) {
        historyRef.current = older;
        containerRef.current = { entries: entriesRecord(older.entries), status: older.status };
      } else {
        const merged = new Map<number, AgentMessage>();
        for (const entry of older.entries) merged.set(entry.entryIndex, entry.message);
        for (const entry of denseEntries(containerRef.current)) merged.set(entry.entryIndex, entry.message);
        const entries = [...merged].sort((a, b) => a[0] - b[0])
          .map(([entryIndex, message]) => ({ entryIndex, message }));
        historyRef.current = {
          ...currentHistory,
          entries,
          previousCursor: older.previousCursor,
          hasMore: older.hasMore,
        };
        containerRef.current = { entries: entriesRecord(entries), status: containerRef.current.status };
      }
      const nextHistory = historyRef.current!;
      setMessages(nextHistory.entries.map((entry) => entry.message));
      setHasEarlierHistory(nextHistory.hasMore);
      if (projectId) cacheSessionSnapshot(projectId, branch, explicitSessionId, currentSession, nextHistory);
    } catch (e) {
      toast.error("Failed to load earlier conversation", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setIsLoadingEarlier(false);
    }
  }, [projectId, branch, explicitSessionId, isLoadingEarlier]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        finishedRef.current = true; // Prevent reconnect on unmount
        wsRef.current.close();
        wsSessionIdRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (stabilityTimeoutRef.current) {
        clearTimeout(stabilityTimeoutRef.current);
      }
      clearSilenceTimer();
      // Invalidate in-flight creates and answer any open eviction dialog with
      // "No" so a suspended ensureSession caller doesn't hang forever.
      sessionGenerationRef.current += 1;
      cancelResidentLimitPrompt();
      // The cache belongs to this conversation UI lifetime. Clearing it on
      // unmount avoids retaining transcripts after the user leaves the page
      // (and prevents a later mount from inheriting another user's snapshot).
      sessionCache.clear();
    };
  }, [cancelResidentLimitPrompt, clearSilenceTimer]);

  // Read the warm snapshot for a workspace identity and apply it as a cache
  // preview. Returns false on a cache miss. For a running session, only its
  // sealed prefix is safe to preview; the mutable tail is fetched again before
  // it is shown. Shared by the workspace-reset effect and the suspension-lift
  // effect below it.
  const applyWarmPreview = useCallback((
    projectId: string,
    branch: string | null,
    explicitSessionId: string | null | undefined,
  ): boolean => {
    const warmSnapshot = readSessionCache(getCacheKey(projectId, branch, explicitSessionId))
      ?? (explicitSessionId ? undefined : readLatestWorkspaceSnapshot(projectId, branch));
    if (!warmSnapshot) return false;
    const sealedThrough = warmSnapshot.history.lastTurnEndEntryIndex ?? null;
    const previewEntries = warmSnapshot.session.status === "running"
      ? warmSnapshot.history.entries.filter(
          (entry) => sealedThrough !== null && entry.entryIndex <= sealedThrough,
        )
      : warmSnapshot.history.entries;
    const previewHistory = {
      ...warmSnapshot.history,
      entries: previewEntries,
      latestEntryIndex: previewEntries.at(-1)?.entryIndex ?? null,
    };
    setSession(warmSnapshot.session);
    sessionRef.current = warmSnapshot.session;
    setStatus(warmSnapshot.session.status);
    setIsInitialized(true);
    setIsCachePreview(true);
    cachePreviewRef.current = true;
    setMessages(previewEntries.map((entry) => entry.message));
    containerRef.current = {
      entries: entriesRecord(previewEntries),
      status: warmSnapshot.session.status,
    };
    historyRef.current = previewHistory;
    setHasEarlierHistory(previewHistory.hasMore ?? false);
    return true;
  }, []);

  // Reset session when projectId or branch changes
  useEffect(() => {
    // Close existing WebSocket with code 1000 to prevent onclose reconnect handler
    // (onclose fires asynchronously, after finishedRef is reset to false below)
    if (wsRef.current) {
      wsRef.current.close(1000, "branch-switch");
      wsRef.current = null;
      wsSessionIdRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (stabilityTimeoutRef.current) {
      clearTimeout(stabilityTimeoutRef.current);
      stabilityTimeoutRef.current = null;
    }
    clearSilenceTimer();

    // Increment generation to invalidate any in-flight startSession /
    // ensureSession API calls
    sessionGenerationRef.current += 1;

    // A resident-limit eviction dialog opened for the previous workspace must
    // not survive the switch: answer it "No" so its suspended ensureSession
    // resumes (and discards itself via the generation bump above).
    cancelResidentLimitPrompt();

    // Per-workspace placeholder intent. Skip auto-start and mark initialized
    // so the empty-state UI shows instead of a spinner. If the user picks an
    // explicit session for this workspace, drop the placeholder intent.
    const currentWorkspaceKey = projectId
      ? workspaceKey(projectId, branch, agentMode)
      : null;
    if (currentWorkspaceKey && explicitSessionId) {
      removePlaceholder(currentWorkspaceKey);
    }
    const stayingInPlaceholder =
      !explicitSessionId && currentWorkspaceKey !== null
      && hasPlaceholder(currentWorkspaceKey);

    // Restore a warm target snapshot synchronously so switching does not blank
    // the conversation while the lightweight head check runs.
    //
    // Never preview while suspended: mid-cross-project-jump this effect fires
    // with (branch=null, sessionId=null), whose cache key aliases the target
    // project's default-workspace latest session — previewing it flashes main's
    // conversation before the real target lands (the same flash the suspended
    // gate on auto-start exists to prevent). Once the staged branch+session
    // apply, this effect re-runs with the real key — except when the target
    // identity IS (branch=null, sessionId=null); the suspension-lift effect
    // below restores the preview for that case.
    const previewed = !stayingInPlaceholder && projectId && !suspendedRef.current
      ? applyWarmPreview(projectId, branch, explicitSessionId)
      : false;
    if (!previewed) {
      setSession(null);
      sessionRef.current = null;
      setStatus("stopped");
      setIsInitialized(stayingInPlaceholder);
      setIsCachePreview(false);
      cachePreviewRef.current = false;
      setMessages([]);
      containerRef.current = { entries: entriesRecord([]), status: "stopped" };
      historyRef.current = null;
      setHasEarlierHistory(false);
    }
    setIsConnected(false);
    setError(null);
    setIsLoading(false);
    setRemoteStatus(null);
    finishedRef.current = false;
    reconnectAttemptRef.current = 0;
    connectionStartTimeRef.current = null;
    shortLivedConnectionsRef.current = 0;
    lastStartFailedRef.current = false;
    startingRef.current = false;

    // Auto-start the session unless the user explicitly asked for an empty
    // placeholder via New Conversation.
    shouldAutoStartRef.current = !stayingInPlaceholder;
    // Keep other workspaces' snapshots warm. Their WebSockets will reconcile
    // anything that changed while they were not selected.
    // Note: agentType is intentionally NOT in this dependency array.
    // Agent type changes are handled by restartSession() which keeps the WebSocket
    // connected so it can receive the clearAll patch and new messages from the backend.
    // Including agentType here would close the WebSocket and race with restartSession.
  }, [projectId, branch, agentMode, explicitSessionId, applyWarmPreview, cancelResidentLimitPrompt, clearSilenceTimer]);

  // A jump whose TARGET identity equals the mid-navigation identity — a cross-
  // project jump to the root workspace, (branch=null, sessionId=null) — never
  // re-runs the reset effect when the staged selection lands: no dep changes,
  // only `suspended` flips. The reset above ran suspended and skipped the
  // preview, so restore it here. Declared before the auto-start effect so
  // startSession sees cachePreviewRef and keeps the preview visible while it
  // revalidates. On non-degenerate lifts this re-runs after the reset effect
  // and no-ops (preview applied → cachePreviewRef set; miss → misses again).
  useEffect(() => {
    if (suspended || !projectId) return;
    if (!shouldAutoStartRef.current || cachePreviewRef.current || sessionRef.current) return;
    if (hasPlaceholder(workspaceKey(projectId, branch, agentMode))) return;
    applyWarmPreview(projectId, branch, explicitSessionId);
  }, [suspended, projectId, branch, agentMode, explicitSessionId, applyWarmPreview]);

  // Auto-start session after mount or worktree switch
  useEffect(() => {
    // Mid-navigation: (branch, sessionId) aren't final — starting now would load
    // the default branch's latest session and flash it before the real target.
    // shouldAutoStartRef stays true, so we start once suspension lifts.
    if (suspended) return;
    const inPlaceholder =
      projectId !== null
      && hasPlaceholder(workspaceKey(projectId, branch, agentMode));
    if (shouldAutoStartRef.current && projectId && (!session || cachePreviewRef.current) && !isLoading && !lastStartFailedRef.current && !inPlaceholder) {
      shouldAutoStartRef.current = false;
      console.log(`[AgentSession] Auto-start: projectId=${projectId}, branch=${branch}, agentMode=${agentMode}`);
      startSession();
    }
  }, [projectId, branch, agentMode, session, isLoading, startSession, suspended]);

  // Reconnect when tab becomes visible again (browser may suspend timers when backgrounded)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && session?.id && !finishedRef.current) {
        const ws = wsRef.current;
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          console.log("[AgentSession] Tab visible, WebSocket disconnected - reconnecting");
          reconnectAttemptRef.current = 0;
          shortLivedConnectionsRef.current = 0;
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
          connectWebSocket(session.id);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [session?.id, connectWebSocket]);

  // Connect WebSocket when session ID becomes available (initial connection only).
  // Reconnection after disconnect is handled by onclose with exponential backoff.
  useEffect(() => {
    if (session?.id && !finishedRef.current) {
      connectWebSocket(session.id);
    }
  }, [session?.id, connectWebSocket]);

  return {
    session,
    messages,
    status,
    isConnected,
    isInitialized,
    isLoading,
    isCachePreview,
    error,
    remoteStatus,
    workflowRunUpdate,
    messageEntryIndices: denseEntries(containerRef.current).map((entry) => entry.entryIndex),
    hasEarlierHistory,
    isLoadingEarlier,
    loadEarlierHistory,
    startSession,
    sendMessage,
    uploadPaste,
    stopSession,
    restartSession,
    switchAgentType,
    setModel,
    startNewConversation,
    ensureSession,
    switchMode,
    acceptPlan,
    residentLimitPrompt,
  };
}
