import { randomUUID } from "crypto";
import { streamText } from "ai";
import type WebSocket from "ws";
import type {
  ProjectChatMessage,
  ProjectChatMessageType,
  ProjectChatThread,
  ProjectChatWorkItem,
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
  workId: string;
  userMessageId: string;
  content: string;
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

interface ThreadLifecycle {
  generation: number;
  deleted: boolean;
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
  private readonly lifecycles = new Map<string, ThreadLifecycle>();
  private readonly outstandingOperations = new Set<Promise<unknown>>();
  private readonly runner: ProjectChatModelRunner;
  private shuttingDown = false;

  constructor(private readonly storage: Storage, runner?: ProjectChatModelRunner) {
    this.runner = runner ?? new DefaultProjectChatModelRunner(storage);
  }

  openThread(threadId: string, userId: string): Promise<ProjectChatSnapshot> {
    return this.trackOperation(this.openThreadInternal(threadId, userId));
  }

  private async openThreadInternal(threadId: string, userId: string): Promise<ProjectChatSnapshot> {
    const generation = this.lifecycle(threadId).generation;
    const existingAtStart = this.liveThreads.has(threadId);
    if (this.shuttingDown && !existingAtStart) throw new Error("Project Chat manager is shutting down");
    const thread = await this.authorize(threadId, userId);
    this.assertLifecycle(threadId, generation, existingAtStart);
    const live = await this.loadLiveThread(thread, generation);
    this.assertLifecycle(threadId, generation, existingAtStart);
    live.thread = thread;
    return this.snapshot(live);
  }

  sendMessage(threadId: string, userId: string, content: string): Promise<void> {
    return this.trackOperation(this.sendMessageInternal(threadId, userId, content));
  }

  private async sendMessageInternal(threadId: string, userId: string, content: string): Promise<void> {
    if (this.shuttingDown) throw new Error("Project Chat manager is shutting down");
    const generation = this.lifecycle(threadId).generation;
    const trimmed = content.trim();
    if (!trimmed) throw new TypeError("Project Chat message must not be empty");
    const thread = await this.authorize(threadId, userId);
    this.assertLifecycle(threadId, generation);
    const live = await this.loadLiveThread(thread, generation);
    this.assertLifecycle(threadId, generation);

    const accepted = await this.acceptWork(live, {
      id: randomUUID(),
      userMessageId: randomUUID(),
      content: trimmed,
    });
    this.assertLifecycle(threadId, generation);
    live.queue.push(accepted);
    this.broadcastStatus(live);
    this.pump(live);
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
    if (this.closingThreads.has(threadId) || this.lifecycle(threadId).deleted) return null;
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
    const lifecycle = this.lifecycle(threadId);
    lifecycle.generation++;
    lifecycle.deleted = true;
    this.closingThreads.add(threadId);
    try {
      const live = this.liveThreads.get(threadId);
      if (live) {
        this.settlePendingApprovals(live, live.activeTurnId, false);
        live.abortController?.abort();
        live.queue.splice(0);
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
      live.queue.splice(0);
      if (live.activeWork) active.push(live.activeWork);
    }
    await Promise.allSettled([...this.outstandingOperations]);
    await Promise.allSettled(active);
    for (const live of this.liveThreads.values()) live.subscribers.clear();
  }

  private async findAuthorized(threadId: string, userId: string): Promise<ProjectChatThread | undefined> {
    if (!userId || this.closingThreads.has(threadId) || this.lifecycle(threadId).deleted) return undefined;
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

  private async loadLiveThread(thread: ProjectChatThread, generation: number): Promise<LiveThread> {
    const existing = this.liveThreads.get(thread.id);
    if (existing) return existing;
    const loading = this.loadingThreads.get(thread.id);
    if (loading) return loading;

    let promise!: Promise<LiveThread>;
    promise = Promise.all([
      this.storage.projectChatMessages.listByThread(thread.id, thread.project_id, thread.user_id),
      this.storage.projectChatWorkItems.listNonterminal(thread.id, thread.project_id, thread.user_id),
    ])
      .then(([messages, workItems]): LiveThread => {
        this.assertLifecycle(thread.id, generation);
        const live: LiveThread = {
          thread,
          messages,
          nextSequence: (messages.at(-1)?.sequence ?? 0) + 1,
          status: "idle",
          queue: workItems.map((work) => this.queueFromWorkItem(work)),
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
      .finally(() => {
        if (this.loadingThreads.get(thread.id) === promise) this.loadingThreads.delete(thread.id);
      });
    this.loadingThreads.set(thread.id, promise);
    return promise;
  }

  private lifecycle(threadId: string): ThreadLifecycle {
    let lifecycle = this.lifecycles.get(threadId);
    if (!lifecycle) {
      lifecycle = { generation: 0, deleted: false };
      this.lifecycles.set(threadId, lifecycle);
    }
    return lifecycle;
  }

  private assertLifecycle(threadId: string, generation: number, allowShutdown = false): void {
    const lifecycle = this.lifecycle(threadId);
    if (lifecycle.deleted || lifecycle.generation !== generation || this.closingThreads.has(threadId)) {
      throw new ProjectChatNotFoundError();
    }
    if (this.shuttingDown && !allowShutdown) throw new Error("Project Chat manager is shutting down");
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.outstandingOperations.delete(tracked));
    this.outstandingOperations.add(tracked);
    return tracked;
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
      const running = await this.storage.projectChatWorkItems.markRunning(
        queued.workId,
        live.thread.id,
        live.thread.project_id,
        live.thread.user_id,
      );
      if (!running) return;
      live.status = "running";
      this.broadcastStatus(live);
      const futureUserMessages = new Set(live.queue.map((item) => item.userMessageId));
      const currentUserMessage = live.messages.find((message) => message.id === queued.userMessageId);
      const history = live.messages.filter((message) =>
        message.type !== "operation" && message.type !== "turn_end" &&
        message.id !== queued.userMessageId && !futureUserMessages.has(message.id));
      const input: ProjectChatRunInput = {
        projectId: live.thread.project_id,
        threadId: live.thread.id,
        userId: live.thread.user_id,
        messages: currentUserMessage ? [...history, currentUserMessage] : history,
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
      const status = abortController.signal.aborted ? "stopped" : "completed";
      await this.finishWork(live, queued, status, null);
    } catch (error) {
      if (abortController.signal.aborted) {
        await this.finishWork(live, queued, "stopped", null);
        return;
      }
      try {
        await this.append(live, "error", error instanceof Error ? error.message : String(error));
        await this.finishWork(
          live,
          queued,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      } catch {
        // Preserve the original failure when persistence is also unavailable.
      }
    } finally {
      this.settlePendingApprovals(live, turnId, false);
      if (live.activeTurnId === turnId) live.activeTurnId = null;
    }
  }

  private async acceptWork(
    live: LiveThread,
    input: { id: string; userMessageId: string; content: string },
  ): Promise<QueuedTurn> {
    const previousWrite = live.writeTail;
    let release!: () => void;
    live.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previousWrite;
    try {
      const accepted = await this.storage.projectChatWorkItems.accept({
        id: input.id,
        user_message_id: input.userMessageId,
        thread_id: live.thread.id,
        project_id: live.thread.project_id,
        user_id: live.thread.user_id,
        content: input.content,
      });
      this.publishMessage(live, accepted.userMessage);
      return this.queueFromWorkItem(accepted.workItem);
    } finally {
      release();
    }
  }

  private async finishWork(
    live: LiveThread,
    queued: QueuedTurn,
    status: "completed" | "stopped" | "failed",
    error: string | null,
  ): Promise<ProjectChatMessage> {
    const previousWrite = live.writeTail;
    let release!: () => void;
    live.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previousWrite;
    try {
      const result = await this.storage.projectChatWorkItems.finish({
        id: queued.workId,
        thread_id: live.thread.id,
        project_id: live.thread.project_id,
        user_id: live.thread.user_id,
        status,
        error,
        turn_end_id: randomUUID(),
        turn_end_content: JSON.stringify({
          status: status === "failed" ? "error" : status,
          workId: queued.workId,
        }),
      });
      this.publishMessage(live, result.turnEnd);
      return result.turnEnd;
    } finally {
      release();
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
      await this.storage.projectChatThreads.touchUpdatedAt(
        live.thread.id,
        live.thread.project_id,
        live.thread.user_id,
      );
      beforeBroadcast?.(message);
      this.publishMessage(live, message);
      return message;
    } finally {
      release();
    }
  }

  private publishMessage(live: LiveThread, message: ProjectChatMessage): void {
    if (live.messages.some((existing) => existing.id === message.id)) return;
    live.messages.push(message);
    live.messages.sort((left, right) => left.sequence - right.sequence);
    live.nextSequence = Math.max(live.nextSequence, message.sequence + 1);
    const index = live.messages.findIndex((existing) => existing.id === message.id);
    this.broadcast(live, {
      JsonPatch: [{
        op: "add",
        path: `/messages/${index}`,
        value: { type: "ENTRY", content: message },
      }],
    });
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

  private queueFromWorkItem(work: ProjectChatWorkItem): QueuedTurn {
    return {
      workId: work.id,
      userMessageId: work.user_message_id,
      content: work.content,
    };
  }
}
