import { createHash, randomUUID } from "crypto";
import { stepCountIs, streamText, tool, type ToolSet } from "ai";
import type WebSocket from "ws";
import type { EventBus, GlobalEvent } from "./event-bus.js";
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
  "You are Project Commander, a project-scoped assistant with a small safe mutation surface.",
  "You can inspect tasks, schedules, agent sessions, and multiple workspaces within the bound project.",
  "Project Chat does not belong to a branch or workspace; never assume one workspace is the whole project.",
  "You may create a task, update a task, create an agent session in an explicitly selected existing workspace, select a requested workspace, send an agent instruction, and run an existing schedule now.",
  "Use supplied tools for factual context and report mutations only from successful tool results.",
  "There is no delete capability, no worktree creation, no schedule configuration, no agent-session stop, and no Git capability.",
].join(" ");
export const PROJECT_CHAT_TOOL_CALL_LIMIT = 8;
export const PROJECT_CHAT_TOOL_RESULT_BYTE_LIMIT = 64 * 1024;

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
  reconciliationIntervalMs?: number;
  toolDependencies?: Pick<CreateProjectChatToolsOptions, "agentSessionManager" | "remoteSessions" | "mutationServices">;
  eventBus?: EventBus;
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

const PROJECT_CHAT_STREAM_ERROR_LIMIT = 512;

function boundedStreamError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.length <= PROJECT_CHAT_STREAM_ERROR_LIMIT
    ? raw
    : `${raw.slice(0, PROJECT_CHAT_STREAM_ERROR_LIMIT)}…`;
  return new Error(message || "Project Chat model stream failed");
}

export async function* adaptProjectChatFullStream(
  fullStream: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProjectChatStreamEvent> {
  let content = "";
  const flush = (): ProjectChatStreamEvent | undefined => {
    if (!content) return undefined;
    const event: ProjectChatStreamEvent = { type: "assistant", content };
    content = "";
    return event;
  };

  for await (const rawPart of fullStream) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as Record<string, unknown>;
    if (part.type === "text-delta" && typeof part.text === "string") {
      content += part.text;
      continue;
    }
    const pending = flush();
    if (pending) yield pending;
    if (part.type === "tool-call") {
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
      const error = boundedStreamError(part.error);
      yield {
        type: "tool_result",
        content: JSON.stringify({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          error: error.message,
        }),
      };
    } else if (part.type === "error") {
      throw boundedStreamError(part.error);
    } else if (part.type === "abort") {
      if (signal.aborted) return;
      throw new Error("Project Chat model stream aborted unexpectedly");
    }
  }
  const pending = flush();
  if (pending) yield pending;
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

    yield* adaptProjectChatFullStream(result.fullStream, input.signal);
  }
}

export function projectChatAiTools(domainTools: ProjectChatTools): ToolSet {
  const adapted: ToolSet = {};
  let reservedCalls = 0;
  let resultBytes = 0;
  for (const [name, entry] of Object.entries(domainTools)) {
    const generic = entry as ProjectChatTool<unknown, unknown>;
    adapted[name] = tool({
      description: generic.description,
      inputSchema: generic.inputSchema,
      execute: async (args) => {
        if (reservedCalls >= PROJECT_CHAT_TOOL_CALL_LIMIT) {
          throw new Error(`Project Chat tool call budget exceeded (${PROJECT_CHAT_TOOL_CALL_LIMIT} per turn)`);
        }
        reservedCalls++;
        const result = await generic.execute(args);
        let serialized: string;
        try {
          serialized = JSON.stringify(result) ?? "null";
        } catch {
          throw new Error("Project Chat tool result could not be serialized");
        }
        const bytes = Buffer.byteLength(serialized, "utf8");
        if (resultBytes + bytes > PROJECT_CHAT_TOOL_RESULT_BYTE_LIMIT) {
          throw new Error(`Project Chat tool result byte budget exceeded (${PROJECT_CHAT_TOOL_RESULT_BYTE_LIMIT} per turn)`);
        }
        resultBytes += bytes;
        return result;
      },
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
  private readonly reconciliationIntervalMs: number;
  private readonly toolDependencies?: ProjectChatManagerOptions["toolDependencies"];
  private readonly unsubscribeEvents?: () => void;
  private readonly startupReconciliation: Promise<void>;
  private reconciliationCursor: string | null = null;
  private reconciliationTimer: ReturnType<typeof setTimeout> | null = null;
  private reconciliationDelayMs = 100;
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
    this.reconciliationIntervalMs = Math.max(1, options.reconciliationIntervalMs ?? 1_000);
    this.reconciliationDelayMs = Math.min(100, this.reconciliationIntervalMs);
    this.toolDependencies = options.toolDependencies;
    this.unsubscribeEvents = options.eventBus?.subscribe((event) => {
      if (this.shuttingDown) return;
      void this.trackOperation(this.handleCorrelatedEvent(event)).catch(() => undefined);
    });
    this.startupReconciliation = this.trackOperation(this.reconcilePersistedOperations(2))
      .catch(() => {
        this.reconciliationDelayMs = Math.min(this.reconciliationDelayMs * 2, 5_000);
      })
      .finally(() => this.scheduleReconciliation(
        this.reconciliationCursor === null
          ? Math.max(this.reconciliationIntervalMs, this.reconciliationDelayMs) : 0,
      ));
  }

  /** Resolves after the bounded startup operation-journal reconciliation. */
  ready(): Promise<void> { return this.startupReconciliation; }

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
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer);
    this.reconciliationTimer = null;
    this.unsubscribeEvents?.();
    for (const live of this.liveThreads.values()) {
      this.cancelEviction(live);
      this.settlePendingApprovals(live, live.activeTurnId, false);
      live.abortController?.abort();
      live.queue.splice(0);
    }
    await Promise.race([
      Promise.allSettled([...this.outstandingOperations]),
      new Promise<void>((resolve) => setTimeout(resolve, this.drainTimeoutMs)),
    ]);
    await Promise.all([...this.liveThreads.values()]
      .map((live) => this.detachActiveWork(live, "accepted", false)));
    for (const live of this.liveThreads.values()) live.subscribers.clear();
  }

  private async handleCorrelatedEvent(event: GlobalEvent): Promise<void> {
    let entityType: "agent_session" | "schedule_run";
    let entityId: string;
    let status: "running" | "completed" | "failed";
    let expectedKind: "agent_session_create" | "schedule_run";
    if (event.type === "session:taskCompleted" || event.type === "session:finished") {
      entityType = "agent_session";
      entityId = event.sessionId;
      status = "completed";
      expectedKind = "agent_session_create";
    } else if (event.type === "session:status" && event.status === "error") {
      entityType = "agent_session";
      entityId = event.sessionId;
      status = "failed";
      expectedKind = "agent_session_create";
    } else if (event.type === "session:status" && event.status === "running") {
      entityType = "agent_session";
      entityId = event.sessionId;
      status = "running";
      expectedKind = "agent_session_create";
    } else if (event.type === "schedule:run-started") {
      entityType = "schedule_run";
      entityId = event.runId;
      status = "running";
      expectedKind = "schedule_run";
    } else if (event.type === "schedule:run-finished") {
      entityType = "schedule_run";
      entityId = event.runId;
      status = event.status === "completed" || event.status === "skipped" ? "completed" : "failed";
      expectedKind = "schedule_run";
    } else {
      return;
    }

    const operations = await this.storage.projectChatOperations.listByCorrelation(
      event.projectId, entityType, entityId, 100,
    );
    for (const operation of operations) {
      if (operation.kind !== expectedKind) continue;
      if (expectedKind === "agent_session_create"
        && (operation.payload.kind !== "agent_session_create"
          || operation.payload.initialInstructionDelivery !== "confirmed")) continue;
      if (expectedKind === "schedule_run") {
        if (operation.payload.kind !== "schedule_run"
          || operation.payload.scheduleId !== (event as { scheduleId: string }).scheduleId
          || operation.payload.contextConfirmed !== true) continue;
      }
      const details = expectedKind === "agent_session_create"
        ? { sessionId: entityId }
        : { scheduleId: (event as { scheduleId: string }).scheduleId, runId: entityId };
      const transitioned = await this.transitionOperation(
        operation, status, details, status === "failed" ? "Operation failed" : null,
      );
      if (!transitioned?.changed) continue;
      const live = this.liveThreads.get(operation.thread_id);
      if (live && live.thread.project_id === operation.project_id
        && live.thread.user_id === operation.user_id) {
        this.publishMessage(live, transitioned.message);
      }
    }
  }

  private async transitionOperation(
    operation: import("./storage/types.js").ProjectChatOperation,
    status: "running" | "completed" | "failed",
    details: Record<string, unknown>,
    error: string | null = null,
  ) {
    const payload = { ...operation.payload, status, ...details } as import("./storage/types.js").ProjectChatOperationPayload;
    const { initialInstructionDelivery: _delivery, contextConfirmed: _context, ...publicPayload } = payload as typeof payload & {
      initialInstructionDelivery?: unknown; contextConfirmed?: unknown;
    };
    const content = JSON.stringify(publicPayload);
    return this.storage.projectChatOperations.transition({
      id: operation.id, thread_id: operation.thread_id,
      project_id: operation.project_id, user_id: operation.user_id,
      status, payload, error,
      message: { id: `operation:${operation.id}:${status}`, content },
    });
  }

  private scheduleReconciliation(delayMs: number): void {
    if (this.shuttingDown || this.reconciliationTimer) return;
    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = null;
      if (this.shuttingDown) return;
      void this.trackOperation(this.reconcilePersistedOperations(2)).then(() => {
        this.reconciliationDelayMs = 100;
        this.scheduleReconciliation(
          this.reconciliationCursor === null ? this.reconciliationIntervalMs : 0,
        );
      }).catch(() => {
        this.reconciliationDelayMs = Math.min(this.reconciliationDelayMs * 2, 5_000);
        this.scheduleReconciliation(this.reconciliationDelayMs);
      });
    }, delayMs);
    this.reconciliationTimer.unref?.();
  }

  private async reconcilePersistedOperations(maxPages: number): Promise<void> {
    for (let pages = 0; pages < maxPages; pages++) {
      if (this.shuttingDown) return;
      const page = await this.storage.projectChatOperations.listNonterminal(this.reconciliationCursor, 50);
      if (page.malformed > 0) {
        console.warn(`[ProjectChat] skipped ${page.malformed} malformed operation row(s)`);
      }
      let retryableFailure = false;
      for (const operation of page.operations) {
        if (this.shuttingDown) return;
        try {
          await this.reconcilePersistedOperation(operation);
        } catch (error) {
          retryableFailure = true;
          console.warn(`[ProjectChat] reconciliation failed for ${operation.id}:`, boundedStreamError(error).message);
        }
      }
      if (retryableFailure) {
        this.reconciliationCursor = null;
        throw new Error("One or more Project Chat operations remain retryable");
      }
      if (!page.hasMore || page.nextCursor === null) {
        this.reconciliationCursor = null;
        return;
      }
      this.reconciliationCursor = page.nextCursor;
    }
  }

  private async reconcilePersistedOperation(
    operation: import("./storage/types.js").ProjectChatOperation,
  ): Promise<void> {
    const ownedThread = await this.storage.projectChatThreads.getById(
      operation.thread_id, operation.project_id, operation.user_id,
    );
    if (!ownedThread) return;
    if (operation.kind === "task_create" && operation.payload.kind === "task_create") {
      const payload = operation.payload;
      let task = await this.storage.tasks.getById(payload.taskId);
      if (task && task.project_id !== operation.project_id) {
        await this.transitionOperation(operation, "failed", {}, "Task identity is already in use");
        return;
      }
      if (!task) {
        if (!payload.title) return;
        try {
          task = await this.storage.tasks.create({
            id: payload.taskId, project_id: operation.project_id, title: payload.title,
            description: payload.description ?? null, status: payload.taskStatus ?? "todo",
            priority: payload.priority ?? "medium", assigned_branch: payload.assignedBranch ?? null,
          });
        } catch (error) {
          console.warn(`[ProjectChat] task create ${operation.id} remains retryable:`, boundedStreamError(error).message);
          throw error;
        }
      }
      if (!(await this.restoreOperationContext(operation, [
        { entityType: "task", entityId: payload.taskId },
      ]))) return;
      await this.transitionOperation(operation, "completed", { taskId: task.id, title: task.title });
      return;
    }
    if (operation.kind === "task_update" && operation.payload.kind === "task_update") {
      const payload = operation.payload;
      const task = await this.storage.tasks.getById(payload.taskId);
      if (!task || task.project_id !== operation.project_id) {
        await this.transitionOperation(operation, "failed", {}, "Task is no longer authorized");
        return;
      }
      if (!payload.patch || !payload.before) return;
      const current = {
        title: task.title, description: task.description, status: task.status,
        priority: task.priority, assignedBranch: task.assigned_branch,
      };
      const desiredMatches = Object.entries(payload.patch)
        .every(([key, value]) => current[key as keyof typeof current] === value);
      if (!desiredMatches) {
        const beforeMatches = Object.keys(payload.patch)
          .every((key) => current[key as keyof typeof current] === payload.before![key as keyof typeof current]);
        if (!beforeMatches) {
          await this.transitionOperation(operation, "failed", {}, "Task changed while recovery was pending");
          return;
        }
        try {
          const { assignedBranch, ...patch } = payload.patch;
          const updated = await this.storage.tasks.update(payload.taskId, {
            ...patch, ...(assignedBranch !== undefined ? { assigned_branch: assignedBranch } : {}),
          });
          if (!updated) throw new Error("Task update failed");
        } catch (error) {
          console.warn(`[ProjectChat] task update ${operation.id} remains retryable:`, boundedStreamError(error).message);
          throw error;
        }
      }
      const confirmed = await this.storage.tasks.getById(payload.taskId);
      if (!confirmed || confirmed.project_id !== operation.project_id) return;
      if (!(await this.restoreOperationContext(operation, [
        { entityType: "task", entityId: payload.taskId },
      ]))) return;
      await this.transitionOperation(operation, "completed", { taskId: confirmed.id, title: confirmed.title });
      return;
    }
    if (operation.kind === "agent_session_create" && operation.payload.kind === "agent_session_create") {
      const sessionId = operation.entity_id ?? operation.payload.sessionId;
      if (!operation.entity_id) return; // unresolved user selection
      const payload = operation.payload;
      if (payload.workspaceId && payload.target
        && payload.workspaceId !== JSON.stringify([payload.target, payload.branch ?? null])) {
        await this.transitionOperation(operation, "failed", {}, "Workspace is no longer authorized");
        return;
      }
      const local = await this.storage.agentSessions.getById(sessionId);
      if (local?.project_id === operation.project_id && operation.status === "running"
        && operation.payload.initialInstructionDelivery === "confirmed") {
        const status = local.status === "error" ? "failed"
          : local.status === "stopped" && local.last_completed_at ? "completed"
            : local.status === "stopped" ? "failed" : "running";
        if (!(await this.restoreOperationContext(operation, [
          { entityType: "workspace", entityId: operation.payload.workspaceId },
          { entityType: "agent_session", entityId: sessionId },
        ]))) return;
        await this.transitionOperation(operation, status, { sessionId }, status === "failed" ? "Agent session failed" : null);
        return;
      }
      const remote = await this.toolDependencies?.remoteSessions?.getMapping(sessionId);
      if (remote?.projectId === operation.project_id && operation.status === "running"
        && operation.payload.initialInstructionDelivery === "confirmed"
        && remote.remoteServerId === payload.target
        && await this.storage.projectRemotes.getByProjectAndServer(operation.project_id, remote.remoteServerId)) {
        const detail = await this.toolDependencies?.remoteSessions?.getDetail(remote, {
          maxEntries: 1, maxChars: 256,
        });
        const status = detail?.status === "error" ? "failed"
          : detail?.status === "stopped" ? "completed" : "running";
        if (!(await this.restoreOperationContext(operation, [
          { entityType: "workspace", entityId: operation.payload.workspaceId },
          { entityType: "agent_session", entityId: sessionId },
        ]))) return;
        await this.transitionOperation(operation, status, { sessionId }, status === "failed" ? "Agent session failed" : null);
        return;
      }
      const service = this.toolDependencies?.mutationServices;
      if (!service || !payload.workspaceId || !payload.target || payload.instruction === undefined
        || !payload.permissionMode || !payload.agentType) return;
      if (payload.target !== "local" && !(await this.storage.projectRemotes.getByProjectAndServer(
        operation.project_id, payload.target,
      ))) {
        await this.transitionOperation(operation, "failed", {}, "Workspace is no longer authorized");
        return;
      }
      try {
        const created = await service.createAgentSession({
          sessionId, workerSessionId: payload.workerSessionId ?? sessionId,
          idempotencyKey: operation.idempotency_key,
          projectId: operation.project_id, userId: operation.user_id,
          target: payload.target, branch: payload.branch ?? null,
          instruction: payload.instruction,
          permissionMode: payload.permissionMode as "plan" | "edit",
          agentType: payload.agentType as "claude-code" | "codex",
          model: payload.model ?? null,
        });
        if (created.sessionId !== sessionId) throw new Error("Session identity mismatch");
        if (!(await this.restoreOperationContext(operation, [
          { entityType: "workspace", entityId: payload.workspaceId },
          { entityType: "agent_session", entityId: sessionId },
        ]))) return;
        const confirmed = await this.transitionOperation(operation, "running", {
          sessionId, initialInstructionDelivery: "confirmed",
        });
        if (confirmed) {
          const latestLocal = await this.storage.agentSessions.getById(sessionId);
          if (latestLocal?.project_id === operation.project_id && latestLocal.status !== "running") {
            const latestStatus = latestLocal.status === "stopped" && latestLocal.last_completed_at
              ? "completed" : "failed";
            await this.transitionOperation(confirmed.operation, latestStatus, { sessionId },
              latestStatus === "failed" ? "Agent session failed" : null);
          } else if (payload.target !== "local") {
            const latestRemote = await this.toolDependencies?.remoteSessions?.getMapping(sessionId);
            if (latestRemote?.projectId === operation.project_id) {
              const detail = await this.toolDependencies?.remoteSessions?.getDetail(latestRemote, {
                maxEntries: 1, maxChars: 256,
              });
              if (detail?.status === "error" || detail?.status === "stopped") {
                const latestStatus = detail.status === "stopped" ? "completed" : "failed";
                await this.transitionOperation(confirmed.operation, latestStatus, { sessionId },
                  latestStatus === "failed" ? "Agent session failed" : null);
              }
            }
          }
        }
      } catch (error) {
        const currentRemote = await this.toolDependencies?.remoteSessions?.getMapping(sessionId);
        const exists = (await this.storage.agentSessions.getById(sessionId))?.project_id === operation.project_id
          || (currentRemote?.projectId === operation.project_id
            && currentRemote.remoteServerId === payload.target
            && Boolean(await this.storage.projectRemotes.getByProjectAndServer(
              operation.project_id, currentRemote.remoteServerId,
            )));
        if (!exists && error instanceof Error && error.message === "Session identity mismatch") {
          await this.transitionOperation(operation, "failed", { sessionId }, boundedStreamError(error).message);
        } else {
          console.warn(`[ProjectChat] session operation ${operation.id} remains retryable:`, boundedStreamError(error).message);
          throw error;
        }
      }
      return;
    }
    if (operation.kind === "agent_instruction" && operation.payload.kind === "agent_instruction"
      && operation.payload.delivery !== "confirmed") {
      const service = this.toolDependencies?.mutationServices;
      if (!service || !operation.payload.instruction || !operation.payload.target) return;
      try {
        if (operation.payload.target === "local") {
          const session = await this.storage.agentSessions.getById(operation.payload.sessionId);
          if (!session || session.project_id !== operation.project_id) {
            throw new Error("Agent session is no longer authorized");
          }
        } else {
          const mapping = await this.toolDependencies?.remoteSessions?.getMapping(operation.payload.sessionId);
          if (!mapping || mapping.projectId !== operation.project_id
            || mapping.remoteServerId !== operation.payload.target.remoteServerId
            || mapping.remoteSessionId !== operation.payload.target.remoteSessionId
            || !(await this.storage.projectRemotes.getByProjectAndServer(
              operation.project_id, mapping.remoteServerId,
            ))) {
            throw new Error("Agent session is no longer authorized");
          }
        }
        const sent = await service.sendAgentInstruction({
          projectId: operation.project_id, userId: operation.user_id,
          sessionId: operation.payload.sessionId, instruction: operation.payload.instruction,
          target: operation.payload.target, idempotencyKey: operation.idempotency_key,
        });
        if (!sent) throw new Error("Agent session did not accept the instruction");
        if (!(await this.restoreOperationContext(operation, [
          { entityType: "agent_session", entityId: operation.payload.sessionId },
        ]))) return;
        await this.transitionOperation(operation, "completed", { delivery: "confirmed" });
      } catch (error) {
        const message = boundedStreamError(error).message;
        if (message.includes("no longer authorized")) {
          await this.transitionOperation(operation, "failed", { delivery: "pending" }, message);
        } else {
          console.warn(`[ProjectChat] instruction operation ${operation.id} remains retryable:`, message);
          throw error;
        }
      }
      return;
    }
    if (operation.kind === "schedule_run" && operation.payload.kind === "schedule_run") {
      const schedule = await this.storage.scheduledTasks.getById(operation.payload.scheduleId);
      if (!schedule || schedule.project_id !== operation.project_id) {
        await this.transitionOperation(operation, "failed", {}, "Schedule is no longer authorized");
        return;
      }
      const run = await this.storage.scheduledTaskRuns.getById(operation.payload.runId);
      if (run?.project_id === operation.project_id && run.schedule_id === operation.payload.scheduleId) {
        const status = run.status === "starting" || run.status === "running" ? "running"
          : run.status === "completed" || run.status === "skipped" ? "completed" : "failed";
        if (!(await this.restoreOperationContext(operation, [
          { entityType: "schedule", entityId: operation.payload.scheduleId },
          { entityType: "schedule_run", entityId: operation.payload.runId },
        ]))) return;
        await this.transitionOperation(operation, status, {
          scheduleId: operation.payload.scheduleId, runId: operation.payload.runId, contextConfirmed: true,
        }, status === "failed" ? "Schedule run failed" : null);
        return;
      }
      if (operation.status === "pending" && this.toolDependencies?.mutationServices) {
        const result = await this.toolDependencies.mutationServices.runScheduleNow(
          operation.payload.scheduleId, operation.payload.runId,
        );
        const [persisted, authorizedSchedule] = await Promise.all([
          this.storage.scheduledTaskRuns.getById(operation.payload.runId),
          this.storage.scheduledTasks.getById(operation.payload.scheduleId),
        ]);
        if (!authorizedSchedule || authorizedSchedule.project_id !== operation.project_id) {
          await this.transitionOperation(operation, "failed", {}, "Schedule is no longer authorized");
        } else if (!("error" in result) && result.runId !== operation.payload.runId) {
          await this.transitionOperation(operation, "failed", {}, "Schedule run identity mismatch");
        } else if (persisted?.project_id === operation.project_id
          && persisted.schedule_id === operation.payload.scheduleId) {
          if (!(await this.restoreOperationContext(operation, [
            { entityType: "schedule", entityId: operation.payload.scheduleId },
            { entityType: "schedule_run", entityId: operation.payload.runId },
          ]))) return;
          const status = persisted.status === "starting" || persisted.status === "running" ? "running"
            : persisted.status === "completed" || persisted.status === "skipped" ? "completed" : "failed";
          const confirmed = await this.transitionOperation(operation, status, { contextConfirmed: true },
            status === "failed" ? "Schedule run failed" : null);
          if (confirmed && status === "running") {
            const latest = await this.storage.scheduledTaskRuns.getById(operation.payload.runId);
            if (latest?.project_id === operation.project_id
              && latest.schedule_id === operation.payload.scheduleId
              && latest.status !== "starting" && latest.status !== "running") {
              const latestStatus = latest.status === "completed" || latest.status === "skipped"
                ? "completed" : "failed";
              await this.transitionOperation(confirmed.operation, latestStatus, {},
                latestStatus === "failed" ? "Schedule run failed" : null);
            }
          }
        } else if ("error" in result) {
          console.warn(`[ProjectChat] schedule operation ${operation.id} remains retryable:`, boundedStreamError(result.error).message);
          throw new Error(result.error);
        }
      }
    }
  }

  private async restoreOperationContext(
    operation: import("./storage/types.js").ProjectChatOperation,
    refs: Array<{ entityType: import("./storage/types.js").ProjectChatContextEntityType; entityId?: string }>,
  ): Promise<boolean> {
    if (refs.some(({ entityId }) => !entityId)) return false;
    try {
      return Boolean(await this.storage.projectChatContextRefs.touchMany(
        operation.thread_id, operation.project_id, operation.user_id,
        refs as Array<{ entityType: import("./storage/types.js").ProjectChatContextEntityType; entityId: string }>,
      ));
    } catch {
      return false;
    }
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
