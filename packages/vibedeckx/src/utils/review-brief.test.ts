import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentMessage, ContentPart } from "../agent-types.js";

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("./chat-model.js", () => {
  const config = {
    apiKeys: { deepseek: "k", openrouter: "" },
    main: { provider: "deepseek", model: "main-model" },
    fast: { provider: "deepseek", model: "fast-model" },
  };
  return {
    resolveChatModel: vi.fn(async () => ({ id: "main-model" })),
    resolveFastChatModel: vi.fn(async () => ({ id: "fast-model" })),
    getChatProviderConfig: vi.fn(async () => config),
    isModelConfigured: vi.fn(() => true),
  };
});

import { generateText } from "ai";
import { isModelConfigured } from "./chat-model.js";
import {
  serializeConversationForBrief,
  projectMessagesForBrief,
  generateIntentBrief,
  clearIntentBriefCache,
  generateIntentBriefWithModel,
  extractReversalsWithModel,
  compactConversation,
  buildBriefPrompt,
  appendCompactionNote,
  timeoutForInput,
  isSizeRelatedFailure,
  SYSTEM_PROMPT,
  REVERSAL_SYSTEM_PROMPT,
  COMPACT_SYSTEM_PROMPT,
  COMPACTION_NOTE,
  BRIEF_TRUNCATION_NOTE,
} from "./review-brief.js";

const mockGenerateText = vi.mocked(generateText);
const mockIsModelConfigured = vi.mocked(isModelConfigured);
const storage = {} as never;

/** One capped-size agent turn — 6k chars, the per-message ceiling. */
const bigTurn = (tag: string): AgentMessage => ({
  type: "assistant",
  content: `${tag} ` + "x".repeat(6_000),
  timestamp: 0,
});

const sizeError = () => Object.assign(new Error("This model's maximum context length is 65536 tokens"), {});

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
    expect(serializeConversationForBrief(messages)).toBe("User: build a login page\n\nAgent: I added the page");
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

  // Regression: the old serializer sliced a head and a tail out of the char
  // stream, which deleted the middle of the conversation — where a design
  // discussion converges. Serialization now drops nothing at all.
  it("never drops turns, however long the conversation is", () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 60; i++) messages.push(bigTurn(`turn-${i}`));
    const out = serializeConversationForBrief(messages);
    expect(out).toContain("turn-0 ");
    expect(out).toContain("turn-30 ");
    expect(out).toContain("turn-59 ");
    expect(out).not.toContain("omitted");
  });

  it("applies the per-message cap", () => {
    const out = serializeConversationForBrief([{ type: "user", content: "z".repeat(9_000), timestamp: 1 }]);
    expect(out).toBe("User: " + "z".repeat(6_000) + "…");
  });

  it("returns empty string for conversations with no usable text", () => {
    expect(serializeConversationForBrief([])).toBe("");
    expect(serializeConversationForBrief([{ type: "turn_end", timestamp: 1 }])).toBe("");
  });
});

describe("timeoutForInput", () => {
  it("keeps the 15s floor for small inputs and scales up for large ones", () => {
    expect(timeoutForInput(500)).toBe(15_000);
    expect(timeoutForInput(120_000)).toBe(29_400);
  });

  it("caps at a minute", () => {
    expect(timeoutForInput(10_000_000)).toBe(60_000);
  });
});

describe("isSizeRelatedFailure", () => {
  it("recognises context-window rejections and timeouts", () => {
    expect(isSizeRelatedFailure(sizeError())).toBe(true);
    expect(isSizeRelatedFailure(new Error("prompt is too long"))).toBe(true);
    expect(isSizeRelatedFailure(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
  });

  it("does not retry on unrelated failures", () => {
    expect(isSizeRelatedFailure(new Error("401 unauthorized"))).toBe(false);
    expect(isSizeRelatedFailure(new Error("rate limited"))).toBe(false);
  });
});

describe("compactConversation", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({ text: "SLICE SUMMARY" } as never);
  });

  it("summarizes the older slices and keeps the newest turns verbatim", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push(bigTurn(`turn-${i}`));

    const out = await compactConversation({}, messages);

    expect(out).toContain("[Compressed slice 1 of 1]");
    expect(out).toContain("SLICE SUMMARY");
    expect(out).toContain("[Recent turns, verbatim]");
    expect(out).toContain("turn-9 ");   // newest kept word for word
    expect(out).not.toContain("turn-0 "); // oldest went through the summarizer
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ system: COMPACT_SYSTEM_PROMPT }),
    );
  });

  it("labels every slice with its position so the distiller can order them", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 25; i++) messages.push(bigTurn(`turn-${i}`));

    const out = await compactConversation({}, messages);

    expect(out).toContain("[Compressed slice 1 of 2]");
    expect(out).toContain("[Compressed slice 2 of 2]");
    const prompts = mockGenerateText.mock.calls.map((c) => (c[0] as { prompt: string }).prompt);
    expect(prompts.some((p) => p.startsWith("Slice 1 of 2."))).toBe(true);
    expect(prompts.some((p) => p.startsWith("Slice 2 of 2."))).toBe(true);
  });

  it("returns null rather than a partial result when a slice fails", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 25; i++) messages.push(bigTurn(`turn-${i}`));
    mockGenerateText
      .mockResolvedValueOnce({ text: "SLICE SUMMARY" } as never)
      .mockRejectedValueOnce(new Error("boom"));

    expect(await compactConversation({}, messages)).toBeNull();
  });

  it("gives up above the fold-call ceiling instead of spending 10 model calls", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 160; i++) messages.push(bigTurn(`turn-${i}`));

    expect(await compactConversation({}, messages)).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns null when there is nothing older than the verbatim window", async () => {
    expect(await compactConversation({}, [{ type: "user", content: "hi", timestamp: 1 }])).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("propagates size failures so the caller can retry with smaller slices", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push(bigTurn(`turn-${i}`));
    mockGenerateText.mockRejectedValue(sizeError());

    await expect(compactConversation({}, messages)).rejects.toThrow(/maximum context length/);
  });

  it("caps output with maxOutputTokens instead of relying on a post-hoc cut", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push(bigTurn(`turn-${i}`));
    await compactConversation({}, messages);
    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 3_000 }));
  });

  // A slice summary feeds the distiller. Cutting its tail would drop whatever
  // correction the compactor put last while the rest still reads as complete —
  // the exact failure this module exists to prevent.
  it("discards an over-long slice summary rather than truncating away its last line", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push(bigTurn(`turn-${i}`));
    mockGenerateText.mockResolvedValue({
      text: "filler ".repeat(1_000) + "\nCORRECTION: the earlier plan was dropped",
    } as never);

    expect(await compactConversation({}, messages)).toBeNull();
  });

  // A token-capped slice summary is under the char limit but still lost its
  // tail — where the compactor was told to put lower-priority material, and
  // where a mid-list correction can vanish silently.
  it("discards a slice summary cut by the token cap", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push(bigTurn(`turn-${i}`));
    mockGenerateText.mockResolvedValue({ text: "SLICE SUMMARY", finishReason: "length" } as never);

    expect(await compactConversation({}, messages)).toBeNull();
  });
});

describe("buildBriefPrompt", () => {
  it("omits the preamble when there are no reversals", () => {
    expect(buildBriefPrompt("User: hi", null)).toBe("Distill this conversation into an intent brief:\n\nUser: hi");
  });

  it("puts the reversals ahead of the conversation", () => {
    const prompt = buildBriefPrompt("User: hi", "SUPERSEDED: model/list -> -c model= (contradicts no-precheck)");
    expect(prompt.indexOf("SUPERSEDED")).toBeLessThan(prompt.indexOf("User: hi"));
    expect(prompt).toMatch(/never report the left-hand side/i);
  });
});

describe("appendCompactionNote", () => {
  it("adds the disclaimer only when the input was compacted", () => {
    expect(appendCompactionNote("brief", false)).toBe("brief");
    expect(appendCompactionNote("brief", true)).toBe(`brief\n\n${COMPACTION_NOTE}`);
  });
});

describe("extractReversalsWithModel", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  const longConvo = "User: " + "a".repeat(7_000);

  it("skips the round-trip for short conversations", async () => {
    expect(await extractReversalsWithModel({}, "User: build it")).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns the reversal list for long conversations", async () => {
    mockGenerateText.mockResolvedValue({ text: " SUPERSEDED: A -> B (why) " } as never);
    expect(await extractReversalsWithModel({}, longConvo)).toBe("SUPERSEDED: A -> B (why)");
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ system: REVERSAL_SYSTEM_PROMPT }),
    );
  });

  it("treats NONE as no reversals", async () => {
    mockGenerateText.mockResolvedValue({ text: "NONE" } as never);
    expect(await extractReversalsWithModel({}, longConvo)).toBeNull();
  });

  it("skips itself on a size failure — the main call will hit the same wall and compact", async () => {
    mockGenerateText.mockRejectedValue(sizeError());
    expect(await extractReversalsWithModel({}, longConvo)).toBeNull();
  });

  it("propagates fatal failures so the caller stops instead of firing another request", async () => {
    mockGenerateText.mockRejectedValue(new Error("rate limited"));
    await expect(extractReversalsWithModel({}, longConvo)).rejects.toThrow(/rate limited/);
  });

  // A truncated reversal list is worse than none: it looks authoritative while
  // missing whichever reversal came last.
  it("discards an over-long reversal list rather than cutting it", async () => {
    mockGenerateText.mockResolvedValue({ text: "SUPERSEDED: a -> b (why). ".repeat(200) } as never);
    expect(await extractReversalsWithModel({}, longConvo)).toBeNull();
  });

  // Same rule when the cut came from maxOutputTokens instead of length.
  it("discards a reversal list cut by the token cap", async () => {
    mockGenerateText.mockResolvedValue({ text: "SUPERSEDED: a -> b (why)", finishReason: "length" } as never);
    expect(await extractReversalsWithModel({}, longConvo)).toBeNull();
  });
});

describe("generateIntentBriefWithModel", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  it("returns the trimmed brief text", async () => {
    mockGenerateText.mockResolvedValue({ text: "  1. Goal: login page\n2. Constraints: none  " } as never);
    expect(await generateIntentBriefWithModel({}, "User: build it")).toBe("1. Goal: login page\n2. Constraints: none");
  });

  it("forwards reversals into the prompt", async () => {
    mockGenerateText.mockResolvedValue({ text: "brief" } as never);
    await generateIntentBriefWithModel({}, "User: build it", { reversals: "SUPERSEDED: A -> B (why)" });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("SUPERSEDED: A -> B (why)") }),
    );
  });

  it("returns null for empty conversations without calling the model", async () => {
    expect(await generateIntentBriefWithModel({}, "   ")).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns null on model failure instead of throwing", async () => {
    mockGenerateText.mockRejectedValue(new Error("rate limited"));
    expect(await generateIntentBriefWithModel({}, "User: build it")).toBeNull();
  });

  // 90s, not the input-scaled 15s: judgment calls run on the MAIN model,
  // where reasoning time dominates and barely scales with input — live,
  // deepseek-v4-pro took ~30s on a 2.5k-char input and blew a 45s budget on a
  // compacted one. An abort masquerades as a size failure and triggers a
  // pointless compaction retry, so the ceiling must clear normal completions.
  it("passes the SDK-native timeout with the judgment-call budget and treats an abort as null", async () => {
    mockGenerateText.mockResolvedValue({ text: "brief" } as never);
    await generateIntentBriefWithModel({}, "User: build it");
    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({ timeout: 90_000 }));

    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    mockGenerateText.mockRejectedValue(abortErr);
    expect(await generateIntentBriefWithModel({}, "User: build it")).toBeNull();
  });

  it("rethrows size failures only when asked, so the caller can retry compacted", async () => {
    mockGenerateText.mockRejectedValue(sizeError());
    expect(await generateIntentBriefWithModel({}, "User: hi")).toBeNull();
    await expect(
      generateIntentBriefWithModel({}, "User: hi", { rethrowSizeFailures: true }),
    ).rejects.toThrow(/maximum context length/);
  });

  it("does not rethrow unrelated failures even when asked", async () => {
    mockGenerateText.mockRejectedValue(new Error("401 unauthorized"));
    expect(await generateIntentBriefWithModel({}, "User: hi", { rethrowSizeFailures: true })).toBeNull();
  });

  it("returns null on empty model output", async () => {
    mockGenerateText.mockResolvedValue({ text: "   " } as never);
    expect(await generateIntentBriefWithModel({}, "User: build it")).toBeNull();
  });

  // The brief is terminal output — a cut here is read by a human, so it is
  // marked rather than discarded. Mid-pipeline values get the opposite rule.
  it("marks a truncated brief visibly instead of ending mid-sentence", async () => {
    mockGenerateText.mockResolvedValue({ text: "y".repeat(9_000) } as never);
    const brief = await generateIntentBriefWithModel({}, "User: build it");
    expect(brief).toBe("y".repeat(4_000) + BRIEF_TRUNCATION_NOTE);
  });

  // A maxOutputTokens cut can land under the char cap: the brief looks
  // complete but lost its tail (live eval: generation stopped mid-heading,
  // before the [settled] items). finishReason is the only signal.
  it("marks a brief cut by the token cap even when under the char cap", async () => {
    mockGenerateText.mockResolvedValue({ text: "short but token-capped brief", finishReason: "length" } as never);
    const brief = await generateIntentBriefWithModel({}, "User: build it");
    expect(brief).toBe("short but token-capped brief" + BRIEF_TRUNCATION_NOTE);
  });

  // 3k, not 1k: reasoning-capable models spend thinking tokens inside
  // maxOutputTokens. Live eval on deepseek-v4-flash showed a 1k budget either
  // cutting the brief mid-heading or returning empty text (all tokens burned
  // on reasoning). Acceptance size is still governed by the char cap.
  it("bounds output with maxOutputTokens sized for reasoning overhead", async () => {
    mockGenerateText.mockResolvedValue({ text: "brief" } as never);
    await generateIntentBriefWithModel({}, "User: build it");
    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 3_000 }));
  });

  it("warns with the finish reason when the model returns empty text", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockGenerateText.mockResolvedValue({ text: "", finishReason: "length" } as never);
      expect(await generateIntentBriefWithModel({}, "User: build it")).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("finishReason: length"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * The projection is a transport optimization: a worker sends only what the
 * distiller reads instead of the whole session. It is only sound if the
 * distiller's input is unchanged by it — every property here is about that
 * equality, not about the projection's own shape.
 */
describe("projectMessagesForBrief", () => {
  const nasty = (): AgentMessage[] => [
    { type: "user", content: "  build the exporter  ", timestamp: 1 },
    { type: "thinking", content: "weighing options", timestamp: 2 },
    { type: "tool_use", tool: "Write", input: { content: "x".repeat(50_000) }, timestamp: 3 },
    { type: "tool_result", tool: "Write", output: "y".repeat(50_000), timestamp: 4 },
    // Multi-part user turn: text parts joined, non-text dropped.
    { type: "user", content: [
      { type: "text", text: "here is the spec" },
      { type: "image", mediaType: "image/png", data: "AAAA" },
      { type: "text", text: "and the follow-up" },
    ] satisfies ContentPart[], timestamp: 5 },
    // Over the per-message cap, so both sides truncate it.
    { type: "assistant", content: "z".repeat(20_000), timestamp: 6 },
    // Harness-injected, not user-written.
    { type: "user", content: "task finished", timestamp: 7,
      event: { kind: "agent_task_completed", sessionId: "s2", turnEndEntryIndex: 3 } },
    { type: "assistant", content: "done, sorted by primary key", timestamp: 8 },
    { type: "turn_end", timestamp: 9 },
    { type: "error", message: "boom", timestamp: 10 },
  ];

  // The whole safety argument in one assertion: distilling the projection must
  // produce the exact prompt input that distilling the raw session would.
  it("leaves the distiller's input byte-identical", () => {
    const messages = nasty();
    expect(serializeConversationForBrief(projectMessagesForBrief(messages)))
      .toBe(serializeConversationForBrief(messages));
  });

  /**
   * The structural property the byte-equality above is a consequence of: the
   * projection is a fixed point, so running it again — which is what the
   * receiving side effectively does when it serializes — changes nothing.
   *
   * Worth pinning separately because serialized equality does not imply it
   * (renderAll joins with "\n\n", so different entry lists could in principle
   * render alike), and the compaction path slices by entry, not by the joined
   * string. Truncation is the step that could have compounded here: the cap
   * appends "…" and the receiving side caps again — slicing back to the cap
   * removes exactly that "…", so re-appending reproduces the same text.
   */
  it("is a fixed point, so the receiving side's own pass changes nothing", () => {
    const once = projectMessagesForBrief(nasty());
    expect(projectMessagesForBrief(once)).toEqual(once);
  });

  it("carries none of the tool traffic", () => {
    const projected = JSON.stringify(projectMessagesForBrief(nasty()));
    expect(projected).not.toMatch(/xxxx|yyyy|weighing options|boom/);
    expect(projected.length).toBeLessThan(7_000); // vs ~100KB of raw entries
  });
});

describe("generateIntentBrief", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockIsModelConfigured.mockReset();
    mockIsModelConfigured.mockReturnValue(true);
    // Briefs are cached by conversation content, and these cases deliberately
    // reuse the same conversations — without this each would be answered by
    // its predecessor's result instead of the model it wires up.
    clearIntentBriefCache();
  });

  /** Route each call by its system prompt; `briefBehaviour` drives the distill step. */
  const wire = (briefBehaviour: () => { text: string }) => {
    mockGenerateText.mockImplementation((async (opts: { system: string }) => {
      if (opts.system === COMPACT_SYSTEM_PROMPT) return { text: "SLICE SUMMARY" };
      if (opts.system === REVERSAL_SYSTEM_PROMPT) return { text: "NONE" };
      return briefBehaviour();
    }) as never);
  };

  it("distills the whole conversation when the model accepts it", async () => {
    wire(() => ({ text: "the brief" }));
    const brief = await generateIntentBrief(storage, "u1", [
      { type: "user", content: "build it", timestamp: 1 },
      { type: "assistant", content: "done", timestamp: 2 },
    ]);
    expect(brief).toBe("the brief");
    expect(mockGenerateText).not.toHaveBeenCalledWith(expect.objectContaining({ system: COMPACT_SYSTEM_PROMPT }));
  });

  // The budget is ours, not the model's: rather than guess one, send everything
  // and compact only when the model actually refuses it.
  it("compacts and retries when the model rejects the full conversation as too large", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 15; i++) messages.push(bigTurn(`turn-${i}`));
    let briefCalls = 0;
    wire(() => {
      if (briefCalls++ === 0) throw sizeError();
      return { text: "the brief" };
    });

    const brief = await generateIntentBrief(storage, "u1", messages);

    expect(brief).toBe(`the brief\n\n${COMPACTION_NOTE}`);
    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({ system: COMPACT_SYSTEM_PROMPT }));
    expect(briefCalls).toBe(2);
  });

  it("does not retry when the failure has nothing to do with size", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 15; i++) messages.push(bigTurn(`turn-${i}`));
    let briefCalls = 0;
    wire(() => {
      briefCalls++;
      throw new Error("401 unauthorized");
    });

    expect(await generateIntentBrief(storage, "u1", messages)).toBeNull();
    expect(briefCalls).toBe(1);
  });

  it("degrades to tier 2 when the conversation cannot be compacted far enough", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 160; i++) messages.push(bigTurn(`turn-${i}`)); // over the fold ceiling
    wire(() => ({ text: "the brief" }));

    expect(await generateIntentBrief(storage, "u1", messages)).toBeNull();
  });

  it("returns null for an empty conversation without calling the model", async () => {
    wire(() => ({ text: "the brief" }));
    expect(await generateIntentBrief(storage, "u1", [])).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  // The slice size is a guess about a window we cannot introspect. A model
  // that refuses anything over ~50k must not fail the same way three times:
  // each retry has to actually slice smaller.
  it("re-slices smaller until the compaction requests fit the model", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 15; i++) messages.push(bigTurn(`turn-${i}`));
    mockGenerateText.mockImplementation((async (opts: { system: string; prompt: string }) => {
      if (opts.prompt.length > 50_000) throw sizeError();
      if (opts.system === COMPACT_SYSTEM_PROMPT) return { text: "SLICE SUMMARY" };
      if (opts.system === REVERSAL_SYSTEM_PROMPT) return { text: "NONE" };
      return { text: "the brief" };
    }) as never);

    const brief = await generateIntentBrief(storage, "u1", messages);

    expect(brief).toBe(`the brief\n\n${COMPACTION_NOTE}`);
    const sliceTotals = new Set(
      mockGenerateText.mock.calls
        .map((c) => /^Slice \d+ of (\d+)\./.exec((c[0] as { prompt: string }).prompt)?.[1])
        .filter(Boolean),
    );
    expect(sliceTotals.size).toBeGreaterThan(1); // the first slice size was abandoned for a smaller one
  });

  it("gives up after the smallest slice size instead of looping", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 15; i++) messages.push(bigTurn(`turn-${i}`));
    mockGenerateText.mockRejectedValue(sizeError());

    expect(await generateIntentBrief(storage, "u1", messages)).toBeNull();
  });

  // Judgment (reversal + brief) runs on the strongest configured lane —
  // weighing importance is exactly where the fast lane is weakest. Mechanical
  // slice compression stays on the fast lane: up to 8 parallel calls, and
  // compression needs recall, not judgment.
  it("runs judgment calls on the main model and compaction on the fast model", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 25; i++) messages.push(bigTurn(`turn-${i}`));
    let briefCalls = 0;
    mockGenerateText.mockImplementation((async (opts: { system: string }) => {
      if (opts.system === COMPACT_SYSTEM_PROMPT) return { text: "SLICE SUMMARY" };
      if (opts.system === REVERSAL_SYSTEM_PROMPT) return { text: "NONE" };
      if (briefCalls++ === 0) throw sizeError(); // force the compaction path
      return { text: "the brief" };
    }) as never);

    await generateIntentBrief(storage, "u1", messages);

    for (const [opts] of mockGenerateText.mock.calls) {
      const { system, model } = opts as { system: string; model: { id: string } };
      expect(model.id).toBe(system === COMPACT_SYSTEM_PROMPT ? "fast-model" : "main-model");
    }
  });

  it("falls back to the fast model for judgment when the main lane has no key", async () => {
    mockIsModelConfigured.mockImplementation((config, choice) => choice === config.fast);
    wire(() => ({ text: "the brief" }));

    await generateIntentBrief(storage, "u1", [
      { type: "user", content: "build it", timestamp: 1 },
      { type: "assistant", content: "done", timestamp: 2 },
    ]);

    const briefCall = mockGenerateText.mock.calls.find((c) => (c[0] as { system: string }).system === SYSTEM_PROMPT);
    expect((briefCall![0] as { model: { id: string } }).model.id).toBe("fast-model");
  });

  it("returns null without a model call when neither lane has a key", async () => {
    mockIsModelConfigured.mockReturnValue(false);
    wire(() => ({ text: "the brief" }));

    expect(
      await generateIntentBrief(storage, "u1", [{ type: "user", content: "build it", timestamp: 1 }]),
    ).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("stops after a fatal reversal-pass failure instead of firing the brief request", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 15; i++) messages.push(bigTurn(`turn-${i}`));
    let briefCalls = 0;
    mockGenerateText.mockImplementation((async (opts: { system: string }) => {
      if (opts.system === REVERSAL_SYSTEM_PROMPT) throw new Error("429 rate limited");
      briefCalls++;
      return { text: "the brief" };
    }) as never);

    expect(await generateIntentBrief(storage, "u1", messages)).toBeNull();
    expect(briefCalls).toBe(0);
  });
});

// The review dialog asks on every open and the create request can ask again;
// each ask is two model calls on the user's critical path.
describe("generateIntentBrief caching", () => {
  const messages: AgentMessage[] = [
    { type: "user", content: "build it", timestamp: 1 },
    { type: "assistant", content: "done", timestamp: 2 },
  ];

  beforeEach(() => {
    mockGenerateText.mockReset();
    mockIsModelConfigured.mockReset();
    mockIsModelConfigured.mockReturnValue(true);
    clearIntentBriefCache();
    mockGenerateText.mockImplementation((async (opts: { system: string }) => (
      opts.system === REVERSAL_SYSTEM_PROMPT ? { text: "NONE" } : { text: "the brief" }
    )) as never);
  });

  it("answers a repeat of the same conversation from cache", async () => {
    expect(await generateIntentBrief(storage, "u1", messages)).toBe("the brief");
    const callsAfterFirst = mockGenerateText.mock.calls.length;
    expect(await generateIntentBrief(storage, "u1", messages)).toBe("the brief");
    expect(mockGenerateText.mock.calls.length).toBe(callsAfterFirst);
  });

  // Keyed by conversation content, never by session: a session that has since
  // produced another turn must not be handed the previous turn's brief.
  it("distills again once the conversation has grown", async () => {
    await generateIntentBrief(storage, "u1", messages);
    const callsAfterFirst = mockGenerateText.mock.calls.length;
    await generateIntentBrief(storage, "u1", [
      ...messages,
      { type: "user", content: "now fix the test", timestamp: 3 },
    ]);
    expect(mockGenerateText.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("does not serve one user's brief to another", async () => {
    await generateIntentBrief(storage, "u1", messages);
    const callsAfterFirst = mockGenerateText.mock.calls.length;
    await generateIntentBrief(storage, "u2", messages);
    expect(mockGenerateText.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("shares one run between overlapping asks", async () => {
    const [a, b] = await Promise.all([
      generateIntentBrief(storage, "u1", messages),
      generateIntentBrief(storage, "u1", messages),
    ]);
    expect([a, b]).toEqual(["the brief", "the brief"]);
    expect(mockGenerateText.mock.calls.filter((c) => (c[0] as { system: string }).system === SYSTEM_PROMPT))
      .toHaveLength(1);
  });

  // A provider hiccup must not pin tier 2 for the cache's whole lifetime.
  it("does not cache a failure", async () => {
    mockGenerateText.mockImplementationOnce((async () => { throw new Error("429 rate limited"); }) as never);
    expect(await generateIntentBrief(storage, "u1", messages)).toBeNull();
    expect(await generateIntentBrief(storage, "u1", messages)).toBe("the brief");
  });
});

describe("prompts", () => {
  it("no longer asks the distiller to guess the intended scope, but keeps goal/constraints/trade-offs", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/intended scope/i);
    expect(SYSTEM_PROMPT).toMatch(/original request/i);
    expect(SYSTEM_PROMPT).toMatch(/trade-offs|limitations/i);
  });

  it("counts agent-made rejections, not just user-made ones", () => {
    expect(SYSTEM_PROMPT).toMatch(/rejected.*whether the user made it or the agent made it/is);
  });

  it("states that later conclusions win, including across compressed slices", () => {
    expect(SYSTEM_PROMPT).toMatch(/supersede/i);
    expect(SYSTEM_PROMPT).toMatch(/later slice overrules an earlier one/i);
  });

  it("asks for behaviour observed by running something", () => {
    expect(SYSTEM_PROMPT).toMatch(/exit codes|observed output/i);
  });

  it("still bars the agent's self-assessment", () => {
    expect(SYSTEM_PROMPT).toMatch(/self-assessment/i);
  });

  it("makes reversals the top priority for the compactor and warns it sees only one slice", () => {
    expect(COMPACT_SYSTEM_PROMPT).toMatch(/1\. Reversals and corrections/);
    expect(COMPACT_SYSTEM_PROMPT).toMatch(/verbatim/i);
    expect(COMPACT_SYSTEM_PROMPT).toMatch(/a later slice may overturn it/i);
  });

  // The dominant question is the brief's zeroth-order statement: the one thing
  // the reviewer must judge. It has to come from the conversation's own
  // emphasis — a distiller inventing priorities hands the reviewer a wrong map,
  // which is worse than no map.
  it("opens with a dominant question derived from the conversation's own emphasis", () => {
    expect(SYSTEM_PROMPT).toMatch(/dominant question/i);
    expect(SYSTEM_PROMPT).toMatch(/repeated|reversed course|finally decided/i);
    expect(SYSTEM_PROMPT).toMatch(/never from your own/i);
    expect(SYSTEM_PROMPT).toMatch(/unclear/i); // permission to punt beats inventing one
  });

  it("separates hard constraints (violation = failure regardless) from ordinary decisions", () => {
    expect(SYSTEM_PROMPT).toMatch(/hard constraints/i);
    expect(SYSTEM_PROMPT).toMatch(/security|data loss/i);
  });

  // Settled status suppresses review findings downstream, so it needs explicit
  // user evidence. Silence keeps its reporting value but must never escalate
  // into "do not relitigate".
  it("grants settled status only on explicit user evidence — silence stays tentative", () => {
    expect(SYSTEM_PROMPT).toMatch(/\[settled\]/);
    expect(SYSTEM_PROMPT).toMatch(/\[tentative\]/);
    expect(SYSTEM_PROMPT).toMatch(/silence is never settled/i);
    expect(SYSTEM_PROMPT).not.toMatch(/silence is agreement/i);
  });

  // Live eval showed the model writing "[settled – reason]" — informative but
  // inconsistent with the exact tags the reviewer prompt refers to.
  it("demands the bare tags with any justification outside the brackets", () => {
    expect(SYSTEM_PROMPT).toMatch(/exactly \[settled\] or \[tentative\]/);
    expect(SYSTEM_PROMPT).toMatch(/justification|reason.*after the tag|outside the bracket/i);
  });

  // Second live run: after compaction the model filed "no IE11" under heading
  // 3 as a rejection instead of heading 4 — legitimate classification freedom,
  // but the evidence tier vanished with it because tags were defined only for
  // heading 4. The tag must follow the item, not the heading.
  it("requires the evidence tag on every item under headings 3 and 4", () => {
    expect(SYSTEM_PROMPT).toMatch(/every item under headings 3 and 4/i);
  });

  // "any justification after the tag" invited paragraph-length parentheticals
  // on every item (live eval run 3), inflating the brief into the token cap.
  it("keeps per-item justifications short or absent", () => {
    expect(SYSTEM_PROMPT).toMatch(/a few words or omit/i);
  });

  it("orders items by weight toward the dominant question, not chronology", () => {
    expect(SYSTEM_PROMPT).toMatch(/order items by how much they matter/i);
  });

  // Compaction must not launder an agent proposal into a user decision — the
  // settled/tentative distinction downstream depends on who decided.
  it("compactor preserves who made each decision so settled status survives compression", () => {
    expect(COMPACT_SYSTEM_PROMPT).toMatch(/who made each decision/i);
    expect(COMPACT_SYSTEM_PROMPT).toMatch(/user confirmation|user confirmed/i);
  });
});
