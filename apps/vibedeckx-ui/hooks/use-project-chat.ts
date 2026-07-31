"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  getFreshToken,
  getWebSocketUrl,
  type ProjectChatMessage,
  type ProjectChatSnapshot,
  type ProjectChatStatus,
  type ProjectChatThread,
} from "@/lib/api";

type ProjectChatPatch = {
  op: "add" | "replace";
  path: string;
  value:
    | { type: "ENTRY"; content: ProjectChatMessage }
    | { type: "STATUS"; content: ProjectChatStatus }
    | { type: "QUEUE"; content: number };
};

type ProjectChatWsMessage =
  | { type: "project_chat_snapshot"; snapshot: ProjectChatSnapshot }
  | { JsonPatch: ProjectChatPatch[] }
  | { error: string };

interface ProjectChatStreamState {
  thread: ProjectChatThread | null;
  messages: ProjectChatMessage[];
  status: ProjectChatStatus;
  queueLength: number;
}

export const PROJECT_CHAT_SNAPSHOT_TIMEOUT_MS = 10_000;
export const PROJECT_CHAT_STALE_AFTER_MS = 40_000;
export const PROJECT_CHAT_SNAPSHOT_CACHE_LIMIT = 5;

export type ProjectChatTerminalError = "thread_not_found";

export interface UseProjectChatResult extends ProjectChatStreamState {
  threads: ProjectChatThread[];
  loading: boolean;
  threadsLoading: boolean;
  threadLoading: boolean;
  isConnected: boolean;
  error: string | null;
  terminalError: ProjectChatTerminalError | null;
  refetchThreads: (includeArchived?: boolean) => Promise<void>;
  createThread: (message?: string) => Promise<ProjectChatThread>;
  renameThread: (threadId: string, title: string) => Promise<ProjectChatThread>;
  archiveThread: (threadId: string, archived?: boolean) => Promise<ProjectChatThread>;
  deleteThread: (threadId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  stopTurn: () => Promise<boolean>;
  resolveToolApproval: (approvalId: string, approved: boolean) => Promise<void>;
}

const emptyStreamState = (): ProjectChatStreamState => ({
  thread: null,
  messages: [],
  status: "idle",
  queueLength: 0,
});

function cacheSnapshot(cache: Map<string, ProjectChatSnapshot>, snapshot: ProjectChatSnapshot): void {
  cache.delete(snapshot.identity.threadId);
  cache.set(snapshot.identity.threadId, snapshot);
  while (cache.size > PROJECT_CHAT_SNAPSHOT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreadNotFoundError(reason: unknown): boolean {
  if (!isRecord(reason)) return false;
  return reason.status === 404
    || (reason instanceof Error && reason.message === "Thread not found");
}

function applyPatches(state: ProjectChatStreamState, patches: unknown[]): ProjectChatStreamState {
  let next = state;
  for (const rawPatch of patches) {
    if (!isRecord(rawPatch) || (rawPatch.op !== "add" && rawPatch.op !== "replace")
      || typeof rawPatch.path !== "string" || !isRecord(rawPatch.value)) continue;
    const patch = rawPatch as unknown as ProjectChatPatch;
    const messagePath = /^\/messages\/(0|[1-9]\d*)$/.exec(patch.path);
    if (messagePath && patch.value.type === "ENTRY" && isRecord(patch.value.content)) {
      const message = patch.value.content as unknown as ProjectChatMessage;
      const index = Number(messagePath[1]);
      if (!Number.isSafeInteger(index)
        || typeof message.id !== "string"
        || typeof message.thread_id !== "string"
        || typeof message.sequence !== "number"
        || typeof message.type !== "string"
        || typeof message.content !== "string"
        || typeof message.created_at !== "string"
        || (next.thread !== null && message.thread_id !== next.thread.id)) continue;
      const messages = [...next.messages];
      if (patch.op === "add") {
        if (index > messages.length || messages.some((existing) => existing.id === message.id)) continue;
        messages.splice(index, 0, message);
      } else {
        if (index >= messages.length || messages[index].id !== message.id) continue;
        messages[index] = message;
      }
      next = { ...next, messages };
    } else if (patch.path === "/status" && patch.value.type === "STATUS"
      && (patch.value.content === "idle" || patch.value.content === "running")) {
      next = { ...next, status: patch.value.content };
    } else if (patch.path === "/queueLength" && patch.value.type === "QUEUE"
      && Number.isSafeInteger(patch.value.content) && patch.value.content >= 0) {
      next = { ...next, queueLength: patch.value.content };
    }
  }
  return next;
}

export function useProjectChat(projectId: string | null, threadId: string | null): UseProjectChatResult {
  const [threads, setThreads] = useState<ProjectChatThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [streamState, setStreamState] = useState<ProjectChatStreamState>(emptyStreamState);
  const [isConnected, setIsConnected] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<ProjectChatTerminalError | null>(null);

  const projectIdRef = useRef(projectId);
  const selectedThreadIdRef = useRef(threadId);
  const listGenerationRef = useRef(0);
  const listRequestEpochRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const connectionGenerationRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  // The cache is deliberately indexed by the durable Thread identity. It never
  // shares state with the branch-scoped Main Chat's project+branch cache.
  const snapshotCacheRef = useRef<Map<string, ProjectChatSnapshot>>(new Map());

  useEffect(() => {
    projectIdRef.current = projectId;
    selectedThreadIdRef.current = threadId;
    for (const [cachedThreadId, snapshot] of snapshotCacheRef.current) {
      if (!projectId || snapshot.identity.projectId !== projectId) {
        snapshotCacheRef.current.delete(cachedThreadId);
      }
    }
  }, [projectId, threadId]);

  const loadThreads = useCallback(async (
    targetProjectId: string,
    generation: number,
    includeArchived: boolean,
  ) => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    const requestEpoch = ++listRequestEpochRef.current;
    try {
      const next = await api.listProjectChatThreads(targetProjectId, includeArchived, {
        signal: controller.signal,
      });
      if (listGenerationRef.current !== generation || projectIdRef.current !== targetProjectId
        || listRequestEpochRef.current !== requestEpoch) return;
      setThreads(next);
      setThreadsError(null);
    } catch (reason) {
      if (controller.signal.aborted || listGenerationRef.current !== generation
        || projectIdRef.current !== targetProjectId || listRequestEpochRef.current !== requestEpoch) return;
      setThreadsError(reason instanceof Error ? reason.message : "Failed to list Project Chat threads");
    } finally {
      if (listAbortRef.current === controller) listAbortRef.current = null;
      if (listGenerationRef.current === generation && projectIdRef.current === targetProjectId
        && listRequestEpochRef.current === requestEpoch) {
        setThreadsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    listGenerationRef.current += 1;
    listRequestEpochRef.current += 1;
    const generation = listGenerationRef.current;
    listAbortRef.current?.abort();
    listAbortRef.current = null;
    if (!projectId) {
      setThreads([]);
      setThreadsLoading(false);
      setThreadsError(null);
      return;
    }
    setThreads([]);
    setThreadsLoading(true);
    setThreadsError(null);
    void loadThreads(projectId, generation, false);
    return () => {
      listRequestEpochRef.current += 1;
      listAbortRef.current?.abort();
      listAbortRef.current = null;
    };
  }, [loadThreads, projectId]);

  const refetchThreads = useCallback(async (includeArchived = false) => {
    const targetProjectId = projectIdRef.current;
    if (!targetProjectId) return;
    await loadThreads(targetProjectId, listGenerationRef.current, includeArchived);
  }, [loadThreads]);

  useEffect(() => {
    connectionGenerationRef.current += 1;
    const generation = connectionGenerationRef.current;
    let cancelled = false;
    let fatal = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let connectInFlight = false;
    let lastFrameAt: number | null = null;

    socketRef.current?.close();
    socketRef.current = null;
    setIsConnected(false);
    setThreadError(null);
    setTerminalError(null);

    if (!projectId || !threadId) {
      setStreamState(emptyStreamState());
      setThreadLoading(false);
      return;
    }
    const activeProjectId = projectId;
    const activeThreadId = threadId;

    const cached = snapshotCacheRef.current.get(threadId);
    if (cached?.identity.projectId === projectId) {
      cacheSnapshot(snapshotCacheRef.current, cached);
      setStreamState({
        thread: cached.thread,
        messages: cached.messages,
        status: cached.status,
        queueLength: cached.queueLength,
      });
    } else {
      snapshotCacheRef.current.delete(threadId);
      setStreamState(emptyStreamState());
    }
    setThreadLoading(true);

    const current = () => !cancelled
      && !fatal
      && connectionGenerationRef.current === generation
      && projectIdRef.current === projectId
      && selectedThreadIdRef.current === threadId;

    const clearSnapshotTimer = () => {
      if (snapshotTimer !== null) clearTimeout(snapshotTimer);
      snapshotTimer = null;
    };

    const stopAsNotFound = (socket?: WebSocket) => {
      fatal = true;
      clearSnapshotTimer();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket && socketRef.current === socket) socketRef.current = null;
      socket?.close();
      setIsConnected(false);
      setThreadLoading(false);
      setThreadError("Thread not found");
      setTerminalError("thread_not_found");
    };

    const scheduleReconnect = (immediate = false) => {
      if (!current()) return;
      if (immediate && reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (reconnectTimer !== null) return;
      const delay = immediate ? 0 : Math.min(1000 * 2 ** reconnectAttempt, 30_000);
      if (!immediate) reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect(true);
      }, delay);
    };

    async function connect(forceRefresh: boolean) {
      if (!current() || connectInFlight) return;
      connectInFlight = true;
      try {
        const [ownedThread, token] = await Promise.all([
          api.getProjectChatThread(activeThreadId),
          getFreshToken(forceRefresh ? { skipCache: true } : undefined),
        ]);
        if (!current()) return;
        if (ownedThread.project_id !== activeProjectId || ownedThread.id !== activeThreadId) {
          fatal = true;
          setThreadError("Project Chat stream identity mismatch");
          setThreadLoading(false);
          return;
        }
        setStreamState((previous) => ({ ...previous, thread: ownedThread }));
        const socket = new WebSocket(getWebSocketUrl(`/api/project-chat/threads/${activeThreadId}/stream`, token));
        socketRef.current = socket;
        let receivedSnapshot = false;
        lastFrameAt = null;
        clearSnapshotTimer();
        snapshotTimer = setTimeout(() => {
          if (!current() || socketRef.current !== socket || receivedSnapshot) return;
          snapshotTimer = null;
          socketRef.current = null;
          socket.close();
          setIsConnected(false);
          setThreadLoading(false);
          setThreadError("Project Chat snapshot timed out");
          scheduleReconnect();
        }, PROJECT_CHAT_SNAPSHOT_TIMEOUT_MS);

        socket.onopen = () => {
          if (!current() || socketRef.current !== socket) return;
          setIsConnected(true);
        };
        socket.onmessage = (event) => {
          if (!current() || socketRef.current !== socket) return;
          try {
            const message = JSON.parse(event.data) as ProjectChatWsMessage;
            if (!isRecord(message)) throw new Error("invalid frame");
            lastFrameAt = Date.now();
            if ("type" in message && message.type === "project_chat_snapshot") {
              const snapshot = message.snapshot;
              if (snapshot.identity.threadId !== activeThreadId
                || snapshot.identity.projectId !== activeProjectId
                || snapshot.thread.id !== activeThreadId
                || snapshot.thread.project_id !== activeProjectId) {
                fatal = true;
                setThreadError("Project Chat stream identity mismatch");
                setThreadLoading(false);
                clearSnapshotTimer();
                socketRef.current = null;
                socket.close();
                return;
              }
              receivedSnapshot = true;
              clearSnapshotTimer();
              reconnectAttempt = 0;
              setTerminalError(null);
              setThreadError(null);
              cacheSnapshot(snapshotCacheRef.current, snapshot);
              setStreamState({
                thread: snapshot.thread,
                messages: snapshot.messages,
                status: snapshot.status,
                queueLength: snapshot.queueLength,
              });
              setThreadLoading(false);
            } else if ("JsonPatch" in message) {
              if (!receivedSnapshot || !Array.isArray(message.JsonPatch)) {
                throw new Error("invalid patch frame");
              }
              setStreamState((previous) => {
                const next = applyPatches(previous, message.JsonPatch);
                if (next.thread) {
                  cacheSnapshot(snapshotCacheRef.current, {
                    identity: {
                      projectId: activeProjectId,
                      threadId: activeThreadId,
                      userId: next.thread.user_id,
                    },
                    thread: next.thread,
                    messages: next.messages,
                    status: next.status,
                    queueLength: next.queueLength,
                  });
                }
                return next;
              });
            } else if ("error" in message) {
              if (message.error === "Thread not found") {
                stopAsNotFound(socket);
                return;
              }
              clearSnapshotTimer();
              socketRef.current = null;
              socket.close();
              setIsConnected(false);
              setThreadError(typeof message.error === "string" ? message.error : "Project Chat stream failed");
              scheduleReconnect();
            }
          } catch {
            setThreadError("Invalid Project Chat stream message");
          }
        };
        socket.onerror = () => {
          if (!current() || socketRef.current !== socket) return;
          clearSnapshotTimer();
          socketRef.current = null;
          socket.close();
          setIsConnected(false);
          scheduleReconnect();
        };
        socket.onclose = () => {
          if (!current() || socketRef.current !== socket) return;
          clearSnapshotTimer();
          socketRef.current = null;
          setIsConnected(false);
          scheduleReconnect();
        };
      } catch (reason) {
        if (!current()) return;
        if (isThreadNotFoundError(reason)) {
          stopAsNotFound();
          return;
        }
        setThreadLoading(false);
        setThreadError(reason instanceof Error ? reason.message : "Failed to open Project Chat thread");
        scheduleReconnect();
      } finally {
        connectInFlight = false;
      }
    }

    const reconnectForBrowserRecovery = () => {
      if (!current() || connectInFlight) return;
      const socket = socketRef.current;
      clearSnapshotTimer();
      if (socket) {
        socketRef.current = null;
        socket.close();
      }
      setIsConnected(false);
      scheduleReconnect(true);
    };
    const handleOnline = () => reconnectForBrowserRecovery();
    const handleVisibility = () => {
      if (document.visibilityState !== "visible" || lastFrameAt === null) return;
      if (Date.now() - lastFrameAt > PROJECT_CHAT_STALE_AFTER_MS) reconnectForBrowserRecovery();
    };
    // This stream has no application-level heartbeat. Recover from browser
    // network transitions and from a stale connection when a hidden tab wakes.
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    void connect(false);

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearSnapshotTimer();
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [projectId, threadId]);

  const createThread = useCallback(async (message?: string) => {
    const targetProjectId = projectIdRef.current;
    if (!targetProjectId) throw new Error("No project selected");
    const normalized = message === undefined ? undefined : message.trim();
    if (message !== undefined && !normalized) throw new Error("Message is required");
    const created = await api.createProjectChatThread(targetProjectId, normalized);
    if (projectIdRef.current === targetProjectId) {
      setThreads((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    }
    return created;
  }, []);

  const updateThreadInState = useCallback((updated: ProjectChatThread) => {
    setThreads((current) => updated.archived_at === null
      ? [updated, ...current.filter((item) => item.id !== updated.id)]
      : current.filter((item) => item.id !== updated.id));
    setStreamState((current) => current.thread?.id === updated.id
      ? { ...current, thread: updated }
      : current);
    const cached = snapshotCacheRef.current.get(updated.id);
    if (cached) cacheSnapshot(snapshotCacheRef.current, { ...cached, thread: updated });
  }, []);

  const renameThread = useCallback(async (targetThreadId: string, title: string) => {
    const targetProjectId = projectIdRef.current;
    const generation = listGenerationRef.current;
    const normalized = title.trim();
    if (!normalized) throw new Error("Title is required");
    const updated = await api.updateProjectChatThread(targetThreadId, { title: normalized });
    if (targetProjectId && projectIdRef.current === targetProjectId
      && listGenerationRef.current === generation && updated.project_id === targetProjectId) {
      updateThreadInState(updated);
    }
    return updated;
  }, [updateThreadInState]);

  const archiveThread = useCallback(async (targetThreadId: string, archived = true) => {
    const targetProjectId = projectIdRef.current;
    const generation = listGenerationRef.current;
    const updated = await api.updateProjectChatThread(targetThreadId, { archived });
    if (targetProjectId && projectIdRef.current === targetProjectId
      && listGenerationRef.current === generation && updated.project_id === targetProjectId) {
      updateThreadInState(updated);
    }
    return updated;
  }, [updateThreadInState]);

  const deleteThread = useCallback(async (targetThreadId: string) => {
    const targetProjectId = projectIdRef.current;
    const generation = listGenerationRef.current;
    await api.deleteProjectChatThread(targetThreadId);
    if (!targetProjectId || projectIdRef.current !== targetProjectId
      || listGenerationRef.current !== generation) return;
    snapshotCacheRef.current.delete(targetThreadId);
    setThreads((current) => current.filter((item) => item.id !== targetThreadId));
    if (selectedThreadIdRef.current === targetThreadId) {
      connectionGenerationRef.current += 1;
      socketRef.current?.close();
      socketRef.current = null;
      setIsConnected(false);
      setThreadLoading(false);
      setStreamState(emptyStreamState());
    }
  }, []);

  const sendMessage = useCallback(async (content: string) => {
    const targetThreadId = selectedThreadIdRef.current;
    if (!targetThreadId) throw new Error("No Project Chat thread selected");
    const normalized = content.trim();
    if (!normalized) throw new Error("Message is required");
    await api.sendProjectChatMessage(targetThreadId, normalized);
  }, []);

  const stopTurn = useCallback(async () => {
    const targetThreadId = selectedThreadIdRef.current;
    if (!targetThreadId) return false;
    return api.stopProjectChatTurn(targetThreadId);
  }, []);

  const resolveToolApproval = useCallback(async (approvalId: string, approved: boolean) => {
    const targetThreadId = selectedThreadIdRef.current;
    if (!targetThreadId) throw new Error("No Project Chat thread selected");
    await api.approveProjectChatTool(targetThreadId, approvalId, approved);
  }, []);

  return {
    ...streamState,
    threads,
    loading: threadsLoading || threadLoading,
    threadsLoading,
    threadLoading,
    isConnected,
    error: threadError ?? threadsError,
    terminalError,
    refetchThreads,
    createThread,
    renameThread,
    archiveThread,
    deleteThread,
    sendMessage,
    stopTurn,
    resolveToolApproval,
  };
}
