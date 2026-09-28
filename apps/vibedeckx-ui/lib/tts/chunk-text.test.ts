import { describe, it, expect } from "vitest";
import { chunkForSpeech, splitSentences } from "./chunk-text";

describe("splitSentences", () => {
  it("splits on CJK and Latin sentence ends but not inside file names or numbers", () => {
    expect(splitSentences("改了 a.ts 文件。版本是 3.14！Done. Next?\nLast line")).toEqual([
      "改了 a.ts 文件。",
      "版本是 3.14！",
      "Done.",
      "Next?",
      "Last line",
    ]);
  });

  it("keeps closing quotes and punctuation runs with their sentence", () => {
    expect(splitSentences("他说「好了。」然后?! 结束")).toEqual(["他说「好了。」", "然后?!", "结束"]);
  });
});

describe("chunkForSpeech", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkForSpeech("Hello there. How are you?", 1500)).toEqual(["Hello there. How are you?"]);
  });

  it("keeps the first chunk short and packs the rest up to maxChars", () => {
    const sentence = "这是一句大约二十个字的测试句子，用来检查分段。"; // 23 chars
    const text = sentence.repeat(40);
    const chunks = chunkForSpeech(text, 300, 100);
    expect(chunks[0].length).toBeLessThanOrEqual(100);
    for (const chunk of chunks.slice(1)) expect(chunk.length).toBeLessThanOrEqual(300);
    expect(chunks.slice(1, -1).every((c) => c.length > 250)).toBe(true);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => c.endsWith("。"))).toBe(true);
  });

  it("splits an over-long sentence at commas, then hard-cuts", () => {
    const long = Array.from({ length: 30 }, (_, i) => `part${i}`).join(", ") + ".";
    const chunks = chunkForSpeech(long, 60, 40);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
    expect(chunks[0].length).toBeLessThanOrEqual(40);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(long);

    const noBreaks = "x".repeat(130);
    expect(chunkForSpeech(noBreaks, 50, 50)).toEqual(["x".repeat(50), "x".repeat(50), "x".repeat(30)]);
  });

  it("joins Latin sentences with a space and CJK without", () => {
    expect(chunkForSpeech("One.\nTwo.", 100)).toEqual(["One. Two."]);
    expect(chunkForSpeech("一。\n二。", 100)).toEqual(["一。二。"]);
  });
});
