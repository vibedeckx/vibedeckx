import { describe, expect, it } from "vitest";
import type { AgentMessage } from "./agent-types.js";
import { buildHistoryWindow, historyHead } from "./session-history-window.js";

const user = (content: string): AgentMessage => ({ type: "user", content, timestamp: 1 });
const assistant = (content: string): AgentMessage => ({ type: "assistant", content, timestamp: 1 });
const end = (): AgentMessage => ({ type: "turn_end", timestamp: 1, outcome: "completed" });

describe("session history windows", () => {
  it("reports the persisted head in the current epoch", () => {
    const entries: AgentMessage[] = [user("a"), assistant("b"), end(), assistant("active")];
    expect(historyHead(entries, 7)).toEqual({
      historyEpoch: 7,
      latestEntryIndex: 3,
      lastTurnEndEntryIndex: 2,
    });
  });

  it("returns a dense bounded tail and keeps absolute entry indices", () => {
    const entries: AgentMessage[] = [];
    for (let turn = 0; turn < 8; turn++) entries.push(user(`u${turn}`), assistant(`a${turn}`), end());
    entries.push(assistant("active"));
    const window = buildHistoryWindow(entries, 2, { turns: 3 });
    expect(window.entries[0].entryIndex).toBe(12);
    expect(window.entries.at(-1)).toMatchObject({ entryIndex: 24, message: { content: "active" } });
    expect(window.hasMore).toBe(true);
    expect(window.previousCursor).toBe(12);
  });

  it("includes extra boundary context so a queued user stays with later output", () => {
    const entries: AgentMessage[] = [
      user("first"), assistant("first result"), end(),
      user("second"), assistant("second result"), user("queued third"), end(),
      assistant("third result"), end(),
    ];
    const tail = buildHistoryWindow(entries, 0, { turns: 1 });
    expect(tail.entries).toContainEqual({ entryIndex: 5, message: entries[5] });
    expect(tail.entries).toContainEqual({ entryIndex: 7, message: entries[7] });
  });
});
