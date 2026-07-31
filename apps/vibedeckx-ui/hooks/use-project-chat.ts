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

export interface UseProjectChatResult extends ProjectChatStreamState {
  threads: ProjectChatThread[];
  loading: boolean;
  threadsLoading: boolean;
  threadLoading: boolean;
  isConnected: boolean;
  error: string | null;
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

function applyPatches(state: ProjectChatStreamState, patches: ProjectChatPatch[]): ProjectChatStreamState {
  let next = state;
  for (const patch of patches) {
    if (patch.path.startsWith("/messages/") && patch.value.type === "ENTRY") {
      const index = Number.parseInt(patch.path.slice("/messages/".length), 10);
      if (!Number.isInteger(index) || index < 0) continue;
      const messages = [...next.messages];
      if (patch.op === "add") messages.splice(Math.min(index, messages.length), 0, patch.value.content);
      else if (index < messages.length) messages[index] = patch.value.content;
      next = { ...next, messages };
    } else if (patch.path === "/status" && patch.value.type === "STATUS") {
      next = { ...next, status: patch.value.content };
    } else if (patch.path === "/queueLength" && patch.value.type === "QUEUE") {
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

  const projectIdRef = useRef(projectId);
  const selectedThreadIdRef = useRef(threadId);
  const listGenerationRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  // The cache is deliberately indexed by the durable Thread identity. It never
  // shares state with the branch-scoped Main Chat's project+branch cache.
  const snapshotCacheRef = useRef<Map<string, ProjectChatSnapshot>>(new Map());

  useEffect(() => {
    projectIdRef.current = projectId;
    selectedThreadIdRef.current = threadId;
  }, [projectId, threadId]);

  const loadThreads = useCallback(async (
    targetProjectId: string,
    generation: number,
    includeArchived: boolean,
  ) => {
    try {
      const next = await api.listProjectChatThreads(targetProjectId, includeArchived);
      if (listGenerationRef.current !== generation || projectIdRef.current !== targetProjectId) return;
      setThreads(next);
      setThreadsError(null);
    } catch (reason) {
      if (listGenerationRef.current !== generation || projectIdRef.current !== targetProjectId) return;
      setThreadsError(reason instanceof Error ? reason.message : "Failed to list Project Chat threads");
    } finally {
      if (listGenerationRef.current === generation && projectIdRef.current === targetProjectId) {
        setThreadsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    listGenerationRef.current += 1;
    const generation = listGenerationRef.current;
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
    let reconnectAttempt = 0;

    socketRef.current?.close();
    socketRef.current = null;
    setIsConnected(false);
    setThreadError(null);

    if (!projectId || !threadId) {
      setStreamState(emptyStreamState());
      setThreadLoading(false);
      return;
    }

    const cached = snapshotCacheRef.current.get(threadId);
    if (cached?.identity.projectId === projectId) {
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

    const connect = async (forceRefresh: boolean) => {
      try {
        const [ownedThread, token] = await Promise.all([
          api.getProjectChatThread(threadId),
          getFreshToken(forceRefresh ? { skipCache: true } : undefined),
        ]);
        if (!current()) return;
        if (ownedThread.project_id !== projectId || ownedThread.id !== threadId) {
          fatal = true;
          setThreadError("Project Chat stream identity mismatch");
          setThreadLoading(false);
          return;
        }
        setStreamState((previous) => ({ ...previous, thread: ownedThread }));
        const socket = new WebSocket(getWebSocketUrl(`/api/project-chat/threads/${threadId}/stream`, token));
        socketRef.current = socket;

        socket.onopen = () => {
          if (!current() || socketRef.current !== socket) return;
          reconnectAttempt = 0;
          setIsConnected(true);
          setThreadError(null);
        };
        socket.onmessage = (event) => {
          if (!current() || socketRef.current !== socket) return;
          try {
            const message = JSON.parse(event.data) as ProjectChatWsMessage;
            if ("type" in message && message.type === "project_chat_snapshot") {
              const snapshot = message.snapshot;
              if (snapshot.identity.threadId !== threadId
                || snapshot.identity.projectId !== projectId
                || snapshot.thread.id !== threadId
                || snapshot.thread.project_id !== projectId) {
                fatal = true;
                setThreadError("Project Chat stream identity mismatch");
                setThreadLoading(false);
                socket.close();
                return;
              }
              snapshotCacheRef.current.set(threadId, snapshot);
              setStreamState({
                thread: snapshot.thread,
                messages: snapshot.messages,
                status: snapshot.status,
                queueLength: snapshot.queueLength,
              });
              setThreadLoading(false);
            } else if ("JsonPatch" in message) {
              setStreamState((previous) => {
                const next = applyPatches(previous, message.JsonPatch);
                if (next.thread) {
                  snapshotCacheRef.current.set(threadId, {
                    identity: { projectId, threadId, userId: next.thread.user_id },
                    thread: next.thread,
                    messages: next.messages,
                    status: next.status,
                    queueLength: next.queueLength,
                  });
                }
                return next;
              });
            } else if ("error" in message) {
              setThreadError(message.error);
            }
          } catch {
            setThreadError("Invalid Project Chat stream message");
          }
        };
        socket.onerror = () => {
          if (current() && socketRef.current === socket) setIsConnected(false);
        };
        socket.onclose = () => {
          if (socketRef.current === socket) socketRef.current = null;
          if (!current()) return;
          setIsConnected(false);
          const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => { void connect(true); }, delay);
        };
      } catch (reason) {
        if (!current()) return;
        setThreadLoading(false);
        setThreadError(reason instanceof Error ? reason.message : "Failed to open Project Chat thread");
      }
    };

    void connect(false);

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
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
    if (cached) snapshotCacheRef.current.set(updated.id, { ...cached, thread: updated });
  }, []);

  const renameThread = useCallback(async (targetThreadId: string, title: string) => {
    const normalized = title.trim();
    if (!normalized) throw new Error("Title is required");
    const updated = await api.updateProjectChatThread(targetThreadId, { title: normalized });
    updateThreadInState(updated);
    return updated;
  }, [updateThreadInState]);

  const archiveThread = useCallback(async (targetThreadId: string, archived = true) => {
    const updated = await api.updateProjectChatThread(targetThreadId, { archived });
    updateThreadInState(updated);
    return updated;
  }, [updateThreadInState]);

  const deleteThread = useCallback(async (targetThreadId: string) => {
    await api.deleteProjectChatThread(targetThreadId);
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
