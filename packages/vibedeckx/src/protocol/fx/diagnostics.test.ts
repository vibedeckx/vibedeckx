import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formatFxRequestFailure } from "./diagnostics.js";

describe("fx startup diagnostics", () => {
  const recording = readFileSync(new URL("./__fixtures__/unauthenticated.jsonl", import.meta.url), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  const original = recording.find(row => row.direction === "stdout").message.error.message as string;
  it.each(["initialize", "session/new"])("recognizes recorded login failure during %s and preserves evidence", method => {
    const message = formatFxRequestFailure(method, original);
    expect(message).toContain("fx is not logged in");
    expect(message).toContain("fx login vercel");
    expect(message).toContain("fx login codex");
    expect(message).toContain("fx login grok");
    expect(message).toContain(original);
  });
  it.each([
    "-32600: Not initialized. Call initialize first.",
    "-32600: Invalid request",
    "-32602: Unknown model: user/custom-model",
    "-32000: Access denied for model openai/private",
    "-32000: Insufficient credits",
  ])("preserves non-login errors: %s", message => {
    expect(formatFxRequestFailure("initialize", message)).toBe(`fx request failed: ${message}`);
  });
  it("does not classify prompt errors as startup authentication failures", () => {
    expect(formatFxRequestFailure("session/prompt", original)).toBe(`fx request failed: ${original}`);
  });
});
