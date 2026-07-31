import { randomUUID } from "crypto";
import { streamText } from "ai";
import type WebSocket from "ws";
import type {
  ProjectChatMessage,
  ProjectChatMessageType,
  ProjectChatThread,
  Storage,
} from "./storage/types.js";
import { resolveChatModel } from "./utils/chat-model.js";

export type ProjectChatStatus = "idle" | "running";

export interface ProjectChatIdentity {
  projectId: string;
  threadId: string;
  userId: string;
}

export interface ProjectChatSnapshot {
  identity: ProjectChatIdentity;
  thread: ProjectChatThread;
  messages: ProjectChatMessage[];
  status: ProjectChatStatus;
  queueLength: number;
}

export type ProjectChatStreamEvent = {
  type: Exclude<ProjectChatMessageType, "user" | "system" | "turn_end">;
  content: string;
  approvalId?: string;
  resolveApproval?: (approved: boolean) => void;
};

export interface ProjectChatRunInput extends ProjectChatIdentity {
  messages: ProjectChatMessage[];
  signal: AbortSignal;
}

export interface ProjectChatModelRunner {
  run(input: ProjectChatRunInput): AsyncIterable<ProjectChatStreamEvent>;
}

export type ProjectChatWsMessage =
  | { type: "project_chat_snapshot"; snapshot: ProjectChatSnapshot }
  | {
    JsonPatch: Array<{
      op: "add" | "replace";
      path: string;
      value:
        | { type: "ENTRY"; content: ProjectChatMessage }
        | { type: "STATUS"; content: ProjectChatStatus }
        | { type: "QUEUE"; content: number };
    }>;
  };

interface QueuedTurn {
  content: string;
  queueId: string | null;
  userPersisted: boolean;
  startPersisted: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface LiveThread {
  thread: ProjectChatThread;
  messages: ProjectChatMessage[];
  nextSequence: number;
  status: ProjectChatStatus;
  queue: QueuedTurn[];
  subscribers: Set<WebSocket>;
  abortController: AbortController | null;
  activeWork: Promise<void> | null;
  activeTurnId: string | null;
  pendingApprovals: Map<string, {
    turnId: string;
    resolve: (approved: boolean) => void;
  }>;
  writeTail: Promise<void>;
}

export class ProjectChatNotFoundError extends Error {
  readonly code = "PROJECT_CHAT_NOT_FOUND";

  constructor() {
    super("Project Chat thread not found");
  }
}

class DefaultProjectChatModelRunner implements ProjectChatModelRunner {
  constructor(private readonly storage: Storage) {}

  async *run(input: ProjectChatRunInput): AsyncGenerator<ProjectChatStreamEvent> {
    const result = streamText({
      model: await resolveChatModel(this.storage, input.userId),
      system: "You are the project assistant. Answer clearly using the supplied project chat transcript.",
      messages: input.messages
        .filter((message) => message.type === "user" || message.type === "assistant" || message.type === "system")
        .map((message) => ({
          role: message.type === "assistant" ? "assistant" as const : message.type === "system" ? "system" as const : "user" as const,
          content: message.content,
        })),
      abortSignal: input.signal,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "project-chat",
        metadata: {
          projectId: input.projectId,
          threadId: input.threadId,
          userId: input.userId,
          tags: ["vibedeckx", "project-chat"],
        },
      },
    });

    let content = "";
    for await (const delta of result.textStream) content += delta;
    if (content) yield { type: "assistant", content };
  }
}

/**
 * Persistent, project-scoped chat runtime. SQLite is the transcript source of
 * truth; this class retains only active queues, abort handles, and subscribers.
 */
export class ProjectChatManager {
  private readonly liveThreads = new Map<string, LiveThread>();
  private readonly loadingThreads = new Map<string, Promise<LiveThread>>();
  private readonly closingThreads = new Set<string>();
  private readonly runner: ProjectChatModelRunner;
  private shuttingDown = false;

  constructor(private readonly storage: Storage, runner?: ProjectChatModelRunner) {
    this.runner = runner ?? new DefaultProjectChatModelRunner(storage);
  }

  async openThread(threadId: string, userId: string): Promise<ProjectChatSnapshot> {
    const thread = await this.authorize(threadId, userId);
    const live = await this.loadLiveThread(thread);
    if (this.closingThreads.has(threadId)) throw new ProjectChatNotFoundError();
    live.thread = thread;
    return this.snapshot(live);
  }

  async sendMessage(threadId: string, userId: string, content: string): Promise<void> {
    if (this.shuttingDown) throw new Error("Project Chat manager is shutting down");
    const trimmed = content.trim();
    if (!trimmed) throw new TypeError("Project Chat message must not be empty");
    const thread = await this.authorize(threadId, userId);
    const live = await this.loadLiveThread(thread);
    if (this.closingThreads.has(threadId)) throw new ProjectChatNotFoundError();

    const queuedBehindActiveTurn = live.activeWork !== null || live.queue.length > 0;
    const queueId = queuedBehindActiveTurn ? randomUUID() : null;
    if (queueId) {
      await this.append(live, "operation", JSON.stringify({ kind: "queued_user", queueId, content: trimmed }));
      if (this.closingThreads.has(threadId)) throw new ProjectChatNotFoundError();
    }

    return new Promise<void>((resolve, reject) => {
      live.queue.push({
        content: trimmed,
        queueId,
        userPersisted: false,
        startPersisted: false,
        resolve,
        reject,
      });
      this.broadcastStatus(live);
      this.pump(live);
      if (queueId) resolve();
    });
  }

  /** Authorization requires storage I/O, so stopping is deliberately async. */
  async stopGeneration(threadId: string, userId: string): Promise<boolean> {
    const thread = await this.findAuthorized(threadId, userId);
    if (!thread) return false;
    const live = this.liveThreads.get(thread.id);
    if (!live?.abortController || live.status !== "running") return false;
    this.settlePendingApprovals(live, live.activeTurnId, false);
    live.abortController.abort();
    return true;
  }

  subscribe(threadId: string, socket: WebSocket): (() => void) | null {
    if (this.closingThreads.has(threadId)) return null;
    const live = this.liveThreads.get(threadId);
    if (!live) return null;
    const subscriberUserId = (socket as WebSocket & { projectChatUserId?: string }).projectChatUserId;
    if (subscriberUserId !== live.thread.user_id) return null;
    this.sendFrame(socket, { type: "project_chat_snapshot", snapshot: this.snapshot(live) });
    live.subscribers.add(socket);
    return () => live.subscribers.delete(socket);
  }

  /** Authorization requires storage I/O, so approval resolution is async. */
  async resolveToolApproval(
    threadId: string,
    userId: string,
    approvalId: string,
    _approved: boolean,
  ): Promise<boolean> {
    const thread = await this.findAuthorized(threadId, userId);
    if (!thread) return false;
    const live = this.liveThreads.get(thread.id);
    const pending = live?.pendingApprovals.get(approvalId);
    if (!live || !pending || pending.turnId !== live.activeTurnId || live.status !== "running") return false;
    live.pendingApprovals.delete(approvalId);
    pending.resolve(_approved);
    return true;
  }

  async deleteThread(threadId: string, userId: string): Promise<boolean> {
    const thread = await this.findAuthorized(threadId, userId);
    if (!thread) return false;
    this.closingThreads.add(threadId);
    try {
      const live = this.liveThreads.get(threadId);
      if (live) {
        this.settlePendingApprovals(live, live.activeTurnId, false);
        live.abortController?.abort();
        for (const queued of live.queue.splice(0)) queued.resolve();
        if (live.activeWork) await Promise.allSettled([live.activeWork]);
        for (const socket of live.subscribers) {
          try { socket.close(); } catch { /* disconnected */ }
        }
        live.subscribers.clear();
      }
      await this.storage.projectChatThreads.delete(thread.id, thread.project_id, userId);
      return true;
    } finally {
      this.liveThreads.delete(threadId);
      this.loadingThreads.delete(threadId);
      this.closingThreads.delete(threadId);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active: Promise<void>[] = [];
    for (const live of this.liveThreads.values()) {
      this.settlePendingApprovals(live, live.activeTurnId, false);
      live.abortController?.abort();
      for (const queued of live.queue.splice(0)) queued.resolve();
      if (live.activeWork) active.push(live.activeWork);
    }
    await Promise.allSettled(active);
    for (const live of this.liveThreads.values()) live.subscribers.clear();
  }

  private async findAuthorized(threadId: string, userId: string): Promise<ProjectChatThread | undefined> {
    if (!userId || this.closingThreads.has(threadId)) return undefined;
    const thread = await this.storage.projectChatThreads.getOwnedById(threadId, userId);
    if (!thread) return undefined;
    const project = userId === "local"
      ? await this.storage.projects.getById(thread.project_id)
      : await this.storage.projects.getById(thread.project_id, userId);
    if (!project) return undefined;
    return this.storage.projectChatThreads.getById(thread.id, thread.project_id, userId);
  }

  private async authorize(threadId: string, userId: string): Promise<ProjectChatThread> {
    const thread = await this.findAuthorized(threadId, userId);
    if (!thread) throw new ProjectChatNotFoundError();
    return thread;
  }

  private async loadLiveThread(thread: ProjectChatThread): Promise<LiveThread> {
    const existing = this.liveThreads.get(thread.id);
    if (existing) return existing;
    const loading = this.loadingThreads.get(thread.id);
    if (loading) return loading;

    const promise = this.storage.projectChatMessages
      .listByThread(thread.id, thread.project_id, thread.user_id)
      .then((messages): LiveThread => {
        const live: LiveThread = {
          thread,
          messages,
          nextSequence: (messages.at(-1)?.sequence ?? 0) + 1,
          status: "idle",
          queue: this.recoverQueuedTurns(messages, thread.id),
          subscribers: new Set(),
          abortController: null,
          activeWork: null,
          activeTurnId: null,
          pendingApprovals: new Map(),
          writeTail: Promise.resolve(),
        };
        this.liveThreads.set(thread.id, live);
        if (live.queue.length > 0) queueMicrotask(() => this.pump(live));
        return live;
      })
      .finally(() => this.loadingThreads.delete(thread.id));
    this.loadingThreads.set(thread.id, promise);
    return promise;
  }

  private pump(live: LiveThread): void {
    if (live.activeWork || this.shuttingDown || this.closingThreads.has(live.thread.id)) return;
    const queued = live.queue.shift();
    if (!queued) return;
    const work = this.runTurn(live, queued)
      .finally(() => {
        live.activeWork = null;
        live.abortController = null;
        live.status = "idle";
        this.broadcastStatus(live);
        this.pump(live);
      });
    live.activeWork = work;
  }

  private async runTurn(live: LiveThread, queued: QueuedTurn): Promise<void> {
    const abortController = new AbortController();
    const turnId = randomUUID();
    live.abortController = abortController;
    live.activeTurnId = turnId;
    try {
      if (!queued.userPersisted) await this.append(live, "user", queued.content);
      if (queued.queueId && !queued.startPersisted) {
        await this.append(live, "operation", JSON.stringify({
          kind: "queued_user_started",
          queueId: queued.queueId,
        }));
      }
      queued.resolve();
      live.status = "running";
      this.broadcastStatus(live);
      const input: ProjectChatRunInput = {
        projectId: live.thread.project_id,
        threadId: live.thread.id,
        userId: live.thread.user_id,
        messages: live.messages.filter((message) => message.type !== "operation" && message.type !== "turn_end"),
        signal: abortController.signal,
      };
      for await (const event of this.runner.run(input)) {
        if (abortController.signal.aborted) {
          if (event.type === "tool_approval_request" && event.resolveApproval) {
            try { event.resolveApproval(false); } catch { /* runner already settled */ }
          }
          break;
        }
        if (event.type === "tool_approval_request") {
          const approvalId = event.approvalId ?? this.readApprovalId(event.content);
          const resolveApproval = event.resolveApproval;
          let registered = false;
          let settled = false;
          const settleApproval = (decision: boolean): void => {
            if (settled || !resolveApproval) return;
            settled = true;
            try { resolveApproval(decision); } catch { /* runner already settled */ }
          };
          try {
            await this.append(live, event.type, event.content, () => {
              if (!approvalId || !resolveApproval || abortController.signal.aborted ||
                live.activeTurnId !== turnId) {
                settleApproval(false);
                return;
              }
              const previous = live.pendingApprovals.get(approvalId);
              if (previous) previous.resolve(false);
              live.pendingApprovals.set(approvalId, { turnId, resolve: settleApproval });
              registered = true;
            });
          } catch (error) {
            if (!registered) settleApproval(false);
            throw error;
          }
        } else {
          await this.append(live, event.type, event.content);
        }
      }
      await this.append(live, "turn_end", JSON.stringify({
        status: abortController.signal.aborted ? "stopped" : "completed",
        ...(queued.queueId ? { queueId: queued.queueId } : {}),
      }));
    } catch (error) {
      if (abortController.signal.aborted) {
        await this.append(live, "turn_end", JSON.stringify({
          status: "stopped",
          ...(queued.queueId ? { queueId: queued.queueId } : {}),
        }));
        queued.resolve();
        return;
      }
      try {
        await this.append(live, "error", error instanceof Error ? error.message : String(error));
        await this.append(live, "turn_end", JSON.stringify({
          status: "error",
          ...(queued.queueId ? { queueId: queued.queueId } : {}),
        }));
      } catch {
        // Preserve the original failure when persistence is also unavailable.
      }
      queued.reject(error);
    } finally {
      this.settlePendingApprovals(live, turnId, false);
      if (live.activeTurnId === turnId) live.activeTurnId = null;
    }
  }

  private async append(
    live: LiveThread,
    type: ProjectChatMessageType,
    content: string,
    beforeBroadcast?: (message: ProjectChatMessage) => void,
  ): Promise<ProjectChatMessage> {
    const previousWrite = live.writeTail;
    let release!: () => void;
    live.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previousWrite;
    try {
      const message = await this.storage.projectChatMessages.append({
        id: randomUUID(),
        thread_id: live.thread.id,
        project_id: live.thread.project_id,
        user_id: live.thread.user_id,
        sequence: live.nextSequence,
        type,
        content,
      });
      if (!message) throw new ProjectChatNotFoundError();
      live.nextSequence++;
      live.messages.push(message);
      await this.storage.projectChatThreads.touchUpdatedAt(
        live.thread.id,
        live.thread.project_id,
        live.thread.user_id,
      );
      beforeBroadcast?.(message);
      this.broadcast(live, {
        JsonPatch: [{
          op: "add",
          path: `/messages/${live.messages.length - 1}`,
          value: { type: "ENTRY", content: message },
        }],
      });
      return message;
    } finally {
      release();
    }
  }

  private snapshot(live: LiveThread): ProjectChatSnapshot {
    return {
      identity: {
        projectId: live.thread.project_id,
        threadId: live.thread.id,
        userId: live.thread.user_id,
      },
      thread: live.thread,
      messages: [...live.messages],
      status: live.status,
      queueLength: live.queue.length,
    };
  }

  private broadcastStatus(live: LiveThread): void {
    this.broadcast(live, {
      JsonPatch: [
        {
          op: "replace",
          path: "/status",
          value: { type: "STATUS", content: live.status },
        },
        {
          op: "replace",
          path: "/queueLength",
          value: { type: "QUEUE", content: live.queue.length },
        },
      ],
    });
  }

  private broadcast(live: LiveThread, frame: ProjectChatWsMessage): void {
    for (const socket of live.subscribers) this.sendFrame(socket, frame);
  }

  private sendFrame(socket: WebSocket, frame: ProjectChatWsMessage): void {
    if (typeof socket.readyState === "number" && socket.readyState !== 1) return;
    try { socket.send(JSON.stringify(frame)); } catch { /* disconnected */ }
  }

  private readApprovalId(content: string): string | null {
    try {
      const parsed = JSON.parse(content) as { approvalId?: unknown };
      return typeof parsed.approvalId === "string" && parsed.approvalId ? parsed.approvalId : null;
    } catch {
      return null;
    }
  }

  private settlePendingApprovals(
    live: LiveThread,
    turnId: string | null,
    decision: boolean,
  ): void {
    if (!turnId) return;
    for (const [approvalId, pending] of live.pendingApprovals) {
      if (pending.turnId !== turnId) continue;
      live.pendingApprovals.delete(approvalId);
      try { pending.resolve(decision); } catch { /* runner already settled */ }
    }
  }

  private recoverQueuedTurns(messages: ProjectChatMessage[], threadId: string): QueuedTurn[] {
    const queued = new Map<string, {
      content: string;
      sequence: number;
      startPersisted: boolean;
      userPersisted: boolean;
    }>();
    const terminal = new Set<string>();
    for (const message of messages) {
      try {
        const value = JSON.parse(message.content) as {
          kind?: unknown;
          queueId?: unknown;
          content?: unknown;
        };
        if (message.type === "operation" && value.kind === "queued_user" &&
          typeof value.queueId === "string" && typeof value.content === "string") {
          queued.set(value.queueId, {
            content: value.content,
            sequence: message.sequence,
            startPersisted: false,
            userPersisted: false,
          });
        } else if (message.type === "operation" && value.kind === "queued_user_started" &&
          typeof value.queueId === "string") {
          const item = queued.get(value.queueId);
          if (item) item.startPersisted = true;
        } else if (message.type === "turn_end" && typeof value.queueId === "string") {
          terminal.add(value.queueId);
        }
      } catch { /* unrelated operation */ }
    }

    const claimedUserSequences = new Set<number>();
    for (const item of queued.values()) {
      const user = messages.find((message) =>
        message.sequence > item.sequence &&
        message.type === "user" &&
        message.content === item.content &&
        !claimedUserSequences.has(message.sequence));
      if (user) {
        item.userPersisted = true;
        claimedUserSequences.add(user.sequence);
      }
    }
    return [...queued]
      .filter(([queueId]) => !terminal.has(queueId))
      .map(([queueId, item]) => ({
        content: item.content,
        queueId,
        userPersisted: item.userPersisted,
        startPersisted: item.startPersisted,
        resolve: () => undefined,
        reject: (error) => console.error(`[ProjectChatManager] Failed recovering queued turn for ${threadId}:`, error),
      }));
  }
}
