"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { produce } from "immer";
import { toast } from "sonner";
import { getWebSocketUrl } from "@/lib/api";

// ============ Types ============

export type AgentMessage =
  | { type: "user"; content: string; timestamp: number }
  | { type: "assistant"; content: string; partial?: boolean; timestamp: number }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string; timestamp: number }
  | { type: "tool_result"; tool: string; output: string; toolUseId?: string; timestamp: number }
  | { type: "thinking"; content: string; timestamp: number }
  | { type: "error"; message: string; timestamp: number }
  | { type: "system"; content: string; timestamp: number };

export type AgentSessionStatus = "running" | "stopped" | "error";

export interface AgentSession {
  id: string;
  projectId: string;
  branch: string | null;
  status: AgentSessionStatus;
  permissionMode?: "plan" | "edit";
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
  | { taskCompleted: { duration_ms?: number; cost_usd?: number } }
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

async function createOrGetSession(
  projectId: string,
  branch: string | null,
  permissionMode?: "plan" | "edit"
): Promise<{ session: AgentSession; messages: AgentMessage[] }> {
  const response = await fetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, permissionMode }),
  });

  if (!response.ok) {
    throw new Error("Failed to create session");
  }

  return response.json();
}

async function sendMessageToSession(sessionId: string, content: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/message`, {
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
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(`Failed to send message${detail}`);
  }
}

async function restartSessionApi(sessionId: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/restart`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error("Failed to restart session");
  }
}

async function switchModeApi(sessionId: string, mode: "plan" | "edit"): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/switch-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });

  if (!response.ok) {
    throw new Error("Failed to switch mode");
  }
}

async function acceptPlanApi(sessionId: string, planContent: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/accept-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planContent }),
  });

  if (!response.ok) {
    throw new Error("Failed to accept plan");
  }
}

// ============ Session Cache ============
// Module-level cache: avoids 14s remote proxy call when switching back to a previously visited workspace.
// Key: "projectId:branch", Value: session object from last successful REST response.
const sessionCache = new Map<string, AgentSession>();

function getCacheKey(projectId: string, branch: string | null): string {
  return `${projectId}:${branch ?? ""}`;
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
  onTaskCompleted?: () => void;
  onSessionStarted?: () => void;
}

export function useAgentSession(projectId: string | null, branch: string | null, agentMode?: string, options?: UseAgentSessionOptions) {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<AgentSessionStatus>("stopped");
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteConnectionStatus | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
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
  const onTaskCompletedRef = useRef(options?.onTaskCompleted);
  const onSessionStartedRef = useRef(options?.onSessionStarted);

  // Keep callback refs in sync with latest options (avoids stale closures in WebSocket handler)
  useEffect(() => {
    onTaskCompletedRef.current = options?.onTaskCompleted;
    onSessionStartedRef.current = options?.onSessionStarted;
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
    // Prevent duplicate connections
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    // Reset state for new connection
    containerRef.current = { entries: [], status: "running" };
    finishedRef.current = false;
    isReplayingRef.current = true; // Buffer patches until Ready signal

    const wsUrl = getWebSocketUrl(`/api/agent-sessions/${sessionId}/stream`);
    console.log("[AgentSession] Connecting to WebSocket:", wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[AgentSession] WebSocket connected");
      setIsConnected(true);
      setError(null);

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
            setStatus(containerRef.current.status);
          }
          return;
        }

        // Handle Ready signal - history replay complete, flush state
        if ("Ready" in msg) {
          console.log("[AgentSession] Received Ready signal - history complete");
          isReplayingRef.current = false;
          // Flush accumulated state to React in a single update
          setMessages([...containerRef.current.entries.filter(Boolean)]);
          setStatus(containerRef.current.status);
          setIsInitialized(true);
          return;
        }

        // Handle finished signal - don't reconnect
        if ("finished" in msg) {
          console.log("[AgentSession] Received finished signal");
          finishedRef.current = true;
          ws.close(1000, "finished");
          return;
        }

        // Handle task completed - show toast
        if ("taskCompleted" in msg) {
          const { duration_ms, cost_usd } = msg.taskCompleted;
          const parts: string[] = [];
          if (duration_ms != null) {
            const secs = (duration_ms / 1000).toFixed(1);
            parts.push(`${secs}s`);
          }
          if (cost_usd != null) {
            parts.push(`$${cost_usd.toFixed(4)}`);
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

          // If session not found, invalidate cache and prevent reconnection attempts
          if (msg.error === "Session not found") {
            console.log("[AgentSession] Session invalid, invalidating cache, will create new session");
            if (projectId) sessionCache.delete(getCacheKey(projectId, branch));
            finishedRef.current = true;
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
          // Invalidate cache so auto-start does a full REST call
          if (projectId) sessionCache.delete(getCacheKey(projectId, branch));
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
        if (session?.id && !finishedRef.current) {
          connectWebSocket(session.id);
        }
      }, delay);
    };

    ws.onerror = (error) => {
      console.error("[AgentSession] WebSocket error:", error);
    };
  }, [session?.id]);

  // Start or get existing session - returns the session for immediate use
  const startSession = useCallback(async (permissionMode?: "plan" | "edit"): Promise<AgentSession | null> => {
    if (!projectId) return null;

    // Capture generation at call time to detect stale responses
    const generation = sessionGenerationRef.current;

    setError(null);
    setIsInitialized(false);

    // Try cached session first — skip the slow REST call if we already know the session ID
    const cacheKey = getCacheKey(projectId, branch);
    const cached = sessionCache.get(cacheKey);
    if (cached) {
      console.log(`[AgentSession] Cache hit for ${cacheKey}, reconnecting WebSocket directly`);
      setSession(cached);
      setStatus(cached.status);
      connectWebSocket(cached.id);
      onSessionStartedRef.current?.();
      return cached;
    }

    // Cache miss — need the slow REST call
    setIsLoading(true);

    try {
      const { session: newSession, messages: initialMessages } =
        await createOrGetSession(projectId, branch, permissionMode);

      // If branch/project changed while the API call was in flight, discard the result
      if (sessionGenerationRef.current !== generation) {
        console.log("[AgentSession] Discarding stale session response (generation mismatch)");
        return null;
      }

      // Cache the session for future workspace switches
      sessionCache.set(cacheKey, newSession);

      setSession(newSession);
      setStatus(newSession.status);

      // Pre-populate messages from REST response for immediate display
      // (WebSocket replay will update containerRef in the background and flush on Ready)
      if (initialMessages && initialMessages.length > 0) {
        setMessages(initialMessages);
      }

      // Connect WebSocket - it will receive history via patches
      connectWebSocket(newSession.id);

      // Notify caller that session has started (e.g. to refetch workspace statuses)
      onSessionStartedRef.current?.();

      // Return session for immediate use (avoids React state timing issues)
      return newSession;
    } catch (e) {
      // Don't set error if the request was invalidated by a branch switch
      if (sessionGenerationRef.current !== generation) return null;

      const errorMsg = e instanceof Error ? e.message : "Failed to start session";
      setError(errorMsg);
      console.error("[AgentSession] Failed to start session:", e);
      return null;
    } finally {
      // Only clear loading if this is still the current generation
      if (sessionGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [projectId, branch, connectWebSocket]);

  // Send user message - optionally accepts sessionId for immediate use after session creation
  const sendMessage = useCallback(
    async (content: string, sessionId?: string) => {
      const targetSessionId = sessionId || session?.id;
      if (!targetSessionId || !content.trim()) return;

      try {
        // Send via REST API (more reliable than WebSocket for important actions)
        await sendMessageToSession(targetSessionId, content.trim());
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : "Failed to send message";
        console.error("[AgentSession] Failed to send message:", errorMsg);
        setError(errorMsg);
        toast.error("Failed to send message", { description: errorMsg });
      }
    },
    [session?.id]
  );

  // Restart session - clears conversation and respawns Claude Code process
  const restartSession = useCallback(async () => {
    if (!session?.id) return;

    // Invalidate cache — session will get new state after restart
    if (projectId) sessionCache.delete(getCacheKey(projectId, branch));

    setIsLoading(true);
    setError(null);

    try {
      await restartSessionApi(session.id);
      // The WebSocket will receive the clearAll patch and status update
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to restart session";
      setError(errorMsg);
      console.error("[AgentSession] Failed to restart session:", e);
    } finally {
      setIsLoading(false);
    }
  }, [session?.id]);

  // Switch permission mode (preserves conversation history)
  const switchMode = useCallback(async (mode: "plan" | "edit") => {
    if (!session?.id) return;

    setError(null);

    try {
      await switchModeApi(session.id, mode);
      // Update session locally - history is preserved, new messages come via WebSocket
      setSession((prev) => prev ? { ...prev, permissionMode: mode } : prev);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to switch mode";
      setError(errorMsg);
      console.error("[AgentSession] Failed to switch mode:", e);
    }
  }, [session?.id]);

  // Accept plan and restart in edit mode
  const acceptPlan = useCallback(async (planContent: string) => {
    if (!session?.id) return;

    setError(null);

    try {
      await acceptPlanApi(session.id, planContent);
      // Update session locally - mode switches to edit
      setSession((prev) => prev ? { ...prev, permissionMode: "edit" } : prev);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to accept plan";
      setError(errorMsg);
      console.error("[AgentSession] Failed to accept plan:", e);
    }
  }, [session?.id]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        finishedRef.current = true; // Prevent reconnect on unmount
        wsRef.current.close();
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
    containerRef.current = { entries: [], status: "stopped" };
    finishedRef.current = false;
    reconnectAttemptRef.current = 0;
    connectionStartTimeRef.current = null;
    shortLivedConnectionsRef.current = 0;

    // Mark that we need to auto-start session after reset
    shouldAutoStartRef.current = true;
  }, [projectId, branch, agentMode]);

  // Auto-start session after mount or worktree switch
  useEffect(() => {
    if (shouldAutoStartRef.current && projectId && !session && !isLoading) {
      shouldAutoStartRef.current = false;
      startSession();
    }
  }, [projectId, session, isLoading, startSession]);

  // Reconnect when session changes
  useEffect(() => {
    if (session?.id && !isConnected && !finishedRef.current) {
      connectWebSocket(session.id);
    }
  }, [session?.id, isConnected, connectWebSocket]);

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
    restartSession,
    switchMode,
    acceptPlan,
  };
}
