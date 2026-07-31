import { createHash, randomUUID } from "crypto";
import { stepCountIs, streamText, tool, type ToolSet } from "ai";
import type WebSocket from "ws";
import type {
  ProjectChatMessage,
  ProjectChatMessageType,
  ProjectChatThread,
  ProjectChatWorkItem,
  Storage,
} from "./storage/types.js";
import { resolveChatModel } from "./utils/chat-model.js";
import {
  createProjectChatTools,
  type CreateProjectChatToolsOptions,
  type ProjectChatTool,
  type ProjectChatTools,
} from "./project-chat-tools.js";

export const PROJECT_CHAT_SYSTEM_PROMPT = [
  "You are Project Commander, a project-scoped read-only assistant.",
  "You can inspect tasks, schedules, agent sessions, and multiple workspaces within the bound project.",
  "Project Chat does not belong to a branch or workspace; never assume one workspace is the whole project.",
  "Use the supplied read tools when factual project context is needed. Never claim to have changed project state.",
].join(" ");

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
  tools?: ProjectChatTools;
}

export interface ProjectChatModelRunner {
  run(input: ProjectChatRunInput): AsyncIterable<ProjectChatStreamEvent>;
}

export interface ProjectChatManagerOptions {
  drainTimeoutMs?: number;
  idleEvictionMs?: number;
  terminalRetryDelayMs?: number;
  terminalRetryAttempts?: number;
  terminalAttemptTimeoutMs?: number;
  toolDependencies?: Pick<CreateProjectChatToolsOptions, "agentSessionManager" | "remoteSessions">;
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
  wasRunning: boolean;
  acceptedMessage?: ProjectChatMessage;
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
  activeWorkItemId: string | null;
  activeAttempt: number | null;
  activeTurnId: string | null;
  pendingApprovals: Map<string, {
    turnId: string;
    resolve: (approved: boolean) => void;
  }>;
  writeTail: Promise<void>;
  evictionTimer: ReturnType<typeof setTimeout> | null;
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
    const tools = input.tools ? projectChatAiTools(input.tools) : {};
    const result = streamText({
      model: await resolveChatModel(this.storage, input.userId),
      system: PROJECT_CHAT_SYSTEM_PROMPT,
      messages: input.messages
        .filter((message) => message.type === "user" || message.type === "assistant" || message.type === "system")
        .map((message) => ({
          role: message.type === "assistant" ? "assistant" as const : message.type === "system" ? "system" as const : "user" as const,
          content: message.content,
        })),
      abortSignal: input.signal,
      tools,
      stopWhen: stepCountIs(8),
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
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        content += part.text;
      } else if (part.type === "tool-call") {
        yield {
          type: "tool_use",
          content: JSON.stringify({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          }),
        };
      } else if (part.type === "tool-result") {
        yield {
          type: "tool_result",
          content: JSON.stringify({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          }),
        };
      } else if (part.type === "tool-error") {
        yield {
          type: "tool_result",
          content: JSON.stringify({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            error: part.error instanceof Error ? part.error.message : String(part.error),
          }),
        };
      }
    }
    if (content) yield { type: "assistant", content };
  }
}

export function projectChatAiTools(domainTools: ProjectChatTools): ToolSet {
  const adapted: ToolSet = {};
  for (const [name, entry] of Object.entries(domainTools)) {
    const generic = entry as ProjectChatTool<unknown, unknown>;
    adapted[name] = tool({
      description: generic.description,
      inputSchema: generic.inputSchema,
      execute: generic.execute,
    }) as ToolSet[string];
  }
  return adapted;
}

/**
 * Persistent, project-scoped chat runtime. SQLite is the transcript source of
 * truth; this class retains only active queues, abort handles, and subscribers.
 */
export class ProjectChatManager {
  private readonly liveThreads = new Map<string, LiveThread>();
  private readonly loadingThreads = new Map<string, Promise<LiveThread>>();
  private readonly closingThreads = new Set<string>();
  private readonly deletingThreads = new Map<string, {
    userId: string;
    promise: Promise<boolean>;
  }>();
  private readonly lifecycles = new Map<string, ThreadLifecycle>();
  private readonly outstandingOperations = new Set<Promise<unknown>>();
  private readonly runner: ProjectChatModelRunner;
  private readonly drainTimeoutMs: number;
  private readonly idleEvictionMs: number;
  private readonly terminalRetryDelayMs: number;
  private readonly terminalRetryAttempts: number;
  private readonly terminalAttemptTimeoutMs: number;
  private readonly toolDependencies?: ProjectChatManagerOptions["toolDependencies"];
  private shuttingDown = false;

  constructor(
    private readonly storage: Storage,
    runner?: ProjectChatModelRunner,
    options: ProjectChatManagerOptions = {},
  ) {
    this.runner = runner ?? new DefaultProjectChatModelRunner(storage);
    this.drainTimeoutMs = options.drainTimeoutMs ?? 2_000;
    this.idleEvictionMs = options.idleEvictionMs ?? 30_000;
    this.terminalRetryDelayMs = options.terminalRetryDelayMs ?? 100;
    this.terminalRetryAttempts = Math.max(1, options.terminalRetryAttempts ?? 3);
    this.terminalAttemptTimeoutMs = options.terminalAttemptTimeoutMs ?? this.drainTimeoutMs;
    this.toolDependencies = options.toolDependencies;
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
    const snapshot = this.snapshot(live);
    this.scheduleEviction(live);
    return snapshot;
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
    this.cancelEviction(live);

    const accepted = await this.acceptWork(live, {
      id: randomUUID(),
      userMessageId: randomUUID(),
      content: trimmed,
    });
    this.assertLifecycle(threadId, generation, true);
    if (accepted.acceptedMessage) this.publishMessage(live, accepted.acceptedMessage);
    if (this.shuttingDown) return;
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
    await this.detachActiveWork(live, "stopped", true);
    return true;
  }

  subscribe(threadId: string, socket: WebSocket): (() => void) | null {
    if (this.closingThreads.has(threadId) || this.lifecycle(threadId).deleted) return null;
    const live = this.liveThreads.get(threadId);
    if (!live) return null;
    const subscriberUserId = (socket as WebSocket & { projectChatUserId?: string }).projectChatUserId;
    if (subscriberUserId !== live.thread.user_id) return null;
    this.sendFrame(socket, { type: "project_chat_snapshot", snapshot: this.snapshot(live) });
    this.cancelEviction(live);
    live.subscribers.add(socket);
    return () => {
      live.subscribers.delete(socket);
      this.scheduleEviction(live);
    };
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
    const pendingAtStart = this.deletingThreads.get(threadId);
    if (pendingAtStart) {
      return pendingAtStart.userId === userId ? pendingAtStart.promise : false;
    }
    const thread = await this.findAuthorized(threadId, userId);
    if (!thread) return false;
    const pendingAfterAuthorization = this.deletingThreads.get(threadId);
    if (pendingAfterAuthorization) {
      return pendingAfterAuthorization.userId === userId
        ? pendingAfterAuthorization.promise
        : false;
    }
    let operation!: Promise<boolean>;
    operation = this.deleteAuthorizedThread(thread, userId).finally(() => {
      if (this.deletingThreads.get(threadId)?.promise !== operation) return;
      this.deletingThreads.delete(threadId);
      this.closingThreads.delete(threadId);
    });
    this.deletingThreads.set(threadId, { userId, promise: operation });
    return operation;
  }

  private async deleteAuthorizedThread(
    thread: ProjectChatThread,
    userId: string,
  ): Promise<boolean> {
    const threadId = thread.id;
    const lifecycle = this.lifecycle(threadId);
    lifecycle.generation++;
    this.closingThreads.add(threadId);
    try {
      const live = this.liveThreads.get(threadId);
      if (live) {
        this.cancelEviction(live);
        this.settlePendingApprovals(live, live.activeTurnId, false);
        live.abortController?.abort();
        live.queue.splice(0);
        await this.detachActiveWork(live, "none", false);
        for (const socket of live.subscribers) {
          try { socket.close(); } catch { /* disconnected */ }
        }
        live.subscribers.clear();
      }
      await this.storage.projectChatThreads.delete(thread.id, thread.project_id, userId);
      lifecycle.deleted = true;
      return true;
    } finally {
      this.liveThreads.delete(threadId);
      this.loadingThreads.delete(threadId);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const live of this.liveThreads.values()) {
      this.cancelEviction(live);
      this.settlePendingApprovals(live, live.activeTurnId, false);
      live.abortController?.abort();
      live.queue.splice(0);
    }
    await Promise.allSettled([...this.outstandingOperations]);
    await Promise.all([...this.liveThreads.values()]
      .map((live) => this.detachActiveWork(live, "accepted", false)));
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
          activeWorkItemId: null,
          activeAttempt: null,
          activeTurnId: null,
          pendingApprovals: new Map(),
          writeTail: Promise.resolve(),
          evictionTimer: null,
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

  private canPersistTurn(live: LiveThread, turnId: string): boolean {
    return live.activeTurnId === turnId &&
      !this.lifecycle(live.thread.id).deleted &&
      !this.closingThreads.has(live.thread.id);
  }

  private terminalMessageId(workItemId: string, attempt: number): string {
    const digest = createHash("sha256").update(`${workItemId}\0${attempt}`).digest("hex");
    return `turn-end-${digest}`;
  }

  private async settleWithin<T>(promise: Promise<T>, timeoutMs = this.drainTimeoutMs): Promise<
    | { status: "fulfilled"; value: T }
    | { status: "rejected"; reason: unknown }
    | { status: "timeout" }
  > {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      promise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
      new Promise<{ status: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return result;
  }

  private async detachActiveWork(
    live: LiveThread,
    persistence: "accepted" | "stopped" | "none",
    resumeQueue: boolean,
  ): Promise<void> {
    const work = live.activeWork;
    if (!work) return;
    const drained = await this.settleWithin(work);
    if (drained.status !== "timeout" || live.activeWork !== work) return;
    const workItemId = live.activeWorkItemId;
    const attempt = live.activeAttempt;
    live.activeTurnId = null;
    live.abortController = null;
    live.activeWork = null;
    live.activeWorkItemId = null;
    live.activeAttempt = null;
    live.writeTail = Promise.resolve();
    live.status = "idle";

    if (workItemId && attempt !== null && persistence === "accepted") {
      await this.settleWithin(this.storage.projectChatWorkItems.markAccepted(
        workItemId,
        live.thread.id,
        live.thread.project_id,
        live.thread.user_id,
        attempt,
      ));
    } else if (workItemId && attempt !== null && persistence === "stopped") {
      const terminal = this.storage.projectChatWorkItems.finish({
        id: workItemId,
        thread_id: live.thread.id,
        project_id: live.thread.project_id,
        user_id: live.thread.user_id,
        attempt,
        status: "stopped",
        error: null,
        turn_end_id: this.terminalMessageId(workItemId, attempt),
        turn_end_content: JSON.stringify({ status: "stopped" }),
      }).then((result) => {
        if (this.liveThreads.get(live.thread.id) === live &&
          !this.lifecycle(live.thread.id).deleted) this.publishMessage(live, result.turnEnd);
        return result;
      });
      await this.settleWithin(terminal);
    }

    if (!resumeQueue) return;
    if (live.queue.length > 0 && !this.shuttingDown && !this.closingThreads.has(live.thread.id)) {
      this.pump(live);
    } else {
      this.broadcastStatus(live);
      this.scheduleEviction(live);
    }
  }

  private cancelEviction(live: LiveThread): void {
    if (!live.evictionTimer) return;
    clearTimeout(live.evictionTimer);
    live.evictionTimer = null;
  }

  private scheduleEviction(live: LiveThread): void {
    this.cancelEviction(live);
    if (this.shuttingDown || this.lifecycle(live.thread.id).deleted || live.activeWork ||
      live.status !== "idle" || live.queue.length > 0 || live.subscribers.size > 0) return;
    live.evictionTimer = setTimeout(() => {
      live.evictionTimer = null;
      if (this.liveThreads.get(live.thread.id) !== live || live.activeWork ||
        live.status !== "idle" || live.queue.length > 0 || live.subscribers.size > 0) return;
      this.liveThreads.delete(live.thread.id);
    }, this.idleEvictionMs);
    live.evictionTimer.unref?.();
  }

  private pump(live: LiveThread): void {
    if (live.activeWork || this.shuttingDown || this.closingThreads.has(live.thread.id)) return;
    const queued = live.queue.shift();
    if (!queued) return;
    this.cancelEviction(live);
    let work!: Promise<void>;
    work = this.runTurn(live, queued)
      .catch(() => undefined)
      .finally(() => {
        if (live.activeWork !== work) return;
        live.activeWork = null;
        live.activeWorkItemId = null;
        live.activeAttempt = null;
        live.abortController = null;
        if (live.queue.length > 0 && !this.shuttingDown && !this.closingThreads.has(live.thread.id)) {
          this.pump(live);
          return;
        }
        live.status = "idle";
        this.broadcastStatus(live);
        this.scheduleEviction(live);
      });
    live.activeWork = work;
  }

  private async runTurn(live: LiveThread, queued: QueuedTurn): Promise<void> {
    const abortController = new AbortController();
    const turnId = randomUUID();
    live.abortController = abortController;
    live.activeWorkItemId = queued.workId;
    live.activeTurnId = turnId;
    let attempt: number | null = null;
    try {
      const running = await this.storage.projectChatWorkItems.markRunning(
        queued.workId,
        live.thread.id,
        live.thread.project_id,
        live.thread.user_id,
      );
      if (!running) return;
      attempt = running.attempt;
      live.activeAttempt = attempt;
      live.status = "running";
      this.broadcastStatus(live);
      const futureUserMessages = new Set(live.queue.map((item) => item.userMessageId));
      const currentUserMessage = live.messages.find((message) => message.id === queued.userMessageId);
      const transcript = live.messages.filter((message) =>
        message.type !== "turn_end" && !futureUserMessages.has(message.id));
      const history = transcript.filter((message) => message.id !== queued.userMessageId);
      const input: ProjectChatRunInput = {
        projectId: live.thread.project_id,
        threadId: live.thread.id,
        userId: live.thread.user_id,
        messages: queued.wasRunning
          ? transcript
          : currentUserMessage ? [...history, currentUserMessage] : history,
        signal: abortController.signal,
        tools: this.toolDependencies
          ? await createProjectChatTools({
            projectId: live.thread.project_id,
            threadId: live.thread.id,
            userId: live.thread.user_id,
            storage: this.storage,
            ...this.toolDependencies,
          })
          : undefined,
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
            await this.append(live, queued, turnId, attempt, event.type, event.content, () => {
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
          await this.append(live, queued, turnId, attempt, event.type, event.content);
        }
      }
      if (!this.canPersistTurn(live, turnId)) return;
      const status = abortController.signal.aborted ? "stopped" : "completed";
      try {
        await this.finishWorkWithRetry(live, queued, turnId, attempt, status, null);
      } catch {
        // A terminal write failure leaves the work nonterminal for recovery.
      }
    } catch (error) {
      if (!this.canPersistTurn(live, turnId)) return;
      if (attempt === null) return;
      if (abortController.signal.aborted) {
        try {
          await this.finishWorkWithRetry(live, queued, turnId, attempt, "stopped", null);
        } catch {
          // A terminal write failure leaves the work nonterminal for recovery.
        }
        return;
      }
      try {
        await this.append(
          live,
          queued,
          turnId,
          attempt,
          "error",
          error instanceof Error ? error.message : String(error),
        );
        await this.finishWorkWithRetry(
          live,
          queued,
          turnId,
          attempt,
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
    const accepted = await this.storage.projectChatWorkItems.accept({
      id: input.id,
      user_message_id: input.userMessageId,
      thread_id: live.thread.id,
      project_id: live.thread.project_id,
      user_id: live.thread.user_id,
      content: input.content,
    });
    return {
      ...this.queueFromWorkItem(accepted.workItem),
      acceptedMessage: accepted.userMessage,
    };
  }

  private async finishWork(
    live: LiveThread,
    queued: QueuedTurn,
    turnId: string,
    attempt: number,
    status: "completed" | "stopped" | "failed",
    error: string | null,
    turnEndId: string = randomUUID(),
  ): Promise<ProjectChatMessage> {
    const previousWrite = live.writeTail;
    let release!: () => void;
    live.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previousWrite;
    try {
      if (!this.canPersistTurn(live, turnId)) throw new ProjectChatNotFoundError();
      const result = await this.storage.projectChatWorkItems.finish({
        id: queued.workId,
        thread_id: live.thread.id,
        project_id: live.thread.project_id,
        user_id: live.thread.user_id,
        attempt,
        is_current: () => this.canPersistTurn(live, turnId),
        status,
        error,
        turn_end_id: turnEndId,
        turn_end_content: JSON.stringify({
          status: status === "failed" ? "error" : status,
        }),
      });
      if (!this.canPersistTurn(live, turnId)) throw new ProjectChatNotFoundError();
      this.publishMessage(live, result.turnEnd);
      return result.turnEnd;
    } finally {
      release();
    }
  }

  private async finishWorkWithRetry(
    live: LiveThread,
    queued: QueuedTurn,
    turnId: string,
    attempt: number,
    status: "completed" | "stopped" | "failed",
    error: string | null,
  ): Promise<ProjectChatMessage> {
    const turnEndId = this.terminalMessageId(queued.workId, attempt);
    let lastError: unknown;
    for (let retry = 0; retry < this.terminalRetryAttempts; retry++) {
      const settled = await this.settleWithin(
        this.finishWork(live, queued, turnId, attempt, status, error, turnEndId),
        this.terminalAttemptTimeoutMs,
      );
      if (settled.status === "fulfilled") return settled.value;
      lastError = settled.status === "rejected"
        ? settled.reason
        : new Error("Project Chat terminal persistence timed out");
      if (settled.status === "timeout") live.writeTail = Promise.resolve();
      if (!this.canPersistTurn(live, turnId) || retry + 1 >= this.terminalRetryAttempts) break;
      await new Promise<void>((resolve) => setTimeout(resolve, this.terminalRetryDelayMs));
    }
    throw lastError;
  }

  private async append(
    live: LiveThread,
    queued: QueuedTurn,
    turnId: string,
    attempt: number,
    type: ProjectChatStreamEvent["type"] | "error",
    content: string,
    beforeBroadcast?: (message: ProjectChatMessage) => void,
  ): Promise<ProjectChatMessage> {
    const previousWrite = live.writeTail;
    let release!: () => void;
    live.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previousWrite;
    try {
      if (!this.canPersistTurn(live, turnId)) throw new ProjectChatNotFoundError();
      const message = await this.storage.projectChatWorkItems.appendEvent({
        id: queued.workId,
        thread_id: live.thread.id,
        project_id: live.thread.project_id,
        user_id: live.thread.user_id,
        attempt,
        is_current: () => this.canPersistTurn(live, turnId),
        message_id: randomUUID(),
        type,
        content,
      });
      if (!message) throw new ProjectChatNotFoundError();
      if (!this.canPersistTurn(live, turnId)) throw new ProjectChatNotFoundError();
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
      wasRunning: work.attempt > 0,
    };
  }
}
