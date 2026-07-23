import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentMessage } from "../agent-types.js";

vi.mock("ai", () => ({ generateText: vi.fn() }));
import { generateText } from "ai";
import { serializeConversationForBrief, generateIntentBriefWithModel, SYSTEM_PROMPT } from "./review-brief.js";

const mockGenerateText = vi.mocked(generateText);

describe("serializeConversationForBrief", () => {
  it("keeps user/assistant text and drops tool traffic, thinking, and event notifications", () => {
    const messages: AgentMessage[] = [
      { type: "user", content: "build a login page", timestamp: 1 },
      { type: "thinking", content: "hmm", timestamp: 2 },
      { type: "tool_use", tool: "Bash", input: { command: "ls" }, timestamp: 3 },
      { type: "tool_result", tool: "Bash", output: "files", timestamp: 4 },
      { type: "assistant", content: "I added the page", timestamp: 5 },
      {
        type: "user", content: "notify", timestamp: 6,
        event: { kind: "agent_task_completed", sessionId: "x", turnEndEntryIndex: 0 },
      },
    ];
    const out = serializeConversationForBrief(messages);
    expect(out).toBe("User: build a login page\n\nAgent: I added the page");
  });

  it("extracts text parts from mixed-content user messages", () => {
    const messages: AgentMessage[] = [
      {
        type: "user",
        content: [
          { type: "image", mediaType: "image/png", data: "AAAA" },
          { type: "text", text: "match this mockup" },
        ],
        timestamp: 1,
      },
    ];
    expect(serializeConversationForBrief(messages)).toBe("User: match this mockup");
  });

  it("elides the middle when the conversation overflows, keeping head and tail", () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push({ type: "user", content: `msg-${i} ` + "x".repeat(2000), timestamp: i });
    }
    const out = serializeConversationForBrief(messages);
    expect(out.length).toBeLessThan(25_000);
    expect(out).toContain("msg-0 ");                                // head kept
    expect(out).toContain("[… middle of the conversation omitted …]");
    expect(out).toContain("x".repeat(100) + "…");                   // per-message cap applied
    expect(out.slice(-16_000)).toContain("msg-39");                 // tail kept
  });

  it("returns empty string for conversations with no usable text", () => {
    expect(serializeConversationForBrief([])).toBe("");
    expect(serializeConversationForBrief([{ type: "turn_end", timestamp: 1 }])).toBe("");
  });
});

describe("generateIntentBriefWithModel", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  it("returns the trimmed brief text", async () => {
    mockGenerateText.mockResolvedValue({ text: "  1. Goal: login page\n2. Constraints: none  " } as never);
    const brief = await generateIntentBriefWithModel({}, "User: build it");
    expect(brief).toBe("1. Goal: login page\n2. Constraints: none");
  });

  it("returns null for empty conversations without calling the model", async () => {
    expect(await generateIntentBriefWithModel({}, "   ")).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns null on model failure instead of throwing", async () => {
    mockGenerateText.mockRejectedValue(new Error("rate limited"));
    expect(await generateIntentBriefWithModel({}, "User: build it")).toBeNull();
  });

  it("passes the SDK-native timeout (which aborts the request) and treats an abort as null", async () => {
    mockGenerateText.mockResolvedValue({ text: "brief" } as never);
    await generateIntentBriefWithModel({}, "User: build it");
    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15_000 }));

    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    mockGenerateText.mockRejectedValue(abortErr);
    expect(await generateIntentBriefWithModel({}, "User: build it")).toBeNull();
  });

  it("returns null on empty model output and caps oversized output", async () => {
    mockGenerateText.mockResolvedValue({ text: "   " } as never);
    expect(await generateIntentBriefWithModel({}, "User: build it")).toBeNull();

    mockGenerateText.mockResolvedValue({ text: "y".repeat(9000) } as never);
    const capped = await generateIntentBriefWithModel({}, "User: build it");
    expect(capped).toHaveLength(4001); // 4000 + ellipsis
  });
});

describe("SYSTEM_PROMPT", () => {
  it("no longer asks the distiller to guess the intended scope, but keeps goal/constraints/trade-offs", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/intended scope/i);
    expect(SYSTEM_PROMPT).toMatch(/original request/i);
    expect(SYSTEM_PROMPT).toMatch(/trade-offs|limitations/i);
  });
});
