import type { AgentMessage } from "./agent-types.js";
import type { Storage } from "./storage/types.js";
import {
  buildHistoryWindow,
  historyHead,
  type SessionHistoryHead,
  type SessionHistoryWindow,
} from "./session-history-window.js";

/**
 * Reads a session's transcript straight out of storage, for sessions whose
 * history is NOT in memory.
 *
 * Under process-bound hydration
 * (docs/plans/2026-09-05-session-history-lazy-hydration-b.md) a session's
 * `MessageStore` exists only while it owns an agent process. Every other read
 * — a detail page, a history window, a workflow reading its source session, a
 * WebSocket replaying a dormant conversation — comes through here.
 *
 * Deliberately stateless: no cache, no TTL, no invalidation rules. A cold read
 * costs one indexed SELECT plus a parse per row, and the plan's §6 accepts
 * that. If measurements later show it is too slow, the fix goes *inside* this
 * class (paged window queries — plan Phase 2 — or a bounded read-through
 * cache), where the manager cannot observe it.
 */
export class SessionHistoryReader {
  private readonly storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * The whole transcript as a SPARSE array indexed by entry index — the exact
   * shape `MessageStore.entries` has, so callers can treat hot and cold
   * sessions identically. Unparsable rows become holes, matching
   * `rebuildStoreFromRows`.
   */
  async readAll(sessionId: string): Promise<AgentMessage[]> {
    const rows = await this.storage.agentSessions.getEntries(sessionId);
    return parseRows(rows, sessionId);
  }

  /** `readAll` with holes dropped — the `getMessages` shape. */
  async readDense(sessionId: string): Promise<AgentMessage[]> {
    return (await this.readAll(sessionId)).filter(Boolean);
  }

  /**
   * Phase 1 reads the whole transcript and slices it in memory: correctness
   * first, and the slicing logic stays the single implementation shared with
   * hot sessions. Phase 2 replaces the body with paged `getEntriesBefore`
   * queries plus one turn_end count — the signature is chosen to allow that
   * without touching a single caller.
   */
  async readWindow(
    sessionId: string,
    historyEpoch: number,
    opts: { before?: number | null; turns?: number } = {},
  ): Promise<SessionHistoryWindow> {
    return buildHistoryWindow(await this.readAll(sessionId), historyEpoch, opts);
  }

  async readHead(sessionId: string, historyEpoch: number): Promise<SessionHistoryHead> {
    return historyHead(await this.readAll(sessionId), historyEpoch);
  }

  /**
   * One page of entries in descending index order, strictly before
   * `beforeIndex` (null = the tail). The backward walk crash repair uses to
   * find a turn boundary without reading the whole transcript.
   */
  async readBefore(
    sessionId: string,
    beforeIndex: number | null,
    limit: number,
  ): Promise<Array<{ entryIndex: number; message: AgentMessage | undefined }>> {
    const rows = await this.storage.agentSessions.getEntriesBefore(sessionId, beforeIndex, limit);
    return rows.map((row) => ({
      entryIndex: row.entry_index,
      message: parseRow(row.data),
    }));
  }
}

function parseRow(data: string): AgentMessage | undefined {
  try {
    return JSON.parse(data) as AgentMessage;
  } catch {
    return undefined;
  }
}

function parseRows(
  rows: Array<{ entry_index: number; data: string }>,
  sessionIdForLog: string,
): AgentMessage[] {
  const entries: AgentMessage[] = [];
  for (const row of rows) {
    const message = parseRow(row.data);
    if (message === undefined) {
      console.error(`[SessionHistoryReader] Failed to parse entry ${row.entry_index} for session ${sessionIdForLog}`);
      continue;
    }
    entries[row.entry_index] = message;
  }
  return entries;
}
