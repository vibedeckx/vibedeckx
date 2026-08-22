/**
 * RFC 6902 JSON Patch utilities for conversation updates
 */

import type { AgentMessage } from "./agent-types.js";
import type { WorkflowRun } from "./storage/types.js";
import type { BackgroundTask } from "./turn-completion.js";

// ============ Patch Operation Types ============

export type PatchOperation = "add" | "replace" | "remove";

export interface PatchEntry {
  op: PatchOperation;
  path: string;
  value?: PatchValue;
}

export type Patch = PatchEntry[];

// ============ Patch Value Types ============

/**
 * PatchType discriminated union
 */
export type PatchValue =
  | { type: "ENTRY"; content: AgentMessage }
  | { type: "STATUS"; content: AgentSessionStatus }
  | { type: "READY"; content: true }
  | { type: "FINISHED"; content: true };

export type AgentSessionStatus = "running" | "stopped" | "error";

// ============ WebSocket Message Format ============

/**
 * Messages sent over WebSocket to frontend
 */
export type AgentWsMessage =
  | { JsonPatch: Patch }
  | { HistorySync: { historyEpoch: number; reset: boolean } }
  | { Ready: true; historyEpoch?: number }
  | { finished: true }
  | { error: string }
  | { taskCompleted: { duration_ms?: number; cost_usd?: number; input_tokens?: number; output_tokens?: number; summaryText?: string; turnEndEntryIndex?: number; workflowSuppressed?: boolean } }
  | { processAlive: { alive: boolean } }
  | { branchActivity: { activity: "idle" | "working" | "completed" | "stopped"; since: number } }
  | { browserCommand: BrowserCommand }
  | { openPreviewFrame: { projectId: string; url: string } }
  | { titleUpdated: { title: string } }
  // Live background-task set (Claude Code `background_tasks_changed`). Sent on
  // every change AND once at subscribe time — the harness only pushes on
  // change, so a client that reloads mid-task would otherwise never learn the
  // task exists. An empty array is meaningful ("nothing running"), so this is
  // always sent, never omitted.
  //
  // `turnParked` means the agent already finished answering and the turn is
  // being held open ONLY by these tasks. The client cannot derive this: its
  // own `turnInFlight` is "no turn_end yet", which is exactly what a parked
  // completion withholds.
  //
  // `parkDeadlineAt` is when that parked turn will be committed anyway (epoch
  // ms), or null when nothing is parked or the user vouched for every live
  // task. Sent as an absolute instant rather than a remaining duration so the
  // countdown survives a reload without the server re-sending anything.
  //
  // `canStopTasks` is whether this agent can stop one task (Claude Code can,
  // Codex cannot). Reported so the client never renders a button that is dead
  // on arrival — and a worker too old to send this field is read as false,
  // which is also the truth: it has no stop route either.
  | { backgroundTasks: { tasks: BackgroundTask[]; turnParked: boolean; parkDeadlineAt: number | null; canStopTasks: boolean } }
  | { workflowRunUpdated: WorkflowRun };

/**
 * Browser command sent from backend to frontend via WebSocket.
 * Frontend forwards to iframe's injected script via postMessage.
 */
export interface BrowserCommand {
  id: string;
  action: "click" | "fill" | "select" | "pressKey" | "getText" | "getHTML" | "querySelector";
  selector?: string;
  value?: string;
  key?: string;
}

/**
 * Browser command result sent from frontend back to backend via WebSocket.
 */
export interface BrowserCommandResult {
  id: string;
  success: boolean;
  error?: string;
  content?: string;
  found?: boolean;
  tag?: string;
  text?: string;
}

// ============ Conversation Patch Builder ============

/**
 * ConversationPatch - Static utility for creating RFC 6902 patches
 */
export const ConversationPatch = {
  /**
   * Create an ADD patch for a new entry at the given index
   */
  addEntry(entryIndex: number, entry: AgentMessage): Patch {
    return [
      {
        op: "add",
        path: `/entries/${entryIndex}`,
        value: { type: "ENTRY", content: entry },
      },
    ];
  },

  /**
   * Create a REPLACE patch for updating an existing entry
   */
  replaceEntry(entryIndex: number, entry: AgentMessage): Patch {
    return [
      {
        op: "replace",
        path: `/entries/${entryIndex}`,
        value: { type: "ENTRY", content: entry },
      },
    ];
  },

  /**
   * Create a REMOVE patch for deleting an entry
   */
  removeEntry(entryIndex: number): Patch {
    return [
      {
        op: "remove",
        path: `/entries/${entryIndex}`,
      },
    ];
  },

  /**
   * Create a status update patch
   */
  updateStatus(status: AgentSessionStatus): Patch {
    return [
      {
        op: "replace",
        path: "/status",
        value: { type: "STATUS", content: status },
      },
    ];
  },

  /**
   * Create a patch to clear all entries (for session restart)
   * Uses a special path "/entries" with "replace" to signal full clear
   */
  clearAll(): Patch {
    return [
      {
        op: "replace",
        path: "/entries",
        value: { type: "ENTRY", content: { type: "system", content: "__CLEAR_ALL__", timestamp: Date.now() } as AgentMessage },
      },
    ];
  },
};
