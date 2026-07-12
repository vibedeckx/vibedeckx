import { describe, expect, it } from "vitest";
import { parseClaudeLine, serializeUserInput } from "./codec.js";

describe("parseClaudeLine", () => {
  it("parses a JSON line into a typed message", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", duration_ms: 5 });
    expect(parseClaudeLine(line)).toEqual({ type: "result", subtype: "success", duration_ms: 5 });
  });

  it("returns null for non-JSON lines", () => {
    expect(parseClaudeLine("plain text progress line")).toBeNull();
  });
});

describe("serializeUserInput", () => {
  it("wraps a plain string in the stream-json user envelope", () => {
    expect(serializeUserInput("hello")).toBe(
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) + "\n",
    );
  });

  it("maps ContentPart[] to text and base64 image blocks", () => {
    const out = serializeUserInput([
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", data: "AAAA" },
    ]);
    expect(JSON.parse(out)).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    });
    expect(out.endsWith("\n")).toBe(true);
  });
});
