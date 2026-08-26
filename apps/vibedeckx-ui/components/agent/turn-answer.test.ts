import { describe, it, expect } from "vitest";
import { extractTurnAnswer } from "./turn-answer";
import type { AgentMessage } from "@/hooks/use-agent-session";

const user = (content: string): AgentMessage => ({ type: "user", content, timestamp: 1 });
const assistant = (content: string): AgentMessage => ({ type: "assistant", content, timestamp: 2 });
const toolUse = (): AgentMessage => ({ type: "tool_use", tool: "Bash", input: {}, timestamp: 3 });
const toolResult = (): AgentMessage => ({ type: "tool_result", tool: "Bash", output: "ok", timestamp: 4 });
const turnEnd = (): AgentMessage => ({ type: "turn_end", timestamp: 5 });

describe("extractTurnAnswer", () => {
  it("returns the LAST assistant text of the turn, skipping tool entries", () => {
    const messages = [user("q"), assistant("draft"), toolUse(), toolResult(), assistant("final"), turnEnd()];
    expect(extractTurnAnswer(messages, 5)).toBe("final");
  });

  it("skips a queued user entry persisted between the answer and the divider", () => {
    // session-history-window.ts: a queued user message can land just before
    // the prior turn_end even though it executes in the next semantic turn.
    const messages = [user("q"), assistant("answer"), user("queued next prompt"), turnEnd()];
    expect(extractTurnAnswer(messages, 3)).toBe("answer");
  });

  it("skips a mid-turn interactive-tool user answer", () => {
    const messages = [user("q"), toolUse(), user("option A"), assistant("done with A"), turnEnd()];
    expect(extractTurnAnswer(messages, 4)).toBe("done with A");
  });

  it("is bounded by the previous turn_end — never leaks the prior turn's answer", () => {
    const messages = [user("q1"), assistant("old answer"), turnEnd(), user("q2"), turnEnd()];
    expect(extractTurnAnswer(messages, 4)).toBeNull();
  });

  it("returns null for a turn with only tools and no text answer", () => {
    const messages = [turnEnd(), user("q"), toolUse(), toolResult(), turnEnd()];
    expect(extractTurnAnswer(messages, 4)).toBeNull();
  });

  it("ignores whitespace-only assistant entries and sparse slots", () => {
    const messages: Array<AgentMessage | undefined> = [user("q"), assistant("real"), undefined, assistant("  \n"), turnEnd()];
    expect(extractTurnAnswer(messages, 4)).toBe("real");
  });
});
