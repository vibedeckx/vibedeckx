import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import type { AgentMessage } from "./agent-types.js";
import { capToolResults, fitTurnBudget, summaryMessage, textHistory, transcriptText } from "./chat-history.js";

const toolMessage = (value: unknown, type: "json" | "text" = "json"): ModelMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "c1", toolName: "getExecutorStatus", output: { type, value } as never }],
});
const outputOf = (message: ModelMessage) => (message.content as Array<{ output: { type: string; value: unknown } }>)[0].output;

describe("textHistory", () => {
  const entries: AgentMessage[] = [
    { type: "user", content: "hi", timestamp: 0 },
    { type: "tool_use", tool: "x", input: {}, timestamp: 0 },
    { type: "assistant", content: "hello", timestamp: 0 },
    { type: "turn_end", timestamp: 0 },
    { type: "user", content: "again", timestamp: 0 },
  ];

  it("keeps only the words of the range", () => {
    expect(textHistory(entries, 0, 4)).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
    expect(textHistory(entries, 3, 99)).toEqual([{ role: "user", content: "again" }]);
  });

  it("renders a range as a transcript, keeping the most recent part when long", () => {
    expect(transcriptText(entries, 0, 5)).toBe("User: hi\n\nAssistant: hello\n\nUser: again");
    const long: AgentMessage[] = [{ type: "user", content: "x".repeat(70_000), timestamp: 0 }, { type: "assistant", content: "the end", timestamp: 0 }];
    const text = transcriptText(long, 0, 2);
    expect(text.length).toBeLessThanOrEqual(60_001);
    expect(text.endsWith("the end")).toBe(true);
  });

  it("frames the summary as earlier conversation", () => {
    expect(summaryMessage("built the login page")).toMatchObject({ role: "user", content: expect.stringContaining("[Earlier conversation, summarized]\nbuilt the login page") });
  });
});

describe("capToolResults", () => {
  it("cuts a long tool result and leaves short ones and other messages alone", () => {
    const short = toolMessage({ ok: true });
    const long = toolMessage({ log: "y".repeat(10_000) });
    const assistant: ModelMessage = { role: "assistant", content: "done" };
    const [a, b, c] = capToolResults([short, long, assistant], 100);
    expect(a).toBe(short);
    expect(c).toBe(assistant);
    expect(outputOf(b)).toMatchObject({ type: "text" });
    expect(String(outputOf(b).value)).toHaveLength(100 + "…(truncated)".length);
  });
});

describe("fitTurnBudget", () => {
  it("drops the oldest tool outputs first until the turn fits", () => {
    const messages = [toolMessage("a".repeat(500), "text"), toolMessage("b".repeat(500), "text"), toolMessage("c".repeat(500), "text")];
    fitTurnBudget(messages, 1_200);
    expect(String(outputOf(messages[0]).value)).toMatch(/^\(output dropped/);
    expect(outputOf(messages[2]).value).toBe("c".repeat(500));
  });

  it("leaves a turn within budget untouched", () => {
    const messages = [toolMessage({ ok: true })];
    const before = JSON.stringify(messages);
    fitTurnBudget(messages, 10_000);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
