"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { produce } from "immer";
import { toast } from "sonner";
import { getWebSocketUrl, getAuthToken, createNewAgentSession } from "@/lib/api";
import type { AgentType } from "@/lib/api";

// ============ Content Part Types (for image attachments) ============

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; mediaType: string; data: string }; // base64
export type ContentPart = TextPart | ImagePart;

// ============ Types ============

export type AgentMessage =
  | { type: "user"; content: string | ContentPart[]; timestamp: number }
  | { type: "assistant"; content: string; partial?: boolean; timestamp: number }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string; timestamp: number }
  | { type: "tool_result"; tool: string; output: string; toolUseId?: string; timestamp: number }
  | { type: "thinking"; content: string; timestamp: number }
  | { type: "error"; message: string; timestamp: number }
  | { type: "system"; content: string; timestamp: number }
  | { type: "approval_request"; requestType: "command" | "fileChange"; requestId: string; command?: string; cwd?: string; changes?: Array<{path: string; diff?: string; kind: string}>; timestamp: number };

export type AgentSessionStatus = "running" | "stopped" | "error";

export interface AgentSession {
  id: string;
  projectId: string;
  branch: string | null;
  status: AgentSessionStatus;
  permissionMode?: "plan" | "edit";
  agentType?: AgentType;
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
  | { Ready: true }
  | { finished: true }
  | { error: string }
  | { taskCompleted: { duration_ms?: number; cost_usd?: number; input_tokens?: number; output_tokens?: number } }
  | { remoteStatus: RemoteConnectionStatus; attempt?: number };

// Container for patch target
interface PatchContainer {
  entries: AgentMessage[];
  status: AgentSessionStatus;
}

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

function getAuthHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function createOrGetSession(
  projectId: string,
  branch: string | null,
  permissionMode?: "plan" | "edit",
  agentType?: AgentType
): Promise<{ session: AgentSession; messages: AgentMessage[] }> {
  const response = await fetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions`, {
    method: "POST",
    headers: getAuthHeaders("application/json"),
    body: JSON.stringify({ branch, permissionMode, agentType }),
  });

  if (!response.ok) {
    throw new Error("Failed to create session");
  }

  return response.json();
}

async function sendMessageToSession(sessionId: string, content: string | ContentPart[]): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/message`, {
    method: "POST",
    headers: getAuthHeaders("application/json"),
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
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/paste`, {
    method: "POST",
    headers: getAuthHeaders("application/json"),
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      if (body.error) detail = ` — ${body.error}`;
    } catch {
      // ignore parse errors
    }
    throw new Error(`Failed to upload paste [${response.status}]${detail}`);
  }

  return response.json();
}

async function restartSessionApi(sessionId: string, agentType?: AgentType): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/restart`, {
    method: "POST",
    headers: getAuthHeaders("application/json"),
    body: JSON.stringify({ agentType }),
  });

  if (!response.ok) {
    throw new Error("Failed to restart session");
  }
}

async function stopSessionApi(sessionId: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/stop`, {
    method: "POST",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error("Failed to stop session");
  }
}

async function switchModeApi(sessionId: string, mode: "plan" | "edit"): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/switch-mode`, {
    method: "POST",
    headers: getAuthHeaders("application/json"),
    body: JSON.stringify({ mode }),
  });

  if (!response.ok) {
    throw new Error("Failed to switch mode");
  }
}

async function acceptPlanApi(sessionId: string, planContent: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/accept-plan`, {
    method: "POST",
    headers: getAuthHeaders("application/json"),
    body: JSON.stringify({ planContent }),
  });

  if (!response.ok) {
    throw new Error("Failed to accept plan");
  }
}

// ============ Session Cache ============
// Module-level cache: avoids 14s remote proxy call when switching back to a previously visited workspace.
// Key: "projectId:branch:sessionId" (sessionId = "latest" when caller hasn't specified an explicit id),
// Value: session object from last successful REST response.
const sessionCache = new Map<string, AgentSession>();

function getCacheKey(projectId: string, branch: string | null, sessionId?: string | null): string {
  return `${projectId}:${branch ?? ""}:${sessionId ?? "latest"}`;
}

async function getSessionById(sessionId: string): Promise<{ session: AgentSession; messages: AgentMessage[] }> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Session ${sessionId} not found`);
  }
  return response.json();
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
          draft.entries = [];
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
            while (draft.entries.length <= index) {
              draft.entries.push(null as unknown as AgentMessage);
            }
            draft.entries[index] = value.content;
            break;

          case "replace":
            if (index < draft.entries.length) {
              draft.entries[index] = value.content;
            } else {
              console.warn(`[JsonPatch] Replace index out of bounds: ${index}`);
            }
            break;

          case "remove":
            if (index < draft.entries.length) {
              // Mark as removed (filter later if needed)
              draft.entries.splice(index, 1);
            }
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
  onTaskCompleted?: () => void;
  onSessionStarted?: () => void;
}

export function useAgentSession(projectId: string | null, branch: string | null, agentMode?: string, agentType?: AgentType, options?: UseAgentSessionOptions) {
  const explicitSessionId = options?.sessionId ?? null;
  const [session, setSession] = useState<AgentSession | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<AgentSessionStatus>("stopped");
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteConnectionStatus | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const wsSessionIdRef = useRef<string | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const containerRef = useRef<PatchContainer>({ entries: [], status: "stopped" });
  const finishedRef = useRef(false);
  const shouldAutoStartRef = useRef(true); // Auto-start on mount and worktree switch
  const connectionStartTimeRef = useRef<number | null>(null);
  const stabilityTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shortLivedConnectionsRef = useRef(0);
  const isReplayingRef = useRef(false); // True during history replay (before Ready signal)
  const sessionGenerationRef = useRef(0); // Incremented on branch/project change to discard stale API responses
  const lastStartFailedRef = useRef(false); // Prevents auto-restart loop after session creation failure
  const startingRef = useRef(false); // Reentrancy guard for startSession
  const onTaskCompletedRef = useRef(options?.onTaskCompleted);
  const onSessionStartedRef = useRef(options?.onSessionStarted);
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
    projectIdRef.current = projectId;
    branchRef.current = branch;
    explicitSessionIdRef.current = explicitSessionId;
  });

  // WebSocket reconnection constants
  const MIN_STABLE_CONNECTION_MS = 5000;  // Connection must be stable for 5s before resetting backoff
  const MAX_RECONNECT_DELAY_MS = 30000;   // Maximum reconnect delay (30s)
  const MAX_RECONNECT_ATTEMPTS = 10;      // Stop trying after this many attempts
  const MAX_SHORT_LIVED_CONNECTIONS = 3;  // After 3 short connections, assume session is invalid

  // Calculate reconnect delay with jitter
  const getReconnectDelay = (attempt: number): number => {
    const baseDelay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * Math.pow(2, attempt));
    const jitter = baseDelay * Math.random() * 0.25;  // 0-25% jitter
    return baseDelay + jitter;
  };

  // Connect WebSocket to session
  const connectWebSocket = useCallback((sessionId: string) => {
    // Helper: invalidate cache entries for the current workspace context.
    // Reads identity from refs because connectWebSocket has [] deps and would
    // otherwise close over stale projectId/branch/explicitSessionId values.
    const invalidateSessionCache = () => {
      const pid = projectIdRef.current;
      if (!pid) return;
      const br = branchRef.current;
      sessionCache.delete(getCacheKey(pid, br, explicitSessionIdRef.current));
      const sid = wsSessionIdRef.current;
      if (sid) sessionCache.delete(getCacheKey(pid, br, sid));
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
    if (containerRef.current.entries.filter(Boolean).length === 0) {
      containerRef.current = { entries: [], status: "running" };
    }
    finishedRef.current = false;
    isReplayingRef.current = true; // Buffer patches until Ready signal

    const wsUrl = getWebSocketUrl(`/api/agent-sessions/${sessionId}/stream`);
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
      try {
        const msg = JSON.parse(event.data) as AgentWsMessage;

        // Handle JsonPatch messages
        if ("JsonPatch" in msg) {
          const patch = msg.JsonPatch;

          // Apply patch to container (always)
          containerRef.current = applyPatch(containerRef.current, patch);

          // During replay, skip React state updates to avoid scroll jump
          if (!isReplayingRef.current) {
            setMessages([...containerRef.current.entries.filter(Boolean)]);
            console.log("[AgentSession] setStatus(live) →", containerRef.current.status);
            setStatus(containerRef.current.status);

            // Invalidate cache when session becomes stopped/error so next startSession does a fresh REST call
            if (containerRef.current.status === "stopped" || containerRef.current.status === "error") {
              invalidateSessionCache();
            }
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
          setMessages([...containerRef.current.entries.filter(Boolean)]);
          setStatus(containerRef.current.status);
          setIsInitialized(true);
          return;
        }

        // Handle finished signal - don't reconnect, invalidate cache so next startSession does a fresh REST call
        if ("finished" in msg) {
          console.log("[AgentSession] Received finished signal, invalidating cache");
          finishedRef.current = true;
          invalidateSessionCache();
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
          connectWebSocket(currentSessionId);
        }
      }, delay);
    };

    ws.onerror = (error) => {
      console.error("[AgentSession] WebSocket error:", error);
    };
  }, []);

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
    setIsInitialized(false);
    lastStartFailedRef.current = false;

    // Try cached session first — skip the slow REST call if we already know the session ID
    const cacheKey = getCacheKey(projectId, branch, explicitSessionId);
    const cached = sessionCache.get(cacheKey);
    if (cached) {
      console.log(`[AgentSession] Cache hit for ${cacheKey}, reconnecting WebSocket directly`);
      setSession(cached);
      setStatus(cached.status);
      connectWebSocket(cached.id);
      onSessionStartedRef.current?.();
      startingRef.current = false;
      return cached;
    }

    // Cache miss — need the slow REST call
    setIsLoading(true);

    try {
      console.log(`[AgentSession] Starting REST call: projectId=${projectId}, branch=${branch}, sessionId=${explicitSessionId ?? "latest"}, agentType=${agentType}, generation=${generation}`);
      const { session: newSession, messages: initialMessages } = explicitSessionId
        ? await getSessionById(explicitSessionId)
        : await createOrGetSession(projectId, branch, permissionMode, agentType);

      console.log(`[AgentSession] REST response: sessionId=${newSession.id}, msgCount=${initialMessages?.length ?? 0}, status=${newSession.status}, explicitSessionIdRequested=${explicitSessionId ?? "<null>"}`);

      // If branch/project changed while the API call was in flight, discard the result
      if (sessionGenerationRef.current !== generation) {
        console.log("[AgentSession] Discarding stale session response (generation mismatch)");
        return null;
      }

      // Cache the session for future workspace switches (cache under both the explicit id key and the latest key)
      sessionCache.set(cacheKey, newSession);
      if (explicitSessionId) {
        sessionCache.set(getCacheKey(projectId, branch, newSession.id), newSession);
      }

      setSession(newSession);
      setStatus(newSession.status);

      // Pre-populate messages from REST response for immediate display
      // (WebSocket replay will update containerRef in the background and flush on Ready)
      if (initialMessages && initialMessages.length > 0) {
        setMessages(initialMessages);
        containerRef.current = { entries: [...initialMessages], status: newSession.status };
      }

      // Connect WebSocket - it will receive history via patches
      connectWebSocket(newSession.id);

      // Notify caller that session has started (e.g. to refetch workspace statuses)
      onSessionStartedRef.current?.();

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
   * under the new agent type. Called from `agent-conversation.tsx` when the
   * user switches between Claude Code and Codex on a session that has not yet
   * received any messages (the dropdown is disabled otherwise).
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
          sessionCache.set(getCacheKey(projectId, branch, explicitSessionId), updated);
          sessionCache.set(getCacheKey(projectId, branch, updated.id), updated);
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
          sessionCache.set(getCacheKey(projectId, branch, explicitSessionId), updated);
          sessionCache.set(getCacheKey(projectId, branch, updated.id), updated);
        }
        return updated;
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to accept plan";
      setError(errorMsg);
      console.error("[AgentSession] Failed to accept plan:", e);
    }
  }, [session?.id, projectId, branch, explicitSessionId]);

  // Start a brand-new conversation: stops the current (if running) and creates a fresh session
  // via POST /api/projects/:projectId/agent-sessions/new. Returns the new session id so the
  // caller can reflect it in the URL.
  const startNewConversation = useCallback(async (overrideAgentType?: AgentType): Promise<string | null> => {
    if (!projectId) return null;
    // Best-effort stop — we don't want to leave an orphan running in the background.
    // NOTE: don't guard on status === "running". Between turns, stream-json agents
    // report status="stopped" while the CLI process is still alive waiting on stdin
    // (see agent-session-manager.ts around the turn-finished branch). Stopping is
    // idempotent on the backend, so it's safe to call whenever we have an id.
    if (session?.id) {
      try {
        await stopSessionApi(session.id);
      } catch (e) {
        // Don't block creating the new session — but log so we notice if stops
        // systematically fail (e.g. remoteSessionMap miss after a server restart).
        console.warn("[AgentSession] startNewConversation: stop of prior session failed:", e);
      }
    }
    setIsLoading(true);
    setError(null);
    try {
      const data = await createNewAgentSession(
        projectId,
        branch,
        session?.permissionMode,
        overrideAgentType ?? session?.agentType ?? agentType
      );
      // Proactively clear UI so the stale old conversation doesn't render during the
      // one-frame gap between this return and the reset effect firing on sessionId
      // change. Mirrors the clears in the projectId/branch/agentMode/explicitSessionId
      // reset effect (minus isLoading, which the finally block handles).
      setSession(null);
      setStatus("stopped");
      setIsInitialized(false);
      setError(null);
      setRemoteStatus(null);
      setMessages([]);
      containerRef.current = { entries: [], status: "stopped" };
      return data.session.id;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to start new conversation";
      setError(errorMsg);
      console.error("[AgentSession] startNewConversation:", e);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [projectId, branch, session?.id, session?.status, session?.permissionMode, session?.agentType, agentType]);

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
    };
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

    // Increment generation to invalidate any in-flight startSession API calls
    sessionGenerationRef.current += 1;

    // Reset all state
    setSession(null);
    setStatus("stopped");
    setIsConnected(false);
    setIsInitialized(false);
    setError(null);
    setIsLoading(false);
    setRemoteStatus(null);
    setMessages([]); // Clear stale messages to prevent scroll jump on workspace switch
    containerRef.current = { entries: [], status: "stopped" };
    finishedRef.current = false;
    reconnectAttemptRef.current = 0;
    connectionStartTimeRef.current = null;
    shortLivedConnectionsRef.current = 0;
    lastStartFailedRef.current = false;
    startingRef.current = false;

    // Mark that we need to auto-start session after reset
    shouldAutoStartRef.current = true;
    // Invalidate session cache — branch or mode changed, cached session is stale
    if (projectId) sessionCache.delete(getCacheKey(projectId, branch, explicitSessionId));
    // Note: agentType is intentionally NOT in this dependency array.
    // Agent type changes are handled by restartSession() which keeps the WebSocket
    // connected so it can receive the clearAll patch and new messages from the backend.
    // Including agentType here would close the WebSocket and race with restartSession.
  }, [projectId, branch, agentMode, explicitSessionId]);

  // Auto-start session after mount or worktree switch
  useEffect(() => {
    if (shouldAutoStartRef.current && projectId && !session && !isLoading && !lastStartFailedRef.current) {
      shouldAutoStartRef.current = false;
      console.log(`[AgentSession] Auto-start: projectId=${projectId}, branch=${branch}, agentMode=${agentMode}`);
      startSession();
    }
  }, [projectId, session, isLoading, startSession]);

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
    error,
    remoteStatus,
    startSession,
    sendMessage,
    uploadPaste,
    stopSession,
    restartSession,
    startNewConversation,
    switchMode,
    acceptPlan,
  };
}
