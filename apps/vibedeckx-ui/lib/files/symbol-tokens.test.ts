import { describe, expect, it } from "vitest";
import { classifyColumn, tokenizeFile } from "./symbol-tokens";

// Column of the first occurrence of `needle` within `line` of `source`
// (1-based line). Mirrors how the click handler derives a source column.
function colOf(source: string, line: number, needle: string): number {
  const text = source.split("\n")[line - 1];
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`"${needle}" not found on line ${line}`);
  return i;
}

describe("symbol-tokens", () => {
  const source = [
    "// clickHere is a comment word",
    'const greeting = "helloWorld";',
    "function compute(value) {",
    "  return value + 1;",
    "}",
  ].join("\n");

  it("classifies a word inside a comment as comment", async () => {
    const index = await tokenizeFile(source, "typescript");
    const col = colOf(source, 1, "clickHere");
    expect(classifyColumn(index, 1, col)).toBe("comment");
  });

  it("classifies a word inside a string literal as string", async () => {
    const index = await tokenizeFile(source, "typescript");
    const col = colOf(source, 2, "helloWorld");
    expect(classifyColumn(index, 2, col)).toBe("string");
  });

  it("classifies a language keyword as keyword", async () => {
    const index = await tokenizeFile(source, "typescript");
    const constCol = colOf(source, 2, "const");
    const returnCol = colOf(source, 4, "return");
    expect(classifyColumn(index, 2, constCol)).toBe("keyword");
    expect(classifyColumn(index, 4, returnCol)).toBe("keyword");
  });

  it("classifies a real identifier as code (clickable)", async () => {
    const index = await tokenizeFile(source, "typescript");
    const fnCol = colOf(source, 3, "compute");
    const refCol = colOf(source, 4, "value");
    expect(classifyColumn(index, 3, fnCol)).toBe("code");
    expect(classifyColumn(index, 4, refCol)).toBe("code");
  });

  it("returns null for an unknown line", async () => {
    const index = await tokenizeFile(source, "typescript");
    expect(classifyColumn(index, 999, 0)).toBeNull();
  });

  it("carries grammar context across tokenizer slice boundaries", async () => {
    // A block comment opened in the first 200-line slice and closed in the
    // second: its inner lines must stay "comment", and code after it "code".
    const lines = Array.from({ length: 199 }, (_, i) => `const v${i} = ${i};`);
    lines.push("/* opens here", "insideComment still", "*/ const afterComment = 1;");
    const big = lines.join("\n");
    const index = await tokenizeFile(big, "typescript");
    expect(classifyColumn(index, 201, colOf(big, 201, "insideComment"))).toBe("comment");
    expect(classifyColumn(index, 202, colOf(big, 202, "afterComment"))).toBe("code");
  });

  it("stops early when aborted", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const controller = new AbortController();
    const pending = tokenizeFile(big, "typescript", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/Aborted/);
  });

  it("does not tokenize the first slice when aborted while the grammar loads", async () => {
    // Shorter than one slice, so only the pre-first-slice check can stop it.
    const controller = new AbortController();
    const pending = tokenizeFile(source, "typescript", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/Aborted/);
  });
});
