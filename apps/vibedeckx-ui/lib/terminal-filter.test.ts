import { describe, expect, it } from "vitest";
import {
  applyFilters,
  collectLogicalLines,
  lineMatches,
  parseFilterInput,
  type BufferLike,
  type TerminalFilter,
} from "./terminal-filter";

const f = (pattern: string, negate = false): TerminalFilter => ({ id: pattern, pattern, negate });

describe("parseFilterInput", () => {
  it("trims and keeps plain text as a positive filter", () => {
    expect(parseFilterInput("  error ")).toEqual({ pattern: "error", negate: false });
  });

  it("treats a leading - or ! as an exclusion", () => {
    expect(parseFilterInput("-debug")).toEqual({ pattern: "debug", negate: true });
    expect(parseFilterInput("! warn ")).toEqual({ pattern: "warn", negate: true });
  });

  it("escapes a literal leading - or ! with a backslash", () => {
    expect(parseFilterInput("\\-v")).toEqual({ pattern: "-v", negate: false });
    expect(parseFilterInput("\\!important")).toEqual({ pattern: "!important", negate: false });
  });

  it("rejects blank input and a bare prefix", () => {
    expect(parseFilterInput("   ")).toBeNull();
    expect(parseFilterInput("-")).toBeNull();
    expect(parseFilterInput("! ")).toBeNull();
  });
});

describe("lineMatches / applyFilters", () => {
  const lines = [
    "INFO server started",
    "ERROR db connection refused",
    "info request GET /health",
    "error: request timeout",
    "DEBUG noisy",
  ];

  it("is case-insensitive", () => {
    expect(applyFilters(lines, [f("ERROR")])).toEqual([
      "ERROR db connection refused",
      "error: request timeout",
    ]);
  });

  it("ANDs multiple chips so the second narrows the first", () => {
    expect(applyFilters(lines, [f("request"), f("error")])).toEqual(["error: request timeout"]);
    // Order does not change the result.
    expect(applyFilters(lines, [f("error"), f("request")])).toEqual(["error: request timeout"]);
  });

  it("hides lines matching a negated chip", () => {
    expect(applyFilters(lines, [f("debug", true), f("info", true)])).toEqual([
      "ERROR db connection refused",
      "error: request timeout",
    ]);
  });

  it("passes everything with no filters", () => {
    expect(applyFilters(lines, [])).toEqual(lines);
    expect(lineMatches("anything", [])).toBe(true);
  });
});

describe("collectLogicalLines", () => {
  function buffer(rows: Array<{ text: string; wrapped?: boolean }>): BufferLike {
    return {
      length: rows.length,
      getLine: (y) =>
        rows[y] && {
          isWrapped: rows[y].wrapped ?? false,
          translateToString: () => rows[y].text,
        },
    };
  }

  it("joins soft-wrapped rows into one logical line", () => {
    const lines = collectLogicalLines(
      buffer([
        { text: "a very long li" },
        { text: "ne of output", wrapped: true },
        { text: "next" },
      ])
    );
    expect(lines).toEqual(["a very long line of output", "next"]);
    // A pattern straddling the wrap point still matches.
    expect(applyFilters(lines, [f("long line")])).toEqual(["a very long line of output"]);
  });

  it("drops trailing blank rows but keeps interior ones", () => {
    expect(
      collectLogicalLines(buffer([{ text: "one" }, { text: "" }, { text: "two" }, { text: "" }, { text: "" }]))
    ).toEqual(["one", "", "two"]);
  });

  it("does not crash on a wrapped first row or missing rows", () => {
    const b: BufferLike = {
      length: 2,
      getLine: (y) => (y === 0 ? undefined : { isWrapped: true, translateToString: () => "tail" }),
    };
    expect(collectLogicalLines(b)).toEqual(["tail"]);
  });
});
