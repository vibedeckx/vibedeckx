"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  getFreshToken,
  getWebSocketUrl,
  type ProjectChatMessage,
  type ProjectChatMessagePage,
  type ProjectChatContextRef,
  type ProjectChatSnapshot,
  type ProjectChatStatus,
  type ProjectChatThread,
} from "@/lib/api";
import { useCreateProjectChatThread } from "@/hooks/use-create-project-chat-thread";

type ProjectChatPatch = {
  op: "add" | "replace";
  path: string;
  value:
    | { type: "ENTRY"; content: ProjectChatMessage }
    | {
      type: "MESSAGES";
      content: ProjectChatMessage[];
      hasEarlierMessages: boolean;
      earliestSequence: number | null;
    }
    | { type: "STATUS"; content: ProjectChatStatus }
    | { type: "ACTIVE_TURN"; content: string | null }
    | { type: "APPROVALS"; content: string[] }
    | { type: "QUEUE"; content: number }
    | { type: "CONTEXT"; content: ProjectChatContextRef[] };
};

interface ProjectChatStreamState {
  thread: ProjectChatThread | null;
  messages: ProjectChatMessage[];
  hasEarlierMessages: boolean;
  earliestSequence: number | null;
  status: ProjectChatStatus;
  activeTurnId: string | null;
  pendingApprovalIds: string[];
  queueLength: number;
  contextRefs: ProjectChatContextRef[];
}

export const PROJECT_CHAT_CONNECT_TIMEOUT_MS = 10_000;
export const PROJECT_CHAT_STALE_AFTER_MS = 40_000;
export const PROJECT_CHAT_SNAPSHOT_CACHE_LIMIT = 5;

export type ProjectChatTerminalError = "thread_not_found";

export interface UseProjectChatResult extends ProjectChatStreamState {
  threads: ProjectChatThread[];
  loading: boolean;
  threadsLoading: boolean;
  threadLoading: boolean;
  loadingEarlierMessages: boolean;
  isConnected: boolean;
  error: string | null;
  terminalError: ProjectChatTerminalError | null;
  refetchThreads: (includeArchived?: boolean) => Promise<void>;
  createThread: (message?: string) => Promise<ProjectChatThread>;
  renameThread: (threadId: string, title: string) => Promise<ProjectChatThread>;
  archiveThread: (threadId: string, archived?: boolean) => Promise<ProjectChatThread>;
  deleteThread: (threadId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  stopTurn: (expectedActiveTurnId: string) => Promise<boolean>;
  resolveToolApproval: (approvalId: string, approved: boolean) => Promise<void>;
  selectWorkspace: (requestId: string, workspaceId: string) => Promise<void>;
  loadEarlierMessages: () => Promise<void>;
}

const emptyStreamState = (): ProjectChatStreamState => ({
  thread: null,
  messages: [],
  hasEarlierMessages: false,
  earliestSequence: null,
  status: "idle",
  activeTurnId: null,
  pendingApprovalIds: [],
  queueLength: 0,
  contextRefs: [],
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

function mergeProjectChatMessages(
  current: ProjectChatMessage[],
  incoming: ProjectChatMessage[],
): ProjectChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreadNotFoundError(reason: unknown): boolean {
  if (!isRecord(reason)) return false;
  return reason.status === 404
    || (reason instanceof Error && reason.message === "Thread not found");
}

function isProjectChatMessage(value: unknown): value is ProjectChatMessage {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.thread_id === "string"
    && typeof value.sequence === "number"
    && typeof value.type === "string"
    && typeof value.content === "string"
    && typeof value.created_at === "string";
}

function isProjectChatContextRef(value: unknown): value is ProjectChatContextRef {
  if (!isRecord(value) || typeof value.thread_id !== "string") return false;
  if (!["task", "workspace", "agent_session", "schedule", "schedule_run"].includes(String(value.entity_type))
    || typeof value.entity_id !== "string" || typeof value.last_referenced_at !== "string"
    || typeof value.deleted !== "boolean") return false;
  if (value.navigation === null) return true;
  if (value.deleted) return false;
  if (!isRecord(value.navigation) || value.navigation.kind !== value.entity_type
    || typeof value.navigation.label !== "string") return false;
  if (value.navigation.kind === "task") return typeof value.navigation.taskId === "string";
  if (value.navigation.kind === "workspace") return typeof value.navigation.target === "string"
    && (value.navigation.branch === null || typeof value.navigation.branch === "string");
  if (value.navigation.kind === "agent_session") return typeof value.navigation.sessionId === "string"
    && typeof value.navigation.target === "string"
    && (value.navigation.branch === null || typeof value.navigation.branch === "string");
  if (value.navigation.kind === "schedule") return typeof value.navigation.scheduleId === "string";
  return value.navigation.kind === "schedule_run" && typeof value.navigation.scheduleId === "string"
    && typeof value.navigation.runId === "string";
}

function isProjectChatStatus(value: unknown): value is ProjectChatStatus {
  return value === "idle" || value === "running" || value === "queued";
}

function isProjectChatSnapshot(value: unknown): value is ProjectChatSnapshot {
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.thread)
    || !Array.isArray(value.messages) || !Array.isArray(value.contextRefs)) return false;
  const threadId = value.thread.id;
  const projectId = value.thread.project_id;
  const userId = value.thread.user_id;
  return typeof threadId === "string"
    && typeof projectId === "string"
    && typeof userId === "string"
    && typeof value.identity.projectId === "string"
    && typeof value.identity.threadId === "string"
    && typeof value.identity.userId === "string"
    && value.identity.threadId === threadId
    && value.identity.projectId === projectId
    && value.identity.userId === userId
    && value.messages.every((message) => isProjectChatMessage(message) && message.thread_id === threadId)
    && typeof value.hasEarlierMessages === "boolean"
    && (value.earliestSequence === null || Number.isSafeInteger(value.earliestSequence))
    && value.contextRefs.every((ref) => isProjectChatContextRef(ref) && ref.thread_id === threadId)
    && isProjectChatStatus(value.status)
    && (value.activeTurnId === null || typeof value.activeTurnId === "string")
    && Array.isArray(value.pendingApprovalIds)
    && value.pendingApprovalIds.every((id) => typeof id === "string" && id.length > 0)
    && Number.isSafeInteger(value.queueLength)
    && (value.queueLength as number) >= 0;
}

function applyPatches(state: ProjectChatStreamState, patches: unknown[]): ProjectChatStreamState | null {
  let next = state;
  for (const rawPatch of patches) {
    if (!isRecord(rawPatch) || (rawPatch.op !== "add" && rawPatch.op !== "replace")
      || typeof rawPatch.path !== "string" || !isRecord(rawPatch.value)) return null;
    const patch = rawPatch as unknown as ProjectChatPatch;
    const messagePath = /^\/messages\/(0|[1-9]\d*)$/.exec(patch.path);
    if (messagePath && patch.value.type === "ENTRY" && isProjectChatMessage(patch.value.content)) {
      const message = patch.value.content;
      const index = Number(messagePath[1]);
      if (!Number.isSafeInteger(index)
        || (next.thread !== null && message.thread_id !== next.thread.id)) return null;
      const messages = [...next.messages];
      if (patch.op === "add") {
        if (index > messages.length || messages.some((existing) => existing.id === message.id)) return null;
        messages.push(message);
        messages.sort((left, right) => left.sequence - right.sequence);
      } else {
        const existingIndex = messages.findIndex((existing) => existing.id === message.id);
        if (existingIndex < 0) return null;
        messages[existingIndex] = message;
      }
      next = { ...next, messages, earliestSequence: messages[0]?.sequence ?? null };
    } else if (patch.path === "/messages" && patch.value.type === "MESSAGES"
      && Array.isArray(patch.value.content) && patch.value.content.every(isProjectChatMessage)
      && typeof patch.value.hasEarlierMessages === "boolean"
      && (patch.value.earliestSequence === null || Number.isSafeInteger(patch.value.earliestSequence))
      && patch.value.content.every((message) => next.thread === null || message.thread_id === next.thread.id)) {
      const retainedOlder = next.earliestSequence !== null && patch.value.earliestSequence !== null
        && next.earliestSequence < patch.value.earliestSequence;
      const messages = retainedOlder
        ? mergeProjectChatMessages(next.messages, patch.value.content)
        : patch.value.content;
      next = {
        ...next,
        messages,
        earliestSequence: messages[0]?.sequence ?? null,
        hasEarlierMessages: retainedOlder ? next.hasEarlierMessages : patch.value.hasEarlierMessages,
      };
    } else if (patch.path === "/status" && patch.value.type === "STATUS"
      && isProjectChatStatus(patch.value.content)) {
      next = { ...next, status: patch.value.content };
    } else if (patch.path === "/activeTurnId" && patch.value.type === "ACTIVE_TURN"
      && (patch.value.content === null || typeof patch.value.content === "string")) {
      next = { ...next, activeTurnId: patch.value.content };
    } else if (patch.path === "/pendingApprovalIds" && patch.value.type === "APPROVALS"
      && Array.isArray(patch.value.content)
      && patch.value.content.every((id) => typeof id === "string" && id.length > 0)) {
      next = { ...next, pendingApprovalIds: [...new Set(patch.value.content)].sort() };
    } else if (patch.path === "/queueLength" && patch.value.type === "QUEUE"
      && Number.isSafeInteger(patch.value.content) && patch.value.content >= 0) {
      next = { ...next, queueLength: patch.value.content };
    } else if (patch.path === "/contextRefs" && patch.value.type === "CONTEXT"
      && Array.isArray(patch.value.content) && patch.value.content.every(isProjectChatContextRef)
      && patch.value.content.every((ref) => next.thread === null || ref.thread_id === next.thread.id)) {
      next = { ...next, contextRefs: patch.value.content };
    } else {
      return null;
    }
  }
  return next;
}

export function useProjectChat(projectId: string | null, threadId: string | null): UseProjectChatResult {
  const createProjectChatThread = useCreateProjectChatThread(projectId);
  const [threads, setThreads] = useState<ProjectChatThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false);
  const [streamState, setStreamState] = useState<ProjectChatStreamState>(emptyStreamState);
  const [isConnected, setIsConnected] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<ProjectChatTerminalError | null>(null);
  const streamStateRef = useRef<ProjectChatStreamState>(emptyStreamState());

  const projectIdRef = useRef(projectId);
  const selectedThreadIdRef = useRef(threadId);
  const listGenerationRef = useRef(0);
  const listRequestEpochRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const threadMutationEpochRef = useRef<Map<string, number>>(new Map());
  const connectionGenerationRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  // The cache is deliberately indexed by the durable Thread identity. It never
  // shares state with the branch-scoped Main Chat's project+branch cache.
  const snapshotCacheRef = useRef<Map<string, ProjectChatSnapshot>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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

  const invalidateThreadList = useCallback((targetProjectId: string, generation: number): boolean => {
    if (!mountedRef.current || projectIdRef.current !== targetProjectId
      || listGenerationRef.current !== generation) return false;
    listRequestEpochRef.current += 1;
    listAbortRef.current?.abort();
    listAbortRef.current = null;
    setThreadsLoading(false);
    return true;
  }, []);

  useEffect(() => {
    connectionGenerationRef.current += 1;
    const generation = connectionGenerationRef.current;
    let cancelled = false;
    let fatal = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let lastFrameAt: number | null = null;
    type ConnectAttempt = {
      controller: AbortController;
      timeout: ReturnType<typeof setTimeout> | null;
      socket: WebSocket | null;
    };
    let activeAttempt: ConnectAttempt | null = null;

    const publishStreamState = (next: ProjectChatStreamState) => {
      streamStateRef.current = next;
      setStreamState(next);
    };

    socketRef.current?.close();
    socketRef.current = null;
    setIsConnected(false);
    setLoadingEarlierMessages(false);
    setThreadError(null);
    setTerminalError(null);

    if (!projectId || !threadId) {
      publishStreamState(emptyStreamState());
      setThreadLoading(false);
      return;
    }
    const activeProjectId = projectId;
    const activeThreadId = threadId;

    const cached = snapshotCacheRef.current.get(threadId);
    if (cached?.identity.projectId === projectId) {
      cacheSnapshot(snapshotCacheRef.current, cached);
      publishStreamState({
        thread: cached.thread,
        messages: cached.messages,
        hasEarlierMessages: cached.hasEarlierMessages,
        earliestSequence: cached.earliestSequence,
        status: cached.status,
        activeTurnId: cached.activeTurnId,
        pendingApprovalIds: cached.pendingApprovalIds,
        queueLength: cached.queueLength,
        contextRefs: cached.contextRefs,
      });
    } else {
      snapshotCacheRef.current.delete(threadId);
      publishStreamState(emptyStreamState());
    }
    setThreadLoading(true);

    const current = () => !cancelled
      && !fatal
      && connectionGenerationRef.current === generation
      && projectIdRef.current === projectId
      && selectedThreadIdRef.current === threadId;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const isActiveAttempt = (attempt: ConnectAttempt) => current() && activeAttempt === attempt;

    const completeAttempt = (attempt: ConnectAttempt) => {
      if (attempt.timeout !== null) clearTimeout(attempt.timeout);
      attempt.timeout = null;
      if (activeAttempt === attempt) activeAttempt = null;
    };

    const cancelAttempt = (attempt: ConnectAttempt) => {
      completeAttempt(attempt);
      attempt.controller.abort();
      const socket = attempt.socket;
      attempt.socket = null;
      if (socket && socketRef.current === socket) socketRef.current = null;
      socket?.close();
    };

    const stopAsNotFound = (socket?: WebSocket) => {
      fatal = true;
      clearReconnectTimer();
      if (activeAttempt) cancelAttempt(activeAttempt);
      if (socket && socketRef.current === socket) {
        socketRef.current = null;
        socket.close();
      }
      setIsConnected(false);
      setThreadLoading(false);
      setThreadError("Thread not found");
      setTerminalError("thread_not_found");
    };

    const scheduleReconnect = (immediate = false) => {
      if (!current()) return;
      if (immediate) clearReconnectTimer();
      if (reconnectTimer !== null) return;
      const delay = immediate ? 0 : Math.min(1000 * 2 ** reconnectAttempt, 30_000);
      if (!immediate) reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect(true);
      }, delay);
    };

    const failSocket = (socket: WebSocket, message?: string) => {
      if (!current() || socketRef.current !== socket) return;
      if (activeAttempt?.socket === socket) cancelAttempt(activeAttempt);
      else {
        socketRef.current = null;
        socket.close();
      }
      setIsConnected(false);
      setThreadLoading(false);
      if (message) setThreadError(message);
      scheduleReconnect();
    };

    async function connect(forceRefresh: boolean) {
      if (!current() || activeAttempt) return;
      const attempt: ConnectAttempt = {
        controller: new AbortController(),
        timeout: null,
        socket: null,
      };
      activeAttempt = attempt;
      attempt.timeout = setTimeout(() => {
        if (!isActiveAttempt(attempt)) return;
        cancelAttempt(attempt);
        setIsConnected(false);
        setThreadLoading(false);
        setThreadError("Project Chat connection timed out");
        scheduleReconnect();
      }, PROJECT_CHAT_CONNECT_TIMEOUT_MS);
      try {
        const [ownedDetail, token] = await Promise.all([
          api.getProjectChatThread(activeThreadId, { signal: attempt.controller.signal }),
          getFreshToken(forceRefresh ? { skipCache: true } : undefined),
        ]);
        if (!isActiveAttempt(attempt)) return;
        const { thread: ownedThread, contextRefs } = ownedDetail;
        if (ownedThread.project_id !== activeProjectId || ownedThread.id !== activeThreadId) {
          fatal = true;
          cancelAttempt(attempt);
          setThreadError("Project Chat stream identity mismatch");
          setThreadLoading(false);
          return;
        }
        if (!Array.isArray(contextRefs) || !contextRefs.every(isProjectChatContextRef)
          || contextRefs.some((ref) => ref.thread_id !== activeThreadId)) {
          throw new Error("Invalid Project Chat thread context");
        }
        publishStreamState({ ...streamStateRef.current, thread: ownedThread, contextRefs });
        const socket = new WebSocket(getWebSocketUrl(`/api/project-chat/threads/${activeThreadId}/stream`, token));
        attempt.socket = socket;
        socketRef.current = socket;
        let receivedSnapshot = false;
        lastFrameAt = null;

        socket.onopen = () => {
          if (!current() || socketRef.current !== socket) return;
          setIsConnected(true);
        };
        socket.onmessage = (event) => {
          if (!current() || socketRef.current !== socket) return;
          try {
            const message = JSON.parse(event.data) as unknown;
            if (!isRecord(message)) throw new Error("invalid frame");
            if ("type" in message && message.type === "project_chat_snapshot") {
              const snapshot = message.snapshot;
              if (!isProjectChatSnapshot(snapshot)) throw new Error("invalid snapshot");
              if (snapshot.identity.threadId !== activeThreadId
                || snapshot.identity.projectId !== activeProjectId
                || snapshot.identity.userId !== ownedThread.user_id
                || snapshot.thread.id !== activeThreadId
                || snapshot.thread.project_id !== activeProjectId
                || snapshot.thread.user_id !== ownedThread.user_id) {
                fatal = true;
                setThreadError("Project Chat stream identity mismatch");
                setThreadLoading(false);
                if (activeAttempt === attempt) cancelAttempt(attempt);
                else {
                  socketRef.current = null;
                  socket.close();
                }
                return;
              }
              receivedSnapshot = true;
              lastFrameAt = Date.now();
              completeAttempt(attempt);
              reconnectAttempt = 0;
              setTerminalError(null);
              setThreadError(null);
              cacheSnapshot(snapshotCacheRef.current, snapshot);
              publishStreamState({
                thread: snapshot.thread,
                messages: streamStateRef.current.thread?.id === activeThreadId
                  && streamStateRef.current.earliestSequence !== null
                  && snapshot.earliestSequence !== null
                  && streamStateRef.current.earliestSequence < snapshot.earliestSequence
                  ? mergeProjectChatMessages(streamStateRef.current.messages, snapshot.messages)
                  : snapshot.messages,
                hasEarlierMessages: streamStateRef.current.thread?.id === activeThreadId
                  && streamStateRef.current.earliestSequence !== null
                  && snapshot.earliestSequence !== null
                  && streamStateRef.current.earliestSequence < snapshot.earliestSequence
                  ? streamStateRef.current.hasEarlierMessages
                  : snapshot.hasEarlierMessages,
                earliestSequence: streamStateRef.current.thread?.id === activeThreadId
                  && streamStateRef.current.earliestSequence !== null
                  && snapshot.earliestSequence !== null
                  && streamStateRef.current.earliestSequence < snapshot.earliestSequence
                  ? streamStateRef.current.earliestSequence
                  : snapshot.earliestSequence,
                status: snapshot.status,
                activeTurnId: snapshot.activeTurnId,
                pendingApprovalIds: snapshot.pendingApprovalIds,
                queueLength: snapshot.queueLength,
                contextRefs: snapshot.contextRefs,
              });
              setThreadLoading(false);
            } else if ("JsonPatch" in message) {
              if (!receivedSnapshot || !Array.isArray(message.JsonPatch)) {
                throw new Error("invalid patch frame");
              }
              const next = applyPatches(streamStateRef.current, message.JsonPatch);
              if (!next) throw new Error("invalid patch frame");
              lastFrameAt = Date.now();
              if (next.thread) {
                cacheSnapshot(snapshotCacheRef.current, {
                  identity: {
                    projectId: activeProjectId,
                    threadId: activeThreadId,
                    userId: next.thread.user_id,
                  },
                  thread: next.thread,
                  messages: next.messages,
                  hasEarlierMessages: next.hasEarlierMessages,
                  earliestSequence: next.earliestSequence,
                  status: next.status,
                  activeTurnId: next.activeTurnId,
                  pendingApprovalIds: next.pendingApprovalIds,
                  queueLength: next.queueLength,
                  contextRefs: next.contextRefs,
                });
              }
              publishStreamState(next);
            } else if ("error" in message) {
              if (message.error === "Thread not found") {
                stopAsNotFound(socket);
                return;
              }
              failSocket(socket, typeof message.error === "string" ? message.error : "Project Chat stream failed");
            } else {
              throw new Error("unknown frame");
            }
          } catch {
            failSocket(socket, "Invalid Project Chat stream message");
          }
        };
        socket.onerror = () => {
          failSocket(socket);
        };
        socket.onclose = () => {
          if (!current() || socketRef.current !== socket) return;
          if (activeAttempt?.socket === socket) cancelAttempt(activeAttempt);
          socketRef.current = null;
          setIsConnected(false);
          scheduleReconnect();
        };
      } catch (reason) {
        if (!isActiveAttempt(attempt)) return;
        cancelAttempt(attempt);
        if (isThreadNotFoundError(reason)) {
          stopAsNotFound();
          return;
        }
        setThreadLoading(false);
        setThreadError(reason instanceof Error ? reason.message : "Failed to open Project Chat thread");
        scheduleReconnect();
      }
    }

    const reconnectForBrowserRecovery = () => {
      if (!current()) return;
      clearReconnectTimer();
      if (activeAttempt) cancelAttempt(activeAttempt);
      const socket = socketRef.current;
      if (socket) {
        socketRef.current = null;
        socket.close();
      }
      setIsConnected(false);
      void connect(true);
    };
    const handleOnline = () => reconnectForBrowserRecovery();
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (activeAttempt || (lastFrameAt !== null
        && Date.now() - lastFrameAt > PROJECT_CHAT_STALE_AFTER_MS)) reconnectForBrowserRecovery();
    };
    // This stream has no application-level heartbeat. Recover from browser
    // network transitions and from a stale connection when a hidden tab wakes.
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    void connect(false);

    return () => {
      cancelled = true;
      clearReconnectTimer();
      if (activeAttempt) cancelAttempt(activeAttempt);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [projectId, threadId]);

  const createThread = useCallback(async (message?: string) => {
    const targetProjectId = projectIdRef.current;
    const generation = listGenerationRef.current;
    if (!targetProjectId) throw new Error("No project selected");
    const created = await createProjectChatThread(message);
    if (created.project_id === targetProjectId && invalidateThreadList(targetProjectId, generation)) {
      setThreads((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    }
    return created;
  }, [createProjectChatThread, invalidateThreadList]);

  const updateThreadInState = useCallback((updated: ProjectChatThread) => {
    setThreads((current) => updated.archived_at === null
      ? [updated, ...current.filter((item) => item.id !== updated.id)]
      : current.filter((item) => item.id !== updated.id));
    if (streamStateRef.current.thread?.id === updated.id) {
      const next = { ...streamStateRef.current, thread: updated };
      streamStateRef.current = next;
      setStreamState(next);
    }
    const cached = snapshotCacheRef.current.get(updated.id);
    if (cached) cacheSnapshot(snapshotCacheRef.current, { ...cached, thread: updated });
  }, []);

  const renameThread = useCallback(async (targetThreadId: string, title: string) => {
    const targetProjectId = projectIdRef.current;
    const generation = listGenerationRef.current;
    const normalized = title.trim();
    if (!normalized) throw new Error("Title is required");
    const mutationEpoch = (threadMutationEpochRef.current.get(targetThreadId) ?? 0) + 1;
    threadMutationEpochRef.current.set(targetThreadId, mutationEpoch);
    const updated = await api.updateProjectChatThread(targetThreadId, { title: normalized });
    if (targetProjectId && updated.project_id === targetProjectId
      && threadMutationEpochRef.current.get(targetThreadId) === mutationEpoch) {
      const belongsToCurrentProject = invalidateThreadList(targetProjectId, generation);
      if (belongsToCurrentProject) {
        updateThreadInState(updated);
      }
    }
    return updated;
  }, [invalidateThreadList, updateThreadInState]);

  const archiveThread = useCallback(async (targetThreadId: string, archived = true) => {
    const targetProjectId = projectIdRef.current;
    const generation = listGenerationRef.current;
    const mutationEpoch = (threadMutationEpochRef.current.get(targetThreadId) ?? 0) + 1;
    threadMutationEpochRef.current.set(targetThreadId, mutationEpoch);
    const updated = await api.updateProjectChatThread(targetThreadId, { archived });
    if (targetProjectId && updated.project_id === targetProjectId
      && threadMutationEpochRef.current.get(targetThreadId) === mutationEpoch) {
      const belongsToCurrentProject = invalidateThreadList(targetProjectId, generation);
      if (belongsToCurrentProject) {
        updateThreadInState(updated);
      }
    }
    return updated;
  }, [invalidateThreadList, updateThreadInState]);

  const deleteThread = useCallback(async (targetThreadId: string) => {
    const targetProjectId = projectIdRef.current;
    const generation = listGenerationRef.current;
    const mutationEpoch = (threadMutationEpochRef.current.get(targetThreadId) ?? 0) + 1;
    threadMutationEpochRef.current.set(targetThreadId, mutationEpoch);
    await api.deleteProjectChatThread(targetThreadId);
    if (!targetProjectId || threadMutationEpochRef.current.get(targetThreadId) !== mutationEpoch
      || !invalidateThreadList(targetProjectId, generation)) return;
    snapshotCacheRef.current.delete(targetThreadId);
    setThreads((current) => current.filter((item) => item.id !== targetThreadId));
    if (selectedThreadIdRef.current === targetThreadId) {
      connectionGenerationRef.current += 1;
      socketRef.current?.close();
      socketRef.current = null;
      setIsConnected(false);
      setThreadLoading(false);
      const empty = emptyStreamState();
      streamStateRef.current = empty;
      setStreamState(empty);
    }
  }, [invalidateThreadList]);

  const sendMessage = useCallback(async (content: string) => {
    const targetThreadId = selectedThreadIdRef.current;
    if (!targetThreadId) throw new Error("No Project Chat thread selected");
    const normalized = content.trim();
    if (!normalized) throw new Error("Message is required");
    await api.sendProjectChatMessage(targetThreadId, normalized);
  }, []);

  const stopTurn = useCallback(async (expectedActiveTurnId: string) => {
    const targetThreadId = selectedThreadIdRef.current;
    if (!targetThreadId) return false;
    return api.stopProjectChatTurn(targetThreadId, expectedActiveTurnId);
  }, []);

  const resolveToolApproval = useCallback(async (approvalId: string, approved: boolean) => {
    const targetThreadId = selectedThreadIdRef.current;
    if (!targetThreadId) throw new Error("No Project Chat thread selected");
    await api.approveProjectChatTool(targetThreadId, approvalId, approved);
  }, []);

  const selectWorkspace = useCallback(async (requestId: string, workspaceId: string) => {
    const targetThreadId = selectedThreadIdRef.current;
    if (!targetThreadId) throw new Error("No Project Chat thread selected");
    await api.selectProjectChatWorkspace(targetThreadId, requestId, workspaceId);
  }, []);

  const loadEarlierMessages = useCallback(async () => {
    const targetThreadId = selectedThreadIdRef.current;
    const state = streamStateRef.current;
    if (!targetThreadId || !state.hasEarlierMessages || state.earliestSequence === null) return;
    setLoadingEarlierMessages(true);
    try {
      const page: ProjectChatMessagePage = await api.listProjectChatMessages(targetThreadId, {
        beforeSequence: state.earliestSequence,
      });
      if (selectedThreadIdRef.current !== targetThreadId
        || streamStateRef.current.thread?.id !== targetThreadId) return;
      const messages = mergeProjectChatMessages(streamStateRef.current.messages, page.messages);
      const next = {
        ...streamStateRef.current,
        messages,
        hasEarlierMessages: page.hasMore,
        earliestSequence: messages[0]?.sequence ?? null,
      };
      streamStateRef.current = next;
      setStreamState(next);
      setThreadError(null);
    } catch (reason) {
      if (selectedThreadIdRef.current === targetThreadId) {
        setThreadError(reason instanceof Error ? reason.message : "Failed to load earlier messages");
      }
    } finally {
      if (selectedThreadIdRef.current === targetThreadId) setLoadingEarlierMessages(false);
    }
  }, []);

  return {
    ...streamState,
    threads,
    loading: threadsLoading || threadLoading,
    threadsLoading,
    threadLoading,
    loadingEarlierMessages,
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
    selectWorkspace,
    loadEarlierMessages,
  };
}
