"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { produce } from "immer";
import { toast } from "sonner";
import { getWebSocketUrl, getAuthToken, api } from "@/lib/api";
import { sendCommandToIframe, openPreviewFrame } from "@/components/preview/browser-frames-provider";

// ============ Types (reused from agent session) ============

export type AgentMessage =
  | { type: "user"; content: string; timestamp: number }
  | { type: "assistant"; content: string; partial?: boolean; timestamp: number }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string; timestamp: number }
  | { type: "tool_result"; tool: string; output: string; toolUseId?: string; timestamp: number }
  | { type: "error"; message: string; timestamp: number }
  | { type: "system"; content: string; timestamp: number };

export type AgentSessionStatus = "running" | "stopped" | "error";

export interface ChatSession {
  id: string;
  projectId: string;
  branch: string | null;
  status: AgentSessionStatus;
  eventListeningEnabled?: boolean;
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

interface BrowserCommand {
  id: string;
  action: string;
  selector?: string;
  value?: string;
  key?: string;
}

type AgentWsMessage =
  | { JsonPatch: Patch }
  | { Ready: true }
  | { finished: true }
  | { error: string }
  | { browserCommand: BrowserCommand }
  | { openPreviewFrame: { projectId: string; url: string } };

interface PatchContainer {
  entries: AgentMessage[];
  status: AgentSessionStatus;
}

// ============ API Functions ============

function getApiBase(): string {
  if (typeof window === "undefined") return "";
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:5173";
  }
  return "";
}

function getAuthHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function createOrGetChatSession(
  projectId: string,
  branch: string | null
): Promise<{ session: ChatSession; messages: AgentMessage[] }> {
  const response = await fetch(`${getApiBase()}/api/projects/${projectId}/chat-sessions`, {
    method: "POST",
    headers: getAuthHeaders("application/json"),
    body: JSON.stringify({ branch }),
  });

  if (!response.ok) {
    throw new Error("Failed to create chat session");
  }

  return response.json();
}

async function sendMessageToChat(sessionId: string, content: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/chat-sessions/${sessionId}/message`, {
    method: "POST",
    headers: getAuthHeaders("application/json"),
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    throw new Error("Failed to send message");
  }
}

async function stopGenerationApi(sessionId: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/chat-sessions/${sessionId}/stop`, {
    method: "POST",
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error("Failed to stop generation");
  }
}

// ============ Patch Application ============

function applyPatch(container: PatchContainer, patch: Patch): PatchContainer {
  return produce(container, (draft) => {
    for (const entry of patch) {
      const { op, path, value } = entry;

      // Handle special clearAll patch
      if (path === "/entries" && op === "replace") {
        if (value?.type === "ENTRY" && value.content?.type === "system" && value.content?.content === "__CLEAR_ALL__") {
          draft.entries = [];
          continue;
        }
      }

      if (path.startsWith("/entries/")) {
        const indexStr = path.replace("/entries/", "");
        const index = parseInt(indexStr, 10);

        if (isNaN(index) || value?.type !== "ENTRY") continue;

        switch (op) {
          case "add":
            while (draft.entries.length <= index) {
              draft.entries.push(null as unknown as AgentMessage);
            }
            draft.entries[index] = value.content;
            break;
          case "replace":
            if (index < draft.entries.length) {
              draft.entries[index] = value.content;
            }
            break;
          case "remove":
            if (index < draft.entries.length) {
              draft.entries.splice(index, 1);
            }
            break;
        }
      } else if (path === "/status" && value?.type === "STATUS") {
        draft.status = value.content;
      }
    }
  });
}

// ============ Session Cache ============

const sessionCache = new Map<string, ChatSession>();

function getCacheKey(projectId: string, branch: string | null): string {
  return `chat:${projectId}:${branch ?? ""}`;
}

// ============ Hook ============

export function useChatSession(projectId: string | null, branch: string | null) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<AgentSessionStatus>("stopped");
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const containerRef = useRef<PatchContainer>({ entries: [], status: "stopped" });
  const finishedRef = useRef(false);
  const shouldAutoStartRef = useRef(true);
  const isReplayingRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const connectionStartTimeRef = useRef<number | null>(null);
  const stabilityTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shortLivedConnectionsRef = useRef(0);
  const lastStartFailedRef = useRef(false);

  const MIN_STABLE_CONNECTION_MS = 5000;
  const MAX_RECONNECT_DELAY_MS = 30000;
  const MAX_RECONNECT_ATTEMPTS = 10;
  const MAX_SHORT_LIVED_CONNECTIONS = 3;

  const getReconnectDelay = (attempt: number): number => {
    const baseDelay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * Math.pow(2, attempt));
    const jitter = baseDelay * Math.random() * 0.25;
    return baseDelay + jitter;
  };

  const connectWebSocket = useCallback((sessionId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    containerRef.current = { entries: [], status: "stopped" };
    finishedRef.current = false;
    isReplayingRef.current = true;

    const wsUrl = getWebSocketUrl(`/api/chat-sessions/${sessionId}/stream`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    const wsGeneration = sessionGenerationRef.current;

    ws.onopen = () => {
      setIsConnected(true);
      setError(null);
      connectionStartTimeRef.current = Date.now();

      if (stabilityTimeoutRef.current) clearTimeout(stabilityTimeoutRef.current);
      stabilityTimeoutRef.current = setTimeout(() => {
        reconnectAttemptRef.current = 0;
        shortLivedConnectionsRef.current = 0;
      }, MIN_STABLE_CONNECTION_MS);
    };

    ws.onmessage = (event) => {
      if (wsGeneration !== sessionGenerationRef.current) return;
      try {
        const msg = JSON.parse(event.data) as AgentWsMessage;

        if ("JsonPatch" in msg) {
          const prevCount = containerRef.current.entries.filter(Boolean).length;
          containerRef.current = applyPatch(containerRef.current, msg.JsonPatch);
          const newCount = containerRef.current.entries.filter(Boolean).length;
          if (!isReplayingRef.current) {
            if (newCount !== prevCount) {
              console.log(`[ChatSession] New message via WS patch (${prevCount} → ${newCount}), calling setMessages`);
            }
            setMessages([...containerRef.current.entries.filter(Boolean)]);
            setStatus(containerRef.current.status);
          } else if (newCount !== prevCount) {
            console.log(`[ChatSession] WS patch added message (${prevCount} → ${newCount}) but isReplaying=true, state NOT updated`);
          }
          return;
        }

        if ("Ready" in msg) {
          isReplayingRef.current = false;
          const count = containerRef.current.entries.filter(Boolean).length;
          console.log(`[ChatSession] Ready received, isReplaying → false, ${count} messages`);
          setMessages([...containerRef.current.entries.filter(Boolean)]);
          setStatus(containerRef.current.status);
          setIsInitialized(true);
          return;
        }

        if ("finished" in msg) {
          finishedRef.current = true;
          ws.close(1000, "finished");
          return;
        }

        if ("openPreviewFrame" in msg) {
          openPreviewFrame(msg.openPreviewFrame.projectId, msg.openPreviewFrame.url);
          return;
        }

        if ("browserCommand" in msg) {
          // Forward command to iframe, send result back via WS
          const cmd = msg.browserCommand;
          if (projectId) {
            sendCommandToIframe(projectId, {
              type: "vibedeckx-command",
              ...cmd,
            }).then((result) => {
              if (result && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: "browser_result",
                  result: {
                    id: cmd.id,
                    success: result.success ?? false,
                    error: result.error,
                    content: result.content,
                    found: result.found,
                    tag: result.tag,
                    text: result.text,
                  },
                }));
              }
            });
          }
          return;
        }

        if ("error" in msg) {
          setError(msg.error);
          if (msg.error === "Session not found") {
            if (projectId) sessionCache.delete(getCacheKey(projectId, branch));
            finishedRef.current = true;
          }
          return;
        }
      } catch (e) {
        console.error("[ChatSession] Failed to parse message:", e);
      }
    };

    ws.onclose = (event) => {
      if (wsGeneration !== sessionGenerationRef.current) return;
      setIsConnected(false);
      wsRef.current = null;

      if (stabilityTimeoutRef.current) {
        clearTimeout(stabilityTimeoutRef.current);
        stabilityTimeoutRef.current = null;
      }

      // Visibility-recovery close — skip short-lived detection, go straight to reconnect
      const isVisibilityRecovery = event.code === 4000;

      const connectionDuration = connectionStartTimeRef.current
        ? Date.now() - connectionStartTimeRef.current
        : 0;
      connectionStartTimeRef.current = null;

      if (!isVisibilityRecovery && connectionDuration > 0 && connectionDuration < MIN_STABLE_CONNECTION_MS) {
        shortLivedConnectionsRef.current++;
        if (shortLivedConnectionsRef.current >= MAX_SHORT_LIVED_CONNECTIONS) {
          if (lastStartFailedRef.current) {
            setError("Unable to connect to remote server. Please check the server configuration.");
            return;
          }
          if (projectId) sessionCache.delete(getCacheKey(projectId, branch));
          setSession(null);
          setError(null);
          reconnectAttemptRef.current = 0;
          shortLivedConnectionsRef.current = 0;
          shouldAutoStartRef.current = true;
          return;
        }
      } else if (connectionDuration >= MIN_STABLE_CONNECTION_MS) {
        shortLivedConnectionsRef.current = 0;
      }

      if (finishedRef.current || event.code === 1000) return;

      if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setError("Unable to connect to server.");
        return;
      }

      const delay = getReconnectDelay(reconnectAttemptRef.current);
      reconnectAttemptRef.current++;

      reconnectTimeoutRef.current = setTimeout(() => {
        if (session?.id && !finishedRef.current) {
          connectWebSocket(session.id);
        }
      }, delay);
    };

    ws.onerror = () => {
      // onclose will fire next
    };
  }, [session?.id]);

  const startSession = useCallback(async (): Promise<ChatSession | null> => {
    if (!projectId) return null;

    const generation = sessionGenerationRef.current;
    setError(null);
    setIsInitialized(false);
    lastStartFailedRef.current = false;

    const cacheKey = getCacheKey(projectId, branch);
    const cached = sessionCache.get(cacheKey);
    if (cached) {
      setSession(cached);
      setStatus(cached.status);
      connectWebSocket(cached.id);
      return cached;
    }

    setIsLoading(true);

    try {
      const { session: newSession, messages: initialMessages } =
        await createOrGetChatSession(projectId, branch);

      if (sessionGenerationRef.current !== generation) return null;

      sessionCache.set(cacheKey, newSession);
      setSession(newSession);
      setStatus(newSession.status);

      if (initialMessages && initialMessages.length > 0) {
        setMessages(initialMessages);
      }

      connectWebSocket(newSession.id);
      return newSession;
    } catch (e) {
      if (sessionGenerationRef.current !== generation) return null;
      const errorMsg = e instanceof Error ? e.message : "Failed to start session";
      setError(errorMsg);
      lastStartFailedRef.current = true;
      return null;
    } finally {
      if (sessionGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [projectId, branch, connectWebSocket]);

  const sendMessage = useCallback(
    async (content: string) => {
      const targetSessionId = session?.id;
      if (!targetSessionId || !content.trim()) return;

      try {
        await sendMessageToChat(targetSessionId, content.trim());
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : "Failed to send message";
        setError(errorMsg);
        toast.error("Failed to send message", { description: errorMsg });
      }
    },
    [session?.id]
  );

  const stopGeneration = useCallback(async () => {
    if (!session?.id) return;
    try {
      await stopGenerationApi(session.id);
    } catch (e) {
      console.error("[ChatSession] Failed to stop generation:", e);
    }
  }, [session?.id]);

  const restartSession = useCallback(async () => {
    if (!session?.id) return;
    try {
      await api.resetChatSession(session.id);
      // The backend broadcasts a clearAll patch via WS which resets messages.
      // Also clear local state immediately for responsiveness.
      setMessages([]);
      setStatus("stopped");
      containerRef.current = { entries: [], status: "stopped" };
    } catch (e) {
      console.error("[ChatSession] Failed to reset session:", e);
      toast.error("Failed to start new conversation");
    }
  }, [session?.id]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        finishedRef.current = true;
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (stabilityTimeoutRef.current) clearTimeout(stabilityTimeoutRef.current);
    };
  }, []);

  // Reset session when projectId or branch changes
  useEffect(() => {
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

    sessionGenerationRef.current += 1;

    setSession(null);
    setStatus("stopped");
    setIsConnected(false);
    setIsInitialized(false);
    setError(null);
    setIsLoading(false);
    containerRef.current = { entries: [], status: "stopped" };
    finishedRef.current = false;
    reconnectAttemptRef.current = 0;
    connectionStartTimeRef.current = null;
    shortLivedConnectionsRef.current = 0;
    lastStartFailedRef.current = false;

    shouldAutoStartRef.current = true;
  }, [projectId, branch]);

  // Auto-start session
  useEffect(() => {
    if (shouldAutoStartRef.current && projectId && !session && !isLoading && !lastStartFailedRef.current) {
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

  // Recover WebSocket state when the browser tab regains focus.
  // Browsers may silently drop WebSocket connections for backgrounded tabs,
  // causing messages to be missed. On tab return, force a reconnect so
  // historical patches (including executor events) are replayed.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (!session?.id || finishedRef.current) return;

      const ws = wsRef.current;
      const msgCount = containerRef.current.entries.filter(Boolean).length;
      console.log(`[ChatSession] Tab visible: ws.readyState=${ws?.readyState ?? "null"}, isReplaying=${isReplayingRef.current}, messages=${msgCount}`);

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // WebSocket already closed — the onclose reconnect logic will handle it
        return;
      }
      // Force reconnect to replay any patches missed while backgrounded
      ws.close(4000, "visibility-recovery");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [session?.id]);

  return {
    session,
    messages,
    status,
    isConnected,
    isInitialized,
    isLoading,
    error,
    sendMessage,
    stopGeneration,
    restartSession,
  };
}
