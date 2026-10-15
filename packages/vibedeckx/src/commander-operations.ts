/**
 * Commander operation ledger — which chat session (and plan step) started which
 * process, recorded BEFORE the process starts so even an instant exit finds its
 * owner.
 *
 * Correlation is by exact identity only. An event whose processId was never
 * registered here is not the commander's, and is never attributed to it by
 * workspace, executor name or recency — the caller decides whether such an
 * event reaches the chat at all (only when the user opted into listening).
 *
 * In-memory: a hub restart forgets every operation, so results of operations
 * in flight across a restart arrive uncorrelated and are not attributed. There
 * is no cross-restart idempotency either.
 */

export type CommanderOperationStatus =
  /** Registered; the start request has not answered yet. */
  | "accepted"
  | "started"
  /** The start request was lost in transit; the process may or may not exist. */
  | "start_unknown"
  | "rejected"
  /** An unknown start whose identity a later call took over to resume it. */
  | "superseded"
  | "finished";

export interface CommanderExecutorOperation {
  /** Tool call id: a re-delivered call reuses it, a real retry gets a new one. */
  id: string;
  kind: "executor";
  chatSessionId: string;
  planId: string | null;
  stepId: string | null;
  executorId: string;
  executorName: string;
  /** "local" or the remote server id. */
  target: string;
  /** The identity the process runs under (`remote-…` for remote targets). */
  processId: string;
  status: CommanderOperationStatus;
  exitCode?: number;
}

export type ExecutorFinishMatch =
  | { kind: "matched"; operation: CommanderExecutorOperation }
  /** A second stop event for an operation that already finished. */
  | { kind: "duplicate"; operation: CommanderExecutorOperation }
  | { kind: "unmatched" };

/** Finished operations kept for duplicate detection; older ones are forgotten. */
const MAX_SETTLED_OPERATIONS = 500;

const isSettled = (status: CommanderOperationStatus) =>
  status === "finished" || status === "rejected" || status === "superseded";

export class CommanderOperationLedger {
  private byId = new Map<string, CommanderExecutorOperation>();
  private byProcessId = new Map<string, string>();

  get(operationId: string): CommanderExecutorOperation | undefined {
    return this.byId.get(operationId);
  }

  /** Register before starting. Returns the existing record for a re-delivered call. */
  register(operation: Omit<CommanderExecutorOperation, "status">): { operation: CommanderExecutorOperation; created: boolean } {
    const existing = this.byId.get(operation.id);
    if (existing) return { operation: existing, created: false };
    const created: CommanderExecutorOperation = { ...operation, status: "accepted" };
    this.byId.set(created.id, created);
    this.byProcessId.set(created.processId, created.id);
    this.prune();
    return { operation: created, created: true };
  }

  /**
   * This chat's own start of the executor on the target whose outcome is still
   * unknown. A new call resumes it under the same identity instead of starting
   * a second process or being refused as someone else's pending start.
   */
  findUnknownStart(chatSessionId: string, executorId: string, target: string): CommanderExecutorOperation | undefined {
    for (const operation of this.byId.values()) {
      if (operation.status === "start_unknown" && operation.chatSessionId === chatSessionId
        && operation.executorId === executorId && operation.target === target) return operation;
    }
    return undefined;
  }

  /** Hand an unknown start's process identity to the call resuming it. */
  supersede(operationId: string): void {
    const operation = this.byId.get(operationId);
    if (!operation || operation.status !== "start_unknown") return;
    operation.status = "superseded";
    if (this.byProcessId.get(operation.processId) === operationId) this.byProcessId.delete(operation.processId);
  }

  /** Record the start outcome. A finish that already arrived is never overwritten. */
  settleStart(operationId: string, status: "started" | "start_unknown" | "rejected"): void {
    const operation = this.byId.get(operationId);
    if (!operation) return;
    if (operation.status === "finished") return;
    operation.status = status;
    if (status === "rejected") this.byProcessId.delete(operation.processId);
  }

  /** Follow the identity a start actually used when it differs from the requested one. */
  rebindProcess(operationId: string, processId: string): void {
    const operation = this.byId.get(operationId);
    if (!operation || operation.processId === processId) return;
    if (this.byProcessId.get(operation.processId) === operationId) this.byProcessId.delete(operation.processId);
    operation.processId = processId;
    this.byProcessId.set(processId, operationId);
  }

  /** A start confirmed out of band (e.g. after a remote reconnects). */
  markStarted(processId: string): void {
    const operation = this.byProcess(processId);
    if (operation && (operation.status === "accepted" || operation.status === "start_unknown")) {
      operation.status = "started";
    }
  }

  finishExecutor(processId: string, exitCode: number): ExecutorFinishMatch {
    const operation = this.byProcess(processId);
    if (!operation) return { kind: "unmatched" };
    if (operation.status === "finished") return { kind: "duplicate", operation };
    operation.status = "finished";
    operation.exitCode = exitCode;
    this.prune();
    return { kind: "matched", operation };
  }

  /**
   * Detach a chat session's operations (conversation reset or session gone).
   * Their later events no longer have an owner and are treated as unmatched.
   */
  forgetSession(chatSessionId: string): void {
    for (const [id, operation] of this.byId) {
      if (operation.chatSessionId !== chatSessionId) continue;
      this.byId.delete(id);
      this.byProcessId.delete(operation.processId);
    }
  }

  private byProcess(processId: string): CommanderExecutorOperation | undefined {
    const id = this.byProcessId.get(processId);
    return id ? this.byId.get(id) : undefined;
  }

  private prune(): void {
    let settled = 0;
    for (const operation of this.byId.values()) if (isSettled(operation.status)) settled++;
    // Map iteration is insertion order, so the oldest settled operations go first.
    for (const [id, operation] of this.byId) {
      if (settled <= MAX_SETTLED_OPERATIONS) break;
      if (!isSettled(operation.status)) continue;
      this.byId.delete(id);
      if (this.byProcessId.get(operation.processId) === id) this.byProcessId.delete(operation.processId);
      settled--;
    }
  }
}

export interface AgentDispatch {
  /** Tool call id of the spawn / send that dispatched the task. */
  id: string;
  chatSessionId: string;
  agentSessionId: string;
  /** Turn ends at or before this entry index predate the dispatch. */
  afterEntryIndex: number;
}

export type AgentTurnMatch =
  | { kind: "matched"; dispatch: AgentDispatch }
  /** A repeated completion for a turn end already credited to a dispatch. */
  | { kind: "duplicate"; dispatch: AgentDispatch }
  | { kind: "unmatched" };

/** Turn ends remembered per agent session for duplicate detection. */
const MAX_SETTLED_TURNS = 500;

/**
 * Tasks the commander dispatched to coding-agent sessions, matched to their
 * completions by turn-end entry index — never by "the session's latest task".
 *
 * Agents run turns one after another, and the commander only dispatches to an
 * idle agent, so the turn ending at index T was opened by the latest dispatch
 * whose user entry precedes T. A completion without a turn-end index, or with
 * one no pending dispatch precedes, is not attributed.
 *
 * Residual: a dispatch's floor is the latest turn end known at dispatch time.
 * A previous turn's completion still in flight at that moment (remote stream
 * lag) would land above a stale floor. In-memory like the executor ledger.
 */
export class AgentDispatchLedger<Completion> {
  private pending = new Map<string, AgentDispatch[]>();
  private settled = new Map<string, AgentDispatch>();
  private lastTurnEnd = new Map<string, number>();
  /** Latest unattributed completion per agent session, for a dispatch registered after it arrived. */
  private unclaimed = new Map<string, { turnEndEntryIndex: number; completion: Completion }>();

  /** The latest turn end seen for the agent session, or -1. */
  lastTurnEndOf(agentSessionId: string): number {
    return this.lastTurnEnd.get(agentSessionId) ?? -1;
  }

  /**
   * Register a dispatch. Returns the completion it already owns when that
   * arrived first (a spawn's session id is only known once it activated); the
   * caller delivers it then.
   */
  register(dispatch: AgentDispatch): Completion | null {
    const list = this.pending.get(dispatch.agentSessionId) ?? [];
    if (list.some((entry) => entry.id === dispatch.id)) return null;
    const early = this.unclaimed.get(dispatch.agentSessionId);
    if (early && early.turnEndEntryIndex > dispatch.afterEntryIndex) {
      this.unclaimed.delete(dispatch.agentSessionId);
      this.settle(dispatch.agentSessionId, early.turnEndEntryIndex, dispatch);
      return early.completion;
    }
    list.push(dispatch);
    this.pending.set(dispatch.agentSessionId, list);
    return null;
  }

  /** Withdraw a dispatch whose delivery failed. */
  cancel(agentSessionId: string, dispatchId: string): void {
    const list = this.pending.get(agentSessionId)?.filter((entry) => entry.id !== dispatchId) ?? [];
    if (list.length > 0) this.pending.set(agentSessionId, list);
    else this.pending.delete(agentSessionId);
  }

  finishTurn(agentSessionId: string, turnEndEntryIndex: number | undefined, completion: Completion): AgentTurnMatch {
    if (turnEndEntryIndex === undefined) return { kind: "unmatched" };
    const seen = this.settled.get(`${agentSessionId}:${turnEndEntryIndex}`);
    if (seen) return { kind: "duplicate", dispatch: seen };
    this.lastTurnEnd.set(agentSessionId, Math.max(this.lastTurnEndOf(agentSessionId), turnEndEntryIndex));

    const list = this.pending.get(agentSessionId) ?? [];
    let owner: AgentDispatch | undefined;
    for (const entry of list) {
      if (entry.afterEntryIndex < turnEndEntryIndex && (!owner || entry.afterEntryIndex >= owner.afterEntryIndex)) owner = entry;
    }
    if (!owner) {
      this.unclaimed.delete(agentSessionId);
      this.unclaimed.set(agentSessionId, { turnEndEntryIndex, completion });
      for (const key of this.unclaimed.keys()) {
        if (this.unclaimed.size <= MAX_SETTLED_TURNS) break;
        this.unclaimed.delete(key);
      }
      return { kind: "unmatched" };
    }
    // Dispatches preceding this turn end can no longer own a later one.
    const rest = list.filter((entry) => entry.afterEntryIndex >= turnEndEntryIndex);
    if (rest.length > 0) this.pending.set(agentSessionId, rest);
    else this.pending.delete(agentSessionId);
    this.settle(agentSessionId, turnEndEntryIndex, owner);
    return { kind: "matched", dispatch: owner };
  }

  forgetChat(chatSessionId: string): void {
    for (const [agentSessionId, list] of this.pending) {
      const rest = list.filter((entry) => entry.chatSessionId !== chatSessionId);
      if (rest.length > 0) this.pending.set(agentSessionId, rest);
      else this.pending.delete(agentSessionId);
    }
  }

  private settle(agentSessionId: string, turnEndEntryIndex: number, dispatch: AgentDispatch): void {
    this.settled.set(`${agentSessionId}:${turnEndEntryIndex}`, dispatch);
    for (const key of this.settled.keys()) {
      if (this.settled.size <= MAX_SETTLED_TURNS) break;
      this.settled.delete(key);
    }
  }
}
