/**
 * What a Main Chat commander still owes: the results of work it started that
 * have not come back yet. One registry per chat session, fed by the four
 * sources that each keep their own identity matching — the executor operation
 * ledger, the agent dispatch ledger, spawns being activated and terminal
 * watchers. The registry only answers "is anything still owed, and what".
 *
 * Every item reaches exactly one outcome. Registering an id whose item already
 * settled starts a new item under that id (a terminal watcher restarted on the
 * same terminal, a start reported unconfirmed and then confirmed after all).
 *
 * Design: docs/commander-turn-model-design.md §4.1. The turn object that will
 * own this registry comes later; for now it hangs off the chat session.
 */

export type PendingKind = "executor" | "agent_dispatch" | "spawn" | "terminal_watch";

/** Outcome vocabulary borrowed from eve: a fact about the work, never a guess. */
export type PendingOutcome = "completed" | "failed" | "cancelled" | "interrupted";

export interface PendingItem {
  /** Identity within its kind: operation id, dispatch id, spawn tool call id, terminal id. */
  id: string;
  kind: PendingKind;
  /** What is being waited for, in words the model and the UI can show. */
  label: string;
  planId: string | null;
  stepId: string | null;
  registeredAt: number;
  outcome: PendingOutcome | null;
  settledAt: number | null;
}

/** Settled items kept for inspection; older ones are forgotten. */
const MAX_SETTLED_ITEMS = 200;

export class PendingRegistry {
  private items = new Map<string, PendingItem>();

  /** Start owing a result. Returns the open item when one is already registered under the id. */
  register(
    item: { kind: PendingKind; id: string; label: string; planId?: string | null; stepId?: string | null },
    now = Date.now(),
  ): PendingItem {
    const key = keyOf(item.kind, item.id);
    const existing = this.items.get(key);
    if (existing && existing.outcome === null) return existing;
    // Re-inserted so a re-registered id moves to the back of the pruning order.
    this.items.delete(key);
    const created: PendingItem = {
      id: item.id,
      kind: item.kind,
      label: item.label,
      planId: item.planId ?? null,
      stepId: item.stepId ?? null,
      registeredAt: now,
      outcome: null,
      settledAt: null,
    };
    this.items.set(key, created);
    return created;
  }

  /** Record the outcome. Returns the item, or null when it is unknown or already settled. */
  settle(kind: PendingKind, id: string, outcome: PendingOutcome, now = Date.now()): PendingItem | null {
    const item = this.items.get(keyOf(kind, id));
    if (!item || item.outcome !== null) return null;
    item.outcome = outcome;
    item.settledAt = now;
    this.prune();
    return item;
  }

  isOpen(kind: PendingKind, id: string): boolean {
    return this.items.get(keyOf(kind, id))?.outcome === null;
  }

  /** Items whose result has not come back, oldest first. */
  open(): PendingItem[] {
    return [...this.items.values()].filter((item) => item.outcome === null);
  }

  hasOpen(): boolean {
    for (const item of this.items.values()) if (item.outcome === null) return true;
    return false;
  }

  /**
   * Drop every item of a kind without an outcome, for a source that forgot its
   * own records (a conversation reset detaches executor operations and agent
   * dispatches; their late results no longer belong to anyone).
   */
  forget(kind: PendingKind): void {
    for (const [key, item] of this.items) if (item.kind === kind) this.items.delete(key);
  }

  private prune(): void {
    let settled = 0;
    for (const item of this.items.values()) if (item.outcome !== null) settled++;
    for (const [key, item] of this.items) {
      if (settled <= MAX_SETTLED_ITEMS) break;
      if (item.outcome === null) continue;
      this.items.delete(key);
      settled--;
    }
  }
}

const keyOf = (kind: PendingKind, id: string) => `${kind}:${id}`;

/** Who opened a turn. `parent_dispatch` and `schedule` arrive with the multi-level commander and scheduled chats. */
export type TurnOpenedBy = "user" | "listened_event";

/**
 * Something entering the conversation. `result`: the outcome of work this chat
 * started. `notice`: an event the user chose to listen to. `browser`: a
 * page-controlled event, summarized in a turn of its own without tools.
 * `nudge`: the turn contract re-driving the model. `wait_timeout`: a `wait`
 * call ran out with work still running.
 */
export interface TurnArrival {
  source: "user" | "result" | "notice" | "browser" | "nudge" | "wait_timeout";
  content: string;
  /** Provenance of an agent-task completion, carried onto the user entry. */
  eventMeta?: { kind: "agent_task_completed"; sessionId: string; turnEndEntryIndex: number };
}

/**
 * One piece of work the commander is doing for whoever opened it: one or more
 * model streams, until it owes nothing. Results of the work it started never
 * open a turn of their own; they join this one (waking it when it waits).
 * Design: docs/commander-turn-model-design.md §3–§5.
 */
export interface CommanderTurn {
  id: string;
  openedBy: TurnOpenedBy;
  startedAt: number;
  /** `running`: a stream is live or parked on an approval. `waiting`: no stream, results or the user still owed. */
  status: "running" | "waiting";
  /**
   * Whether the user was there when the current stream started: they opened
   * the turn or spoke into it. A stream woken by a result or an event is not
   * watched, so outbound agent actions in it need approval.
   */
  userPresent: boolean;
  /** A turn summarizing untrusted browser events: no tools, and nothing else joins it. */
  toolless: boolean;
  /** Arrivals not yet shown to the model; the next stream starts with them. */
  inbox: TurnArrival[];
  streams: number;
}

export function openTurn(first: TurnArrival, id: string, now = Date.now()): CommanderTurn {
  return {
    id,
    openedBy: first.source === "user" ? "user" : "listened_event",
    startedAt: now,
    status: "running",
    userPresent: false,
    toolless: first.source === "browser",
    inbox: [first],
    streams: 0,
  };
}

/** Whether an arrival may join the turn, or has to wait for the next one. */
export function turnAccepts(turn: CommanderTurn, arrival: TurnArrival): boolean {
  return !turn.toolless && arrival.source !== "browser";
}

/**
 * Who is watching the stream about to start with these arrivals: the user if
 * they spoke, nobody if a result or event woke it; a nudge alone changes nothing.
 */
export function userPresentAfter(current: boolean, arrivals: TurnArrival[]): boolean {
  if (arrivals.some((arrival) => arrival.source === "user")) return true;
  if (arrivals.some((arrival) => arrival.source !== "nudge")) return false;
  return current;
}
