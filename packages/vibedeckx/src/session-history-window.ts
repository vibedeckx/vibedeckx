import type { AgentMessage } from "./agent-types.js";

export interface WindowedAgentEntry {
  entryIndex: number;
  message: AgentMessage;
}

export interface SessionHistoryHead {
  historyEpoch: number;
  latestEntryIndex: number | null;
  lastTurnEndEntryIndex: number | null;
}

export interface SessionHistoryWindow extends SessionHistoryHead {
  entries: WindowedAgentEntry[];
  previousCursor: number | null;
  hasMore: boolean;
}

export function historyHead(
  entries: Array<AgentMessage | undefined>,
  historyEpoch: number,
): SessionHistoryHead {
  let latestEntryIndex: number | null = null;
  let lastTurnEndEntryIndex: number | null = null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index];
    if (!message) continue;
    latestEntryIndex ??= index;
    if (lastTurnEndEntryIndex === null && message.type === "turn_end") {
      lastTurnEndEntryIndex = index;
    }
    if (latestEntryIndex !== null && lastTurnEndEntryIndex !== null) break;
  }
  return { historyEpoch, latestEntryIndex, lastTurnEndEntryIndex };
}

/**
 * Return a dense entry window whose start is aligned to a persisted turn_end
 * interval. `before` is exclusive and is used for upward pagination.
 *
 * A queued user entry can be persisted just before the prior turn_end even
 * when the CLI later executes it in the next semantic turn. Including one
 * extra boundary interval keeps that ambiguous edge together with the output
 * that follows it. Adjacent pages remain contiguous and merge by entryIndex.
 */
export function buildHistoryWindow(
  entries: Array<AgentMessage | undefined>,
  historyEpoch: number,
  opts: { before?: number | null; turns?: number } = {},
): SessionHistoryWindow {
  const head = historyHead(entries, historyEpoch);
  const endExclusive = Math.max(0, Math.min(opts.before ?? entries.length, entries.length));
  const requestedTurns = Math.max(1, Math.min(opts.turns ?? 5, 20));
  const boundaries: number[] = [];
  for (let index = endExclusive - 1; index >= 0; index--) {
    if (entries[index]?.type === "turn_end") boundaries.push(index);
    if (boundaries.length >= requestedTurns + 2) break;
  }

  // Keep the active tail plus N completed boundary intervals. The extra
  // boundary is overlap/context, not an additional advertised turn.
  const startIndex = boundaries.length > requestedTurns + 1
    ? boundaries[requestedTurns + 1] + 1
    : 0;
  const dense: WindowedAgentEntry[] = [];
  for (let index = startIndex; index < endExclusive; index++) {
    const message = entries[index];
    if (message) dense.push({ entryIndex: index, message });
  }
  const hasMore = startIndex > 0;
  return {
    ...head,
    entries: dense,
    previousCursor: hasMore ? startIndex : null,
    hasMore,
  };
}
