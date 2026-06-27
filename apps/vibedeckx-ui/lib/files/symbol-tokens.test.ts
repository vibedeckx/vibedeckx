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
});
